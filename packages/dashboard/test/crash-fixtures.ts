import { type BlameReport, recordBlame, recordEvent, type Store, type StoredBlame } from '@shadowlap/engine';
import { blameReport } from '../../engine/test/fix-fixtures.js';
import { fixCrash } from '../src/fix-crash.js';
import { fixDetail } from '../src/fixes.js';
import { stepReads, type NextStepWork } from '../src/next-step.js';
import type { GoldenSource } from '../src/tests.js';
import { addRun } from './read-model-store.js';

/**
 * A crash no model rescued, in a store built here: a golden's test replay whose agent exited with an
 * error, blamed with no call that rescues it, its fix, and what Find breaking commit named for it.
 * The server's tests (fix-crash.test.ts) and the UI's (ui-fix-crash.test.ts) read the same.
 */

export const T0 = 1_790_000_000_000;
export const MIN = 60_000;
export const GOLDEN = 'goldens/refund-in-limit';
const EXPECT = { calls: [{ tool: 'issue_refund', times: 0 }] };

/** The lines a crashed agent printed last, as its result keeps them: a Python traceback raised in the project's own code, at the line the commit Find breaking commit names added. */
export const PY_TAIL = ['Traceback (most recent call last):', '  File "/work/project/agent/main.py", line 30, in <module>', '    print(total(order["items"]))', '  File "/work/project/agent/refund.py", line 2, in total', '    log(items)', "NameError: name 'log' is not defined"].join('\n');

export const source = (runId: string, o: Partial<GoldenSource> = {}): GoldenSource => ({ path: GOLDEN, runId, packedAt: T0, mode: 'replay', repeat: 1, passes: 1, checks: [], ...o });
export const work = (goldens: GoldenSource[]): NextStepWork => ({ goldens, tests: undefined, normalize: undefined, dir: '/work/project' });

/** The fixtures for the store `of` gives, open for the test that calls them. */
export function crashFixtures(of: () => Store) {
  /** A session of the golden, with its replay: passed, crashed (its agent exited, having printed `output` last), or failed a check. */
  function tested(parent: string, at: number, how: 'passed' | 'crashed' | 'diverged', output?: string): string {
    const revision = how === 'passed' ? 'aaaaaaa' : 'bbbbbbb';
    const session = of().startTestSession({ command: ['shadowlap', 'test', GOLDEN], startedAt: at, revision }).sessionId;
    const ok = how === 'passed';
    const run = addRun(of(), { parent, startedAt: at, ...(ok ? {} : { status: 'failed' as const }), calls: ok ? 'r' : 'rl', meta: { test: { golden: GOLDEN, session } } });
    const failure = how === 'crashed' ? { failure: 'exit' as const, reason: 'the agent exited with code 1' } : how === 'diverged' ? { failure: 'diverged' as const, reason: 'call #2 changed' } : {};
    of().addTestResult({ sessionId: session, golden: GOLDEN, ok, ...failure, runId: run, goldenRunId: parent, revision, at, ...(output ? { data: { output } } : {}) });
    return run;
  }

  /** What Find breaking commit named for the crash at `at`, half a minute later, with the change it kept (`change`, as bisect keeps it), or none. */
  function named(at: number, change: Record<string, unknown> | null = null): void {
    recordEvent(of(), { kind: 'bisect.found', ref: GOLDEN, at: at + 30_000, data: { commit: 'ccccccc', first: { rev: 'ccccccc', subject: 'Log the total', author: 'Ravi', date: '2026-09-30T10:00:00Z', ...(change ? { change } : {}) }, why: 'the agent exited with code 1', untested: [], replays: 3, tokens: 0, answered: { at, ok: false } } });
  }

  /**
   * The crash, blamed with no call that rescues it (`stronger`: by a stronger model; `report`: what
   * else its report found; `output`: what its agent printed last), and its fix. With `rerun`, the
   * blame kept its flags, so the fix offers blame's next step (Run blame again, or with a stronger
   * model) where blame's rules do.
   */
  function blamed(how: 'crashed' | 'diverged' = 'crashed', o: { stronger?: boolean; rerun?: boolean; report?: Partial<BlameReport>; output?: string } = {}) {
    const rec = addRun(of(), { startedAt: T0, calls: 'lll' });
    tested(rec, T0 + MIN, 'passed');
    const run = tested(rec, T0 + 2 * MIN, how, o.output);
    const report = { ...blameReport(run, 'unrescuable'), ...(o.stronger ? { rescue: { fields: { model: 'claude-opus-5-5' } } } : {}), ...o.report };
    const { fix, blame } = recordBlame(of(), { runId: run, report, expect: EXPECT, scope: null, command: 'shadowlap blame', ...(o.rerun ? { rerun: { flags: [], command: null } } : {}), title: 'The agent exited', checkText: 'issue_refund never called', at: T0 + 3 * MIN });
    return { rec, run, fixId: fix.fixId, blame };
  }

  const detail = (fixId: string, w: NextStepWork, names = false) => fixDetail(of(), fixId, { crash: (b: StoredBlame) => fixCrash(of(), b, { work: w, reads: stepReads(of()), serving: { project: null, names, top: null }, error: true }) })!;
  return { tested, named, blamed, detail };
}
