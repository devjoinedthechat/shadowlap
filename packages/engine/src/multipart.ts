import { createHash } from 'node:crypto';

/**
 * A multipart/form-data request (an audio transcription, a file upload, an image edit) as matching
 * reads it. Its client picks a random boundary for every request, so the body's bytes differ each
 * time the same upload is sent. What makes it the same request is its parts: each one's name,
 * filename and content type, a field's text, and a file's content, by its SHA-256.
 *
 * A model request that isn't JSON is stored as the base64 of its bytes, and read from there here, so
 * a recording's stored request reads the same way when it is fingerprinted again. Stored requests and
 * the bytes sent upstream are never changed.
 */

/** One part of a form, as matching reads it. */
export interface MultipartPart {
  name: string | null;
  filename?: string;
  contentType?: string;
  /** A field's text: a part with no filename whose content is UTF-8. */
  value?: string;
  /** Anything else (a file, binary content): its SHA-256 and size. */
  sha256?: string;
  bytes?: number;
}

/** The view of a form body: its parts, in order. */
export interface MultipartView {
  multipart: MultipartPart[];
}

const CRLF = Buffer.from('\r\n');
const HEADERS_END = Buffer.from('\r\n\r\n');
// RFC 2046 bchars, 1 to 70 of them, not ending in a space.
const BOUNDARY = /^[0-9A-Za-z'()+_,\-./:=? ]{0,69}[0-9A-Za-z'()+_,\-./:=?]$/;

/**
 * A stored model request body as matching reads it: a form's parts (`{ multipart: [...] }`) when it
 * is the base64 of a multipart/form-data body, and the body itself otherwise.
 */
export function multipartView(body: unknown): unknown {
  // Every multipart body starts with "--", which base64 writes as "LS".
  if (typeof body !== 'string' || body.length < 8 || !body.startsWith('LS')) return body;
  const bytes = Buffer.from(body, 'base64');
  // Only a body the proxy stored as base64 (which writes it this way), never some other string.
  if (bytes.toString('base64') !== body) return body;
  const parts = parseMultipart(bytes);
  return parts ? ({ multipart: parts } satisfies MultipartView) : body;
}

/**
 * The parts of a multipart/form-data body, its boundary read from its first line; null when the bytes
 * aren't one (no boundary line, a part without its headers' end, no closing delimiter).
 */
export function parseMultipart(bytes: Buffer): MultipartPart[] | null {
  if (bytes[0] !== 0x2d || bytes[1] !== 0x2d) return null;
  const firstEnd = bytes.indexOf(CRLF);
  if (firstEnd < 3) return null;
  const boundary = bytes.subarray(2, firstEnd).toString('latin1').replace(/[ \t]+$/, '');
  if (!BOUNDARY.test(boundary)) return null;
  const delimiter = Buffer.from(`\r\n--${boundary}`, 'latin1');
  const parts: MultipartPart[] = [];
  let at = firstEnd + CRLF.length;
  for (;;) {
    const next = bytes.indexOf(delimiter, at);
    if (next < 0) return null;
    const part = readPart(bytes.subarray(at, next));
    if (!part) return null;
    parts.push(part);
    let after = next + delimiter.length;
    if (bytes[after] === 0x2d && bytes[after + 1] === 0x2d) return parts;
    // Transport padding (spaces, tabs) may follow a delimiter before its line ends.
    while (bytes[after] === 0x20 || bytes[after] === 0x09) after++;
    if (bytes[after] !== 0x0d || bytes[after + 1] !== 0x0a) return null;
    at = after + 2;
  }
}

function readPart(raw: Buffer): MultipartPart | null {
  // A part with no headers starts with the blank line that ends them.
  const end = raw.subarray(0, 2).equals(CRLF) ? 0 : raw.indexOf(HEADERS_END);
  if (end < 0) return null;
  const headers = new Map<string, string>();
  for (const line of end === 0 ? [] : raw.subarray(0, end).toString('utf8').split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  const content = raw.subarray(end === 0 ? 2 : end + HEADERS_END.length);
  const disposition = headers.get('content-disposition') ?? '';
  const name = param(disposition, 'name');
  const filename = param(disposition, 'filename');
  const contentType = headers.get('content-type');
  const out: MultipartPart = { name: name ?? null };
  if (filename !== undefined) out.filename = filename;
  if (contentType !== undefined) out.contentType = contentType;
  const text = content.toString('utf8');
  if (filename === undefined && Buffer.from(text, 'utf8').equals(content)) out.value = text;
  else {
    out.sha256 = createHash('sha256').update(content).digest('hex');
    out.bytes = content.length;
  }
  return out;
}

/** A parameter of a header value (`name="file"`, `filename=a.wav`), quoted or not; undefined when absent. */
function param(header: string, key: string): string | undefined {
  const re = new RegExp(`(?:^|;)\\s*${key}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;]*))`, 'i');
  const m = re.exec(header);
  if (!m) return undefined;
  return m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]!.trim();
}
