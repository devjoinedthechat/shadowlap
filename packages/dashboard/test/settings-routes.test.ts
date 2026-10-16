import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NO_COMMAND, Store, storeApiRequest, type CallMeta, type RunMeta } from '@shadowlap/engine';
import { cliSpawner, startDashboard, type Dashboard, type JobView } from '../src/index.js';
import { PREVIEW_LIMITS } from '../src/redaction-preview.js';

/**
 * Settings over HTTP: each tab's read, the edits to shadowlap.config.json (checked as the CLI checks
 * them, refused when the file changed on disk since the page read it, logged in the activity feed),
 * the in-process redaction preview, and the calibrate and gc jobs, run against a stand-in CLI.
 */
const FAKE = fileURLToPath(new URL('./fake-settings-cli.mjs', import.meta.url));

let project: string;
let dbPath: string;
let store: Store;
let dash: Dashboard;
const env = { ...process.env };

beforeAll(() => {
  // The projects list (setup runs) and who made an edit, without the machine's own.
  process.env.SHADOWLAP_HOME = mkdtempSync(join(tmpdir(), 'sl-settings-home-'));
  process.env.SHADOWLAP_AUTHOR = 'dana@example.com';
});
afterAll(() => {
  rmSync(process.env.SHADOWLAP_HOME!, { recursive: true, force: true });
  process.env = env;
});

beforeEach(async () => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-settings-routes-')));
  mkdirSync(join(project, '.shadowlap'));
  dbPath = join(project, '.shadowlap', 'shadowlap.db');
  store = Store.open(dbPath);
  dash = await startDashboard({ store, dbPath, spawnCli: cliSpawner({ command: [process.execPath, FAKE], dbPath, cwd: project }), project: { path: project } });
});
afterEach(async () => {
  await dash.close();
  store.close();
  rmSync(project, { recursive: true, force: true });
});

