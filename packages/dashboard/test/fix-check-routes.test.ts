import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changeFixCheck, checkKey, markFixApplied, recordBlame, recordVerdict, shortFixId, Store } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun, ORACLE, verifyReport } from '../../engine/test/fix-fixtures.js';
import { fixAttemptGroups } from '../src/attempt-groups.js';
import { fixBundles, fixDetail, fixList, goldensFolderIn } from '../src/fixes.js';
import { verdictsView } from '../src/verdicts.js';
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
    // The Blame step's check gives every judge of the blame's own check its card, by its line.
    expect(fixDetail(store, fix.fixId)!.blame!.judges.map((j) => [j.label, j.reads])).toEqual([
      ['judge "explains-refusal" answers yes', 'the whole run'],
      ['judge "second" answers yes', 'the answer'],
    ]);
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

describe('a recording of a verified fix working', () => {
  it("is its accepted verdict's first passing attempt on its first failing run, and none before one", () => {
    const failing = makeRun(store, { labels: ['refund-bug'] });
    const fix = opened(failing);
    expect(fixDetail(store, fix.fixId)!.fixedRun).toBeNull();
    const { verdict } = recordVerdict(store, { report: verifyReport([{ runId: failing, role: 'target', pass: true }], { oracle: ORACLE }), expect: EXPECT, command: 'shadowlap verify', at: Date.now() });
    expect(fixDetail(store, fix.fixId)!.fixedRun).toBe(verdict.report.runs[0].attempts[0].runId);
  });
});

