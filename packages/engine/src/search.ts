/**
 * Search across recorded content: prompts, responses, tool arguments and results, in every run. The
 * index is built on demand and kept only for runs that changed since, so recording never pays for it.
 * A model request repeats the whole conversation before it, so each model call indexes only the turns
 * it adds: a long run's index grows with its content, not with the square of it. A run is indexed a
 * batch of calls at a time and remembers where it stopped, so the index can be brought up to date in
 * slices (the dashboard does, while it is idle), and a run still recording is indexed from its newest
 * calls on rather than from its first call again.
 */
import { classifyRun } from './classify.js';
import { normalizeConversation, type TurnBlock } from './conversation.js';
import { loadApiRequest } from './manifest.js';
import { normalizeResponse } from './responses.js';
import type { SearchState, Store } from './store.js';
import type { CallKind, CallRecord } from './types.js';

const DOC_MAX = 100_000;

/** Marks around matched terms in a snippet: characters that never appear in recorded text as typed. */
export const MATCH_START = String.fromCharCode(1);
export const MATCH_END = String.fromCharCode(2);

export interface SearchHit {
  runId: string;
  callNo: number;
  kind: CallKind;
  name: string;
  /** Where the text matched: `prompt`, `response`, `arguments` or `result`. */
  field: string;
  /** The text around the match, with MATCH_START before and MATCH_END after each matched term. */
  snippet: string;
  runStartedAt: number;
}

function blockText(b: TurnBlock): string {
  switch (b.type) {
    case 'text':
    case 'thinking':
      return b.text;
    case 'tool_call':
      return `${b.name} ${JSON.stringify(b.input)}`;
    case 'tool_result':
      return b.content;
    default:
      return '';
  }
}

/** Every key and value in a JSON value: arguments and results read as their content, not their syntax. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (typeof v === 'number' || typeof v === 'boolean') out.push(String(v));
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      strings(x, out);
    }
  }
  return out;
}

const cap = (s: string) => (s.length > DOC_MAX ? s.slice(0, DOC_MAX) : s);

type Doc = { callNo: number; field: string; text: string };

/**
 * What a call's start adds to the index: the turns a model call's request adds to its conversation
 * (`scopes`, the turns already indexed per scope, moves on), or a tool call's arguments.
 */
function startDocs(store: Store, c: CallRecord, scopes: Record<string, number>): Doc[] {
  try {
    if (c.kind === 'api' && c.requestRef) {
      const conv = normalizeConversation(loadApiRequest(store, c.requestRef));
      if (!conv) return [];
      // Branches have conversations of their own.
      const scope = typeof c.meta.scope === 'string' ? c.meta.scope : '';
      const before = scopes[scope] ?? 0;
      // A conversation that got shorter started over: index all of it.
      const from = before <= conv.turns.length ? before : 0;
      scopes[scope] = conv.turns.length;
      const text = conv.turns
        .slice(from)
        .flatMap((t) => t.blocks.map(blockText))
        .filter(Boolean)
        .join('\n');
      return text ? [{ callNo: c.callNo, field: 'prompt', text: cap(text) }] : [];
    }
    if (c.kind === 'tool' && c.requestRef) {
      const args = store.getJson<{ args?: unknown }>(c.requestRef)?.args;
      return [{ callNo: c.callNo, field: 'arguments', text: cap(`${c.name} ${strings(args).join(' ')}`) }];
    }
  } catch {
    // an unreadable call is left out of the index
  }
  return [];
}

/** What a call's answer adds to the index: a model's response, or a tool's result. */
function endDocs(store: Store, c: CallRecord): Doc[] {
  const end = c.end;
  if (!end?.responseRef) return [];
  try {
    if (c.kind === 'api') {
      const provider = end.meta.provider ?? c.meta.provider;
      const r = normalizeResponse(store.getBlob(end.responseRef), end.meta.headers?.['content-type'], end.meta.chunks ?? [], typeof provider === 'string' ? provider : undefined);
      const text = r.blocks.map((b) => (b.type === 'tool_call' ? `${b.name} ${JSON.stringify(b.input)}` : b.text)).join('\n');
      return text ? [{ callNo: c.callNo, field: 'response', text: cap(text) }] : [];
    }
    if (c.kind === 'tool') {
      const text = strings(store.getJson(c.end!.responseRef!)).join(' ');
      return text ? [{ callNo: c.callNo, field: 'result', text: cap(text) }] : [];
    }
  } catch {
    // an unreadable answer is left out of the index
  }
  return [];
}

/**
 * Where indexing a run stopped, kept in its `search_state` row: the last call whose start was
 * indexed, the turns indexed per scope, and the calls whose answer is not indexed yet. A run is
 * indexed a batch at a time, and a run still recording from where the last look stopped, so its
 * index grows with its calls instead of being built again from its first call.
 */
