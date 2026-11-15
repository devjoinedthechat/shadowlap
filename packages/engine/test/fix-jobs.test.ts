import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixRecords, noFixReason, recordBlame, recordRepair, recordVerdict, repairArgv, Store, verifyArgv, type BlameReport } from '../src/index.js';
import { blameReport, EXPECT, makeRun, repairReport, verifyReport } from './fix-fixtures.js';

/**
 * The verify a fix's Verify step and the terminal UI's V run: the runs a repair held out from its
 * repairer are verified as held out, so a change is tried on failing runs it was not written for.
 */

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => {
  store.close();
});

const CHECK = ['--expect', JSON.stringify(EXPECT)];

function blame(runId: string) {
  return recordBlame(store, { runId, report: blameReport(runId), expect: EXPECT, scope: null, command: `shadowlap blame ${runId.slice(0, 10)}`, title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}' });
}

/** A repair that accepted nothing, which ran at `at`: its targets shown to its repairer, the others held out. */
function repaired(targets: string[], holdout: string[], at: number): void {
  recordRepair(store, { repairId: `repair-${at}`, dir: `.shadowlap/repairs/repair-${at}`, report: repairReport({ targets, holdout, accepted: false }), expect: EXPECT, command: 'shadowlap repair --fixes label:refund-bug', at });
}

describe('a verify from a fix', () => {
  it('holds out the runs a repair or a verify of the fix held out, until a repair shows one to its repairer', () => {
    const [a, b, c, d] = [1, 2, 3, 4].map(() => makeRun(store, { labels: ['refund-bug'] }));
    const { fix } = blame(a);
    for (const run of [b, c, d]) blame(run);
    const rec = () => fixRecords(store, store.getFix(fix.fixId)!);
    // Nothing held out yet, as in a fix whose change was written by hand: its label names its failing runs.
    expect(verifyArgv(store, rec())).toEqual(['verify', '--fixes', 'label:refund-bug', ...CHECK]);
    repaired([a, c], [b, d], 10);
    expect(verifyArgv(store, rec())).toEqual(['verify', '--fixes', a, c, '--holdout', b, d, ...CHECK]);
    // A verify shows a run to no one: one that named every run a target leaves b and d held out.
    recordVerdict(store, { report: verifyReport([a, b, c, d].map((runId) => ({ runId, role: 'target' as const, pass: false }))), expect: EXPECT, command: 'shadowlap verify --fixes label:refund-bug', at: 20 });
    expect(verifyArgv(store, rec())).toEqual(['verify', '--fixes', a, c, '--holdout', b, d, ...CHECK]);
    // A repair since showed d to its repairer, and held c out from it.
    repaired([a, d], [b, c], 30);
    expect(verifyArgv(store, rec())).toEqual(['verify', '--fixes', a, d, '--holdout', b, c, ...CHECK]);
    // A repair from the fix is given every failing run, and holds every other one out itself.
    expect(repairArgv(store, rec())).toEqual(['repair', '--fixes', 'label:refund-bug', ...CHECK]);
  });

  it('names the runs to fix by their label only when it names no held-out run, and holds none out with no run to fix left', () => {
    const [a, c] = [makeRun(store, { labels: ['refund-bug'] }), makeRun(store, { labels: ['refund-bug'] })];
    const b = makeRun(store, { labels: ['refund-bug-eu'] });
    const { fix } = blame(a);
    blame(c);
    repaired([a, c], [b], Date.now() + 1);
    const rec = () => fixRecords(store, store.getFix(fix.fixId)!);
    expect(verifyArgv(store, rec())).toEqual(['verify', '--fixes', 'label:refund-bug', '--holdout', b, ...CHECK]);
    // The runs it was written for are gone: b is verified as a run to fix.
    store.deleteRun(a);
    store.deleteRun(c);
    expect(verifyArgv(store, rec())).toEqual(['verify', '--fixes', 'label:refund-bug-eu', ...CHECK]);
  });
});

describe('a repair from a fix', () => {
  /** A blame of `runId` kept with its fix, rescuing by the request fields given, the run keeping it as its own (`meta.blame`). */
  const blamedWith = (runId: string, report: BlameReport, rescuedRunId: string | null = null) => {
    const kept = recordBlame(store, { runId, report, expect: EXPECT, scope: null, command: `shadowlap blame ${runId.slice(0, 10)}`, title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}' });
    store.updateRunMeta(runId, { blame: { at: 2, outcome: report.outcome, callNo: report.blamed?.callNo ?? null, confidence: 'high', rescuedRunId, fields: report.rescue.fields, oracle: report.oracle, probes: [], spent: 0.03 } });
    return kept.fix.fixId;
  };

  it('rescues as the blame it shows did: the request fields it set, and a stronger model it was asked with, which the repair blames with where asking again rescues nothing', () => {
    const run = makeRun(store, { labels: ['refund-bug'] });
    blamedWith(run, { ...blameReport(run, 'unrescuable'), rescue: { fields: { temperature: 1 } } });
    const rescued = makeRun(store, {});
    const found = blameReport(run);
    const fixId = blamedWith(run, { ...found, rescue: { fields: { temperature: 1, model: 'claude-opus-5-5' } }, contrast: { ...found.contrast!, rescuedRunId: rescued } }, rescued);
    const rec = () => fixRecords(store, store.getFix(fixId)!);
    expect(repairArgv(store, rec())).toEqual(['repair', '--fixes', 'label:refund-bug', '--set', 'temperature=1', '--stronger', 'claude-opus-5-5', ...CHECK]);
    // Both blames are reused: asking the recorded model again rescued nothing, the stronger model did, so the repair has a path to learn from.
    expect(noFixReason(store, rec(), null)).toBeNull();
  });

  it('ends "No fix to try" where neither asking again nor the stronger model rescued the run, and runs nothing it can’t say safely', () => {
    const run = makeRun(store, { labels: ['refund-bug'] });
    blamedWith(run, blameReport(run, 'unrescuable'));
    const fixId = blamedWith(run, { ...blameReport(run, 'unrescuable'), rescue: { fields: { model: 'claude-opus-5-5' } } });
    const rec = () => fixRecords(store, store.getFix(fixId)!);
    expect(repairArgv(store, rec())).toEqual(['repair', '--fixes', 'label:refund-bug', '--stronger', 'claude-opus-5-5', ...CHECK]);
    expect(noFixReason(store, rec(), null)).toMatchObject({ kind: 'unrescued' });
    // A model that reads as a flag, or a field that would hide part of the command: no repair from here.
    const odd = makeRun(store, { labels: ['odd-bug'] });
    const oddFix = blamedWith(odd, { ...blameReport(odd, 'unrescuable'), rescue: { fields: { model: '--help' } } });
    expect(repairArgv(store, fixRecords(store, store.getFix(oddFix)!))).toEqual([]);
    const hidden = makeRun(store, { labels: ['hidden-bug'] });
    const hiddenFix = blamedWith(hidden, { ...blameReport(hidden, 'unrescuable'), rescue: { fields: { stop: 'a\u202eb' } } });
    expect(repairArgv(store, fixRecords(store, store.getFix(hiddenFix)!))).toEqual([]);
  });
});
