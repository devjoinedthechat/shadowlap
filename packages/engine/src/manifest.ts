import type { Store } from './store.js';

/**
 * Request manifests. Every model request resends the whole conversation, so whole-request blobs
 * never deduplicate. A request is stored as `system`, `tools` and each message as separate blobs
 * plus a manifest listing their hashes. Reconstruction is semantic, not
 * byte-for-byte, which is sufficient because only responses are ever served.
 */

interface ChunkedManifest {
  v: 1;
  kind: 'chunked';
  fields: Record<string, unknown>;
  system: string | null;
  tools: string | null;
  messages: string[];
}

interface WholeManifest {
  v: 1;
  kind: 'whole';
  blob: string;
  /** How to decode the blob. */
  encoding: 'json' | 'utf8' | 'base64';
}

export type RequestManifest = ChunkedManifest | WholeManifest;

function isConversationShaped(body: unknown): body is { messages: unknown[]; system?: unknown; tools?: unknown } & Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body) && Array.isArray((body as { messages?: unknown }).messages);
}

/** Stores an API request body (parsed JSON, or raw text/bytes) and returns the manifest's hash. */
export function storeApiRequest(store: Store, body: unknown): string {
  let manifest: RequestManifest;
  if (isConversationShaped(body)) {
    const { messages, system, tools, ...fields } = body;
    manifest = {
      v: 1,
      kind: 'chunked',
      fields,
      system: system === undefined ? null : store.putJson(system),
      tools: tools === undefined ? null : store.putJson(tools),
      messages: messages.map((m) => store.putJson(m)),
    };
  } else if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    manifest = { v: 1, kind: 'whole', blob: store.putBlob(body), encoding: 'base64' };
  } else if (typeof body === 'string') {
    manifest = { v: 1, kind: 'whole', blob: store.putBlob(Buffer.from(body, 'utf8')), encoding: 'utf8' };
  } else {
    manifest = { v: 1, kind: 'whole', blob: store.putJson(body), encoding: 'json' };
  }
  return store.putJson(manifest);
}

/** Reconstructs the request body stored under a manifest hash. */
export function loadApiRequest(store: Store, manifestRef: string): unknown {
  const manifest = store.getJson<RequestManifest>(manifestRef);
  if (!manifest) throw new Error(`missing request manifest ${manifestRef}`);
  if (manifest.kind === 'whole') {
    const bytes = store.getBlob(manifest.blob);
    if (!bytes) throw new Error(`missing blob ${manifest.blob}`);
    if (manifest.encoding === 'json') return JSON.parse(bytes.toString('utf8'));
    if (manifest.encoding === 'utf8') return bytes.toString('utf8');
    return bytes;
  }
  const body: Record<string, unknown> = { ...manifest.fields };
  if (manifest.system !== null) body.system = store.getJson(manifest.system);
  if (manifest.tools !== null) body.tools = store.getJson(manifest.tools);
  body.messages = manifest.messages.map((h) => store.getJson(h));
  return body;
}

/** The blob hashes a stored request references (none when the manifest is missing or malformed). */
export function manifestRefs(store: Store, manifestRef: string): string[] {
  let manifest: RequestManifest | null = null;
  try {
    manifest = store.getJson<RequestManifest>(manifestRef);
  } catch {
    return [];
  }
  if (!manifest || typeof manifest !== 'object') return [];
  if (manifest.kind === 'whole') return typeof manifest.blob === 'string' ? [manifest.blob] : [];
  if (manifest.kind === 'chunked') return [manifest.system, manifest.tools, ...(Array.isArray(manifest.messages) ? manifest.messages : [])].filter((h): h is string => typeof h === 'string');
  return [];
}
