import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PRICES, NO_COMMAND, Store, checkLabels, packRun, parseExpect, type RunMeta } from '@shadowlap/engine';
import { startDashboard, type Dashboard } from '../src/index.js';
import type { CheckContext, CheckPreview } from '../src/check-preview.js';
import type { ChecksConfig } from '../src/config-tests.js';
import { folderGoneText } from '../src/folder-gone.js';
import type { GoldenSource } from '../src/tests.js';

/**
 * The check builder's routes: the agent's goldens with their tests entries as written, one golden's
 * entry written back (refused when the file changed since the page read it, naming what changed, and
 * in the words `shadowlap test` refuses the file in), and the two pooled reads it builds a check
 * from: what a run's calls offer, and a draft judged on the agent's recordings.
 */

let project: string;
let store: Store;
let dash: Dashboard;
let goldens: GoldenSource[];
const env = { ...process.env };

beforeAll(() => {
  process.env.SHADOWLAP_HOME = mkdtempSync(join(tmpdir(), 'sl-config-tests-home-'));
  process.env.SHADOWLAP_AUTHOR = 'dana@example.com';
});
afterAll(() => {
  rmSync(process.env.SHADOWLAP_HOME!, { recursive: true, force: true });
  process.env = env;
});

beforeEach(async () => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-config-tests-')));
  mkdirSync(join(project, '.shadowlap'));
  const dbPath = join(project, '.shadowlap', 'shadowlap.db');
  store = Store.open(dbPath);
  goldens = [];
  dash = await startDashboard({ store, dbPath, readOnly: false, project: { path: project }, goldens: () => goldens });
});
afterEach(async () => {
  await dash.close();
  store.close();
  rmSync(project, { recursive: true, force: true });
});

