import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Store } from '@shadowlap/engine';
import { windowOf } from '../src/commands/import.js';
import { fields, keys } from './json-shapes.js';

/**
 * shadowlap import langfuse|phoenix|logfire without a trace id: the traces that started in a window,
 * listed through each store's own API (a local server stands in for it), one run per trace, each
 * trace said in a line, and a trace an earlier import brought in skipped by its id.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/traces/${name}`, import.meta.url), 'utf8')) as T;

const KEYS = { LANGFUSE_PUBLIC_KEY: 'pk-lf-0e5c-public', LANGFUSE_SECRET_KEY: 'sk-lf-9d1f-do-not-store' };
const PHOENIX_KEY = 'phx_6b1d_do_not_store';
const LOGFIRE_TOKEN = 'pylf_v1_us_donotstore7a1c';
/** Where the stores would be found otherwise, cleared so a developer's own setup can't reach the tests. */
const NO_STORE_ENV = { LANGFUSE_HOST: '', LANGFUSE_BASE_URL: '', PHOENIX_ENDPOINT: '', PHOENIX_COLLECTOR_ENDPOINT: '', PHOENIX_BASE_URL: '', PHOENIX_API_KEY: '', PHOENIX_PROJECT: '', PHOENIX_PROJECT_NAME: '', LOGFIRE_BASE_URL: '', LOGFIRE_READ_TOKEN: '' };

type Handler = (req: IncomingMessage, url: URL, body: string) => { status: number; body: unknown };
let api: Server;
let host: string;
let handle: Handler = () => ({ status: 404, body: { message: 'not found' } });
/** Every request the store got, as `METHOD path?query`. */
let seen: string[] = [];
const dirs: string[] = [];

beforeAll(async () => {
  api = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      seen.push(`${req.method} ${url.pathname}${url.search}`);
      const r = handle(req, url, body);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  host = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
afterEach(() => {
  seen = [];
});
afterAll(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** A store of its own for each test. */
function freshDb(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'sl-import-bulk-')));
  dirs.push(d);
  return join(d, 'store.db');
}

