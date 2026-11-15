import type { FactWords } from '../actions.js';
import { quoteArg } from '../job-title.js';
import { guessImportFormat, IMPORT_FILE_FORMATS, type ImportFileFormat } from '../../../engine/src/import-format.js';
import { IMPORT_WINDOW_FLAGS, importWindowFieldProblem, importWindowProblem, type ImportWindow } from '../../../engine/src/import-window.js';
import { OTEL_SAMPLE, OTEL_SAMPLE_NAME, type OtlpSpan, type OtlpTrace } from './sample-otel.js';

/**
 * Import a capture or a trace: which format a file is, what each trace store keeps, and the sample
 * the dialog offers. The format is the engine's `guessImportFormat` (the file's name, then its first
 * bytes when the name says nothing); the CLI detects nothing (the format is its subcommand), so the
 * dialog says which it will run and lets the person change it. No DOM here: the tests import it.
 */

export { IMPORT_FILE_FORMATS, OTEL_SAMPLE_NAME, importWindowFieldProblem, type ImportFileFormat, type ImportWindow };

/** The formats the select offers, in the CLI's order; `IMPORT_FILE_FORMATS` names each. */
export const FILE_FORMATS = Object.keys(IMPORT_FILE_FORMATS) as ImportFileFormat[];

/** What the file picker offers. */
export const IMPORT_ACCEPT = '.har,.json,.jsonl,.yaml,.yml';

/** How much of a file's start the guess reads: enough for the top-level keys that say what it is. */
export const HEAD_BYTES = 4096;

/** A file's first bytes, or undefined when the browser can't read them (its name alone decides then). */
export async function fileHead(file: Blob): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
  } catch {
    return undefined;
  }
}

/**
 * What the dialog makes of a file picked: the format `guessImportFormat` gives its name and first
 * bytes (a HAR saved as .json is HAR, OTLP lines in a .jsonl are OpenTelemetry), or why it can't
 * be imported from here: YAML or another format, with the engine's reason, or a file larger than
 * the dashboard takes.
 */
export function pickedFormat(name: string, bytes: number, head: Uint8Array | string | undefined, limit: number | null): { format: ImportFileFormat | null; error: string | null } {
  const g = guessImportFormat(name, head);
  return { format: g.format, error: g.reason ?? tooLargeNote(bytes, limit, g.format) };
}

/** The formats whose import puts a run together from several files: a LiteLLM proxy's file per worker, traces apart from their logs. */
export const SEVERAL_FILES: ReadonlySet<ImportFileFormat> = new Set(['litellm', 'otel']);

/** The most files one import takes from the dashboard (routes/imports.ts MAX_IMPORT_FILES). */
export const MAX_FILES = 20;

/**
 * What the dialog makes of several files picked at once: the format each one's name and first bytes
 * give, the same for all, and one the CLI puts a run together from (LiteLLM, OpenTelemetry); else why
 * they can't go in together. A file the guess refuses, or one too large, says why with its name.
 */
export function pickedFormats(files: ReadonlyArray<{ name: string; bytes: number; head: Uint8Array | string | undefined }>, limit: number | null): { format: ImportFileFormat | null; error: string | null } {
  if (files.length === 1) return pickedFormat(files[0]!.name, files[0]!.bytes, files[0]!.head, limit);
  if (files.length > MAX_FILES) return { format: null, error: `${files.length} files are more than one import takes (${MAX_FILES}): import the rest in a terminal, or in a second import.` };
  const each = files.map((f) => ({ name: f.name, ...pickedFormat(f.name, f.bytes, f.head, limit) }));
  const refused = each.find((f) => f.error);
  if (refused) return { format: null, error: `${refused.name}: ${refused.error!}` };
  const formats = [...new Set(each.map((f) => f.format!))];
  if (formats.length > 1) return { format: null, error: `These files are of different formats (${formats.map((f) => IMPORT_FILE_FORMATS[f]).join(' and ')}): several go in together only as LiteLLM captures or as OpenTelemetry exports.` };
  return { format: formats[0]!, error: severalNote(files.length, formats[0]!) };
}

/** Why the files can't go in together as `format`, or null: several only where the CLI puts a run together from them. */
export function severalNote(count: number, format: ImportFileFormat): string | null {
  return count > 1 && !SEVERAL_FILES.has(format) ? `Several files go in together only as LiteLLM captures or as OpenTelemetry exports: import a ${IMPORT_FILE_FORMATS[format]} file on its own.` : null;
}

/** A file larger than the dashboard takes: what to do instead. */
export function tooLargeNote(bytes: number, limit: number | null, format: ImportFileFormat | null): string | null {
  if (limit === null || bytes <= limit) return null;
  const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;
  return `This file is ${mb(bytes)}, more than the dashboard takes (${mb(limit)}): import it in a terminal with shadowlap import ${format ?? '<format>'} <file>.`;
}

export type TraceSource = 'langfuse' | 'langsmith' | 'phoenix' | 'logfire';

