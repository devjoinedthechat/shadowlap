import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markFixApplied, NO_COMMAND, recordBlame, recordRepair, recordVerdict, Store, type BlameReport, type RepairReport, type VerifyReport } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun, repairReport, verifyReport } from '../../engine/test/fix-fixtures.js';
import { fixBundles, goldenExpect } from '../src/fixes.js';
import { startDashboard, type Dashboard, type DashboardOptions, type JobView, type ProjectConfig } from '../src/index.js';

/**
 * Fixes over HTTP: the list, a fix, its title, the bundles the Forks view shows, and the blame,
 * repair and apply jobs. The jobs run a stand-in that exits at once: what matters here is the
 * command line each builder makes from what the browser sends, and what it refuses.
 */

let store: Store;
let project: string;
let dash: Dashboard | null = null;
const spawned: string[][] = [];

beforeEach(() => {
  store = Store.open(':memory:');
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-fixes-routes-')));
  spawned.length = 0;
});
afterEach(async () => {
  await dash?.close();
  dash = null;
  store.close();
  rmSync(project, { recursive: true, force: true });
});

async function start(o: Partial<DashboardOptions> = {}): Promise<Dashboard> {
  dash = await startDashboard({
    store,
    version: '0.1.0',
    project: { path: project },
    spawnCli: (args, options) => {
      spawned.push(args);
      // A repair takes a while; everything else is over at once.
      const script = args[0] === 'repair' ? 'setTimeout(() => {}, 20000)' : '';
      return spawn(process.execPath, ['-e', script], { stdio: options?.events ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'] });
    },
    ...o,
  });
  return dash;
}

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${dash!.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': dash!.token, ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}), ...(init.headers as Record<string, string>) } });
const json = async <T = Record<string, any>>(res: Response): Promise<T> => (await res.json()) as T;
const job = (body: Record<string, unknown>) => api('jobs', { method: 'POST', body: JSON.stringify(body) });

async function started(body: Record<string, unknown>): Promise<JobView> {
  const res = await job(body);
  expect(res.status, await res.clone().text()).toBe(202);
  return json<JobView>(res);
}

/** Waits for a job to end, as the page does before the next repair or apply. */
async function finished(j: JobView): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if ((await json<JobView>(await api(`jobs/${j.id}`))).done) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`job ${j.id} did not end`);
}

function blame(runId: string, o: { outcome?: BlameReport['outcome']; expect?: unknown; report?: BlameReport } = {}) {
  return recordBlame(store, { runId, report: o.report ?? blameReport(runId, o.outcome), expect: o.expect === undefined ? EXPECT : o.expect, scope: null, command: `shadowlap blame ${runId.slice(0, 10)}`, title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}' });
}

/** A run for each attempt a report names, as the CLI makes them: a replay of the run it probed or verified, marked. */
function attemptRuns(parent: string, attempts: Array<{ runId: string; passed: boolean }>, mark: (passed: boolean) => Record<string, unknown>): void {
  for (const a of attempts) {
    store.createRun({ runId: a.runId, mode: 'replay', parentRunId: parent, command: { argv: ['node', 'agent.mjs'], cwd: '.' }, startedAt: 2_000, meta: mark(a.passed) });
    store.endRun(a.runId, a.passed ? 'completed' : 'failed');
  }
}

/** A failing run blamed, with its probes as runs; a good run; a rejected verify and an accepted repair, their attempts as runs too. */
function story(): { failing: string; good: string; fixId: string; report: BlameReport; rejected: VerifyReport; repair: RepairReport } {
  const failing = makeRun(store, { labels: ['refund-bug'], calls: ['api', 'tool', 'api', 'tool', 'api', 'tool', 'api'] });
  const good = makeRun(store, { labels: ['good'], status: 'completed' });
  const report = blameReport(failing);
  const { fix } = blame(failing, { report });
  for (const p of report.probes) attemptRuns(failing, p.attempts, (passed) => ({ probe: { of: failing, callNo: p.callNo, passed } }));
  const rejected = verifyReport([
    { runId: failing, role: 'target', pass: false },
    { runId: good, role: 'good', pass: true },
  ]);
  recordVerdict(store, { report: rejected, expect: EXPECT, command: 'shadowlap verify --fixes label:refund-bug --keeps label:good' });
  for (const x of rejected.runs) attemptRuns(x.runId, x.attempts, (passed) => ({ verify: { role: x.role, passed } }));
  const repair = repairReport({ targets: [failing], good: [good] });
  recordRepair(store, { repairId: 'repair-munzln2i', dir: '.shadowlap/repairs/repair-munzln2i', report: repair, expect: EXPECT, command: 'shadowlap repair --fixes label:refund-bug --keeps label:good' });
  for (const c of repair.candidates) for (const x of c.verify?.runs ?? []) attemptRuns(x.runId, x.attempts, (passed) => ({ verify: { role: x.role, passed } }));
  return { failing, good, fixId: fix.fixId, report, rejected, repair };
}

describe('GET /api/fixes', () => {
  it('lists the fixes with the counts the chips show, filtered by status', async () => {
    const { fixId } = story();
    const open = makeRun(store, { labels: ['double-email'] });
    const { fix: openFix } = blame(open, { expect: { tools: { send_email: 1 } } });
    await start();
    const all = await json(await api('fixes'));
    expect(all.counts).toEqual({ all: 2, open: 1, verified: 1 });
    expect(all.fixes.map((f: { fixId: string }) => f.fixId)).toEqual([openFix.fixId, fixId]);
    expect(all.fixes[1]).toMatchObject({ status: 'verified', label: 'refund-bug', failing: 1, good: 1, href: `#/fixes/${fixId}` });
    expect((await json(await api('fixes?status=open'))).fixes.map((f: { fixId: string }) => f.fixId)).toEqual([openFix.fixId]);
    expect((await json(await api('fixes?status=verified'))).fixes.map((f: { fixId: string }) => f.fixId)).toEqual([fixId]);
    expect((await api('fixes?status=closed')).status).toBe(400);
    expect((await fetch(`${dash!.url}/api/fixes`)).status).toBe(401);
  });

  it('answers an unchanged list with a 304', async () => {
    story();
    await start();
    const first = await api('fixes');
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    expect((await api('fixes', { headers: { 'if-none-match': etag! } })).status).toBe(304);
  });
});

describe('GET /api/fixes/:id', () => {
  it('gives a fix with its steps by id or prefix, and names the repairer a repair from here asks', async () => {
    const { fixId } = story();
    await start();
    const d = await json(await api(`fixes/${fixId.slice(0, 12).toLowerCase()}`));
    expect(d).toMatchObject({ fixId, status: 'verified', defaultStep: 'verify', repairer: { name: 'claude-code', configured: false } });
    expect(d.blame).toMatchObject({ lostAt: 5, title: 'Lost at model call #5' });
    expect(d.repair).toMatchObject({ repairId: 'repair-munzln2i', accepted: true });
    expect(d.verify).toHaveLength(2);
    expect(d.commands.repair).toBe(`shadowlap repair --fixes label:refund-bug --keeps label:good --expect '${JSON.stringify(EXPECT)}' --repairer claude-code`);
    expect((await api('fixes/fx-NOSUCHFIX')).status).toBe(404);
    expect((await api('fixes/fx-')).status).toBe(404);
  });

  it('leaves the repairer to shadowlap.config.json when it names one', async () => {
    const run = makeRun(store, { labels: ['double-email'] });
    const { fix } = blame(run, { expect: { tools: { send_email: 1 } } });
    await start({ loadConfig: (): ProjectConfig => ({ normalize: [], redact: [], repair: { repairer: 'anthropic:claude-opus-5-5' } }) });
    const d = await json(await api(`fixes/${fix.fixId}`));
    expect(d.repairer).toEqual({ name: 'anthropic:claude-opus-5-5', configured: true });
    expect(d.actions.repair.command).toBe(`shadowlap repair --fixes label:double-email --expect '{"tools":{"send_email":1}}'`);
  });
});

describe('PUT /api/fixes/:id/title', () => {
  it('renames a fix, and refuses an empty title', async () => {
    const { fixId } = story();
    await start();
    const res = await api(`fixes/${fixId}/title`, { method: 'PUT', body: JSON.stringify({ title: '  Refunds above the limit\nissued without approval ' }) });
    expect(res.status).toBe(200);
    expect((await json(res)).title).toBe('Refunds above the limit issued without approval');
    expect(store.getFix(fixId)!.data.titleEdited).toBe(true);
    expect((await api(`fixes/${fixId}/title`, { method: 'PUT', body: JSON.stringify({ title: '   ' }) })).status).toBe(400);
    expect((await api('fixes/fx-NOSUCHFIX/title', { method: 'PUT', body: JSON.stringify({ title: 'x' }) })).status).toBe(404);
  });

  it('is a write a read-only dashboard refuses', async () => {
    const { fixId } = story();
    await start({ readOnly: true });
    expect((await api(`fixes/${fixId}/title`, { method: 'PUT', body: JSON.stringify({ title: 'Renamed' }) })).status).toBe(403);
    expect(store.getFix(fixId)!.title).toBe('issue_refund called with amount 240');
  });
});

describe('the Forks view’s bundles', () => {
  it('bundles each probe under the blamed run, marks the one blame named, and leads to the fix’s steps', () => {
    const { failing, good, fixId, report, rejected, repair } = story();
    const bundles = fixBundles(store, failing)!;
    const blames = bundles.filter((b) => b.kind === 'blame');
    expect(blames.map((b) => [b.title, b.blamed, `${b.passes} of ${b.attempts.length}`, b.href])).toEqual([
      ['blame · probe #1', false, '2 of 3', `#/fixes/${fixId}/blame`],
      ['blame · probe #5', true, '2 of 4', `#/fixes/${fixId}/blame`],
      ['blame · probe #7', false, '0 of 4', `#/fixes/${fixId}/blame`],
    ]);
    const rescued = report.contrast!.rescuedRunId;
    expect(blames[1]!.attempts[0]).toEqual({ runId: rescued, passed: true, note: 'passed · called escalate', href: `#/run/${rescued}`, rescued: true });
    expect(blames[1]!.attempts[1]!.note).toBe('issue_refund called');
    expect(blames.every((b) => b.parentRunId === failing)).toBe(true);

    // The working tree's verify (rejected) leads to its verdict; the repair's accepted candidate too;
    // the candidate it tried and dropped leads to the Repair step.
    const verifies = bundles.filter((b) => b.kind === 'verify' && b.parentRunId === failing);
    const d = store.listVerdicts();
    const rejectedId = d.find((v) => v.report === rejected || v.report.codeVersion === '370712a+dirty')!.verifyId;
    const acceptedId = d.find((v) => v.repairId === 'repair-munzln2i')!.verifyId;
    expect(verifies.map((b) => [b.title, b.change, b.verdict, b.href])).toEqual(
      expect.arrayContaining([
        ['verify · target', '370712a+dirty', 'rejected', `#/fixes/${fixId}/verify/${rejectedId}`],
        ['verify · target', 'repair candidate 3', 'accepted', `#/fixes/${fixId}/verify/${acceptedId}`],
        ['verify · target', 'repair candidate 2', 'rejected', `#/fixes/${fixId}/repair`],
      ]),
    );
    expect(verifies).toHaveLength(3);
    // The good run's family has its own bundles, each under it.
    const goods = fixBundles(store, good)!;
    expect(goods.map((b) => [b.parentRunId, b.role, b.verdict])).toEqual(expect.arrayContaining([[good, 'good', 'accepted']]));
    expect(goods.every((b) => b.parentRunId === good)).toBe(true);
    // Every attempt the reports name is bundled once.
    const names = (r: VerifyReport) => r.runs.filter((x) => x.runId === failing).flatMap((x) => x.attempts.map((a) => a.runId));
    const expected = [...report.probes.flatMap((p) => p.attempts.map((a) => a.runId)), ...names(rejected), ...repair.candidates.flatMap((c) => (c.verify ? names(c.verify) : []))];
    expect(bundles.flatMap((b) => b.attempts.map((a) => a.runId)).sort()).toEqual([...new Set(expected)].sort());
  });

  it('bundles attempts no stored report names from the marks on the runs', () => {
    const failing = makeRun(store, { calls: ['api', 'tool', 'api'] });
    attemptRuns(failing, [{ runId: '01M3RZZZZA0000000000000000', passed: true }, { runId: '01M3RZZZZB0000000000000000', passed: false }], (passed) => ({ probe: { of: failing, callNo: 3, passed } }));
    const [b] = fixBundles(store, failing)!;
    expect(b).toMatchObject({ kind: 'blame', title: 'blame · probe #3', passes: 1, fixId: null, href: `#/run/${failing}` });
    expect(b!.attempts.map((a) => a.note)).toEqual(['passed', 'failed']);
  });

  it('is served for a run and its prefix, and 404 for none', async () => {
    const { failing } = story();
    await start();
    const out = await json(await api(`fixes/family/${failing.slice(0, 12)}`));
    expect(out.bundles.length).toBeGreaterThan(3);
    expect((await api('fixes/family/01ZZZZZZZZ')).status).toBe(404);
  });
});

describe('the blame job', () => {
  it('blames a failed run with the check given, as JSON or its text, or the exit code alone', async () => {
    const run = makeRun(store, {});
    await start();
    await started({ kind: 'blame', runId: run.slice(0, 10), expect: { tools: { send_email: 1 } } });
    await started({ kind: 'blame', runId: run, expect: '{"tools":{"send_email":0}}' });
    await started({ kind: 'blame', runId: run, expect: null });
    expect(spawned).toEqual([
      ['blame', run, '--expect', '{"tools":{"send_email":1}}'],
      ['blame', run, '--expect', '{"tools":{"send_email":0}}'],
      ['blame', run],
    ]);
    expect((await job({ kind: 'blame', runId: run, expect: 'send_email once' })).status).toBe(400);
    expect((await job({ kind: 'blame', runId: run, expect: [1] })).status).toBe(400);
    expect((await job({ kind: 'blame', runId: '01ZZZZZZZZ' })).status).toBe(404);
    expect((await job({ kind: 'blame' })).status).toBe(400);
  });

  it('finds the check when none is given: the fix the run fails in, a fix its labels point to, or the agent’s exit', async () => {
    const { failing } = story();
    const sibling = makeRun(store, { labels: ['refund-bug'] });
    const exited = makeRun(store, { status: 'failed' });
    const passed = makeRun(store, { status: 'completed' });
    await start();
    await started({ kind: 'blame', runId: failing });
    await started({ kind: 'blame', runId: sibling });
    await started({ kind: 'blame', runId: exited });
    expect(spawned).toEqual([
      ['blame', failing, '--expect', JSON.stringify(EXPECT)],
      ['blame', sibling, '--expect', JSON.stringify(EXPECT)],
      ['blame', exited],
    ]);
    // A run that exited cleanly and names no check: the dashboard has to ask for it.
    const res = await job({ kind: 'blame', runId: passed });
    expect(res.status).toBe(422);
    expect((await json(res)).error).toMatch(/say what a passing run must do/);
  });

  it('takes a test run’s check from the config’s tests for its golden', async () => {
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ tests: { 'goldens/refund-over-limit': { expect: { tools: { issue_refund: 0 } } }, 'goldens/email-*': { repeat: 2, expect: { tools: { send_email: 1 } } } } }));
    const tested = makeRun(store, { status: 'completed', meta: { test: { golden: 'goldens/refund-over-limit', session: 's1' } } });
    const matched = makeRun(store, { status: 'completed', meta: { test: { golden: './goldens/email-twice/', session: 's1' } } });
    await start();
    await started({ kind: 'blame', runId: tested });
    await started({ kind: 'blame', runId: matched });
    expect(spawned).toEqual([
      ['blame', tested, '--expect', '{"tools":{"issue_refund":0}}'],
      ['blame', matched, '--expect', '{"tools":{"send_email":1}}'],
    ]);
  });

  it('reads a golden’s check by its folder, or a pattern on its last part', () => {
    const tests = { 'goldens/a': { expect: { tools: { x: 0 } } }, 'goldens/b-*': { expect: { tools: { y: 1 } } }, 'goldens/c': { repeat: 3 } };
    expect(goldenExpect(tests, 'goldens/a/')).toEqual({ tools: { x: 0 } });
    expect(goldenExpect(tests, 'goldens/b-twice')).toEqual({ tools: { y: 1 } });
    expect(goldenExpect(tests, 'goldens/c')).toBeUndefined();
    expect(goldenExpect(tests, 'other/b-twice')).toBeUndefined();
    expect(goldenExpect(undefined, 'goldens/a')).toBeUndefined();
  });

  it('runs a command from an imported pack only once it is confirmed, and never a capture’s', async () => {
    const imported = makeRun(store, { meta: { imported: { from: 'pack' } } });
    await start();
    const res = await job({ kind: 'blame', runId: imported, expect: null });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toMatch(/imported pack/);
    await started({ kind: 'blame', runId: imported, expect: null, yes: true });
    expect(spawned.at(-1)).toEqual(['blame', imported, '--yes']);
    // A run built from a capture has no command at all: blame it in a terminal, with one.
    const capture = store.createRun({ mode: 'record', command: { argv: [NO_COMMAND], cwd: '.' }, startedAt: 3_000, meta: { covers: ['api'] } }).runId;
    store.endRun(capture, 'failed');
    const refused = await job({ kind: 'blame', runId: capture, expect: null, yes: true });
    expect(refused.status).toBe(409);
    expect((await json(refused)).error).toMatch(/no command to re-run/);
  });
});

