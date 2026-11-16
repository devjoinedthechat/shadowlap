import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A scripted fake of the Gemini API (Generative Language): `models/{model}:generateContent` and
 * `:streamGenerateContent?alt=sse`, close enough to the wire format for `@google/genai`, including
 * function calls and `usageMetadata`. It answers under /v1beta/ and /v1/ alike: `@google/genai` and
 * google-genai 2.x for Python ask for v1beta, google-genai 3.x for Python for v1. It knows nothing
 * about shadowlap.
 */

export interface FunctionCall {
  name: string;
  args: Record<string, unknown>;
}

export interface Turn {
  text: string | null;
  functionCalls?: FunctionCall[];
  finishReason: 'STOP' | 'MAX_TOKENS';
  usage: { promptTokenCount: number; candidatesTokenCount: number };
}

export interface GeminiRequest {
  contents: Array<{ role?: string; parts: unknown[] }>;
  systemInstruction?: unknown;
  tools?: unknown[];
  generationConfig?: unknown;
}

export interface ScriptContext {
  request: GeminiRequest;
  requestNo: number;
  /** Model turns in the request so far. */
  modelTurns: number;
}

export type ScriptResult = { turn: Turn } | { status: number; body: unknown; headers?: Record<string, string> };
export type Script = (ctx: ScriptContext) => ScriptResult;

export interface MockServer {
  url: string;
  requests: Array<{ path: string; headers: Record<string, string>; body: GeminiRequest }>;
  close(): Promise<void>;
}

let n = 0;
export const turn = (text: string | null, opts: Partial<Turn> = {}): Turn => ({
  text,
  finishReason: 'STOP',
  usage: { promptTokenCount: 400 + ++n, candidatesTokenCount: 15 },
  ...opts,
});
export const functionCall = (name: string, args: Record<string, unknown>): FunctionCall => ({ name, args });

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function split(s: string, parts: number): string[] {
  if (!s) return [];
  const size = Math.max(1, Math.ceil(s.length / parts));
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

export async function startMockGemini(opts: { script: Script }): Promise<MockServer> {
  const requests: MockServer['requests'] = [];
  let requestNo = 0;
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://mock');
      const m = /^\/v1(?:beta)?\/models\/([^:/]+):(generateContent|streamGenerateContent)$/.exec(url.pathname);
      if (req.method !== 'POST' || !m) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 404, message: `mock: no route ${req.method!} ${url.pathname}`, status: 'NOT_FOUND' } }));
        return;
      }
      const model = m[1]!;
      const streaming = m[2] === 'streamGenerateContent';
      const body = JSON.parse((await readBody(req)).toString('utf8')) as GeminiRequest;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
      requests.push({ path: url.pathname + url.search, headers, body });
      requestNo++;
      const result = opts.script({ request: body, requestNo, modelTurns: body.contents.filter((c) => c.role === 'model').length });
      if (!('turn' in result)) {
        const bytes = Buffer.from(JSON.stringify(result.body));
        res.writeHead(result.status, { 'content-type': 'application/json', 'content-length': String(bytes.length), ...(result.headers ?? {}) });
        res.end(bytes);
        return;
      }
      const t = result.turn;
      const usageMetadata = { ...t.usage, totalTokenCount: t.usage.promptTokenCount + t.usage.candidatesTokenCount };
      const parts: unknown[] = [];
      if (t.text) parts.push({ text: t.text });
      for (const fc of t.functionCalls ?? []) parts.push({ functionCall: fc });
      const chunkOf = (chunkParts: unknown[], finish: string | null) => ({
        candidates: [{ content: { parts: chunkParts, role: 'model' }, ...(finish ? { finishReason: finish } : {}), index: 0 }],
        usageMetadata,
        modelVersion: model,
        responseId: `mock-${requestNo}`,
      });
      if (!streaming) {
        const bytes = Buffer.from(JSON.stringify(chunkOf(parts, t.finishReason)));
        res.writeHead(200, { 'content-type': 'application/json; charset=UTF-8', 'content-length': String(bytes.length) });
        res.end(bytes);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const events: unknown[] = [];
      const textPieces = split(t.text ?? '', 3);
      const calls = t.functionCalls ?? [];
      textPieces.forEach((piece, i) => events.push(chunkOf([{ text: piece }], i === textPieces.length - 1 && calls.length === 0 ? t.finishReason : null)));
      calls.forEach((fc, i) => events.push(chunkOf([{ functionCall: fc }], i === calls.length - 1 ? t.finishReason : null)));
      if (events.length === 0) events.push(chunkOf([{ text: '' }], t.finishReason));
      for (const e of events) {
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 3)));
        if (res.destroyed) return;
        res.write(`data: ${JSON.stringify(e)}\r\n\r\n`);
      }
      res.end();
    })().catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 500, message: String(err), status: 'INTERNAL' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

// A scripted judge, for shadowlap's judge checks (judge.ts).
export { judgeQuestion, judgeTurn, withJudge, type JudgeDecision, type JudgeQuestion } from './judge.js';
