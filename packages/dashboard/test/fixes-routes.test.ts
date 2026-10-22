import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markFixApplied, NO_COMMAND, recordBlame, recordRepair, recordVerdict, setFixTitle, Store, type BlameReport, type RepairReport, type VerifyReport } from '@shadowlap/engine';
import { AFTER, BEFORE, blameReport, EXPECT, makeRun, repairReport, verifyReport } from '../../engine/test/fix-fixtures.js';
import { blameCheckFor, fixBundles } from '../src/fixes.js';
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
/**
 * A repair from here asks the user's own Claude Code unless the config names another repairer, and
 * claude must be found first: here it is this test's node, wherever claude is installed or not.
 */
const claudeWas = process.env.SHADOWLAP_CLAUDE;
/** Commands the stand-in keeps running (for 20 s, or until stopped): a repair, unless a test says otherwise. */
const slow = new Set<string>();

beforeEach(() => {
  store = Store.open(':memory:');
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-fixes-routes-')));
  spawned.length = 0;
  slow.clear();
  slow.add('repair');
  process.env.SHADOWLAP_CLAUDE = process.execPath;
});
afterEach(async () => {
  await dash?.close();
  dash = null;
  store.close();
  rmSync(project, { recursive: true, force: true });
  if (claudeWas === undefined) delete process.env.SHADOWLAP_CLAUDE;
  else process.env.SHADOWLAP_CLAUDE = claudeWas;
});

