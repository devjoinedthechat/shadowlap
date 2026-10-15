import {
  applyNormalizers,
  cacheMisses,
  Lru,
  compilePattern,
  conversationRequestFor,
  hasRecordedCommand,
  loadApiRequest,
  normalizerApplies,
  recordedDurations,
  runConversations,
  runInterventions,
  runStamp,
  shortModel,
  showJson,
  structuralDiff,
  summarizeRun,
  toolResultLine,
  type CacheMiss,
  type CallRecord,
  type ConversationSpan,
  type NotRecorded,
  type Normalizer,
  type Price,
  type RunCache,
  type RunConversations,
  type RunIntervention,
  type RunNote,
  type RunRecord,
  type ShowJson,
  type Store,
} from '@shadowlap/engine';
import { modelResolver, runLabel } from '@shadowlap/tui/data';

/**
 * The run page's read model beyond the rows themselves: where each conversation starts and which
 * call belongs to which, where the prompt cache stopped hitting, what replaying did not wait for,
 * what was never recorded, and what the header and banners say (the fork, the flag that made it,
 * blame, the checks). Plain functions over the store, like the rest of api.ts.
 */

// ---- per call --------------------------------------------------------------------------------------

/** What a call row adds for the run page; every field is computed for the whole run at once. */
export interface CallFacts {
  /** The conversation the call belongs to, numbered from 1 in the order they start; null when it belongs to none. */
  conversation: number | null;
  /** A model call whose request starts its conversation. */
  conversationStart: boolean;
  /** A tool call: the model call that asked for it, when one did. */
  requestedBy: number | null;
  /** A tool call: the tool-use id the provider gave that request. */
  toolUseId: string | null;
  /** A model call where the prompt cache stopped hitting: the tokens sent again, and the call it is judged against. */
  cacheMiss: { sentAgain: number; previousCallNo: number } | null;
  /** A replayed call: how long the recording it came from waited for it (this run waited for none of it). */
  recordedMs: number | null;
}

export const NO_FACTS: CallFacts = Object.freeze({ conversation: null, conversationStart: false, requestedBy: null, toolUseId: null, cacheMiss: null, recordedMs: null });

export interface RunAnalysis {
  conversations: RunConversations;
  cache: RunCache;
  recorded: Map<number, number>;
  facts(callNo: number): CallFacts;
}

/** Analyses of the runs read lately, per store: the run page asks for a run and then its calls, one by one. */
const analyses = new WeakMap<Store, Map<string, RunAnalysis>>();

/** A run's conversations, cache misses and recorded durations, computed once per state of the run. */
export function analyseRun(store: Store, run: RunRecord, calls: readonly CallRecord[]): RunAnalysis {
  let byRun = analyses.get(store);
  if (!byRun) analyses.set(store, (byRun = new Map()));
  const key = `${run.runId}\n${runStamp(calls)}`;
  const known = byRun.get(key);
  if (known) return known;
  const conversations = runConversations(store, calls, { attribute: true });
  const cache = cacheMisses(calls, conversations);
  const recorded = run.mode === 'replay' ? recordedDurations(store, run, calls) : new Map<number, number>();
  const misses = new Map<number, CacheMiss>(cache.misses.map((m) => [m.callNo, m]));
  const analysis: RunAnalysis = {
    conversations,
    cache,
    recorded,
    facts(callNo) {
      const c = conversations.byCall.get(callNo);
      const miss = misses.get(callNo);
      return {
        conversation: c?.conversation ?? null,
        conversationStart: c?.starts ?? false,
        requestedBy: c?.requestedBy ?? null,
        toolUseId: c?.toolUseId ?? null,
        cacheMiss: miss ? { sentAgain: miss.sentAgain, previousCallNo: miss.previousCallNo } : null,
        recordedMs: recorded.get(callNo) ?? null,
      };
    },
  };
  // A handful of runs at most: the one open, and the ones it links to.
  for (const k of byRun.keys()) if (k.startsWith(`${run.runId}\n`) || byRun.size >= 16) byRun.delete(k);
  byRun.set(key, analysis);
  return analysis;
}

