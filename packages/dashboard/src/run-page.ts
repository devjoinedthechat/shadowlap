import {
  CHECK_STATUSES,
  cacheMisses,
  canonicalModel,
  Lru,
  hasRecordedCommand,
  isJudgeCall,
  LiveConversations,
  normalizeResponse,
  previewRedaction,
  recordedDurations,
  responseInfo,
  runConversations,
  runInterventions,
  runStamp,
  shortModel,
  showJson,
  summarizeRun,
  toolResultLine,
  type CacheMiss,
  type CallRecord,
  type CheckStatus,
  type ConversationSpan,
  type NotRecorded,
  type Normalizer,
  type Price,
  type RunCache,
  type RunConversations,
  type InterventionFlag,
  type JudgeOutcome,
  type RunNote,
  type RunRecord,
  type ShowJson,
  type Store,
  type ToolTrust,
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
  /**
   * A model call: the tools its answer asked for, in order, as the response names them, whether or
   * not they ran here (a capture records none of them); null for other calls.
   */
  asks: string[] | null;
}

export const NO_FACTS: CallFacts = Object.freeze({ conversation: null, conversationStart: false, requestedBy: null, toolUseId: null, cacheMiss: null, recordedMs: null, asks: null });

export interface RunAnalysis {
  conversations: RunConversations;
  cache: RunCache;
  recorded: Map<number, number>;
  facts(callNo: number): CallFacts;
  /** The run's calls by number. */
  byNo: ReadonlyMap<number, CallRecord>;
  /**
   * The model call whose request shows a call's conversation, as the engine's
   * `conversationRequestFor` finds it: its own request, else its conversation's latest before it,
   * else the first after it. Looked up rather than searched for, so a whole run's calls cost one pass.
   */
  requestFor(callNo: number): CallRecord | null;
}

/** Analyses of the runs read lately, per store: the run page asks for a run and then its calls, one by one. */
const analyses = new WeakMap<Store, Map<string, RunAnalysis>>();

/**
 * The runs still recording whose pages are followed, per store: their conversations as their calls
 * arrive (LiveConversations), and the tools each model call's answer asked for, with the record they
 * were read from. A recording's page asks for its newest calls every two seconds; working out where
 * every call of a long run belongs each time held up the dashboard for seconds at 50,000 calls.
 */
const following = new WeakMap<Store, Map<string, { live: LiveConversations; asks: Map<number, { rec: CallRecord; names: string[] }> }>>();

/** The runs followed at once per store. */
const FOLLOW = 4;

/** The tools a model call's answer asked for, by name; cached by response blob. */
const asked = (store: Store, c: CallRecord) => responseInfo(store, c).tools.map((t) => t.name);

/**
 * A run's conversations and what each model call asked for. A run still recording is placed as its
 * calls arrive, from where it was last asked for (`following`): each call is worked out once, and its
 * answer once it arrives. A finished run is placed whole, every call with everything known.
 */
function conversationsOf(store: Store, run: RunRecord, calls: readonly CallRecord[]): { conversations: RunConversations; asks: Map<number, string[]> } {
  let byRun = following.get(store);
  if (run.status !== 'running') {
    byRun?.delete(run.runId);
    const asks = new Map<number, string[]>();
    for (const c of calls) if (c.kind === 'api') asks.set(c.callNo, asked(store, c));
    return { conversations: runConversations(store, calls, { attribute: true }), asks };
  }
  if (!byRun) following.set(store, (byRun = new Map()));
  let entry = byRun.get(run.runId);
  let conversations = entry?.live.update(calls) ?? null;
  if (!entry || !conversations) {
    entry = { live: new LiveConversations(store, { attribute: true }), asks: new Map() };
    conversations = entry.live.update(calls)!;
  }
  byRun.delete(run.runId);
  byRun.set(run.runId, entry);
  for (const key of byRun.keys()) if (byRun.size > FOLLOW) byRun.delete(key);
  const asks = new Map<number, string[]>();
  for (const c of calls) {
    if (c.kind !== 'api') continue;
    let had = entry.asks.get(c.callNo);
    if (had?.rec !== c) entry.asks.set(c.callNo, (had = { rec: c, names: asked(store, c) }));
    asks.set(c.callNo, had.names);
  }
  return { conversations, asks };
}