/**
 * What each trace store keeps, its name, what its trace ids look like, and the keys it is read with:
 * the field's placeholder names the format rather than showing a made-up id. Langfuse's SDKs write
 * a UUID, or 32 hex characters since they moved onto OpenTelemetry; LangSmith's trace is its root
 * run's UUID; Phoenix and Logfire show OpenTelemetry's. `holds` is what the source keeps beyond the
 * messages and model settings; `keys` names them until the dashboard says which it reads; `keyQuiet`
 * says where they matter (a Phoenix without authentication needs none); `looksBack` that a trace is
 * searched for back 30 days unless Looks back says further, as the CLI's --since does.
 */
export const TRACE_COPY: Readonly<Record<TraceSource, { name: string; id: string; idRule: string; holds: string; keys: string; keyQuiet?: string; looksBack?: true }>> = {
  langfuse: {
    name: 'Langfuse',
    id: 'a UUID or 32 hex characters, from the trace’s page',
    idRule: 'letters, digits, dashes, dots and colons',
    holds: 'a tool’s output only where the trace has it; tool definitions often aren’t stored',
    keys: '`LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`',
  },
  langsmith: {
    name: 'LangSmith',
    id: 'a UUID, from the trace’s page in LangSmith',
    idRule: 'letters, digits, dashes, dots and colons',
    holds: 'a tool’s output where you logged it',
    keys: '`LANGSMITH_API_KEY`',
  },
  phoenix: {
    name: 'Phoenix',
    id: '32 hex characters, from the trace’s page in Phoenix',
    idRule: '32 hex characters',
    holds: 'tool definitions, and a tool’s output where its instrumentation logged it',
    keys: '`PHOENIX_API_KEY`',
    keyQuiet: 'where your Phoenix asks for one; nothing passes through Shadowlap',
  },
  logfire: {
    name: 'Logfire',
    id: '32 hex characters, from the trace’s details in Logfire',
    idRule: '32 hex characters',
    holds: 'tool definitions, a tool’s arguments, and its result with `record_return=True`',
    keys: '`LOGFIRE_READ_TOKEN`',
    looksBack: true,
  },
};

/** The stores whose traces an import reads in a window, as `shadowlap import` does without a trace id; LangSmith's go one at a time. */
export const WINDOWED: ReadonlySet<TraceSource> = new Set(['langfuse', 'phoenix', 'logfire']);

/** A window's fields as the dialog shows them, each empty until typed (the CLI's own then: the last 30 days, the newest 100). */
export interface WindowFields {
  since: string;
  until: string;
  limit: string;
  traceName: string;
}

export const NO_WINDOW: WindowFields = { since: '', until: '', limit: '', traceName: '' };

/** The window as the job sends it and the command line shows it: only the fields typed. */
export function windowGiven(w: WindowFields): ImportWindow {
  const given: ImportWindow = {};
  for (const k of Object.keys(IMPORT_WINDOW_FLAGS) as Array<keyof ImportWindow>) if (w[k].trim()) given[k] = w[k].trim();
  return given;
}

/** Why the window typed can't be read, in the CLI's words; null when it can. */
export function windowNote(w: WindowFields, now: number = Date.now()): string | null {
  return importWindowProblem(windowGiven(w), now);
}

/** The window's flags as one types them: `--since 7d --limit 50`. */
function windowFlags(w: ImportWindow): string {
  return (Object.keys(IMPORT_WINDOW_FLAGS) as Array<keyof ImportWindow>)
    .filter((k) => w[k])
    .map((k) => ` ${IMPORT_WINDOW_FLAGS[k]} ${quoteArg(w[k]!)}`)
    .join('');
}

/** A trace id as Langfuse and LangSmith write them, as the CLI checks it. */
export const TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
/** A trace id as OpenTelemetry writes it, which is how Phoenix and Logfire show theirs. */
export const OTEL_TRACE_ID = /^[0-9a-f]{32}$/i;

/** Whether `id` is a trace id of the store's, as the CLI checks it. */
export function traceIdOk(source: TraceSource, id: string): boolean {
  return (source === 'phoenix' || source === 'logfire' ? OTEL_TRACE_ID : TRACE_ID).test(id);
}