const api = (path: string, init: RequestInit = {}, d: Dashboard = dash) =>
  fetch(`${d.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': d.token, ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}) } });
const send = (method: string, path: string, body: unknown, d?: Dashboard) => api(path, { method, body: JSON.stringify(body) }, d);
const get = async <T = Record<string, unknown>>(path: string): Promise<T> => {
  const res = await api(path);
  expect(res.status, `${path}: ${res.status}`).toBe(200);
  return (await res.json()) as T;
};
const error = async (res: Response) => ((await res.json()) as { error: string }).error;
const config = () => JSON.parse(readFileSync(join(project, 'shadowlap.config.json'), 'utf8')) as Record<string, unknown>;
const version = async () => (await get<{ config: { version: string } }>('settings/matching')).config.version;

async function waitJob(id: string): Promise<JobView> {
  for (let i = 0; i < 400; i++) {
    const view = (await (await api(`jobs/${id}`)).json()) as JobView;
    if (view.done) return view;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`job ${id} did not finish`);
}

async function job(body: Record<string, unknown>): Promise<Response> {
  return send('POST', 'jobs', body);
}

function recording(o: { argv?: string[]; mode?: 'record' | 'replay'; parent?: string; ended?: boolean; meta?: RunMeta } = {}) {
  const run = store.createRun({ mode: o.mode ?? 'record', ...(o.parent ? { parentRunId: o.parent } : {}), command: { argv: o.argv ?? ['node', 'agent.mjs'], cwd: project }, ...(o.meta ? { meta: o.meta } : {}) });
  if (o.ended !== false) store.endRun(run.runId, 'completed');
  return run;
}

/** A model call whose request says who the customer is, by email and in a field a path rule names. */
function modelCall(runId: string, callNo: number, email: string) {
  const body = { model: 'claude-sonnet-4-5', metadata: { user_id: `u-${callNo}` }, messages: [{ role: 'user', content: `Refund for ${email}` }] };
  const id = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: `m${callNo}`.padEnd(64, '0'), occurrence: 1 };
  const meta: CallMeta = {};
  store.appendCallStart({ runId, callNo, ...id, origin: 'live', effect: null, requestRef: storeApiRequest(store, body), meta, at: callNo });
  store.appendCallEnd(id, { runId, callNo, attempt: 0, responseRef: store.putBlob(Buffer.from(JSON.stringify({ content: [{ type: 'text', text: `Refunded ${email}` }] }))), outcome: 'ok', meta: {}, at: callNo + 1 });
}

describe('reading the tabs', () => {
  it('serves every tab for a project with no runs and no config', async () => {
    const m = await get<{ rules: unknown[]; calibrate: { label: string; argv: null }; config: { exists: boolean; version: string } }>('settings/matching');
    expect(m.rules).toEqual([]);
    expect(m.calibrate).toMatchObject({ label: 'Record a run first', argv: null });
    expect(m.config).toMatchObject({ exists: false, version: 'absent' });
    expect(await get('settings/redaction')).toMatchObject({ rules: [], runs: [], previewRunId: null, previewError: 'Record a run first: the preview needs one to read.' });
    expect(await get('settings/agents')).toMatchObject({ files: expect.arrayContaining([expect.objectContaining({ path: 'CLAUDE.md', found: false })]) });
    expect(await get('settings/tools')).toMatchObject({ live: [], fenced: [], http: [] });
    expect(await get('settings/project')).toMatchObject({ name: project.split(/[\\/]/).pop(), runs: 0, attempts: 0, store: { path: dbPath }, cleanup: { olderThanDays: 30 } });
    expect(await get('settings/store')).toMatchObject({ configured: null, status: null, ciStep: null, error: null });
    // The CI tab reads the tests feature's endpoint; Settings serves nothing of its own for it.
    expect((await api('settings/ci')).status).toBe(404);
  });

  it('sends the team store, its CI step, and why a store that is not a URL cannot be used', async () => {
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ store: 's3://northwind-agent-runs/support-agent?region=eu-central-1', ciPush: false }));
    const s = await get<{ configured: string; status: { bucket: string; region: string; ciPush: boolean; inStore: number }; ciStep: { file: string; text: string } }>('settings/store');
    expect(s.configured).toBe('s3://northwind-agent-runs/support-agent?region=eu-central-1');
    expect(s.status).toMatchObject({ bucket: 'northwind-agent-runs', region: 'eu-central-1', ciPush: false, inStore: 0 });
    expect(s.ciStep.file).toMatch(/^\.github\/workflows\//);
    expect(s.ciStep.text).toContain('npx shadowlap test goldens/* --push');
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ store: 'ftp://nope' }));
    expect(await get('settings/store')).toMatchObject({ configured: 'ftp://nope', status: null, error: expect.stringMatching(/names a store that can't be used/) });
  });

  it("gives the shadowlap mcp line for a server, with credentials hidden, and refuses what isn't one", async () => {
    const byUrl = await get<{ line: string; entry: { command: string; args: string[] } }>(`settings/tools/mcp?url=${encodeURIComponent('https://mcp.linear.app/mcp')}`);
    expect(byUrl.line).toBe('shadowlap mcp --url https://mcp.linear.app/mcp');
    expect(byUrl.entry).toEqual({ command: 'shadowlap', args: ['mcp', '--url', 'https://mcp.linear.app/mcp'] });
    const byCommand = await get<{ line: string; hidden: boolean; copy: { command: string; args: string[] } }>(`settings/tools/mcp?command=${encodeURIComponent('npx -y @modelcontextprotocol/server-github --token ghp_abcdef1234567890')}`);
    expect(byCommand.line).toBe('shadowlap mcp -- npx -y @modelcontextprotocol/server-github --token •••');
    expect(byCommand.hidden).toBe(true);
    // What Copy the entry copies is what was typed: the person typed the token in it.
    expect(byCommand.copy).toEqual({ command: 'shadowlap', args: ['mcp', '--', 'npx', '-y', '@modelcontextprotocol/server-github', '--token', 'ghp_abcdef1234567890'] });
    const proxied = await get<{ copy: { command: string; args: string[] } }>(`settings/tools/mcp?command=${encodeURIComponent('shadowlap mcp --url https://mcp.stripe.com')}`);
    expect(proxied.copy).toEqual({ command: 'shadowlap', args: ['mcp', '--url', 'https://mcp.stripe.com'] });
    const bad = await api(`settings/tools/mcp?url=${encodeURIComponent('mcp.example.com')}`);
    expect(bad.status).toBe(400);
    expect(await error(bad)).toMatch(/starts with http/);
  });
});

describe('editing shadowlap.config.json', () => {
  it('adds and removes rules as the CLI does, logs each edit, and refuses an edit based on an old version', async () => {
    const add = await send('POST', 'settings/rules/normalize', { rule: { kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' }, expect: 'absent' });
    expect(add.status).toBe(200);
    const added = (await add.json()) as { n: number; added: boolean; version: string };
    expect(added).toMatchObject({ n: 1, added: true });
    expect(config()).toEqual({ normalize: [{ kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' }] });

    // A page that read the file before that edit can't change it: it reloads and tries again.
    const stale = await send('POST', 'settings/rules/redact', { rule: { pattern: 'email', replace: '<EMAIL>' }, expect: 'absent' });
    expect(stale.status).toBe(409);
    expect(await error(stale)).toMatch(/changed since it was read/);

    // A rule the CLI would refuse is refused in the CLI's words; so is an edit that names no version.
    const empty = await send('POST', 'settings/rules/redact', { rule: { pattern: '/x*/', replace: '<X>' }, expect: added.version });
    expect(empty.status).toBe(400);
    expect(await error(empty)).toMatch(/matches an empty string/);
    expect((await send('POST', 'settings/rules/redact', { rule: { pattern: 'email' } })).status).toBe(400);
    expect((await send('POST', 'settings/rules/other', { rule: { pattern: 'email' }, expect: added.version })).status).toBe(404);

    const redact = await send('POST', 'settings/rules/redact', { rule: { pattern: 'email', replace: '' }, expect: added.version });
    expect(redact.status).toBe(200);
    // A cleared "Replace with" takes the default, as a missing --replace does.
    expect((config().redact as unknown[])[0]).toEqual({ pattern: 'email', replace: '<REDACTED>' });

    const v = await version();
    const rm = await api(`settings/rules/normalize/1?expect=${v}`, { method: 'DELETE' });
    expect(rm.status).toBe(200);
    expect(await rm.json()).toMatchObject({ n: 1, rule: { path: '$.metadata.user_id' } });
    expect(config().normalize).toEqual([]);
    expect((await api(`settings/rules/normalize/1?expect=${v}`, { method: 'DELETE' })).status).toBe(409);
    expect((await api(`settings/rules/redact/5?expect=${await version()}`, { method: 'DELETE' })).status).toBe(400);

    const events = store.listEvents().map((e) => [e.kind, e.ref, e.actor]);
    expect(events).toEqual(
      expect.arrayContaining([
        ['normalizer.added', '$.metadata.user_id', 'dana@example.com'],
        ['redaction.added', '<REDACTED>', 'dana@example.com'],
        ['normalizer.removed', '$.metadata.user_id', 'dana@example.com'],
      ]),
    );
    // A redaction rule's pattern can hold the very text it hides: never in the activity log.
    expect(store.listEvents().find((e) => e.kind === 'redaction.added')?.data).toEqual({ replace: '<REDACTED>' });
  });

  it('sets the clock and Push from CI, keeping the rest of the file as it was', async () => {
    writeFileSync(join(project, 'shadowlap.config.json'), '{\n    "store": "s3://b/f",\n    "normalize": []\n}\n');
    const clock = await send('PUT', 'settings/clock', { mode: 'exact', expect: await version() });
    expect(await clock.json()).toMatchObject({ clock: 'exact', changed: true });
    expect((await send('PUT', 'settings/clock', { mode: 'sometimes', expect: await version() })).status).toBe(400);
    const push = await send('PUT', 'settings/store/ci-push', { on: false, expect: await version() });
    expect(await push.json()).toMatchObject({ ciPush: false, previous: true, changed: true });
    expect(readFileSync(join(project, 'shadowlap.config.json'), 'utf8')).toBe('{\n    "store": "s3://b/f",\n    "normalize": [],\n    "clock": "exact",\n    "ciPush": false\n}\n');
    expect((await send('PUT', 'settings/store/ci-push', { on: 'no', expect: await version() })).status).toBe(400);
    expect(store.listEvents().map((e) => [e.kind, e.ref, e.data])).toEqual(
      expect.arrayContaining([
        ['clock.set', 'exact', { clock: 'exact', was: null }],
        ['store.ci', 's3://b/f', { push: false, previous: true }],
      ]),
    );
  });

  it('says why a config that is not JSON cannot be edited', async () => {
    writeFileSync(join(project, 'shadowlap.config.json'), '{ "normalize": [ }');
    const m = await get<{ config: { error: string; version: null } }>('settings/matching');
    expect(m.config.error).toMatch(/not valid JSON/);
    const res = await send('PUT', 'settings/clock', { mode: 'exact', expect: 'absent' });
    expect(res.status).toBe(422);
    expect(await error(res)).toMatch(/not valid JSON/);
  });

  it('refuses every edit on a read-only dashboard', async () => {
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ normalize: [{ pattern: 'uuid', replace: '<UUID>' }], store: 's3://b/f' }));
    const before = readFileSync(join(project, 'shadowlap.config.json'), 'utf8');
    const ro = await startDashboard({ store, dbPath, readOnly: true, project: { path: project } });
    try {
      const v = (await get<{ config: { version: string } }>('settings/matching')).config.version;
      const edits = [
        await send('POST', 'settings/rules/normalize', { rule: { pattern: 'uuid' }, expect: v }, ro),
        await api(`settings/rules/normalize/1?expect=${v}`, { method: 'DELETE' }, ro),
        await send('PUT', 'settings/clock', { mode: 'exact', expect: v }, ro),
        await send('PUT', 'settings/store/ci-push', { on: false, expect: v }, ro),
        await send('POST', 'settings/calibrate/write', { jobId: 'any' }, ro),
        await send('POST', 'jobs', { kind: 'calibrate' }, ro),
        await send('POST', 'jobs', { kind: 'gc' }, ro),
      ];
      expect(edits.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 403, 403]);
      expect(readFileSync(join(project, 'shadowlap.config.json'), 'utf8')).toBe(before);
      expect(store.listEvents()).toEqual([]);
      // Reading stays open: every tab, and the preview.
      for (const tab of ['matching', 'redaction', 'agents', 'tools', 'project', 'store']) expect((await api(`settings/${tab}`, {}, ro)).status, tab).toBe(200);
    } finally {
      await ro.close();
    }
  });
});

describe('the redaction preview', () => {
  it('counts what each rule would mask in a run, path rules included, and says why a rule masks nothing', async () => {
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ redact: [{ pattern: 'email', replace: '<EMAIL>' }, { kind: 'api', path: '$.metadata.user_id', replace: '<USER>' }, { kind: 'tool', path: '$.args.card', replace: '<CARD>' }] }));
    const run = recording();
    modelCall(run.runId, 1, 'c-311@example.com');
    modelCall(run.runId, 2, 'c-312@example.com');
    const v = await get<{ run: { runId: string; label: string }; preview: { total: number; rules: Array<{ n: number; count: number; samples: unknown[]; note: string | null; reached: number | null }> }; command: string }>(`settings/redaction/preview?run=${run.runId.slice(0, 12)}`);
    expect(v.run).toEqual({ runId: run.runId, label: `${run.runId.slice(0, 10)} · node agent.mjs` });
    expect(v.command).toBe(`shadowlap redact preview ${run.runId.slice(0, 10)}`);
    const [email, user, card] = v.preview.rules;
    expect(email).toMatchObject({ n: 1, count: 4, reached: null });
    expect(email!.samples).toHaveLength(2);
    expect(user).toMatchObject({ n: 2, count: 2, reached: 2 });
    expect(card).toMatchObject({ n: 3, count: 0, note: 'no tool call in this run' });
    expect(v.preview.total).toBe(6);
  });

  it('says apart what a rule matches that a copy leaves as it is, with the path rule that masks it', async () => {
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ redact: [{ pattern: '/\\b(?:\\d[ -]?){13,16}\\b/', replace: '<CARD>' }] }));
    const run = recording();
    const call = (callNo: number, kind: 'clock' | 'tool', name: string, request: unknown, result: string) => {
      const id = { kind, name, fingerprint: `c${callNo}`.padEnd(64, '0'), occurrence: 1 };
      store.appendCallStart({ runId: run.runId, callNo, ...id, origin: 'live', effect: kind === 'tool' ? 'read' : null, requestRef: store.putJson(request), meta: {}, at: callNo });
      store.appendCallEnd(id, { runId: run.runId, callNo, attempt: 0, responseRef: store.putBlob(Buffer.from(result)), outcome: 'ok', meta: {}, at: callNo });
    };
    // The time the agent read, and a card on file as a number and as text.
    call(1, 'clock', 'now', { label: 'now' }, '{"result":1792155242516}');
    call(2, 'tool', 'lookup_card', { args: { customer: 'C-311' } }, '{"result":{"card":4111111111111111,"on_file":"4111 1111 1111 1111"}}');
    type View = { preview: { total: number; unmasked: number; rules: Array<{ count: number; note: string | null; unmasked: { count: number; samples: Array<{ value: string; kind: string; in: string; path: string }>; remedies: Array<{ command: string }> } }> } };
    // Read on a thread of its own, as every preview from this store is.
    const v = await get<View>(`settings/redaction/preview?run=${run.runId}`);
    expect(v.preview).toMatchObject({ total: 1, unmasked: 2 });
    const [card] = v.preview.rules;
    expect(card).toMatchObject({ count: 1, note: null });
    expect(card!.unmasked.samples.map((s) => [s.value, s.kind, s.in, s.path])).toEqual([
      ['1792155242516', 'clock', 'response', '$.result'],
      ['4111111111111111', 'tool', 'response', '$.result.card'],
    ]);
    expect(card!.unmasked.remedies.map((r) => r.command)).toEqual(["shadowlap redact add --kind tool --name lookup_card --path '$.result.card' --replace '<CARD>'"]);
  });

  it('refuses a run still recording, a run that is not there, and rules that cannot be read', async () => {
    const live = recording({ ended: false });
    const res = await api(`settings/redaction/preview?run=${live.runId}`);
    expect(res.status).toBe(409);
    expect(await error(res)).toMatch(/still recording/);
    expect((await api('settings/redaction/preview?run=01ZZZZZZZZZZZZZZZZZZZZZZZZ')).status).toBe(404);
    expect((await api('settings/redaction/preview')).status).toBe(400);
    const done = recording();
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ redact: [{ pattern: '/(/', replace: '<X>' }] }));
    const broken = await api(`settings/redaction/preview?run=${done.runId}`);
    expect(broken.status).toBe(422);
    expect(await error(broken)).toMatch(/redaction rule #1/);
  });

  // The preview runs on a worker thread, started from the built dashboard (npm run build first).
  describe('read apart, within limits', () => {
    const saved = { ...PREVIEW_LIMITS };
    afterEach(() => void Object.assign(PREVIEW_LIMITS, saved));

    /** A run with a value a pattern like (a+)+$ backtracks on for minutes. */
    function slowRun() {
      writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ redact: [{ pattern: 'email', replace: '<EMAIL>' }, { pattern: '/(a+)+$/', replace: '<A>' }] }));
      const run = recording();
      modelCall(run.runId, 1, `${'a'.repeat(40)}!`);
      return run;
    }

    it('stops a long run at a limit between calls, and says how far it got and which limit', async () => {
      writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ redact: [{ pattern: 'email', replace: '<EMAIL>' }] }));
      const run = recording();
      for (let n = 1; n <= 12; n++) modelCall(run.runId, n, `c-${n}@example.com`);
      type View = { preview: { calls: number; total: number; partial: { read: number; of: number; stopped: string } | null } };
      expect((await get<View>(`settings/redaction/preview?run=${run.runId}`)).preview).toMatchObject({ calls: 12, partial: null, total: 24 });
      PREVIEW_LIMITS.maxCalls = 5;
      expect((await get<View>(`settings/redaction/preview?run=${run.runId}`)).preview).toMatchObject({ calls: 5, partial: { read: 5, of: 12, stopped: 'calls' }, total: 10 });
      PREVIEW_LIMITS.maxCalls = 2000;
      PREVIEW_LIMITS.maxBytes = 1;
      expect((await get<View>(`settings/redaction/preview?run=${run.runId}`)).preview).toMatchObject({ calls: 1, partial: { read: 1, of: 12, stopped: 'bytes' } });
    });

    it('ends a preview whose rule takes too long on one call, naming the rule, and answers everything else meanwhile', async () => {
      const run = slowRun();
      Object.assign(PREVIEW_LIMITS, { softMs: 200, hardMs: 1500 });
      const t0 = Date.now();
      const preview = api(`settings/redaction/preview?run=${run.runId}`);
      await new Promise((r) => setTimeout(r, 300));
      // The server's own thread is free: the status bar's meta answers at once.
      const m0 = Date.now();
      expect((await api('meta')).status).toBe(200);
      expect(Date.now() - m0).toBeLessThan(500);
      const res = await preview;
      expect(res.status).toBe(422);
      expect(await error(res)).toBe('The preview stopped after 2 s on one call. Rule #2, /(a+)+$/, repeats a group that repeats itself, which can take minutes on some text, in a pack too: write it without the outer repeat.');
      expect(Date.now() - t0).toBeLessThan(5000);
    });

    it('says the store is busy while another command holds it, and reads it once it is free', async () => {
      writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ redact: [{ pattern: 'email', replace: '<EMAIL>' }] }));
      const run = recording();
      modelCall(run.runId, 1, 'c-1@example.com');
      PREVIEW_LIMITS.openMs = 300;
      const holder = new DatabaseSync(dbPath);
      holder.exec('BEGIN IMMEDIATE');
      try {
        const res = await api(`settings/redaction/preview?run=${run.runId}`);
        expect(res.status).toBe(503);
        expect(await error(res)).toBe('The store is busy with another command: pick the run again in a moment.');
      } finally {
        holder.exec('ROLLBACK');
        holder.close();
      }
      // Free now: the next preview has the usual time to open it, however busy the machine is.
      PREVIEW_LIMITS.openMs = 15_000;
      expect((await get<{ preview: { total: number } }>(`settings/redaction/preview?run=${run.runId}`)).preview.total).toBe(2);
    });

    it('closes only once a preview thread it ended has let go of the store', async () => {
      // Windows can't delete or move the store's file while a thread holds it open.
      writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ redact: [{ pattern: 'email', replace: '<EMAIL>' }] }));
      const run = recording();
      modelCall(run.runId, 1, 'c-1@example.com');
      PREVIEW_LIMITS.openMs = 300;
      const holder = new DatabaseSync(dbPath);
      holder.exec('BEGIN IMMEDIATE');
      let released = 0;
      const release = () => {
        if (released) return;
        holder.exec('ROLLBACK');
        holder.close();
        released = Date.now();
      };
      // The page has its answer at once; the thread is asked to end, but it waits inside SQLite for the store.
      expect((await api(`settings/redaction/preview?run=${run.runId}`)).status).toBe(503);
      const timer = setTimeout(release, 500);
      try {
        await dash.close();
        expect(released, 'the dashboard closed while a preview thread still held the store').toBeGreaterThan(0);
      } finally {
        clearTimeout(timer);
        release();
      }
    });

    it('stops reading when the page stops waiting, and refuses a preview past the threads it reads on', async () => {
      const run = slowRun();
      Object.assign(PREVIEW_LIMITS, { workers: 1, softMs: 200, hardMs: 20_000 });
      const stop = new AbortController();
      const first = fetch(`${dash.url}/api/settings/redaction/preview?run=${run.runId}`, { headers: { 'x-shadowlap-token': dash.token }, signal: stop.signal }).catch(() => null);
      await new Promise((r) => setTimeout(r, 300));
      // Its one thread is busy: another preview is refused, and the page asks again in a moment.
      const busy = await api(`settings/redaction/preview?run=${run.runId}`);
      expect(busy.status).toBe(503);
      expect(await error(busy)).toMatch(/Other previews are still being read/);
      stop.abort();
      await first;
      // The page stopped waiting, so the thread was ended: the next preview gets it.
      writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ redact: [{ pattern: 'email', replace: '<EMAIL>' }] }));
      let status = 0;
      for (let i = 0; i < 40 && status !== 200; i++) {
        status = (await api(`settings/redaction/preview?run=${run.runId}`)).status;
        if (status !== 200) await new Promise((r) => setTimeout(r, 50));
      }
      expect(status).toBe(200);
    });
  });
});

describe('calibrate', () => {
  it('names its run, streams the rounds, and adds exactly what it proposed', async () => {
    expect((await job({ kind: 'calibrate' })).status).toBe(409);
    const run = recording();
    const started = (await (await job({ kind: 'calibrate' })).json()) as JobView;
    expect(started.args).toEqual(['calibrate', run.runId]);
    expect(started.title).toBe('Calibrating');
    const ended = await waitJob(started.id);
    expect(ended.lines.join('\n')).toMatch(/round 1 {2}diverged at call 1/);
    expect(ended.result).toMatchObject({ normalizers: [expect.objectContaining({ path: '$.metadata.user_id', why: 'this looks like a UUID' }), expect.anything()] });

    const write = await send('POST', 'settings/calibrate/write', { jobId: started.id });
    expect(write.status).toBe(200);
    expect(await write.json()).toMatchObject({ added: [1, 2], already: [] });
    expect(config().normalize).toEqual([
      { kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' },
      { kind: 'tool', name: 'save_report', path: '$.args.path', replace: '<PATH>' },
    ]);
    expect(store.listEvents().map((e) => [e.kind, e.runId, e.data?.via])).toEqual([
      ['normalizer.added', run.runId, 'calibrate'],
      ['normalizer.added', run.runId, 'calibrate'],
    ]);
    // Adding them again changes nothing: they are there already.
    expect(await (await send('POST', 'settings/calibrate/write', { jobId: started.id })).json()).toMatchObject({ added: [], already: [1, 2] });
    expect((await send('POST', 'settings/calibrate/write', { jobId: 'nope' })).status).toBe(404);
  });

  it('takes a run it is given only when it is a finished recording made here, and --write when asked', async () => {
    const rec = recording();
    const replay = recording({ mode: 'replay', parent: rec.runId });
    const live = recording({ ended: false });
    const capture = recording({ argv: [NO_COMMAND] });
    const fromPack = recording({ meta: { imported: { from: 'goldens/refund', at: 1 } } as RunMeta });
    const refusedReplay = await job({ kind: 'calibrate', runId: replay.runId });
    expect(refusedReplay.status).toBe(409);
    expect(await error(refusedReplay)).toBe(`${replay.runId.slice(0, 10)} is a replay; calibrate the recording it came from (${rec.runId.slice(0, 10)})`);
    expect(await error(await job({ kind: 'calibrate', runId: live.runId }))).toMatch(/still recording/);
    expect(await error(await job({ kind: 'calibrate', runId: capture.runId }))).toMatch(/was imported/);
    expect(await error(await job({ kind: 'calibrate', runId: fromPack.runId }))).toMatch(/was imported/);
    expect((await job({ kind: 'calibrate', runId: '01ZZZZZZZZZZZZZZZZZZZZZZZZ' })).status).toBe(404);
    expect((await job({ kind: 'calibrate', runId: rec.runId, write: 'yes' })).status).toBe(400);
    const written = (await (await job({ kind: 'calibrate', runId: rec.runId.slice(0, 10), write: true })).json()) as JobView;
    expect(written.args).toEqual(['calibrate', rec.runId, '--write']);
    await waitJob(written.id);
  });

  it('adds nothing from a job that is not a finished calibration', async () => {
    const run = recording();
    const d2 = await startDashboard({ store, dbPath, spawnCli: cliSpawner({ command: [process.execPath, FAKE], dbPath, cwd: project, env: { ...process.env, FAKE_HOLD_MS: '1500' } }), project: { path: project } });
    try {
      const started = (await (await send('POST', 'jobs', { kind: 'calibrate', runId: run.runId }, d2)).json()) as JobView;
      const early = await send('POST', 'settings/calibrate/write', { jobId: started.id }, d2);
      expect(early.status).toBe(409);
      expect(await error(early)).toBe('the calibration is still running');
      const dry = (await (await send('POST', 'jobs', { kind: 'gc' }, d2)).json()) as JobView;
      const other = await send('POST', 'settings/calibrate/write', { jobId: dry.id }, d2);
      expect(other.status).toBe(400);
      expect(await error(other)).toBe('that job is not a calibration');
      expect((await send('POST', 'settings/calibrate/write', {}, d2)).status).toBe(400);
      expect(store.listEvents()).toEqual([]);
    } finally {
      await d2.close();
    }
  });

  it("adds nothing from a calibration of a run this project's store doesn't have", async () => {
    // As when a drawer stays open across a switch to another project: its run is in the other store.
    const run = recording();
    const started = (await (await job({ kind: 'calibrate' })).json()) as JobView;
    await waitJob(started.id);
    store.deleteRun(run.runId);
    const res = await send('POST', 'settings/calibrate/write', { jobId: started.id });
    expect(res.status).toBe(409);
    expect(await error(res)).toMatch(/replayed a run this project doesn’t have/);
    expect(existsSync(join(project, 'shadowlap.config.json'))).toBe(false);
    expect(store.listEvents()).toEqual([]);
  });

  it('has nothing to add for a recording that replays clean', async () => {
    const run = recording();
    const d2 = await startDashboard({ store, dbPath, spawnCli: cliSpawner({ command: [process.execPath, FAKE], dbPath, cwd: project, env: { ...process.env, FAKE_CLEAN: '1' } }), project: { path: project } });
    try {
      const res = await send('POST', 'jobs', { kind: 'calibrate', runId: run.runId }, d2);
      const started = (await res.json()) as JobView;
      let ended: JobView = started;
      for (let i = 0; i < 400 && !ended.done; i++) {
        await new Promise((r) => setTimeout(r, 25));
        ended = (await (await api(`jobs/${started.id}`, {}, d2)).json()) as JobView;
      }
      expect(ended.lines.join('\n')).toMatch(/Nothing to add/);
      const write = await send('POST', 'settings/calibrate/write', { jobId: started.id }, d2);
      expect(write.status).toBe(409);
      expect(await error(write)).toMatch(/proposed nothing/);
    } finally {
      await d2.close();
    }
  });
});

describe('clean up old runs', () => {
  it('runs the dry run first, then deletes exactly the runs it listed', async () => {
    const dry = (await (await job({ kind: 'gc' })).json()) as JobView;
    expect(dry.args).toEqual(['gc', '--older-than', '30', '--dry-run']);
    expect(dry.title).toBe('Cleaning up');
    const ended = await waitJob(dry.id);
    expect(ended.result).toMatchObject({ dryRun: true, count: 2, expect: '2-0123456789abcdef' });
    const confirm = (await (await job({ kind: 'gc', confirm: dry.id })).json()) as JobView;
    expect(confirm.args).toEqual(['gc', '--before', '1757000000000', '--expect', '2-0123456789abcdef']);
    const deleted = await waitJob(confirm.id);
    expect(deleted.result).toMatchObject({ dryRun: false, count: 2 });
    // Only a finished dry run of this dashboard can be confirmed.
    expect((await job({ kind: 'gc', confirm: confirm.id })).status).toBe(409);
    expect((await job({ kind: 'gc', confirm: 'gone' })).status).toBe(409);
    expect((await job({ kind: 'gc', olderThanDays: 0 })).status).toBe(400);
    expect(((await (await job({ kind: 'gc', olderThanDays: 90 })).json()) as JobView).args).toEqual(['gc', '--older-than', '90', '--dry-run']);
  });

  it('has nothing to confirm from a dry run that names neither a cutoff nor runs to keep', async () => {
    const d2 = await startDashboard({ store, dbPath, spawnCli: cliSpawner({ command: [process.execPath, FAKE], dbPath, cwd: project, env: { ...process.env, FAKE_GC_NO_CUTOFF: '1' } }), project: { path: project } });
    try {
      const dry = (await (await send('POST', 'jobs', { kind: 'gc' }, d2)).json()) as JobView;
      for (let i = 0; i < 400; i++) {
        const v = (await (await api(`jobs/${dry.id}`, {}, d2)).json()) as JobView;
        if (v.done) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const res = await send('POST', 'jobs', { kind: 'gc', confirm: dry.id }, d2);
      expect(res.status).toBe(409);
      expect(await error(res)).toMatch(/the dry run picked no runs/);
    } finally {
      await d2.close();
    }
  });

  /** A dry run of a dashboard whose gc reports what `env` says, and what confirming it answers. */
  async function confirmAfter(env: Record<string, string>): Promise<{ status: number; body: { args?: string[]; error?: string } }> {
    const d2 = await startDashboard({ store, dbPath, spawnCli: cliSpawner({ command: [process.execPath, FAKE], dbPath, cwd: project, env: { ...process.env, ...env } }), project: { path: project } });
    try {
      const dry = (await (await send('POST', 'jobs', { kind: 'gc' }, d2)).json()) as JobView;
      for (let i = 0; i < 400; i++) {
        const v = (await (await api(`jobs/${dry.id}`, {}, d2)).json()) as JobView;
        if (v.done) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const res = await send('POST', 'jobs', { kind: 'gc', confirm: dry.id }, d2);
      return { status: res.status, body: (await res.json()) as { args?: string[]; error?: string } };
    } finally {
      await d2.close();
    }
  }

  it('gives back what deleted runs left when the dry run found no runs old enough, with a plain gc that deletes none', async () => {
    // Blobs nothing uses: a plain gc removes them and compacts the store.
    expect(await confirmAfter({ FAKE_GC_COUNT: '0' })).toMatchObject({ status: 202, body: { args: ['gc'] } });
    // Only unused space, past 1 MB: the same.
    expect(await confirmAfter({ FAKE_GC_COUNT: '0', FAKE_GC_BYTES: '0', FAKE_GC_FREE: String(5 * 1024 * 1024) })).toMatchObject({ status: 202, body: { args: ['gc'] } });
  });

  it('has nothing to confirm when the dry run found nothing to delete or give back, or while a run records', async () => {
    const none = await confirmAfter({ FAKE_GC_COUNT: '0', FAKE_GC_BYTES: '0', FAKE_GC_FREE: '4096' });
    expect(none.status).toBe(409);
    expect(none.body.error).toMatch(/nothing to delete or give back/);
    const recording = await confirmAfter({ FAKE_GC_COUNT: '0', FAKE_GC_RECORDING: '1' });
    expect(recording.status).toBe(409);
    expect(recording.body.error).toMatch(/a run is recording/);
  });
});
