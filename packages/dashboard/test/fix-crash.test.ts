import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordBlame, recordEvent, Store, type StoredBlame } from '@shadowlap/engine';
import { blameReport } from '../../engine/test/fix-fixtures.js';
import { fixCrash } from '../src/fix-crash.js';
import { fixDetail } from '../src/fixes.js';
import { fixesView } from '../src/fixes-view.js';
import { stepReads, type NextStepWork } from '../src/next-step.js';
import type { GoldenSource } from '../src/tests.js';
import { addRun } from './read-model-store.js';

/**
 * A fix's crash path: where blame found no call that rescues a test replay whose agent exited with an
 * error, the run's own step leads the fix, on its page and its Fixes row, before a stronger model:
 * Find breaking commit, then Revert once that named the commit, which the Blame step shows as every
 * route serves a found commit (its author only where names are shown). A failure that didn't crash
 * keeps the fix's own lead.
 */

const T0 = 1_790_000_000_000;
const MIN = 60_000;
const GOLDEN = 'goldens/refund-in-limit';
const EXPECT = { calls: [{ tool: 'issue_refund', times: 0 }] };

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => store.close());

const source = (runId: string, o: Partial<GoldenSource> = {}): GoldenSource => ({ path: GOLDEN, runId, packedAt: T0, mode: 'replay', repeat: 1, passes: 1, checks: [], ...o });
const work = (goldens: GoldenSource[]): NextStepWork => ({ goldens, tests: undefined, normalize: undefined, dir: '/work/project' });

/** A session of the golden, with its replay: passed, crashed (its agent exited), or failed a check. */
function tested(parent: string, at: number, how: 'passed' | 'crashed' | 'diverged'): string {
  const revision = how === 'passed' ? 'aaaaaaa' : 'bbbbbbb';
  const session = store.startTestSession({ command: ['shadowlap', 'test', GOLDEN], startedAt: at, revision }).sessionId;
  const ok = how === 'passed';
  const run = addRun(store, { parent, startedAt: at, ...(ok ? {} : { status: 'failed' as const }), calls: ok ? 'r' : 'rl', meta: { test: { golden: GOLDEN, session } } });
  const failure = how === 'crashed' ? { failure: 'exit' as const, reason: 'the agent exited with code 1' } : how === 'diverged' ? { failure: 'diverged' as const, reason: 'call #2 changed' } : {};
  store.addTestResult({ sessionId: session, golden: GOLDEN, ok, ...failure, runId: run, goldenRunId: parent, revision, at });
  return run;
}

/** What Find breaking commit named for the crash at `at`, half a minute later. */
function named(at: number): void {
  recordEvent(store, { kind: 'bisect.found', ref: GOLDEN, at: at + 30_000, data: { commit: 'ccccccc', first: { rev: 'ccccccc', subject: 'Log the total', author: 'Ravi', date: '2026-09-30T10:00:00Z' }, why: 'the agent exited with code 1', untested: [], replays: 3, tokens: 0, answered: { at, ok: false } } });
}

/** The crash, blamed with no call that rescues it (`stronger`: by a stronger model), and its fix. */
function blamed(how: 'crashed' | 'diverged' = 'crashed', o: { stronger?: boolean } = {}) {
  const rec = addRun(store, { startedAt: T0, calls: 'lll' });
  tested(rec, T0 + MIN, 'passed');
  const run = tested(rec, T0 + 2 * MIN, how);
  const report = { ...blameReport(run, 'unrescuable'), ...(o.stronger ? { rescue: { fields: { model: 'claude-opus-5-5' } } } : {}) };
  const { fix } = recordBlame(store, { runId: run, report, expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'The agent exited', checkText: 'issue_refund never called', at: T0 + 3 * MIN });
  return { rec, run, fixId: fix.fixId };
}

const detail = (fixId: string, w: NextStepWork, names = false) => fixDetail(store, fixId, { crash: (b: StoredBlame) => fixCrash(store, b, { work: w, reads: stepReads(store), serving: { project: null, names, top: null } }) })!;

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
