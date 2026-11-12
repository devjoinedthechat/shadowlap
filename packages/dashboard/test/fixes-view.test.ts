import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decideVerify, fixRecords, gateResult, markFixApplied, recordBlame, recordRepair, recordVerdict, type BlameReport, type SprtGate, Store } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun, repairReport, verifyReport } from '../../engine/test/fix-fixtures.js';
import { fixLead } from '../src/fix-lead.js';
import { type FixActions } from '../src/fix-shared.js';
import { fixDetail, fixesSummary, needsLookFixes } from '../src/fixes.js';
import { fixesView } from '../src/fixes-view.js';

/**
 * The Fixes page's read model: where each fix stands on the ladder, the chip it is under, the to-do
 * order, the step each row leads with, and the failed runs nobody has blamed, which lead the list.
 */

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => {
  store.close();
});

const DAY = 24 * 60 * 60 * 1000;
let at = 10 * DAY;

/** A failing run blamed under its own check (`tool`, called once), opening a fix of its own; `outcome` changes what blame found. */
function opened(tool: string, outcome: BlameReport['outcome'] = 'blamed') {
  const run = makeRun(store, { labels: [tool] });
  const expect = { tools: { [tool]: 1 } };
  const { fix } = recordBlame(store, { runId: run, report: blameReport(run, outcome), expect, scope: null, command: 'shadowlap blame', title: `${tool} called twice`, checkText: `${tool} called once`, at: (at += DAY) });
  return { run, expect, fixId: fix.fixId };
}

/** A change made by hand, verified on the fix's failing run: accepted when it passes, rejected when it doesn't. */
function verifiedByHand(f: { run: string; expect: unknown }, pass = true) {
  recordVerdict(store, { report: verifyReport([{ runId: f.run, role: 'target', pass }]), expect: f.expect, command: 'shadowlap verify', at: (at += DAY) });
}

/** A fix verified with the patch an accepted repair made. */
function repaired() {
  const run = makeRun(store, { labels: ['refund-bug'] });
  const good = makeRun(store, { labels: ['good'], status: 'completed' });
  const { fix } = recordBlame(store, { runId: run, report: blameReport(run), expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: (at += DAY) });
  recordRepair(store, { repairId: 'repair-munzln2i', dir: '.shadowlap/repairs/repair-munzln2i', report: repairReport({ targets: [run], good: [good] }), expect: EXPECT, command: 'shadowlap repair', at: (at += DAY) });
  return { run, fixId: fix.fixId };
}

const rowOf = (fixId: string) => fixesView(store).fixes.find((f) => f.fixId === fixId)!;