/**
 * Tool results in a line, per store, by what the line depends on: the result blob (content
 * addressed, so an entry never goes stale), how the call came out, and whether it was an HTTP host.
 * The run page asks for a run every two seconds; its tool results are read once.
 */
const resultLines = new WeakMap<Store, Lru<string, string | null>>();

function resultShortOf(store: Store, c: CallRecord): string | null {
  if (c.kind !== 'tool') return null;
  if (c.origin === 'blocked' || !c.end) return toolResultLine(c, null);
  let lines = resultLines.get(store);
  if (!lines) resultLines.set(store, (lines = new Lru(20_000)));
  const key = `${c.end.responseRef ?? ''}\n${c.origin}\n${c.end.outcome}\n${typeof c.meta.http === 'string' ? 'http' : ''}\n${c.end.meta.error?.message ?? ''}`;
  const known = lines.get(key);
  if (known !== undefined) return known;
  let payload: unknown = null;
  try {
    payload = c.end.responseRef ? store.getJson(c.end.responseRef) : null;
  } catch {
    payload = null;
  }
  const line = toolResultLine(c, payload);
  lines.set(key, line);
  return line;
}

/** What a call row shows that is the call's own: its blobs, its fingerprint and a tool's result in a line. */
export function ownFacts(store: Store, c: CallRecord): { fingerprint: string; requestRef: string | null; responseRef: string | null; resultShort: string | null } {
  return { fingerprint: c.fingerprint, requestRef: c.requestRef, responseRef: c.end?.responseRef ?? null, resultShort: resultShortOf(store, c) };
}

/** The model call whose request shows a call's conversation: its own, or its conversation's latest before it. */
export function conversationSource(store: Store, run: RunRecord, calls: readonly CallRecord[], callNo: number): { call: CallRecord; n: number | null } | null {
  const a = analyseRun(store, run, calls);
  const from = conversationRequestFor(calls, a.conversations, callNo);
  return from ? { call: from, n: a.conversations.byCall.get(from.callNo)?.conversation ?? null } : null;
}

// ---- per run ---------------------------------------------------------------------------------------

export interface RunBlame {
  outcome: 'blamed' | 'unrescuable' | 'stopped';
  /** The model call whose recorded answer lost the run. */
  callNo: number | null;
  /** That call counted among the model calls in the blame's scope: "model call k of m". */
  modelCall: { k: number; m: number } | null;
  confidence: 'high' | 'medium' | 'low';
  rescuedRunId: string | null;
  scope: string | null;
  at: number;
}

export interface RunCheck {
  label: string;
  /** How this run came out on it. */
  ok: boolean;
  detail: string | null;
  /** Attempts that passed it, of those that ran it: the run's repeat or test attempts together, else this run alone. */
  count: number;
  of: number;
}

export interface RunPageFacts {
  /** The conversations in the run, in the order they start. */
  conversations: ConversationSpan[];
  /** The prompt cache: the share of live input read from it, and every call where it stopped hitting. */
  cache: { readShare: number | null; readShareAll: number | null; misses: CacheMiss[]; sentAgain: number };
  /** What replaying did not wait for: the recorded durations of the replayed calls, summed (ms). */
  notWaitedMs: number;
  /** What the run did that Shadowlap did not record, so a replay runs it for real; null when nothing. */
  notRecorded: NotRecorded | null;
  /** The call a replay forked at. */
  forkAt: number | null;
  /** The flag the fork banner names, and every flag the replay ran with. */
  intervention: RunIntervention | null;
  interventions: RunIntervention[];
  /** A fork a blame of its parent found passing: the blamed run and the call it asked again. */
  rescuedBy: { runId: string; callNo: number | null } | null;
  /** The last blame of this run. */
  blame: RunBlame | null;
  /** The run's outcome checks, counted over the attempts they ran in. */
  checks: RunCheck[] | null;
}

