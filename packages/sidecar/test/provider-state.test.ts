import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '../src/server.js';

/**
 * State a recording left on a provider's side that a fork's live call names: a context cache on the
 * Gemini API or Vertex AI, a file the recorded run uploaded through OpenAI's, Anthropic's or Gemini's
 * Files API, and a vector store it made. The provider keeps each only for the account that made it,
 * and the cache and Gemini's files only for a while, so the live call is sent with the cache's
 * contents, or the file's bytes, in their place, rebuilt from the recording; a file it holds no copy
 * of, or one a request names by its id alone, and a vector store, are sent as they were, with a
 * warning, unless Gemini has deleted the file already, which refuses the call with why.
 */

const command = { argv: ['agent'], cwd: '/' };
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

/** A provider answering by path: each request kept as it arrived, its body parsed when it is JSON. */
async function provider(answer: (path: string, req: IncomingMessage) => unknown): Promise<{ url: string; seen: Array<{ path: string; body: unknown }> }> {
  const seen: Array<{ path: string; body: unknown }> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let body: unknown = raw.toString('base64');
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        // a form or a file's bytes
      }
      const path = (req.url ?? '').split('?')[0];
      seen.push({ path, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer(path, req)));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const post = async (url: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

/** A form upload as the SDKs send one: `purpose` (OpenAI's) and the file. */
const upload = async (url: string, headers: Record<string, string>, purpose?: string) => {
  const form = new FormData();
  if (purpose) form.append('purpose', purpose);
  form.append('file', new Blob([PDF], { type: 'application/pdf' }), 'refund-policy.pdf');
  const res = await fetch(url, { method: 'POST', headers, body: form });
  return (await res.json()) as Record<string, unknown>;
};

const GEMINI_ANSWER = { candidates: [{ content: { role: 'model', parts: [{ text: 'Yes, within 30 days.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 5 } };

describe('a context cache the recording made', () => {
  it("is sent as the cache's contents when a fork's live call names it", async () => {
    const google = await provider((path) => (path.endsWith('/cachedContents') ? { name: 'cachedContents/refund-desk', model: 'models/gemini-2.5-flash', expireTime: '2026-10-25T11:00:00Z' } : GEMINI_ANSWER));
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { gemini: google.url } });
    const cache = { model: 'models/gemini-2.5-flash', systemInstruction: { parts: [{ text: 'You are the refund desk.' }] }, contents: [{ role: 'user', parts: [{ text: 'POLICY: refunds within 30 days of delivery.' }] }], ttl: '3600s' };
    const ask = { cachedContent: 'cachedContents/refund-desk', contents: [{ role: 'user', parts: [{ text: 'Can I return order A-1042?' }] }] };
    const agent = async (runId: string) => {
      const base = sidecar.envFor(runId).GOOGLE_GEMINI_BASE_URL;
      const made = await post(`${base}/v1beta/cachedContents`, cache, { 'x-goog-api-key': 'k' });
      return post(`${base}/v1beta/models/gemini-2.5-flash:generateContent`, { ...ask, cachedContent: made.body.name }, { 'x-goog-api-key': 'k' });
    };
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      await agent(rec.runId);
      sidecar.endRun(rec.runId, 'completed');
      expect(google.seen.map((s) => s.path)).toEqual(['/v1beta/cachedContents', '/v1beta/models/gemini-2.5-flash:generateContent']);

      // The fork asks the model again: the cache is the recording's, an hour old or another project's.
      const fork = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command, replay: { divergeAt: 2 } });
      expect((await agent(fork.runId)).status).toBe(200);
      const { summary } = sidecar.endRun(fork.runId, 'completed');
      expect(google.seen).toHaveLength(3);
      expect(google.seen[2].body).toEqual({ systemInstruction: cache.systemInstruction, contents: [...cache.contents, ...ask.contents] });
      expect(summary.warnings.join('\n')).toMatch(/call 2 used cachedContents\/refund-desk, which the recording made at call #1 .*sent with the cache's contents in place of it/);
      // The fork's recording keeps the request as the agent sent it.
      const [, sent] = store.getCalls(fork.runId);
      expect(sent.origin).toBe('live');
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  it("is sent as the cache's contents on Vertex AI too, where the cache is the project's", async () => {
    const PLACE = '/v1/projects/dev-alice/locations/us-central1';
    const NAME = 'projects/412907/locations/us-central1/cachedContents/7340';
    const google = await provider((path) => (path.endsWith('/cachedContents') ? { name: NAME, model: `${PLACE.slice(4)}/publishers/google/models/gemini-2.5-flash`, expireTime: '2026-10-25T11:00:00Z' } : GEMINI_ANSWER));
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { vertex: google.url } });
    const cache = { model: `${PLACE.slice(4)}/publishers/google/models/gemini-2.5-flash`, systemInstruction: { parts: [{ text: 'You are the refund desk.' }] }, contents: [{ role: 'user', parts: [{ text: 'POLICY: refunds within 30 days of delivery.' }] }], ttl: '3600s' };
    const ask = { contents: [{ role: 'user', parts: [{ text: 'Can I return order A-1042?' }] }] };
    const agent = async (runId: string) => {
      const base = `${sidecar.url}/r/${runId}/vertex${PLACE}`;
      const made = await post(`${base}/cachedContents`, cache, { authorization: 'Bearer ya29.test' });
      return post(`${base}/publishers/google/models/gemini-2.5-flash:generateContent`, { ...ask, cachedContent: made.body.name }, { authorization: 'Bearer ya29.test' });
    };
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      await agent(rec.runId);
      sidecar.endRun(rec.runId, 'completed');
      const fork = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command, replay: { divergeAt: 2 } });
      expect((await agent(fork.runId)).status).toBe(200);
      const { summary } = sidecar.endRun(fork.runId, 'completed');
      expect(google.seen).toHaveLength(3);
      expect(google.seen[2].body).toEqual({ systemInstruction: cache.systemInstruction, contents: [...cache.contents, ...ask.contents] });
      expect(summary.warnings.join('\n')).toContain(`call 2 used ${NAME}, which the recording made at call #1`);
    } finally {
      await sidecar.close();
      store.close();
    }
  });
});

describe('a file or vector store a request names by its id alone', () => {
  it("is sent as it was, and the run names each, with the call to fork from (OpenAI's code interpreter and file search)", async () => {
    const openai = await provider((path) =>
      path === '/v1/files'
        ? { id: 'file-policy', object: 'file', bytes: PDF.length, filename: 'refund-policy.pdf', purpose: 'user_data' }
        : path === '/v1/vector_stores'
          ? { id: 'vs_refunds', object: 'vector_store', name: 'refunds' }
          : { id: 'resp_1', object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Thirty days.' }] }] },
    );
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { openai: openai.url } });
    const ask = (file: unknown, vs: unknown) => ({ model: 'gpt-5', tools: [{ type: 'code_interpreter', container: { type: 'auto', file_ids: [file] } }, { type: 'file_search', vector_store_ids: [vs] }], input: 'How long do I have?' });
    const agent = async (runId: string) => {
      const base = sidecar.envFor(runId).OPENAI_BASE_URL;
      const file = await upload(`${base}/files`, { authorization: 'Bearer k' }, 'user_data');
      const vs = await post(`${base}/vector_stores`, { name: 'refunds', file_ids: [file.id] }, { authorization: 'Bearer k' });
      return post(`${base}/responses`, ask(file.id, vs.body.id), { authorization: 'Bearer k' });
    };
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      await agent(rec.runId);
      sidecar.endRun(rec.runId, 'completed');
      const fork = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command, replay: { divergeAt: 3 } });
      expect((await agent(fork.runId)).status).toBe(200);
      const { summary } = sidecar.endRun(fork.runId, 'completed');
      expect(openai.seen.at(-1)).toEqual({ path: '/v1/responses', body: ask('file-policy', 'vs_refunds') });
      const said = summary.warnings.join('\n');
      expect(said).toMatch(/call 3 names file file-policy in file_ids, which the recorded run uploaded at call #1 and OpenAI keeps only for the organization that uploaded it; it goes by its id alone, so the call was sent as it was, and it fails with another account's key\. Fork from the upload \(--diverge-at 1\)/);
      expect(said).toMatch(/call 3 names vector store vs_refunds in vector_store_ids, which the recorded run made at call #2 and OpenAI keeps only for the organization that made it; .* Fork from where it was made \(--diverge-at 2\)/);
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  it("is sent as it was, and the run names it (a file in Anthropic's code execution container)", async () => {
    const anthropic = await provider((path) => (path === '/v1/files' ? { id: 'file_011data', type: 'file', filename: 'orders.csv', mime_type: 'text/csv', size_bytes: 12 } : { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Three late orders.' }], stop_reason: 'end_turn', usage: { input_tokens: 9, output_tokens: 3 } }));
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: anthropic.url } });
    const headers = { 'x-api-key': 'k', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'files-api-2025-04-14,code-execution-2025-08-25' };
    const ask = (file: unknown) => ({ model: 'claude-opus-5', max_tokens: 64, tools: [{ type: 'code_execution_20250825', name: 'code_execution' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'How many orders are late?' }, { type: 'container_upload', file_id: file }] }] });
    const agent = async (runId: string) => {
      const base = sidecar.envFor(runId).ANTHROPIC_BASE_URL;
      const file = await upload(`${base}/v1/files`, headers);
      return post(`${base}/v1/messages`, ask(file.id), headers);
    };
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      await agent(rec.runId);
      sidecar.endRun(rec.runId, 'completed');
      const fork = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command, replay: { divergeAt: 2 } });
      expect((await agent(fork.runId)).status).toBe(200);
      const { summary } = sidecar.endRun(fork.runId, 'completed');
      expect(anthropic.seen.at(-1)).toEqual({ path: '/v1/messages', body: ask('file_011data') });
      expect(summary.warnings.join('\n')).toMatch(/call 2 names file file_011data in a container_upload, which the recorded run uploaded at call #1 and Anthropic keeps only for the workspace that uploaded it; it goes by its id alone, so the call was sent as it was, .* \(--diverge-at 1\)/);
    } finally {
      await sidecar.close();
      store.close();
    }
  });
});

