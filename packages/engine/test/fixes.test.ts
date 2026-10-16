import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkKey, coversCheck, fixCost, FixIdError, fixLabelInfo, fixOfRun, fixRecords, markFixApplied, prNumber, recordBlame, recordRepair, recordVerdict, resolveFix, setFixTitle, settleAppliedFixes, Store } from '../src/index.js';
import { blameReport, EXPECT, makeRun, ORACLE, repairReport, verifyReport } from './fix-fixtures.js';

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => {
  store.close();
});

const blame = (runId: string, o: { expect?: unknown; oracle?: string[]; at?: number; outcome?: 'blamed' | 'unrescuable' | 'stopped'; title?: string } = {}) =>
  recordBlame(store, { runId, report: blameReport(runId, o.outcome, o.oracle ? { oracle: o.oracle } : {}), expect: o.expect === undefined ? EXPECT : o.expect, scope: null, command: `shadowlap blame ${runId.slice(0, 10)}`, title: o.title ?? 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: o.at ?? 2_000, actor: 'dana', ci: null });

const label = (runId: string, ...labels: string[]) => store.updateRunMeta(runId, { labels });

/** Other checks, with the oracles blame and verify would give them. */
const EMAIL = { tools: { send_email: 1 } };
const EMAIL_ORACLE = ['the agent exits 0', 'send_email called 1 time'];
const EXIT_ORACLE = ['the agent exits 0'];

