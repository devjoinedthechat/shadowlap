/**
 * Search across recorded content: prompts, responses, tool arguments and results, in every run. The
 * index is built on demand and kept only for runs that changed since, so recording never pays for it.
 * A model request repeats the whole conversation before it, so each model call indexes only the turns
 * it adds: a long run's index grows with its content, not with the square of it.
 */
import { classifyRun } from './classify.js';
import { normalizeConversation, type TurnBlock } from './conversation.js';
import { loadApiRequest } from './manifest.js';
import { normalizeResponse } from './responses.js';
import type { Store } from './store.js';
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

function docsFor(store: Store, calls: CallRecord[]): Array<{ callNo: number; field: string; text: string }> {
  const docs: Array<{ callNo: number; field: string; text: string }> = [];
  // Turns already indexed, per scope: branches have conversations of their own.
  const seen = new Map<string, number>();
  for (const c of calls) {
    try {
      if (c.kind === 'api') {
        if (c.requestRef) {
          const conv = normalizeConversation(loadApiRequest(store, c.requestRef));
          if (conv) {
            const scope = typeof c.meta.scope === 'string' ? c.meta.scope : '';
            const before = seen.get(scope) ?? 0;
            // A conversation that got shorter started over: index all of it.
            const from = before <= conv.turns.length ? before : 0;
            seen.set(scope, conv.turns.length);
            const text = conv.turns
              .slice(from)
              .flatMap((t) => t.blocks.map(blockText))
              .filter(Boolean)
              .join('\n');
            if (text) docs.push({ callNo: c.callNo, field: 'prompt', text: cap(text) });
          }
        }
        const end = c.end;
        if (end?.responseRef) {
          const provider = end.meta.provider ?? c.meta.provider;
          const r = normalizeResponse(store.getBlob(end.responseRef), end.meta.headers?.['content-type'], end.meta.chunks ?? [], typeof provider === 'string' ? provider : undefined);
          const text = r.blocks.map((b) => (b.type === 'tool_call' ? `${b.name} ${JSON.stringify(b.input)}` : b.text)).join('\n');
          if (text) docs.push({ callNo: c.callNo, field: 'response', text: cap(text) });
        }
      } else if (c.kind === 'tool') {
        if (c.requestRef) {
          const args = store.getJson<{ args?: unknown }>(c.requestRef)?.args;
          docs.push({ callNo: c.callNo, field: 'arguments', text: cap(`${c.name} ${strings(args).join(' ')}`) });
        }
        if (c.end?.responseRef) {
          const text = strings(store.getJson(c.end.responseRef)).join(' ');
          if (text) docs.push({ callNo: c.callNo, field: 'result', text: cap(text) });
        }
      }
    } catch {
      // an unreadable call is left out of the index
    }
  }
  return docs;
}

/** Brings the index up to date: runs that are new, still running, or changed since they were indexed. Returns how many were (re)indexed. */
export function updateSearchIndex(store: Store): number {
  let updated = 0;
  for (const run of store.allRuns()) {
    const count = store.countCalls(run.runId);
    const state = store.searchState(run.runId);
    if (state && state.calls === count && state.status === run.status && run.status !== 'running') continue;
    store.replaceSearchDocs(run.runId, count, run.status, docsFor(store, store.getCalls(run.runId)));
    updated++;
  }
  return updated;
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