interface Progress {
  last: number;
  scopes: Record<string, number>;
  /** Still on their way, or answered with a failure the agent may retry: their answer is indexed once it is final. */
  open: number[];
}

/** Calls read and indexed at a time. */
const BATCH = 200;

/** A run as the index needs to know it: its status and how many calls it has. */
export interface SearchIndexRun {
  runId: string;
  status: string;
  calls: number;
}

function progressOf(state: SearchState): Progress | null {
  if (state.progress === null) return null;
  try {
    const p = JSON.parse(state.progress) as Partial<Progress>;
    if (typeof p.last !== 'number' || typeof p.scopes !== 'object' || p.scopes === null || !Array.isArray(p.open)) return null;
    return { last: p.last, scopes: { ...p.scopes }, open: p.open.filter((n): n is number => typeof n === 'number') };
  } catch {
    return null;
  }
}

/**
 * Whether the index is behind on a run (`behind`: calls not indexed, or a run that ended since), has
 * only answers still on their way (`open`: a recording's newest call), or covers it (`none`).
 */
function standing(run: SearchIndexRun, state: SearchState | undefined | null): 'behind' | 'open' | 'none' {
  if (!state) return 'behind';
  // A row that covers its run whole, as an earlier Shadowlap wrote every row.
  if (state.progress === null) return state.calls === run.calls && state.status === run.status ? 'none' : 'behind';
  if (run.status !== 'running' || state.status !== run.status || state.calls < run.calls) return 'behind';
  return progressOf(state)?.open.length ? 'open' : 'none';
}

/** An answer the index can take: any, once the run has ended; while it records, one the agent won't retry. */
function settled(c: CallRecord, running: boolean): boolean {
  if (!running) return true;
  return c.end !== null && !(c.end.outcome === 'error' && c.end.meta.retryable === true);
}

/**
 * Indexes the next batch of a run: the answers that arrived for its open calls and up to BATCH calls
 * after the last one indexed, stopping early past `deadline`. False when there was nothing to index;
 * 'busy' when another command was writing the store and `briefly` would not wait for it.
 */
function indexBatch(store: Store, run: SearchIndexRun, state: SearchState | null, deadline: number, briefly: boolean): boolean | 'busy' {
  let p = state ? progressOf(state) : { last: 0, scopes: {}, open: [] };
  let fresh = false;
  let indexed = state && p ? state.calls : 0;
  if (state && state.progress === null) {
    // A row that covered its run whole when the run had ended, and only its status moved since:
    // what it holds stands.
    if (state.calls === run.calls && state.status !== 'running' && run.status !== 'running') {
      return store.addSearchDocs(run.runId, { expected: state, next: { ...state, status: run.status }, docs: [], briefly }) === 'busy' ? 'busy' : true;
    }
  }
  if (!p) {
    // Indexed whole before it ended (an earlier Shadowlap), or by a row this one can't read: again from its start.
    p = { last: 0, scopes: {}, open: [] };
    fresh = true;
    indexed = 0;
  }
  const running = run.status === 'running';
  const docs: Doc[] = [];
  const open: number[] = [];
  let moved = false;
  for (const c of p.open.length ? store.getCalls(run.runId, { only: p.open }) : []) {
    if (!settled(c, running)) {
      open.push(c.callNo);
      continue;
    }
    docs.push(...endDocs(store, c));
    moved = true;
  }
  // An open call gone from the store (its run deleted meanwhile) is dropped.
  if (open.length !== p.open.length) moved = true;
  for (const c of store.getCalls(run.runId, { after: p.last, limit: BATCH })) {
    docs.push(...startDocs(store, c, p.scopes));
    if (settled(c, running)) docs.push(...endDocs(store, c));
    else open.push(c.callNo);
    p.last = c.callNo;
    indexed++;
    moved = true;
    if (performance.now() >= deadline) break;
  }
  const whole = !running && open.length === 0 && indexed >= run.calls;
  if (!moved && state && state.status === run.status && !whole) return false;
  const next: SearchState = { calls: indexed, status: run.status, progress: whole ? null : JSON.stringify({ last: p.last, scopes: p.scopes, open }) };
  // Another process indexing the same run meanwhile wins; the next look starts from where it got to.
  return store.addSearchDocs(run.runId, { expected: state, next, docs, fresh, briefly }) === 'busy' ? 'busy' : true;
}

/** The store's runs as the index needs them, newest first. */
function storeRuns(store: Store): SearchIndexRun[] {
  return store.allRuns().map((r) => ({ runId: r.runId, status: r.status, calls: store.countCalls(r.runId) }));
}

/** How many of `runs` (every run in the store when not given) the index is behind on: calls not indexed yet, or a run that ended since. */
export function searchIndexBehind(store: Store, runs: readonly SearchIndexRun[] = storeRuns(store)): number {
  const states = store.searchStates();
  return runs.filter((r) => standing(r, states.get(r.runId)) === 'behind').length;
}

