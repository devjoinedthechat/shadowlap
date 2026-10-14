/**
 * Which `shadowlap import` subcommand a file is for, guessed from its name and, when given, its first
 * bytes. The CLI itself detects nothing (the format is the subcommand); this is for the dashboard's
 * import dialog, which picks a format for a dropped file and lets the person change it. No Node
 * imports: the dashboard's browser bundle uses this too.
 */

/** The file formats `shadowlap import` reads. Langfuse and LangSmith traces are fetched, not uploaded. */
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

const YAML = 'A YAML cassette has to be converted to JSON first: Shadowlap reads JSON, so no YAML parser is trusted with a file from anywhere.';
const UNKNOWN = 'Not a format Shadowlap imports. It reads HAR, nock or VCR as JSON, LiteLLM JSONL, and OpenTelemetry OTLP JSON.';

/** How much of the file's start the content check looks at. */
const SNIFF_BYTES = 4096;

function head(firstBytes: Uint8Array | string | undefined): string {
  if (firstBytes === undefined) return '';
  if (typeof firstBytes === 'string') return firstBytes.slice(0, SNIFF_BYTES);
  return new TextDecoder('utf-8', { fatal: false }).decode(firstBytes.subarray(0, SNIFF_BYTES));
}

/**
 * The format a file's first bytes unmistakably have, or null. Each check is a key only that format
 * writes near its start, so a file the name misdescribes still lands on the right importer.
 */
function sniff(text: string): ImportFileFormat | null {
  const start = text.replace(/^﻿/, '').trimStart();
  if (!start.startsWith('{') && !start.startsWith('[')) return null;
  if (/"resourceSpans"\s*:/.test(start)) return 'otel';
  if (/"format"\s*:\s*"shadowlap-capture"/.test(start)) return 'litellm';
  if (/^\{\s*"log"\s*:/.test(start) || /"log"\s*:\s*\{[\s\S]*"entries"\s*:/.test(start)) return 'har';
  if (/"interactions"\s*:/.test(start)) return 'vcr';
  if (/"scope"\s*:\s*"https?:\/\//.test(start)) return 'nock';
  return null;
}

/**
 * The import format for a file: `.har` is HAR, `.jsonl` is LiteLLM, and `.json` is OpenTelemetry
 * (OTLP JSON) when the name says otel, otlp or trace, VCR when it says cassette or vcr, and nock
 * otherwise. With `firstBytes`, a JSON file whose content says which format it is gets that format
 * whatever its name. YAML and anything else are refused, with the reason to show.
 */
export function guessImportFormat(filename: string, firstBytes?: Uint8Array | string): ImportFormatGuess {
  const name = filename.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (ext === 'yaml' || ext === 'yml') return { format: null, reason: YAML };
  const byName: ImportFileFormat | null =
    ext === 'har' ? 'har' : ext === 'jsonl' ? 'litellm' : ext === 'json' ? (/otel|otlp|trace/i.test(name) ? 'otel' : /cassette|vcr/i.test(name) ? 'vcr' : 'nock') : null;
  if (!byName) return { format: null, reason: UNKNOWN };
  const byContent = sniff(head(firstBytes));
  return { format: byContent ?? byName };
}
