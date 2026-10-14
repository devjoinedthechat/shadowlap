import { describe, expect, it } from 'vitest';
import {
  binOrigins,
  checksOf,
  classifyRun,
  countOrigins,
  displayOrigin,
  isFailedOutcome,
  lostAt,
  notableOrigin,
  originCells,
  outcomeLabel,
  runOutcome,
  Store,
  type ClassifiableRun,
  type RunMeta,
} from '@shadowlap/engine';

const run = (over: Partial<ClassifiableRun> & { meta?: RunMeta | Record<string, unknown> } = {}): ClassifiableRun => ({
  runId: 'R',
  parentRunId: null,
  mode: 'record',
  status: 'completed',
  divergence: null,
  ...over,
});

const blame = (outcome: 'blamed' | 'unrescuable' | 'stopped', callNo: number | null, rescuedRunId: string | null = null) => ({
  at: 1,
  outcome,
  callNo,
  confidence: 'high' as const,
  rescuedRunId,
  fields: {},
  oracle: ['the agent exits 0'],
  probes: [],
  spent: 0,
});

describe('classifyRun: the kind of a run', () => {
  it('names recordings, forks, clean replays and other replays from mode and divergence', () => {
    expect(classifyRun(run())).toEqual({ kind: 'recording', attemptOf: null, attemptKind: null });
    expect(classifyRun(run({ mode: 'replay', parentRunId: 'P', divergence: { callNo: 17 } })).kind).toBe('fork');
    expect(classifyRun(run({ mode: 'replay', parentRunId: 'P' })).kind).toBe('clean');
    // A replay that never finished, failed before diverging, or made no calls is not a clean replay.
    expect(classifyRun(run({ mode: 'replay', parentRunId: 'P', status: 'running' })).kind).toBe('replay');
    expect(classifyRun(run({ mode: 'replay', parentRunId: 'P', status: 'failed' })).kind).toBe('replay');
    expect(classifyRun(run({ mode: 'replay', parentRunId: 'P' }), { calls: 0 }).kind).toBe('replay');
    expect(classifyRun(run({ mode: 'replay', parentRunId: 'P' }), { calls: 3 }).kind).toBe('clean');
  });

  it('names captures, recordings from packs and test runs from their metadata', () => {
    expect(classifyRun(run({ meta: { imported: { at: 1, from: 'cap.har' }, covers: ['api'] } })).kind).toBe('capture');
    expect(classifyRun(run({ meta: { imported: { at: 1, from: 'golden' } } })).kind).toBe('pack');
    // A fork that came in a pack with its lineage is still a fork.
    expect(classifyRun(run({ mode: 'replay', parentRunId: 'P', divergence: { callNo: 4 }, meta: { imported: { at: 1, from: 'golden' } } })).kind).toBe('fork');
    expect(classifyRun(run({ mode: 'replay', parentRunId: 'G', divergence: { callNo: 1 }, meta: { test: { golden: 'goldens/refund', session: 's1' } } })).kind).toBe('test');
  });

  it('bundles --repeat, blame and verify attempts under the run they replayed', () => {
    const repeat = run({ mode: 'replay', parentRunId: 'P', meta: { repeat: { group: 'g', attempt: 2, of: 5 } } });
    expect(classifyRun(repeat)).toEqual({ kind: 'clean', attemptOf: 'P', attemptKind: 'repeat' });
    const probe = run({ mode: 'replay', parentRunId: 'P', divergence: { callNo: 5 }, meta: { repeat: { group: 'g-5', attempt: 1, of: 4 }, probe: { of: 'P', callNo: 5, passed: true } } });
    expect(classifyRun(probe)).toEqual({ kind: 'fork', attemptOf: 'P', attemptKind: 'probe' });
    const verify = run({ mode: 'replay', parentRunId: 'Q', meta: { repeat: { group: 'v-Q', attempt: 1, of: 2 }, verify: { role: 'good', passed: false } } });
    expect(classifyRun(verify)).toEqual({ kind: 'clean', attemptOf: 'Q', attemptKind: 'verify' });
    // A probe keeps the run it probed even when the link to its parent is gone.
    expect(classifyRun({ ...probe, parentRunId: null }).attemptOf).toBe('P');
  });

  it('shows the fork blame rescued a run with as a run, and never bundles a test run', () => {
    const probe = run({ mode: 'replay', parentRunId: 'P', divergence: { callNo: 5 }, meta: { probe: { of: 'P', callNo: 5, passed: true } } });
    expect(classifyRun(probe, { rescued: true })).toEqual({ kind: 'fork', attemptOf: null, attemptKind: null });
    const test = run({ mode: 'replay', parentRunId: 'G', meta: { test: { golden: 'g', session: 's' }, repeat: { group: 'x', attempt: 2, of: 3 } } });
    expect(classifyRun(test)).toEqual({ kind: 'test', attemptOf: null, attemptKind: null });
  });

  it('ignores metadata that is not shaped like what Shadowlap writes (a run from a pack)', () => {
    const odd = run({ mode: 'replay', parentRunId: 'P', meta: { repeat: 'yes', probe: 3, verify: [], covers: 'api', checks: 'all', blame: 'x' } as Record<string, unknown> });
    expect(classifyRun(odd)).toEqual({ kind: 'clean', attemptOf: null, attemptKind: null });
    expect(checksOf(odd)).toBeNull();
    expect(lostAt(odd)).toBeNull();
    expect(runOutcome(odd).kind).toBe('clean');
  });
});

