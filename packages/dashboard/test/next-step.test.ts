import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { judgeCapture, NO_COMMAND, parseTests, recordBlame, recordEvent, rulesOnCalls, Store, type CleanReport, type DiffEntry, type Normalizer, type PlantReport, type RunMeta } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun } from '../../engine/test/fix-fixtures.js';
import { copyNextStep, failureKey, fixByFailure, goldenFolder, nextStepOf, nextStepRows, nextStepStamp, pageSteps, pricedNextStep, replayStepOf, stepRow, type NextStepWork } from '../src/next-step.js';
import { listRuns } from '../src/api.js';
import { overviewSummary } from '../src/overview.js';
import { judgedRows, runJudged, type OutcomeWork } from '../src/run-outcome.js';
import { loadRunIndex } from '../src/run-index.js';
import type { GoldenSource } from '../src/tests.js';
import { addRun } from './read-model-store.js';

/**
 * A run's one next step (next-step.ts, A12), each branch on a store as the CLI leaves it: the mock's
 * order, first that applies, so the run page's lime button, the lists, Needs a look and the palette
 * say the same; and what each step that bills bills, from the engine's estimates.
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
const work = (goldens: GoldenSource[], o: Partial<NextStepWork> = {}): NextStepWork => ({ goldens, tests: undefined, normalize: undefined, dir: '/work/project', ...o });

/** What a list and the run's page read: the step, with no price. */
const step = (id: string, w: NextStepWork | null = work([]), judged?: Parameters<typeof nextStepOf>[3]) => nextStepOf(store, id, w, judged)!;
const recording = (at = T0, o: { status?: 'completed' | 'failed'; meta?: RunMeta; calls?: string } = {}) => addRun(store, { startedAt: at, calls: o.calls ?? 'lll', ...(o.status ? { status: o.status } : {}), ...(o.meta ? { meta: o.meta } : {}) });

/** A diverged test replay of a golden: its session's result says how it failed. */
function divergedTest(parent: string, diff: DiffEntry[], o: { at?: number; revision?: string | null } = {}): string {
  const session = store.startTestSession({ command: ['shadowlap', 'test', GOLDEN], startedAt: o.at ?? T0 + MIN, revision: o.revision ?? 'bbbbbbb' }).sessionId;
  const run = addRun(store, { parent, startedAt: o.at ?? T0 + MIN, status: 'failed', calls: 'r', meta: { test: { golden: GOLDEN, session } } });
  store.setDivergence(run, { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, diff });
  store.addTestResult({ sessionId: session, golden: GOLDEN, ok: false, failure: 'diverged', reason: 'diverged at call 1', runId: run, goldenRunId: parent, revision: o.revision ?? 'bbbbbbb', at: o.at ?? T0 + MIN });
  return run;
}

/** A test replay whose agent exited with an error. */
function crashedTest(parent: string, at = T0 + MIN): string {
  const session = store.startTestSession({ command: ['shadowlap', 'test', GOLDEN], startedAt: at, revision: 'bbbbbbb' }).sessionId;
  const run = addRun(store, { parent, startedAt: at, status: 'failed', calls: 'rl', meta: { test: { golden: GOLDEN, session } } });
  store.addTestResult({ sessionId: session, golden: GOLDEN, ok: false, failure: 'exit', reason: 'the agent exited with code 1', runId: run, goldenRunId: parent, revision: 'bbbbbbb', at });
  return run;
}

/** A session in which the golden passed, at a revision, with its replay. */
function passedTest(parent: string, at: number, revision = 'aaaaaaa'): string {
  const session = store.startTestSession({ command: ['shadowlap', 'test', GOLDEN], startedAt: at, revision }).sessionId;
  const run = addRun(store, { parent, startedAt: at, calls: 'r', meta: { test: { golden: GOLDEN, session } } });
  store.addTestResult({ sessionId: session, golden: GOLDEN, ok: true, runId: run, goldenRunId: parent, revision, at });
  return run;
}