describe('a file the recorded run uploaded', () => {
  it("is sent as its bytes when a fork's live Responses call refers to it (OpenAI)", async () => {
    const openai = await provider((path) => (path === '/v1/files' ? { id: 'file-policy', object: 'file', bytes: PDF.length, filename: 'refund-policy.pdf', purpose: 'user_data' } : { id: 'resp_1', object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Thirty days.' }] }] }));
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { openai: openai.url } });
    const agent = async (runId: string) => {
      const base = sidecar.envFor(runId).OPENAI_BASE_URL;
      const file = await upload(`${base}/files`, { authorization: 'Bearer k' }, 'user_data');
      return post(`${base}/responses`, { model: 'gpt-5', input: [{ role: 'user', content: [{ type: 'input_file', file_id: file.id }, { type: 'input_text', text: 'How long do I have?' }] }] }, { authorization: 'Bearer k' });
    };
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      await agent(rec.runId);
      sidecar.endRun(rec.runId, 'completed');
      const fork = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command, replay: { divergeAt: 2 } });
      expect((await agent(fork.runId)).status).toBe(200);
      const { summary } = sidecar.endRun(fork.runId, 'completed');
      expect(openai.seen.map((s) => s.path)).toEqual(['/v1/files', '/v1/responses', '/v1/responses']);
      expect(openai.seen[2].body).toEqual({ model: 'gpt-5', input: [{ role: 'user', content: [{ type: 'input_file', filename: 'refund-policy.pdf', file_data: `data:application/pdf;base64,${PDF.toString('base64')}` }, { type: 'input_text', text: 'How long do I have?' }] }] });
      expect(summary.warnings.join('\n')).toMatch(/call 2 referred to file file-policy, which the recorded run uploaded at call #1 and OpenAI keeps only for the organization that uploaded it: it was sent with the file's contents in its place/);
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  it("is sent as its bytes when a fork's live Messages call refers to it (Anthropic)", async () => {
    const anthropic = await provider((path) => (path === '/v1/files' ? { id: 'file_011policy', type: 'file', filename: 'refund-policy.pdf', mime_type: 'application/pdf', size_bytes: PDF.length } : { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Thirty days.' }], stop_reason: 'end_turn', usage: { input_tokens: 9, output_tokens: 3 } }));
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: anthropic.url } });
    const headers = { 'x-api-key': 'k', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'files-api-2025-04-14' };
    const agent = async (runId: string) => {
      const base = sidecar.envFor(runId).ANTHROPIC_BASE_URL;
      const file = await upload(`${base}/v1/files`, headers);
      return post(`${base}/v1/messages`, { model: 'claude-opus-5', max_tokens: 64, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'file', file_id: file.id } }, { type: 'text', text: 'How long do I have?' }] }] }, headers);
    };
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      await agent(rec.runId);
      sidecar.endRun(rec.runId, 'completed');
      const fork = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command, replay: { divergeAt: 2 } });
      expect((await agent(fork.runId)).status).toBe(200);
      sidecar.endRun(fork.runId, 'completed');
      expect(anthropic.seen[2].body).toMatchObject({ messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF.toString('base64') } }, { type: 'text', text: 'How long do I have?' }] }] });
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  describe("through Gemini's File API", () => {
    const FILE_URI = 'https://generativelanguage.googleapis.com/v1beta/files/policy-pdf';
    /** A recording that uploads the PDF (the upload's last request holds `sent` and answers with the file) and asks about it. */
    async function recorded(file: { sizeBytes: number; expirationTime: string }, sent: Buffer = PDF) {
      const google = await provider((path) => (path === '/upload/v1beta/files' ? { file: { name: 'files/policy-pdf', displayName: 'refund-policy.pdf', mimeType: 'application/pdf', sizeBytes: String(file.sizeBytes), uri: FILE_URI, expirationTime: file.expirationTime, state: 'ACTIVE' } } : GEMINI_ANSWER));
      const store = Store.open(':memory:');
      const sidecar = await Sidecar.start({ store, upstreams: { gemini: google.url } });
      const agent = async (runId: string) => {
        const base = sidecar.envFor(runId).GOOGLE_GEMINI_BASE_URL;
        const res = await fetch(`${base}/upload/v1beta/files?upload_id=u1&upload_protocol=resumable`, { method: 'POST', headers: { 'x-goog-api-key': 'k', 'x-goog-upload-command': 'upload, finalize', 'x-goog-upload-offset': '0' }, body: sent });
        const { file: made } = (await res.json()) as { file: { uri: string; mimeType: string } };
        return post(`${base}/v1beta/models/gemini-2.5-flash:generateContent`, { contents: [{ role: 'user', parts: [{ fileData: { fileUri: made.uri, mimeType: made.mimeType } }, { text: 'How long do I have?' }] }] }, { 'x-goog-api-key': 'k' });
      };
      const rec = sidecar.startRun({ mode: 'record', command });
      await agent(rec.runId);
      sidecar.endRun(rec.runId, 'completed');
      return { google, store, sidecar, agent, parent: rec.runId };
    }

    it('sends the uploaded bytes inline in place of the file, however long ago it was uploaded', async () => {
      const { google, store, sidecar, agent, parent } = await recorded({ sizeBytes: PDF.length, expirationTime: '2026-01-01T00:00:00Z' });
      try {
        const fork = sidecar.startRun({ mode: 'replay', parentRunId: parent, command, replay: { divergeAt: 2 } });
        expect((await agent(fork.runId)).status).toBe(200);
        sidecar.endRun(fork.runId, 'completed');
        expect(google.seen[2].body).toEqual({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'application/pdf', data: PDF.toString('base64') } }, { text: 'How long do I have?' }] }] });
      } finally {
        await sidecar.close();
        store.close();
      }
    });

    it('refuses a call that reads a file Google has deleted when the recording holds no whole copy of it', async () => {
      // Uploaded in parts: the last request held only its end.
      const { google, store, sidecar, agent, parent } = await recorded({ sizeBytes: PDF.length * 3, expirationTime: '2026-01-01T00:00:00Z' });
      try {
        const fork = sidecar.startRun({ mode: 'replay', parentRunId: parent, command, replay: { divergeAt: 2 } });
        const refused = await agent(fork.runId);
        const { summary } = sidecar.endRun(fork.runId, 'completed');
        expect(refused.status).toBe(400);
        expect(refused.body).toMatchObject({ error: { code: 400, status: 'FAILED_PRECONDITION', message: expect.stringMatching(/reads file https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/policy-pdf, which the recorded run uploaded at call #1 and Google deleted at 2026-01-01T00:00:00\.000Z .*--diverge-at 1/) as unknown } });
        expect(google.seen).toHaveLength(2);
        expect(summary.refused).toBe(1);
      } finally {
        await sidecar.close();
        store.close();
      }
    });

    it('sends one Google still keeps as it was, and says it fails with another project\'s key', async () => {
      const { google, store, sidecar, agent, parent } = await recorded({ sizeBytes: PDF.length * 3, expirationTime: new Date(Date.now() + 3_600_000).toISOString() });
      try {
        const fork = sidecar.startRun({ mode: 'replay', parentRunId: parent, command, replay: { divergeAt: 2 } });
        expect((await agent(fork.runId)).status).toBe(200);
        const { summary } = sidecar.endRun(fork.runId, 'completed');
        expect(google.seen[2].body).toMatchObject({ contents: [{ parts: [{ fileData: { fileUri: FILE_URI } }, { text: 'How long do I have?' }] }] });
        expect(summary.warnings.join('\n')).toMatch(/call 2 refers to file .*policy-pdf, which the recorded run uploaded at call #1 and Google keeps only for the project that uploaded it, and for 48 hours; the recording holds no whole copy of it .*fails with another account's key\. Fork from the upload \(--diverge-at 1\)/);
      } finally {
        await sidecar.close();
        store.close();
      }
    });
  });
});