describe('the repair job', () => {
  it('repairs an open fix from its runs, with the user’s own Claude Code unless the config names a repairer', async () => {
    const run = makeRun(store, { labels: ['double-email'] });
    const good = makeRun(store, { labels: ['good'], status: 'completed' });
    const { fix } = blame(run, { expect: { tools: { send_email: 1 } } });
    await start();
    const j = await started({ kind: 'repair', fixId: fix.fixId.slice(0, 13) });
    expect(j.title).toBe('Repairing');
    expect(spawned.at(-1)).toEqual(['repair', '--fixes', 'label:double-email', '--keeps', 'label:good', '--expect', '{"tools":{"send_email":1}}', '--repairer', 'claude-code']);
    expect(good).toBeTruthy();
    await api(`jobs/${j.id}/stop`, { method: 'POST' });
  });

  it('leaves the repairer to the config, and refuses a fix that is not open', async () => {
    const { fixId } = story();
    const run = makeRun(store, { labels: ['double-email'] });
    const { fix } = blame(run, { expect: { tools: { send_email: 1 } } });
    await start({ loadConfig: (): ProjectConfig => ({ normalize: [], redact: [], repair: { repairer: 'anthropic' } }), jobStopGraceMs: 200 });
    const res = await job({ kind: 'repair', fixId });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toMatch(/verified already/);
    expect((await job({ kind: 'repair', fixId: 'fx-NOSUCHFIX' })).status).toBe(404);
    const j = await started({ kind: 'repair', fixId: fix.fixId });
    expect(spawned.at(-1)).not.toContain('--repairer');
    await api(`jobs/${j.id}/stop`, { method: 'POST' });
  });
});

