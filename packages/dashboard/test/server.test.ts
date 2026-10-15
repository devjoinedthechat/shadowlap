import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NO_COMMAND, Store, storeApiRequest, unpackRun } from '@shadowlap/engine';
import { applyDeltas, startDashboard, type Dashboard } from '../src/index.js';

const GOLDEN = fileURLToPath(new URL('../../../testing/golden/reference-agent', import.meta.url));

let store: Store;
let dash: Dashboard;
let runId: string;
let uiDir: string;
const spawned: string[][] = [];

/** Raw request, so the Host header can be set (fetch does not allow it). */
function raw(path: string, headers: Record<string, string>, method = 'GET'): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  const u = new URL(dash.url);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path, method, headers }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}
const api = (path: string, init: RequestInit = {}) => fetch(`${dash.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': dash.token, 'content-type': 'application/json', ...(init.headers as Record<string, string>) } });

beforeAll(async () => {
  store = Store.open(':memory:');
  runId = unpackRun(store, GOLDEN).imported[0]!;
  uiDir = mkdtempSync(join(tmpdir(), 'fp-dash-ui-'));
  writeFileSync(join(uiDir, 'index.html'), '<!doctype html><title>Shadowlap</title><script type="module" src="/assets/app.js"></script>');
  // What a downloaded run inlines.
  mkdirSync(join(uiDir, 'assets'));
  writeFileSync(join(uiDir, 'assets', 'app.css'), 'body{}');
  writeFileSync(join(uiDir, 'assets', 'app.js'), 'void 0;');
  writeFileSync(join(uiDir, 'assets', 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  dash = await startDashboard({
    store,
    uiDir,
    version: '0.1.0',
    dbPath: ':memory:',
    spawnCli: (args) => {
      spawned.push(args);
      // Stands in for the CLI: prints the new run's id the way `shadowlap replay` does.
      return spawn(process.execPath, ['-e', 'process.stderr.write("[shadowlap] replaying run 01K5CQ4P2R0000000000000000\\n"); console.log("✓ Replay clean")'], { stdio: ['ignore', 'pipe', 'pipe'] });
    },
  });
});
afterAll(async () => {
  await dash.close();
  store.close();
  rmSync(uiDir, { recursive: true, force: true });
});

describe('dashboard server: the security boundary', () => {
  it('binds to loopback and puts the token in the URL fragment', () => {
    expect(dash.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(dash.openUrl).toBe(`${dash.url}/#token=${dash.token}`);
    expect(dash.token.length).toBeGreaterThanOrEqual(32);
  });

  it('answers only requests addressed to localhost (DNS rebinding)', async () => {
    const port = new URL(dash.url).port;
    expect((await raw('/api/runs', { host: `evil.example:${port}`, 'x-shadowlap-token': dash.token })).status).toBe(403);
    expect((await raw('/', { host: `attacker.test:${port}` })).status).toBe(403);
    expect((await raw('/api/runs', { host: `localhost:${port}`, 'x-shadowlap-token': dash.token })).status).toBe(200);
  });

  it('serves no data without the session token', async () => {
    expect((await fetch(`${dash.url}/api/runs`)).status).toBe(401);
    expect((await fetch(`${dash.url}/api/runs`, { headers: { 'x-shadowlap-token': 'x'.repeat(dash.token.length) } })).status).toBe(401);
    expect((await fetch(`${dash.url}/api/runs/${runId}/calls/3`)).status).toBe(401);
  });

  it('refuses cross-origin writes even with the token', async () => {
    const r = await api(`runs/${runId}/actions`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: JSON.stringify({ key: 'r' }) });
    expect(r.status).toBe(403);
  });

  it('serves the app with a strict CSP and never files outside it', async () => {
    const page = await fetch(`${dash.url}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(await (await fetch(`${dash.url}/run/${runId}`)).text()).toContain('<title>Shadowlap</title>'); // client routes load the app
    const port = new URL(dash.url).port;
    expect((await raw('/%2e%2e/%2e%2e/package.json', { host: `127.0.0.1:${port}` })).status).toBe(404);
    expect((await raw('/..%2f..%2fpackage.json', { host: `127.0.0.1:${port}` })).status).toBe(404);
  });
});

describe('dashboard server: data', () => {
  it('lists runs with labels, calls and cost, and supports ETags', async () => {
    const r = await api('runs');
    expect(r.status).toBe(200);
    const { runs } = (await r.json()) as { runs: Array<{ runId: string; label: string; calls: number; spent: number; captured: number; imported: boolean; source: string | null; depth: number }> };
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runId, label: 'recording', calls: 30, depth: 0 });
    // The run was unpacked from a golden someone else recorded: its cost was paid where it was
    // recorded, so it is captured here, not spent, and it is marked as imported.
    expect(runs[0]!.spent).toBe(0);
    expect(runs[0]!.captured).toBeGreaterThan(0);
    expect(runs[0]!.imported).toBe(true);
    // A pack carries its command, so the list shows the command rather than where it came from.
    expect(runs[0]!.source).toBeNull();
    const again = await api('runs', { headers: { 'if-none-match': r.headers.get('etag')! } });
    expect(again.status).toBe(304);
  });

  it('returns a run with its summary and one row per call', async () => {
    const d = (await (await api(`runs/${runId}`)).json()) as { label: string; summary: { total: number; cost: { spent: number } }; calls: Array<{ callNo: number; kind: string; model: string | null; stopReason: string | null; detail: string; usage: unknown; cost: number | null }> };
    expect(d.summary.total).toBe(30);
    expect(d.calls).toHaveLength(30);
    const api3 = d.calls.find((c) => c.callNo === 3)!;
    expect(api3).toMatchObject({ kind: 'api', model: 'opus-5', stopReason: 'tool_use' });
    expect(api3.cost).toBeGreaterThan(0);
    const tool = d.calls.find((c) => c.kind === 'tool')!;
    expect(tool.detail).toMatch(/^\{"query":/);
    expect((await api('runs/01NOPE0000000000000000000')).status).toBe(404);
  });

  it('returns a model call with its conversation, request, and a playable response', async () => {
    const d = (await (await api(`runs/${runId}/calls/3`)).json()) as {
      conversation: { fromCallNo: number; model: string; tools: string[]; turns: Array<{ role: string; blocks: Array<{ type: string; text?: string }> }> };
      response: { kind: string; blocks: Array<{ type: string; name?: string; input?: unknown }>; stopReason: string; deltas: Parameters<typeof applyDeltas>[0]; events: number };
      actions: Array<{ key: string; prompt: unknown }>;
    };
    expect(d.conversation.fromCallNo).toBe(3);
    expect(d.conversation.model).toBe('claude-opus-5');
    expect(d.conversation.tools).toEqual(['search_web', 'read_file', 'fetch_page', 'send_email']);
    expect(d.conversation.turns[0]).toMatchObject({ role: 'system' });
    expect(d.conversation.turns[1]!.role).toBe('user');
    expect(d.response.kind).toBe('sse');
    expect(d.response.stopReason).toBe('tool_use');
    expect(d.response.blocks.map((b) => b.type)).toEqual(['text', 'tool_call', 'tool_call']);
    expect(d.response.blocks[1]).toMatchObject({ name: 'search_web', input: { query: 'shadowlap replay' } });
    expect(d.response.events).toBeGreaterThan(5);
    expect(applyDeltas(d.response.deltas)).toEqual({ blocks: d.response.blocks, stopReason: 'tool_use' });
    expect(d.actions.map((a) => a.key)).toEqual(expect.arrayContaining(['r', 's', 'i', 'm', 'a', 'p']));
  });

  it('returns a tool call with its recorded result and the conversation before it', async () => {
    const d = (await (await api(`runs/${runId}/calls/4`)).json()) as { call: { kind: string; name: string }; result: { result?: unknown }; conversation: { fromCallNo: number }; request: { args: unknown } };
    expect(d.call).toMatchObject({ kind: 'tool', name: 'search_web' });
    expect(d.request).toEqual({ args: { query: 'shadowlap replay' } });
    expect(d.result.result).toBeDefined();
    expect(d.conversation.fromCallNo).toBe(3);
  });

  it('gives each call its start, end and time to first token, for the timeline', async () => {
    const detail = (await (await api(`runs/${runId}`)).json()) as { calls: Array<{ kind: string; startedAt: number; endedAt: number | null; ttftMs: number | null }> };
    expect(detail.calls.every((c) => c.startedAt > 0 && c.endedAt !== null && c.endedAt >= c.startedAt)).toBe(true);
    // The golden's model calls were streamed, so they have a first-event time.
    expect(detail.calls.filter((c) => c.kind === 'api').some((c) => c.ttftMs !== null)).toBe(true);
  });

  it('returns the family of a run: its recording, forks, repeated attempts and their checks', async () => {
    const fork = (attempt: number, ok: boolean) => {
      const r = store.createRun({ mode: 'replay', parentRunId: runId, command: { argv: ['node', 'agent.js'], cwd: '.' }, meta: { repeat: { group: 'g', attempt, of: 2 }, checks: [{ ok: true, label: 'a', detail: null }, { ok, label: 'b', detail: ok ? null : 'no' }] } });
      store.setDivergence(r.runId, { type: 'request_changed', callNo: 3, kind: 'api', name: 'POST /v1/messages', replayedBefore: 2 });
      store.endRun(r.runId, 'completed');
      return r.runId;
    };
    const [a, b] = [fork(1, true), fork(2, false)];
    const res = await api(`runs/${b.slice(0, 12)}/lineage`);
    expect(res.status).toBe(200);
    const { nodes } = (await res.json()) as { nodes: Array<{ runId: string; depth: number; divergence: { callNo: number } | null; repeat: { attempt: number } | null; checks: { passed: number; total: number } | null }> };
    expect(nodes[0]).toMatchObject({ runId, depth: 0, divergence: null, repeat: null, checks: null });
    expect(nodes.filter((n) => n.repeat).map((n) => [n.runId, n.depth, n.divergence?.callNo, n.repeat!.attempt, n.checks])).toEqual([
      [a, 1, 3, 1, { passed: 2, total: 2 }],
      [b, 1, 3, 2, { passed: 1, total: 2 }],
    ]);
    expect((await api('runs/01ZZZZZZZZZZZZZZZZZZZZZZZZ/lineage')).status).toBe(404);
    store.deleteRun(a);
    store.deleteRun(b);
  });

  it('adds and removes labels, keeps notes on a call, and searches recorded content', async () => {
    const post = (path: string, body: unknown) => api(path, { method: 'POST', body: JSON.stringify(body) });
    let res = await post(`runs/${runId}/labels`, { add: ['good', 'refund-flow'] });
    expect(await res.json()).toEqual({ labels: ['good', 'refund-flow'] });
    res = await post(`runs/${runId}/labels`, { remove: ['good'] });
    expect(await res.json()).toEqual({ labels: ['refund-flow'] });
    expect((await post(`runs/${runId}/labels`, { add: ['<script>'] })).status).toBe(400);
    const listed = (await (await api('runs')).json()) as { runs: Array<{ runId: string; labels: string[] }> };
    expect(listed.runs.find((r) => r.runId === runId)?.labels).toEqual(['refund-flow']);

    res = await post(`runs/${runId}/notes`, { callNo: 3, text: 'The first plan is too broad.' });
    expect(((await res.json()) as { notes: Array<{ text: string }> }).notes.map((n) => n.text)).toEqual(['The first plan is too broad.']);
    expect((await post(`runs/${runId}/notes`, { callNo: 999, text: 'x' })).status).toBe(404);
    const call3 = (await (await api(`runs/${runId}/calls/3`)).json()) as { notes: Array<{ text: string }> };
    expect(call3.notes.map((n) => n.text)).toEqual(['The first plan is too broad.']);

    const found = (await (await api(`search?q=${encodeURIComponent('config.json')}`)).json()) as { hits: Array<{ runId: string; field: string }> };
    expect(found.hits.some((h) => h.runId === runId && h.field === 'arguments')).toBe(true);
    store.updateRunMeta(runId, { labels: [], notes: [] });
  });

  it('refuses label and note changes from a read-only dashboard', async () => {
    const readOnly = await startDashboard({ store, uiDir, version: '0.1.0', dbPath: ':memory:' });
    try {
      const res = await fetch(`${readOnly.url}/api/runs/${runId}/labels`, { method: 'POST', headers: { 'x-shadowlap-token': readOnly.token, 'content-type': 'application/json' }, body: JSON.stringify({ add: ['bug'] }) });
      expect(res.status).toBe(403);
    } finally {
      await readOnly.close();
    }
  });

  it('downloads a run as one HTML file, with its ancestors, redacted by the project rules', async () => {
    const r = await api(`runs/${runId.slice(0, 10)}/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toBe(`attachment; filename="shadowlap-${runId.slice(0, 10).toLowerCase()}.html"`);
    expect(r.headers.get('x-shadowlap-redacted')).toBe('no');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const html = await r.text();
    expect(html).toContain(`"runIds":["${runId}"]`);
    expect(html).toContain("default-src 'none'"); // the file cannot load anything from anywhere
    expect(html).toContain('search_web');
    expect((await api('runs/01ZZZZZZZZZZZZZZZZZZZZZZZZ/export')).status).toBe(404);
    expect((await fetch(`${dash.url}/api/runs/${runId}/export`)).status).toBe(401);

    // With redaction rules, and from a read-only dashboard: downloading is a read.
    const redacting = await startDashboard({ store, uiDir, version: '0.1.0', dbPath: ':memory:', redact: [{ kind: 'tool', path: '$.query', replace: '<QUERY>' }] });
    try {
      const res = await fetch(`${redacting.url}/api/runs/${runId}/export`, { headers: { 'x-shadowlap-token': redacting.token } });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-shadowlap-redacted')).toBe('yes');
      const redacted = await res.text();
      expect(redacted).toContain('<QUERY>');
    } finally {
      await redacting.close();
    }
  });

  it('compares runs', async () => {
    const c = (await (await api(`compare?a=${runId}&b=${runId}`)).json()) as { identicalPrefix: number; firstRequestDifference: unknown };
    expect(c).toMatchObject({ identicalPrefix: 30, firstRequestDifference: null });
    expect((await api(`compare?a=${runId}`)).status).toBe(400);
  });

  it('accepts the short run ids the CLI prints', async () => {
    const short = runId.slice(0, 10);
    const run = (await (await api(`runs/${short}`)).json()) as { run: { runId: string } };
    expect(run.run.runId).toBe(runId);
    const call = (await (await api(`runs/${short.toLowerCase()}/calls/3`)).json()) as { call: { callNo: number; kind: string } };
    expect(call.call).toMatchObject({ callNo: 3, kind: 'api' });
    expect(((await (await api(`compare?a=${short}&b=${runId}`)).json()) as { identicalPrefix: number }).identicalPrefix).toBe(30);
    expect((await api('runs/01ZZZZZZZZ')).status).toBe(404);
    expect((await api('runs/01%25')).status).toBe(404);
  });
});

