import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixRecords, recordBlame, recordRepair, recordVerdict, repairArgv, Store, verifyArgv } from '../src/index.js';
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