describe('the Fixes page', () => {
  it('says where each fix stands on one ladder, and the chip it is under', () => {
    const open = opened('lookup', 'unrescuable');
    const blamed = opened('send_email');
    const hand = opened('escalate');
    verifiedByHand(hand);
    const patched = repaired();
    expect(rowOf(open.fixId)).toMatchObject({ rung: 'open', bucket: 'open', pr: null, ci: null });
    expect(rowOf(blamed.fixId)).toMatchObject({ rung: 'blamed', bucket: 'open' });
    expect(rowOf(hand.fixId)).toMatchObject({ status: 'verified', rung: 'verified', bucket: 'ready' });
    expect(rowOf(patched.fixId)).toMatchObject({ rung: 'verified', bucket: 'ready', failingIds: [patched.run.slice(0, 10)] });
    // Merged with its pull request, it shipped: under Applied, not ready to apply, here or on the Overview.
    store.mergeFixData(patched.fixId, { source: { ci: 'github', pr: { url: 'https://github.com/acme/agent/pull/138', number: 138, state: 'merged' } } });
    expect(rowOf(patched.fixId)).toMatchObject({ rung: 'merged', bucket: 'applied', ci: 'github', pr: { number: 138, url: 'https://github.com/acme/agent/pull/138', state: 'merged' }, next: null });
    expect(fixDetail(store, patched.fixId)).toMatchObject({ rung: 'merged', pr: { number: 138, state: 'merged' } });
    expect(fixesSummary(store).readyToApply).toBe(1);
    expect(needsLookFixes(store).filter((x) => x.kind === 'ready').map((x) => x.fixId)).toEqual([hand.fixId]);
    markFixApplied(store, hand.fixId, { patch: 'none', repairId: null, goldens: [], tests: 'failed', via: 'fix apply' });
    expect(rowOf(hand.fixId)).toMatchObject({ rung: 'applied', bucket: 'applied', broken: 'shadowlap test failed on its goldens', next: null });
    expect(fixesView(store).counts).toEqual({ all: 4, open: 2, ready: 0, applied: 2, verified: 2 });
  });

  it('lists the fixes in to-do order, the newest first within each place', () => {
    const blamedOld = opened('send_email');
    const open = opened('lookup', 'unrescuable');
    const hand = opened('escalate');
    verifiedByHand(hand, false);
    const blamedNew = opened('cancel_order');
    const ready = repaired();
    const applied = opened('refund');
    verifiedByHand(applied);
    markFixApplied(store, applied.fixId, { patch: 'none', repairId: null, goldens: [], tests: 'passed', via: 'fix apply' });
    const broken = opened('notify');
    verifiedByHand(broken);
    markFixApplied(store, broken.fixId, { patch: 'none', repairId: null, goldens: [], tests: 'failed', via: 'fix apply' });
    const view = fixesView(store);
    // Nobody has blamed it to a call; blamed, with no change yet; blamed with a change made by hand; ready; broken; applied.
    expect(view.fixes.map((f) => f.fixId)).toEqual([open.fixId, blamedNew.fixId, blamedOld.fixId, hand.fixId, ready.fixId, broken.fixId, applied.fixId]);
    expect(rowOf(hand.fixId).steps[1]).toMatchObject({ state: 'done', short: 'by hand', title: 'Changed by hand', meta: 'verify checks it; repair hasn’t run' });
    // A rejected change made by hand opens the fix where it did: on its blame.
    expect(fixDetail(store, hand.fixId)!.defaultStep).toBe('blame');
    expect(view.counts).toEqual({ all: 7, open: 4, ready: 1, applied: 2, verified: 3 });
    expect(view.totals.failing).toBe(7);
    // `?status=` keeps the rows it always kept, in the same order; the counts stay whole.
    expect(fixesView(store, { status: 'verified' }).fixes.map((f) => f.fixId)).toEqual([ready.fixId, broken.fixId, applied.fixId]);
    expect(fixesView(store, { status: 'applied' })).toMatchObject({ counts: view.counts, fixes: [{ fixId: broken.fixId }, { fixId: applied.fixId }] });
  });

  it('says by hand for a change made by hand after a repair that accepted nothing', () => {
    const f = opened('send_email');
    recordRepair(store, { repairId: 'repair-none', dir: '.shadowlap/repairs/repair-none', report: repairReport({ targets: [f.run], accepted: false }), expect: f.expect, command: 'shadowlap repair', at: (at += DAY) });
    expect(rowOf(f.fixId).steps[1]).toMatchObject({ state: 'todo', short: 'no change yet' });
    verifiedByHand(f);
    expect(rowOf(f.fixId).steps[1]).toMatchObject({ state: 'done', short: 'by hand', title: 'Changed by hand', meta: expect.stringMatching(/tried, none accepted/) });
  });

  it('reads each fix’s reports once until fixes change', () => {
    const f = opened('send_email');
    verifiedByHand(f, false);
    fixesView(store);
    const verdicts = vi.spyOn(store, 'getVerdict');
    const calls = vi.spyOn(store, 'getCalls');
    const all = vi.spyOn(store, 'allRuns');
    fixesView(store);
    expect(verdicts).not.toHaveBeenCalled();
    verifiedByHand(f);
    expect(fixesView(store).fixes[0].status).toBe('verified');
    expect(verdicts).toHaveBeenCalled();
    expect(calls).not.toHaveBeenCalled();
    expect(all).not.toHaveBeenCalled();
  });
});

describe('the failed runs nobody has blamed', () => {
  it('lead the list as one row: how many, the newest, and what failed in it', () => {
    expect(fixesView(store).unblamed).toBeNull();
    makeRun(store, { startedAt: 1_000 });
    const newest = makeRun(store, { startedAt: 2_000, meta: { checks: [{ ok: false, label: 'issue_refund called 0 times', detail: 'called 1 time' }] } });
    opened('send_email');
    const { unblamed, counts, totals } = fixesView(store);
    expect(unblamed).toMatchObject({ count: 2, runId: newest, failed: 'issue_refund called 0 times, but called 1 time', checks: ['issue_refund called 0 times'] });
    // Never counted with the fixes.
    expect(counts.all).toBe(1);
    expect(totals.failing).toBe(1);
  });

  it('says what failed by the agent’s exit when no check failed, and offers Run blame only where the run’s page leads with it', () => {
    const run = makeRun(store, { calls: ['api', 'tool', 'api'] });
    const row = fixesView(store).unblamed!;
    expect(row).toMatchObject({ runId: run, failed: 'the agent exited with an error', checks: [] });
    expect(row.next).toMatchObject({ key: 'blame', label: 'Run blame' });
    // A run that made no model call can't be blamed: no step.
    store.close();
    store = Store.open(':memory:');
    makeRun(store);
    expect(fixesView(store).unblamed).toMatchObject({ count: 1, next: null });
  });
});

