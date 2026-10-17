import { guessImportFormat, IMPORT_FILE_FORMATS, type ImportFileFormat } from '../../../engine/src/import-format.js';
import { OTEL_SAMPLE, OTEL_SAMPLE_NAME, type OtlpSpan, type OtlpTrace } from './sample-otel.js';

/**
 * Import a capture or a trace: which format a file is, what each trace store keeps, and the sample
 * the dialog offers. The format is the engine's `guessImportFormat` (the file's name, then its first
 * bytes when the name says nothing); the CLI detects nothing (the format is its subcommand), so the
 * dialog says which it will run and lets the person change it. No DOM here: the tests import it.
 */

export { IMPORT_FILE_FORMATS, OTEL_SAMPLE_NAME, type ImportFileFormat };

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

/** A file larger than the dashboard takes: what to do instead. */
export function tooLargeNote(bytes: number, limit: number | null, format: ImportFileFormat | null): string | null {
  if (limit === null || bytes <= limit) return null;
  const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;
  return `This file is ${mb(bytes)}, more than the dashboard takes (${mb(limit)}): import it in a terminal with shadowlap import ${format ?? '<format>'} <file>.`;
}

export type TraceSource = 'langfuse' | 'langsmith';

/**
 * What each trace store keeps, its name, and what its trace ids look like: the field's placeholder
 * names the format rather than showing a made-up id. Langfuse's SDKs write a UUID, or 32 hex
 * characters since they moved onto OpenTelemetry; LangSmith's trace is its root run's UUID.
 */
export const TRACE_COPY: Readonly<Record<TraceSource, { name: string; id: string; keeps: string }>> = {
  langfuse: { name: 'Langfuse', id: 'a UUID or 32 hex characters, from the trace’s page', keeps: 'Generations keep the messages and model settings. Tool definitions often aren’t stored, so tools run live on replay unless their outputs are in the trace.' },
  langsmith: { name: 'LangSmith', id: 'a UUID, from the trace’s page in LangSmith', keeps: 'LLM runs keep the messages and model settings. Tool runs keep their outputs when you logged them; anything else runs live on replay.' },
};

/** A trace id as Langfuse and LangSmith write them, as the CLI checks it. */
export const TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

/** `LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY`. */
export function keyList(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
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
 * "Use a sample: otel-traces.json": the trace the dashboard ships (`sample-otel.ts`), as the file
 * the dialog picks. It is dated to end now, so the run it makes is today's, as a capture just
 * exported would be; it goes up and is imported like any file picked.
 */
export function sampleTrace(now = Date.now()): { name: string; text: string } {
  return { name: OTEL_SAMPLE_NAME, text: `${JSON.stringify(redateTrace(OTEL_SAMPLE, now), null, 1)}\n` };
}