async function start(o: Partial<DashboardOptions> = {}): Promise<Dashboard> {
  dash = await startDashboard({
    store,
    version: '0.1.0',
    project: { path: project },
    spawnCli: (args, options) => {
      spawned.push(args);
      // A repair takes a while; everything else is over at once, unless the test made it slow too.
      const script = slow.has(args[0]!) ? 'setTimeout(() => {}, 20000)' : '';
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
    const { fixId, good } = story();
    await start();
    const d = await json(await api(`fixes/${fixId.slice(0, 12).toLowerCase()}`));
    expect(d).toMatchObject({ fixId, status: 'verified', defaultStep: 'verify', repairer: { name: 'claude-code', configured: false, problem: null } });
    expect(d.blame).toMatchObject({ lostAt: 5, title: 'Lost at model call #5' });
    expect(d.repair).toMatchObject({ repairId: 'repair-munzln2i', accepted: true });
    expect(d.verify).toHaveLength(2);
    expect(d.commands.repair).toBe(`shadowlap repair --fixes label:refund-bug --keeps ${good.slice(0, 10)} --expect '${JSON.stringify(EXPECT)}' --repairer claude-code`);
    expect((await api('fixes/fx-NOSUCHFIX')).status).toBe(404);
    expect((await api('fixes/fx-')).status).toBe(404);
  });

  it('leaves the repairer to shadowlap.config.json when it names one', async () => {
    const run = makeRun(store, { labels: ['double-email'] });
    const { fix } = blame(run, { expect: { tools: { send_email: 1 } } });
    await start({ loadConfig: (): ProjectConfig => ({ normalize: [], redact: [], repair: { repairer: 'anthropic:claude-opus-5-5' } }) });
    const d = await json(await api(`fixes/${fix.fixId}`));
    expect(d.repairer).toEqual({ name: 'anthropic:claude-opus-5-5', configured: true, problem: null });
    expect(d.actions.repair.command).toBe(`shadowlap repair --fixes label:double-email --expect '{"tools":{"send_email":1}}'`);
  });

  it('says when the repairer a repair from here asks can’t be asked: claude isn’t where the jobs would look', async () => {
    const run = makeRun(store, { labels: ['double-email'] });
    const { fix } = blame(run, { expect: { tools: { send_email: 1 } } });
    process.env.SHADOWLAP_CLAUDE = join(project, 'no-claude-here');
    await start();
    const d = await json(await api(`fixes/${fix.fixId}`));
    expect(d.repairer).toEqual({ name: 'claude-code', configured: false, problem: `This repair asks your own Claude Code, and ${join(project, 'no-claude-here')}, which SHADOWLAP_CLAUDE names, was not found: point SHADOWLAP_CLAUDE at Claude Code, or name another repairer in shadowlap.config.json (repair.repairer).` });
    // A fix that isn't open has nothing to repair, so nothing to say about its repairer.
    const { fixId } = story();
    expect((await json(await api(`fixes/${fixId}`))).repairer.problem).toBeNull();
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

  it('shows in the change feed as fixes, wherever the title was set', async () => {
    const { fixId } = story();
    await start();
    const before = await json(await api('changes'));
    await api(`fixes/${fixId}/title`, { method: 'PUT', body: JSON.stringify({ title: 'Renamed here' }) });
    const renamed = await json(await api(`changes?since=${before.cursor}`));
    expect(renamed).toMatchObject({ changed: true, runs: false, calls: false, other: ['fixes'] });
    // As `shadowlap fix title` sets it: in the store, not through the dashboard.
    setFixTitle(store, fixId, 'Renamed in a terminal');
    expect((await json(await api(`changes?since=${renamed.cursor}`))).other).toEqual(['fixes']);
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
    expect(blames[1]!.attempts[0]).toEqual({ runId: rescued, passed: true, verdict: 'passed', note: 'passed · called escalate', href: `#/run/${rescued}`, rescued: true });
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

  it('names the fix of each bundle under a run several fixes verified, which would otherwise read the same', () => {
    const { good, failing } = story();
    const other = makeRun(store, { labels: ['double-email'] });
    const { fix: second } = blame(other, { expect: { tools: { send_email: 1 } } });
    const both = verifyReport([
      { runId: other, role: 'target', pass: true },
      { runId: good, role: 'good', pass: true },
    ]);
    recordVerdict(store, { report: both, expect: { tools: { send_email: 1 } }, command: 'shadowlap verify --fixes label:double-email --keeps label:good' });
    for (const x of both.runs) attemptRuns(x.runId, x.attempts, (passed) => ({ verify: { role: x.role, passed } }));
    const titles = fixBundles(store, good)!.map((b) => [b.title, b.fixId === second.fixId]);
    expect(titles).toEqual(expect.arrayContaining([['verify · good · double-email', true], ['verify · good · refund-bug', false]]));
    expect(titles.every(([t]) => / · (double-email|refund-bug)$/.test(t as string))).toBe(true);
    // A run only one fix holds keeps the titles as they are.
    expect(fixBundles(store, failing)!.every((b) => !/refund-bug|double-email/.test(b.title))).toBe(true);
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

  it('judges a replay of a test run by its golden’s check, as the CLI did, whether it exited 0 or 1', async () => {
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ tests: { 'goldens/refund-*': { fork: true, expect: { tools: { issue_refund: { count: 0, args: { amount: 240 } } } } } } }));
    const golden = makeRun(store, { status: 'completed', meta: { imported: { at: 1, from: 'refund-over-limit' } } });
    const tested = makeRun(store, { mode: 'replay', parent: golden, status: 'completed', meta: { test: { golden: 'goldens/refund-over-limit', session: 's1' } } });
    const failedCheck = [{ ok: false, label: 'issue_refund with {"amount":240} called 0 times', detail: 'called 1 time' }];
    // A clean replay of the test run that failed its check, and a --strict one that also exited 1:
    // labelled like a fix that blamed on another check, which must not win over the config.
    const clean = makeRun(store, { mode: 'replay', parent: tested, status: 'completed', labels: ['double-email'], meta: { checks: failedCheck } });
    const strict = makeRun(store, { mode: 'replay', parent: tested, status: 'failed', labels: ['double-email'], meta: { checks: failedCheck } });
    blame(makeRun(store, { labels: ['double-email'] }), { expect: { tools: { send_email: 1 } } });
    await start();
    await started({ kind: 'blame', runId: clean });
    await started({ kind: 'blame', runId: strict });
    const refund = JSON.stringify({ tools: { issue_refund: { count: 0, args: { amount: 240 } } } });
    expect(spawned).toEqual([
      ['blame', clean, '--expect', refund],
      ['blame', strict, '--expect', refund],
    ]);
    // Without the config, the labels' fix would have given its check.
    expect(blameCheckFor(store, store.getRun(strict)!, { configDir: project })).toEqual({ expect: { tools: { send_email: 1 } }, from: 'labels' });
  });

  it('finds a pack’s check by the folder it was unpacked from, and the check a replay was given', async () => {
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ tests: { 'refund-over-limit': { expect: { tools: { escalate: 1 } } } } }));
    const unpacked = makeRun(store, { status: 'completed', meta: { imported: { at: 1, from: 'refund-over-limit' } } });
    const replay = makeRun(store, { mode: 'replay', parent: unpacked, status: 'failed', meta: { checks: [{ ok: false, label: 'escalate called 1 time', detail: 'called 0 times' }] } });
    const judged = makeRun(store, { mode: 'replay', parent: unpacked, status: 'completed', meta: { expect: { tools: { send_email: 0 } }, checks: [{ ok: false, label: 'send_email called 0 times', detail: 'called 1 time' }] } });
    await start();
    await started({ kind: 'blame', runId: replay });
    await started({ kind: 'blame', runId: judged });
    expect(spawned).toEqual([
      ['blame', replay, '--expect', '{"tools":{"escalate":1}}'],
      ['blame', judged, '--expect', '{"tools":{"send_email":0}}'],
    ]);
    expect(blameCheckFor(store, store.getRun(judged)!, {})).toEqual({ expect: { tools: { send_email: 0 } }, from: 'replay' });
  });

  it('asks for a check the run failed that nothing names, rather than blaming on the exit code', async () => {
    const run = makeRun(store, { status: 'failed', meta: { checks: [{ ok: false, label: 'send_email called 0 times', detail: 'called 1 time' }] } });
    await start();
    const res = await job({ kind: 'blame', runId: run });
    expect(res.status).toBe(422);
    expect((await json(res)).error).toBe(`say what a passing run must do: ${run.slice(0, 10)} failed “send_email called 0 times”, and neither the run nor shadowlap.config.json gives that check. Give it as expect JSON, such as {"tools":{"send_email":1}}`);
    expect(spawned).toEqual([]);
  });

  it('refuses a run still recording, and a check too long to be one', async () => {
    const recording = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: '.' }, startedAt: 3_000 }).runId;
    const run = makeRun(store, {});
    await start();
    const live = await job({ kind: 'blame', runId: recording, expect: null });
    expect(live.status).toBe(409);
    expect((await json(live)).error).toMatch(/still recording: blame it once it has ended/);
    const long = { output: { includes: ['x'.repeat(17 * 1024)] } };
    for (const expect_ of [long, JSON.stringify(long)]) {
      const res = await job({ kind: 'blame', runId: run, expect: expect_ });
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe('that check is too long');
    }
    expect(spawned).toEqual([]);
  });

  it('says a run its recorder left was interrupted, not that it is still recording', async () => {
    // On disk, so its recorder can be named as a process that is gone, as when it was killed.
    store.close();
    const dbPath = join(project, 'shadowlap.db');
    store = Store.open(dbPath);
    const left = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: '.' }, startedAt: 3_000 }).runId;
    const db = new DatabaseSync(dbPath);
    db.prepare('UPDATE run_owners SET pid = ? WHERE run_id = ?').run(spawnSync(process.execPath, ['-e', '0']).pid!, left);
    db.close();
    await start();
    const res = await job({ kind: 'blame', runId: left, expect: null });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe(`${left.slice(0, 10)} was interrupted: its recorder stopped before it ended, so it has no failure to blame`);
    expect(spawned).toEqual([]);
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

  it('asks the same before running the command of a teammate’s run pulled from the team store, naming the store', async () => {
    const pulled = makeRun(store, { meta: { imported: { at: 1, from: 's3://northwind-agent-runs/support-agent' }, author: 'maya@example.com' } });
    await start();
    const res = await job({ kind: 'blame', runId: pulled, expect: null });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toMatch(new RegExp(`^${pulled.slice(0, 10)} came from the team store: this runs the command it was recorded with \\(`));
    await started({ kind: 'blame', runId: pulled, expect: null, yes: true });
    expect(spawned.at(-1)).toEqual(['blame', pulled, '--yes']);
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

  it('runs only with the repairer the page named: one the config no longer names is refused, and nothing runs', async () => {
    const run = makeRun(store, { labels: ['double-email'] });
    const { fix } = blame(run, { expect: { tools: { send_email: 1 } } });
    // shadowlap.config.json as it reads now: edited in Settings or a terminal while the page stays open.
    let configured: string | undefined = 'anthropic';
    await start({ loadConfig: (): ProjectConfig => ({ normalize: [], redact: [], ...(configured ? { repair: { repairer: configured } } : {}) }), jobStopGraceMs: 200 });

    // The page loaded before the config named anthropic: its dialog said the user's own Claude Code.
    const stale = await job({ kind: 'repair', fixId: fix.fixId, repairer: 'claude-code' });
    expect(stale.status).toBe(409);
    expect((await json(stale)).error).toBe('the repairer in shadowlap.config.json changed since this page loaded: now anthropic. Nothing ran: open Repair from here again');
    expect(spawned).toEqual([]);
    // Read again, the dialog names anthropic, which the CLI reads from the config by itself.
    const asked = await started({ kind: 'repair', fixId: fix.fixId, repairer: 'anthropic' });
    expect(spawned.at(-1)).not.toContain('--repairer');
    await api(`jobs/${asked.id}/stop`, { method: 'POST' });
    await finished(asked);

    // The config names none any more: a dialog that said anthropic is refused, the user's own Claude Code runs.
    configured = undefined;
    spawned.length = 0;
    const gone = await job({ kind: 'repair', fixId: fix.fixId, repairer: 'anthropic' });
    expect(gone.status).toBe(409);
    expect((await json(gone)).error).toMatch(/changed since this page loaded: now none, so your own Claude Code \(claude-code\)\./);
    expect(spawned).toEqual([]);
    expect((await job({ kind: 'repair', fixId: fix.fixId, repairer: 42 })).status).toBe(400);
    const own = await started({ kind: 'repair', fixId: fix.fixId, repairer: 'claude-code' });
    expect(spawned.at(-1)).toEqual(['repair', '--fixes', 'label:double-email', '--expect', '{"tools":{"send_email":1}}', '--repairer', 'claude-code']);
    await api(`jobs/${own.id}/stop`, { method: 'POST' });
    // The dialog reads the fix again as it opens: the repairer it names is the config's, as it reads now.
    configured = 'openai:gpt-5';
    expect((await json(await api(`fixes/${fix.fixId}`))).repairer).toEqual({ name: 'openai:gpt-5', configured: true, problem: null });
  });

  it('runs nothing when the repairer can’t be asked from here: it would blame every run and find no one to propose a fix', async () => {
    const run = makeRun(store, { labels: ['double-email'] });
    const { fix } = blame(run, { expect: { tools: { send_email: 1 } } });
    let configured: string | undefined;
    await start({ loadConfig: (): ProjectConfig => ({ normalize: [], redact: [], ...(configured ? { repair: { repairer: configured } } : {}) }), jobStopGraceMs: 200 });
    // No claude on the PATH the jobs get, and SHADOWLAP_CLAUDE names none.
    delete process.env.SHADOWLAP_CLAUDE;
    const path = process.env.PATH;
    process.env.PATH = project;
    try {
      const refused = await job({ kind: 'repair', fixId: fix.fixId, repairer: 'claude-code' });
      expect(refused.status).toBe(409);
      expect((await json(refused)).error).toBe('This repair asks your own Claude Code, and claude was not found on this machine: install Claude Code, or set SHADOWLAP_CLAUDE to its path, or name another repairer in shadowlap.config.json (repair.repairer). Nothing ran');
      // The config names Claude Code itself: it says so.
      configured = 'claude-code:claude-opus-5-5';
      expect((await json(await api(`fixes/${fix.fixId}`))).repairer.problem).toBe('shadowlap.config.json names Claude Code as the repairer, and claude was not found on this machine: install Claude Code, or set SHADOWLAP_CLAUDE to its path, or have the config name another repairer.');
      expect((await job({ kind: 'repair', fixId: fix.fixId, repairer: 'claude-code:claude-opus-5-5' })).status).toBe(409);
      expect(spawned).toEqual([]);
      // An API repairer can't be checked without asking it: the repair says why, if it must.
      configured = 'anthropic';
      const asked = await started({ kind: 'repair', fixId: fix.fixId, repairer: 'anthropic' });
      expect(spawned.at(-1)).toEqual(['repair', '--fixes', 'label:double-email', '--expect', '{"tools":{"send_email":1}}']);
      await api(`jobs/${asked.id}/stop`, { method: 'POST' });
    } finally {
      process.env.PATH = path;
    }
  });
});