describe('runOutcome: what the status column says', () => {
  it('says in progress while a run records, whatever else it carries', () => {
    expect(outcomeLabel(runOutcome(run({ status: 'running', meta: { blame: blame('blamed', 5) } })))).toBe('in progress');
  });

  it('says where blame found the run was lost, or that a check failed when it found no call', () => {
    const lost = runOutcome(run({ status: 'failed', meta: { blame: blame('blamed', 9, 'F') } }));
    expect(lost).toEqual({ kind: 'lost', callNo: 9 });
    expect(outcomeLabel(lost)).toBe('lost at #9');
    expect(runOutcome(run({ meta: { blame: blame('unrescuable', null) } })).kind).toBe('check-failed');
    expect(runOutcome(run({ meta: { blame: blame('stopped', null) } })).kind).toBe('check-failed');
    expect(lostAt(run({ meta: { blame: blame('blamed', 9) } }))).toBe(9);
  });

  it('counts checks as ls --json and lineage do, and names the first that failed', () => {
    const checks = [
      { ok: true, label: 'issue_refund called 0 times', detail: null },
      { ok: false, label: 'send_email called 1 time', detail: 'it was called 2 times' },
    ];
    expect(checksOf(run({ meta: { checks } }))).toEqual({ passed: 1, total: 2 });
    expect(runOutcome(run({ mode: 'replay', parentRunId: 'P', divergence: { callNo: 3 }, meta: { checks } }))).toEqual({ kind: 'check-failed', check: 'send_email called 1 time' });
    const passed = runOutcome(run({ mode: 'replay', parentRunId: 'P', meta: { checks: [checks[0]!, { ...checks[0]!, label: 'exit 0' }] } }));
    expect(passed).toEqual({ kind: 'passed', checks: 2 });
    expect(outcomeLabel(passed)).toBe('2 checks passed');
    expect(outcomeLabel({ kind: 'passed', checks: 1 })).toBe('1 check passed');
  });

  it('says a test diverged when it left its golden without checks to judge it', () => {
    const t = { mode: 'replay' as const, parentRunId: 'G', meta: { test: { golden: 'goldens/refund-in-limit', session: 's' } } };
    expect(runOutcome(run({ ...t, status: 'failed', divergence: { callNo: 1 } }))).toEqual({ kind: 'diverged', callNo: 1 });
    expect(runOutcome(run(t))).toEqual({ kind: 'clean' });
  });

  it('counts an agent that exited with an error as a failed check, unless a fork injected the failure', () => {
    expect(runOutcome(run({ status: 'failed' }))).toEqual({ kind: 'check-failed', check: null });
    const failAt = run({ mode: 'replay', parentRunId: 'P', status: 'failed', divergence: { callNo: 19 } });
    expect(runOutcome(failAt, { injected: true })).toEqual({ kind: 'none' });
    // An interrupted run is not a failure of the agent.
    expect(runOutcome(run({ status: 'crashed' }))).toEqual({ kind: 'none' });
  });

  it('says clean for a clean replay and nothing for a plain recording or fork', () => {
    expect(runOutcome(run({ mode: 'replay', parentRunId: 'P' }))).toEqual({ kind: 'clean' });
    expect(runOutcome(run())).toEqual({ kind: 'none' });
    expect(outcomeLabel(runOutcome(run({ mode: 'replay', parentRunId: 'P', divergence: { callNo: 2 } })))).toBe('—');
  });

  it('treats diverged, lost and failed checks as failures', () => {
    expect([{ kind: 'diverged', callNo: 1 }, { kind: 'lost', callNo: 2 }, { kind: 'check-failed', check: null }].every((o) => isFailedOutcome(o as never))).toBe(true);
    expect([{ kind: 'running' }, { kind: 'passed', checks: 2 }, { kind: 'clean' }, { kind: 'none' }].some((o) => isFailedOutcome(o as never))).toBe(false);
  });
});

