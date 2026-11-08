import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordEvent, Store } from '@shadowlap/engine';
import { nextStepOf, pricedNextStep, type NextStepWork } from '../src/next-step.js';
import { crashCommit } from '../src/run-offers.js';
import type { GoldenSource } from '../src/tests.js';
import { addRun } from './read-model-store.js';

/**
 * Once Find breaking commit named a crash's commit, Revert leads its run's next step (next-step.ts):
 * the commit undone in the working tree, then its golden tested, Run blame plain beside it; and the
 * run's offers carry the commit, for the finding that leads (run-offers.ts `crashCommit`).
 */

const T0 = 1_790_000_000_000;
const MIN = 60_000;
const GOLDEN = 'goldens/refund-in-limit';

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => store.close());

const source = (runId: string | null, o: Partial<GoldenSource> = {}): GoldenSource => ({ path: GOLDEN, runId, packedAt: T0, mode: 'replay', repeat: 1, passes: 1, checks: [], ...o });
const work = (goldens: GoldenSource[]): NextStepWork => ({ goldens, tests: undefined, normalize: undefined, dir: '/work/project' });
const step = (id: string, w: NextStepWork) => nextStepOf(store, id, w)!;

/** A session of the golden at a revision, with its replay: passed, or crashed (its agent exited). */
function tested(parent: string, at: number, o: { ok: boolean; revision?: string }): string {
  const revision = o.revision ?? (o.ok ? 'aaaaaaa' : 'bbbbbbb');
  const session = store.startTestSession({ command: ['shadowlap', 'test', GOLDEN], startedAt: at, revision }).sessionId;
  const run = addRun(store, { parent, startedAt: at, ...(o.ok ? {} : { status: 'failed' as const }), calls: o.ok ? 'r' : 'rl', meta: { test: { golden: GOLDEN, session } } });
  store.addTestResult({ sessionId: session, golden: GOLDEN, ok: o.ok, ...(o.ok ? {} : { failure: 'exit' as const, reason: 'the agent exited with code 1' }), runId: run, goldenRunId: parent, revision, at });
  return run;
}

/** What Find breaking commit named for the crash at `at`, half a minute later: `ccccccc`, with its change where given. */
function named(at: number, change?: Record<string, unknown>): void {
  recordEvent(store, { kind: 'bisect.found', ref: GOLDEN, at: at + 30_000, data: { commit: 'ccccccc', first: { rev: 'ccccccc', subject: 'Log the total', author: 'Ravi', date: '2026-09-30T10:00:00Z', ...(change ? { change } : {}) }, why: 'the agent exited with code 1', untested: [], replays: 3, tokens: 0, answered: { at, ok: false } } });
}

describe('Revert, once a crash’s commit is named', () => {
  it('leads with the commit undone and the golden replayed offline, Run blame plain beside it', () => {
    const rec = addRun(store, { startedAt: T0, calls: 'lll' });
    tested(rec, T0 + MIN, { ok: true });
    const crash = tested(rec, T0 + 2 * MIN, { ok: false });
    named(T0 + 2 * MIN);
    expect(step(crash, work([source(rec)]))).toMatchObject({
      key: 'revert',
      label: 'Revert',
      golden: GOLDEN,
      rev: 'ccccccc',
      merge: false,
      title: 'Revert ccccccc',
      sub: `Log the total: undone in your working tree, then ${GOLDEN} replayed offline`,
      command: `git revert --no-commit ccccccc && shadowlap test ${GOLDEN}`,
      blame: { offer: { from: 'exit' }, sub: 'Whether an answer of the model’s lost the run' },
    });
  });

  it('reverts a merge against its first parent, and says a golden that runs live is tested', () => {
    const rec = addRun(store, { startedAt: T0, calls: 'lll' });
    tested(rec, T0 + MIN, { ok: true });
    const crash = tested(rec, T0 + 2 * MIN, { ok: false });
    named(T0 + 2 * MIN, { file: 'agent.py', files: ['agent.py'], hunk: '@@ -1 +1 @@\n-a\n+b', line: 1, cut: false, merge: true });
    expect(step(crash, work([source(rec, { mode: 'fork' })]))).toMatchObject({ key: 'revert', merge: true, command: `git revert --no-commit -m 1 ccccccc && shadowlap test ${GOLDEN}`, sub: `Log the total: undone in your working tree, then ${GOLDEN} tested` });
  });

  it('is priced as Re-run test, free where nothing runs live, with the Run blame beside it priced', async () => {
    const rec = addRun(store, { startedAt: T0, calls: 'lll' });
    tested(rec, T0 + MIN, { ok: true });
    const crash = tested(rec, T0 + 2 * MIN, { ok: false });
    named(T0 + 2 * MIN);
    const s = await pricedNextStep(store, crash, work([source(rec)]), { judged: undefined, kept: () => true });
    expect(s).toMatchObject({ key: 'revert', estimate: { kind: 'tests', usd: 0, parts: ['replays offline'] }, blame: { estimate: { kind: 'blame' } } });
  });

  it('gives way to Open passing run once a later replay passed, and to blame once the golden was tested since with changes on top', () => {
    const rec = addRun(store, { startedAt: T0, calls: 'lll' });
    tested(rec, T0 + MIN, { ok: true });
    const crash = tested(rec, T0 + 2 * MIN, { ok: false });
    named(T0 + 2 * MIN);
    // Tested again since the answer on a tree with changes on top of a commit: reverted by hand, or other work.
    tested(rec, T0 + 4 * MIN, { ok: false, revision: 'bbbbbbb+dirty' });
    expect(step(crash, work([source(rec)]))).toMatchObject({ key: 'blame' });
    const passed = tested(rec, T0 + 5 * MIN, { ok: true, revision: 'bbbbbbb+dirty' });
    expect(step(crash, work([source(rec)]))).toMatchObject({ key: 'passing', runId: passed });
  });

  it('names no commit that is no commit', () => {
    const rec = addRun(store, { startedAt: T0, calls: 'lll' });
    tested(rec, T0 + MIN, { ok: true });
    const crash = tested(rec, T0 + 2 * MIN, { ok: false });
    recordEvent(store, { kind: 'bisect.found', ref: GOLDEN, data: { first: { rev: '--output=x', subject: 's', author: 'a', date: 'd' }, why: 'exit', answered: { at: T0 + 2 * MIN, ok: false } } });
    expect(step(crash, work([source(rec)])).key).not.toBe('revert');
  });
});

describe('a crash’s commit in its run’s offers', () => {
  it('is the standing answer’s, with its change, for a crashed replay no later one fixed', () => {
    const rec = addRun(store, { startedAt: T0, calls: 'lll' });
    const pass = tested(rec, T0 + MIN, { ok: true });
    const crash = tested(rec, T0 + 2 * MIN, { ok: false });
    expect(crashCommit(store, store.getRun(crash)!)).toBeNull();
    named(T0 + 2 * MIN, { file: 'agent.py', files: ['agent.py', 'docs/x.md'], hunk: '@@ -1 +1 @@\n-a\n+b', line: 1, cut: false, merge: false });
    expect(crashCommit(store, store.getRun(crash)!)).toMatchObject({ rev: 'ccccccc', subject: 'Log the total', change: { file: 'agent.py', files: ['agent.py', 'docs/x.md'], line: 1, path: null, outside: 0 } });
    // Not for a run that passed, nor once a later replay passed.
    expect(crashCommit(store, store.getRun(pass)!)).toBeNull();
    tested(rec, T0 + 3 * MIN, { ok: true });
    expect(crashCommit(store, store.getRun(crash)!)).toBeNull();
  });
});