describe('dashboard server: actions', () => {
  it('builds the command line on the server, runs it, and reports the new run', async () => {
    const started = await api(`runs/${runId}/actions`, { method: 'POST', body: JSON.stringify({ key: 'i', callNo: 3, value: 'Prefer sources from 2026.' }) });
    expect(started.status).toBe(202);
    const job = (await started.json()) as { id: string };
    // The golden was imported with unpack, so the replay carries consent explicitly.
    expect(spawned.at(-1)).toEqual(['replay', runId, '--inject', '3=Prefer sources from 2026.', '--inject-as', 'user', '--yes']);
    let view: { done: boolean; code: number | null; newRunId: string | null; lines: string[] } = { done: false, code: null, newRunId: null, lines: [] };
    for (let i = 0; i < 50 && !view.done; i++) {
      await new Promise((r) => setTimeout(r, 50));
      view = (await (await api(`jobs/${job.id}`)).json()) as typeof view;
    }
    expect(view).toMatchObject({ done: true, code: 0, newRunId: '01K5CQ4P2R0000000000000000' });
    expect(view.lines.join('\n')).toContain('Replay clean');
  });

  it('needs an explicit yes to replay a run imported from a pack', async () => {
    const bad = await api(`runs/${runId}/actions`, { method: 'POST', body: JSON.stringify({ key: 'r', value: 'sure' }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/type yes/);
    const ok = await api(`runs/${runId}/actions`, { method: 'POST', body: JSON.stringify({ key: 'r', value: 'yes' }) });
    expect(ok.status).toBe(202);
    expect(spawned.at(-1)).toEqual(['replay', runId, '--yes']);
  });

  it('refuses actions that do not exist here or miss their input', async () => {
    expect((await api(`runs/${runId}/actions`, { method: 'POST', body: JSON.stringify({ key: 'i', callNo: 3 }) })).status).toBe(400);
    expect((await api(`runs/${runId}/actions`, { method: 'POST', body: JSON.stringify({ key: 'o', callNo: 3 }) })).status).toBe(400); // override is for tool calls
    expect((await api(`runs/${runId}/actions`, { method: 'POST', body: JSON.stringify({ key: 'r', callNo: 999 }) })).status).toBe(400);
    expect((await api(`runs/${runId}/actions`, { method: 'POST', body: JSON.stringify({ args: ['rm', '-rf'] }) })).status).toBe(400);
  });

  it('asks a run built from a capture for the agent command, and refuses the forks that need more', async () => {
    const capture = store.createRun({ mode: 'record', command: { argv: [NO_COMMAND], cwd: '.' }, meta: { imported: { at: 1, from: '/tmp/session.har' }, covers: ['api'] } });
    const id = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: 'c'.repeat(64), occurrence: 1 };
    store.appendCallStart({ runId: capture.runId, callNo: 1, ...id, origin: 'live', effect: null, requestRef: storeApiRequest(store, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }), meta: { provider: 'anthropic' }, at: 1 });
    store.appendCallEnd(id, { runId: capture.runId, callNo: 1, attempt: 0, responseRef: null, outcome: 'ok', meta: { status: 200 }, at: 2 });
    store.endRun(capture.runId, 'completed');
    try {
      const { runs } = (await (await api('runs')).json()) as { runs: Array<{ runId: string; source: string | null; imported: boolean }> };
      expect(runs.find((r) => r.runId === capture.runId)).toMatchObject({ source: 'session.har', imported: true });

      const d = (await (await api(`runs/${capture.runId}/calls/1`)).json()) as { actions: Array<{ key: string; label: string; prompt: { label: string } | null; disabled: string | null; group: string | null; hint: string | null }> };
      // A note and one item: the forks wait for a replay with the agent's command.
      expect(d.actions.filter((a) => a.group === 'call')).toEqual([expect.objectContaining({ key: 'r', label: 'Replay it with your command', disabled: null, hint: expect.stringContaining('A capture has no command') })]);

      const post = (body: unknown) => api(`runs/${capture.runId}/actions`, { method: 'POST', body: JSON.stringify(body) });
      expect((await post({ key: 'r', value: 'python agent.py "a b"' })).status).toBe(202);
      // What was typed only ever follows `--`.
      expect(spawned.at(-1)).toEqual(['replay', capture.runId, '--', 'python', 'agent.py', 'a b']);
      const refused = await post({ key: 'i', callNo: 1, value: 'Be brief.' });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toContain('Replay it with yours first');
      const empty = await post({ key: 'r', value: '""' });
      expect(((await empty.json()) as { error: string }).error).toBe('Not run: give the command that starts your agent');
    } finally {
      store.deleteRun(capture.runId);
    }
  });

  it('shows a failure Shadowlap answered with (--fail-at) as injected, not as a live call', async () => {
    const replay = store.createRun({ mode: 'replay', parentRunId: runId, command: { argv: ['node', 'agent.js'], cwd: '.' } });
    const id = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: 'd'.repeat(64), occurrence: 1 };
    store.appendCallStart({ runId: replay.runId, callNo: 1, ...id, origin: 'live', effect: null, requestRef: storeApiRequest(store, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }), meta: { provider: 'anthropic' }, at: 1 });
    store.appendCallEnd(id, { runId: replay.runId, callNo: 1, attempt: 0, responseRef: null, outcome: 'error', meta: { status: 429, injected: true }, at: 2 });
    store.endRun(replay.runId, 'completed');
    try {
      const d = (await (await api(`runs/${replay.runId}`)).json()) as { summary: { injected: number; upstreamRequests: number }; calls: Array<{ origin: string; status: number | null }> };
      expect(d.calls[0]).toMatchObject({ origin: 'injected' });
      expect(d.summary).toMatchObject({ injected: 1, upstreamRequests: 0 });
    } finally {
      store.deleteRun(replay.runId);
    }
  });

  it('deletes a run and its unreferenced blobs', async () => {
    const r = await api(`runs/${runId}`, { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { blobs: number }).blobs).toBeGreaterThan(0);
    expect((await api(`runs/${runId}`)).status).toBe(404);
  });
});