const inScope = (callScope: unknown, scope: string | null | undefined) => !scope || (typeof callScope === 'string' && (callScope === scope || callScope.startsWith(`${scope}/`)));

// A run can come from someone else's pack: what its metadata says is checked before it is shown.
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const int = (v: unknown): number | null => (Number.isInteger(v) ? (v as number) : null);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);

function blameOf(run: RunRecord, calls: readonly CallRecord[]): RunBlame | null {
  const b: unknown = run.meta?.blame;
  if (!isObject(b)) return null;
  const callNo = int(b.callNo);
  const scope = str(b.scope);
  // The model calls blame probed: those with an answer, in its scope (the agent's, not a simulated user's).
  const steps = calls.filter((c) => c.kind === 'api' && c.end && inScope(c.meta.scope, scope)).map((c) => c.callNo);
  const k = callNo === null ? 0 : steps.indexOf(callNo) + 1;
  return {
    outcome: oneOf(b.outcome, ['blamed', 'unrescuable', 'stopped'] as const, 'stopped'),
    callNo,
    modelCall: k > 0 ? { k, m: steps.length } : null,
    confidence: oneOf(b.confidence, ['high', 'medium', 'low'] as const, 'low'),
    rescuedRunId: str(b.rescuedRunId),
    scope,
    at: typeof b.at === 'number' && Number.isFinite(b.at) ? b.at : 0,
  };
}

/** A run's checks as stored, keeping only well-formed entries. */
function storedChecks(run: RunRecord): Array<{ ok: boolean; label: string; detail: string | null }> {
  const v: unknown = run.meta?.checks;
  return Array.isArray(v) ? v.filter((c): c is { ok: boolean; label: string; detail: string | null } => isObject(c) && typeof c.ok === 'boolean' && typeof c.label === 'string').map((c) => ({ ok: c.ok, label: c.label, detail: str(c.detail) })) : [];
}

function storedNotRecorded(run: RunRecord): NotRecorded {
  const v: unknown = run.meta?.notRecorded;
  if (!isObject(v)) return { hosts: [], tools: [] };
  const hosts = Array.isArray(v.hosts) ? v.hosts.filter((h): h is NotRecorded['hosts'][number] => isObject(h) && typeof h.target === 'string' && Number.isInteger(h.count)).map((h) => ({ target: h.target, count: h.count, action: oneOf(h.action, ['warned', 'blocked'] as const, 'warned') })) : [];
  const tools = Array.isArray(v.tools) ? v.tools.filter((t): t is string => typeof t === 'string') : [];
  return { hosts, tools };
}

/** Attempts run together: one `--repeat` group, or one golden in one test session, under the same parent. */
function attemptsOf(store: Store, run: RunRecord): RunRecord[] {
  const repeat = str(run.meta?.repeat?.group);
  const session = str(run.meta?.test?.session);
  const golden = str(run.meta?.test?.golden);
  if (!run.parentRunId || (!repeat && !session)) return [run];
  const together = store.childRuns(run.parentRunId).filter((r) => (repeat ? r.meta?.repeat?.group === repeat : r.meta?.test?.session === session && r.meta?.test?.golden === golden));
  return together.length ? together : [run];
}

function checksOf(store: Store, run: RunRecord): RunCheck[] | null {
  const own = storedChecks(run);
  if (!own.length) return null;
  const attempts = attemptsOf(store, run).map(storedChecks);
  return own.map((c) => {
    const ran = attempts.map((checks) => checks.find((x) => x.label === c.label)).filter((x) => x !== undefined);
    return { label: c.label, ok: c.ok, detail: c.detail, count: ran.filter((x) => x.ok).length, of: ran.length };
  });
}

