import { basename } from 'node:path';
import { links } from '@shadowlap/dashboard';
import { recordEvent, type StoreOf } from '@shadowlap/engine';
import { append, IMPORTED_LABEL, type ImportedCall, type ImportResult, type Skip } from './import-capture.js';
import { emitJobEvent } from './job-events.js';

/**
 * What every `shadowlap import` subcommand does once its runs are written: drop the runs that got
 * no calls, log each kept one in the activity feed, tell a dashboard job about it, and describe the
 * whole import as one JSON object — the object `--json` prints and the job's result.
 */

export type ImportFormat = 'har' | 'nock' | 'vcr' | 'litellm' | 'otel' | 'langfuse' | 'langsmith' | 'phoenix' | 'logfire';

/** What a trace source kept, for the import to say so. */
export interface TraceKept {
  /** Traces read (an OpenTelemetry file can hold several; a trace store returns one). */
  traces: number;
  /** Spans, observations or runs read, of every kind. */
  spans: number;
  /** Model calls found, and how many of them were imported (the rest kept no messages). */
  modelCalls: number;
  modelCallsImported: number;
  /** Imported model calls that carried their model settings (temperature, token limit, ...). */
  withSettings: number;
  /** Imported model calls that carried the tool definitions the model was given. */
  withToolDefinitions: number;
  /** Tool calls found, and how many kept their arguments and output (those replay; the rest run live). */
  toolCalls: number;
  toolCallsKept: number;
}

export interface ImportJsonRun {
  /** The full run id: what a dashboard job opens. */
  runId: string;
  /** The run's source as stored (`meta.imported.from`): the file's name (or names), or `langfuse:7f3a9c2e`. */
  source: string;
  /** LiteLLM: the correlation id the calls shared. A trace: its id where it came from. Otherwise null. */
  key: string | null;
  calls: { model: number; tool: number };
  labels: string[];
  imported: ImportedCall[];
}

export interface ImportJson {
  format: ImportFormat;
  /** Entries read: HAR entries, nock definitions, cassette interactions, capture lines, spans, observations or runs. */
  entries: number;
  /** One per run made, in order. Empty when nothing could be imported. */
  runs: ImportJsonRun[];
  /** Everything that made no call, with the reason, in the order it was read. */
  skipped: Skip[];
  /** Traces only: what the source kept. */
  kept?: TraceKept;
  /** An import of the traces in a window (a trace store's, without a trace id): the window it read. */
  window?: { since: string; until: string; limit: number; traceName: string | null };
  /** ... and each trace the store listed in it, newest first, with what became of it. */
  traces?: ImportJsonTrace[];
}

/**
 * A trace an import of a window found: `imported` as `runId`; `already` imported, as `runId`, by an
 * earlier import, and left as it is; `skipped` for `reason` (it held nothing to import, or the store
 * can't give it whole); `failed`, where the store failed and the import stopped; `unread` after that.
 */
export interface ImportJsonTrace {
  id: string;
  name: string | null;
  /** When it started (ISO 8601), where the store says. */
  startedAt: string | null;
  outcome: 'imported' | 'already' | 'skipped' | 'failed' | 'unread';
  runId: string | null;
  reason: string | null;
}

export interface ImportedRun {
  /** LiteLLM: the correlation id; a trace: its id. */
  key: string | null;
  result: ImportResult;
}

/** What the activity feed and an import dialog call the source: a file's name, or `langfuse:7f3a9c2e`. */
export function sourceName(source: string): string {
  return /^(langfuse|langsmith|phoenix|logfire):/.test(source) ? source : basename(source) || source;
}

/**
 * The source an import of files records: their names, never their folders. A path names this
 * machine's folders (a home folder, a dashboard upload's temporary one) and would travel with the
 * run wherever the store goes. Several files are named up to three, then counted.
 */
export function fileSource(paths: readonly string[]): string {
  const names = [...new Set(paths.map((p) => basename(p)))];
  return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

/** Runs an import links one by one in a dashboard job's drawer; past that, the Runs page. */
const IMPORT_LINKS = 3;

/**
 * The Runs page filtered to an import's runs: the label every imported run carries, and the source
 * they share (a dashboard import names it with --name), escaped as the dashboard's links are.
 */
export function importedRunsLink(runs: ReadonlyArray<Pick<ImportJsonRun, 'source'>>): string {
  const sources = new Set(runs.map((r) => sourceName(r.source)));
  return links.runs({ q: sources.size === 1 ? `${IMPORTED_LABEL} ${[...sources][0]!}` : IMPORTED_LABEL });
}

/**
 * Settles one run an import wrote: deletes it when it holds no call, else records `capture.imported`
 * for it and returns it as `--json` lists it.
 */
export function settleRun(store: StoreOf<'recording' | 'activity'>, o: { format: ImportFormat; key: string | null; result: ImportResult; author?: string | null }): ImportJsonRun | null {
  const { result, key } = o;
  if (!result.imported.length) {
    store.deleteRun(result.run.runId);
    return null;
  }
  const source = result.run.meta?.imported?.from ?? '';
  const calls = { model: result.imported.filter((c) => c.kind === 'api').length, tool: result.imported.filter((c) => c.kind === 'tool').length };
  recordEvent(store, {
    kind: 'capture.imported',
    actor: o.author ?? null,
    runId: result.run.runId,
    ref: sourceName(source),
    data: { format: o.format, from: source, key, modelCalls: calls.model, toolCalls: calls.tool },
  });
  return { runId: result.run.runId, source, key, calls, labels: result.run.meta?.labels ?? [], imported: result.imported };
}

/**
 * Tells a dashboard job what an import made: each run (`{ type: 'run', role: 'imported' }`), links
 * to them, and the result.
 */
export function reportImportJob(json: ImportJson, env: NodeJS.ProcessEnv = process.env): void {
  const { runs } = json;
  for (const r of runs) emitJobEvent({ type: 'run', runId: r.runId, role: 'imported' }, env);
  // A dashboard job opens the run it made. One that made a few links each (a LiteLLM file holds a run
  // per correlation id); past that, the Runs page, filtered to them, lists them all.
  if (runs.length > IMPORT_LINKS) emitJobEvent({ type: 'link', label: `All ${runs.length} on Runs`, href: importedRunsLink(runs) }, env);
  else if (runs.length > 1) for (const r of runs) emitJobEvent({ type: 'link', label: `Open ${r.runId.slice(0, 10)}`, href: links.run(r.runId) }, env);
  emitJobEvent({ type: 'result', data: json }, env);
}

/**
 * Settles an import: deletes the runs that hold no call, records `capture.imported` for each run
 * kept, reports each to a dashboard job followed by the result, and returns that result. Skips come
 * first from `skipped` (what the file itself couldn't offer), then from each run in order.
 */
export function settleImport(
  store: StoreOf<'recording' | 'activity'>,
  o: { format: ImportFormat; entries: number; runs: ImportedRun[]; skipped?: Skip[]; kept?: TraceKept; author?: string | null; env?: NodeJS.ProcessEnv },
): ImportJson {
  const skipped: Skip[] = [...(o.skipped ?? [])];
  const runs: ImportJsonRun[] = [];
  for (const { key, result } of o.runs) {
    append(skipped, result.skipped);
    const run = settleRun(store, { format: o.format, key, result, author: o.author ?? null });
    if (run) runs.push(run);
  }
  const json: ImportJson = { format: o.format, entries: o.entries, runs, skipped, ...(o.kept ? { kept: o.kept } : {}) };
  reportImportJob(json, o.env ?? process.env);
  return json;
}