describe('the repair job’s imported runs', () => {
  it('asks before it runs the command of a run from someone else’s pack, the fix’s own or one a label brings in', async () => {
    const run = makeRun(store, { labels: ['double-email'] });
    const { fix } = blame(run, { expect: { tools: { send_email: 1 } } });
    // A good run from a pack: the fix doesn't hold it, but --keeps label:good selects it.
    const imported = makeRun(store, { labels: ['good'], status: 'completed', meta: { imported: { at: 1, from: 'pack' } } });
    await start({ jobStopGraceMs: 200 });
    const res = await job({ kind: 'repair', fixId: fix.fixId });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toMatch(new RegExp(`^${imported.slice(0, 10)} came from an imported pack`));
    expect(spawned).toEqual([]);
    const j = await started({ kind: 'repair', fixId: fix.fixId, yes: true });
    expect(spawned.at(-1)).toEqual(['repair', '--fixes', 'label:double-email', '--keeps', 'label:good', '--expect', '{"tools":{"send_email":1}}', '--repairer', 'claude-code', '--yes']);
    await api(`jobs/${j.id}/stop`, { method: 'POST' });
  });
});

describe('the working tree, one change at a time', () => {
  it('runs no agent from the tree while a repair tries candidates in it, nor another repair or an apply', async () => {
    const { fixId, failing } = story();
    const run = makeRun(store, { labels: ['double-email'] });
    const { fix } = blame(run, { expect: { tools: { send_email: 1 } } });
    await start({ jobStopGraceMs: 200 });
    const repair = await started({ kind: 'repair', fixId: fix.fixId });
    expect(repair.worktree).toEqual({ use: 'writes', doing: 'a repair is trying candidates in your working tree', folder: project });
    const refused = async (body: Record<string, unknown>, message: string) => {
      const res = await job(body);
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect((await json(res)).error).toBe(message);
    };
    await refused({ kind: 'blame', runId: run, expect: null }, 'a repair is trying candidates in your working tree: blame once it is done');
    await refused({ kind: 'action', runId: failing, key: 'r' }, 'a repair is trying candidates in your working tree: replay once it is done');
    await refused({ kind: 'repair', fixId: fix.fixId }, 'a repair is trying candidates in your working tree: repair once it is done');
    await refused({ kind: 'apply', fixId }, 'a repair is trying candidates in your working tree: apply the patch once it is done');
    expect(spawned).toHaveLength(1);
    // Once it is done, the tree is free again.
    await api(`jobs/${repair.id}/stop`, { method: 'POST' });
    await finished(repair);
    await started({ kind: 'blame', runId: run, expect: null });
  });

  it('starts no repair or apply while an agent runs from the tree, and lets agents run side by side', async () => {
    const { fixId } = story();
    const run = makeRun(store, { labels: ['double-email'] });
    const other = makeRun(store, {});
    const { fix } = blame(run, { expect: { tools: { send_email: 1 } } });
    slow.add('blame');
    await start({ jobStopGraceMs: 200 });
    const blaming = await started({ kind: 'blame', runId: run, expect: null });
    expect(blaming.worktree).toEqual({ use: 'reads', doing: 'a blame is running your agent from your working tree', folder: project });
    // Another blame reads the tree too: both run.
    const second = await started({ kind: 'blame', runId: other, expect: null });
    for (const [body, verb] of [
      [{ kind: 'repair', fixId: fix.fixId }, 'repair'],
      [{ kind: 'apply', fixId }, 'apply the patch'],
    ] as const) {
      const res = await job(body);
      expect(res.status).toBe(409);
      expect((await json(res)).error).toBe(`a blame is running your agent from your working tree: ${verb} once it is done`);
    }
    // A job that runs no agent waits for nothing.
    const pack = await started({ kind: 'action', runId: other, key: 'p', value: join(project, 'pack') });
    expect(pack.worktree).toBeNull();
    const listed = await json<{ jobs: JobView[] }>(await api('jobs'));
    expect(listed.jobs.map((j) => j.worktree?.use ?? null)).toEqual([null, 'reads', 'reads']);
    for (const j of [blaming, second]) await api(`jobs/${j.id}/stop`, { method: 'POST' });
  });
});