describe('Fixes: grouping', () => {
  it('opens a fix from a blame with the labels of its run, and joins the next run with a label it holds', () => {
    const a = makeRun(store, { labels: ['good', 'refund-over-limit'] });
    const b = makeRun(store, { labels: ['refund-over-limit'] });
    const first = blame(a);
    expect(first.created).toBe(true);
    expect(first.fix).toMatchObject({ title: 'issue_refund called with amount 240', labels: ['refund-over-limit'], status: 'open', openedAt: 2_000, verifiedAt: null, check: { expect: EXPECT, key: checkKey(EXPECT), oracle: ORACLE, text: 'issue_refund never called with {"amount":240}' }, data: { openedBy: 'dana' } });
    expect(first.fix.fixId).toMatch(/^fx-[0-9A-Z]{26}$/);
    expect(first.blame).toMatchObject({ runId: a, outcome: 'blamed', expect: EXPECT });

    // Another check, and another title: the label decides, and the first title and check stay.
    const second = blame(b, { expect: EMAIL, oracle: EMAIL_ORACLE, title: 'something else', at: 3_000 });
    expect(second).toMatchObject({ created: false, fix: { fixId: first.fix.fixId, title: 'issue_refund called with amount 240', check: { expect: EXPECT } } });

    const rec = fixRecords(store, store.getFix(first.fix.fixId)!);
    expect(rec.failing).toEqual([a, b]);
    expect(rec.blames.map((x) => x.runId)).toEqual([a, b]);
    expect(store.blamesOfRun(a)[0]!.report.blamed?.callNo).toBe(5);
    expect(fixLabelInfo(store, rec.fix)).toEqual({ labels: ['refund-over-limit'], label: 'refund-over-limit' });
  });

  it('groups runs with no label by their check, however it is written', () => {
    const a = makeRun(store);
    const b = makeRun(store);
    const c = makeRun(store);
    const first = blame(a, { expect: { tools: { send_email: 1, issue_refund: 0 } } });
    expect(first.fix).toMatchObject({ labels: [], check: { key: checkKey({ tools: { issue_refund: 0, send_email: 1 } }) } });
    expect(blame(b, { expect: { tools: { issue_refund: 0, send_email: 1 } } }).fix.fixId).toBe(first.fix.fixId);
    // Another check is another failure; the exit code alone is a check of its own.
    const other = blame(c, { expect: null, oracle: EXIT_ORACLE });
    expect(other.created).toBe(true);
    expect(other.fix.check.key).toBe('check:exit');
  });

  it('matches every label of a fix, not only the first label of its first run', () => {
    const a = makeRun(store, { labels: ['customer-x', 'refund-over-limit'] });
    const refunds = blame(a).fix;
    // The same failure under the label it shares: it joins.
    const b = makeRun(store, { labels: ['refund-over-limit'] });
    expect(blame(b, { at: 3_000 }).fix.fixId).toBe(refunds.fixId);
    // A label the fix doesn't hold, and another check: another failure, so a fix of its own.
    const c = makeRun(store, { labels: ['customer-x', 'double-email'] });
    const emails = blame(c, { expect: EMAIL, oracle: EMAIL_ORACLE, at: 4_000 });
    expect(emails.created).toBe(true);
    expect(emails.fix.labels).toEqual(['customer-x', 'double-email']);
    // Every label of the run is the fix's: the label decides, whatever the check.
    const d = makeRun(store, { labels: ['refund-over-limit'] });
    expect(blame(d, { expect: { tools: { issue_refund: 0 } }, at: 5_000 }).fix.fixId).toBe(refunds.fixId);
    // Both fixes hold customer-x; the one with the same check wins.
    const e = makeRun(store, { labels: ['customer-x'] });
    expect(blame(e, { expect: EMAIL, oracle: EMAIL_ORACLE, at: 6_000 }).fix.fixId).toBe(emails.fix.fixId);
    expect(fixRecords(store, store.getFix(refunds.fixId)!).failing).toEqual([a, b, d]);
    expect(fixLabelInfo(store, store.getFix(refunds.fixId)!)).toEqual({ labels: ['customer-x', 'refund-over-limit'], label: 'refund-over-limit' });
  });

  it('picks up labels given to its runs later, and takes an unlabelled run with its check', () => {
    const x = makeRun(store);
    const fix = blame(x).fix;
    expect(fixLabelInfo(store, fix)).toEqual({ labels: [], label: null });
    const y = makeRun(store);
    label(x, 'refund-bug');
    label(y, 'refund-bug');
    expect(blame(y, { at: 3_000 }).fix.fixId).toBe(fix.fixId);
    expect(fixLabelInfo(store, store.getFix(fix.fixId)!)).toEqual({ labels: ['refund-bug'], label: 'refund-bug' });
    // A run with no label and the same check: the one fix with that check takes it.
    const z = makeRun(store);
    expect(blame(z, { at: 4_000 }).fix.fixId).toBe(fix.fixId);
    // A label taken off every run is gone from the fix; the labels kept on it are the fallback once its runs are deleted.
    label(x);
    label(y);
    expect(fixLabelInfo(store, store.getFix(fix.fixId)!).labels).toEqual([]);
    for (const id of [x, y, z]) store.deleteRun(id);
    expect(fixLabelInfo(store, store.getFix(fix.fixId)!)).toEqual({ labels: ['refund-bug'], label: 'refund-bug' });
  });

  it('keeps runs whose labels a fix does not share apart, even under the same check', () => {
    const crash = blame(makeRun(store, { labels: ['crash-on-start'] }), { expect: null, oracle: EXIT_ORACLE }).fix;
    const timeout = blame(makeRun(store, { labels: ['timeout-bug'] }), { expect: null, oracle: EXIT_ORACLE, at: 3_000 });
    expect(timeout.created).toBe(true);
    // An unlabelled run with a check two labelled fixes have: a fix of its own, which the next one joins.
    const lone = blame(makeRun(store), { expect: null, oracle: EXIT_ORACLE, at: 4_000 });
    expect(lone.created).toBe(true);
    expect(blame(makeRun(store), { expect: null, oracle: EXIT_ORACLE, at: 5_000 }).fix.fixId).toBe(lone.fix.fixId);
    // A labelled run that shares no label with any fix joins the unlabelled one with its check.
    expect(blame(makeRun(store, { labels: ['flaky-start'] }), { expect: null, oracle: EXIT_ORACLE, at: 6_000 }).fix.fixId).toBe(lone.fix.fixId);
    expect(store.listFixes().map((f) => f.fixId)).toEqual([lone.fix.fixId, timeout.fix.fixId, crash.fixId]);
  });

  it('keeps a run in the fix it already fails in, applied or not, and opens a new fix for a new run once it is applied', () => {
    const a = makeRun(store, { labels: ['refund-over-limit'] });
    const first = blame(a);
    expect(blame(a, { expect: { tools: { escalate: 1 } } }).fix.fixId).toBe(first.fix.fixId);
    expect(fixOfRun(store, a)?.fixId).toBe(first.fix.fixId);

    markFixApplied(store, first.fix.fixId, { patch: 'applied', repairId: null, goldens: [], tests: 'passed' }, 4_000);
    const again = makeRun(store, { labels: ['refund-over-limit'] });
    const next = blame(again, { at: 5_000 });
    expect(next.created).toBe(true);
    expect(next.fix.fixId).not.toBe(first.fix.fixId);
    expect(store.listFixes().map((f) => f.status)).toEqual(['open', 'applied']);
    // The old recording blamed again stays with its applied fix: it can't show the failure coming back.
    const old = blame(a, { at: 6_000 });
    expect(old).toMatchObject({ created: false, fix: { fixId: first.fix.fixId, status: 'applied' } });
  });
});

