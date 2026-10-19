import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { matchTask, type ReadPolicy, type Store } from '@shadowlap/engine';
import { type GuardMode } from './run-agent.js';
import { openStore, type GlobalOpts } from './shared.js';
import { resolveTarget } from './takeover.js';
import { cannotScore, loadTasks, scoreTask, type LoadedTask } from './tasks.js';

/**
 * `shadowlap tasks serve`: one attempt per HTTP request, for a training loop that wants a reward.
 * The request names the task and the model (the server of the model being trained); the attempt
 * replays the golden up to the takeover for free, the model answers from there with writes stubbed,
 * and the response carries each check's result, the score, the run and what it cost. It listens on
 * this machine only, checks the Host header, refuses requests from web pages, and needs the token it
 * prints.
 */

export interface ServeSettings {
  port: number;
  /** The port was asked for: if it is taken, fail rather than take another. */
  strictPort: boolean;
  token: string;
  /** Attempts running at once; more requests wait their turn. */
  concurrency: number;
  reads: ReadPolicy;
  timeoutMs: number | null;
  guard: GuardMode;
  /** Only these tasks, by golden path; every ready one when empty. */
  goldens: string[];
  /**
   * The endpoint of the model being trained (`--base-url`): a request that names no `baseUrl` (and no
   * provider, as `anthropic:<model>` does) asks it, and `keyEnv`'s key goes to it alone.
   */
  baseUrl?: string;
  /**
   * The environment variable whose key goes to `baseUrl` (`--key-env`). A request can't name one
   * itself, and the key never goes to an endpoint a request names elsewhere: either would let a
   * request send a key from the environment to an address of its choosing.
   */
  keyEnv?: string;
}

export interface TasksServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

const BODY_LIMIT = 64 * 1024;
/** Past the limit the rest of a body is read and dropped, so the 413 reaches the client; this far past it, the connection is cut. */
const DRAIN_LIMIT = 16 * BODY_LIMIT;

function send(res: ServerResponse, status: number, value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(bytes.length), 'cache-control': 'no-store' });
  res.end(bytes);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= BODY_LIMIT) chunks.push(c);
      else if (size - c.length <= BODY_LIMIT) reject(Object.assign(new Error(`the request is over ${BODY_LIMIT / 1024} KB`), { status: 413 }));
      else if (size > DRAIN_LIMIT) req.destroy();
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const sameOrigin = (a: string, b: string) => {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
};

function tokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!m) return false;
  const given = Buffer.from(m[1]!.trim());
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

function taskView(t: LoadedTask) {
  return { task: t.name, golden: t.golden, status: t.status, note: t.note, takeover: t.takeover?.callNo ?? null, why: t.takeover?.why ?? null, scope: t.scope, rewards: t.rewards, checks: ['the agent exits 0', ...t.checks.filter((c) => !c.cap).map((c) => c.label)], run: t.runId };
}