function shadowlap(db: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db, ...args], {
      cwd: join(db, '..'),
      env: { ...process.env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_GUARD: 'off', ...NO_STORE_ENV, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}

/** The runs a store holds, each with the trace id kept with it. */
function importedKeys(db: string): Array<{ runId: string; key: string | undefined; from: string | undefined }> {
  const store = Store.open(db);
  try {
    return store.allRuns().map((r) => ({ runId: r.runId, key: r.meta?.imported?.key, from: r.meta?.imported?.from }));
  } finally {
    store.close();
  }
}

// ---- Langfuse ----

type Observation = Record<string, unknown> & { id: string; traceId: string; startTime: string; parentObservationId: string | null };
const LANGFUSE = fixture<{ observations: Observation[] }>('langfuse-trace.json');
const DAY = 86_400_000;

/** The fixture's trace again under another id, `daysLater` days after it started, as Langfuse names it; without its generations and tools, a trace with no call to import. */
function langfuseTrace(id: string, name: string, daysLater: number, withCalls = true): { id: string; name: string; startTime: string; observations: Observation[] } {
  const shift = (t: unknown) => (typeof t === 'string' ? new Date(Date.parse(t) + daysLater * DAY).toISOString() : t);
  const observations = LANGFUSE.observations
    .filter((o) => withCalls || (o.type !== 'GENERATION' && o.type !== 'TOOL'))
    .map((o) => ({ ...o, id: `${id.slice(0, 8)}-${o.id}`, traceId: id, startTime: shift(o.startTime) as string, endTime: shift(o.endTime), parentObservationId: o.parentObservationId ? `${id.slice(0, 8)}-${o.parentObservationId}` : null }));
  return { id, name, startTime: observations[0].startTime, observations };
}

/** Observations as the v2 API sends them: input and output as the text they were stored as, model parameters and metadata as JSON text. */
const text = (v: unknown) => (v && typeof v === 'object' ? JSON.stringify(v) : v);
const asV2 = (o: Observation) => ({ ...o, input: JSON.stringify(o.input ?? null), output: JSON.stringify(o.output ?? null), modelParameters: text(o.modelParameters), metadata: text(o.metadata) });

const T1 = '11111111-41b8-4d0e-9a51-2c6e8b1d4f07';
const T2 = '22222222-41b8-4d0e-9a51-2c6e8b1d4f07';
const T3 = '33333333-41b8-4d0e-9a51-2c6e8b1d4f07';
const T4 = '44444444-41b8-4d0e-9a51-2c6e8b1d4f07';
/** Newest first: two support chats, a nightly job that called no model, and a chat from before the window. */
const LANGFUSE_TRACES = [langfuseTrace(T1, 'support-chat', 4), langfuseTrace(T2, 'support-chat', 3), langfuseTrace(T3, 'nightly-eval', 2, false), langfuseTrace(T4, 'support-chat', -20)];
const BASIC = `Basic ${Buffer.from(`${KEYS.LANGFUSE_PUBLIC_KEY}:${KEYS.LANGFUSE_SECRET_KEY}`).toString('base64')}`;

/**
 * Langfuse with the Observations API v2: the root observations listed two to a page, with the trace's
 * name, filtered as asked (all but the window's start, which an older Langfuse may ignore and the
 * import checks itself); a trace's observations by its id. `fail` answers for one trace with a status.
 */
function langfuseV2(o: { fail?: { id: string; status: number } } = {}): Handler {
  return (req, url) => {
    if (req.headers.authorization !== BASIC) return { status: 401, body: { message: 'Invalid credentials' } };
    if (url.pathname !== '/api/public/v2/observations') return { status: 404, body: { message: 'not found' } };
    const traceId = url.searchParams.get('traceId');
    if (traceId) {
      if (o.fail?.id === traceId) return { status: o.fail.status, body: { message: 'Internal Server Error' } };
      const t = LANGFUSE_TRACES.find((x) => x.id === traceId);
      return { status: 200, body: { data: (t?.observations ?? []).map(asV2).reverse(), meta: { cursor: null } } };
    }
    const filter = JSON.parse(url.searchParams.get('filter') ?? '[]') as Array<{ column: string; operator: string; value: unknown }>;
    const named = filter.find((f) => f.column === 'traceName')?.value;
    const until = Date.parse(String(filter.find((f) => f.column === 'startTime' && f.operator === '<')?.value));
    const roots = LANGFUSE_TRACES.filter((t) => (named === undefined || t.name === named) && Date.parse(t.startTime) < until).map((t) => ({ ...asV2(t.observations[0]), traceName: t.name, isRootObservation: true }));
    const at = Number(url.searchParams.get('cursor') ?? 0);
    return { status: 200, body: { data: roots.slice(at, at + 2), meta: { cursor: at + 2 < roots.length ? String(at + 2) : null } } };
  };
}

/** The window the Langfuse tests read: from the fixture's day to a week after it. */
const WINDOW = ['--since', '2026-10-01', '--until', '2026-10-08'];

describe('shadowlap import langfuse, the traces in a window', () => {
  it('imports each trace that started in the window as a run, says each in a line, and skips what an import brought in before', async () => {
    const db = freshDb();
    handle = langfuseV2();
    // One of them imported by its id first: it keeps that id with the run.
    const single = await shadowlap(db, ['import', 'langfuse', T2, '--host', host, '--json'], KEYS);
    expect(single.code, single.err).toBe(0);
    const t2Run = (JSON.parse(single.out) as { runs: Array<{ runId: string }> }).runs[0].runId;
    expect(importedKeys(db)).toEqual([{ runId: t2Run, key: T2, from: 'langfuse:22222222' }]);
    seen = [];

    const r = await shadowlap(db, ['import', 'langfuse', ...WINDOW, '--host', host], KEYS);
    expect(r.code, r.err).toBe(0);
    const where = new URL(host).host;
    const runs = importedKeys(db);
    const t1Run = runs.find((x) => x.key === T1)!.runId;
    expect(r.out.split('\n').slice(0, 6)).toEqual([
      `3 traces in Langfuse on ${where} that started from 2026-10-01 00:00 UTC to 2026-10-08 00:00 UTC:`,
      `  11111111-41b8-4d  imported as ${t1Run.slice(0, 10)}: 3 model calls and 1 tool result  support-chat`,
      `  22222222-41b8-4d  imported before, as ${t2Run.slice(0, 10)}  support-chat`,
      '  33333333-41b8-4d  skipped: no model calls in its 3 observations  nightly-eval',
      'Imported 1 of 3 traces: 1 imported before, 1 skipped.',
      'Read 10 observations. It kept the messages of 3 of 3 model calls, settings for 3, tool definitions for 3, and the output of 1 of 2 tool calls (the others run live on replay, with writes fenced).',
    ]);
    expect(r.out).toContain(`The keys were read from the environment and sent to ${where} only; nothing of them is stored.`);
    expect(r.out).toContain(`shadowlap replay ${t1Run.slice(0, 10)} -- <your agent command>`);
    // The list asked for the root observations in the window with the trace's name, a page at a time;
    // the trace imported before was never fetched, and the one from before the window, which this
    // Langfuse lists anyway, was left out.
    const lists = seen.filter((s) => !s.includes('traceId='));
    expect(lists).toHaveLength(2);
    const q = new URL(lists[0].slice(4), 'http://x').searchParams;
    expect(q.get('fields')).toBe('core,basic,trace_context');
    expect(q.get('fromStartTime')).toBe('2026-10-01T00:00:00.000Z');
    expect(q.get('toStartTime')).toBe('2026-10-08T00:00:00.000Z');
    expect(JSON.parse(q.get('filter')!)).toEqual([
      { type: 'datetime', column: 'startTime', operator: '>=', value: '2026-10-01T00:00:00.000Z' },
      { type: 'datetime', column: 'startTime', operator: '<', value: '2026-10-08T00:00:00.000Z' },
      { type: 'boolean', column: 'isRootObservation', operator: '=', value: true },
    ]);
    expect(seen.filter((s) => s.includes('traceId=')).map((s) => new URL(s.slice(4), 'http://x').searchParams.get('traceId'))).toEqual([T1, T3]);
    expect(runs.map((x) => x.key).sort()).toEqual([T1, T2]);

    // Again: nothing new to import, and nothing failed.
    const again = await shadowlap(db, ['import', 'langfuse', ...WINDOW, '--host', host], KEYS);
    expect(again.code, again.err).toBe(0);
    expect(again.out).toContain(`  11111111-41b8-4d  imported before, as ${t1Run.slice(0, 10)}  support-chat\n`);
    expect(again.out).toContain('Imported 0 of 3 traces: 2 imported before, 1 skipped.\n');
    expect(again.out).not.toContain('shadowlap replay');
    expect(importedKeys(db)).toHaveLength(2);
    const bytes = readFileSync(db);
    for (const secret of Object.values(KEYS)) expect(bytes.includes(Buffer.from(secret))).toBe(false);
  });

  it('filters by the trace name, and lists every trace found with what became of it in --json', async () => {
    const db = freshDb();
    handle = langfuseV2();
    const r = await shadowlap(db, ['import', 'langfuse', ...WINDOW, '--trace-name', 'support-chat', '--host', host, '--json'], KEYS);
    expect(r.code, r.err).toBe(0);
    const json = JSON.parse(r.out);
    expect(keys(json)).toEqual(fields('importBulk'));
    expect(keys(json.window)).toEqual(fields('importWindow'));
    expect(json.traces.map((t: unknown) => keys(t))).toEqual([fields('importTrace'), fields('importTrace')]);
    expect(json.window).toEqual({ since: '2026-10-01T00:00:00.000Z', until: '2026-10-08T00:00:00.000Z', limit: 100, traceName: 'support-chat' });
    expect(json.traces).toEqual([
      { id: T1, name: 'support-chat', startedAt: LANGFUSE_TRACES[0].startTime, outcome: 'imported', runId: json.runs[0].runId, reason: null, judged: null },
      { id: T2, name: 'support-chat', startedAt: LANGFUSE_TRACES[1].startTime, outcome: 'imported', runId: json.runs[1].runId, reason: null, judged: null },
    ]);
    expect(json.runs.map((x: { key: string; source: string; calls: unknown }) => [x.key, x.source, x.calls])).toEqual([
      [T1, 'langfuse:11111111', { model: 3, tool: 1 }],
      [T2, 'langfuse:22222222', { model: 3, tool: 1 }],
    ]);
    expect(json.kept).toMatchObject({ traces: 2, spans: 14, modelCalls: 6, modelCallsImported: 6 });
    const filter = JSON.parse(new URL(seen[0].slice(4), 'http://x').searchParams.get('filter')!) as unknown[];
    expect(filter).toContainEqual({ type: 'string', column: 'traceName', operator: '=', value: 'support-chat' });
  });

  it('judges each trace by the rules on calls as it imports it, and once they change, each it imported before, said in its line and in --json', async () => {
    const db = freshDb();
    handle = langfuseV2();
    const config = join(db, '..', 'shadowlap.config.json');
    const rule = (orderId: string) => writeFileSync(config, JSON.stringify({ tests: { 'goldens/support': { expect: { calls: [{ tool: 'lookup_order', args: { order_id: orderId } }] } } } }));
    rule('A-1042');
    const first = await shadowlap(db, ['import', 'langfuse', ...WINDOW, '--trace-name', 'support-chat', '--host', host, '--json'], KEYS);
    expect(first.code, first.err).toBe(0);
    const imported = JSON.parse(first.out) as { traces: Array<{ outcome: string; runId: string; judged: { verdict: string } | null }> };
    expect(imported.traces.map((t) => [t.outcome, t.judged?.verdict])).toEqual([
      ['imported', 'passed'],
      ['imported', 'passed'],
    ]);
    // The rules stay: each imported before keeps its verdict.
    const same = await shadowlap(db, ['import', 'langfuse', ...WINDOW, '--trace-name', 'support-chat', '--host', host, '--json'], KEYS);
    expect((JSON.parse(same.out) as { traces: Array<{ outcome: string; judged: unknown }> }).traces.map((t) => [t.outcome, t.judged])).toEqual([
      ['already', null],
      ['already', null],
    ]);
    // A rule its calls break: each imported before is judged again, and says so.
    rule('B-7');
    const again = await shadowlap(db, ['import', 'langfuse', ...WINDOW, '--trace-name', 'support-chat', '--host', host], KEYS);
    expect(again.code, again.err).toBe(0);
    const t1Run = imported.traces[0].runId;
    expect(again.out).toContain(`  11111111-41b8-4d  imported before, as ${t1Run.slice(0, 10)} · judged again: check failed: every lookup_order call: order_id = "B-7", but lookup_order #`);
    const kept = Store.open(db);
    try {
      expect(kept.getRun(t1Run)?.meta?.judged).toMatchObject({ verdict: 'failed' });
    } finally {
      kept.close();
    }
    // And once more with --json: the verdict it kept now stands.
    const json = await shadowlap(db, ['import', 'langfuse', ...WINDOW, '--trace-name', 'support-chat', '--host', host, '--json'], KEYS);
    expect((JSON.parse(json.out) as { traces: Array<{ judged: unknown }> }).traces.map((t) => t.judged)).toEqual([null, null]);
  });

  it('stops at a failure that is not the one trace\'s, keeps what it imported, and goes on from there when run again', async () => {
    const db = freshDb();
    handle = langfuseV2({ fail: { id: T2, status: 500 } });
    const r = await shadowlap(db, ['import', 'langfuse', ...WINDOW, '--host', host], KEYS);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`  22222222-41b8-4d  failed: ${new URL(host).host} answered 500 Internal Server Error  support-chat\n`);
    expect(r.out).toContain('Imported 1 of 3 traces: 1 failed, 1 not read.\n');
    expect(r.out).toContain('The import stopped at the failure. Run it again to go on from there: it skips the traces imported already.');
    expect(r.err).toBe(`shadowlap: ${new URL(host).host} answered 500 Internal Server Error\n`);
    expect(importedKeys(db).map((x) => x.key)).toEqual([T1]);

    // A trace gone since it was listed is that trace's alone: skipped, and the import goes on.
    const gone = langfuseV2();
    handle = (req, url, body) => (url.searchParams.get('traceId') === T2 ? { status: 200, body: { data: [], meta: { cursor: null } } } : gone(req, url, body));
    const next = await shadowlap(db, ['import', 'langfuse', ...WINDOW, '--host', host], KEYS);
    expect(next.code, next.err).toBe(0);
    expect(next.out).toContain(`  22222222-41b8-4d  skipped: Langfuse has no trace ${T2} on ${new URL(host).host}  support-chat\n`);
    expect(next.out).toContain('Imported 0 of 3 traces: 1 imported before, 2 skipped.\n');
  });

  it('reads a Langfuse without the Observations API v2 through its traces list, and stops the list at --limit', async () => {
    const db = freshDb();
    handle = (req, url) => {
      if (req.headers.authorization !== BASIC) return { status: 401, body: { message: 'Invalid credentials' } };
      if (url.pathname === '/api/public/traces') {
        const from = Date.parse(url.searchParams.get('fromTimestamp')!);
        const data = LANGFUSE_TRACES.filter((t) => Date.parse(t.startTime) >= from).map((t) => ({ id: t.id, name: t.name, timestamp: t.startTime }));
        return { status: 200, body: { data, meta: { page: 1, limit: 100, totalItems: data.length, totalPages: 1 } } };
      }
      const t = LANGFUSE_TRACES.find((x) => url.pathname === `/api/public/traces/${x.id}`);
      if (t) return { status: 200, body: { id: t.id, name: t.name, observations: t.observations } };
      return { status: 404, body: { message: 'not found' } };
    };
    const r = await shadowlap(db, ['import', 'langfuse', '--since', '2026-10-01', '--limit', '1', '--host', host], KEYS);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/^The newest 1 trace in Langfuse on \S+ that started from 2026-10-01 00:00 UTC to \d{4}-\d\d-\d\d \d\d:\d\d UTC:\n {2}11111111-41b8-4d {2}imported as \w{10}: 3 model calls and 1 tool result {2}support-chat\nImported 1 of 1 trace\.\n--limit stopped the list at 1: more may have started in that window\.\n/);
    const list = new URL(seen.find((s) => s.startsWith('GET /api/public/traces?'))!.slice(4), 'http://x').searchParams;
    expect(Object.fromEntries(list)).toMatchObject({ page: '1', limit: '100', fromTimestamp: '2026-10-01T00:00:00.000Z', orderBy: 'timestamp.desc' });
    expect(seen.filter((s) => s.startsWith(`GET /api/public/traces/`))).toEqual([`GET /api/public/traces/${T1}`]);
  });

  it('refuses a window without keys, keys the store rejects, flags that need no trace id, and a window that is none', async () => {
    const db = freshDb();
    handle = langfuseV2();
    const bare = await shadowlap(db, ['import', 'langfuse', '--host', host], KEYS);
    expect(bare).toMatchObject({ code: 2, err: 'shadowlap: import langfuse: give a trace id, or --since, --until, --limit or --trace-name to import the traces that started in a window\n' });
    const both = await shadowlap(db, ['import', 'langfuse', T1, '--limit', '5', '--trace-name', 'x', '--host', host], KEYS);
    expect(both).toMatchObject({ code: 2, err: 'shadowlap: --limit, --trace-name: for the traces in a window, without a trace id; give a trace id or the flags, not both\n' });
    const zero = await shadowlap(db, ['import', 'langfuse', '--limit', '0', '--host', host], KEYS);
    expect(zero).toMatchObject({ code: 2, err: 'shadowlap: --limit: a number of traces from 1 to 10000, not "0"\n' });
    const backwards = await shadowlap(db, ['import', 'langfuse', '--since', '2026-10-05', '--until', '2026-10-01', '--host', host], KEYS);
    expect(backwards).toMatchObject({ code: 2, err: 'shadowlap: --until: "2026-10-01" is not after --since (2026-10-05 00:00 UTC)\n' });
    const noKeys = await shadowlap(db, ['import', 'langfuse', ...WINDOW, '--host', host], { LANGFUSE_PUBLIC_KEY: '', LANGFUSE_SECRET_KEY: '' });
    expect(noKeys.code).toBe(2);
    expect(noKeys.err).toContain('LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY');
    const wrong = await shadowlap(db, ['import', 'langfuse', ...WINDOW, '--host', host], { ...KEYS, LANGFUSE_SECRET_KEY: 'sk-lf-wrong' });
    expect(wrong).toMatchObject({ code: 2, err: 'shadowlap: Langfuse refused the keys (401): check LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY, and that the host is the region the project lives in\n' });
    // A store that doesn't answer is a failure to finish, not a mistake in what was asked.
    const away = await shadowlap(db, ['import', 'langfuse', ...WINDOW, '--host', 'http://127.0.0.1:9'], KEYS);
    expect(away.code).toBe(1);
    expect(away.err).toMatch(/^shadowlap: could not reach 127\.0\.0\.1:9: /);
    // An empty window is nothing to import, and nothing wrong.
    const empty = await shadowlap(db, ['import', 'langfuse', '--since', '2026-10-20', '--until', '2026-10-21', '--host', host], KEYS);
    expect(empty).toMatchObject({ code: 0, out: `No traces in Langfuse on ${new URL(host).host} started from 2026-10-20 00:00 UTC to 2026-10-21 00:00 UTC.\n` });
    expect(importedKeys(db)).toEqual([]);
  });
});