describe('Fixes: verdicts and repairs', () => {
  it('keeps every verdict; an accepted one turns the fix verified, and a later rejected one leaves it so', () => {
    const a = makeRun(store, { labels: ['refund-over-limit'] });
    const held = makeRun(store, { labels: ['refund-over-limit'] });
    const good = makeRun(store, { labels: ['good'], status: 'completed' });
    const fix = blame(a).fix;

    const no = recordVerdict(store, { report: verifyReport([{ runId: a, role: 'target', pass: false }, { runId: good, role: 'good', pass: true }]), expect: EXPECT, command: 'shadowlap verify', at: 3_000 });
    expect(no.verdict).toMatchObject({ verdict: 'rejected', repairId: null, candidate: null });
    expect(no.verdict.verifyId).toMatch(/^vf-[0-9A-Z]{26}$/);
    expect(no.fixes).toEqual([{ fix: expect.objectContaining({ fixId: fix.fixId, status: 'open' }), standing: { counts: true, why: null } }]);

    // The held-out run was never blamed: its label joins it to the fix.
    const yes = recordVerdict(store, { report: verifyReport([{ runId: a, role: 'target', pass: true }, { runId: held, role: 'holdout', pass: true }, { runId: good, role: 'good', pass: true }]), expect: EXPECT, command: 'shadowlap verify', at: 4_000 });
    expect(yes.fixes).toEqual([{ fix: expect.objectContaining({ fixId: fix.fixId, status: 'verified', verifiedAt: 4_000 }), standing: { counts: true, why: null } }]);
    recordVerdict(store, { report: verifyReport([{ runId: a, role: 'target', pass: false }]), expect: EXPECT, command: 'shadowlap verify', at: 5_000 });

    const rec = fixRecords(store, store.getFix(fix.fixId)!);
    expect(rec.fix).toMatchObject({ status: 'verified', verifiedAt: 4_000 });
    expect(rec.verdicts.map((v) => v.verdict)).toEqual(['rejected', 'accepted', 'rejected']);
    expect(rec.failing).toEqual([a, held]);
    expect(rec.good).toEqual([good]);
    expect(store.getVerdict(yes.verdict.verifyId)?.report.runs).toHaveLength(3);
  });

  it('leaves a fix open after a verdict under another check, or on runs that already passed', () => {
    const a = makeRun(store, { labels: ['refund-over-limit'] });
    const held = makeRun(store, { labels: ['refund-over-limit'] });
    const fix = blame(a).fix;

    // No --expect: it checked the exit code, which the recording already met.
    const exitOnly = recordVerdict(store, {
      report: verifyReport(
        [
          { runId: a, role: 'target', pass: true, recorded: true, deterministic: true },
          { runId: held, role: 'target', pass: true, recorded: true, deterministic: true },
        ],
        { oracle: EXIT_ORACLE },
      ),
      expect: null,
      command: 'shadowlap verify --fixes label:refund-over-limit',
      at: 3_000,
    });
    expect(exitOnly.fixes).toEqual([{ fix: expect.objectContaining({ fixId: fix.fixId, status: 'open' }), standing: { counts: false, why: 'another-check', missing: ['issue_refund with {"amount":240} called 0 times'] } }]);
    // An unrelated check is no better.
    const unrelated = recordVerdict(store, { report: verifyReport([{ runId: a, role: 'target', pass: true }], { oracle: ['the agent exits 0', 'send_email called 0 times'] }), expect: { tools: { send_email: 0 } }, command: 'v', at: 4_000 });
    expect(unrelated.fixes[0]).toMatchObject({ fix: { status: 'open' }, standing: { counts: false, why: 'another-check' } });
    // The fix's check, on runs that passed it as recorded: it proves nothing.
    const passing = recordVerdict(store, { report: verifyReport([{ runId: a, role: 'target', pass: true, recorded: true }]), expect: EXPECT, command: 'v', at: 5_000 });
    expect(passing.fixes[0]).toMatchObject({ fix: { status: 'open' }, standing: { counts: false, why: 'already-passing' } });
    // None of them brought the held-out run to the fix.
    expect(fixRecords(store, store.getFix(fix.fixId)!).failing).toEqual([a]);

    // A check that asks for more than the fix's, on runs that failed it: that counts.
    const stronger = recordVerdict(store, {
      report: verifyReport(
        [
          { runId: a, role: 'target', pass: true },
          { runId: held, role: 'holdout', pass: true },
        ],
        { oracle: [...ORACLE, 'escalate called 1 time'] },
      ),
      expect: { tools: { ...EXPECT.tools, escalate: 1 } },
      command: 'v',
      at: 6_000,
    });
    expect(stronger.fixes[0]).toMatchObject({ fix: { status: 'verified', verifiedAt: 6_000 }, standing: { counts: true } });
    const rec = fixRecords(store, store.getFix(fix.fixId)!);
    expect(rec.failing).toEqual([a, held]);
    expect(rec.verdicts.map((v) => rec.standing.get(v.verifyId)?.counts)).toEqual([false, false, false, true]);
  });

  it('says when an oracle covers a fix check', () => {
    const fix = { check: { expect: EXPECT, key: checkKey(EXPECT), oracle: ORACLE, text: '' } };
    expect(coversCheck(fix, ORACLE, EXPECT)).toEqual({ covers: true, missing: [] });
    // The same check with its keys in another order.
    expect(coversCheck(fix, [], { tools: { issue_refund: { args: { amount: 240 }, count: 0 } } }).covers).toBe(true);
    expect(coversCheck(fix, [...ORACLE, 'send_email called 1 time'], { other: true }).covers).toBe(true);
    expect(coversCheck(fix, EXIT_ORACLE, null)).toEqual({ covers: false, missing: [ORACLE[1]] });
    // A fix checked on the exit code alone is covered by any check.
    expect(coversCheck({ check: { expect: null, key: 'check:exit', oracle: EXIT_ORACLE, text: '' } }, EMAIL_ORACLE, EMAIL).covers).toBe(true);
  });

  it('links a verify of runs never blamed to the fix their label points to, and never by the check alone', () => {
    const a = makeRun(store, { labels: ['refund-over-limit'] });
    const fix = blame(a).fix;
    const b = makeRun(store, { labels: ['refund-over-limit'] });
    const kept = recordVerdict(store, { report: verifyReport([{ runId: b, role: 'target', pass: true }]), expect: EXPECT, command: 'v', at: 3_000 });
    expect(kept.fixes).toEqual([{ fix: expect.objectContaining({ fixId: fix.fixId, status: 'verified', verifiedAt: 3_000 }), standing: { counts: true, why: null } }]);
    expect(fixRecords(store, store.getFix(fix.fixId)!).failing).toEqual([a, b]);
    // An unlabelled run under the same check: a blame would join it, a verify doesn't group.
    const c = makeRun(store);
    expect(recordVerdict(store, { report: verifyReport([{ runId: c, role: 'target', pass: true }]), expect: EXPECT, command: 'v' }).fixes).toEqual([]);
    expect(fixRecords(store, store.getFix(fix.fixId)!).failing).toEqual([a, b]);
  });

  it('keeps a verdict on runs no fix holds, linked to nothing', () => {
    const lone = makeRun(store, { labels: ['other'] });
    const kept = recordVerdict(store, { report: verifyReport([{ runId: lone, role: 'target', pass: true }]), expect: null, command: 'shadowlap verify' });
    expect(kept.fixes).toEqual([]);
    expect(store.listVerdicts()).toHaveLength(1);
    expect(store.listFixes()).toEqual([]);
  });

  it('keeps a repair with its fix; an accepted candidate becomes a verdict, and a pull request where the fix came from', () => {
    const a = makeRun(store, { labels: ['refund-over-limit'] });
    const held = makeRun(store, { labels: ['refund-over-limit'] });
    const good = makeRun(store, { labels: ['good'], status: 'completed' });
    const fix = blame(a).fix;

    const kept = recordRepair(store, { repairId: 'repair-munzln2i', dir: '.shadowlap/repairs/repair-munzln2i', report: repairReport({ targets: [a], holdout: [held], good: [good], pr: 'https://github.com/example/agent/pull/138' }), expect: EXPECT, command: 'shadowlap repair', at: 6_000 });
    expect(kept.repair).toMatchObject({ repairId: 'repair-munzln2i', accepted: true, outcome: 'fixed' });
    expect(kept.verdict).toMatchObject({ verdict: 'accepted', repairId: 'repair-munzln2i', candidate: 3 });
    expect(kept.fixes).toEqual([
      { fix: expect.objectContaining({ fixId: fix.fixId, status: 'verified', verifiedAt: 6_000, data: expect.objectContaining({ source: { pr: { url: 'https://github.com/example/agent/pull/138', number: 138, state: 'open', at: 6_000 } } }) }), standing: { counts: true, why: null } },
    ]);
    const rec = fixRecords(store, store.getFix(fix.fixId)!);
    expect(rec.repairs.map((r) => r.repairId)).toEqual(['repair-munzln2i']);
    expect(rec.failing).toEqual([a, held]);
    expect(rec.good).toEqual([good]);
    expect(store.getRepair('repair-munzln2i')?.report.candidates).toHaveLength(3);
  });

  it('reads the number of a pull request or merge request from its address', () => {
    expect(prNumber('https://github.com/example/agent/pull/138')).toBe(138);
    expect(prNumber('https://gitlab.com/example/agent/-/merge_requests/42')).toBe(42);
    expect(prNumber('https://bitbucket.org/example/agent/pull-requests/7/overview')).toBe(7);
    expect(prNumber('https://example.com/agent/pull/12x')).toBeNull();
  });

  it('marks the fix applied when repair --apply left the change in the working tree, with the goldens it copied', () => {
    const a = makeRun(store, { labels: ['refund-over-limit'] });
    const fix = blame(a).fix;
    recordRepair(store, { repairId: 'repair-applied', dir: '.shadowlap/repairs/repair-applied', report: repairReport({ targets: [a], applied: true }), expect: EXPECT, command: 'shadowlap repair --apply', at: 7_000, goldensCopied: [`goldens/${a.slice(0, 10)}`] });
    expect(store.getFix(fix.fixId)).toMatchObject({ status: 'applied', verifiedAt: 7_000, appliedAt: 7_000, data: { applied: { patch: 'applied', repairId: 'repair-applied', goldens: [`goldens/${a.slice(0, 10)}`], tests: 'skipped', via: 'repair --apply' } } });
  });

  it('neither verifies nor applies a fix from a repair checked under another check', () => {
    const a = makeRun(store, { labels: ['refund-over-limit'] });
    const fix = blame(a).fix;
    const kept = recordRepair(store, { repairId: 'repair-exit', dir: '.shadowlap/repairs/repair-exit', report: repairReport({ targets: [a], applied: true, oracle: EXIT_ORACLE }), expect: null, command: 'shadowlap repair --apply', at: 7_000 });
    expect(kept.fixes).toEqual([{ fix: expect.objectContaining({ fixId: fix.fixId, status: 'open', appliedAt: null }), standing: { counts: false, why: 'another-check', missing: [ORACLE[1]] } }]);
  });

  it('leaves the fix open after a repair that accepts nothing', () => {
    const a = makeRun(store, { labels: ['refund-over-limit'] });
    const fix = blame(a).fix;
    const kept = recordRepair(store, { repairId: 'repair-none', dir: '.shadowlap/repairs/repair-none', report: repairReport({ targets: [a], accepted: false }), expect: EXPECT, command: 'shadowlap repair' });
    expect(kept).toMatchObject({ repair: { accepted: false, outcome: 'not-fixed' }, verdict: null });
    expect(kept.fixes).toEqual([{ fix: expect.objectContaining({ fixId: fix.fixId, status: 'open' }), standing: null }]);
    expect(store.listVerdicts()).toEqual([]);
  });

  it('keeps a run failing in one fix out of another', () => {
    const a = makeRun(store, { labels: ['refund-over-limit'] });
    const b = makeRun(store, { labels: ['double-email'] });
    const refunds = blame(a).fix;
    const emails = blame(b, { expect: EMAIL, oracle: EMAIL_ORACLE }).fix;
    // A verify of both runs reports to both fixes, and neither takes the other's run. Under the refund check, it counts for refunds only.
    const kept = recordVerdict(store, { report: verifyReport([{ runId: a, role: 'target', pass: true }, { runId: b, role: 'holdout', pass: true }]), expect: EXPECT, command: 'shadowlap verify' });
    const byFix = new Map(kept.fixes.map((x) => [x.fix.fixId, [x.fix.status, x.standing.counts]]));
    expect(byFix).toEqual(
      new Map([
        [refunds.fixId, ['verified', true]],
        [emails.fixId, ['open', false]],
      ]),
    );
    expect(fixRecords(store, store.getFix(refunds.fixId)!).failing).toEqual([a]);
    expect(fixRecords(store, store.getFix(emails.fixId)!).failing).toEqual([b]);
  });
});

