/**
 * Which `shadowlap import` subcommand a file is for, guessed from its name and, when given, its first
 * bytes. The CLI itself detects nothing (the format is the subcommand); this is for the dashboard's
 * import dialog, which picks a format for a dropped file and lets the person change it. No Node
 * imports: the dashboard's browser bundle uses this too.
 */

/** The file formats `shadowlap import` reads. Langfuse, LangSmith, Phoenix and Logfire traces are fetched, not uploaded. */
export type ImportFileFormat = 'har' | 'nock' | 'vcr' | 'litellm' | 'otel';

/** Each format's name as the import dialog shows it. */
export const IMPORT_FILE_FORMATS: Readonly<Record<ImportFileFormat, string>> = {
  har: 'HAR',
  nock: 'nock',
  vcr: 'VCR (JSON)',
  litellm: 'LiteLLM',
  otel: 'OpenTelemetry',
};

export type ImportFormatGuess = { format: ImportFileFormat; reason?: undefined } | { format: null; reason: string };

const YAML = 'A YAML cassette has to be converted to JSON first: shadowlap reads JSON, so no YAML parser is trusted with a file from anywhere.';
const UNKNOWN = 'Not a format shadowlap imports. It reads HAR, nock or VCR as JSON, LiteLLM JSONL, and OpenTelemetry OTLP JSON.';

/** How much of the file's start the content check looks at. */
const SNIFF_BYTES = 4096;

function head(firstBytes: Uint8Array | string | undefined): string {
  if (firstBytes === undefined) return '';
  if (typeof firstBytes === 'string') return firstBytes.slice(0, SNIFF_BYTES);
  return new TextDecoder('utf-8', { fatal: false }).decode(firstBytes.subarray(0, SNIFF_BYTES));
}

/**
 * The keys of the first JSON object in `text` (the top-level object, or the first element of a
 * top-level array), with the value of each key whose value is a string, read as far as the text
 * goes. Nested values are stepped over, never read: a request body that happens to hold a key named
 * `log` or `resourceSpans` says nothing about the file. Null when the text doesn't start like JSON.
 */
function topLevelKeys(text: string): { array: boolean; keys: Map<string, string | null> } | null {
  let i = 0;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  /** A string at `i` (on its opening quote), or null when the text ends inside it. */
  const string = (): string | null => {
    let out = '';
    i++;
    while (i < text.length) {
      const c = text[i++]!;
      if (c === '"') return out;
      if (c === '\\') {
        const e = text[i++];
        if (e === 'u') {
          out += String.fromCharCode(parseInt(text.slice(i, i + 4), 16) || 0);
          i += 4;
        } else out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : (e ?? '');
      } else out += c;
    }
    return null;
  };
  /** Steps over one value of any kind, stopping at the comma or brace that ends it. */
  const skip = () => {
    let depth = 0;
    while (i < text.length) {
      const c = text[i]!;
      if (c === '"') {
        if (string() === null) return;
        continue;
      }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        if (depth === 0) return;
        depth--;
      } else if (c === ',' && depth === 0) return;
      i++;
    }
  };
  ws();
  const array = text[i] === '[';
  if (array) {
    i++;
    ws();
  }
  if (text[i] !== '{') return array ? { array, keys: new Map() } : null;
  i++;
  const keys = new Map<string, string | null>();
  for (;;) {
    ws();
    if (text[i] !== '"') break;
    const key = string();
    if (key === null) break;
    ws();
    if (text[i] !== ':') break;
    i++;
    ws();
    if (text[i] === '"') {
      const value = string();
      keys.set(key, value);
      if (value === null) break;
    } else {
      keys.set(key, null);
      skip();
    }
    ws();
    if (text[i] !== ',') break;
    i++;
  }
  return { array, keys };
}

/**
 * The format a file's first bytes unmistakably have, or null: a key only that format writes at the
 * top of the file. Only the top level counts, so nothing a body or a span holds can mislead it.
 */
function sniff(text: string): ImportFileFormat | null {
  const top = topLevelKeys(text.replace(/^\uFEFF/, ''));
  if (!top) return null;
  const { array, keys } = top;
  if (!array && (keys.has('resourceSpans') || keys.has('resourceLogs') || keys.has('batches'))) return 'otel';
  if (!array && keys.get('format') === 'shadowlap-capture') return 'litellm';
  if (!array && keys.has('log')) return 'har';
  if (!array && keys.has('interactions')) return 'vcr';
  if (array && keys.has('scope') && (keys.has('method') || keys.has('path'))) return 'nock';
  return null;
}

/**
 * The import format for a file. `.har` is HAR. A `.json` file is OpenTelemetry (OTLP JSON) when its
 * name says otel, otlp or trace, VCR when it says cassette or vcr; otherwise its content decides
 * (with `firstBytes`: the top-level keys of OTLP, HAR, a VCR cassette, a nock recording or a
 * shadowlap capture), and nock when it says nothing. A `.jsonl` file is LiteLLM, unless its name
 * says otel, otlp or trace or its first line is OTLP, as the collector's file exporter writes it.
 * Content never overrides a name that says what the file is. YAML and anything else are refused,
 * with the reason to show.
 */
export function guessImportFormat(filename: string, firstBytes?: Uint8Array | string): ImportFormatGuess {
  const name = filename.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (ext === 'yaml' || ext === 'yml') return { format: null, reason: YAML };
  if (ext === 'har') return { format: 'har' };
  if (ext !== 'json' && ext !== 'jsonl') return { format: null, reason: UNKNOWN };
  if (/otel|otlp|trace/i.test(name)) return { format: 'otel' };
  if (ext === 'json' && /cassette|vcr/i.test(name)) return { format: 'vcr' };
  const byContent = sniff(head(firstBytes));
  if (ext === 'jsonl') return { format: byContent === 'otel' ? 'otel' : 'litellm' };
  return { format: byContent ?? 'nock' };
}