// ---- Phoenix ----

type Span = Record<string, unknown> & { context: { trace_id: string; span_id: string }; parent_id: string | null; start_time: string; name: string };
const PHOENIX = new Map([
  ['4a2db41deabc4aec332fb9fbfa0fc3e2', fixture<{ data: Span[] }>('phoenix-spans.json').data],
  ['3e4096353fce83a482ccbf37d3f1291c', fixture<{ data: Span[] }>('phoenix-spans-sdk-objects.json').data],
]);

describe('shadowlap import phoenix, the traces in a window', () => {
  it("lists the root spans in the window a page at a time, with the name asked for, and imports each trace", async () => {
    const db = freshDb();
    handle = (req, url) => {
      if (req.headers.authorization !== `Bearer ${PHOENIX_KEY}`) return { status: 401, body: 'Unauthorized' };
      if (url.pathname !== '/v1/projects/support-agent/spans') return { status: 404, body: 'Not Found' };
      const traceId = url.searchParams.get('trace_id');
      if (traceId) return { status: 200, body: { data: PHOENIX.get(traceId) ?? [], next_cursor: null } };
      const roots = [...PHOENIX.values()].map((spans) => spans.find((s) => !s.parent_id)!).sort((a, b) => b.start_time.localeCompare(a.start_time));
      const at = url.searchParams.get('cursor') ? 1 : 0;
      return { status: 200, body: { data: roots.slice(at, at + 1), next_cursor: at === 0 ? 'U3Bhbjox' : null } };
    };
    const r = await shadowlap(db, ['import', 'phoenix', '--since', '2026-10-22T00:00Z', '--until', '2026-10-23', '--trace-name', 'support-agent', '--project', 'support-agent', '--host', host, '--json'], { PHOENIX_API_KEY: PHOENIX_KEY });
    expect(r.code, r.err).toBe(0);
    const json = JSON.parse(r.out);
    // Newest first: the trace that started at 16:10, then the one at 15:59.
    expect(json.traces.map((t: { id: string; outcome: string; name: string }) => [t.id, t.outcome, t.name])).toEqual([
      ['3e4096353fce83a482ccbf37d3f1291c', 'imported', 'support-agent'],
      ['4a2db41deabc4aec332fb9fbfa0fc3e2', 'imported', 'support-agent'],
    ]);
    expect(json.runs.map((x: { source: string; calls: unknown }) => x.source).sort()).toEqual(['phoenix:3e409635', 'phoenix:4a2db41d']);
    const lists = seen.filter((s) => s.includes('parent_id='));
    expect(lists).toHaveLength(2);
    const q = new URL(lists[0].slice(4), 'http://x').searchParams;
    expect(Object.fromEntries(q)).toEqual({ parent_id: 'null', start_time: '2026-10-22T00:00:00.000Z', end_time: '2026-10-23T00:00:00.000Z', sort: 'start_time', order: 'desc', limit: '1000', name: 'support-agent' });
    expect(new URL(lists[1].slice(4), 'http://x').searchParams.get('cursor')).toBe('U3Bhbjox');
    expect(readFileSync(db).includes(Buffer.from(PHOENIX_KEY))).toBe(false);

    // Text this time, and both are there already.
    const again = await shadowlap(db, ['import', 'phoenix', '--since', '2026-10-22T00:00Z', '--until', '2026-10-23', '--project', 'support-agent', '--host', host], { PHOENIX_API_KEY: PHOENIX_KEY });
    expect(again.code, again.err).toBe(0);
    expect(again.out).toMatch(new RegExp(`^2 traces in Phoenix project support-agent on ${new URL(host).host.replace(/\./g, '\\.')} that started from 2026-10-22 00:00 UTC to 2026-10-23 00:00 UTC:\n`));
    expect(again.out).toContain('Imported 0 of 2 traces: 2 imported before.\n');
    expect(again.out).toContain(`PHOENIX_API_KEY was read from the environment and sent to ${new URL(host).host} only; nothing of it is stored.`);
  });
});

