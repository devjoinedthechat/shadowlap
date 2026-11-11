import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changeFixCheck, checkKey, markFixApplied, recordBlame, shortFixId, Store } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun } from '../../engine/test/fix-fixtures.js';
import { fixDetail, fixList, goldensFolderIn } from '../src/fixes.js';
import { startDashboard, type Dashboard, type DashboardOptions, type JobView } from '../src/index.js';

/**
 * Giving a fix another check, as the dashboard reads and asks it: a fix's judge and the golden that
 * guards it, the runs a check left out, the fix-check job and the preview it reads first.
 */

let store: Store;
let project: string;
let dash: Dashboard | null = null;
const spawned: string[][] = [];

beforeEach(() => {
  store = Store.open(':memory:');
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-fix-check-routes-')));
});
afterEach(async () => {
  await dash?.close();
  dash = null;
  spawned.length = 0;
  store.close();
  rmSync(project, { recursive: true, force: true });
});

const JUDGE = { name: 'explains-refusal', question: 'Does the answer say why the refund was refused?', of: 'run', model: 'claude-haiku-4-5', pass: 'yes' };

function opened(runId: string, expect: unknown = EXPECT) {
  return recordBlame(store, { runId, report: blameReport(runId), expect, scope: null, command: `shadowlap blame ${runId.slice(0, 10)}`, title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with amount 240' }).fix;
}

describe("a fix's judge, its guard and the runs a check left out", () => {
  it("reads the check's first judge as the Must line's card says it, and none from a check that doesn't parse", () => {
    const fix = opened(makeRun(store, { labels: ['refund-bug'] }), { ...EXPECT, judge: [JUDGE, { ...JUDGE, name: 'second', of: 'answer' }] });
    expect(fixList(store).fixes[0].judge).toEqual({ label: 'judge "explains-refusal" answers yes', question: JUDGE.question, reads: 'the whole run', model: 'claude-haiku-4-5' });
    expect(fixDetail(store, fix.fixId)!.judge?.reads).toBe('the whole run');
    const other = opened(makeRun(store, { labels: ['other-bug'] }), { judge: 'not a list' });
    expect(fixDetail(store, other.fixId)!.judge).toBeNull();
    expect(fixDetail(store, opened(makeRun(store, { labels: ['plain'] })).fixId)!.judge).toBeNull();
  });

  it('names the golden a failing run replayed, else one applying it copied that the goldens folder still holds', () => {
    const replayed = makeRun(store, { labels: ['refund-bug'], meta: { test: { golden: 'goldens/refund-flow', session: 's1' } } });
    expect(fixDetail(store, opened(replayed).fixId)!.guard).toBe('goldens/refund-flow');
    const fix = opened(makeRun(store, { labels: ['other-bug'] }));
    markFixApplied(store, fix.fixId, { patch: 'none', repairId: null, goldens: ['goldens/gone', 'goldens/Refund-Twice'], tests: 'skipped' });
    expect(fixDetail(store, fix.fixId)!.guard).toBeNull();
    mkdirSync(join(project, 'goldens', 'refund-twice'), { recursive: true });
    expect(fixDetail(store, fix.fixId, { goldensFolder: goldensFolderIn(project) })!.guard).toBe('goldens/Refund-Twice');
  });

  it('lists the runs a check given since left out, and no failing run that left names its guard', () => {
    const failing = makeRun(store, { labels: ['refund-bug'], meta: { test: { golden: 'goldens/refund-flow', session: 's1' } } });
    const other = makeRun(store, { labels: ['refund-bug'] });
    const fix = opened(failing);
    recordBlame(store, { runId: other, report: blameReport(other), expect: EXPECT, scope: null, command: 'shadowlap blame', title: 't', checkText: 'c' });
    const expect2 = { tools: { issue_refund: 0 } };
    changeFixCheck(store, fix.fixId, { check: { expect: expect2, key: checkKey(expect2), oracle: ['the agent exits 0'], text: 'issue_refund never called' }, judged: { failing: { [failing]: 'passed', [other]: 'failed' }, good: {} } });
    const d = fixDetail(store, fix.fixId)!;
    expect(d.left).toEqual({ failing: [failing], good: [] });
    expect(d.failingRuns.map((r) => r.runId)).toEqual([other]);
    expect(d.guard).toBeNull();
  });
});

/** The dashboard, its jobs a stand-in that exits at once: what matters is the command line each builder makes, and what it refuses. */
async function start(o: Partial<DashboardOptions> = {}): Promise<Dashboard> {
  await dash?.close();
  dash = await startDashboard({
    store,
    version: '0.1.0',
    project: { path: project },
    spawnCli: (args, options) => {
      spawned.push(args);
      return spawn(process.execPath, ['-e', ''], { stdio: options?.events ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'] });
    },
    ...o,
  });
  return dash;
}

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${dash!.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': dash!.token, ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}), ...(init.headers as Record<string, string>) } });
const json = async <T = Record<string, any>>(res: Response): Promise<T> => (await res.json()) as T;
const job = (body: Record<string, unknown>) => api('jobs', { method: 'POST', body: JSON.stringify(body) });
const preview = (fixId: string, expect: unknown) => api(`fixes/${fixId}/check-preview`, { method: 'POST', body: JSON.stringify({ expect }) });
const DRAFT = { tools: { issue_refund: 0 } };

describe('Save check: the fix-check job', () => {
  it('runs shadowlap fix check with the draft, titled as its drawer heads it', async () => {
    const fix = opened(makeRun(store, { labels: ['refund-bug'] }));
    await start();
    const res = await job({ kind: 'fix-check', fixId: fix.fixId, expect: DRAFT });
    expect(res.status, await res.clone().text()).toBe(202);
    expect((await json<JobView>(res)).title).toBe('Changing check');
    expect(spawned.at(-1)).toEqual(['fix', 'check', fix.fixId, '--expect', '{"tools":{"issue_refund":0}}']);
  });

  it("refuses a check the command would refuse, in the engine's words, and a fix that isn't open", async () => {
    const run = makeRun(store, { labels: ['refund-bug'] });
    const fix = opened(run);
    await start();
    const refusal = async (body: Record<string, unknown>) => {
      const res = await job(body);
      return [res.status, (await json(res)).error as string] as const;
    };
    expect(await refusal({ kind: 'fix-check', fixId: fix.fixId, expect: { tools: { issue_refund: 'often' } } })).toEqual([400, expect.stringMatching(/^expect\.tools\["issue_refund"\]/)]);
    expect(await refusal({ kind: 'fix-check', fixId: fix.fixId, expect: null })).toEqual([400, 'expect must be an object']);
    expect(await refusal({ kind: 'fix-check', fixId: fix.fixId, expect: { tools: { send_email: { count: 1, args: { to: 'a\u200bb@example.com' } } } } })).toEqual([400, expect.stringMatching(/^The check holds a hidden character, U\+200B, at position 2 of tools\.send_email\.args\.to: remove it\. Nothing changed\.$/)]);
    // Run blame's check dialog shows the same words under its field.
    expect(await refusal({ kind: 'blame', runId: run, expect: { tools: { issue_refund: 'often' } } })).toEqual([400, expect.stringMatching(/^expect\.tools\["issue_refund"\]/)]);
    markFixApplied(store, fix.fixId, { patch: 'none', repairId: null, goldens: [], tests: 'skipped' });
    expect(await refusal({ kind: 'fix-check', fixId: fix.fixId, expect: DRAFT })).toEqual([409, `${shortFixId(fix.fixId)} is applied: it keeps the check its accepted verdict counted under. Add a check to the golden that guards it instead, under "tests" in shadowlap.config.json.`]);
    expect(spawned).toEqual([]);
  });
});

describe("fix mode's preview", () => {
  it('judges a draft on every run the fix holds, failing first, from what each recorded', async () => {
    const failing = makeRun(store, { labels: ['refund-bug'] });
    const fix = opened(failing);
    const good = makeRun(store, { labels: ['good'], status: 'completed' });
    store.addFixLink(fix.fixId, 'good', good, Date.now());
    await start({ readOnly: true });
    const res = await preview(fix.fixId, DRAFT);
    expect(res.status, await res.clone().text()).toBe(200);
    const p = await json(res);
    expect(p.rows.map((r: { runId: string; role: string; outcome: string; na: boolean }) => [r.runId, r.role, r.outcome, r.na])).toEqual([
      [failing, 'failing', 'failed', false],
      [good, 'good', 'passed', false],
    ]);
    expect(p).toMatchObject({ refused: null, uncounted: [] });
    // A preview changes nothing: a read-only dashboard answers it, and refuses the job.
    expect((await job({ kind: 'fix-check', fixId: fix.fixId, expect: DRAFT })).status).toBe(403);
    expect(store.fixChecks(fix.fixId)).toHaveLength(1);
  });

  it("says what Save check would refuse, and answers a check it can't take or a fix no longer open as the job does", async () => {
    const passes = makeRun(store, { labels: ['refund-bug'], status: 'completed' });
    const fix = opened(passes);
    await start();
    expect((await json(await preview(fix.fixId, DRAFT))).refused).toBe(`None of ${shortFixId(fix.fixId)}'s failing runs fails this check as recorded, so it would no longer be this failure. Nothing changed.`);
    const bad = await preview(fix.fixId, { tools: { issue_refund: 'often' } });
    expect([bad.status, (await json(bad)).error]).toEqual([400, expect.stringMatching(/^expect\.tools\["issue_refund"\]/)]);
    markFixApplied(store, fix.fixId, { patch: 'none', repairId: null, goldens: [], tests: 'skipped' });
    expect((await preview(fix.fixId, DRAFT)).status).toBe(409);
  });
});