const api = (path: string, init: RequestInit = {}) => fetch(`${dash.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': dash.token, ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}) } });
const send = (method: string, path: string, body: unknown) => api(path, { method, body: JSON.stringify(body) });
async function get<T>(path: string): Promise<T> {
  const res = await api(path);
  expect(res.status, `${path}: ${res.status}`).toBe(200);
  return (await res.json()) as T;
}
const error = async (res: Response) => ((await res.json()) as { error: string }).error;
const file = () => readFileSync(join(project, 'shadowlap.config.json'), 'utf8');
const writeConfig = (data: unknown, indent: string | number = 2) => writeFileSync(join(project, 'shadowlap.config.json'), `${JSON.stringify(data, null, indent)}\n`);
const golden = (path: string, runId: string | null, more: Partial<GoldenSource> = {}): GoldenSource => ({ path, runId, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: [], ...more });
const labelsOf = (raw: unknown) => checkLabels(parseExpect(raw, 'expect'));

/** A recording of `argv`: tool calls with their arguments and results, by name, then the agent's last answer. */
function recording(argv: string[], tools: Array<{ name: string; args?: unknown; result?: unknown; origin?: 'live' | 'blocked'; error?: boolean; meta?: Record<string, unknown> }>, o: { at?: number; meta?: RunMeta; status?: 'completed' | 'failed' } = {}): string {
  const run = store.createRun({ mode: 'record', command: { argv, cwd: project }, startedAt: o.at ?? 1000, ...(o.meta ? { meta: o.meta } : {}) });
  tools.forEach((t, i) => {
    const callNo = i + 1;
    const identity = { kind: 'tool' as const, name: t.name, fingerprint: createHash('sha256').update(`${t.name} ${callNo}`).digest('hex'), occurrence: 1 };
    store.appendCallStart({ runId: run.runId, callNo, ...identity, origin: t.origin ?? 'live', effect: t.name.startsWith('lookup') ? 'read' : 'write', requestRef: store.putJson({ args: t.args ?? {} }), meta: t.meta ?? {}, at: (o.at ?? 1000) + callNo });
    store.appendCallEnd(identity, { runId: run.runId, callNo, attempt: 0, responseRef: store.putJson({ result: t.result ?? null }), outcome: t.error || t.origin === 'blocked' ? 'error' : 'ok', meta: {}, at: (o.at ?? 1000) + callNo });
  });
  store.endRun(run.runId, o.status ?? 'completed', (o.at ?? 1000) + 100);
  return run.runId;
}

const REFUND = [
  { name: 'lookup_order', args: { order: 'A-1131' }, result: { total: 240, limit: 200 } },
  { name: 'issue_refund', args: { order: 'A-1131', amount: 240 }, result: { ok: true } },
];
const AGENT = ['node', 'agent.mjs'];

describe('the builder reads the config', () => {
  it('lists the agent’s goldens with their entries as written, the version, the prints and the layout', async () => {
    const rec = recording([...AGENT, 'A-1131'], REFUND);
    const other = recording(['python', 'other_agent.py'], REFUND);
    goldens = [golden('goldens/refund', rec, { judges: ['claude-haiku-4-5'] }), golden('goldens/refund-late', rec), golden('goldens/other', other, { mode: 'fork' })];
    writeConfig({ redact: [{ pattern: 'email', replace: '<EMAIL>' }, { pattern: 'not-a-pattern', replace: '<X>' }], tests: { suiteRisk: 0.05, 'goldens/refund': { fork: false, expect: { tools: { send_email: 0 } } }, 'goldens/refund-*': { fork: true }, 'goldens/other': {} } });
    const read = await get<ChecksConfig>(`checks/goldens?run=${rec}`);
    expect(read).toMatchObject({ exists: true, indent: '  ', order: ['suiteRisk', 'goldens/refund', 'goldens/refund-*', 'goldens/other'], relaid: false, agent: 'node agent.mjs', redactions: 1, judges: ['claude-haiku-4-5'] });
    // Ask a judge…'s models: the docs' example first, the project's judges', then each the engine prices that a judge takes, once each.
    expect(read.models.slice(0, 2)).toEqual(['claude-haiku-4-5', 'claude-fable-5-1']);
    expect(read.models).toHaveLength(Object.keys(DEFAULT_PRICES).length);
    expect(read.models).toContain('gemini-2.5-flash');
    expect(read.version).toMatch(/^[0-9a-f]{64}$/);
    expect(read.goldens.map((g) => [g.path, g.key, g.pattern, g.mode.label, g.inStore])).toEqual([
      ['goldens/refund', 'goldens/refund', false, 'replay', true],
      ['goldens/refund-late', 'goldens/refund-*', true, 'replay', true],
    ]);
    expect(read.goldens[0].entry).toEqual({ fork: false, expect: { tools: { send_email: 0 } } });
    expect(Object.keys(read.read.keys)).toEqual(['redact']);
    expect(Object.keys(read.read.tests)).toEqual(['suiteRisk', 'goldens/refund', 'goldens/refund-*', 'goldens/other']);
    // A golden asked by its path: its agent's goldens, itself first among them as listed.
    expect((await get<ChecksConfig>('checks/goldens?golden=goldens/other')).goldens.map((g) => g.path)).toEqual(['goldens/other']);
  });

  it('says when a write would lay out other lines anew, and that a project with no file has none', async () => {
    const rec = recording(AGENT, REFUND);
    goldens = [golden('goldens/refund', rec)];
    expect(await get<ChecksConfig>(`checks/goldens?run=${rec}`)).toMatchObject({ exists: false, version: 'absent', order: [], relaid: false });
    writeFileSync(join(project, 'shadowlap.config.json'), '{"normalize": [], "tests": {}}\n');
    expect((await get<ChecksConfig>(`checks/goldens?run=${rec}`)).relaid).toBe(true);
  });

  it('answers a missing run, an unknown golden and a file that is no JSON object in words of their own', async () => {
    expect((await api('checks/goldens?run=01K8RG00000000000000000099')).status).toBe(404);
    const res = await api('checks/goldens?golden=goldens/elsewhere');
    expect(res.status).toBe(404);
    expect(await error(res)).toBe('no golden goldens/elsewhere in this project');
    expect((await api('checks/goldens')).status).toBe(400);
    const rec = recording(AGENT, REFUND);
    writeFileSync(join(project, 'shadowlap.config.json'), '{ not json');
    const bad = await api(`checks/goldens?run=${rec}`);
    expect(bad.status).toBe(422);
    expect(await error(bad)).toContain('shadowlap.config.json: not valid JSON');
  });
});

describe('a golden’s entry written back', () => {
  async function read(run: string) {
    return get<ChecksConfig>(`checks/goldens?run=${run}`);
  }

  it('adds an entry where there is none, keeps every other key in its place, and logs what it added', async () => {
    const rec = recording(AGENT, REFUND);
    goldens = [golden('goldens/refund', rec)];
    writeConfig({ normalize: [], tests: { suiteRisk: 0.05 }, prices: {} });
    const { version, read: prints } = await read(rec);
    const check = { tools: { issue_refund: 0 } };
    const res = await send('PUT', 'checks/tests', { golden: 'goldens/refund', version, read: prints, entry: { expect: check } });
    expect(res.status).toBe(200);
    const written = (await res.json()) as { key: string; version: string; added: string[]; removed: string[]; changed: boolean };
    expect(written).toMatchObject({ key: 'goldens/refund', added: labelsOf(check), removed: [], changed: true });
    expect(written.version).not.toBe(version);
    expect(file()).toBe(`${JSON.stringify({ normalize: [], tests: { suiteRisk: 0.05, 'goldens/refund': { expect: check } }, prices: {} }, null, 2)}\n`);
    const feed = (await get<{ items: Array<{ text: string }> }>('activity')).items;
    expect(feed.find((e) => e.text.startsWith('Check added'))?.text).toBe(`Check added · refund: ${labelsOf(check).join('; ')}`);
  });

  it('changes only the checks of an entry, takes them out with null, and writes nothing when nothing changes', async () => {
    const rec = recording(AGENT, REFUND);
    goldens = [golden('goldens/refund', rec)];
    const was = { tools: { send_email: 0 } };
    writeConfig({ tests: { 'goldens/refund': { fork: true, expect: was, repeat: 3 } } });
    let { version, read: prints } = await read(rec);
    const check = { tools: { issue_refund: 0 } };
    const changed = await send('PUT', 'checks/tests', { golden: 'goldens/refund', version, read: prints, entry: { expect: check } });
    expect(await changed.json()).toMatchObject({ added: labelsOf(check), removed: labelsOf(was), changed: true });
    expect(JSON.parse(file())).toEqual({ tests: { 'goldens/refund': { fork: true, expect: check, repeat: 3 } } });
    ({ version, read: prints } = await read(rec));
    const same = await send('PUT', 'checks/tests', { golden: 'goldens/refund', version, read: prints, entry: { expect: check } });
    expect(await same.json()).toMatchObject({ version, added: [], removed: [], changed: false });
    const out = await send('PUT', 'checks/tests', { golden: 'goldens/refund', version, read: prints, entry: { expect: null } });
    expect(await out.json()).toMatchObject({ removed: labelsOf(check), changed: true });
    expect(JSON.parse(file())).toEqual({ tests: { 'goldens/refund': { fork: true, repeat: 3 } } });
    const feed = (await get<{ items: Array<{ text: string }> }>('activity')).items.map((e) => e.text);
    expect(feed.filter((t) => /^Checks? (added|removed|changed)/.test(t))).toEqual([`Check removed · refund: ${labelsOf(check).join('; ')}`, 'Checks changed · refund']);
  });

  it('gives a golden that follows a pattern an entry of its own, with the pattern’s other keys, and leaves the pattern', async () => {
    const rec = recording(AGENT, REFUND);
    goldens = [golden('goldens/refund-late', rec)];
    writeConfig({ tests: { 'goldens/refund-*': { fork: true, repeat: 2, expect: { tools: { send_email: 0 } } } } });
    const { version, read: prints } = await read(rec);
    const check = { tools: { issue_refund: 0 } };
    const res = await send('PUT', 'checks/tests', { golden: 'goldens/refund-late', version, read: prints, entry: { expect: check } });
    expect(await res.json()).toMatchObject({ key: 'goldens/refund-late', removed: labelsOf({ tools: { send_email: 0 } }) });
    expect(JSON.parse(file())).toEqual({ tests: { 'goldens/refund-*': { fork: true, repeat: 2, expect: { tools: { send_email: 0 } } }, 'goldens/refund-late': { fork: true, repeat: 2, expect: check } } });
  });

  it('refuses a file changed since the page read it, naming what changed, and changes nothing', async () => {
    const rec = recording(AGENT, REFUND);
    goldens = [golden('goldens/refund', rec), golden('goldens/other', rec)];
    writeConfig({ normalize: [], tests: { 'goldens/other': {} } });
    const { version, read: prints } = await read(rec);
    writeConfig({ normalize: [], prices: { 'claude-x': { input: 1, output: 2 } }, tests: { 'goldens/other': { fork: true } } });
    const now = file();
    const res = await send('PUT', 'checks/tests', { golden: 'goldens/refund', version, read: prints, entry: { expect: { tools: { issue_refund: 0 } } } });
    expect(res.status).toBe(409);
    expect(await error(res)).toBe('shadowlap.config.json changed on disk since this page read it: "prices" added and tests["goldens/other"] changed. It shows your change against the file as it is now; nothing was changed.');
    expect(file()).toBe(now);
    // Without what it read, the refusal names nothing.
    const bare = await send('PUT', 'checks/tests', { golden: 'goldens/refund', version, entry: { expect: { tools: { issue_refund: 0 } } } });
    expect(await error(bare)).toBe('shadowlap.config.json changed on disk since this page read it. It shows your change against the file as it is now; nothing was changed.');
  });

  it('refuses a check shadowlap test would refuse, in its words, and what isn’t a write of an entry', async () => {
    const rec = recording(AGENT, REFUND);
    goldens = [golden('goldens/refund', rec)];
    const { version, read: prints } = await read(rec);
    const put = (body: Record<string, unknown>) => send('PUT', 'checks/tests', { golden: 'goldens/refund', version, read: prints, ...body });
    const nothing = await put({ entry: { expect: { calls: [{ tool: 'issue_refund' }] } } });
    expect(nothing.status).toBe(400);
    expect(await error(nothing)).toMatch(/^shadowlap\.config\.json: tests\["goldens\/refund"\]\.expect\.calls\[0\] checks nothing: give it "after", "args" or both/);
    const count = await put({ entry: { expect: { tools: { issue_refund: 'often' } } } });
    expect(count.status).toBe(400);
    expect(await error(count)).toBe('shadowlap.config.json: tests["goldens/refund"].expect.tools["issue_refund"] must be a count such as 0, ">= 1", "<= 12" or "2-4"');
    expect(await error(await put({ version: 'v1', entry: { expect: null } }))).toBe('version is the version of shadowlap.config.json the page read: open the check again and try again');
    expect(await error(await put({ entry: { fork: true } }))).toBe('entry sets expect alone, not fork');
    expect(await error(await put({ entry: { expect: [] } }))).toContain('expect is an expect object');
    const unknown = await send('PUT', 'checks/tests', { golden: 'goldens/elsewhere', version, entry: { expect: null } });
    expect(unknown.status).toBe(404);
    expect(existsSync(join(project, 'shadowlap.config.json'))).toBe(false);
  });
});

describe('what a run’s calls offer a check', () => {
  it('lists each tool by its first call, the tools before the call, and the number fields of the results before it', async () => {
    const rec = recording(AGENT, [
      { name: 'lookup_order', args: { order: 'A-1131' }, result: { total: 240, limit: '200', note: 'gold' } },
      { name: 'lookup_policy', result: JSON.stringify({ cap: 150 }) },
      { name: 'ask_customer', result: { amount: 99 }, meta: { input: true } },
      { name: 'lookup_order', args: { order: 'A-1132' }, result: { total: 260 } },
      { name: 'lookup_stock', result: { units: 4, error: 'down' } },
      { name: 'issue_refund', args: { order: 'A-1131', amount: 240 }, result: { refunded: 240 } },
      { name: 'send_email', origin: 'blocked', result: { queued: 1 } },
    ]);
    const ctx = await get<CheckContext>(`checks/context?run=${rec}&at=6`);
    expect(ctx.at).toEqual({ callNo: 6, tool: 'issue_refund', args: { order: 'A-1131', amount: 240 }, effect: 'write' });
    expect(ctx.tools.map((t) => [t.tool, t.callNo])).toEqual([['lookup_order', 1], ['lookup_policy', 2], ['lookup_stock', 5], ['issue_refund', 6], ['send_email', 7]]);
    expect(ctx.before).toEqual(['lookup_order', 'lookup_policy', 'lookup_stock']);
    // The latest of each, a result held as JSON in a string read as it, none from a person's answer, an error or a call blocked.
    expect(ctx.fields).toEqual([
      { tool: 'lookup_order', field: 'total', value: 260, callNo: 4 },
      { tool: 'lookup_order', field: 'limit', value: '200', callNo: 1 },
      { tool: 'lookup_policy', field: 'cap', value: 150, callNo: 2 },
    ]);
    expect(ctx.conds.map((f) => `${f.tool}.${f.field}`)).toEqual(['lookup_order.total', 'lookup_order.limit', 'lookup_policy.cap', 'issue_refund.refunded']);
    expect((await api(`checks/context?run=${rec}&at=0`)).status).toBe(400);
  });
});

describe('a draft judged on the agent’s recordings', () => {
  it('judges the newest finished recordings of the agent alone, as shadowlap check does, with its goldens’ and the run it is made from', async () => {
    const over = [REFUND[0], { name: 'issue_refund', args: { amount: 240 }, result: { ok: true } }];
    const within = [{ name: 'lookup_order', result: { total: 240 } }, { name: 'issue_refund', args: { amount: 120 }, result: { ok: true } }];
    const made = recording(AGENT, over, { at: 5000, meta: { labels: ['refund-bug'] } });
    const runs = [
      recording(AGENT, within, { at: 4000, meta: { labels: ['good'] } }),
      recording(AGENT, over, { at: 3000, meta: { labels: ['good', 'refund-bug'] } }),
      recording(AGENT, over, { at: 2000, meta: { labels: ['good'] } }),
      recording(AGENT, over, { at: 1500, meta: { labels: ['good'] } }),
      recording(AGENT, over, { at: 1200, meta: { labels: ['good'] } }),
    ];
    recording(['python', 'other_agent.py'], over, { at: 4500 });
    const packed = recording(AGENT, within, { at: 900 });
    packRun(store, packed, join(project, 'goldens', 'refund-packed'));
    goldens = [golden('goldens/refund', runs[0]), golden('goldens/refund-packed', '01K8RG00000000000000000077')];
    const check = { calls: [{ tool: 'issue_refund', args: { amount: { '<=': 200 } } }] };
    const res = await send('POST', 'checks/preview', { expect: check, run: made });
    expect(res.status).toBe(200);
    const p = (await res.json()) as CheckPreview;
    expect(p.total).toBe(7);
    expect(p.judged.map((r) => r.runId)).toEqual([made, ...runs, packed]);
    expect(p.counts).toEqual({ passed: 2, failed: 5, inconclusive: 0, notApplicable: 0 });
    expect(p.notes).toEqual([`Fails 4 recordings labelled good: ${runs[1].slice(0, 10)}, ${runs[2].slice(0, 10)}, ${runs[3].slice(0, 10)} and 1 more`]);
    expect(p.tools).toEqual(['lookup_order', 'issue_refund']);
    expect(p.madeFrom).toMatchObject({ runId: made, outcome: 'failed', labels: ['refund-bug'] });
    expect(p.goldens.map((g) => [g.path, g.row?.outcome, g.tools, g.error])).toEqual([
      ['goldens/refund', 'passed', ['lookup_order', 'issue_refund'], null],
      ['goldens/refund-packed', 'passed', ['lookup_order', 'issue_refund'], null],
    ]);
  });

  it('counts a recording no check applied to apart, and refuses a draft the CLI would refuse, in its words', async () => {
    const rec = recording(AGENT, REFUND);
    const when = { if: { tool: 'lookup_order', result: { total: { '>': 1000 } } }, then: { tools: { issue_refund: 0 } } };
    const p = (await (await send('POST', 'checks/preview', { expect: { when: [when] }, run: rec })).json()) as CheckPreview;
    expect(p.counts).toEqual({ passed: 0, failed: 0, inconclusive: 0, notApplicable: 1 });
    expect(p.judged[0].na).toBe(true);
    const bad = await send('POST', 'checks/preview', { expect: { calls: [{ tool: 'issue_refund' }] }, run: rec });
    expect(bad.status).toBe(400);
    expect(await error(bad)).toMatch(/^expect\.calls\[0\] checks nothing/);
    const capture = store.createRun({ mode: 'record', command: { argv: [NO_COMMAND], cwd: project } });
    expect((await send('POST', 'checks/preview', { expect: { tools: { issue_refund: 0 } }, run: capture.runId })).status).toBe(409);
  });
});

describe('a read-only dashboard, and a project folder gone', () => {
  const entry = { expect: { tools: { send_email: 0 } } };
  it('refuses a write with 403 on a read-only dashboard, and still judges a draft there, which changes nothing', async () => {
    await dash.close();
    dash = await startDashboard({ store, dbPath: join(project, '.shadowlap', 'shadowlap.db'), readOnly: true, project: { path: project }, goldens: () => goldens });
    const made = recording(AGENT, [{ name: 'issue_refund', args: { amount: 120 } }]);
    goldens = [golden('goldens/refund', made)];
    expect((await send('PUT', 'checks/tests', { golden: 'goldens/refund', version: 'absent', entry })).status).toBe(403);
    expect(existsSync(join(project, 'shadowlap.config.json'))).toBe(false);
    expect((await send('POST', 'checks/preview', { expect: { tools: { issue_refund: 0 } }, run: made })).status).toBe(200);
  });

  it('refuses a write into a project folder that is gone, in the folder-gone words', async () => {
    // A project folder apart from the store's, so the store stays.
    const away = realpathSync(mkdtempSync(join(tmpdir(), 'sl-config-tests-away-')));
    await dash.close();
    dash = await startDashboard({ store, dbPath: join(project, '.shadowlap', 'shadowlap.db'), readOnly: false, project: { path: away }, goldens: () => goldens });
    goldens = [golden('goldens/refund', recording(AGENT, [{ name: 'issue_refund', args: { amount: 120 } }]))];
    rmSync(away, { recursive: true, force: true });
    const res = await send('PUT', 'checks/tests', { golden: 'goldens/refund', version: 'absent', entry });
    expect(res.status).toBe(409);
    expect(await error(res)).toBe(folderGoneText(basename(away)));
  });
});
