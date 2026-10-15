/**
 * Import a capture or a trace: which format a file is, guessed from its name and changeable, and
 * what each trace store keeps. The CLI detects nothing (the format is its subcommand), so the
 * dialog says which it will run. No DOM here: the tests import it.
 */

export type FileFormat = 'har' | 'nock' | 'vcr' | 'litellm' | 'otel';
export const FILE_FORMATS: readonly FileFormat[] = ['har', 'nock', 'vcr', 'litellm', 'otel'];

/** The format select's words. */
export const FORMAT_LABEL: Readonly<Record<FileFormat, string>> = { har: 'HAR', nock: 'nock', vcr: 'VCR (JSON)', litellm: 'LiteLLM', otel: 'OpenTelemetry' };

/** What the file picker offers. */
export const IMPORT_ACCEPT = '.har,.json,.jsonl,.yaml,.yml';

const YAML = 'A YAML cassette has to be converted to JSON first: Shadowlap reads JSON, so no YAML parser is trusted with a file from anywhere.';
const UNKNOWN = 'Not a format Shadowlap imports. It reads HAR, nock or VCR as JSON, LiteLLM JSONL, and OpenTelemetry OTLP JSON.';

/**
 * The format a file's name says: .har is HAR, .jsonl is LiteLLM, and .json is OpenTelemetry (OTLP
 * JSON) when the name says otel, otlp or trace, VCR when it says cassette or vcr, and nock otherwise.
 * YAML, and anything else, is refused with the reason.
 */
export function guessImportFormat(name: string): { format: FileFormat; error: null } | { format: null; error: string } {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (ext === 'yaml' || ext === 'yml') return { format: null, error: YAML };
  if (ext === 'har') return { format: 'har', error: null };
  if (ext === 'jsonl') return { format: 'litellm', error: null };
  if (ext === 'json') {
    if (/otel|otlp|trace/i.test(name)) return { format: 'otel', error: null };
    if (/cassette|vcr/i.test(name)) return { format: 'vcr', error: null };
    return { format: 'nock', error: null };
  }
  return { format: null, error: UNKNOWN };
}

/** A file larger than the dashboard takes: what to do instead. */
export function tooLargeNote(bytes: number, limit: number | null, format: FileFormat | null): string | null {
  if (limit === null || bytes <= limit) return null;
  const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;
  return `This file is ${mb(bytes)}, more than the dashboard takes (${mb(limit)}): import it in a terminal with shadowlap import ${format ?? '<format>'} <file>.`;
}

export type TraceSource = 'langfuse' | 'langsmith';

/** What each trace store keeps, and its name. */
export const TRACE_COPY: Readonly<Record<TraceSource, { name: string; keeps: string }>> = {
  langfuse: { name: 'Langfuse', keeps: 'Generations keep the messages and model settings. Tool definitions often aren’t stored, so tools run live on replay unless their outputs are in the trace.' },
  langsmith: { name: 'LangSmith', keeps: 'LLM runs keep the messages and model settings. Tool runs keep their outputs when you logged them; anything else runs live on replay.' },
};

/** A trace id as Langfuse and LangSmith write them, as the CLI checks it. */
export const TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

/** `LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY`. */
export function keyList(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