/**
 * Brings the index up to date for about `budgetMs` (no limit unless asked), newest runs first, a
 * batch of calls at a time: runs that are new or ended since they were indexed, and the calls a run
 * still recording made since. Each batch is written as it is done, so a slice cut short keeps what it
 * did, and the next one goes on from there. `runs` saves reading the run list when the caller has it.
 * `briefly` waits for another command's write a moment only, as a dashboard must on the thread that
 * answers its pages: while gc, a pull or an import writes the store, the slice stops at the batch it
 * could not write, writing nothing more (`busy`), and a later one goes on. Returns the batches
 * written, and how many runs the index is still behind on (0 when it caught up).
 */
export function indexSearch(store: Store, options: { budgetMs?: number; runs?: readonly SearchIndexRun[]; briefly?: boolean } = {}): { batches: number; behind: number; busy?: true } {
  const deadline = performance.now() + (options.budgetMs ?? Number.POSITIVE_INFINITY);
  const runs = options.runs ?? storeRuns(store);
  const states = store.searchStates();
  const briefly = options.briefly === true;
  let batches = 0;
  for (const run of runs) {
    if (standing(run, states.get(run.runId)) === 'none') continue;
    for (let state = store.searchState(run.runId); standing(run, state) !== 'none'; state = store.searchState(run.runId)) {
      const done = indexBatch(store, run, state, deadline, briefly);
      if (done === 'busy') return { batches, behind: searchIndexBehind(store, runs), busy: true };
      if (!done) break;
      batches++;
      if (performance.now() >= deadline) return { batches, behind: searchIndexBehind(store, runs) };
    }
  }
  return { batches, behind: searchIndexBehind(store, runs) };
}

/** Brings the index up to date: runs that are new, still recording, or changed since they were indexed. Returns how many runs it indexed. */
export function updateSearchIndex(store: Store): number {
  const runs = storeRuns(store);
  const states = store.searchStates();
  const touched = runs.filter((r) => standing(r, states.get(r.runId)) !== 'none');
  indexSearch(store, { runs: touched });
  const after = store.searchStates();
  return touched.filter((r) => {
    const a = after.get(r.runId);
    const b = states.get(r.runId);
    return !b || !a || a.calls !== b.calls || a.status !== b.status || a.progress !== b.progress;
  }).length;
}

/**
 * A query as an FTS5 expression: every word must appear, and "quoted words" must appear together.
 * Anything that looks like FTS syntax is taken as plain text.
 */
export function searchExpression(query: string): string | null {
  const parts: string[] = [];
  for (const m of query.matchAll(/"([^"]*)"|(\S+)/g)) {
    const text = (m[1] ?? m[2] ?? '').replace(/"/g, '').trim();
    if (text) parts.push(`"${text}"`);
  }
  return parts.length ? parts.join(' ') : null;
}

/**
 * The calls whose recorded content matches, best first. Attempts (blame's probes, verify's attempts,
 * `replay --repeat`'s) repeat the run they came from word for word, so they rank after the runs
 * people made: a search shows the recording before five copies of it. A search within one run
 * (`runId`) keeps the index's order.
 */
export function searchCalls(store: Store, query: string, opts: { limit?: number; runId?: string } = {}): SearchHit[] {
  const match = searchExpression(query);
  if (!match) return [];
  updateSearchIndex(store);
  const limit = opts.limit ?? 50;
  const hits: Array<{ hit: SearchHit; attempt: boolean }> = [];
  const runs = new Map<string, { startedAt: number; attempt: boolean; calls: Map<number, CallRecord> }>();
  // Read past the limit, so the runs people made can come first even when attempts rank as high:
  // four times as many rows, at most 1,000 unless the limit asks for more, and never fewer than it.
  const read = opts.runId ? limit : Math.max(limit, Math.min(limit * 4, 1000));
  for (const h of store.searchDocs(match, read, opts.runId)) {
    let run = runs.get(h.runId);
    if (!run) {
      const record = store.getRun(h.runId);
      if (!record) continue;
      run = { startedAt: record.startedAt, attempt: classifyRun(record).attemptOf !== null, calls: new Map(store.getCalls(h.runId).map((c) => [c.callNo, c])) };
      runs.set(h.runId, run);
    }
    const call = run.calls.get(h.callNo);
    if (!call) continue;
    hits.push({ hit: { runId: h.runId, callNo: h.callNo, kind: call.kind, name: call.name, field: h.field, snippet: h.snippet, runStartedAt: run.startedAt }, attempt: run.attempt });
  }
  return [...hits.filter((h) => !h.attempt), ...hits.filter((h) => h.attempt)].slice(0, limit).map((h) => h.hit);
}