export async function serveTasks(opts: GlobalOpts, root: string, s: ServeSettings, log: (line: string) => void): Promise<TasksServer> {
  const session = `serve-${Date.now().toString(36)}`;
  const counters = new Map<string, number>();
  let running = 0;
  const queue: Array<() => void> = [];
  const acquire = () => (running < s.concurrency ? (running++, Promise.resolve()) : new Promise<void>((resolve) => queue.push(() => (running++, resolve()))));
  const release = () => {
    running--;
    queue.shift()?.();
  };
  const tasks = () => {
    let store: Store | null = null;
    try {
      store = openStore(opts);
      const all = loadTasks(root, store).tasks;
      return s.goldens.length ? all.filter((t) => s.goldens.includes(t.golden)) : all;
    } finally {
      store?.close();
    }
  };

  let port = 0;
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    // Loopback only, and only as itself: a page that rebinds a name to 127.0.0.1 sends its own Host.
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: `requests must be addressed to 127.0.0.1:${port}` });
    if (req.headers.origin !== undefined) return send(res, 403, { error: 'requests from web pages are refused' });
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (req.method === 'GET' && url.pathname === '/v1/health') return send(res, 200, { ok: true });
    if (!tokenMatches(req.headers.authorization, s.token)) return send(res, 401, { error: 'send the token tasks serve printed: Authorization: Bearer <token>' });

    if (req.method === 'GET' && url.pathname === '/v1/tasks') return send(res, 200, { tasks: tasks().map(taskView) });

    const m = /^\/v1\/tasks\/(.+)\/attempts$/.exec(url.pathname);
    if (req.method !== 'POST' || !m) return send(res, 404, { error: `no route ${req.method} ${url.pathname}: POST /v1/tasks/<task>/attempts, GET /v1/tasks` });
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse((await readBody(req)).toString('utf8') || '{}') as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('the body must be a JSON object');
      body = parsed as Record<string, unknown>;
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      // Over the limit: said, and the connection closed once the rest of the body is dropped.
      if (status === 413) res.setHeader('connection', 'close');
      return send(res, status, { error: err instanceof SyntaxError ? 'the body is not JSON' : (err as Error).message });
    }
    let name: string;
    try {
      name = decodeURIComponent(m[1]!);
    } catch {
      return send(res, 400, { error: 'the task in the path is not a valid percent-encoded name' });
    }
    const match = matchTask(tasks(), name);
    if (!match) return send(res, 404, { error: `no task "${name}" (GET /v1/tasks lists them)` });
    if ('ambiguous' in match) return send(res, 409, { error: `"${name}" names more than one golden: give its path, such as ${encodeURIComponent(match.ambiguous[0]!)}`, ambiguous: match.ambiguous });
    const { task } = match;
    if (typeof body.model !== 'string' || !body.model) return send(res, 400, { error: '"model" is required: the model to ask, such as "my-finetune"' });
    if (body.baseUrl !== undefined && typeof body.baseUrl !== 'string') return send(res, 400, { error: '"baseUrl" must be a string' });
    if (body.keyEnv !== undefined) return send(res, 400, { error: '"keyEnv" is set when tasks serve starts (--key-env), not per request' });
    if (body.from !== undefined && (typeof body.from !== 'number' || !Number.isSafeInteger(body.from) || body.from < 1)) return send(res, 400, { error: '"from" must be a model call number' });
    if (body.reads !== undefined && body.reads !== 'live' && body.reads !== 'replay') return send(res, 400, { error: '"reads" must be "live" or "replay"' });
    // The endpoint tasks serve was started with, unless the request names another one or a provider.
    const baseUrl = (body.baseUrl as string | undefined) ?? (s.baseUrl && !/^(anthropic|openai):/.test(body.model.trim()) ? s.baseUrl : undefined);
    let target: ReturnType<typeof resolveTarget>;
    try {
      target = resolveTarget({ model: body.model, baseUrl, keyEnv: s.keyEnv && s.baseUrl && baseUrl && sameOrigin(baseUrl, s.baseUrl) ? s.keyEnv : undefined });
    } catch (err) {
      return send(res, 400, { error: (err as Error).message });
    }
    const takeover = body.from as number | undefined;
    const refused = cannotScore(task, target, takeover);
    if (refused) return send(res, 409, { error: refused, status: task.status });

    await acquire();
    try {
      const n = (counters.get(task.golden) ?? 0) + 1;
      counters.set(task.golden, n);
      const started = Date.now();
      let score: Awaited<ReturnType<typeof scoreTask>>;
      try {
        score = await scoreTask(opts, task, target, { attempts: 1, reads: (body.reads as ReadPolicy | undefined) ?? s.reads, concurrency: 1, budget: null, timeoutMs: s.timeoutMs, guard: s.guard, first: n, of: n, ...(takeover !== undefined ? { takeover } : {}) }, { id: session, spentBefore: 0 });
      } catch (err) {
        return send(res, 502, { error: err instanceof Error ? err.message : String(err), task: task.name });
      }
      const a = score.attempts[0];
      if (!a) return send(res, 502, { error: score.stopped ?? 'the attempt did not finish', task: task.name });
      log(`${task.name} · ${target.model} · ${a.score.toFixed(2)} · ${a.runId}`);
      return send(res, 200, {
        task: task.name,
        model: target.model,
        takeover: score.takeover,
        score: a.score,
        checks: a.checks,
        run: a.runId,
        spent: a.spent,
        // Its judge checks' calls, apart from what the attempt cost, as tasks score reports them.
        ...(a.judge ? { judge: a.judge } : {}),
        exitCode: a.exitCode,
        ms: Date.now() - started,
        ...(score.dropped.length ? { dropped: score.dropped } : {}),
      });
    } finally {
      release();
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) send(res, 500, { error: err instanceof Error ? err.message : String(err) });
      else res.destroy();
    });
  });
  const listen = (p: number) =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(p, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  try {
    await listen(s.port);
  } catch (err) {
    if ((err as { code?: string }).code !== 'EADDRINUSE' || s.strictPort) throw err;
    await listen(0);
  }
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
