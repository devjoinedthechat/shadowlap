import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changeFixCheck, checkKey, fixLabelInfo, fixOfRun, fixRecords, leftFixLinkSql, madeUnderOldCheck, recordBlame, recordVerdict, runsLeft, shownBlame, Store, type StoredFix } from '../src/index.js';
import { blameReport, EXPECT, makeRun, ORACLE, verifyReport } from './fix-fixtures.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void } };

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => {
  store.close();
});

const EMAIL = { tools: { send_email: 1 } };
const EMAIL_LABEL = 'send_email called 1 time';
const emailCheck: StoredFix['check'] = { expect: EMAIL, key: checkKey(EMAIL), oracle: ['the agent exits 0', EMAIL_LABEL], text: 'send_email called 1 time' };
/** A check asking for both the fix's first check and the email: it covers either. */
const BOTH = { tools: { issue_refund: { count: 0, args: { amount: 240 } }, send_email: 1 } };
const BOTH_ORACLE = [...ORACLE, EMAIL_LABEL];

const blame = (runId: string, o: { expect?: unknown; at?: number; outcome?: 'blamed' | 'stopped' } = {}) =>
  recordBlame(store, { runId, report: blameReport(runId, o.outcome), expect: o.expect === undefined ? EXPECT : o.expect, scope: null, command: `shadowlap blame ${runId.slice(0, 10)}`, title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: o.at ?? 2_000, actor: 'dana', ci: null }).fix;

const verdict = (runs: Parameters<typeof verifyReport>[0], expect: unknown, oracle: string[], at: number) => recordVerdict(store, { report: verifyReport(runs, { oracle }), expect, command: 'shadowlap verify', at }).verdict.verifyId;

describe("a fix's check, changed", () => {
  it('keeps every check it had, and leaves out the runs the newest one judged otherwise, links kept', () => {
    const [a, b, c, g] = [makeRun(store), makeRun(store), makeRun(store), makeRun(store, { labels: ['good'] })];
    const fix = blame(a);
    blame(b, { at: 2_100 });
    blame(c, { at: 2_200 });
    verdict([{ runId: a, role: 'target', pass: false, recorded: false }, { runId: g, role: 'good', pass: true }], EXPECT, ORACLE, 3_000);
    expect(fixRecords(store, store.getFix(fix.fixId)!).good).toEqual([g]);

    const before = store.changeCounts().fixes;
    const done = changeFixCheck(store, fix.fixId, { check: emailCheck, judged: { failing: { [a]: 'failed', [b]: 'passed', [c]: 'gone' }, good: { [g]: 'failed' } }, at: 4_000, actor: 'maya' });
    expect(done).toMatchObject({ changed: true, previous: fix.check, fix: { check: emailCheck, status: 'open' } });
    expect(store.changeCounts().fixes).toBeGreaterThan(before);

    const rec = fixRecords(store, done.fix);
    expect(rec.checks.map((x) => [x.position, x.at, x.actor, x.check.key])).toEqual([
      [0, 2_000, 'dana', fix.check.key],
      [1, 4_000, 'maya', emailCheck.key],
    ]);
    // A run gone from the store, or one its judge left open, stays the fix's.
    expect(rec.failing).toEqual([a, c]);
    expect(rec.good).toEqual([]);
    expect(rec.left).toEqual({ failing: [b], good: [g] });
    expect(store.fixLinks(fix.fixId, 'failing').map((l) => l.ref)).toEqual([a, b, c]);
    expect(runsLeft(rec.checks)).toEqual({ failing: new Set([b]), good: new Set([g]) });

    // A run that left fails in the fix no more; its labels leave with it.
    expect(fixOfRun(store, b)).toBeNull();
    expect(fixOfRun(store, a)?.fixId).toBe(fix.fixId);
    store.updateRunMeta(b, { labels: ['refunds'] });
    expect(fixLabelInfo(store, rec.fix).labels).toEqual([]);

    // The SQL readers' condition says the same.
    const left = store.query(`SELECT l.ref AS ref FROM fix_links l WHERE l.fix_id = ? AND l.kind IN ('failing', 'good') AND ${leftFixLinkSql('l')} ORDER BY l.ref`, fix.fixId).map((r) => String(r.ref));
    expect(left).toEqual([b, g].sort());
    const kept = store.query(`SELECT l.ref AS ref FROM fix_links l WHERE l.fix_id = ? AND l.kind IN ('failing', 'good') AND NOT ${leftFixLinkSql('l')} ORDER BY l.ref`, fix.fixId).map((r) => String(r.ref));
    expect(kept).toEqual([a, c].sort());

    // A run that joins after the change stays, as the check never judged it.
    const d = makeRun(store);
    blame(d, { expect: EMAIL, at: 5_000 });
    expect(fixRecords(store, store.getFix(fix.fixId)!).failing).toEqual([a, c, d]);
  });

  it('finds in SQL the runs that left by their ids, whatever those hold, and none before a check judged them', () => {
    const a = makeRun(store);
    const fix = blame(a);
    const odd = ['run "quoted"', 'run\\slashed', 'run.dotted'];
    for (const ref of odd) store.addFixLink(fix.fixId, 'failing', ref, 2_500);
    const kept = () => store.query(`SELECT l.ref AS ref FROM fix_links l WHERE l.fix_id = ? AND l.kind = 'failing' AND NOT ${leftFixLinkSql('l')} ORDER BY l.ref`, fix.fixId).map((r) => String(r.ref));
    // Its first check judged none of them: every run stays.
    expect(kept()).toEqual([a, ...odd].sort());
    changeFixCheck(store, fix.fixId, { check: emailCheck, judged: { failing: { [a]: 'failed', [odd[0]]: 'passed', [odd[1]]: 'passed', [odd[2]]: 'failed' }, good: {} }, at: 3_000 });
    expect(kept()).toEqual([a, odd[2]].sort());
    expect([...runsLeft(store.fixChecks(fix.fixId)).failing].sort()).toEqual([odd[0], odd[1]].sort());
  });

  it('writes nothing for the check it has, and refuses a fix that is not open or not there', () => {
    const a = makeRun(store);
    const fix = blame(a);
    const count = store.changeCounts().fixes;
    expect(changeFixCheck(store, fix.fixId, { check: { ...fix.check, text: 'other words' }, judged: { failing: { [a]: 'failed' }, good: {} } })).toMatchObject({ changed: false });
    expect(store.changeCounts().fixes).toBe(count);
    expect(store.fixChecks(fix.fixId)).toHaveLength(1);

    store.updateFix(fix.fixId, { status: 'verified', verifiedAt: 3_000 });
    expect(() => changeFixCheck(store, fix.fixId, { check: emailCheck, judged: { failing: {}, good: {} } })).toThrow(`${fix.fixId} is verified`);
    expect(() => changeFixCheck(store, 'fx-NOSUCHFIX', { check: emailCheck, judged: { failing: {}, good: {} } })).toThrow('unknown fix fx-NOSUCHFIX');
    expect(store.getFix(fix.fixId)?.check).toEqual(fix.check);
  });
});

