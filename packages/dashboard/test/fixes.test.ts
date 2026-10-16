import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findPairs, fixRecords, markFixApplied, recordBlame, recordRepair, recordVerdict, Store, type BlameReport } from '@shadowlap/engine';
import { AFTER, BEFORE, blameReport, EXPECT, makeRun, repairReport, verifyReport } from '../../engine/test/fix-fixtures.js';
import { DONE, ESCALATE, LOOKUP, POLICY, REFUND, recordRun } from '../../engine/test/training-fixtures.js';
import { runDetail } from '../src/api.js';
import { fixDetail, fixesSummary, fixForRun, fixList, needsLookFixes, repairArgv } from '../src/fixes.js';

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => {
  store.close();
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
const EXIT_ORACLE = ['the agent exits 0'];

function blame(runId: string, o: { outcome?: BlameReport['outcome']; at?: number; expect?: unknown; title?: string; scope?: string } = {}) {
  return recordBlame(store, {
    runId,
    report: blameReport(runId, o.outcome),
    expect: o.expect === undefined ? EXPECT : o.expect,
    scope: o.scope ?? null,
    command: `shadowlap blame ${runId.slice(0, 10)} --expect '${JSON.stringify(EXPECT)}'`,
    title: o.title ?? 'issue_refund called with amount 240',
    checkText: 'issue_refund never called with {"amount":240}',
    at: o.at ?? NOW - DAY,
  });
}

/** The refund story: a failing run blamed, a held-out run and a good one, a rejected verify, then an accepted repair. */
function story() {
  const failing = makeRun(store, { labels: ['refund-bug'], calls: ['api', 'tool', 'api', 'tool', 'api', 'tool', 'api'] });
  const held = makeRun(store, { labels: ['refund-bug'] });
  const good = makeRun(store, { labels: ['good'], status: 'completed' });
  const { fix } = blame(failing, { at: NOW - 2 * DAY });
  recordVerdict(store, { report: verifyReport([{ runId: failing, role: 'target', pass: true }, { runId: held, role: 'holdout', pass: true }, { runId: good, role: 'good', pass: false }]), expect: EXPECT, command: 'shadowlap verify --fixes 01M3RXQ4VB', at: NOW - 2 * DAY + 1 });
  recordRepair(store, { repairId: 'repair-munzln2i', dir: '.shadowlap/repairs/repair-munzln2i', report: repairReport({ targets: [failing], holdout: [held], good: [good] }), expect: EXPECT, command: 'shadowlap repair --fixes label:refund-bug --keeps label:good', at: NOW - DAY });
  return { failing, held, good, fixId: fix.fixId };
}

describe('the Fixes list', () => {
  it('shows each failure with its status, label, failing runs, check and how far each step got', () => {
    const { fixId } = story();
    const open = makeRun(store, { labels: ['double-email'] });
    const { fix: openFix } = blame(open, { expect: { tools: { send_email: 1 } }, title: 'send_email called twice, not once', at: NOW });

    const list = fixList(store);
    expect(list.counts).toEqual({ all: 2, open: 1, verified: 1 });
    expect(list.fixes.map((f) => f.fixId)).toEqual([openFix.fixId, fixId]);
    expect(list.fixes[0]).toMatchObject({ status: 'open', title: 'send_email called twice, not once', label: 'double-email', labels: ['double-email'], failing: 1, good: 0, href: `#/fixes/${openFix.fixId}`, broken: null });
    expect(list.fixes[0]!.steps.map((s) => [s.state, s.short])).toEqual([
      ['done', 'lost at #5'],
      ['todo', 'no fix yet'],
      ['todo', 'not verified'],
    ]);
    expect(list.fixes[1]).toMatchObject({ status: 'verified', label: 'refund-bug', failing: 2, good: 1, check: 'issue_refund never called with {"amount":240}', verifiedAt: NOW - DAY });
    expect(list.fixes[1]!.steps.map((s) => [s.state, s.short])).toEqual([
      ['done', 'lost at #5'],
      ['done', 'prompt fix'],
      ['done', '3 of 3 held'],
    ]);
    expect(list.fixes[1]!.attempts).toBeGreaterThan(0);
    expect(fixList(store, { status: 'open' }).fixes.map((f) => f.fixId)).toEqual([openFix.fixId]);
    expect(fixList(store, { status: 'verified' }).fixes.map((f) => f.fixId)).toEqual([fixId]);
  });

  it('says how far a blame got that rescued nothing or stopped, and a verify that only rejected', () => {
    const a = makeRun(store, { labels: ['a'] });
    const b = makeRun(store, { labels: ['b'] });
    blame(a, { outcome: 'unrescuable' });
    const stopped = blame(b, { outcome: 'stopped', at: NOW });
    recordVerdict(store, { report: verifyReport([{ runId: b, role: 'target', pass: false }]), expect: EXPECT, command: 'v' });
    const [x, y] = fixList(store).fixes;
    expect(x!.fixId).toBe(stopped.fix.fixId);
    expect(x!.steps.map((s) => [s.state, s.short, s.title])).toEqual([
      ['todo', 'blame stopped', 'Stopped before the search finished'],
      ['todo', 'no fix yet', 'No fix yet'],
      ['no', 'rejected', 'Rejected'],
    ]);
    expect(x!.steps[0]!.meta).toBe('the budget of $0.05 is spent');
    // It ran to the end, but no model call rescued the run: no call is blamed yet, so it is still to do.
    expect(y!.steps[0]).toMatchObject({ state: 'todo', short: 'not rescued', title: 'Not rescued from any model call' });
    expect(fixDetail(store, y!.fixId)!.defaultStep).toBe('blame');
  });

  it('says where a fix came from', () => {
    const a = makeRun(store, { labels: ['refund-bug'] });
    recordBlame(store, { runId: a, report: blameReport(a), expect: EXPECT, scope: null, command: 'c', title: 't', checkText: 'x', ci: 'github' });
    recordRepair(store, { repairId: 'repair-ci', dir: '.shadowlap/repairs/repair-ci', report: repairReport({ targets: [a], pr: 'https://github.com/example/agent/pull/138' }), expect: EXPECT, command: 'r' });
    expect(fixList(store).fixes[0]!.source).toBe('from CI · PR #138');
    // Opened here, its merge request opened by a repair; once known to be merged, it says so.
    const b = makeRun(store, { labels: ['double-email'] });
    const { fix } = blame(b, { expect: { tools: { send_email: 1 } } });
    recordRepair(store, { repairId: 'repair-mr', dir: '.shadowlap/repairs/repair-mr', report: repairReport({ targets: [b], pr: 'https://gitlab.com/example/agent/-/merge_requests/42' }), expect: { tools: { send_email: 1 } }, command: 'r' });
    expect(fixDetail(store, fix.fixId)!.source).toBe('PR #42');
    store.mergeFixData(fix.fixId, { source: { pr: { state: 'merged' } } });
    expect(fixDetail(store, fix.fixId)!.source).toBe('PR #42 merged');
  });
});

describe('a fix', () => {
  it('opens on its last finished step, with its runs, actions and commands', () => {
    const { failing, held, good, fixId } = story();
    const d = fixDetail(store, fixId.slice(0, 10).toLowerCase())!;
    expect(d).toMatchObject({ fixId, status: 'verified', defaultStep: 'verify', expect: EXPECT, failing: 2, good: 1 });
    expect(d.failingRuns.map((r) => [r.runId, r.exists, r.href])).toEqual([
      [failing, true, `#/run/${failing}`],
      [held, true, `#/run/${held}`],
    ]);
    expect(d.goodRuns.map((r) => r.runId)).toEqual([good]);
    expect(d.steps[1]).toMatchObject({ title: 'Escalate refunds above the policy limit', meta: 'candidate 3 of 3 · proposed by claude-code' });
    expect(d.steps[2]).toMatchObject({ title: '3 of 3 runs held', meta: '1 earlier change rejected' });
    expect(d.actions).toEqual({ repair: null, apply: { kind: 'patch', argv: ['fix', 'apply', fixId], gitApply: 'git apply .shadowlap/repairs/repair-munzln2i/fix.patch', pending: null }, applied: false });
    expect(d.commands.blame).toBe(`shadowlap blame ${failing.slice(0, 10)} --expect '${JSON.stringify(EXPECT)}'`);
    expect(d.commands.repair).toBe(`shadowlap repair --fixes label:refund-bug --keeps label:good --expect '${JSON.stringify(EXPECT)}' --repairer claude-code`);
    expect(fixDetail(store, 'fx-NOPE')).toBeNull();
    expect(fixDetail(store, 'fx-')).toBeNull();
  });

  it('shows the Blame step: the lost call, the boundary, both answers, probes, attempts per probe and cost', () => {
    const { failing, fixId } = story();
    const b = fixDetail(store, fixId)!.blame!;
    expect(b).toMatchObject({ runId: failing, runExists: true, outcome: 'blamed', title: 'Lost at model call #5', lostAt: 5, step: 3, steps: 4, confidence: 'high', confidenceWhy: 'rescue stops cleanly at the boundary', needed: 2, attemptsPerProbe: 5, rescue: 'resample the probed call', pairs: 0 });
    expect(b.boundary).toBe('Resampling #5 rescued 2 of 4 attempts; resampling #7, the next model call, rescued 0 of 4.');
    expect(b.next).toEqual({ callNo: 7, step: 4, passes: 0, attempts: 4 });
    expect(b.answers).toEqual({ callNo: 5, recorded: 'issue_refund({"order_id":"A-1042","amount":240})', rescued: '"Above the limit.", escalate({"reason":"refund of $240 is above $100"})' });
    expect(b.hrefs).toEqual({ run: `#/run/${failing}`, lostAt: `#/run/${failing}/5`, rescued: `#/run/${b.rescuedRunId}` });
    expect(b.probes.map((p) => [p.callNo, p.verdict, `${p.passes} of ${p.attempts}`])).toEqual([
      [1, 'rescued', '2 of 3'],
      [5, 'rescued · blamed', '2 of 4'],
      [7, 'lost', '0 of 4'],
    ]);
    expect(b.bundles[1]).toMatchObject({ title: 'blame · probe #5', blamed: true, passes: 2 });
    // The rescued fork says what asking again did.
    expect(b.bundles[1]!.attempts.map((a) => a.note)).toEqual(['passed · called escalate', 'issue_refund called', 'passed', 'issue_refund called']);
    expect(b.callRow.map((c) => [c.callNo, c.kind, c.verdict, c.inScope])).toEqual([
      [1, 'api', 'rescued', true],
      [2, 'tool', null, true],
      [3, 'api', null, true],
      [4, 'tool', null, true],
      [5, 'api', 'blamed', true],
      [6, 'tool', null, true],
      [7, 'api', 'lost', true],
    ]);
    expect(b.cost).toEqual({ attempts: 11, upstreamRequests: 22, spent: expect.closeTo(0.11, 10), unknownModels: [] });
  });

  it("dims the calls outside a blame's scope, tool calls included, and keeps those in it", () => {
    const run = makeRun(store, { calls: [{ kind: 'api', scope: 'agent' }, { kind: 'tool', scope: 'agent' }, { kind: 'api', scope: 'customer' }, { kind: 'tool', scope: 'agent/refunds' }, { kind: 'api', scope: 'agent' }] });
    const { fix } = blame(run, { scope: 'agent' });
    expect(fixDetail(store, fix.fixId)!.blame!.callRow.map((c) => [c.callNo, c.kind, c.inScope])).toEqual([
      [1, 'api', true],
      [2, 'tool', true],
      [3, 'api', false],
      [4, 'tool', true],
      [5, 'api', true],
    ]);
  });

  it('shows the Repair step: the change and what was added, the result per role, why, candidates, files and the pull request body', () => {
    const { failing, fixId } = story();
    const r = fixDetail(store, fixId)!.repair!;
    expect(r).toMatchObject({ repairId: 'repair-munzln2i', accepted: true, title: 'Escalate refunds above the policy limit', repairer: 'claude-code', served: 'claude-opus-5-5', dir: '.shadowlap/repairs/repair-munzln2i', needed: 4, attemptsPerRun: 5 });
    expect(r.change).toEqual({ file: 'agent.mjs', anchor: 'system prompt', before: BEFORE, after: AFTER, added: { at: BEFORE.length - 1, text: ': escalate every refund above the limit it sets' }, removed: '' });
    expect(r.roles).toEqual([
      { role: 'target', held: 1, of: 1 },
      { role: 'held-out', held: 1, of: 1 },
      { role: 'good', held: 1, of: 1 },
    ]);
    expect(r.lost).toEqual([{ runId: failing, at: 'model call #5 (3 of 4)', href: `#/fixes/${fixId}/blame` }]);
    expect(r.candidates.map((c) => [c.id, c.verdict, c.why])).toEqual([
      [1, 'set aside', 'it mentions A-1042, which only the failing runs contain: a fix has to hold for cases it has not seen'],
      [2, 'rejected', 'target run 01M3RZ4XKN not fixed: 0 of 2 passed'],
      [3, 'accepted', 'the smallest rewrite the gate accepts'],
    ]);
    expect(r.files).toEqual([
      { name: 'fix.patch', note: '1 file · +1 −1' },
      { name: 'report.md', note: 'the pull request body' },
      { name: 'report.json', note: 'for agents and CI' },
      { name: 'goldens/', note: '1 recording made by the fixed code' },
    ]);
    expect(r.prBody).toContain('## Escalate refunds above the policy limit');
    expect(r.verify).toMatchObject({ verifyId: expect.stringMatching(/^vf-/), counts: true });
  });

  it('shows the Verify step: one change per verdict, its runs, and what it cost to find out', () => {
    const { fixId, good } = story();
    const d = fixDetail(store, fixId)!;
    expect(d.verify.map((v) => [v.code, v.verdict, v.headline, v.counts, v.note])).toEqual([
      ['repair candidate 3', 'accepted', 'Every failing run fixed, every good run kept', true, null],
      ['370712a+dirty', 'rejected', 'The change broke a run that worked', true, null],
    ]);
    expect(d.defaultVerify).toBe(d.verify[0]!.verifyId);
    const rejected = d.verify[1]!;
    expect(rejected).toMatchObject({ href: `#/fixes/${fixId}/verify/${rejected.verifyId}`, label: '370712a+dirty · rejected', oracle: 'a run passes when 4 of 5 attempts meet the check: the agent exits 0; issue_refund with {"amount":240} called 0 times' });
    expect(rejected.rows.map((r) => [r.role, r.outcome, r.note])).toEqual([
      ['target', 'fixed', 'forked at #1'],
      ['held-out', 'fixed', 'forked at #1'],
      ['good', 'broken', 'the agent exited with code 1'],
    ]);
    expect(rejected.rows[2]).toMatchObject({ runId: good, attempts: 2, passes: 0, tokens: { recorded: 4_329, now: 5_193 } });
    expect(rejected.tokens).toMatchObject({ change: expect.stringMatching(/^\+/) });
    expect(rejected.attempts).toBe(10);
  });

  it("lists a verdict under another check with why it doesn't count, and leaves the steps as they were", () => {
    const run = makeRun(store, { labels: ['refund-bug'] });
    const { fix } = blame(run);
    recordVerdict(store, { report: verifyReport([{ runId: run, role: 'target', pass: true, recorded: true, deterministic: true }], { oracle: EXIT_ORACLE }), expect: null, command: 'shadowlap verify --fixes label:refund-bug', at: NOW });
    const d = fixDetail(store, fix.fixId)!;
    expect(d).toMatchObject({ status: 'open', defaultStep: 'blame', oracle: ['the agent exits 0', 'issue_refund with {"amount":240} called 0 times'] });
    expect(d.steps[2]).toEqual({ key: 'verify', n: '03', state: 'todo', short: 'not verified', title: 'Not verified yet', meta: 'verified only under another check' });
    expect(d.verify).toHaveLength(1);
    expect(d.verify[0]).toMatchObject({ verdict: 'accepted', counts: false, note: "Checked under another check, so it doesn't count for this fix: it doesn't check issue_refund with {\"amount\":240} called 0 times." });
    expect(d.actions).toMatchObject({ repair: { argv: ['repair', '--fixes', 'label:refund-bug', '--expect', JSON.stringify(EXPECT)] }, apply: null, applied: false });
  });

  it('offers Repair from here on an open fix, and an empty Repair and Verify step', () => {
    const run = makeRun(store);
    const { fix } = blame(run, { expect: null });
    const d = fixDetail(store, fix.fixId)!;
    expect(d).toMatchObject({ defaultStep: 'blame', repair: null, verify: [], defaultVerify: null, applied: null });
    expect(d.actions).toEqual({ repair: { argv: ['repair', '--fixes', run], command: `shadowlap repair --fixes ${run} --repairer claude-code` }, apply: null, applied: false });
    expect(d.commands.verify).toBe(`shadowlap verify --fixes ${run.slice(0, 10)}`);
  });

  it('keeps Copy git apply on an applied fix, and says what applying left undone', () => {
    const run = makeRun(store, { labels: ['refund-bug'] });
    const { fix } = blame(run);
    // repair --apply: the change is in the working tree, its goldens are not in the project yet.
    recordRepair(store, { repairId: 'repair-applied', dir: '.shadowlap/repairs/repair-applied', report: repairReport({ targets: [run], applied: true, dir: '.shadowlap/repairs/repair-applied' }), expect: EXPECT, command: 'r', at: NOW });
    let d = fixDetail(store, fix.fixId)!;
    expect(d).toMatchObject({ status: 'applied', broken: null, applied: { via: 'repair --apply', goldens: [], tests: 'skipped' } });
    expect(d.actions).toEqual({
      repair: null,
      apply: { kind: 'patch', argv: ['fix', 'apply', fix.fixId], gitApply: 'git apply .shadowlap/repairs/repair-applied/fix.patch', pending: 'copy the recordings the fixed code made into the goldens folder, and run shadowlap test on them' },
      applied: true,
    });
    // fix apply copied them and the test failed: the fix doesn't hold, and Needs a look says so first.
    markFixApplied(store, fix.fixId, { patch: 'applied', repairId: 'repair-applied', goldens: [`goldens/${run.slice(0, 10)}`], tests: 'failed', via: 'fix apply' });
    d = fixDetail(store, fix.fixId)!;
    expect(d).toMatchObject({ broken: 'shadowlap test failed on its goldens', actions: { apply: { pending: 'run shadowlap test on its goldens' } } });
    blame(makeRun(store, { labels: ['other'] }), { expect: { tools: { send_email: 1 } }, at: NOW + 1 });
    expect(needsLookFixes(store).map((x) => [x.kind, x.action])).toEqual([
      ['broken', 'Open'],
      ['open', 'Fix it'],
    ]);
    expect(needsLookFixes(store)[0]).toMatchObject({ fixId: fix.fixId, title: "An applied fix doesn't hold", detail: 'issue_refund called with amount 240 · shadowlap test failed on its goldens', icon: 'fail', href: `#/fixes/${fix.fixId}` });
    expect(fixesSummary(store, NOW + DAY).broken).toBe(1);
  });

  it('marks a fix that a verify rejected after it was applied, and does not count that as rejected before it shipped', () => {
    const { failing, fixId } = story();
    markFixApplied(store, fixId, { patch: 'applied', repairId: 'repair-munzln2i', goldens: ['goldens/x'], tests: 'passed', via: 'fix apply' }, NOW - DAY + 10);
    const later = recordVerdict(store, { report: verifyReport([{ runId: failing, role: 'target', pass: false }]), expect: EXPECT, command: 'v', at: NOW - 10 });
    const d = fixDetail(store, fixId)!;
    expect(d).toMatchObject({ status: 'applied', broken: 'a verify rejected it after it was applied' });
    expect(d.steps[2]).toMatchObject({ state: 'done', meta: '1 earlier change rejected · 1 later change rejected' });
    expect(d.verify[0]).toMatchObject({ verifyId: later.verdict.verifyId, verdict: 'rejected', counts: true, note: 'Rejected after the fix was applied: it no longer holds.' });
    expect(fixesSummary(store, NOW)).toMatchObject({ broken: 1, rejected: { total: 1 }, verified: { total: 1 } });
    expect(needsLookFixes(store)[0]).toMatchObject({ kind: 'broken', href: `#/fixes/${fixId}/verify/${later.verdict.verifyId}`, at: NOW - 10 });
    // Accepted again since, it holds again.
    recordVerdict(store, { report: verifyReport([{ runId: failing, role: 'target', pass: true }]), expect: EXPECT, command: 'v', at: NOW - 5 });
    expect(fixDetail(store, fixId)!.broken).toBeNull();
  });
});

describe('fixes for the other views', () => {
  it('sums what fixes came to this week and last week, for the Overview', () => {
    story();
    const old = makeRun(store, { labels: ['old'] });
    blame(old, { at: NOW - 10 * DAY });
    makeRun(store, { status: 'failed' }); // a failed recording never blamed
    makeRun(store, { status: 'failed', mode: 'replay' }); // a failed fork: not a failure to fix

    const sum = fixesSummary(store, NOW);
    expect(sum).toMatchObject({
      open: 1,
      readyToApply: 1,
      broken: 0,
      funnel: { failures: 3, blamed: 2, verified: 1, applied: 0 },
      reproduced: { thisWeek: 1, lastWeek: 1, total: 2 },
      verified: { thisWeek: 1, lastWeek: 0, total: 1 },
      rejected: { thisWeek: 1, lastWeek: 0, total: 1 },
    });
    expect(sum.attempts).toBeGreaterThan(20);
    expect(sum.spent).toBeGreaterThan(0.004);
  });

  it('counts only verdicts that count for a fix', () => {
    const run = makeRun(store, { labels: ['refund-bug'] });
    blame(run);
    recordVerdict(store, { report: verifyReport([{ runId: run, role: 'target', pass: true, recorded: true }], { oracle: EXIT_ORACLE }), expect: null, command: 'v', at: NOW });
    recordVerdict(store, { report: verifyReport([{ runId: run, role: 'target', pass: false }], { oracle: EXIT_ORACLE }), expect: null, command: 'v', at: NOW });
    expect(fixesSummary(store, NOW)).toMatchObject({ readyToApply: 0, funnel: { verified: 0 }, verified: { total: 0 }, rejected: { total: 0 } });
  });

  it('lists what needs a look, most urgent first', () => {
    const { fixId } = story();
    const unblamed = makeRun(store, { status: 'failed', labels: ['refund-bug'], startedAt: NOW });
    // Blamed before blames were kept: only meta.blame on the run, so it is not a fix yet.
    const blamedBefore = makeRun(store, { status: 'failed', startedAt: NOW - 1, meta: { blame: { at: 1, outcome: 'blamed', callNo: 1, confidence: 'high', rescuedRunId: null, fields: {}, oracle: [], probes: [], spent: 0 } } });
    const open = makeRun(store, { labels: ['double-email'] });
    const { fix: openFix } = blame(open, { at: NOW, title: 'send_email called twice, not once', expect: { tools: { send_email: 1 } } });

    const items = needsLookFixes(store);
    expect(items.map((x) => [x.kind, x.action])).toEqual([
      ['open', 'Fix it'],
      ['unblamed', 'Run blame'],
      ['unblamed', 'Run blame'],
      ['ready', 'Apply'],
    ]);
    expect(items[0]).toMatchObject({ fixId: openFix.fixId, title: 'send_email called twice, not once', detail: 'lost at model call #5 · no fix yet', href: `#/fixes/${openFix.fixId}`, icon: 'blame' });
    expect(items[1]).toMatchObject({ runId: unblamed, href: `#/run/${unblamed}`, detail: 'refund-bug · not blamed yet', expect: EXPECT, icon: 'fail' });
    expect(items[2]).toMatchObject({ runId: blamedBefore, detail: 'node agent.mjs · not blamed yet' });
    expect(items[2]).not.toHaveProperty('expect');
    expect(items[3]).toMatchObject({ fixId, title: 'A verified fix is ready', detail: 'Escalate refunds above the policy limit', href: `#/fixes/${fixId}/repair`, icon: 'fixok' });
    expect(needsLookFixes(store, { limit: 2 })).toHaveLength(2);
  });

  it('counts the training pairs a blame made, as export pairs counts them', () => {
    // The support agent refunded $240 at #5; asked again there, two of three probes escalated and passed.
    const { run } = recordRun(store, [LOOKUP, POLICY, REFUND, DONE], { status: 'failed' });
    store.updateRunMeta(run.runId, { blame: { at: 2_000, outcome: 'blamed', callNo: 5, confidence: 'high', rescuedRunId: null, fields: {}, oracle: ['the agent exits 0'], probes: [{ callNo: 5, passes: 2, attempts: 3, rescued: true }], spent: 0.01 } });
    [true, true, false].forEach((passed, i) =>
      recordRun(store, passed ? [LOOKUP, POLICY, ESCALATE, DONE] : [LOOKUP, POLICY, REFUND, DONE], { parentRunId: run.runId, status: passed ? 'completed' : 'failed', meta: { probe: { of: run.runId, callNo: 5, passed }, repeat: { group: 'b1-5', attempt: i + 1, of: 3 } } }),
    );
    const { fix } = blame(run.runId);
    const pairs = fixDetail(store, fix.fixId)!.blame!.pairs;
    expect(pairs).toBeGreaterThan(0);
    expect(pairs).toBe(findPairs(store).sources.find((x) => x.key === `blame:${run.runId}`)!.made);
  });

  it('tells a run page how a run takes part in a fix', () => {
    const { failing, good, fixId } = story();
    const fix = fixForRun(store, failing)!;
    expect(fix).toMatchObject({ role: 'failing', fix: { fixId, status: 'verified', href: `#/fixes/${fixId}`, label: 'refund-bug' }, probe: null, verify: null });
    expect(fix.blame).toMatchObject({ lostAt: 5, step: 3, steps: 4, confidence: 'high', short: 'asked again, it calls escalate instead', href: `#/fixes/${fixId}/blame` });
    expect(fixForRun(store, good)).toMatchObject({ role: 'good', fix: { fixId } });
    // The run page's own answer carries it: its banner reads the fix there.
    expect(runDetail(store, failing)!.fix).toEqual(fix);

    // Attempts are runs too: a blame probe, the fork it rescued the run with, a verify attempt.
    const kept = store.blamesOfRun(failing)[0]!.report;
    const rescuedId = kept.contrast!.rescuedRunId;
    const probeId = kept.probes[0]!.attempts[1]!.runId;
    store.createRun({ runId: rescuedId, mode: 'replay', parentRunId: failing, command: { argv: ['x'], cwd: '.' }, meta: { probe: { of: failing, callNo: 5, passed: true } } });
    store.createRun({ runId: probeId, mode: 'replay', parentRunId: failing, command: { argv: ['x'], cwd: '.' }, meta: { probe: { of: failing, callNo: 1, passed: false } } });
    expect(fixForRun(store, rescuedId)).toMatchObject({ role: 'rescued', fix: { fixId }, probe: { of: failing, callNo: 5, passed: true, blamed: true } });
    expect(fixForRun(store, probeId)).toMatchObject({ role: 'probe', probe: { callNo: 1, blamed: false } });

    const verdict = store.listVerdicts().find((v) => v.verdict === 'rejected')!;
    const attemptId = verdict.report.runs[2]!.attempts[0]!.runId;
    store.createRun({ runId: attemptId, mode: 'replay', parentRunId: good, command: { argv: ['x'], cwd: '.' }, meta: { verify: { role: 'good', passed: false } } });
    expect(fixForRun(store, attemptId)).toMatchObject({ role: 'verify', fix: { fixId }, verify: { verifyId: verdict.verifyId, verdict: 'rejected', role: 'good', passed: false, href: `#/fixes/${fixId}/verify/${verdict.verifyId}` } });

    // A failed run never blamed: Run blame, with the check of the fix its label points to.
    const unblamed = makeRun(store, { status: 'failed' });
    expect(fixForRun(store, unblamed)).toEqual({ role: 'unblamed', fix: null, blame: null, probe: null, verify: null });
    const labelled = makeRun(store, { status: 'failed', labels: ['refund-bug'] });
    expect(fixForRun(store, labelled)).toMatchObject({ role: 'unblamed', expect: EXPECT });
    expect(fixForRun(store, makeRun(store, { status: 'completed' }))).toBeNull();
    expect(fixForRun(store, '01NOPE0000000000000000000')).toBeNull();
  });

  it('repairs a fix by its label only when the label selects nothing but its runs', () => {
    const a = makeRun(store, { labels: ['customer-x', 'refund-bug'] });
    const b = makeRun(store, { labels: ['customer-x', 'double-email'] });
    const refunds = blame(a).fix;
    blame(b, { expect: { tools: { send_email: 1 } } });
    // customer-x is on both fixes' runs, so the refund fix is repaired by its runs; refund-bug would do once it is the label most runs carry.
    expect(repairArgv(store, fixRecords(store, store.getFix(refunds.fixId)!))).toEqual(['repair', '--fixes', a, '--expect', JSON.stringify(EXPECT)]);
    const c = makeRun(store, { labels: ['refund-bug'] });
    blame(c);
    expect(repairArgv(store, fixRecords(store, store.getFix(refunds.fixId)!))).toEqual(['repair', '--fixes', 'label:refund-bug', '--expect', JSON.stringify(EXPECT)]);
  });

  it('offers no repair once none of the failing runs is left, though its label still names the fix', () => {
    const run = makeRun(store, { labels: ['escalation'] });
    const { fix } = blame(run);
    expect(repairArgv(store, fixRecords(store, fix))).toEqual(['repair', '--fixes', 'label:escalation', '--expect', JSON.stringify(EXPECT)]);
    store.deleteRun(run);
    expect(repairArgv(store, fixRecords(store, store.getFix(fix.fixId)!))).toEqual([]);
    expect(fixDetail(store, fix.fixId)!.actions.repair).toBeNull();
  });
});