// ---- Logfire ----

const LOGFIRE = fixture<{ data: Array<Record<string, unknown> & { trace_id: string; parent_span_id: string | null; start_timestamp: string; span_name: string }> }>('logfire-records.json').data;

describe('shadowlap import logfire, the traces in a window', () => {
  it('asks for the root spans in the window with one query, and reads each trace from just before it started', async () => {
    const db = freshDb();
    const bodies: Array<{ sql: string; min_timestamp: string; max_timestamp?: string; limit: number }> = [];
    handle = (req, url, body) => {
      if (req.headers.authorization !== LOGFIRE_TOKEN) return { status: 401, body: { detail: 'Invalid read token' } };
      if (url.pathname !== '/v2/query' || req.method !== 'POST') return { status: 404, body: { detail: 'Not Found' } };
      const q = JSON.parse(body) as (typeof bodies)[number];
      bodies.push(q);
      if (q.sql.includes('GROUP BY trace_id')) {
        // The agent's root span under a name with a quote in it, as the query compares it.
        const named = /span_name = '((?:[^']|'')*)'/.exec(q.sql)?.[1]?.replace(/''/g, "'");
        const roots = LOGFIRE.filter((r) => r.parent_span_id === null).map((r) => ({ trace_id: r.trace_id, started: r.start_timestamp, name: `${r.span_name}'s` }));
        return { status: 200, body: { schema: { fields: [] }, data: roots.filter((x) => named === undefined || x.name === named).sort((a, b) => b.started.localeCompare(a.started)) } };
      }
      const id = /trace_id = '([0-9a-f]{32})'/.exec(q.sql)?.[1];
      return { status: 200, body: { schema: { fields: [] }, data: LOGFIRE.filter((r) => r.trace_id === id) } };
    };
    const r = await shadowlap(db, ['import', 'logfire', '--since', '2026-10-22', '--until', '2026-10-23', '--trace-name', "support-agent's", '--host', host], { LOGFIRE_READ_TOKEN: LOGFIRE_TOKEN });
    expect(r.code, r.err).toBe(0);
    expect(r.out.split('\n').slice(0, 4)).toEqual([
      `2 traces named "support-agent's" in Logfire on ${new URL(host).host} that started from 2026-10-22 00:00 UTC to 2026-10-23 00:00 UTC:`,
      expect.stringMatching(/^ {2}01a16460e2f31134 {2}imported as \w{10}: 3 model calls and 2 tool results$/),
      expect.stringMatching(/^ {2}01a16458\w{8} {2}imported as \w{10}: \d+ model calls?( and \d+ tool results?)?$/),
      'Imported 2 of 2 traces.',
    ]);
    expect(bodies[0]).toEqual({
      sql: "SELECT trace_id, MIN(start_timestamp) AS started, MIN(span_name) AS name FROM records WHERE parent_span_id IS NULL AND kind = 'span' AND span_name = 'support-agent''s' GROUP BY trace_id ORDER BY started DESC",
      min_timestamp: '2026-10-22T00:00:00.000Z',
      max_timestamp: '2026-10-23T00:00:00.000Z',
      limit: 100,
    });
    // Each trace's spans from a minute before its root started, not from the window's start.
    expect(bodies.slice(1).map((b) => b.min_timestamp)).toEqual(['2026-10-22T16:09:33.587Z', '2026-10-22T16:00:00.185Z']);
    expect(importedKeys(db).map((x) => x.from).sort()).toEqual(['logfire:01a16458', 'logfire:01a16460']);
  });
});

describe('the window of an import', () => {
  it('says --since leaves no time before now, without naming an --until that was never given', () => {
    // --since 0h is now: with no --until, the window ends now too, in the same millisecond.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-24T12:00:00Z'));
    try {
      expect(() => windowOf('langfuse', undefined, { since: '0h' })).toThrow(/^--since: "0h" is not a moment in the past$/);
      expect(() => windowOf('langfuse', undefined, { since: '2026-10-24T12:00:00Z' })).toThrow(/^--since: "2026-10-24T12:00:00Z" is not a moment in the past$/);
      // Given, --until is named as before.
      expect(() => windowOf('langfuse', undefined, { since: '2026-10-05', until: '2026-10-01' })).toThrow(/^--until: "2026-10-01" is not after --since \(2026-10-05 00:00 UTC\)$/);
      expect(windowOf('langfuse', undefined, { since: '1h' })).toMatchObject({ since: new Date('2026-10-24T11:00:00Z'), until: new Date('2026-10-24T12:00:00Z') });
    } finally {
      vi.useRealTimers();
    }
  });
});