/** The run's own hosts; the tools come from the recording when the run is a replay of it. */
function notRecordedOf(store: Store, run: RunRecord): NotRecorded | null {
  const own = storedNotRecorded(run);
  let tools = own.tools;
  const seen = new Set([run.runId]);
  for (let r = run; !tools.length && r.parentRunId && !seen.has(r.parentRunId); ) {
    seen.add(r.parentRunId);
    const parent = store.getRun(r.parentRunId);
    if (!parent) break;
    tools = storedNotRecorded(parent).tools;
    r = parent;
  }
  return own.hosts.length || tools.length ? { hosts: own.hosts, tools } : null;
}

export function runPageFacts(store: Store, run: RunRecord, calls: readonly CallRecord[]): RunPageFacts {
  const a = analyseRun(store, run, calls);
  const interventions = run.mode === 'replay' ? runInterventions(store, run, calls) : [];
  const parent = run.parentRunId ? store.getRun(run.parentRunId) : null;
  const rescued = parent && isObject(parent.meta?.blame) && parent.meta.blame.rescuedRunId === run.runId ? parent.meta.blame : null;
  let notWaitedMs = 0;
  for (const ms of a.recorded.values()) notWaitedMs += ms;
  return {
    conversations: a.conversations.conversations,
    cache: { readShare: a.cache.readShare, readShareAll: a.cache.readShareAll, misses: a.cache.misses, sentAgain: a.cache.sentAgain },
    notWaitedMs,
    notRecorded: notRecordedOf(store, run),
    forkAt: run.mode === 'replay' ? (run.divergence?.callNo ?? null) : null,
    intervention: interventions.find((x) => x.flag !== '--inject-as') ?? null,
    interventions,
    rescuedBy: rescued && parent ? { runId: parent.runId, callNo: int(rescued.callNo) } : null,
    blame: blameOf(run, calls),
    checks: checksOf(store, run),
  };
}

// ---- provenance ------------------------------------------------------------------------------------

export interface RunProvenance {
  runId: string;
  /** What the run is, as the header names it: recording, clean replay, fork @17, capture. */
  label: string;
  /** The command it ran, or null for a run imported from a capture, which never knew it. */
  command: string[] | null;
  codeVersion: string | null;
  startedAt: number;
  endedAt: number | null;
  /** The same times in UTC, as `2026-10-01 09:41:07 UTC`. */
  startedUtc: string;
  endedUtc: string | null;
  /** Each model as recorded (`claude-sonnet-5-20260101`, the dated snapshot), its short name for display, and the model calls made with it, most used first. */
  models: Array<{ model: string; short: string; calls: number }>;
  /** The providers the model calls went to (`anthropic`, `openai`, …), most used first. */
  providers: Array<{ provider: string; calls: number }>;
  calls: { model: number; tool: number; other: number; scopes: number };
  /** Requests that reached a provider, and what the live ones cost. */
  upstream: { requests: number; spent: number };
  /** Calls by origin; `injected` counts calls Shadowlap answered itself (`--fail-at`). */
  origins: Record<string, number>;
  /** The run and the runs it came from, the recording first. */
  lineage: Array<{ runId: string; parentRunId: string | null; mode: RunRecord['mode']; label: string; codeVersion: string | null; startedAt: number }>;
  /** What a copy made now (pack, export html, dataset, pairs) would mask: the rules that apply and the values they hit; null values when not counted. */
  mask: { rules: number; values: number | null };
  labels: string[];
  notes: RunNote[];
}

/** Counts what a set of redaction rules would mask in one run; the settings page's preview can stand in for it. */
export type MaskCounter = (store: Store, runId: string) => { rules: number; values: number | null } | null;

export interface ProvenanceOptions {
  prices?: Record<string, Price>;
  /** The project's redaction rules: counted over the run's stored requests and responses. */
  redact?: Normalizer[];
  /** Counts instead of the built-in count. */
  maskCount?: MaskCounter;
}

const utc = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

