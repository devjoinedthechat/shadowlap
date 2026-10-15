import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkKey, fixCost, fixOfRun, fixRecords, markFixApplied, recordBlame, recordRepair, recordVerdict, resolveFix, setFixTitle, Store } from '../src/index.js';
import { blameReport, EXPECT, makeRun, repairReport, verifyReport } from './fix-fixtures.js';

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => {
  store.close();
});

const blame = (runId: string, o: { expect?: unknown; at?: number; outcome?: 'blamed' | 'unrescuable' | 'stopped'; title?: string } = {}) =>
  recordBlame(store, { runId, report: blameReport(runId, o.outcome), expect: o.expect === undefined ? EXPECT : o.expect, scope: null, command: `shadowlap blame ${runId.slice(0, 10)}`, title: o.title ?? 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: o.at ?? 2_000, actor: 'dana', ci: null });

describe('Fixes: grouping', () => {
  it('opens a fix from a blame, grouped by the run\'s label, and joins the next run with that label', () => {
    const a = makeRun(store, { labels: ['good', 'refund-over-limit'] });
    const b = makeRun(store, { labels: ['refund-over-limit'] });
    const first = blame(a);
    expect(first.created).toBe(true);
    expect(first.fix).toMatchObject({ title: 'issue_refund called with amount 240', groupKey: 'label:refund-over-limit', label: 'refund-over-limit', status: 'open', openedAt: 2_000, verifiedAt: null, check: { expect: EXPECT, text: 'issue_refund never called with {"amount":240}' }, data: { openedBy: 'dana' } });
    expect(first.fix.fixId).toMatch(/^fx-[0-9A-Z]{26}$/);
    expect(first.blame).toMatchObject({ runId: a, outcome: 'blamed', expect: EXPECT });

    // A check written differently, and another title: the label decides, and the first title stays.
    const second = blame(b, { expect: { tools: { send_email: 1 } }, title: 'something else', at: 3_000 });
    expect(second).toMatchObject({ created: false, fix: { fixId: first.fix.fixId, title: 'issue_refund called with amount 240' } });

    const rec = fixRecords(store, store.getFix(first.fix.fixId)!);
    expect(rec.failing).toEqual([a, b]);
    expect(rec.blames.map((x) => x.runId)).toEqual([a, b]);
    expect(store.blamesOfRun(a)[0]!.report.blamed?.callNo).toBe(5);
  });

  it('groups runs with no label by their check, however it is written', () => {
    const a = makeRun(store);
    const b = makeRun(store);
    const c = makeRun(store);
    const first = blame(a, { expect: { tools: { send_email: 1, issue_refund: 0 } } });
    expect(first.fix).toMatchObject({ label: null, groupKey: checkKey({ tools: { issue_refund: 0, send_email: 1 } }) });
    expect(blame(b, { expect: { tools: { issue_refund: 0, send_email: 1 } } }).fix.fixId).toBe(first.fix.fixId);
    // Another check is another failure; the exit code alone is a check of its own.
    const other = blame(c, { expect: null });
    expect(other.created).toBe(true);
    expect(other.fix.groupKey).toBe('check:exit');
  });

  it('keeps a run in the fix it already fails in, and opens a new fix once that one is applied', () => {
    const a = makeRun(store, { labels: ['refund-over-limit'] });
    const first = blame(a);
    expect(blame(a, { expect: { tools: { escalate: 1 } } }).fix.fixId).toBe(first.fix.fixId);
    expect(fixOfRun(store, a)?.fixId).toBe(first.fix.fixId);

    markFixApplied(store, first.fix.fixId, { patch: 'applied', repairId: null, goldens: [], tests: 'passed' }, 4_000);
    const again = makeRun(store, { labels: ['refund-over-limit'] });
    const next = blame(again, { at: 5_000 });
    expect(next.created).toBe(true);
    expect(next.fix.fixId).not.toBe(first.fix.fixId);
    expect(store.fixesByGroup('label:refund-over-limit').map((f) => f.status)).toEqual(['applied', 'open']);
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
    expect(no.fixes).toEqual([expect.objectContaining({ fixId: fix.fixId, status: 'open' })]);

    // The held-out run was never blamed: its label joins it to the fix.
    const yes = recordVerdict(store, { report: verifyReport([{ runId: a, role: 'target', pass: true }, { runId: held, role: 'holdout', pass: true }, { runId: good, role: 'good', pass: true }]), expect: EXPECT, command: 'shadowlap verify', at: 4_000 });
    expect(yes.fixes).toEqual([expect.objectContaining({ fixId: fix.fixId, status: 'verified', verifiedAt: 4_000 })]);
    recordVerdict(store, { report: verifyReport([{ runId: a, role: 'target', pass: false }]), expect: EXPECT, command: 'shadowlap verify', at: 5_000 });

    const rec = fixRecords(store, store.getFix(fix.fixId)!);
    expect(rec.fix).toMatchObject({ status: 'verified', verifiedAt: 4_000 });
    expect(rec.verdicts.map((v) => v.verdict)).toEqual(['rejected', 'accepted', 'rejected']);
    expect(rec.failing).toEqual([a, held]);
    expect(rec.good).toEqual([good]);
    expect(store.getVerdict(yes.verdict.verifyId)?.report.runs).toHaveLength(3);
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
    expect(kept.fixes).toEqual([expect.objectContaining({ fixId: fix.fixId, status: 'verified', verifiedAt: 6_000, data: expect.objectContaining({ source: { pr: { url: 'https://github.com/example/agent/pull/138', number: 138 } } }) })]);
    const rec = fixRecords(store, store.getFix(fix.fixId)!);
    expect(rec.repairs.map((r) => r.repairId)).toEqual(['repair-munzln2i']);
    expect(rec.failing).toEqual([a, held]);
    expect(rec.good).toEqual([good]);
    expect(store.getRepair('repair-munzln2i')?.report.candidates).toHaveLength(3);
  });

  it('marks the fix applied when repair --apply left the change in the working tree', () => {
    const a = makeRun(store, { labels: ['refund-over-limit'] });
    const fix = blame(a).fix;
    recordRepair(store, { repairId: 'repair-applied', dir: '.shadowlap/repairs/repair-applied', report: repairReport({ targets: [a], applied: true }), expect: EXPECT, command: 'shadowlap repair --apply', at: 7_000 });
    expect(store.getFix(fix.fixId)).toMatchObject({ status: 'applied', verifiedAt: 7_000, appliedAt: 7_000, data: { applied: { patch: 'applied', repairId: 'repair-applied', tests: 'skipped' } } });
  });

  it('leaves the fix open after a repair that accepts nothing', () => {
    const a = makeRun(store, { labels: ['refund-over-limit'] });
    const fix = blame(a).fix;
    const kept = recordRepair(store, { repairId: 'repair-none', dir: '.shadowlap/repairs/repair-none', report: repairReport({ targets: [a], accepted: false }), expect: EXPECT, command: 'shadowlap repair' });
    expect(kept).toMatchObject({ repair: { accepted: false, outcome: 'not-fixed' }, verdict: null });
    expect(store.getFix(fix.fixId)?.status).toBe('open');
    expect(store.listVerdicts()).toEqual([]);
  });

  it('keeps a run failing in one fix out of another', () => {
    const a = makeRun(store, { labels: ['refund-over-limit'] });
    const b = makeRun(store, { labels: ['double-email'] });
    const refunds = blame(a).fix;
    const emails = blame(b, { expect: { tools: { send_email: 1 } } }).fix;
    // A verify of both runs reports to both fixes, and neither takes the other's run.
    const kept = recordVerdict(store, { report: verifyReport([{ runId: a, role: 'target', pass: true }, { runId: b, role: 'holdout', pass: true }]), expect: EXPECT, command: 'shadowlap verify' });
    expect(kept.fixes.map((f) => f.fixId).sort()).toEqual([refunds.fixId, emails.fixId].sort());
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
    blame(makeRun(store), { expect: { tools: { other: 1 } } });
    expect(() => resolveFix(store, 'fx-0')).toThrow(/ambiguous/);
  });

  it('keeps a title someone gave it, and what applying it did', () => {
    const fix = blame(makeRun(store)).fix;
    expect(setFixTitle(store, fix.fixId, '  Refunds above the limit\nissued without approval ')).toMatchObject({ title: 'Refunds above the limit issued without approval', data: { titleEdited: true } });
    expect(() => setFixTitle(store, fix.fixId, '   ')).toThrow('a title needs some text');
    const applied = markFixApplied(store, fix.fixId, { patch: 'already', repairId: 'repair-1', goldens: ['goldens/01M3RZ4XKN'], tests: 'passed', by: 'dana' }, 9_000);
    expect(applied).toMatchObject({ status: 'applied', appliedAt: 9_000, data: { titleEdited: true, applied: { patch: 'already', goldens: ['goldens/01M3RZ4XKN'] } } });
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
      expect(again.getFix(kept.fix.fixId)).toMatchObject({ title: 't', label: 'refund-over-limit' });
      expect(again.blamesOfRun(run)[0]).toMatchObject({ scope: 'agent', command: 'c' });
      expect(again.linksTo(run, 'failing')).toHaveLength(1);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