describe('a patch already in the working tree', () => {
  it('is offered to mark applied, with no git apply to copy, and the Overview counts the fix no more as ready to apply', async () => {
    const { fixId } = story();
    // The project's repository, its agent with the change in it: a pull request merged it.
    const git = (...args: string[]) => spawnSync('git', args, { cwd: project, stdio: 'ignore' });
    writeFileSync(join(project, 'agent.mjs'), `${AFTER}\n`);
    git('init', '-q', '-b', 'main');
    git('add', 'agent.mjs');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'Escalate refunds above the limit');
    await start();
    expect((await json(await api(`fixes/${fixId}`))).actions.apply).toMatchObject({ kind: 'patch', inTree: true, gitApply: null });
    const summary = await json(await api('summary'));
    expect(summary.fixes.readyToApply).toBe(0);
    expect(summary.needsLook.items.filter((x: { kind: string }) => x.kind === 'ready')).toEqual([]);
    // Taken out again: the patch is to apply.
    writeFileSync(join(project, 'agent.mjs'), `${BEFORE}\n`);
    expect((await json(await api(`fixes/${fixId}`))).actions.apply).toMatchObject({ inTree: false, gitApply: 'git -c core.autocrlf=false apply .shadowlap/repairs/repair-munzln2i/fix.patch' });
    expect((await json(await api('summary'))).fixes.readyToApply).toBe(1);
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

  it('marks applied a fix verified on the working tree as it is, which has no patch', async () => {
    const run = makeRun(store, { labels: ['double-email'] });
    const { fix } = blame(run, { expect: { tools: { send_email: 1 } } });
    recordVerdict(store, { report: verifyReport([{ runId: run, role: 'target', pass: true }]), expect: { tools: { send_email: 1 } }, command: 'shadowlap verify --fixes label:double-email' });
    expect(store.getFix(fix.fixId)!.status).toBe('verified');
    await start();
    const j = await started({ kind: 'apply', fixId: fix.fixId });
    expect(j.title).toBe('Marking the fix applied');
    expect(spawned.at(-1)).toEqual(['fix', 'apply', fix.fixId]);
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

  it('refuses a patch that is more than the change its repair verified, and runs nothing', async () => {
    const run = makeRun(store, { labels: ['refund-bug'] });
    const { fix } = blame(run);
    const repair = repairReport({ targets: [run], dir: '.shadowlap/repairs/repair-tampered' });
    repair.patch += ['diff --git a/EVIL.txt b/EVIL.txt', 'new file mode 100644', '--- /dev/null', '+++ b/EVIL.txt', '@@ -0,0 +1 @@', '+from the bucket', ''].join('\n');
    recordRepair(store, { repairId: 'repair-tampered', dir: '.shadowlap/repairs/repair-tampered', report: repair, expect: EXPECT, command: 'r' });
    await start();
    const before = spawned.length;
    const refused = await job({ kind: 'apply', fixId: fix.fixId });
    expect(refused.status).toBe(409);
    expect((await json(refused)).error).toBe(`${fix.fixId.slice(0, 13)}'s patch is not the change its repair verified: it changes agent.mjs and EVIL.txt, where its accepted candidate changes agent.mjs alone. Nothing ran`);
    expect(spawned.length).toBe(before);
  });

  it('is listed with blame and repair among the kinds the dashboard runs', async () => {
    await start();
    const meta = await json(await api('meta'));
    expect(meta.jobKinds).toEqual(expect.arrayContaining(['blame', 'repair', 'apply']));
  });
});