function tally(values: Array<string | null | undefined>): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const v of values) if (v) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * Values a set of rules would rewrite in a run: each string a rule changes in a stored request
 * (tool arguments and model requests alike), and each match of a pathless pattern in a response.
 */
export function countMasked(store: Store, runId: string, rules: Normalizer[]): number {
  if (!rules.length) return 0;
  let values = 0;
  for (const c of store.getCalls(runId)) {
    const applicable = rules.filter((r) => normalizerApplies(r, c.kind, c.name));
    if (!applicable.length) continue;
    try {
      if (c.requestRef) {
        const body = c.kind === 'api' ? loadApiRequest(store, c.requestRef) : store.getJson(c.requestRef);
        for (const rule of applicable) values += structuralDiff(body, applyNormalizers(body, [rule], c.kind, c.name)).length;
      }
      const bytes = c.end?.responseRef ? store.getBlob(c.end.responseRef) : null;
      const text = bytes?.toString('utf8');
      if (text) {
        for (const rule of applicable) {
          if (rule.path !== undefined || rule.pattern === undefined) continue;
          const re = compilePattern(rule.pattern);
          values += [...text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))].length;
        }
      }
    } catch {
      // a call that can't be read masks nothing here
    }
  }
  return values;
}

export function runProvenance(store: Store, run: RunRecord, options: ProvenanceOptions = {}): RunProvenance {
  const calls = store.getCalls(run.runId);
  const modelOf = modelResolver(store);
  const summary = summarizeRun(run, calls, [], [], { modelOf, ...(options.prices ? { prices: options.prices } : {}) });
  const models = calls.filter((c) => c.kind === 'api');
  const lineage: RunProvenance['lineage'] = [];
  const seen = new Set<string>();
  for (let r: RunRecord | null = run; r && !seen.has(r.runId); r = r.parentRunId ? store.getRun(r.parentRunId) : null) {
    seen.add(r.runId);
    lineage.unshift({ runId: r.runId, parentRunId: r.parentRunId, mode: r.mode, label: runLabel(r, r === run ? calls.length : store.countCalls(r.runId)), codeVersion: r.codeVersion, startedAt: r.startedAt });
  }
  const rules = options.redact ?? [];
  const mask = options.maskCount?.(store, run.runId) ?? { rules: rules.length, values: rules.length ? countMasked(store, run.runId, rules) : 0 };
  return {
    runId: run.runId,
    label: runLabel(run, calls.length),
    command: hasRecordedCommand(run) ? run.command.argv : null,
    codeVersion: run.codeVersion,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    startedUtc: utc(run.startedAt),
    endedUtc: run.endedAt === null ? null : utc(run.endedAt),
    models: tally(models.map((c) => c.end?.meta.model ?? c.meta.model ?? modelOf(c))).map(([model, n]) => ({ model, short: shortModel(model), calls: n })),
    providers: tally(models.map((c) => {
      const p = c.end?.meta.provider ?? c.meta.provider;
      return typeof p === 'string' ? p : null;
    })).map(([provider, n]) => ({ provider, calls: n })),
    calls: {
      model: summary.byKind.api,
      tool: summary.byKind.tool,
      other: summary.byKind.clock + summary.byKind.random,
      scopes: new Set(calls.map((c) => c.meta.scope).filter((s) => typeof s === 'string')).size,
    },
    upstream: { requests: summary.upstreamRequests, spent: summary.cost.spent },
    origins: { ...summary.byOrigin, injected: summary.injected },
    lineage,
    mask,
    labels: run.meta?.labels ?? [],
    notes: run.meta?.notes ?? [],
  };
}

/** `shadowlap show <run> --json`, exactly as the CLI prints it, without starting the CLI. */
export function runShowJson(store: Store, run: RunRecord, options: { prices?: Record<string, Price> } = {}): ShowJson {
  return showJson(store, run, { ...(options.prices ? { prices: options.prices } : {}), modelOf: modelResolver(store) });
}