/** A run's conversations, cache misses and recorded durations, computed once per state of the run. */
export function analyseRun(store: Store, run: RunRecord, calls: readonly CallRecord[]): RunAnalysis {
  let byRun = analyses.get(store);
  if (!byRun) analyses.set(store, (byRun = new Map()));
  // Its status too: a recording is placed as its calls arrive, the finished run whole.
  const key = `${run.runId}\n${run.status}\n${runStamp(calls)}`;
  const known = byRun.get(key);
  if (known) return known;
  // Read already, while tool calls were matched to the model calls that asked for them: cached by blob.
  const { conversations, asks } = conversationsOf(store, run, calls);
  const cache = cacheMisses(calls, conversations);
  const recorded = run.mode === 'replay' ? recordedDurations(store, run, calls) : new Map<number, number>();
  const misses = new Map<number, CacheMiss>(cache.misses.map((m) => [m.callNo, m]));
  const byNo = new Map(calls.map((c) => [c.callNo, c]));
  // Each conversation's requests in call order, for requestFor.
  const requests = new Map<number, CallRecord[]>();
  for (const c of calls) {
    const n = conversations.requests.has(c.callNo) ? conversations.byCall.get(c.callNo)?.conversation : undefined;
    if (n === undefined || n === null) continue;
    const list = requests.get(n);
    if (list) list.push(c);
    else requests.set(n, [c]);
  }
  const analysis: RunAnalysis = {
    conversations,
    cache,
    recorded,
    byNo,
    requestFor(callNo) {
      const self = byNo.get(callNo);
      if (!self) return null;
      if (self.kind === 'api' && self.requestRef) return self;
      const n = conversations.byCall.get(callNo)?.conversation ?? null;
      const members = n === null ? undefined : requests.get(n);
      if (!members?.length) return null;
      // The last request before the call, by halving; else the first after it.
      let lo = 0;
      let hi = members.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (members[mid]!.callNo < callNo) lo = mid + 1;
        else hi = mid;
      }
      return lo > 0 ? members[lo - 1]! : (members.find((c) => c.callNo > callNo) ?? null);
    },
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
        asks: asks.get(callNo) ?? null,
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
  if (c.kind === 'clock' || c.kind === 'random') return valueLineOf(store, c);
  if (c.kind === 'api') return saidLineOf(store, c);
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

/** How much of what a model said its line keeps. */
const SAID_MAX = 200;

/**
 * What a model call's answer said, in a line: its text, without its thinking or the tools it called,
 * the whitespace closed up and cut at about 200 characters. Turns shows it under the call, and Calls
 * beside a call that asked for no tool (the agent's final answer). Null for an answer that said
 * nothing (it only called tools), and for one that failed or can't be read. Cached by response blob.
 */
function saidLineOf(store: Store, c: CallRecord): string | null {
  const ref = c.end?.responseRef;
  if (!ref || c.end?.outcome !== 'ok') return null;
  let lines = resultLines.get(store);
  if (!lines) resultLines.set(store, (lines = new Lru(20_000)));
  const key = `${ref}\nsaid`;
  const known = lines.get(key);
  if (known !== undefined) return known;
  let line: string | null = null;
  try {
    const provider = c.end.meta.provider ?? c.meta.provider;
    const r = normalizeResponse(store.getBlob(ref), c.end.meta.headers?.['content-type'], c.end.meta.chunks ?? [], typeof provider === 'string' ? provider : undefined);
    const text = r.blocks
      .flatMap((b) => (b.type === 'text' ? [b.text] : []))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    line = text ? (text.length > SAID_MAX ? `${text.slice(0, SAID_MAX - 1)}…` : text) : null;
  } catch {
    line = null;
  }
  lines.set(key, line);
  return line;
}

/** A clock read's or a random value's value in a line, as JSON: what the agent got, and a replay serves again. */
function valueLineOf(store: Store, c: CallRecord): string | null {
  if (!c.end?.responseRef || c.end.outcome !== 'ok') return null;
  let lines = resultLines.get(store);
  if (!lines) resultLines.set(store, (lines = new Lru(20_000)));
  const key = `${c.end.responseRef}\nvalue`;
  const known = lines.get(key);
  if (known !== undefined) return known;
  let line: string | null = null;
  try {
    const payload = store.getJson<{ result?: unknown }>(c.end.responseRef);
    const v = payload && typeof payload === 'object' && 'result' in payload ? payload.result : undefined;
    const text = v === undefined ? null : (JSON.stringify(v) ?? null);
    line = text === null ? null : text.length > 72 ? `${text.slice(0, 71)}…` : text;
  } catch {
    line = null;
  }
  lines.set(key, line);
  return line;
}

/**
 * What a call row shows that is the call's own: its blobs, its fingerprint, a tool's result in a
 * line, and whether it is a person's answer the agent read (`userInput()`, or stdin through the
 * preload), which Calls tags "input" and the fork menu answers differently.
 */
export function ownFacts(store: Store, c: CallRecord): { fingerprint: string; requestRef: string | null; responseRef: string | null; resultShort: string | null; input?: true } {
  return { fingerprint: c.fingerprint, requestRef: c.requestRef, responseRef: c.end?.responseRef ?? null, resultShort: resultShortOf(store, c), ...(c.kind === 'tool' && c.meta.input === true ? { input: true as const } : {}) };
}

/** The model call whose request shows a call's conversation: its own, or its conversation's latest before it. */
export function conversationSource(store: Store, run: RunRecord, calls: readonly CallRecord[], callNo: number, analysis: RunAnalysis = analyseRun(store, run, calls)): { call: CallRecord; n: number | null } | null {
  const from = analysis.requestFor(callNo);
  return from ? { call: from, n: analysis.conversations.byCall.get(from.callNo)?.conversation ?? null } : null;
}

// ---- per run ---------------------------------------------------------------------------------------

export interface RunBlame {
  outcome: 'blamed' | 'unrescuable' | 'stopped';
  /** It placed the failure on no call only because its first probe couldn't tell: not settled, never "not rescued". Absent otherwise. */
  unsettled?: true;
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
  /** passed, failed, inconclusive or not-applicable, when the result says (one kept before results had a status reads as `ok` says). */
  status?: CheckStatus;
  /** A judge's reason for its verdict, and where the verdict came from. */
  reason?: string;
  source?: 'recording' | 'live';
  /** A judge check: its verdict, whether it came from the recording (free) or the judge live, and what it cost. */
  judge?: JudgeOutcome;
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
  intervention: InterventionFlag | null;
  interventions: InterventionFlag[];
  /** A fork a blame of its parent found passing: the blamed run and the call it asked again. */
  rescuedBy: { runId: string; callNo: number | null } | null;
  /** The last blame of this run. */
  blame: RunBlame | null;
  /** The run's outcome checks, counted over the attempts they ran in. */
  checks: RunCheck[] | null;
  /**
   * Each model the run's model calls name, by the short name their rows carry (`opus-5`): as the run
   * page names it everywhere, the id without a date stamp (`claude-opus-5`).
   */
  models: Record<string, string>;
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
  // The agent's model calls: a judge check's are none of blame's steps.
  const steps = calls.filter((c) => c.kind === 'api' && c.end && inScope(c.meta.scope, scope) && !isJudgeCall(c)).map((c) => c.callNo);
  const k = callNo === null ? 0 : steps.indexOf(callNo) + 1;
  return {
    outcome: oneOf(b.outcome, ['blamed', 'unrescuable', 'stopped'] as const, 'stopped'),
    ...(b.unsettled === true ? { unsettled: true as const } : {}),
    callNo,
    modelCall: k > 0 ? { k, m: steps.length } : null,
    confidence: oneOf(b.confidence, ['high', 'medium', 'low'] as const, 'low'),
    rescuedRunId: str(b.rescuedRunId),
    scope,
    at: typeof b.at === 'number' && Number.isFinite(b.at) ? b.at : 0,
  };
}

type StoredRunCheck = Pick<RunCheck, 'ok' | 'label' | 'detail' | 'status' | 'reason' | 'source' | 'judge'>;

/** A judge check's outcome as stored, checked field by field: a run can come from someone else's pack. */
function storedJudge(v: unknown): JudgeOutcome | null {
  if (!isObject(v) || typeof v.name !== 'string' || typeof v.model !== 'string') return null;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  return {
    name: v.name,
    model: v.model,
    of: oneOf(v.of, ['answer', 'output', 'run'] as const, 'answer'),
    verdict: v.verdict === 'yes' || v.verdict === 'no' ? v.verdict : null,
    source: v.source === 'recording' || v.source === 'live' ? v.source : null,
    cost: num(v.cost),
    redactions: num(v.redactions) ?? 0,
    ...(typeof v.normalized === 'boolean' ? { normalized: v.normalized } : {}),
    cut: num(v.cut) ?? 0,
    ...(int(v.callNo) !== null ? { callNo: int(v.callNo)! } : {}),
  };
}

/** A run's checks as stored, keeping only well-formed entries, each with its status, and a judge's reason, source and outcome, when it has them. */
function storedChecks(run: RunRecord): StoredRunCheck[] {
  const v: unknown = run.meta?.checks;
  if (!Array.isArray(v)) return [];
  return v
    .filter((c): c is Record<string, unknown> & { ok: boolean; label: string } => isObject(c) && typeof c.ok === 'boolean' && typeof c.label === 'string')
    .map((c) => {
      const judge = storedJudge(c.judge);
      return {
        ok: c.ok,
        label: c.label,
        detail: str(c.detail),
        ...(typeof c.status === 'string' && (CHECK_STATUSES as readonly string[]).includes(c.status) ? { status: c.status as CheckStatus } : {}),
        ...(typeof c.reason === 'string' ? { reason: c.reason } : {}),
        ...(c.source === 'recording' || c.source === 'live' ? { source: c.source } : {}),
        ...(judge ? { judge } : {}),
      };
    });
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
    const { label, ok, detail, ...rest } = c;
    return { label, ok, detail, count: ran.filter((x) => x.ok).length, of: ran.length, ...rest };
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

/** A model id as the run page names it: the platform's prefixes and suffixes off, and no date stamp (`claude-opus-5`). */
export function modelName(model: string): string {
  return canonicalModel(model).replace(/-\d{8}$/, '');
}

/** The run's models by the short name a call row carries, each as the page names it. */
function modelsOf(store: Store, calls: readonly CallRecord[]): Record<string, string> {
  const out: Record<string, string> = {};
  const modelOf = modelResolver(store);
  for (const c of calls) {
    if (c.kind !== 'api') continue;
    const model = c.end?.meta.model ?? c.meta.model ?? modelOf(c) ?? null;
    if (!model) continue;
    const short = shortModel(model);
    if (short && !(short in out)) out[short] = modelName(model);
  }
  return out;
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
    // The flag the banner names: the first the replay ran with (`--inject-as system` is part of its `--inject`).
    intervention: interventions[0] ?? null,
    interventions,
    rescuedBy: rescued && parent ? { runId: parent.runId, callNo: int(rescued.callNo) } : null,
    blame: blameOf(run, calls),
    checks: checksOf(store, run),
    models: modelsOf(store, calls),
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
  /**
   * What a copy made now (pack, export html, dataset, pairs) would mask: the rules that apply and the
   * values they hit in a pack; `returned`, when there are any, the values a path rule masks in what
   * calls got back, which only a copy that is read masks (export html, dataset); and `unmasked`, when
   * there are any, the values they match that a pack leaves as they are (numbers). Null values when
   * not counted, with why when it says, and `busy` when it is yet to be counted (the preview threads
   * were busy): asked again, it is.
   */
  mask: { rules: number; values: number | null; returned?: number; unmasked?: number; why?: string; busy?: true };
  labels: string[];
  notes: RunNote[];
}

/** Counts what a set of redaction rules would mask in one run: the dashboard passes the Redaction tab's preview (run-mask.ts). */
export type MaskCounter = (store: Store, runId: string) => { rules: number; values: number | null; returned?: number; unmasked?: number; why?: string; busy?: true } | null;

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
 * What a set of rules would mask in a run, as the Redaction tab's preview and `shadowlap redact
 * preview` count it: each value a rule changes in what a pack copies (requests, responses, errors),
 * once however many later requests of a conversation send it again. Read here, with no limit: the
 * dashboard counts apart from its own thread instead (run-mask.ts). Throws for a run still recording.
 */
export function countMasked(store: Store, runId: string, rules: Normalizer[]): number {
  return rules.length ? previewRedaction(store, runId, rules).total : 0;
}

/** The count here, or null when there is none (a run still recording, a rule that can't be read). */
function maskHere(store: Store, runId: string, rules: Normalizer[]): { rules: number; values: number | null; returned?: number; unmasked?: number } {
  if (!rules.length) return { rules: 0, values: 0 };
  try {
    const p = previewRedaction(store, runId, rules);
    return { rules: rules.length, values: p.total, ...(p.returned ? { returned: p.returned } : {}), ...(p.unmasked ? { unmasked: p.unmasked } : {}) };
  } catch {
    return { rules: rules.length, values: null };
  }
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
  const mask = options.maskCount?.(store, run.runId) ?? maskHere(store, run.runId, rules);
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

/** `shadowlap show <run> --json`, exactly as the CLI prints it, without starting the CLI: `tools` is the project's config's, as the CLI reads it. */
export function runShowJson(store: Store, run: RunRecord, options: { prices?: Record<string, Price>; tools?: ToolTrust } = {}): ShowJson {
  return showJson(store, run, { ...(options.prices ? { prices: options.prices } : {}), ...(options.tools ? { tools: options.tools } : {}), modelOf: modelResolver(store) });
}
