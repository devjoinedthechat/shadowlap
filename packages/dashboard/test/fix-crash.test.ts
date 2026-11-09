import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { blameReport } from '../../engine/test/fix-fixtures.js';
import { fixDetail } from '../src/fixes.js';
import { fixesView } from '../src/fixes-view.js';
import { crashFixtures, GOLDEN, MIN, source, T0, work } from './crash-fixtures.js';

/**
 * A fix's crash path: where blame found no call that rescues a test replay whose agent exited with an
 * error, the run's own step leads the fix, on its page and its Fixes row, before a stronger model:
 * Find breaking commit, then Revert once that named the commit, which the Blame step shows as every
 * route serves a found commit (its author only where names are shown). A failure that didn't crash
 * keeps the fix's own lead.
 */

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => store.close());

const { tested, named, blamed, detail } = crashFixtures(() => store);

describe('a fix whose crash no model rescued', () => {
  it('leads with Find breaking commit on its page and its Fixes row, before the stronger model, its search offline and free', () => {
    const { rec, run, fixId } = blamed();
    const w = work([source(rec)]);
    const d = detail(fixId, w);
    expect(d.lead).toMatchObject({ key: 'bisect', use: 'reads', runId: run, step: { key: 'bisect', golden: GOLDEN } });
    expect(d.lead!.label).toMatch(/^Find breaking commit/);
    expect(d.blame!.crash).toEqual({ commit: null, offline: true, stronger: false });
    expect(fixesView(store, { next: w }).fixes[0].next).toMatchObject({ key: 'bisect', runId: run });
    // A golden marked fork runs live from where it forks: its search is not offline.
    expect(detail(fixId, work([source(rec, { mode: 'fork' })])).blame!.crash).toMatchObject({ offline: false });
  });

  it('leads with Revert once Find breaking commit named the commit, the Blame step showing it, its author only where names are shown', () => {
    const { rec, run, fixId } = blamed('crashed', { stronger: true });
    named(T0 + 2 * MIN);
    const w = work([source(rec)]);
    const d = detail(fixId, w);
    expect(d.lead).toMatchObject({ key: 'revert', label: 'Revert', use: 'writes', runId: run, command: `git revert --no-commit ccccccc && shadowlap test ${GOLDEN}`, step: { key: 'revert', rev: 'ccccccc', golden: GOLDEN } });
    expect(d.blame!.crash).toMatchObject({ commit: { rev: 'ccccccc', subject: 'Log the total', author: '' }, offline: true, stronger: true });
    expect(detail(fixId, w, true).blame!.crash!.commit!.author).toBe('Ravi');
    // The list's row leads the same way, and carries no commit: its Revert reads the run's when pressed.
    expect(fixesView(store, { next: w }).fixes[0].next).toMatchObject({ key: 'revert', runId: run, step: { rev: 'ccccccc' } });
  });

  it('keeps the fix’s own lead where the run didn’t crash, the run page isn’t read, or a later replay passed it', () => {
    const diverged = blamed('diverged');
    const w = work([source(diverged.rec)]);
    expect(detail(diverged.fixId, w).lead?.key).not.toMatch(/^(bisect|revert)$/);
    expect(detail(diverged.fixId, w).blame!.crash).toBeNull();
    store.close();
    store = Store.open(':memory:');
    const { rec, fixId } = blamed();
    // Without the next step's work (a copy, a CLI caller), nothing is read for it.
    expect(fixDetail(store, fixId)!.lead?.key).not.toMatch(/^(bisect|revert)$/);
    expect(fixDetail(store, fixId)!.blame!.crash).toBeNull();
    tested(rec, T0 + 4 * MIN, 'passed');
    expect(detail(fixId, work([source(rec)])).lead?.key).not.toMatch(/^(bisect|revert)$/);
  });
});

describe('a crash whose blame found something of its own', () => {
  /** The crash's blame, inconclusive at its first model call: its first probe couldn't tell. */
  const unsettled = { probes: blameReport('x', 'unrescuable').probes.map((p) => ({ ...p, decision: 'inconclusive' as const })) };
  const failedWrite = { failedWrite: { name: 'write_file', message: 'EACCES: permission denied', callNo: 1 } };

  it('leads with Run blame again where its first probe couldn’t tell, with no crash path on its page or its row, even once the commit is named', () => {
    const { rec, fixId } = blamed('crashed', { rerun: true, report: unsettled });
    named(T0 + 2 * MIN);
    const w = work([source(rec)]);
    const d = detail(fixId, w);
    expect(d.lead?.key).toBe('blame-again');
    expect(d.blame!.crash).toBeNull();
    // Blame's own words on what settles it, as `shadowlap blame` prints them.
    expect(d.blame!.look).not.toBeNull();
    expect(fixesView(store, { next: w }).fixes[0].next?.key).toBe('blame-again');
  });

  it('leads with Find breaking commit where no answer of the model’s lost the run, offering no stronger model, its Blame step keeping blame’s own finding', () => {
    const { rec, fixId } = blamed('crashed', { rerun: true, report: failedWrite });
    const d = detail(fixId, work([source(rec)]));
    expect(d.lead?.key).toBe('bisect');
    expect(d.actions.blameStronger).toBeNull();
    expect(d.blame!.look).toBe("No answer of the model's lost this run: look at the tools, the harness or the command.");
    expect(d.blame!.crash).toEqual({ commit: null, offline: true, stronger: false });
  });

  it('offers the stronger model beside Find breaking commit where its blame kept its flags, and leads with the search', () => {
    const { rec, fixId } = blamed('crashed', { rerun: true });
    const d = detail(fixId, work([source(rec)]));
    expect(d.lead?.key).toBe('bisect');
    expect(d.actions.blameStronger).not.toBeNull();
  });
});
