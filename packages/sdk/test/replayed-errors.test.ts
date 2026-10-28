import { renameSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReplayedError, tool } from '../src/index.js';

/**
 * An error a tool threw, recorded and then replayed: the replay hands the agent what it reads off
 * the error, a file system error's `errno`, `syscall`, `path` and `dest`, an HTTP client error's
 * `status`, as the Python SDK keeps an error's arguments and file names. A stand-in sidecar answers
 * resolve and keeps what the call completed with.
 */
let server: Server;
let answer: unknown;
let completed: { error?: unknown } | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString()));
    req.on('end', () => {
      if (req.url?.endsWith('/complete')) completed = JSON.parse(body) as { error?: unknown };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url?.endsWith('/resolve') ? answer : { ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  process.env.SHADOWLAP_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/t/token`;
});
afterAll(async () => {
  delete process.env.SHADOWLAP_URL;
  await new Promise<void>((r) => server.close(() => r()));
});

/** What a tool that fails as `fail` does threw live, what the recording keeps of it, and what its replay throws. */
async function roundTrip(fail: () => never): Promise<{ original: unknown; recorded: unknown; replayed: unknown }> {
  const lookup = tool('lookup_order', { effect: 'read' }, async ({ id }: { id: string }) => (id ? fail() : null));
  const thrown = () => lookup({ id: 'A-17' }).then(
    () => null,
    (e: unknown) => e,
  );
  answer = { origin: 'live', callNo: 1 };
  completed = null;
  const original = await thrown();
  // As the sidecar stores it: JSON.
  const recorded = JSON.parse(JSON.stringify(completed!.error)) as unknown;
  answer = { origin: 'replayed', callNo: 1, outcome: 'error', error: recorded };
  return { original, recorded, replayed: await thrown() };
}

/** An HTTP client's error, as Octokit's RequestError and the OpenAI SDK's APIError are: a status, and the request it made. */
class HttpClientError extends Error {
  readonly status: number;
  readonly request: { method: string; url: string; headers: Record<string, string> };
  constructor(message: string, status: number) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.request = { method: 'GET', url: 'https://api.example/orders/A-17', headers: { authorization: 'token not-for-a-recording' } };
  }
}

/** An HTTP client's error as Axios's is: the response it got, with its status, headers, data and the request's config. */
class AxiosLikeError extends Error {
  readonly response: { status: number; statusText: string; headers: Record<string, string>; data: unknown; config: { headers: Record<string, string> } };
  constructor(status: number, statusText: string) {
    super(`Request failed with status code ${status}`);
    this.name = 'AxiosError';
    this.response = { status, statusText, headers: { 'set-cookie': 'session=not-for-a-recording' }, data: { error: 'rate limited' }, config: { headers: { Authorization: 'Bearer not-for-a-recording' } } };
  }
}

describe('a replayed error', () => {
  it("keeps the status of the response an HTTP client's error carries, as Axios's does, and nothing else of it", async () => {
    const { recorded, replayed } = await roundTrip(() => {
      throw new AxiosLikeError(429, 'Too Many Requests');
    });
    expect(replayed).toBeInstanceOf(ReplayedError);
    expect((replayed as { response?: unknown }).response).toEqual({ status: 429, statusText: 'Too Many Requests' });
    expect(JSON.stringify(recorded)).not.toContain('not-for-a-recording');
    expect(JSON.stringify(recorded)).not.toContain('rate limited');
  });

  it("keeps a file system error's errno, syscall, path and dest", async () => {
    const missing = join(tmpdir(), `sl-replayed-errors-${process.pid}-missing`);
    const { original, replayed } = await roundTrip(() => {
      renameSync(missing, `${missing}-moved`);
      throw new Error('renamed a file that is not there');
    });
    const o = original as NodeJS.ErrnoException & { dest?: string };
    expect([o.code, o.syscall, o.dest]).toEqual(['ENOENT', 'rename', `${missing}-moved`]);
    expect(replayed).toBeInstanceOf(ReplayedError);
    const r = replayed as NodeJS.ErrnoException & { dest?: string };
    expect([r.name, r.message, r.code, r.errno, r.syscall, r.path, r.dest]).toEqual([o.name, o.message, o.code, o.errno, o.syscall, o.path, o.dest]);
    expect(String(r)).toBe(String(o));
  });

  it("keeps an HTTP client error's status, and nothing nested, which can hold a request's headers", async () => {
    const { recorded, replayed } = await roundTrip(() => {
      throw new HttpClientError('Not Found', 404);
    });
    expect(replayed).toBeInstanceOf(ReplayedError);
    expect(replayed).toMatchObject({ name: 'HttpError', message: 'Not Found', status: 404 });
    expect((replayed as { request?: unknown }).request).toBeUndefined();
    expect(JSON.stringify(recorded)).not.toContain('not-for-a-recording');
  });

  it('takes no field that would shadow what an error has, and reads a recording made before fields were kept as it did', () => {
    const e = new ReplayedError({ name: 'HttpError', message: 'Bad Gateway', code: 'E502', fields: { status: 502, toString: 'no', name: 'Other', code: 'X', ok: false, nested: { a: 1 } as never } });
    expect([String(e), e.code, (e as unknown as { status: number }).status, (e as unknown as { ok: boolean }).ok, (e as unknown as { nested?: unknown }).nested]).toEqual(['HttpError: Bad Gateway', 'E502', 502, false, undefined]);
    const old = new ReplayedError({ name: 'Error', message: 'gone' });
    expect(Object.keys(old).sort()).toEqual(['code', 'data', 'name']);
  });
});