describe('verdicts under a check the fix had before', () => {
  it('counts only those that cover the check as it is, and none comes to count that did not', () => {
    const [a, b] = [makeRun(store), makeRun(store)];
    const fix = blame(a);
    blame(b, { at: 2_100 });
    // Each kept counting, or not, under the fix's first check: rejected ones, so the fix stays open.
    const old = verdict([{ runId: a, role: 'target', pass: false, recorded: false }], EXPECT, ORACLE, 3_000);
    const both = verdict([{ runId: a, role: 'target', pass: false, recorded: false }], BOTH, BOTH_ORACLE, 3_100);
    const stricter = verdict([{ runId: a, role: 'target', pass: false, recorded: false }], { tools: { issue_refund: { count: 0, args: { amount: 240 } }, refund_log: 2 } }, [...ORACLE, 'refund_log called 2 times'], 3_200);
    const exitOnly = verdict([{ runId: a, role: 'target', pass: false, recorded: false }], null, ['the agent exits 0'], 3_300);
    const onB = verdict([{ runId: b, role: 'target', pass: false, recorded: false }], BOTH, BOTH_ORACLE, 3_400);
    const before = fixRecords(store, store.getFix(fix.fixId)!);
    expect([old, both, stricter, onB].map((id) => before.standing.get(id))).toEqual(Array(4).fill({ counts: true, why: null }));
    expect(before.standing.get(exitOnly)).toEqual({ counts: false, why: 'another-check', missing: [ORACLE[1]] });

    changeFixCheck(store, fix.fixId, { check: emailCheck, judged: { failing: { [a]: 'failed', [b]: 'passed' }, good: {} }, at: 4_000 });
    const rec = fixRecords(store, store.getFix(fix.fixId)!);
    // Made under the check the fix had: kept, and no longer counted.
    expect(rec.standing.get(old)).toEqual({ counts: false, why: 'old-check', missing: [EMAIL_LABEL] });
    // A check the fix never had that covers the one it has still counts; one that doesn't reads another check's.
    expect(rec.standing.get(both)).toEqual({ counts: true, why: null });
    expect(rec.standing.get(stricter)).toEqual({ counts: false, why: 'another-check', missing: [EMAIL_LABEL] });
    // What another check leaves out is named against the check as it is.
    expect(rec.standing.get(exitOnly)).toEqual({ counts: false, why: 'another-check', missing: [EMAIL_LABEL] });
    // One whose failing runs all left: none of its runs fails in the fix.
    expect(rec.standing.get(onB)).toEqual({ counts: false, why: 'no-runs' });

    expect(madeUnderOldCheck(rec, rec.verdicts.find((v) => v.verifyId === old)!)).toMatchObject({ position: 0, check: { key: fix.check.key } });
    expect(madeUnderOldCheck(rec, { expect: EMAIL })).toBeNull();
    expect(madeUnderOldCheck(rec, { expect: BOTH })).toBeNull();

    // Back to the first check: what was made under it counts again, and the runs judged under it are back.
    changeFixCheck(store, fix.fixId, { check: fix.check, judged: { failing: { [a]: 'failed', [b]: 'failed' }, good: {} }, at: 5_000 });
    const back = fixRecords(store, store.getFix(fix.fixId)!);
    expect(back.standing.get(old)).toEqual({ counts: true, why: null });
    expect(back.standing.get(onB)).toEqual({ counts: true, why: null });
    expect(back.failing).toEqual([a, b]);
    expect(madeUnderOldCheck(back, { expect: EMAIL })).toMatchObject({ position: 1 });
  });

  it('shows a blame made under the check the fix has, once it has changed, else the blame it showed', () => {
    const [a, b] = [makeRun(store), makeRun(store)];
    const fix = blame(a);
    changeFixCheck(store, fix.fixId, { check: emailCheck, judged: { failing: { [a]: 'failed' }, good: {} }, at: 3_000 });
    let rec = fixRecords(store, store.getFix(fix.fixId)!);
    expect(shownBlame(rec)?.runId).toBe(a);
    // Blamed again under the fix's check, stopped part way: it is the one shown, not the old one that found a call.
    recordBlame(store, { runId: b, report: blameReport(b, 'stopped'), expect: EMAIL, scope: null, command: 'shadowlap blame', title: 't', checkText: 'send_email called 1 time', at: 4_000, actor: 'maya', ci: null });
    rec = fixRecords(store, store.getFix(fix.fixId)!);
    expect(rec.blames).toHaveLength(2);
    expect(shownBlame(rec)?.runId).toBe(b);
    // A fix whose check never changed shows the latest that found a call.
    const c = makeRun(store);
    const other = blame(c, { expect: BOTH, at: 5_000 });
    recordBlame(store, { runId: c, report: blameReport(c, 'stopped'), expect: { tools: { refund_log: 1 } }, scope: null, command: 'shadowlap blame', title: 't', checkText: 'x', at: 6_000, actor: 'dana', ci: null });
    expect(shownBlame(fixRecords(store, store.getFix(other.fixId)!))?.outcome).toBe('blamed');
  });
});

