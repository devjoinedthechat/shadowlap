import { attemptBundles, classifyRun, withAttempts, kindFacts, loadApiRequest, modelResolver, normalizeConversation, normalizeResponse, runLabel, summarizeRun, type CallRecord, type ModelResolver, type NormalizedResponse, type Price, type RunRecord, type Store, type StoreOf, type SummaryOptions, type Turn } from '@shadowlap/engine';

import { attemptTallies, leftRunning, type AttemptTally } from './attempts.js';

// The run's kind in words and the model of its calls, as the dashboard shows them, are the engine's.
export { kindFacts, modelResolver, runLabel, type LabelledRun } from '@shadowlap/engine';

/** Read model for the TUI. Everything here is a thin, read-only view over the engine's store. */

export interface RunNode {
  run: RunRecord;
  depth: number;
  calls: number;
  /** The run's kind in words (`runLabel`). */
  label: string;
  /** Approximate USD spent on live model calls and saved by replayed ones. */
  spent: number;
  saved: number;
  /** What an imported run's calls cost whoever made them: not spent here. */
  captured: number;
  /** Marked running, but the process recording it is gone: nothing will add to it (the store's recordingRuns). */
  interrupted: boolean;
  /** The attempts bundled under it (a `--repeat`'s, blame's probes, verify's, and theirs in turn) and how many passed, kind by kind. */
  attempts: AttemptTally[] | null;
}

export interface CostOptions {
  prices?: Record<string, Price>;
  modelOf: ModelResolver;
}

export function summaryOptions(store: StoreOf<'recording'>, prices?: Record<string, Price>): SummaryOptions {
  return { ...(prices ? { prices } : {}), modelOf: modelResolver(store) };
}

type RunCost = { spent: number; saved: number; captured: number };
const costCache = new Map<string, RunCost>();

/** Cost of a run; finished runs are summed once, a recording run is re-summed on every refresh. */
export function runCost(store: StoreOf<'recording'>, run: RunRecord, options: CostOptions): RunCost {
  const cached = run.status !== 'running' ? costCache.get(run.runId) : undefined;
  if (cached) return cached;
  const s = summarizeRun(run, store.getCalls(run.runId), [], [], options);
  const cost = { spent: s.cost.spent, saved: s.cost.saved, captured: s.cost.captured };
  if (run.status !== 'running') costCache.set(run.runId, cost);
  return cost;
}

/**
 * The runs the list is made of, newest first: the newest `limit` that aren't attempts, and every
 * attempt bundled under them. Attempts (blame's probes, verify's, a `--repeat`'s, a golden's repeats)
 * fold under the run they came from, so they never count against the limit: a store where blame and
 * verify ran hundreds of times still lists the recordings they ran on. It reads a page at a time, a
 * larger one each time, until it holds that many or the whole store. An attempt whose run isn't
 * among them is left out with it.
 */
function listedRuns(store: StoreOf<'recording'>, limit: number): RunRecord[] {
  for (let page = limit * 2; ; page *= 4) {
    const runs = store.listRuns(page);
    let shown = 0;
    let end = runs.length;
    for (let i = 0; i < runs.length; i++) {
      if (!classifyRun(runs[i]!).attemptKind && ++shown === limit) {
        end = i + 1;
        break;
      }
    }
    if (shown < limit && runs.length === page) continue;
    let list = runs.slice(0, end);
    for (;;) {
      const ids = new Set(list.map((r) => r.runId));
      const kept = list.filter((r) => {
        const c = classifyRun(r);
        return !c.attemptKind || !c.attemptOf || ids.has(c.attemptOf);
      });
      if (kept.length === list.length) return kept;
      list = kept;
    }
  }
}

/**
 * Runs as a tree: roots oldest first, children under their parent, oldest first. The attempts bundled
 * under a run are folded into it, as the dashboard's Runs folds them, unless `attempts` lists them.
 * `limit` is how many runs it lists besides their attempts (`listedRuns`).
 */
export function loadRunTree(store: StoreOf<'recording'>, options: CostOptions & { attempts?: boolean }, limit = 500): RunNode[] {
  const runs = listedRuns(store, limit);
  const ids = new Set(runs.map((r) => r.runId));
  const bundles = attemptBundles(runs);
  const folded = options.attempts ? new Set<string>() : new Set([...bundles.values()].flat());
  const byId = new Map(runs.map((r) => [r.runId, r]));
  // The runs their recorder left running: interrupted, as a run and as an attempt.
  const left = leftRunning(store, runs);
  // Counted as a delete counts them (`withAttempts`): those bundled under it, and theirs in turn.
  const attemptsUnder = (id: string) => {
    const ids = withAttempts(bundles, id);
    return ids.length ? attemptTallies(ids.flatMap((a) => byId.get(a) ?? []), left) : null;
  };
  const roots = runs.filter((r) => (!r.parentRunId || !ids.has(r.parentRunId)) && !folded.has(r.runId)).sort((a, b) => a.startedAt - b.startedAt);
  const out: RunNode[] = [];
  const walk = (run: RunRecord, depth: number) => {
    const calls = store.countCalls(run.runId);
    out.push({ run, depth, calls, label: runLabel(run, kindFacts(store, run, calls)), ...runCost(store, run, options), interrupted: left.has(run.runId), attempts: attemptsUnder(run.runId) });
    for (const child of store.childRuns(run.runId)) if (ids.has(child.runId) && !folded.has(child.runId)) walk(child, depth + 1);
  };
  roots.forEach((r) => walk(r, 0));
  return out;
}