describe("a fix's steps after its check changed", () => {
  it('say its blame was found, and its verdict checked, under the old check', () => {
    const failing = makeRun(store, { labels: ['refund-bug'] });
    const fix = opened(failing);
    recordVerdict(store, { report: verifyReport([{ runId: failing, role: 'target', pass: false }], { oracle: ORACLE }), expect: EXPECT, command: 'shadowlap verify', at: Date.now() });
    const before = fixDetail(store, fix.fixId)!.steps;
    expect(before[2].state).toBe('no');
    const draft = { tools: { issue_refund: 0 } };
    changeFixCheck(store, fix.fixId, { check: { expect: draft, key: checkKey(draft), oracle: ['the agent exits 0', 'issue_refund called 0 times'], text: 'issue_refund never called' }, judged: { failing: { [failing]: 'failed' }, good: {} } });
    const [blame, , verify] = fixDetail(store, fix.fixId)!.steps;
    expect(blame).toMatchObject({ state: 'warn', short: 'old check', title: 'Found under the old check', meta: `${before[0].short} · blame again under this one` });
    expect(verify).toMatchObject({ state: 'todo', short: 'not verified', meta: 'verified only under its old check' });
    expect(fixDetail(store, fix.fixId)!.verify[0].oldCheck).toBe(true);
  });

  const DRAFT_CHECK = { expect: { tools: { issue_refund: 0 } }, key: checkKey({ tools: { issue_refund: 0 } }), oracle: ['the agent exits 0', 'issue_refund called 0 times'], text: 'issue_refund never called' };
  const blamedFix = (runId: string) =>
    recordBlame(store, { runId, report: blameReport(runId), expect: EXPECT, scope: null, command: `shadowlap blame ${runId.slice(0, 10)}`, rerun: { flags: [], command: null }, title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with amount 240' }).fix;

  it("blame again under the fix's check while the blamed run still fails it, and lead with it", () => {
    const failing = makeRun(store, { labels: ['refund-bug'] });
    const fix = blamedFix(failing);
    expect(fixDetail(store, fix.fixId)!).toMatchObject({ actions: { blameAgain: null }, blame: { oldCheck: null } });
    changeFixCheck(store, fix.fixId, { check: DRAFT_CHECK, judged: { failing: { [failing]: 'inconclusive' }, good: {} } });
    const d = fixDetail(store, fix.fixId)!;
    const again = d.actions.blameAgain!;
    expect(again).toMatchObject({ kind: 'old-check', gate: null, lastGood: null, soFar: null, underCheck: true });
    expect(again.argv.slice(0, 4)).toEqual(['blame', failing, '--expect', JSON.stringify(DRAFT_CHECK.expect)]);
    expect(d.lead).toMatchObject({ key: 'blame-again', stopped: false, gate: null, underCheck: true, command: again.command });
    expect(d.blame!.oldCheck).toEqual({ text: 'issue_refund never called with amount 240', next: 'again', command: again.command });
    expect(d.verify).toEqual([]);
  });

  it("offers none once the fix's check passed the blamed run, which left the fix: the note names no command", () => {
    const failing = makeRun(store, { labels: ['refund-bug'] });
    const other = makeRun(store, { labels: ['refund-bug'] });
    const fix = blamedFix(failing);
    recordBlame(store, { runId: other, report: blameReport(other, 'unrescuable'), expect: EXPECT, scope: null, command: 'shadowlap blame', rerun: { flags: [], command: null }, title: 'x', checkText: 'x' });
    changeFixCheck(store, fix.fixId, { check: DRAFT_CHECK, judged: { failing: { [failing]: 'passed', [other]: 'failed' }, good: {} } });
    const d = fixDetail(store, fix.fixId)!;
    expect(d.blame).toMatchObject({ runId: failing, oldCheck: { text: 'issue_refund never called with amount 240', next: null, command: null } });
    expect(d.actions).toMatchObject({ blameAgain: null, blameStronger: null });
    expect(d.lead?.key).not.toBe('blame-again');
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
    // As context for a check added to the golden that guards it: its runs, nothing refused or uncounted.
    const context = await api(`fixes/${fix.fixId}/check-preview`, { method: 'POST', body: JSON.stringify({ expect: DRAFT, context: true }) });
    expect(await json(context)).toMatchObject({ rows: [{ runId: passes, role: 'failing', outcome: 'passed' }], refused: null, uncounted: [] });
  });
});

describe("what reads a verdict's standing, after a fix's check changed", () => {
  const draft = { tools: { issue_refund: 0 } };
  const change = (fixId: string, failing: string) => changeFixCheck(store, fixId, { check: { expect: draft, key: checkKey(draft), oracle: ['the agent exits 0', 'issue_refund called 0 times'], text: 'issue_refund never called' }, judged: { failing: { [failing]: 'failed' }, good: {} } });

  it("reads a verdict checked under the old check as no longer counting, on Changes' Verdicts and in the run's Forks view", () => {
    const failing = makeRun(store, { labels: ['refund-bug'] });
    const fix = opened(failing);
    const report = verifyReport([{ runId: failing, role: 'target', pass: false }], { oracle: ORACLE });
    const { verifyId } = recordVerdict(store, { report, expect: EXPECT, command: 'shadowlap verify', at: Date.now() }).verdict;
    for (const a of report.runs[0].attempts) {
      store.createRun({ runId: a.runId, mode: 'replay', parentRunId: failing, command: { argv: ['node', 'agent.mjs'], cwd: '.' }, startedAt: 2_000, meta: { verify: { role: 'target', passed: a.passed } } });
      store.endRun(a.runId, 'failed');
    }
    const counted = () => [verdictsView(store, []).rows.find((x) => x.kind === 'verify' && x.verifyId === verifyId), fixBundles(store, failing)!.find((b) => b.kind === 'verify')!.counts] as const;
    expect(counted()[1]).toBe(true);
    change(fix.fixId, failing);
    const [row, inForks] = counted();
    expect(row).toMatchObject({ counts: false, line: "Doesn't count for this fix: it was checked under the fix’s old check" });
    expect(inForks).toBe(false);
  });

  it("groups a fix's attempts under a blame made under its check, the old check's blame until there is one", () => {
    const failing = makeRun(store, { labels: ['refund-bug'] });
    const fix = opened(failing);
    const first = store.listBlames()[0].blameId;
    change(fix.fixId, failing);
    expect(fixAttemptGroups(store, fix.fixId)!.blame!.blameId).toBe(first);
    // A blame under the fix's check that found no call is shown over the old check's that found one.
    const again = recordBlame(store, { runId: failing, report: blameReport(failing, 'unrescuable'), expect: draft, scope: null, command: 'shadowlap blame', title: 't', checkText: 'issue_refund never called', at: Date.now() + 1_000 });
    expect(again.fix.fixId).toBe(fix.fixId);
    expect(fixAttemptGroups(store, fix.fixId)!.blame!.blameId).toBe(again.blame.blameId);
  });
});