/** A Phoenix project's name or id, as the CLI takes it. */
export function phoenixProjectOk(project: string): boolean {
  return !!project && project.length <= 200 && !/[/?#]/.test(project);
}

/** Why the CLI won't take the Phoenix project typed; null while the field is empty, or it will. */
export function phoenixProjectNote(project: string): string | null {
  const p = project.trim();
  if (!p || phoenixProjectOk(p)) return null;
  return p.length > 200 ? 'That is not a project’s name or id: it is 200 characters at most.' : 'That is not a project’s name or id: it holds no /, ? or #.';
}

/** `LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY`. */
export function keyList(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
}

/**
 * A trace moved in time: every span's start and end, and each event's time, shifted by the same
 * amount so the trace ends at `endMs` and keeps its own pacing. Times that are no whole number of
 * nanoseconds are left as they are; the import reads them as it would have.
 */
export function redateTrace(trace: OtlpTrace, endMs: number): OtlpTrace {
  const nanos = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? BigInt(v) : null);
  const spans = trace.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((sc) => sc.spans));
  const times = spans.flatMap((sp) => [sp.startTimeUnixNano, sp.endTimeUnixNano, ...(sp.events ?? []).map((e) => e.timeUnixNano)]).map(nanos).filter((t): t is bigint => t !== null);
  if (!times.length) return trace;
  const last = times.reduce((a, b) => (b > a ? b : a));
  const shift = BigInt(Math.round(endMs)) * 1_000_000n - last;
  const move = (v: string) => {
    const t = nanos(v);
    return t === null ? v : String(t + shift);
  };
  const span = (sp: OtlpSpan): OtlpSpan => ({
    ...sp,
    ...(sp.startTimeUnixNano !== undefined ? { startTimeUnixNano: move(sp.startTimeUnixNano) } : {}),
    ...(sp.endTimeUnixNano !== undefined ? { endTimeUnixNano: move(sp.endTimeUnixNano) } : {}),
    ...(sp.events ? { events: sp.events.map((e) => (e.timeUnixNano !== undefined ? { ...e, timeUnixNano: move(e.timeUnixNano) } : e)) } : {}),
  });
  return { ...trace, resourceSpans: trace.resourceSpans.map((r) => ({ ...r, scopeSpans: r.scopeSpans.map((sc) => ({ ...sc, spans: sc.spans.map(span) })) })) };
}

/**
 * "Use sample: otel-traces.json": the trace the dashboard ships (`sample-otel.ts`), as the file
 * the dialog picks. It is dated to end now, so the run it makes is today's, as a capture just
 * exported would be; it goes up and is imported like any file picked.
 */
export function sampleTrace(now = Date.now()): { name: string; text: string } {
  return { name: OTEL_SAMPLE_NAME, text: `${JSON.stringify(redateTrace(OTEL_SAMPLE, now), null, 1)}\n` };
}

/** What Import capture is told of the source picked, as `importWords` reads it. */
interface ImportWordsInput {
  source: 'file' | TraceSource;
  picked: { files: ReadonlyArray<{ name: string }>; format?: string | null } | null;
  id: string;
  host: string;
  project: string;
  /** The traces in a window, without a trace id (`many`), or how far back one trace may have started (Logfire's Looks back). */
  window?: { many: boolean; fields: WindowFields } | undefined;
  /** What the server says of a trace store: the keys it reads, and whether they are set. */
  keys: { keyNames: readonly string[]; keys: boolean } | null;
  defaults: { host?: string | null; project?: string | null } | null;
  uploads: boolean;
}

const ON_REPLAY: FactWords = { label: 'On replay', value: 'what it doesn’t hold runs live, writes fenced' };

/** What Import capture says of the source picked: its amber line, its rows, and the command it runs. */
export function importWords(o: ImportWordsInput): { line: string | null; rows: FactWords[]; command: string } {
  if (o.source !== 'file') return traceWords(o, o.source);
  const files = o.picked?.files ?? [];
  return {
    line: o.uploads ? null : 'This dashboard takes no files: start it in your project with shadowlap dashboard, or import in a terminal with shadowlap import',
    rows: [ON_REPLAY],
    command: `shadowlap import ${o.picked?.format ?? '<format>'} ${files.length ? files.map((f) => quoteArg(f.name)).join(' ') : '<file>'}`,
  };
}

/** What Import capture says of a trace store: its keys where they aren't set, what it holds, and the command, one trace's or a window's. */
function traceWords(o: ImportWordsInput, source: TraceSource): { line: string | null; rows: FactWords[]; command: string } {
  const copy = TRACE_COPY[source];
  const names = o.keys ? keyList(o.keys.keyNames.map((n) => `\`${n}\``)) : copy.keys;
  const one = o.keys?.keyNames.length === 1;
  const host = o.host && o.host !== o.defaults?.host ? ` --host ${quoteArg(o.host)}` : '';
  const project = source === 'phoenix' && o.project.trim() !== o.defaults?.project ? ` ${quoteArg(`--project=${o.project.trim()}`)}` : '';
  const many = !!o.window?.many && WINDOWED.has(source);
  const given = o.window ? windowGiven(o.window.fields) : {};
  // One trace takes no window, but Logfire's how far back it looks.
  const flags = many ? windowFlags(given) || ' --since 30d' : copy.looksBack && given.since ? windowFlags({ since: given.since }) : '';
  return {
    line: o.keys && !o.keys.keys ? `${names} ${one ? 'is' : 'are'} not set where this dashboard runs: set ${one ? 'it' : 'them'}, then start shadowlap dashboard again` : null,
    rows: [
      ...(many ? [{ label: 'Imports', value: 'each trace a run of its own', quiet: 'newest first; one imported before is skipped' }] : []),
      { label: 'Holds', value: 'messages and model settings', quiet: copy.holds },
      ON_REPLAY,
      { label: 'Key', value: `${names} on this machine`, quiet: copy.keyQuiet ?? 'nothing passes through Shadowlap' },
    ],
    command: `shadowlap import ${source}${many ? '' : ` ${o.id.trim() ? quoteArg(o.id.trim()) : '<trace-id>'}`}${flags}${host}${project}`,
  };
}
