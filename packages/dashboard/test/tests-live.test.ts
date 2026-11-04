import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { goldenProviders } from '../src/ci-workflows.js';
import type { GoldenSource, TestsJob } from '../src/tests.js';
import { liveAsk, liveReasons, sessionLiveGoldens, testedGoldens } from '../src/tests-live.js';

/**
 * Which goldens a Tests job runs live, worked out from the goldens as the CLI lists them: the rule
 * by their tests entries, which Settings → CI says the same goldens by, and the goldens a test
 * command runs. The routes that ask before such a job are tests-routes.test.ts's.
 */

const at = (path: string, over: Partial<GoldenSource> = {}): GoldenSource => ({ path, runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: [], ...over });
const session = (...args: string[]): TestsJob => ({ title: 'Running tests', args: ['test', ...args] });

describe('what a session runs live', () => {
  it('reads which goldens a test command runs as the CLI expands it, and why each goes live', () => {
    const some = [at('goldens/a'), at('goldens/b-fork', { mode: 'fork' }), at('goldens/deeper/c'), at('evals/d'), at('80')];
    const paths = (args: string[]) => testedGoldens(some, args).map((g) => g.path);
    // The pattern matches within its last part only; a flag's value is no golden.
    expect(paths(['test', 'goldens/*', 'evals/d'])).toEqual(['goldens/a', 'goldens/b-fork', 'evals/d']);
    expect(paths(['test', 'goldens/b-*', '--max-attempts', '80', '--continue'])).toEqual(['goldens/b-fork']);
    expect(paths(['test', 'goldens/deeper/c', '--update'])).toEqual(['goldens/deeper/c']);
    expect(paths(['normalize', 'add', 'goldens/a'])).toEqual([]);
    expect(liveReasons(at('x'))).toEqual([]);
    expect(liveReasons(at('x', { mode: 'fork', judges: ['claude-haiku-4-5'], injection: true }))).toEqual([{ kind: 'fork' }, { kind: 'judges', models: ['claude-haiku-4-5'] }, { kind: 'injection' }]);
    // A replay golden's judges answer from its recording, offline.
    expect(liveReasons(at('x', { judges: ['claude-haiku-4-5'] }))).toEqual([]);
    // A pack that can't be read fails its test before anything runs: its entry says fork, and the session runs nothing of it live.
    const unreadable = at('goldens/e', { mode: 'fork', error: 'no run.json: not a pack' });
    expect(liveReasons(unreadable)).toEqual([{ kind: 'fork' }]);
    expect(sessionLiveGoldens([...some, unreadable], session('goldens/*'))).toEqual([{ path: 'goldens/b-fork', why: [{ kind: 'fork' }] }]);
  });

  it('goes by the rule Settings → CI says which goldens run live in CI by', () => {
    // A pack that can't be read still runs live in CI once it is fixed: Settings → CI names it by its entry.
    const list = [at('goldens/a'), at('goldens/b', { mode: 'fork', judges: ['claude-haiku-4-5'] }), at('goldens/c', { injection: true }), at('goldens/d', { judges: ['claude-haiku-4-5'] }), at('goldens/e', { mode: 'fork', injection: true }), at('goldens/f', { mode: 'fork', error: 'no run.json: not a pack' })];
    const named = { fork: ['fork'], injection: ['injection gate'], judges: [] } as const;
    expect(goldenProviders(tmpdir(), list).map((g) => g.live)).toEqual(list.map((g) => liveReasons(g).flatMap((w) => named[w.kind])));
    expect(goldenProviders(tmpdir(), list).map((g) => g.live)).toEqual([[], ['fork'], ['injection gate'], [], ['fork', 'injection gate'], ['fork']]);
  });
});

describe('the question a session asks', () => {
  const HAIKU = 'claude-haiku-4-5';
  const BILLED = 'Live calls are billed by your provider. Confirm it to run it';
  const words = (list: GoldenSource[]) => liveAsk(list, session('goldens/*'), undefined)?.error;

  it('names several goldens, then how many more, and says a fork’s judges in its clause only when every fork has them', () => {
    const forks = ['a', 'b', 'c', 'd', 'e'].map((n) => at(`goldens/${n}`, { mode: 'fork', judges: [HAIKU] }));
    expect(words(forks.slice(0, 2))).toBe(`goldens/a and goldens/b are marked fork, so they run live from where they fork, writes blocked, and ask their judges live (${HAIKU}). ${BILLED}`);
    expect(words(forks)).toBe(`goldens/a, goldens/b, goldens/c and 2 more are marked fork, so they run live from where they fork, writes blocked, and ask their judges live (${HAIKU}). ${BILLED}`);
    // Only one of two forks has a judge: its own clause says so.
    expect(words([forks[0], at('goldens/b', { mode: 'fork' }), at('goldens/c', { injection: true }), at('goldens/d', { injection: true })])).toBe(
      `goldens/a and goldens/b are marked fork, so they run live from where they fork, writes blocked; goldens/a asks its judges live (${HAIKU}); goldens/c and goldens/d have injection gates, which run live from each payload they plant, writes stubbed. ${BILLED}`,
    );
    // A replay golden's judges answer from its recording: nothing to ask.
    expect(words([at('goldens/a'), at('goldens/b', { judges: [HAIKU] })])).toBeUndefined();
  });

  it('asks again when what goes live changed between the question and the yes', () => {
    const before = [at('goldens/a', { mode: 'fork' }), at('goldens/b')];
    const q = liveAsk(before, session('goldens/*'), undefined)!;
    expect(liveAsk(before, session('goldens/*'), q.confirm)).toBeNull();
    // Its judge is asked live too, or another golden goes live: the yes was to neither.
    const judged = [at('goldens/a', { mode: 'fork', judges: [HAIKU] }), at('goldens/b')];
    const planted = [at('goldens/a', { mode: 'fork' }), at('goldens/b', { injection: true })];
    for (const now of [judged, planted]) {
      const again = liveAsk(now, session('goldens/*'), q.confirm);
      expect(again).toEqual({ error: words(now), status: 409, confirm: expect.stringMatching(/^[0-9a-f]{32}$/) });
      expect(again!.confirm).not.toBe(q.confirm);
    }
  });
});
