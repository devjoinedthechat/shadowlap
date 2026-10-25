import { isRawNumber, multipartContents, type CallRecord } from '@shadowlap/engine';

/**
 * What a recording left on a provider's side, besides a Responses conversation (responses-state.ts),
 * that a fork's live call may name: a Gemini context cache (`cachedContent`), which Google keeps only
 * for the project that made it and only for its time to live, an hour by default; and a file the
 * recorded run uploaded through OpenAI's, Anthropic's or Gemini's Files API, which the provider keeps
 * only for the organization, workspace or project that uploaded it, and Gemini only for 48 hours. A
 * replay serves the recorded calls, so the first live call after a fork names state that may be gone,
 * or another key's: the fork fails, or reads it from someone else's account.
 *
 * So a live call that names a cache the recording made is sent with the cache's contents in its
 * request instead, the stateless form of the same request, rebuilt from the recorded call that made
 * the cache; and one that refers to a file the recording uploaded is sent with the file's bytes in
 * the request, from the recorded upload. A file the recording holds no whole copy of (uploaded in
 * parts, or around Shadowlap), or one too large to send inline, is sent as it was, and the run says
 * it fails with another key's; one Gemini has deleted already is refused, saying why.
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);

/** The most a call may carry inline in place of the files it names: Gemini's limit on a request's inline data, the strictest of the three. */
export const INLINE_LIMIT = 20 * 1024 * 1024;

interface RecordedCache {
  callNo: number;
  /** The request that made it: its contents, system instruction, tools and tool config. */
  request: Json;
}

interface RecordedFile {
  callNo: number;
  /** The provider's name for it as a request names it: `file-…` (OpenAI), `file_…` (Anthropic), `files/…` or its URI (Gemini). */
  id: string;
  filename: string | null;
  mimeType: string | null;
  /** Its bytes as the recorded upload sent them; null when the recording holds no whole copy. */
  bytes: Buffer | null;
  /** When the provider deletes it (Gemini's `expirationTime`), in ms; null when it keeps it. */
  expiresAt: number | null;
}

/** What to send in place of a live call's body, and what to say of it; or why it is refused. */
export interface Rebuilt {
  /** The body to send, when it differs from the agent's. */
  body?: Json;
  /** Said once each in the run's summary, by key. */
  notes: Array<{ key: string; text: string }>;
  /** Not sent: why, as a clause, and the request field it is about. */
  refuse?: { why: string; param: string };
}

/** Who keeps a provider's uploads, as a sentence's clause. */
const KEEPER: Readonly<Record<string, string>> = {
  gemini: 'Google keeps only for the project that uploaded it, and for 48 hours',
  openai: 'OpenAI keeps only for the organization that uploaded it',
  azure: 'Azure keeps only for the resource it was uploaded to',
  anthropic: 'Anthropic keeps only for the workspace that uploaded it',
};

const CACHE_FIELDS = ['systemInstruction', 'system_instruction', 'tools', 'toolConfig', 'tool_config'] as const;

export class ProviderState {
  private index: { caches: Map<string, RecordedCache>; files: Map<string, RecordedFile> } | null = null;