describe('a store made before fix_checks.judged', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('gains the column on open, and its fix takes a check and leaves out the runs it judged otherwise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-fix-check-'));
    dirs.push(dir);
    const path = join(dir, 'shadowlap.db');
    const first = Store.open(path);
    const [a, b] = [makeRun(first), makeRun(first)];
    const fix = recordBlame(first, { runId: a, report: blameReport(a), expect: EXPECT, scope: null, command: 'shadowlap blame', title: 't', checkText: 'c', at: 2_000, actor: 'dana', ci: null }).fix;
    recordBlame(first, { runId: b, report: blameReport(b), expect: EXPECT, scope: null, command: 'shadowlap blame', title: 't', checkText: 'c', at: 2_100, actor: 'dana', ci: null });
    first.close();
    const raw = new DatabaseSync(path);
    raw.exec(`ALTER TABLE fix_checks DROP COLUMN judged`);
    raw.close();

    const second = Store.open(path);
    try {
      expect(second.fixChecks(fix.fixId)).toEqual([expect.objectContaining({ position: 0, judged: null })]);
      changeFixCheck(second, fix.fixId, { check: emailCheck, judged: { failing: { [a]: 'failed', [b]: 'passed' }, good: {} }, at: 3_000 });
      const rec = fixRecords(second, second.getFix(fix.fixId)!);
      expect([rec.failing, rec.left.failing]).toEqual([[a], [b]]);
    } finally {
      second.close();
    }
  });
});
