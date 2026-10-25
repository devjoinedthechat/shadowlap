import { kindFacts, loadApiRequest, modelResolver, normalizeConversation, runLabel, summarizeRun, type CallRecord, type ModelResolver, type Price, type RunRecord, type Store, type SummaryOptions, type Turn } from '@shadowlap/engine';

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
}

export interface CostOptions {
  prices?: Record<string, Price>;
  modelOf: ModelResolver;
}

export function summaryOptions(store: Store, prices?: Record<string, Price>): SummaryOptions {
  return { ...(prices ? { prices } : {}), modelOf: modelResolver(store) };
}

type RunCost = { spent: number; saved: number; captured: number };
const costCache = new Map<string, RunCost>();

/** Cost of a run; finished runs are summed once, a recording run is re-summed on every refresh. */
export function runCost(store: Store, run: RunRecord, options: CostOptions): RunCost {
  const cached = run.status !== 'running' ? costCache.get(run.runId) : undefined;
  if (cached) return cached;
  const s = summarizeRun(run, store.getCalls(run.runId), [], [], options);
  const cost = { spent: s.cost.spent, saved: s.cost.saved, captured: s.cost.captured };
  if (run.status !== 'running') costCache.set(run.runId, cost);
  return cost;
}

/** Runs as a tree: roots oldest first, children under their parent, oldest first. */
export function loadRunTree(store: Store, options: CostOptions, limit = 500): RunNode[] {
  const runs = store.listRuns(limit);
  const ids = new Set(runs.map((r) => r.runId));
  const roots = runs.filter((r) => !r.parentRunId || !ids.has(r.parentRunId)).sort((a, b) => a.startedAt - b.startedAt);
  const out: RunNode[] = [];
  const left = runs.some((r) => r.status === 'running') ? new Set(store.recordingRuns().abandoned.map((r) => r.run.runId)) : new Set<string>();
  const walk = (run: RunRecord, depth: number) => {
    const calls = store.countCalls(run.runId);
    out.push({ run, depth, calls, label: runLabel(run, kindFacts(store, run, calls)), ...runCost(store, run, options), interrupted: left.has(run.runId) });
    for (const child of store.childRuns(run.runId)) if (ids.has(child.runId)) walk(child, depth + 1);
  };
  roots.forEach((r) => walk(r, 0));
  return out;
}

export function loadRequest(store: Store, call: CallRecord): unknown {
  if (!call.requestRef) return null;
  return call.kind === 'api' ? loadApiRequest(store, call.requestRef) : store.getJson(call.requestRef);
}

export function loadResponseBytes(store: Store, call: CallRecord): Buffer | null {
  const ref = call.end?.responseRef;
  return ref ? store.getBlob(ref) : null;
}

export interface ConversationAt {
  turns: Turn[];
  /** The api call whose request this conversation is. */
  fromCallNo: number;
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
    try {
      const conv = normalizeConversation(loadApiRequest(store, c.requestRef));
      return conv ? { turns: conv.turns, fromCallNo: c.callNo } : null;
    } catch {
      return null;
    }
  }
  return null;
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