describe('a capture its import judged failed', () => {
  const judged = (verdict: 'failed' | 'passed') => ({ rules: 'r', at: 1, verdict, why: null, checks: verdict === 'failed' ? [{ status: 'failed', ok: false, label: 'every issue_refund call: amount <= 100', detail: 'amount was 240' }] : [] });
  const capture = (verdict: 'failed' | 'passed', startedAt: number) => makeRun(store, { status: 'completed', startedAt, meta: { imported: { at: 1, from: '/work/cap.jsonl' }, covers: ['api'], judged: judged(verdict) }, calls: ['api'] });

  it('is a failure nobody has blamed, as Runs counts it: what its import judged it failed, and Run blame on its page', () => {
    const failed = capture('failed', 2_000);
    capture('passed', 3_000);
    const row = fixesView(store).unblamed!;
    expect(row).toMatchObject({ count: 1, runId: failed, failed: 'every issue_refund call: amount <= 100, but amount was 240' });
    // Its page leads with Run blame, which asks for your command first: the row opens it.
    expect(row.next).toMatchObject({ key: 'blame', capture: true });
    expect(needsLookFixes(store).filter((x) => x.kind === 'unblamed').map((x) => x.runId)).toEqual([failed]);
  });

  it('is none once blamed', () => {
    const failed = capture('failed', 2_000);
    recordBlame(store, { runId: failed, report: blameReport(failed), expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'every issue_refund call: amount <= 100', at: (at += DAY) });
    expect(fixesView(store).unblamed).toBeNull();
  });
});