describe('a repair or an apply at a time', () => {
  it('refuses another while one changes the working tree', async () => {
    const { fixId } = story();
    const run = makeRun(store, { labels: ['double-email'] });
    const { fix } = blame(run, { expect: { tools: { send_email: 1 } } });
    await start({ jobStopGraceMs: 200 });
    const repair = await started({ kind: 'repair', fixId: fix.fixId });
    for (const body of [{ kind: 'apply', fixId }, { kind: 'repair', fixId: fix.fixId }]) {
      const res = await job(body);
      expect(res.status).toBe(409);
      expect((await json(res)).error).toMatch(/a repair is running/);
    }
    // A blame changes nothing in the working tree: it can run meanwhile.
    await started({ kind: 'blame', runId: run, expect: null });
    await api(`jobs/${repair.id}/stop`, { method: 'POST' });
  });
});

describe('the apply job', () => {
  it('applies a verified fix, and finishes what an apply left undone', async () => {
    const { fixId } = story();
    await start();
    const j = await started({ kind: 'apply', fixId });
    expect(j.title).toBe('Applying the patch');
    expect(spawned.at(-1)).toEqual(['fix', 'apply', fixId]);
    await finished(j);
    markFixApplied(store, fixId, { patch: 'applied', repairId: 'repair-munzln2i', goldens: [], tests: 'skipped', by: 'dana', via: 'fix apply' });
    const again = await started({ kind: 'apply', fixId });
    expect(again.title).toBe('Finishing the apply');
  });

  it('refuses an open fix and one with nothing left to do', async () => {
    const { fixId } = story();
    const run = makeRun(store, { labels: ['double-email'] });
    const { fix } = blame(run, { expect: { tools: { send_email: 1 } } });
    markFixApplied(store, fixId, { patch: 'applied', repairId: 'repair-munzln2i', goldens: ['goldens/01M3RZ0001'], tests: 'passed', by: 'dana', via: 'fix apply' });
    await start();
    const open = await job({ kind: 'apply', fixId: fix.fixId });
    expect(open.status).toBe(409);
    expect((await json(open)).error).toMatch(/is open/);
    const done = await job({ kind: 'apply', fixId });
    expect(done.status).toBe(409);
    expect((await json(done)).error).toMatch(/applied already/);
  });

  it('is listed with blame and repair among the kinds the dashboard runs', async () => {
    await start();
    const meta = await json(await api('meta'));
    expect(meta.jobKinds).toEqual(expect.arrayContaining(['blame', 'repair', 'apply']));
  });
});
