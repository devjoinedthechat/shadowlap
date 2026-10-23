import { basename } from 'node:path';
import { recordEvent, type Store } from '@shadowlap/engine';
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
 * they share (a dashboard import names it with --name). Every character a link's fragment can't
 * hold as it is, escaped.
 */
export function importedRunsLink(runs: ReadonlyArray<Pick<ImportJsonRun, 'source'>>): string {
  const sources = new Set(runs.map((r) => sourceName(r.source)));
  const q = sources.size === 1 ? `${IMPORTED_LABEL} ${[...sources][0]!}` : IMPORTED_LABEL;
  return `#/runs?q=${encodeURIComponent(q).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/**
 * Settles an import: deletes the runs that hold no call, records `capture.imported` for each run
 * kept, reports each to a dashboard job (`{ type: 'run', role: 'imported' }`) followed by the
 * result, and returns that result. Skips come first from `skipped` (what the file itself couldn't
 * offer), then from each run in order.
 */
export function settleImport(
  store: Store,
  o: { format: ImportFormat; entries: number; runs: ImportedRun[]; skipped?: Skip[]; kept?: TraceKept; author?: string | null; env?: NodeJS.ProcessEnv },
): ImportJson {
  const skipped: Skip[] = [...(o.skipped ?? [])];
  const runs: ImportJsonRun[] = [];
  for (const { key, result } of o.runs) {
    append(skipped, result.skipped);
    if (!result.imported.length) {
      store.deleteRun(result.run.runId);
      continue;
    }
    const source = result.run.meta?.imported?.from ?? '';
    const calls = { model: result.imported.filter((c) => c.kind === 'api').length, tool: result.imported.filter((c) => c.kind === 'tool').length };
    runs.push({ runId: result.run.runId, source, key, calls, labels: result.run.meta?.labels ?? [], imported: result.imported });
    recordEvent(store, {
      kind: 'capture.imported',
      actor: o.author ?? null,
      runId: result.run.runId,
      ref: sourceName(source),
      data: { format: o.format, from: source, key, modelCalls: calls.model, toolCalls: calls.tool },
    });
  }
  const json: ImportJson = { format: o.format, entries: o.entries, runs, skipped, ...(o.kept ? { kept: o.kept } : {}) };
  const env = o.env ?? process.env;
  for (const r of runs) emitJobEvent({ type: 'run', runId: r.runId, role: 'imported' }, env);
  // A dashboard job opens the run it made. One that made a few links each (a LiteLLM file holds a run
  // per correlation id); past that, the Runs page, filtered to them, lists them all.
  if (runs.length > IMPORT_LINKS) emitJobEvent({ type: 'link', label: `All ${runs.length} on Runs`, href: importedRunsLink(runs) }, env);
  else if (runs.length > 1) for (const r of runs) emitJobEvent({ type: 'link', label: `Open ${r.runId.slice(0, 10)}`, href: `#/run/${r.runId}` }, env);
  emitJobEvent({ type: 'result', data: json }, env);
  return json;
}
