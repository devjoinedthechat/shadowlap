import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import {
  binOrigins,
  checksOf,
  classifyRun,
  countOrigins,
  displayOrigin,
  failedChecks,
  importedRecording,
  isFailedOutcome,
  kindLabel,
  lostAt,
  notableOrigin,
  originCells,
  outcomeLabel,
  pulledRun,
  runKind,
  runOutcome,
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

  it('calls a replay that reproduced a failing recording exactly a clean replay, and its outcome still a failure', () => {
    // The recording exited 1 after 8 calls; the replay served all 8 and exited 1 as recorded.
    const replay = run({ mode: 'replay', parentRunId: 'P', status: 'failed' });
    const failedParent = { calls: 8, status: 'failed' as const };
    expect(classifyRun(replay, { calls: 8, parent: failedParent }).kind).toBe('clean');
    expect(runOutcome(replay, { calls: 8, parent: failedParent })).toEqual({ kind: 'check-failed', check: null });
    // Served more than the recording holds (a partial recording's other calls ran live): still all of it.
    expect(runKind(replay, { calls: 9, parent: failedParent })).toBe('clean');
    // It stopped short of the recording, the recording passed, or its parent is gone: not a reproduction.
    expect(runKind(replay, { calls: 5, parent: failedParent })).toBe('replay');
    expect(runKind(replay, { calls: 8, parent: { calls: 8, status: 'completed' } })).toBe('replay');
    expect(runKind(replay, { calls: 8, parent: null })).toBe('replay');
    expect(runKind(replay, { calls: 8 })).toBe('replay');
    // Interrupted is never clean.
    expect(runKind({ ...replay, status: 'crashed' }, { calls: 8, parent: failedParent })).toBe('replay');
  });

  it('labels each kind as the run list does', () => {
    expect(kindLabel('fork', { callNo: 17 })).toBe('fork @17');
    // A replay that stopped before its recording did left it there, but is no fork to carry on from.
    expect(kindLabel('fork', { callNo: 11, type: 'ended_early' })).toBe('ended early @11');
    expect(kindLabel(runKind(run({ mode: 'replay', parentRunId: 'P', status: 'completed', divergence: { callNo: 11, type: 'ended_early' } }), { calls: 10 }), { callNo: 11, type: 'ended_early' })).toBe('ended early @11');
    expect(kindLabel('clean', null)).toBe('clean replay');
    expect(kindLabel('pack', null)).toBe('recording');
    expect(['recording', 'capture', 'replay', 'test'].map((k) => kindLabel(k as never, null))).toEqual(['recording', 'capture', 'replay', 'test']);
  });

  it('names captures, recordings from packs and test runs from their metadata', () => {
    expect(classifyRun(run({ meta: { imported: { at: 1, from: 'cap.har' }, covers: ['api'] } })).kind).toBe('capture');
    expect(classifyRun(run({ meta: { imported: { at: 1, from: 'golden' } } })).kind).toBe('pack');
    // A fork that came in a pack with its lineage is still a fork.
    expect(classifyRun(run({ mode: 'replay', parentRunId: 'P', divergence: { callNo: 4 }, meta: { imported: { at: 1, from: 'golden' } } })).kind).toBe('fork');
    expect(classifyRun(run({ mode: 'replay', parentRunId: 'G', divergence: { callNo: 1 }, meta: { test: { golden: 'goldens/refund', session: 's1' } } })).kind).toBe('test');
  });

  it('reads a run pulled from the team store as what it is, and a pack someone sent as a pack', () => {
    const pulled = { imported: { at: 1, from: 's3://northwind-agent-runs/support-agent' }, author: 'maya@example.com' };
    expect(classifyRun(run({ meta: pulled })).kind).toBe('recording');
    expect(kindLabel(runKind(run({ meta: pulled })), null)).toBe('recording');
    // From a pull request's folder too, and from every kind of store.
    expect(classifyRun(run({ meta: { imported: { at: 1, from: 's3://northwind-agent-runs/prs', pr: '42' } } })).kind).toBe('recording');
    for (const from of ['gs://runs/team', 'az://northwind/runs', 'r2://0123abc/runs/team']) expect(pulledRun({ meta: { imported: { at: 1, from } } }), from).toBe(true);
    // An unpack names the pack's folder, an import its file or trace: neither is a store.
    for (const from of ['triage-from-maya', 'goldens/refund', '/tmp/otel-genai.json', 'langfuse:7f3a9c2e', 's3:', 'http://collector:4318/v1/traces', '']) expect(pulledRun({ meta: { imported: { at: 1, from } } }), from).toBe(false);
    expect(pulledRun({ meta: { imported: 's3://x/y' } })).toBe(false);
    expect(pulledRun({ meta: {} })).toBe(false);
    expect(pulledRun({})).toBe(false);
    expect(classifyRun(run({ meta: { imported: { at: 1, from: 'triage-from-maya' } } })).kind).toBe('pack');
    // A capture a teammate pushed is still a capture.
    expect(classifyRun(run({ meta: { imported: { at: 1, from: 'gs://runs/team' }, covers: ['api'] } })).kind).toBe('capture');
  });

  it('counts what a pulled recording spent, and what a pack or a capture holds as captured', () => {
    const rec = (meta: Record<string, unknown>, mode: 'record' | 'replay' = 'record') => ({ mode, meta });
    // A teammate's recording is the team's: its calls were spent.
    expect(importedRecording(rec({ imported: { at: 1, from: 's3://northwind-agent-runs/support-agent' } }))).toBe(false);
    // A pack someone sent, and a capture (pulled or not), were paid for where that traffic ran.
    expect(importedRecording(rec({ imported: { at: 1, from: 'triage-from-maya' } }))).toBe(true);
    expect(importedRecording(rec({ imported: { at: 1, from: 'cap.har' }, covers: ['api'] }))).toBe(true);
    expect(importedRecording(rec({ imported: { at: 1, from: 's3://northwind-agent-runs/support-agent' }, covers: ['api'] }))).toBe(true);
    // Replays spend what they spend, wherever they came from; a run made here is no import.
    expect(importedRecording(rec({ imported: { at: 1, from: 'triage-from-maya' } }, 'replay'))).toBe(false);
    expect(importedRecording(rec({}))).toBe(false);
  });

  it('bundles --repeat, blame and verify attempts under the run they replayed', () => {
    const repeat = run({ mode: 'replay', parentRunId: 'P', meta: { repeat: { group: 'g', attempt: 2, of: 5 } } });
    expect(classifyRun(repeat)).toEqual({ kind: 'clean', attemptOf: 'P', attemptKind: 'repeat' });
    const probe = run({ mode: 'replay', parentRunId: 'P', divergence: { callNo: 5 }, meta: { repeat: { group: 'g-5', attempt: 1, of: 4 }, probe: { of: 'P', callNo: 5, passed: true } } });
    expect(classifyRun(probe)).toEqual({ kind: 'fork', attemptOf: 'P', attemptKind: 'probe' });
    const verify = run({ mode: 'replay', parentRunId: 'Q', meta: { repeat: { group: 'v-Q', attempt: 1, of: 2 }, verify: { role: 'good', passed: false } } });
    expect(classifyRun(verify)).toEqual({ kind: 'clean', attemptOf: 'Q', attemptKind: 'verify' });
    // A probe whose run was deleted (the link is gone) is bundled under nothing.
    expect(classifyRun({ ...probe, parentRunId: null })).toEqual({ kind: 'fork', attemptOf: null, attemptKind: 'probe' });
  });

  it('bundles a probe under the run it replayed, never under another run it names', () => {
    // A run from a pack can carry any metadata: a probe that names a run other than its parent is not one of blame's.
    const odd = run({ mode: 'replay', parentRunId: 'P', divergence: { callNo: 5 }, meta: { probe: { of: 'SOMEONE-ELSE', callNo: 5, passed: true } } });
    expect(classifyRun(odd)).toEqual({ kind: 'fork', attemptOf: null, attemptKind: null });
  });

  it('shows the fork blame rescued a run with as a run, and a test run as the result of its golden', () => {
    const probe = run({ mode: 'replay', parentRunId: 'P', divergence: { callNo: 5 }, meta: { probe: { of: 'P', callNo: 5, passed: true } } });
    expect(classifyRun(probe, { rescued: true })).toEqual({ kind: 'fork', attemptOf: null, attemptKind: null });
    const test = run({ mode: 'replay', parentRunId: 'G', meta: { test: { golden: 'g', session: 's' }, repeat: { group: 'x', attempt: 2, of: 3 } } });
    expect(classifyRun(test)).toEqual({ kind: 'test', attemptOf: null, attemptKind: null });
  });

  it('bundles the attempts of a golden replayed more than once under the attempt its result shows', () => {
    const shown = run({ runId: 'T3', mode: 'replay', parentRunId: 'G', meta: { test: { golden: 'goldens/refund-over-limit', session: 's', attempt: 3 } } });
    expect(classifyRun(shown)).toEqual({ kind: 'test', attemptOf: null, attemptKind: null });
    const other = run({ runId: 'T1', mode: 'replay', parentRunId: 'G', meta: { test: { golden: 'goldens/refund-over-limit', session: 's', attempt: 1, of: 'T3' } } });
    expect(classifyRun(other)).toEqual({ kind: 'test', attemptOf: 'T3', attemptKind: 'test' });
    // Never under itself, its recording, nothing, or as anything but a replay.
    for (const of of ['T1', 'G', '', 7]) expect(classifyRun(run({ ...other, meta: { test: { golden: 'g', session: 's', of } } as Record<string, unknown> })).attemptOf).toBeNull();
    expect(classifyRun({ ...other, mode: 'record', parentRunId: null }).attemptOf).toBeNull();
  });

  it('ignores metadata that is not shaped like what shadowlap writes (a run from a pack)', () => {
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
    // No one call lost it: the two it was lost gradually around, never "lost at" the first.
    const gradual = runOutcome(run({ status: 'failed', meta: { blame: { ...blame('blamed', 9, 'F'), range: { from: 9, to: 11, fromStep: 4, toStep: 5, gradual: true } } } }));
    expect(gradual).toEqual({ kind: 'lost', callNo: 9, range: { from: 9, to: 11, gradual: true } });
    expect(outcomeLabel(gradual)).toBe('lost gradually around #9 and #11');
    // One the probes left open between two calls: lost between them, never at the first alone.
    const between = runOutcome(run({ status: 'failed', meta: { blame: { ...blame('blamed', 9), range: { from: 9, to: 12, fromStep: 4, toStep: 6 } } } }));
    expect(between).toEqual({ kind: 'lost', callNo: 9, range: { from: 9, to: 12 } });
    expect(outcomeLabel(between)).toBe('lost between #9 and #12');
    // Pinned to one call, the call.
    expect(runOutcome(run({ status: 'failed', meta: { blame: { ...blame('blamed', 9), range: { from: 9, to: 9 } } } }))).toEqual({ kind: 'lost', callNo: 9 });
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
    const passed = runOutcome(run({ mode: 'replay', parentRunId: 'P', meta: { checks: [checks[0], { ...checks[0], label: 'exit 0' }] } }));
    expect(passed).toEqual({ kind: 'passed', checks: 2 });
    expect(outcomeLabel(passed)).toBe('2 checks passed');
    expect(outcomeLabel({ kind: 'passed', checks: 1 })).toBe('1 check passed');
  });

  it('counts checks by how they came out: a check that did not apply is no pass, one that could not be decided neither', () => {
    const pass = { ok: true, status: 'passed', label: 'issue_refund called 0 times', detail: null };
    const na = { ok: true, status: 'not-applicable', label: 'when lookup_order has result.total > 200: escalate called at least 1 time', detail: 'the condition never held: lookup_order #2: result.total 180 <= 200' };
    const unsure = { ok: false, status: 'inconclusive', label: 'judge "explains" answers yes', detail: 'not judged: no recorded verdict and no key for anthropic' };
    const fail = { ok: false, status: 'failed', label: 'send_email called 0 times', detail: 'called 1 time' };
    const r = (checks: unknown[], status: ClassifiableRun['status'] = 'completed') => run({ mode: 'replay', parentRunId: 'P', status, meta: { checks } as Record<string, unknown> });
    // shadowlap test on a golden whose when never held: one check passed, two did not apply.
    expect(checksOf(r([pass, na, na]))).toEqual({ passed: 1, total: 3, notApplicable: 2 });
    expect(runOutcome(r([pass, na, na]))).toEqual({ kind: 'passed', checks: 1, notApplicable: 2 });
    expect(outcomeLabel(runOutcome(r([pass, na, na])))).toBe('1 check passed, 2 not applicable');
    expect(outcomeLabel(runOutcome(r([na])))).toBe('1 check not applicable');
    // A check that could not be decided, and none failed: inconclusive, neither a pass nor a failure.
    const undecided = runOutcome(r([pass, unsure, na]));
    expect(undecided).toEqual({ kind: 'inconclusive', check: 'judge "explains" answers yes' });
    expect(outcomeLabel(undecided)).toBe('check inconclusive');
    expect(isFailedOutcome(undecided)).toBe(false);
    // One that failed decides it, and is the one named.
    expect(runOutcome(r([unsure, fail]))).toEqual({ kind: 'check-failed', check: 'send_email called 0 times' });
    const counts = checksOf(r([unsure, fail, na]))!;
    expect(counts).toEqual({ passed: 0, total: 3, inconclusive: 1, notApplicable: 1 });
    expect(failedChecks(counts)).toBe(1);
    // The agent's exit fails a run whose only other trouble is a check it could not decide.
    expect(runOutcome(r([unsure], 'failed'))).toEqual({ kind: 'check-failed', check: null });
    // A check kept before checks had a status reads as its ok says.
    expect(checksOf(r([{ ok: true, label: 'a', detail: null }, { ok: false, label: 'b', detail: 'x' }]))).toEqual({ passed: 1, total: 2 });
  });

  it('says inconclusive, no failure, when a check could not be decided and none failed', () => {
    const judged = { ok: true, status: 'passed', label: 'explains: the judge answers yes to "Does it say why?"', detail: 'the judge answered yes: it does' };
    const notJudged = { ok: false, status: 'inconclusive', label: 'polite: the judge answers yes to "Is it polite?"', detail: 'not judged: no recorded verdict and the test runs offline' };
    const failed = { ok: false, status: 'failed', label: 'send_email called 1 time', detail: 'it was called 2 times' };
    const unsure = runOutcome(run({ mode: 'replay', parentRunId: 'P', meta: { checks: [judged, notJudged] } }));
    expect(unsure).toEqual({ kind: 'inconclusive', check: notJudged.label });
    expect(outcomeLabel(unsure)).toBe('check inconclusive');
    expect(isFailedOutcome(unsure)).toBe(false);
    // A check that failed, or the agent's exit, says more than one that could not be decided.
    expect(runOutcome(run({ mode: 'replay', parentRunId: 'P', meta: { checks: [notJudged, failed] } }))).toEqual({ kind: 'check-failed', check: failed.label });
    expect(runOutcome(run({ mode: 'replay', parentRunId: 'P', status: 'failed', meta: { checks: [notJudged] } }))).toEqual({ kind: 'check-failed', check: null });
    // A blamed run names the check that failed, never the one no probe could decide.
    expect(runOutcome(run({ meta: { blame: blame('unrescuable', null), checks: [notJudged, failed] } }))).toEqual({ kind: 'check-failed', check: failed.label });
  });

  it('says a test diverged when it left its golden without checks to judge it', () => {
    const t = { mode: 'replay' as const, parentRunId: 'G', meta: { test: { golden: 'goldens/refund-in-limit', session: 's' } } };
    expect(runOutcome(run({ ...t, status: 'failed', divergence: { callNo: 1 } }))).toEqual({ kind: 'diverged', callNo: 1 });
    expect(runOutcome(run(t))).toEqual({ kind: 'clean' });
  });

  it('lets a divergence decide a test that ran offline or may not fork, whatever its checks say', () => {
    // goldens/refund-in-limit has two checks and diverged at #1 offline: shadowlap test says "diverged at call 1".
    const checks = [
      { ok: true, label: 'issue_refund called once', detail: null },
      { ok: false, label: 'send_email called once', detail: 'it was called 0 times' },
    ];
    const t = { mode: 'replay' as const, parentRunId: 'G', status: 'failed' as const, divergence: { callNo: 1 }, meta: { test: { golden: 'goldens/refund-in-limit', session: 's' }, checks } };
    expect(runOutcome(run(t), { offline: true })).toEqual({ kind: 'diverged', callNo: 1 });
    // The run says the golden may not fork: the divergence decides even with every check passed.
    const passing = checks.map((c) => ({ ...c, ok: true }));
    expect(runOutcome(run({ ...t, status: 'completed', meta: { test: { golden: 'g', session: 's', fork: false }, checks: passing } }))).toEqual({ kind: 'diverged', callNo: 1 });
    // A golden that may fork goes live from the fork, and its checks decide.
    expect(runOutcome(run({ ...t, status: 'completed', meta: { test: { golden: 'g', session: 's', fork: true }, checks: passing } }), { offline: false })).toEqual({ kind: 'passed', checks: 2 });
    expect(runOutcome(run({ ...t, meta: { test: { golden: 'g', session: 's', fork: true }, checks } }))).toEqual({ kind: 'check-failed', check: 'send_email called once' });
    // Nothing says either way and it went live: the checks decide, as for a golden that may fork.
    expect(runOutcome(run({ ...t, status: 'completed', meta: { test: { golden: 'g', session: 's' }, checks: passing } }))).toEqual({ kind: 'passed', checks: 2 });
  });

  it('fails a test whose replay made no calls, as shadowlap test does', () => {
    const t = run({ mode: 'replay', parentRunId: 'G', meta: { test: { golden: 'goldens/refund', session: 's' } } });
    const none = runOutcome(t, { calls: 0 });
    expect(none).toEqual({ kind: 'check-failed', check: 'no calls were made' });
    expect(isFailedOutcome(none)).toBe(true);
    expect(runOutcome(t, { calls: 3 })).toEqual({ kind: 'clean' });
    // A recording that made no calls is not judged by it.
    expect(runOutcome(run(), { calls: 0 })).toEqual({ kind: 'none' });
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

describe('the browser bundle', () => {
  it('can import classification on its own: @shadowlap/engine/classify has no Node imports', async () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { exports: Record<string, { default: string; types: string }> };
    expect(pkg.exports['./classify']).toEqual({ types: './dist/classify.d.ts', default: './dist/classify.js' });
    const entry = fileURLToPath(new URL('../src/classify.ts', import.meta.url));
    const out = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'browser', format: 'esm', logLevel: 'silent' });
    expect(out.errors).toEqual([]);
    expect(out.outputFiles[0].text).toContain('outcomeLabel');
  });
});