const UUID_CHANGE: DiffEntry = { path: '$.metadata.user_id', op: 'changed', before: '3f1c9a2e-5b7d-4e21-9c0a-8d6f2b1e7a43', after: 'b84e07d1-2c9f-4a63-8e15-6f0d3a9c2b78' };
const RULE: Normalizer = { kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' };

function plant(runId: string, o: { gate: PlantReport['gate']; attempts?: Array<Partial<PlantReport['attempts'][number]>>; stopReason?: string | null; golden?: string | null; at?: number; ended?: boolean; cost?: Partial<PlantReport['cost']>; payloads?: Array<{ id: string; source: string }> }): void {
  const report = {
    resultId: `inj-${String(o.at ?? 0)}`,
    mode: 'plant',
    runId,
    golden: o.golden ?? null,
    templates: { version: 1, ids: ['system-notice'] },
    repeat: 2,
    unrecordedReads: 'fence',
    payloads: o.payloads ?? [],
    attempts: o.attempts ?? [],
    baselines: [{ read: 1, runs: ['a', 'b'], writes: 1, failed: [] }],
    totals: { attempts: 1, obeyed: 0, influenced: 0, ignored: 0, inconclusive: 0 },
    gate: o.gate,
    stopReason: o.stopReason ?? null,
    cost: { spent: 3.11, upstreamRequests: 8, unknownModels: [], ...o.cost },
  };
  store.putInjectionResult({ resultId: report.resultId, runId, golden: o.golden ?? null, sessionId: null, mode: 'plant', at: o.at ?? T0, endedAt: o.ended === false ? null : (o.at ?? T0) + 1, attempts: 1, obeyed: 0, influenced: 0, ignored: 0, inconclusive: 0, verdict: 'obeyed', actor: null, data: report });
}

function clean(runId: string, verdict: CleanReport['verdict'], at = T0): void {
  const report = { resultId: `inj-c${verdict}${String(at)}`, mode: 'clean', runId, golden: null, read: { callNo: 1, name: 'get_ticket' }, writes: [{ callNo: 3, name: 'send_email', attempts: 3, gone: 3, verdict, bound: null }], attempts: [], verdict, stopReason: null, cost: { spent: 0.1, upstreamRequests: 1, unknownModels: [] } };
  store.putInjectionResult({ resultId: report.resultId, runId, golden: null, sessionId: null, mode: 'clean', at, endedAt: at + 1, attempts: 3, obeyed: 0, influenced: 0, ignored: 0, inconclusive: 0, verdict, actor: null, data: report });
}

function preset(runId: string, verdict: 'passed' | 'failed' | 'inconclusive', sessionId = 'cs-1'): string {
  store.startChaosSession({ sessionId, startedAt: T0, command: ['shadowlap', 'replay', runId, '--chaos'], presets: ['timeout'] });
  const attempt = addRun(store, { parent: runId, startedAt: T0 + 1, status: verdict === 'passed' ? 'completed' : 'failed', calls: 'rl', meta: { chaos: { preset: 'timeout', callNo: 2, session: sessionId, attempt: 1 } } });
  store.addChaosResult({ sessionId, runId, golden: null, preset: 'timeout', verdict, callNo: 2, passes: verdict === 'passed' ? 1 : 0, attempts: 1, at: T0 + 2, data: { detail: 'lookup (#2) timed out: the agent exited with code 1', runs: [{ runId: attempt, passed: verdict === 'passed', verdict, exitCode: 1 }] } });
  return attempt;
}

describe('a run’s next step', () => {
  it('waits for a run still recording: Replay, off until it ends', () => {
    const live = addRun(store, { startedAt: T0, status: 'running', calls: 'l' });
    expect(step(live)).toMatchObject({ key: 'replay', label: 'Replay', off: 'Replay once the recording finishes' });
  });

  it('opens the passing run of a test whose golden passed when it ran again', () => {
    const rec = recording();
    const failed = divergedTest(rec, [UUID_CHANGE]);
    const passed = passedTest(rec, T0 + 2 * MIN);
    expect(step(failed, work([source(rec)]))).toMatchObject({ key: 'passing', label: 'Open passing run', href: `#/run/${passed}`, title: `Opens ${passed.slice(0, 10)}` });
    // A replay that passed before it failed says nothing of it, and neither does a run no longer there.
    const later = divergedTest(rec, [UUID_CHANGE], { at: T0 + 3 * MIN });
    expect(step(later, work([source(rec)])).key).toBe('normalizer');
    const crash = crashedTest(rec, T0 + 90_000);
    expect(step(crash, work([source(rec)]))).toMatchObject({ key: 'passing', href: `#/run/${passed}` });
  });

  it('adds the normalizer of a test that diverged on a value made anew on every run, and re-runs it once the rule is in', () => {
    const rec = recording();
    const t = divergedTest(rec, [UUID_CHANGE]);
    const s = step(t, work([source(rec)]));
    expect(s).toMatchObject({ key: 'normalizer', label: 'Add normalizer and re-run', golden: GOLDEN });
    expect(s).toMatchObject({ command: expect.stringContaining('normalize add') });
    expect(s.command).toContain(`&& shadowlap test ${GOLDEN}`);
    expect(step(t, work([source(rec)], { normalize: [RULE] }))).toMatchObject({ key: 'rerun-test', label: 'Re-run test', golden: GOLDEN, command: `shadowlap test ${GOLDEN}` });
  });

  it('updates the golden after a rule that can’t make the replay match, as the job does', () => {
    const rec = recording();
    const t = divergedTest(rec, [UUID_CHANGE, { path: '$.temperature', op: 'changed', before: 0, after: 1 }]);
    const rule = step(t, work([source(rec)]));
    expect(rule).toMatchObject({ key: 'normalizer', label: 'Add normalizer and update' });
    expect(rule.command).toContain('--update');
    // The rule added, what's left is the update.
    expect(step(t, work([source(rec)], { normalize: [RULE] }))).toMatchObject({ key: 'update-golden', label: 'Update golden', golden: GOLDEN });
  });

  it('updates the golden of a test that diverged on what a patch or a config change changed', () => {
    const rec = recording();
    for (const path of ['$.system', '$.system[0].text', '$.model', '$.tools[1].description', '$.instructions', '$.systemInstruction.parts[0].text']) {
      const t = divergedTest(rec, [{ path, op: 'changed', before: 'a', after: 'b' }], { at: T0 + MIN + path.length });
      expect(step(t, work([source(rec)])), path).toMatchObject({ key: 'update-golden', label: 'Update golden', command: `shadowlap test ${GOLDEN} --update`, sub: 'It re-records the golden under the change' });
    }
  });

  it('finds the breaking commit of a test that diverged on anything else, and leaves an id that may be real to the person', () => {
    const rec = recording();
    const other = divergedTest(rec, [{ path: '$.messages[3].content', op: 'changed', before: 'a', after: 'b' }]);
    expect(step(other, work([source(rec)]))).toMatchObject({ key: 'bisect', label: 'Find breaking commit…', starts: false, command: `shadowlap bisect ${GOLDEN} --good <commit> --bad a7b3c2e` });
    // Neither a rule nor an update leads for an id that may be another customer's.
    const id = divergedTest(rec, [{ path: '$.metadata.customer_id', op: 'changed', before: 'A-1', after: 'A-2' }], { at: T0 + 2 * MIN });
    expect(step(id, work([source(rec)])).key).toBe('bisect');
  });

  it('updates the golden of a test whose judge check couldn’t be judged offline, which asks the judge once', () => {
    const rec = recording();
    const session = store.startTestSession({ command: ['shadowlap', 'test', GOLDEN], startedAt: T0 + MIN }).sessionId;
    const t = addRun(store, { parent: rec, startedAt: T0 + MIN, calls: 'r', meta: { test: { golden: GOLDEN, session } } });
    const judge = { name: 'polite', model: 'claude-haiku-4-5', answer: null, cost: null };
    store.addTestResult({ sessionId: session, golden: GOLDEN, ok: false, failure: 'inconclusive', runId: t, goldenRunId: rec, at: T0 + MIN, data: { verdict: 'inconclusive', checks: [{ ok: false, status: 'inconclusive', label: 'judge: polite', detail: 'not judged: no recorded verdict', judge } as never] } });
    expect(step(t, work([source(rec)]))).toMatchObject({ key: 'update-golden', label: 'Update golden', sub: expect.stringContaining('Asks the judge once') });
    // A golden that forks asks its judges live: an update doesn't settle it.
    expect(step(t, work([source(rec, { mode: 'fork' })])).key).not.toBe('update-golden');
  });

  it('leaves a test whose golden is gone to what any failed run leads with', () => {
    const rec = recording();
    const t = divergedTest(rec, [UUID_CHANGE]);
    expect(step(t, work([]))).toMatchObject({ key: 'blame' });
  });

  it('packs the recording an attempt that obeyed proves, with its gate, until a golden is made from it', () => {
    const rec = recording();
    const obeyed = addRun(store, { parent: rec, startedAt: T0 + MIN, calls: 'rl', meta: { injection: { result: 'inj-1', role: 'attempt', read: 1, attempt: 1, of: 1, verdict: 'obeyed' }, repeat: { group: 'inj-1', attempt: 1, of: 1 } } });
    expect(step(obeyed)).toMatchObject({ key: 'pack-gate', label: 'Pack with injection gate…', runId: rec, folder: goldenFolder(rec), title: `Pack ${rec.slice(0, 10)} with injection gate`, command: `shadowlap pack ${rec.slice(0, 10)} ${goldenFolder(rec)}` });
    // A golden made from the recording: it reads against its parent, as any attempt.
    expect(step(obeyed, work([source(rec)]))).toMatchObject({ key: 'compare', parent: rec });
  });

  it('compares any other attempt with the run it came from, failed or not, and a fork too', () => {
    const rec = recording(T0, { status: 'failed' });
    const marks: RunMeta[] = [
      { probe: { of: rec, callNo: 1, passed: false }, repeat: { group: 'g', attempt: 1, of: 2 } },
      { verify: { role: 'target', passed: false }, repeat: { group: 'v', attempt: 1, of: 2 } },
      { repeat: { group: 'r', attempt: 1, of: 5 } },
      { chaos: { preset: 'timeout', callNo: 1, session: 'c', attempt: 1 } },
      { injection: { result: 'inj-1', role: 'attempt', read: 1, attempt: 1, of: 1, verdict: 'ignored' }, repeat: { group: 'inj', attempt: 1, of: 1 } },
    ];
    for (const meta of marks) {
      const attempt = addRun(store, { parent: rec, startedAt: T0 + MIN, status: 'failed', calls: 'rl', meta });
      expect(step(attempt), JSON.stringify(meta)).toMatchObject({ key: 'compare', label: 'Compare with parent', parent: rec, href: `#/compare/${rec}/${attempt}`, title: `Against ${rec.slice(0, 10)}`, command: `shadowlap diff ${rec.slice(0, 10)} ${attempt.slice(0, 10)}` });
    }
    const fork = addRun(store, { parent: rec, startedAt: T0 + MIN, divergence: 2, calls: 'rl' });
    expect(step(fork)).toMatchObject({ key: 'compare', parent: rec });
    // Not one whose parent is gone: nothing to compare it with.
    expect(step(addRun(store, { startedAt: T0 + MIN, mode: 'replay', status: 'completed', divergence: 2, calls: 'rl' }))).toMatchObject({ key: 'replay' });
  });

  it('finds the breaking commit of a crash, free from where its golden last passed, Run blame plain beside it, until the commit is named', () => {
    const rec = recording();
    passedTest(rec, T0 + MIN, 'aaaaaaa');
    const crash = crashedTest(rec, T0 + 2 * MIN);
    const s = step(crash, work([source(rec)]));
    expect(s).toMatchObject({ key: 'bisect', label: 'Find breaking commit', starts: true, command: `shadowlap bisect ${GOLDEN} --good aaaaaaa --bad a7b3c2e`, blame: { from: 'exit' }, sub: expect.stringContaining('offline: no tokens') });
    // With no commit it passed at, it asks for one.
    const other = Store.open(':memory:');
    const held = store;
    store = other;
    const rec2 = recording();
    expect(step(crashedTest(rec2), work([source(rec2)]))).toMatchObject({ key: 'bisect', label: 'Find breaking commit…', starts: false });
    other.close();
    store = held;
    // Once the commit is named, the change is the code's: blame leads, until Revert… comes.
    recordEvent(store, { kind: 'bisect.found', ref: GOLDEN, runId: crash, data: { first: { rev: 'ccccccc', subject: 'Log the total', author: 'a', date: 'b' }, why: 'exit', answered: { at: T0 + 2 * MIN, ok: false } } });
    expect(step(crash, work([source(rec)]))).toMatchObject({ key: 'blame' });
  });

  it('leads a recording by its newest injection test: its proof, a test its budget stopped, one that showed too little', () => {
    const rec = recording();
    const attempt = addRun(store, { parent: rec, startedAt: T0 + 1, calls: 'rl', meta: { injection: { result: 'inj-1', role: 'attempt', read: 4, attempt: 1, of: 1, verdict: 'obeyed' }, repeat: { group: 'inj', attempt: 1, of: 1 } } });
    const failed: PlantReport['gate'] = { obeyed: 0, influenced: null, verdict: 'failed', reason: 'send_email obeyed' };
    plant(rec, { gate: failed, at: T0 + 1, attempts: [{ runId: attempt, read: 4, payload: 'system-notice', verdict: 'obeyed', evidence: [{ kind: 'canary', callNo: 6, tool: 'send_email', path: '$.to', value: 'x', why: null }], readAt: 5 }] });
    expect(step(rec)).toMatchObject({ key: 'injection-proof', label: 'Open proof', runId: attempt, href: `#/run/${attempt}/6`, title: `Opens ${attempt.slice(0, 10)}`, sub: expect.stringContaining('system-notice at #4') });
    // A newer test decides, and one still running says nothing yet.
    plant(rec, { gate: { obeyed: 0, influenced: null, verdict: 'inconclusive', reason: '3 of the 6 planned attempts ran' }, at: T0 + 2, stopReason: 'the budget of $2.00 is spent' });
    expect(step(rec)).toMatchObject({ key: 'injection-test', label: 'Run injection test…', runId: rec, command: `shadowlap injection ${rec.slice(0, 10)}`, sub: expect.stringContaining('the budget of $2.00 is spent') });
    plant(rec, { gate: { obeyed: 0, influenced: null, verdict: 'inconclusive', reason: 'no model read it' }, at: T0 + 3 });
    plant(rec, { gate: failed, at: T0 + 10, ended: false });
    expect(step(rec)).toMatchObject({ key: 'injection-again', label: 'Re-run injection test', runId: rec, job: { repeat: 2, templates: ['system-notice'], baselines: 2, liveReads: false }, command: `shadowlap injection ${rec.slice(0, 10)} --templates system-notice --repeat 2`, sub: 'It showed too little to say: no model read it' });
    // With a payload file its result doesn't keep, it can't run again as it ran: it asks what to test.
    plant(rec, { gate: { obeyed: 0, influenced: null, verdict: 'inconclusive', reason: 'no model read it' }, at: T0 + 4, payloads: [{ id: 'mine', source: 'file' }] });
    expect(step(rec)).toMatchObject({ key: 'injection-test', sub: 'It showed too little to say: no model read it' });
    // A golden's gate runs again in its test.
    plant(rec, { gate: { obeyed: 0, influenced: null, verdict: 'inconclusive', reason: 'no model read it' }, at: T0 + 5, golden: GOLDEN });
    expect(step(rec)).toMatchObject({ key: 'gate-again', label: 'Re-run test', golden: GOLDEN, command: `shadowlap test ${GOLDEN}`, sub: 'Its injection gate showed too little to say: no model read it' });
    // One that ignored them leaves the recording to the steps after.
    plant(rec, { gate: { obeyed: 0, influenced: null, verdict: 'passed', reason: null }, at: T0 + 6 });
    expect(step(rec).key).toBe('pack');
  });

  it('packs with a gate a recording a read is proven to have caused a write in, while no golden is made from it', () => {
    const rec = recording();
    clean(rec, 'not caused', T0 + 1);
    expect(step(rec).key).toBe('pack');
    clean(rec, 'caused', T0 + 2);
    expect(step(rec)).toMatchObject({ key: 'pack-gate', label: 'Pack with injection gate…', runId: rec });
    expect(step(rec, work([source(rec)])).key).toBe('replay');
    // Only the newest answer for a read and a write counts.
    clean(rec, 'not caused', T0 + 3);
    expect(step(rec).key).toBe('pack');
  });

  it('opens the proof of presets that failed, after an injection test’s, and changes nothing for those left inconclusive', () => {
    const rec = recording();
    const attempt = preset(rec, 'failed');
    expect(step(rec)).toMatchObject({ key: 'preset-proof', label: 'Open proof', runId: attempt, href: `#/run/${attempt}/2`, sub: expect.stringContaining('tool timeout failed · 0 of 1 passed') });
    plant(rec, { gate: { obeyed: 0, influenced: null, verdict: 'inconclusive', reason: 'no model read it' }, at: T0 + 3 });
    expect(step(rec).key).toBe('injection-again');
    const other = recording(T0 + MIN);
    preset(other, 'inconclusive', 'cs-2');
    expect(step(other).key).toBe('pack');
  });

  it('opens the fix that covers a failure, and blames one nobody blamed, a fork too', () => {
    const rec = recording(T0, { status: 'failed' });
    const offer = step(rec);
    expect(offer).toMatchObject({ key: 'blame', label: 'Run blame', offer: { from: 'exit', expect: null, failed: [] }, command: `shadowlap blame ${rec.slice(0, 10)}` });
    const forked = addRun(store, { parent: rec, startedAt: T0 + MIN, status: 'failed', divergence: 2, calls: 'rl', meta: { checks: [{ ok: false, label: 'send_email called 1 time', detail: 'called 2 times' }] } });
    expect(step(forked)).toMatchObject({ key: 'blame', offer: { from: 'ask', failed: ['send_email called 1 time'] }, command: `shadowlap blame ${forked.slice(0, 10)} --expect '<what it must do>'` });
    const held = makeRun(store, { labels: ['refund-bug'], calls: ['api', 'tool', 'api'] });
    const { fix } = recordBlame(store, { runId: held, report: blameReport(held), expect: EXPECT, scope: null, command: 'shadowlap blame x', title: 'Refunds above the limit', checkText: 'issue_refund never called', at: T0 });
    expect(step(held)).toMatchObject({ key: 'fix', label: 'Open fix', fixId: fix.fixId, status: 'open', title: '“Refunds above the limit”', href: expect.stringContaining(fix.fixId) });
    // Blame needs a model call to ask again, and a run that was only stopped has nothing to blame.
    expect(step(recording(T0 + MIN, { status: 'failed', calls: 'b' })).key).toBe('replay');
  });

  it('adds the rule a replay’s divergence proposes, as its own banner did', () => {
    const rec = recording();
    const fork = addRun(store, { parent: rec, startedAt: T0 + MIN, divergence: 1, calls: 'l' });
    store.setDivergence(fork, { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, hints: [{ message: 'looks like a UUID', normalizer: RULE }] });
    expect(step(fork)).toMatchObject({ key: 'rule', label: 'Add normalizer' });
  });

  it('packs a recording that passed, with no golden made from it, and replays anything else', () => {
    const rec = recording();
    expect(step(rec)).toMatchObject({ key: 'pack', label: 'Pack as golden…', runId: rec, folder: goldenFolder(rec), command: `shadowlap pack ${rec.slice(0, 10)} ${goldenFolder(rec)}` });
    expect(goldenFolder(rec)).toBe(`goldens/${rec.slice(0, 10).toLowerCase()}`);
    // No project to pack into, a recording with a golden, one of its family's, and one that failed its family's checks today.
    expect(step(rec, null).key).toBe('replay');
    expect(step(rec, work([source(rec)])).key).toBe('replay');
    const fork = addRun(store, { parent: rec, startedAt: T0 + MIN, divergence: 2, calls: 'rl' });
    expect(step(rec, work([source(fork)])).key).toBe('replay');
    expect(step(rec, work([]), { judged: { by: 'family', verdict: 'failed', counts: { passed: 0, failed: 1, inconclusive: 0, notApplicable: 0 }, callNo: null, first: null, today: true, goldens: [], why: null } }).key).toBe('replay');
    // A recording cut short says nothing, and neither does one that made no call.
    expect(step(addRun(store, { startedAt: T0 + 2 * MIN, status: 'crashed', calls: 'l' })).key).toBe('replay');
    expect(step(addRun(store, { startedAt: T0 + 3 * MIN, calls: '' })).key).toBe('replay');
    // A clean or a test replay replays the recording it came from; a capture asks for a command.
    const replayed = addRun(store, { parent: rec, startedAt: T0 + MIN, calls: 'rrr' });
    expect(step(replayed)).toMatchObject({ key: 'replay', label: 'Replay recording', runId: rec, title: `Replays ${rec.slice(0, 10)}, the recording this replay came from`, command: `shadowlap replay ${rec.slice(0, 10)}` });
    const capture = addRun(store, { startedAt: T0 + MIN, argv: [NO_COMMAND], meta: { imported: { at: T0, from: '/work/cap.jsonl' }, covers: ['api'] }, calls: 'll' });
    expect(step(capture)).toMatchObject({ key: 'replay', label: 'Replay with your command…', runId: capture, command: `shadowlap replay ${capture.slice(0, 10)} -- <your command>` });
    // A clean replay of a capture has a command of its own: it replays itself, as its capture has none to replay with.
    const ofCapture = addRun(store, { parent: capture, startedAt: T0 + 2 * MIN, calls: 'rr' });
    expect(step(ofCapture)).toMatchObject({ key: 'replay', label: 'Replay', runId: ofCapture });
    expect(replayStepOf(store, replayed)).toMatchObject({ label: 'Replay recording', runId: rec });
    expect(replayStepOf(store, rec)).toMatchObject({ label: 'Replay', runId: rec });
  });

  it('opens the fix that holds a judged capture’s failure, else blames it with the rule it broke and your command', () => {
    const rule = { tool: 'issue_refund', args: { amount: { '<=': 100 } } };
    const tests = { [GOLDEN]: { expect: { calls: [rule] } } };
    const rules = rulesOnCalls(parseTests(tests));
    const capture = addRun(store, { startedAt: T0, argv: [NO_COMMAND], meta: { imported: { at: T0, from: '/work/cap.jsonl' }, covers: ['api', 'tool'] }, calls: [{ code: 'l', kind: 'tool' }] });
    const calls = store.getCalls(capture);
    store.updateRunMeta(capture, { judged: { ...judgeCapture(store, calls, rules, T0)!, verdict: 'failed', checks: [{ status: 'failed', ok: false, label: 'every issue_refund call: amount <= 100', detail: 'issue_refund #1: amount 240' }] } });
    const w = work([], { tests });
    const judged = runJudged(store, loadRunIndex(store), capture, { version: 'v1', tests, dir: '/work/project', goldens: [] } satisfies OutcomeWork, { checks: true });
    expect(judged).toMatchObject({ by: 'import', verdict: 'failed' });
    const blamed = step(capture, w, { judged: judged! });
    expect(blamed).toMatchObject({ key: 'blame', capture: true, offer: { from: 'golden', expect: { calls: [rule] }, failed: ['every issue_refund call: amount <= 100'] } });
    expect(blamed.command).toContain('-- <your command>');
    // Not judged yet, as a list's row past its budget: Replay with your command…, its step until then.
    expect(step(capture, w).key).toBe('replay');
    // A fix that holds the same failure, whatever its call numbers and amounts: Open fix.
    const held = makeRun(store, { labels: ['refund-bug'], calls: ['api'] });
    const { fix } = recordBlame(store, { runId: held, report: { ...blameReport(held), oracle: ['every issue_refund call: amount <= 250'] }, expect: EXPECT, scope: null, command: 'shadowlap blame x', title: 'Refunds above the limit', checkText: 'send_email called once', at: T0 });
    expect(step(capture, w, { judged: { ...judged!, first: { label: 'every issue_refund call: amount <= 100', detail: null } } })).toMatchObject({ key: 'fix', fixId: fix.fixId });
  });

  it('tells failures apart without their call numbers and amounts', () => {
    expect(failureKey('check failed: send_email called 1 time')).toBe('send_email called 1');
    expect(failureKey('send_email called 2 times, but called 3 times')).toBe('send_email called 2');
    expect(failureKey('issue_refund #4: amount 300 > total 240.50 (#2)')).toBe('issue_refund: amount N > total N');
    expect(fixByFailure([], 'x')).toBeNull();
  });
});

describe('what the next step of a run bills', () => {
  const priced = (id: string, w: NextStepWork | null = work([]), whole = true) => pricedNextStep(store, id, w, { judged: undefined, whole });

  it('prices Run blame at its ceiling, from the run’s model calls, and only once the calls are read', async () => {
    const rec = recording(T0, { status: 'failed' });
    expect((await priced(rec))?.estimate).toMatchObject({ kind: 'blame', ceiling: true, usd: expect.any(Number) });
    expect((await priced(rec))?.estimate?.usd).toBeGreaterThan(0);
    // A long run's first answer leaves it out: the page asks again once it is read.
    expect((await priced(rec, work([]), false))?.estimate).toBeUndefined();
    expect(step(rec).estimate).toBeUndefined();
  });

  it('prices an update of a golden at what its recording cost, and asks first for what it does', async () => {
    const rec = recording();
    const t = divergedTest(rec, [{ path: '$.system', op: 'changed', before: 'a', after: 'b' }]);
    expect((await priced(t, work([source(rec)])))?.estimate).toMatchObject({ kind: 'update', ceiling: false, always: 'it replaces goldens', usd: expect.any(Number) });
    // The recording's model calls, at their model's price.
    const est = (await priced(t, work([source(rec)])))?.estimate;
    expect(est?.usd).toBeGreaterThan(0);
  });

  it('leaves what bills nothing with no estimate: a golden’s bisect, its re-run, a pack, a replay', async () => {
    const rec = recording();
    passedTest(rec, T0 + MIN);
    const crash = crashedTest(rec, T0 + 2 * MIN);
    expect((await priced(crash, work([source(rec)])))?.estimate).toBeUndefined();
    const other = recording(T0 + 3 * MIN);
    expect((await priced(other))?.key).toBe('pack');
    expect((await priced(other))?.estimate).toBeUndefined();
    const t = divergedTest(rec, [UUID_CHANGE], { at: T0 + 4 * MIN });
    expect((await priced(t, work([source(rec)])))?.estimate).toMatchObject({ kind: 'tests', usd: 0 });
  });

  it('prices a re-run at what the last test spent, and asks first with no estimate when that spent nothing', async () => {
    const rec = recording();
    plant(rec, { gate: { obeyed: 0, influenced: null, verdict: 'inconclusive', reason: 'x' }, at: T0 + 1 });
    expect((await priced(rec))?.estimate).toMatchObject({ kind: 'injection', usd: 3.11, note: expect.stringContaining('as the last test') });
    plant(rec, { gate: { obeyed: 0, influenced: null, verdict: 'inconclusive', reason: 'x' }, at: T0 + 2, cost: { spent: 0 } });
    expect((await priced(rec))?.estimate).toMatchObject({ kind: 'injection', usd: null });
  });

  it('prices a new injection test and a gate from the recording’s reads', async () => {
    const rec = addRun(store, { startedAt: T0, calls: [{ code: 'l', kind: 'tool' }, { code: 'l' }, { code: 'l' }] });
    plant(rec, { gate: { obeyed: 0, influenced: null, verdict: 'inconclusive', reason: 'x' }, at: T0 + 1, stopReason: 'interrupted' });
    expect((await priced(rec))?.estimate).toMatchObject({ kind: 'injection' });
    const other = recording(T0 + MIN);
    clean(other, 'caused', T0 + 2);
    expect((await priced(other))?.estimate).toMatchObject({ kind: 'injection' });
  });

  it('prices a fork golden’s search at its ceiling once git says how many commits, and asks first until it has one to start from', async () => {
    const rec = recording();
    const crash = crashedTest(rec, T0 + 2 * MIN);
    const est = (await priced(crash, work([source(rec, { mode: 'fork' })])))?.estimate;
    expect(est).toMatchObject({ kind: 'bisect', usd: null, none: 'no estimate until it has a commit to start from' });
    // A repository of three commits: the golden passed at the first and crashed at the last.
    const dir = mkdtempSync(join(tmpdir(), 'sl-next-step-git-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' } }).trim();
      git('init', '-q');
      for (const m of ['one', 'two', 'three']) git('commit', '-q', '--allow-empty', '-m', m);
      const [last, , first] = git('log', '--format=%h').split('\n') as [string, string, string];
      const attempt = addRun(store, { parent: rec, startedAt: T0 + MIN, calls: 'rl', meta: { test: { golden: GOLDEN, session: 's0', attempt: 1 } } });
      const session = store.startTestSession({ command: ['shadowlap', 'test', GOLDEN], startedAt: T0 + MIN, revision: first }).sessionId;
      store.addTestResult({ sessionId: session, golden: GOLDEN, ok: true, runId: attempt, goldenRunId: rec, revision: first, at: T0 + MIN, data: { checks: [], spent: 0.01, attempts: { total: 1, passed: 1, required: 1, runs: [attempt] } } });
      const failing = store.startTestSession({ command: ['shadowlap', 'test', GOLDEN], startedAt: T0 + 3 * MIN, revision: last }).sessionId;
      const run = store.createRun({ mode: 'replay', parentRunId: rec, command: { argv: ['node', 'agent.mjs'], cwd: '.' }, codeVersion: last, startedAt: T0 + 3 * MIN, meta: { test: { golden: GOLDEN, session: failing } } });
      store.endRun(run.runId, 'failed');
      store.addTestResult({ sessionId: failing, golden: GOLDEN, ok: false, failure: 'exit', reason: 'the agent exited with code 1', runId: run.runId, goldenRunId: rec, revision: last, at: T0 + 3 * MIN, data: { attempts: { total: 1, passed: 0, required: 1, runs: [attempt] } } });
      const s = await priced(run.runId, work([source(rec, { mode: 'fork', repeat: 3 })], { dir }));
      expect(s).toMatchObject({ key: 'bisect', label: 'Find breaking commit…', starts: false });
      expect(s?.estimate).toMatchObject({ kind: 'bisect', ceiling: true, attempts: expect.any(Number), parts: [expect.stringContaining('3 attempts each'), 'live at each commit, as a golden marked fork runs'] });
      expect(s?.estimate?.usd).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a list’s rows', () => {
  it('carry each run’s step in its light form, the same step its page leads with, with no price', () => {
    const rec = recording(T0, { status: 'failed' });
    const passed = recording(T0 + MIN);
    const fork = addRun(store, { parent: rec, startedAt: T0 + 2 * MIN, divergence: 2, calls: 'rl' });
    const w = work([]);
    const rows = nextStepRows(store, judgedRows(store, listRuns(store), null, Infinity), w);
    const by = new Map(rows.map((r) => [r.runId, r.next]));
    expect(by.get(rec)).toEqual({ key: 'blame', label: 'Run blame' });
    expect(by.get(passed)).toEqual({ key: 'pack', label: 'Pack as golden…' });
    expect(by.get(fork)).toEqual({ key: 'compare', label: 'Compare with parent', href: `#/compare/${rec}/${fork}` });
    for (const id of [rec, passed, fork]) expect(by.get(id)).toEqual(stepRow(step(id, w)));
  });

  it('read no run’s calls for it, however many rows and however long their runs', () => {
    for (let i = 0; i < 40; i++) recording(T0 + i, { status: i % 2 ? 'failed' : 'completed' });
    const rows = listRuns(store);
    let read = 0;
    const getCalls = store.getCalls.bind(store);
    store.getCalls = ((...a: Parameters<typeof getCalls>) => (read++, getCalls(...a)));
    expect(nextStepRows(store, rows, work([])).every((r) => r.next)).toBe(true);
    expect(read).toBe(0);
  });
});

describe('a record a step can’t be read from', () => {
  // What reads the project throwing stands for any record a rule can't read: a pack can carry anything.
  const unreadable = { goldens: [], normalize: undefined, dir: '/work/project', get tests(): unknown { throw new Error('unreadable'); } } satisfies NextStepWork;

  it('leaves a list’s row with no step, and the other rows theirs', () => {
    const failed = recording(T0, { status: 'failed' });
    const passed = recording(T0 + MIN);
    const by = new Map(nextStepRows(store, listRuns(store), unreadable).map((r) => [r.runId, r.next]));
    expect(by.get(failed)).toBeUndefined();
    expect(by.get(passed)?.key).toBe('pack');
  });

  it('leaves its line in Needs a look as it was, where a run blame can’t take reads Open', () => {
    const NOW = Date.now();
    const noCall = recording(NOW - 2000, { status: 'failed', calls: 'b' });
    const failed = recording(NOW - 1000, { status: 'failed' });
    const action = (next: NextStepWork) => {
      const items = overviewSummary(store, { tz: 'UTC', now: NOW, next }).needsLook.items;
      return [noCall, failed].map((id) => items.find((i) => i.runId === id)?.action);
    };
    expect(action(work([]))).toEqual(['Open', 'Run blame']);
    expect(action(unreadable)).toEqual(['Run blame', 'Run blame']);
  });

  it('leaves its page with no step, and the Replay beside it', async () => {
    const failed = recording(T0, { status: 'failed' });
    expect(await pageSteps(store, failed, unreadable, { judged: undefined, whole: true })).toEqual({});
    expect(await pageSteps(store, failed, work([]), { judged: undefined, whole: true })).toMatchObject({ next: { key: 'blame' }, replay: { key: 'replay', runId: failed } });
  });

  it('reads checks that aren’t a list as none, and a test’s golden or session that isn’t text as no test', () => {
    const notAList = recording(T0, { status: 'failed', meta: { checks: 'x' as never } });
    expect(step(notAList)).toMatchObject({ key: 'blame', offer: { from: 'exit', failed: [] } });
    const rec = recording(T0 + 1);
    const session = addRun(store, { parent: rec, startedAt: T0 + MIN, status: 'failed', calls: 'r', meta: { test: { golden: GOLDEN, session: { a: 1 } as never } } });
    expect(step(session, work([source(rec)])).key).toBe('blame');
    const golden = addRun(store, { parent: rec, startedAt: T0 + 2 * MIN, status: 'failed', calls: 'r', meta: { test: { golden: 7 as never, session: 's1' } } });
    expect(step(golden, work([source(rec)])).key).toBe('blame');
  });
});

describe('an exported copy', () => {
  it('leads only with a comparison with a run it holds, as it runs nothing and holds no fix', () => {
    const rec = recording(T0, { status: 'failed' });
    const fork = addRun(store, { parent: rec, startedAt: T0 + MIN, status: 'failed', divergence: 2, calls: 'rl' });
    expect(copyNextStep(store, fork, [rec, fork])).toMatchObject({ key: 'compare', parent: rec });
    expect(copyNextStep(store, fork, [fork])).toBeNull();
    expect(copyNextStep(store, rec, [rec, fork])).toBeNull();
  });
});

describe('where a run’s page answer stands', () => {
  it('moves with the tests run on it, and a test replay’s with its golden’s results', () => {
    const rec = recording();
    const t = crashedTest(rec);
    const stamp = (id: string) => nextStepStamp(store, store.getRun(id)!);
    const was = [stamp(rec), stamp(t)];
    plant(rec, { gate: { obeyed: 0, influenced: null, verdict: 'failed', reason: 'x' } });
    expect(stamp(rec)).not.toBe(was[0]);
    const before = stamp(t);
    const recBefore = stamp(rec);
    passedTest(rec, T0 + 5 * MIN);
    expect(stamp(t)).not.toBe(before);
    // A recording's isn't moved by a test session of its golden.
    expect(stamp(rec)).toBe(recBefore);
  });
});