describe('the step a fix leads with', () => {
  const actions = (o: Partial<FixActions> = {}): FixActions => ({ repair: null, apply: null, applied: false, blameAgain: null, blameStronger: null, verifyLeft: null, ...o });
  const repair = { argv: ['repair'], command: 'shadowlap repair --fixes label:send_email', noFix: null, noFixWhy: null, candidates: 3, spent: false };
  const apply = { kind: 'patch' as const, argv: ['fix', 'apply', 'F'], command: 'shadowlap fix apply F', gitApply: null, pending: null, pulled: false, files: [], diff: null, patchFile: null, refused: null, inTree: false, goldens: 0, names: [], held: null, change: null };
  const recOf = (fixId: string) => fixRecords(store, store.getFix(fixId)!);

  it('leads an open fix with blame again, blame with a stronger model, or Run repair, in that order', () => {
    const f = recOf(opened('send_email').fixId);
    const again = { kind: 'stopped' as const, argv: ['blame'], command: 'shadowlap blame 01M3RZ0001', gate: null, lastGood: null, soFar: 9, pulled: null, left: [] };
    const stronger = { argv: ['blame'], command: 'shadowlap blame 01M3RZ0001', attempts: 4, spent: 0.2, pulled: null, left: [] };
    expect(fixLead(f, actions({ blameAgain: again, blameStronger: stronger, repair }), { repairer: null })).toEqual({ key: 'blame-again', label: 'Run blame again', command: again.command, use: 'reads', stopped: true, gate: null, soFar: 9, lastGood: null });
    expect(fixLead(f, actions({ blameStronger: stronger, repair }), { repairer: null })).toEqual({ key: 'blame-stronger', label: 'Run blame with stronger model…', command: stronger.command, use: 'reads' });
    expect(fixLead(f, actions({ repair }), { repairer: ' anthropic ' })).toEqual({ key: 'repair', label: 'Run repair', command: repair.command, use: 'writes', repairer: 'anthropic' });
    // A repair that would end "No fix to try" runs nothing, and with no repair at all there is no step: the row opens the fix.
    expect(fixLead(f, actions({ repair: { ...repair, noFix: 'no answer of the model’s lost the run' } }), { repairer: null })).toBeNull();
    expect(fixLead(f, actions(), { repairer: null })).toBeNull();
  });

  it('waits after a repair that accepted nothing, until the fix is blamed again', () => {
    const f = opened('send_email');
    recordRepair(store, { repairId: 'repair-none', dir: '.shadowlap/repairs/repair-none', report: repairReport({ targets: [f.run], accepted: false }), expect: f.expect, command: 'shadowlap repair', at: (at += DAY) });
    expect(fixLead(recOf(f.fixId), actions({ repair }), { repairer: null })).toBeNull();
    recordBlame(store, { runId: f.run, report: blameReport(f.run), expect: f.expect, scope: null, command: 'shadowlap blame', title: 'send_email called twice', checkText: 'send_email called once', at: (at += DAY) });
    expect(fixLead(recOf(f.fixId), actions({ repair }), { repairer: null })).toMatchObject({ key: 'repair' });
  });

  it('leads after a repair that accepted nothing with what its newest incomplete verdict left: Run more attempts or Verify again, until the fix is blamed again', () => {
    const gate: SprtGate = { kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 80 };
    // A change made by hand, verified on the fix's failing run under its check, which stopped part way with its budget of $0.012: by that budget, or at an attempt it couldn't judge.
    const cases = [
      { tool: 'send_email', undecided: null, key: 'more', label: 'Run more attempts' },
      { tool: 'escalate', undecided: 'judge "sent-once" could not answer: no key for anthropic', key: 'again', label: 'Verify again' },
    ] as const;
    for (const c of cases) {
      const f = opened(c.tool);
      recordRepair(store, { repairId: `repair-${c.tool}`, dir: `.shadowlap/repairs/repair-${c.tool}`, report: repairReport({ targets: [f.run], accepted: false }), expect: f.expect, command: 'shadowlap repair', at: (at += DAY) });
      const report = verifyReport([{ runId: f.run, role: 'target', pass: true }]);
      report.runs[0] = { ...report.runs[0], passes: 4, verdict: 'open', decision: 'continue', gate: gateResult(gate, [true, true, true, true], {}), ...(c.undecided ? { undecided: c.undecided } : {}) };
      const stopReason = c.undecided ? null : 'the budget of $0.01 is spent';
      Object.assign(report, decideVerify(report.runs, stopReason), { gate, attemptsPerRun: gate.max, stopReason, attempts: 5, spent: 0.016 });
      const { verdict } = recordVerdict(store, { report, expect: f.expect, command: `shadowlap verify --fixes label:${c.tool} --budget 0.012`, rerun: { flags: ['--budget', '0.012'], command: null }, at: (at += DAY) });
      // What the fix's own Verify step offers for that verdict, and what its row leads with.
      const more = fixDetail(store, f.fixId)!.verify[0].more!;
      const lead = { key: c.key, label: c.label, command: more.command, use: 'reads', verifyId: verdict.verifyId, max: 80, attempts: 5 };
      expect(more.kind).toBe(c.key);
      expect(fixLead(recOf(f.fixId), actions({ repair }), { repairer: null })).toEqual(lead);
      expect(rowOf(f.fixId).next).toEqual(lead);
      // Run more attempts leaves out the budget that stopped it; Verify again runs as it ran.
      expect(more.command).toMatch(/^shadowlap verify /);
      expect(more.command.includes('--budget 0.012')).toBe(c.key === 'again');
      // A blame since the repair: the fix goes back to Run repair.
      recordBlame(store, { runId: f.run, report: blameReport(f.run), expect: f.expect, scope: null, command: 'shadowlap blame', title: `${c.tool} called twice`, checkText: `${c.tool} called once`, at: (at += DAY) });
      expect(fixLead(recOf(f.fixId), actions({ repair }), { repairer: null })).toMatchObject({ key: 'repair', label: 'Run repair' });
    }
  });

  it('leads a verified fix with Apply fix, Mark applied or Finish applying, and a merged, refused or applied one with nothing', () => {
    const { fixId } = repaired();
    const rec = recOf(fixId);
    expect(fixLead(rec, actions({ apply }), { repairer: null })).toEqual({ key: 'apply', label: 'Apply fix', command: 'shadowlap fix apply F', use: 'writes', pending: null });
    expect(fixLead(rec, actions({ apply: { ...apply, inTree: true } }), { repairer: null })).toMatchObject({ label: 'Mark applied' });
    expect(fixLead(rec, actions({ apply: { ...apply, kind: 'mark' } }), { repairer: null })).toMatchObject({ label: 'Mark applied' });
    expect(fixLead(rec, actions({ apply: { ...apply, refused: 'it changes two files' } }), { repairer: null })).toBeNull();
    expect(fixLead(rec, actions({ apply, applied: true }), { repairer: null })).toBeNull();
    expect(fixLead(rec, actions({ apply: { ...apply, pending: 'run shadowlap test on its goldens' }, applied: true }), { repairer: null })).toMatchObject({ label: 'Finish applying', pending: 'run shadowlap test on its goldens' });
    store.mergeFixData(fixId, { source: { pr: { url: 'https://github.com/acme/agent/pull/9', number: 9, state: 'merged' } } });
    expect(fixLead(recOf(fixId), actions({ apply }), { repairer: null })).toBeNull();
    // The row carries what the page's actions say: this fix's patch, applied with its command.
    store.mergeFixData(fixId, { source: null });
    expect(rowOf(fixId).next).toMatchObject({ key: 'apply', label: 'Apply fix', command: `shadowlap fix apply ${fixId}` });
  });
});