describe('Fixes: reading them back', () => {
  it('counts what everything behind a fix took, each record once', () => {
    const a = makeRun(store, { labels: ['refund-over-limit'] });
    const good = makeRun(store, { labels: ['good'], status: 'completed' });
    const fix = blame(a).fix;
    const report = repairReport({ targets: [a], good: [good] });
    recordRepair(store, { repairId: 'repair-1', dir: '.shadowlap/repairs/repair-1', report, expect: EXPECT, command: 'shadowlap repair' });
    const rec = fixRecords(store, store.getFix(fix.fixId)!);
    const b = rec.blames[0]!.report;
    const accepted = report.candidates[2]!.verify!;
    const rejected = report.candidates[1]!.verify!;
    const cost = fixCost([rec, rec]);
    expect(cost.attempts).toBe(b.attempts + accepted.attempts + rejected.attempts);
    expect(cost.upstreamRequests).toBe(b.upstreamRequests + accepted.upstreamRequests + rejected.upstreamRequests);
    expect(cost.spent).toBeCloseTo(b.spent + accepted.spent + rejected.spent + 0.004, 10);
  });

  it('finds a fix by a prefix of its id, in any case, with or without fx-', () => {
    const fix = blame(makeRun(store)).fix;
    const id = fix.fixId.slice(3);
    expect(resolveFix(store, fix.fixId)?.fixId).toBe(fix.fixId);
    expect(resolveFix(store, id.slice(0, 12).toLowerCase())?.fixId).toBe(fix.fixId);
    expect(resolveFix(store, `FX-${id.slice(0, 12)}`)?.fixId).toBe(fix.fixId);
    expect(resolveFix(store, 'fx-ZZZZ')).toBeNull();
    expect(resolveFix(store, '')).toBeNull();
    // `fx-` alone names no fix, even when there is only one.
    expect(resolveFix(store, 'fx-')).toBeNull();
    expect(resolveFix(store, 'fx-01/../')).toBeNull();
    blame(makeRun(store), { expect: { tools: { other: 1 } } });
    expect(() => resolveFix(store, 'fx-0')).toThrow(FixIdError);
    expect(() => resolveFix(store, 'fx-0')).toThrow(/ambiguous/);
  });

  it('keeps a title someone gave it, and what applying it did', () => {
    const fix = blame(makeRun(store)).fix;
    expect(setFixTitle(store, fix.fixId, '  Refunds above the limit\nissued without approval ')).toMatchObject({ title: 'Refunds above the limit issued without approval', data: { titleEdited: true } });
    expect(() => setFixTitle(store, fix.fixId, '   ')).toThrow('a title needs some text');
    const applied = markFixApplied(store, fix.fixId, { patch: 'applied', repairId: 'repair-1', goldens: [], tests: 'skipped', via: 'repair --apply' }, 9_000);
    expect(applied).toMatchObject({ status: 'applied', appliedAt: 9_000, data: { titleEdited: true, applied: { patch: 'applied', tests: 'skipped', via: 'repair --apply' } } });
    // Applied again (fix apply finishing what repair --apply left): when it was applied stays, what was done is replaced.
    const again = markFixApplied(store, fix.fixId, { patch: 'applied', repairId: 'repair-1', goldens: ['goldens/01M3RZ4XKN'], tests: 'passed', by: 'dana', via: 'fix apply' }, 9_500);
    expect(again).toMatchObject({ appliedAt: 9_000, data: { titleEdited: true, applied: { goldens: ['goldens/01M3RZ4XKN'], tests: 'passed', by: 'dana', via: 'fix apply' } } });
  });

  it('holds an applied fix again once a test session passes every golden its test failed on', () => {
    const fix = blame(makeRun(store)).fix;
    const other = blame(makeRun(store), { expect: { tools: { other: 1 } } }).fix;
    markFixApplied(store, fix.fixId, { patch: 'applied', repairId: 'repair-1', goldens: ['goldens/01M3RZ4XKN', 'goldens/01M3RZ5B2C'], tests: 'failed', by: 'dana', via: 'fix apply' }, 9_000);
    markFixApplied(store, other.fixId, { patch: 'applied', repairId: 'repair-2', goldens: ['goldens/01M3RZ4XKN'], tests: 'skipped', via: 'repair --apply' }, 9_100);
    // One of its goldens passed: it still doesn't hold.
    expect(settleAppliedFixes(store, new Set(['goldens/01M3RZ4XKN']), 9_500)).toEqual([]);
    expect(store.getFix(fix.fixId)!.data.applied?.tests).toBe('failed');
    // Both did, written as a session or a path may write them: it holds, applied when it was.
    const settled = settleAppliedFixes(store, new Set(['goldens/01M3RZ4XKN', './goldens/01M3RZ5B2C/']), 9_600);
    expect(settled.map((f) => f.fixId)).toEqual([fix.fixId]);
    expect(store.getFix(fix.fixId)).toMatchObject({ status: 'applied', appliedAt: 9_000, data: { applied: { tests: 'passed', goldens: ['goldens/01M3RZ4XKN', 'goldens/01M3RZ5B2C'], by: 'dana', via: 'fix apply' } } });
    // A fix whose goldens were never tested is left for fix apply to finish.
    expect(store.getFix(other.fixId)!.data.applied?.tests).toBe('skipped');
  });

  it('changes only what it is asked to: a column, or one key of the data', () => {
    const run = makeRun(store);
    const fix = recordBlame(store, { runId: run, report: blameReport(run), expect: EXPECT, scope: null, command: 'c', title: 't', checkText: 'x', ci: 'github' }).fix;
    store.updateFix(fix.fixId, { status: 'verified', verifiedAt: 5 });
    store.mergeFixData(fix.fixId, { source: { pr: { url: 'u', number: 1 } } });
    expect(store.getFix(fix.fixId)).toMatchObject({ title: 't', status: 'verified', verifiedAt: 5, appliedAt: null, data: { source: { ci: 'github', pr: { url: 'u', number: 1 } } } });
    expect(() => store.updateFix('fx-NOPE', { title: 'x' })).toThrow('unknown fix fx-NOPE');
    expect(() => store.mergeFixData('fx-NOPE', {})).toThrow('unknown fix fx-NOPE');
  });

  it('holds the write lock from the start of each record, so no other write lands between what it reads and what it writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-fixes-lock-'));
    try {
      const path = join(dir, 'shadowlap.db');
      const s = Store.open(path);
      const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void } };
      const other = new DatabaseSync(path);
      other.exec('PRAGMA busy_timeout = 0');
      const blocked: string[] = [];
      // Another connection tries to take the write lock: it can't while a record holds it.
      const probe = (what: string) => {
        try {
          other.exec('BEGIN IMMEDIATE');
          other.exec('ROLLBACK');
        } catch {
          blocked.push(what);
        }
      };
      // Probe at the first statement each record runs, before it has read or written anything.
      let armed: string | null = null;
      const methods = s as unknown as Record<string, (...a: unknown[]) => unknown>;
      for (const name of ['putBlame', 'putVerdict', 'putRepair', 'getFix']) {
        const original = methods[name]!.bind(s);
        methods[name] = (...args: unknown[]) => {
          if (armed) probe(armed);
          armed = null;
          return original(...args);
        };
      }
      // The probe tells the two apart: a deferred transaction holds no lock until it writes.
      s.transaction(() => probe('deferred'), 'deferred');

      const run = makeRun(s, { labels: ['refund-over-limit'] });
      armed = 'blame';
      const { fix } = recordBlame(s, { runId: run, report: blameReport(run), expect: EXPECT, scope: null, command: 'c', title: 't', checkText: 'x' });
      armed = 'verdict';
      recordVerdict(s, { report: verifyReport([{ runId: run, role: 'target', pass: true }]), expect: EXPECT, command: 'v' });
      armed = 'repair';
      recordRepair(s, { repairId: 'repair-lock', dir: '.shadowlap/repairs/repair-lock', report: repairReport({ targets: [run] }), expect: EXPECT, command: 'r' });
      armed = 'title';
      setFixTitle(s, fix.fixId, 'Refunds above the limit');
      armed = 'applied';
      markFixApplied(s, fix.fixId, { patch: 'applied', repairId: 'repair-lock', goldens: [], tests: 'passed' });
      expect(blocked).toEqual(['blame', 'verdict', 'repair', 'title', 'applied']);
      other.close();
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opens one fix when blames of runs with the same label finish at once in several processes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-fixes-race-'));
    try {
      const path = join(dir, 'shadowlap.db');
      const s = Store.open(path);
      const runs = Array.from({ length: 8 }, () => makeRun(s, { labels: ['refund-over-limit'] }));
      s.close();
      const engine = fileURLToPath(new URL('../dist/index.js', import.meta.url));
      const script = `const { Store, recordBlame } = await import(${JSON.stringify('file://' + engine)}); const s = Store.open(${JSON.stringify(path)}); recordBlame(s, { runId: process.argv[1], report: JSON.parse(process.env.REPORT), expect: null, scope: null, command: 'c', title: 't', checkText: 'x' }); s.close();`;
      const results = await Promise.all(
        runs.map(
          (run) =>
            new Promise<[number | null, string]>((resolve) => {
              const child = spawn(process.execPath, ['--input-type=module', '-e', script, run], { env: { ...process.env, REPORT: JSON.stringify(blameReport(run)) }, stdio: ['ignore', 'ignore', 'pipe'] });
              let err = '';
              child.stderr.on('data', (d: Buffer) => (err += d.toString()));
              child.on('exit', (code) => resolve([code, err]));
            }),
        ),
      );
      expect(results.filter(([code]) => code !== 0).map(([, err]) => err)).toEqual([]);
      const again = Store.open(path);
      const fixes = again.listFixes();
      expect(fixes).toHaveLength(1);
      expect([...fixRecords(again, fixes[0]!).failing].sort()).toEqual([...runs].sort());
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps fixes in the store file, and a fix outlives a run deleted from it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-fixes-'));
    try {
      const path = join(dir, 'shadowlap.db');
      const s = Store.open(path);
      const run = makeRun(s, { labels: ['refund-over-limit'] });
      const kept = recordBlame(s, { runId: run, report: blameReport(run), expect: EXPECT, scope: 'agent', command: 'c', title: 't', checkText: 'x' });
      s.deleteRun(run);
      s.close();
      const again = Store.open(path);
      expect(again.getFix(kept.fix.fixId)).toMatchObject({ title: 't', labels: ['refund-over-limit'], check: { oracle: ORACLE } });
      expect(fixLabelInfo(again, again.getFix(kept.fix.fixId)!).label).toBe('refund-over-limit');
      expect(again.blamesOfRun(run)[0]).toMatchObject({ scope: 'agent', command: 'c' });
      expect(again.linksTo(run, 'failing')).toHaveLength(1);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Fixes: the change feed', () => {
  it('moves the fixes counter on every write to a fix or a report behind it, and nothing else does', () => {
    const fixes = () => store.changeCounts().fixes;
    const run = makeRun(store, { labels: ['refund-over-limit'] });
    const start = fixes();
    expect(start).toBe(0);
    const { fix } = blame(run);
    const blamed = fixes()!;
    expect(blamed).toBeGreaterThan(start!);
    setFixTitle(store, fix.fixId, 'Refunds above the limit');
    expect(fixes()).toBeGreaterThan(blamed);
    const titled = fixes();
    recordVerdict(store, { report: verifyReport([{ runId: run, role: 'target', pass: true }]), expect: EXPECT, command: 'shadowlap verify --fixes label:refund-over-limit' });
    expect(fixes()).toBeGreaterThan(titled!);
    const verified = fixes();
    // A label on a run is a change to runs only.
    label(run, 'refund-over-limit', 'seen');
    expect(fixes()).toBe(verified);
  });
});