describe('call origins: one character per call', () => {
  it('follows the stored origin, naming injected and failed answers apart', () => {
    expect(displayOrigin('replayed', { outcome: 'ok' })).toBe('replayed');
    expect(displayOrigin('live', null)).toBe('live');
    expect(displayOrigin('live', { outcome: 'error', injected: true })).toBe('injected');
    expect(displayOrigin('live', { outcome: 'error' })).toBe('failed');
    // A blocked write answers with an error: the fence, not a failure.
    expect(displayOrigin('blocked', { outcome: 'error' })).toBe('blocked');
    expect(displayOrigin('stubbed', { outcome: 'ok' })).toBe('stubbed');
    expect(displayOrigin('overridden', { outcome: 'ok' })).toBe('overridden');
  });

  it('groups a long strip into cells that keep the most notable origin of their range', () => {
    expect(notableOrigin('rrrbrr')).toBe('b');
    expect(notableOrigin('rlsoif')).toBe('f');
    expect(notableOrigin('')).toBeNull();
    expect(originCells('rrrrbrrlll', 3)).toBe('rbll');
    expect(binOrigins('rl', 60)).toEqual({ size: 1, cells: 'rl' });
    const long = 'r'.repeat(905) + 'o' + 'l'.repeat(10) + 'b' + 'l'.repeat(283);
    const { size, cells } = binOrigins(long, 60);
    expect(size).toBe(20);
    expect(cells).toHaveLength(60);
    // Calls 901–920 hold the override at #906 and the blocked write at #917; the write outranks it.
    expect(cells[45]).toBe('b');
    expect(cells.replace(/[rl]/g, '')).toBe('b');
    expect(cells.slice(0, 45)).toBe('r'.repeat(45));
    expect(countOrigins('rrlbf')).toEqual({ r: 2, l: 1, o: 0, i: 0, f: 1, b: 1, s: 0 });
  });
});

describe('Store.query', () => {
  it('answers read-only statements and refuses anything that writes', () => {
    const store = Store.open(':memory:');
    try {
      store.createRun({ mode: 'record', command: { argv: ['node', 'a.js'], cwd: '/w' }, startedAt: 5 });
      expect(store.query(`SELECT COUNT(*) AS n FROM runs WHERE started_at >= ?`, 1)).toEqual([{ n: 1 }]);
      expect(store.query(`WITH x AS (SELECT run_id FROM runs) SELECT COUNT(*) AS n FROM x`)).toEqual([{ n: 1 }]);
      expect(() => store.query(`DELETE FROM runs`)).toThrow(/read-only/);
      expect(() => store.query(`WITH x AS (SELECT 1) DELETE FROM runs`)).toThrow(/read-only/);
      // A word inside a string literal is data, not a statement.
      expect(store.query(`SELECT 'delete me' AS s`)).toEqual([{ s: 'delete me' }]);
    } finally {
      store.close();
    }
  });
});