  /**
   * `calls`: the recording's calls. `read` reads a recorded call's request and its answer's bytes.
   * Nothing is read until a live call might name what they made.
   */
  constructor(
    private readonly calls: readonly CallRecord[],
    private readonly read: { request: (rec: CallRecord) => unknown; response: (rec: CallRecord) => Buffer | null },
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether a recording holds a call that may have left such state: a cache made, a file uploaded. */
  static applies(calls: readonly CallRecord[]): boolean {
    return calls.some((c) => c.kind === 'api' && /^POST .*\/(cachedContents|files)$/.test(c.name));
  }

  /** The caches the recording made and the files it uploaded, by the name a later request gives each. */
  private recorded(): NonNullable<ProviderState['index']> {
    if (this.index) return this.index;
    const caches = new Map<string, RecordedCache>();
    const files = new Map<string, RecordedFile>();
    for (const c of [...this.calls].sort((a, b) => a.callNo - b.callNo)) {
      if (c.kind !== 'api' || c.end?.outcome !== 'ok' || !c.requestRef || !c.name.startsWith('POST ')) continue;
      const path = c.name.slice('POST '.length);
      const format = typeof c.meta.provider === 'string' ? c.meta.provider : '';
      const isCache = format === 'gemini' && /\/cachedContents$/.test(path);
      if (!isCache && !/\/files$/.test(path)) continue;
      try {
        const bytes = this.read.response(c);
        const answer = bytes ? (JSON.parse(bytes.toString('utf8')) as unknown) : null;
        if (!isObject(answer)) continue;
        const request = this.read.request(c);
        if (isCache) {
          if (typeof answer.name === 'string' && isObject(request)) caches.set(answer.name, { callNo: c.callNo, request });
          continue;
        }
        // Gemini's File API: the upload's last request answers with the file, and holds it whole
        // when the file came in one piece (its size is what the request sent).
        if (format === 'gemini' && isObject(answer.file) && typeof answer.file.name === 'string') {
          const f = answer.file;
          const sent = typeof request === 'string' ? Buffer.from(request, 'base64') : null;
          const expires = typeof f.expirationTime === 'string' ? Date.parse(f.expirationTime) : Number.NaN;
          const file: RecordedFile = {
            callNo: c.callNo,
            id: f.name as string,
            filename: typeof f.displayName === 'string' ? f.displayName : null,
            mimeType: typeof f.mimeType === 'string' ? f.mimeType : null,
            bytes: sent && sent.length === Number(f.sizeBytes) ? sent : null,
            expiresAt: Number.isFinite(expires) ? expires : null,
          };
          files.set(file.id, file);
          if (typeof f.uri === 'string') files.set(f.uri, file);
          continue;
        }
        // OpenAI's and Anthropic's Files APIs: a form whose `file` part holds it.
        if (typeof answer.id === 'string' && (answer.object === 'file' || answer.type === 'file')) {
          const form = typeof request === 'string' ? multipartContents(Buffer.from(request, 'base64')) : null;
          const part = form?.find((p) => p.name === 'file' && p.filename !== undefined);
          files.set(answer.id, {
            callNo: c.callNo,
            id: answer.id,
            filename: (typeof answer.filename === 'string' ? answer.filename : part?.filename) ?? null,
            mimeType: (typeof answer.mime_type === 'string' ? answer.mime_type : part?.contentType) ?? null,
            bytes: part?.content ?? null,
            expiresAt: null,
          });
        }
      } catch {
        // A call whose request or answer doesn't read left nothing this replay can rebuild.
      }
    }
    return (this.index = { caches, files });
  }

  /**
   * What to send for live call `callNo` in `format` (the provider's wire format: gemini, openai,
   * azure, anthropic) in place of `body`, when it names a cache the recording made or a file it
   * uploaded; nothing when it names neither.
   */
  rebuild(format: string, callNo: number, body: unknown): Rebuilt {
    const out: Rebuilt = { notes: [] };
    if (!isObject(body)) return out;
    const { caches, files } = this.recorded();
    if (!caches.size && !files.size) return out;
    let next = body;
    let changed = false;

    if (format === 'gemini') {
      const named = typeof body.cachedContent === 'string' ? body.cachedContent : typeof body.cached_content === 'string' ? body.cached_content : null;
      const cache = named !== null ? caches.get(named) : undefined;
      if (named !== null && cache) {
        const { cachedContent: _camel, cached_content: _snake, ...rest } = body;
        const held: Json = {};
        for (const field of CACHE_FIELDS) if (cache.request[field] !== undefined) held[field] = cache.request[field];
        const contents = [...listOf(cache.request.contents), ...listOf(rest.contents)];
        next = { ...held, ...rest, contents };
        changed = true;
        out.notes.push({ key: `cache:${named}`, text: `call ${callNo} used ${named}, which the recording made at call #${cache.callNo} and Google keeps only for the project that made it and for its time to live (an hour by default): it was sent with the cache's contents in place of it, rebuilt from that call.` });
      }
    }

    if (files.size) {
      let inline = 0;
      const refused: string[] = [];
      const swapped = mapObjects(next, (node) => {
        const ref = fileRef(format, node);
        const file = ref ? files.get(ref.id) : undefined;
        if (!ref || !file) return node;
        const keeper = KEEPER[format] ?? 'the provider keeps only for the account that uploaded it';
        const encoded = file.bytes && inline + file.bytes.length <= INLINE_LIMIT ? ref.inline(file) : null;
        if (encoded) {
          inline += file.bytes!.length;
          changed = true;
          out.notes.push({ key: `file:${file.id}`, text: `call ${callNo} referred to file ${ref.id}, which the recorded run uploaded at call #${file.callNo} and ${keeper}: it was sent with the file's contents in its place, from that upload.` });
          return encoded;
        }
        if (format === 'gemini' && file.expiresAt !== null && file.expiresAt <= this.now()) {
          refused.push(`it reads file ${ref.id}, which the recorded run uploaded at call #${file.callNo} and Google deleted at ${new Date(file.expiresAt).toISOString()} (it keeps an upload for 48 hours), and the recording holds no whole copy of it to send in its place. Fork from the upload (--diverge-at ${file.callNo}) so the fork uploads it again.`);
          return node;
        }
        const why = !file.bytes ? 'holds no whole copy of it (it was uploaded in parts, or around Shadowlap)' : inline + file.bytes.length > INLINE_LIMIT ? `can't send it in the request (over ${INLINE_LIMIT / 1024 / 1024} MB inline)` : `can't send a ${file.mimeType ?? 'file of that type'} in the request`;
        out.notes.push({ key: `file:${file.id}`, text: `call ${callNo} refers to file ${ref.id}, which the recorded run uploaded at call #${file.callNo} and ${keeper}; the recording ${why}, so it was sent as it was, and it fails with another account's key. Fork from the upload (--diverge-at ${file.callNo}) to upload it again.` });
        return node;
      });
      if (refused.length) return { notes: [], refuse: { why: refused[0]!, param: 'contents' } };
      next = swapped;
    }
    if (changed) out.body = next;
    return out;
  }
}

/** A request's reference to an uploaded file: the name it gives it, and the same content sent inline in its place (null when it can't be). */
interface FileRef {
  id: string;
  inline: (file: RecordedFile) => Json | null;
}

const dataUrl = (file: RecordedFile, mime: string) => `data:${mime};base64,${file.bytes!.toString('base64')}`;

/** The file a node of a request refers to by its provider's name for it, as `format`'s requests refer to one. */
function fileRef(format: string, node: Json): FileRef | null {
  if (format === 'openai' || format === 'azure') {
    // Responses: an input_file or input_image item; Chat Completions: a file content part.
    if ((node.type === 'input_file' || node.type === 'input_image') && typeof node.file_id === 'string') {
      const { file_id: _id, ...rest } = node;
      return {
        id: node.file_id,
        inline: (file) => {
          const mime = file.mimeType ?? (node.type === 'input_image' ? 'image/png' : 'application/pdf');
          return node.type === 'input_file' ? { ...rest, filename: file.filename ?? 'file', file_data: dataUrl(file, mime) } : { ...rest, image_url: dataUrl(file, mime) };
        },
      };
    }
    if (node.type === 'file' && isObject(node.file) && typeof node.file.file_id === 'string') {
      return { id: node.file.file_id, inline: (file) => ({ ...node, file: { filename: file.filename ?? 'file', file_data: dataUrl(file, file.mimeType ?? 'application/pdf') } }) };
    }
    return null;
  }
  if (format === 'anthropic') {
    // A document or image block whose source is an uploaded file.
    const source = node.source;
    if (!isObject(source) || source.type !== 'file' || typeof source.file_id !== 'string') return null;
    return {
      id: source.file_id,
      inline: (file) => {
        const mime = file.mimeType ?? '';
        if (mime === 'application/pdf' || mime.startsWith('image/')) return { ...node, source: { type: 'base64', media_type: mime, data: file.bytes!.toString('base64') } };
        if (mime.startsWith('text/') && node.type === 'document') return { ...node, source: { type: 'text', media_type: 'text/plain', data: file.bytes!.toString('utf8') } };
        return null;
      },
    };
  }
  if (format === 'gemini') {
    // A part whose fileData names a file of the File API, as the SDKs (camelCase) and REST (snake_case) write it.
    const camel = isObject(node.fileData) ? node.fileData : null;
    const snake = isObject(node.file_data) ? node.file_data : null;
    const data = camel ?? snake;
    const uri = data ? (camel ? data.fileUri : data.file_uri) : undefined;
    if (!data || typeof uri !== 'string') return null;
    const declared = camel ? data.mimeType : data.mime_type;
    return {
      id: uri,
      inline: (file) => {
        const mime = (typeof declared === 'string' ? declared : null) ?? file.mimeType ?? 'application/octet-stream';
        const { fileData: _camel, file_data: _snake, ...rest } = node;
        return camel ? { ...rest, inlineData: { mimeType: mime, data: file.bytes!.toString('base64') } } : { ...rest, inline_data: { mime_type: mime, data: file.bytes!.toString('base64') } };
      },
    };
  }
  return null;
}

/** `value` with each object in it passed through `f`, depth first, the objects `f` returns left as they are. */
function mapObjects(value: unknown, f: (node: Json) => Json): Json {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    // A number kept as written (parseJsonExact) goes as it is.
    if (!isObject(v) || isRawNumber(v)) return v;
    const node = f(v);
    if (node !== v) return node;
    const out: Json = {};
    // Defined, not assigned, so a `__proto__` key in a request stays a key.
    for (const [k, x] of Object.entries(v)) Object.defineProperty(out, k, { value: walk(x), enumerable: true, writable: true, configurable: true });
    return out;
  };
  return walk(value) as Json;
}