export function loadRequest(store: StoreOf<'recording'>, call: CallRecord): unknown {
  if (!call.requestRef) return null;
  return call.kind === 'api' ? loadApiRequest(store, call.requestRef) : store.getJson(call.requestRef);
}

export function loadResponseBytes(store: StoreOf<'recording'>, call: CallRecord): Buffer | null {
  const ref = call.end?.responseRef;
  return ref ? store.getBlob(ref) : null;
}

export interface ConversationAt {
  turns: Turn[];
  /** The api call whose request this conversation is. */
  fromCallNo: number;
  /**
   * The first turn this request added to the one the model call before it sent, in the same scope;
   * absent for a scope's first model call, whose turns are all it has.
   */
  freshFrom?: number;
}

/** Conversations by request, per store: a request's blob never changes, and the inspector reads the same ones again as you move. */
const conversations = new WeakMap<Store, Map<string, Turn[] | null>>();

function turnsOf(store: Store, c: CallRecord): Turn[] | null {
  if (c.kind !== 'api' || !c.requestRef) return null;
  let byRef = conversations.get(store);
  if (!byRef) conversations.set(store, (byRef = new Map<string, Turn[] | null>()));
  if (byRef.has(c.requestRef)) return byRef.get(c.requestRef)!;
  let turns: Turn[] | null;
  try {
    turns = normalizeConversation(loadApiRequest(store, c.requestRef))?.turns ?? null;
  } catch {
    turns = null;
  }
  if (byRef.size > 2000) byRef.clear();
  byRef.set(c.requestRef, turns);
  return turns;
}

const scopeOf = (c: CallRecord) => (typeof c.meta.scope === 'string' ? c.meta.scope : '');

/** How many model calls back to look for the conversation this one carries on. */
const LOOK_BACK = 50;

/**
 * Where `turns` carries on from: the longest of the `earlier` conversations that `turns` starts
 * with, turn for turn. A side call in the same scope (a title, a guardrail, a summary) sends a
 * conversation of its own, which isn't a start of the agent's and so doesn't count. Undefined when
 * none is: then nothing is marked new.
 */
export function freshSince(earlier: ReadonlyArray<readonly Turn[]>, turns: readonly Turn[]): number | undefined {
  const keys = turns.map((t) => JSON.stringify(t));
  let best: number | undefined;
  for (const e of earlier) {
    if (e.length > turns.length || (best !== undefined && e.length <= best)) continue;
    if (e.every((t, i) => JSON.stringify(t) === keys[i])) best = e.length;
  }
  return best;
}

/**
 * The conversation state at a call, whatever the provider. For a model call it is that call's own
 * request; for a tool, clock or random call it is the most recent model request before it. Every
 * model request carries the full conversation, so this needs no reconstruction.
 */
export function conversationAt(store: Store, calls: CallRecord[], index: number): ConversationAt | null {
  for (let i = index; i >= 0; i--) {
    const c = calls[i]!;
    if (c.kind !== 'api' || !c.requestRef) continue;
    const turns = turnsOf(store, c);
    if (!turns) return null;
    // The model calls before it in the same scope: a sub-agent's carry a conversation of their own.
    const earlier: Turn[][] = [];
    for (let j = i - 1; j >= 0 && earlier.length < LOOK_BACK; j--) {
      const p = calls[j]!;
      if (p.kind !== 'api' || !p.requestRef || scopeOf(p) !== scopeOf(c)) continue;
      const t = turnsOf(store, p);
      if (t) earlier.push(t);
    }
    const from = earlier.length ? freshSince(earlier, turns) : undefined;
    return { turns, fromCallNo: c.callNo, ...(from !== undefined ? { freshFrom: from } : {}) };
  }
  return null;
}

/** What a model call did, for its row: the tools it called, the first words it said, or how it ended. */
export interface ModelAction {
  text: string;
  tone?: 'warn' | 'err';
}

const STOPPED_SHORT = /^(max_tokens|length|MAX_TOKENS|max_output_tokens|incomplete)$/;

export function modelAction(store: StoreOf<'recording'>, call: CallRecord): ModelAction {
  const end = call.end;
  if (!end) return { text: '…' };
  if (end.outcome === 'error') return { text: end.meta.status ? `HTTP ${end.meta.status}` : (end.meta.error?.name ?? 'failed'), tone: 'err' };
  let r: NormalizedResponse;
  try {
    const provider = end.meta.provider ?? call.meta.provider;
    r = normalizeResponse(loadResponseBytes(store, call), end.meta.headers?.['content-type'], end.meta.chunks ?? [], typeof provider === 'string' ? provider : undefined);
  } catch {
    return { text: end.meta.stopReason ?? '' };
  }
  const stop = r.stopReason ?? end.meta.stopReason ?? null;
  if (stop && STOPPED_SHORT.test(stop)) return { text: `cut off: ${stop}`, tone: 'warn' };
  const tools = r.blocks.flatMap((b) => (b.type === 'tool_call' ? [b.name] : []));
  if (tools.length) return { text: `-> ${tools.join(', ')}` };
  const said = r.blocks.find((b) => b.type === 'text' && b.text.trim());
  if (said?.type === 'text') return { text: `"${said.text.trim().replace(/\s+/g, ' ')}"` };
  return { text: stop ?? '' };
}

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
