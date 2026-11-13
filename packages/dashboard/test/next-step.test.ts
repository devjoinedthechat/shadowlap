import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { judgeCapture, NO_COMMAND, parseTests, recordBlame, recordEvent, rulesOnCalls, Store, type CleanReport, type DiffEntry, type Normalizer, type PlantReport, type RunMeta } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun } from '../../engine/test/fix-fixtures.js';
import { copyNextStep, failureKey, fixByFailure, nextStepOf, nextStepRows, nextStepStamp, pageSteps, pricedNextStep, replayStepOf, stepCalls, stepRow, type NextStepWork } from '../src/next-step.js';
import { goldenFolder } from '../src/run-offers.js';
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

  it('leaves a test Find breaking commit can’t start from to the rules after, never to an update nothing asked for', () => {
    const rec = recording();
    const ELSE: DiffEntry = { path: '$.messages[3].content', op: 'changed', before: 'a', after: 'b' };
    // A signal cut it short, with no test result: it says nothing about its golden, so it replays the recording.
    const session = store.startTestSession({ command: ['shadowlap', 'test', GOLDEN], startedAt: T0 + MIN, revision: 'bbbbbbb' }).sessionId;
    const cut = addRun(store, { parent: rec, startedAt: T0 + MIN, status: 'crashed', calls: 'r', meta: { test: { golden: GOLDEN, session } } });
    store.setDivergence(cut, { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, diff: [ELSE] });
    expect(step(cut, work([source(rec)]))).toMatchObject({ key: 'replay', label: 'Replay recording', runId: rec });
    // Its golden came out inconclusive there, neither passed nor failed: blame, as any failed run.
    const again = store.startTestSession({ command: ['shadowlap', 'test', GOLDEN], startedAt: T0 + 2 * MIN, revision: 'ccccccc' }).sessionId;
    const unsure = addRun(store, { parent: rec, startedAt: T0 + 2 * MIN, status: 'failed', calls: 'r', meta: { test: { golden: GOLDEN, session: again } } });
    store.setDivergence(unsure, { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, diff: [ELSE] });
    store.addTestResult({ sessionId: again, golden: GOLDEN, ok: false, failure: 'inconclusive', reason: 'gate', runId: unsure, goldenRunId: rec, revision: 'ccccccc', at: T0 + 2 * MIN, data: { verdict: 'inconclusive', gate: { decision: 'inconclusive' }, divergence: {} } as never });
    expect(step(unsure, work([source(rec)])).key).toBe('blame');
  });

  it('updates the golden of a test whose judge check couldn’t be judged offline, which asks the judge once', () => {
    const rec = recording();
    const session = store.startTestSession({ command: ['shadowlap', 'test', GOLDEN], startedAt: T0 + MIN }).sessionId;
    const t = addRun(store, { parent: rec, startedAt: T0 + MIN, calls: 'r', meta: { test: { golden: GOLDEN, session } } });
    const judge = { name: 'polite', model: 'claude-haiku-4-5', answer: null, cost: null };
    store.addTestResult({ sessionId: session, golden: GOLDEN, ok: false, failure: 'inconclusive', runId: t, goldenRunId: rec, at: T0 + MIN, data: { verdict: 'inconclusive', checks: [{ ok: false, status: 'inconclusive', label: 'judge: polite', detail: 'not judged: no recorded verdict', judge } as never] } });
    expect(step(t, work([source(rec, { checks: ['judge: polite'] })]))).toMatchObject({ key: 'update-golden', label: 'Update golden', sub: expect.stringContaining('Asks the judge once') });
    // A golden that forks asks its judges live: an update doesn't settle it.
    expect(step(t, work([source(rec, { mode: 'fork', checks: ['judge: polite'] })])).key).not.toBe('update-golden');
  });

  it('leaves a test whose golden is gone to what any failed run leads with', () => {
    const rec = recording();
    const t = divergedTest(rec, [UUID_CHANGE]);
    expect(step(t, work([]))).toMatchObject({ key: 'blame' });
  });

  it('packs the recording an attempt that obeyed proves, with its gate, until a golden is made from it', () => {
    const rec = recording();
    const obeyed = addRun(store, { parent: rec, startedAt: T0 + MIN, calls: 'rl', meta: { injection: { result: 'inj-1', role: 'attempt', read: 1, attempt: 1, of: 1, verdict: 'obeyed' }, repeat: { group: 'inj-1', attempt: 1, of: 1 } } });
    expect(step(obeyed)).toMatchObject({ key: 'pack-gate', label: 'Pack with injection gate…', runId: rec, folder: goldenFolder(rec), gate: { obeyed: 0, repeat: 3 }, title: `Pack ${rec.slice(0, 10)} with injection gate`, command: `shadowlap pack ${rec.slice(0, 10)} ${goldenFolder(rec)}` });
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
    expect(s).toMatchObject({ key: 'bisect', label: 'Find breaking commit', starts: true, command: `shadowlap bisect ${GOLDEN} --good aaaaaaa --bad a7b3c2e`, blame: { offer: { from: 'exit' }, sub: 'Whether an answer of the model’s lost the run', command: `shadowlap blame ${crash.slice(0, 10)}` }, sub: expect.stringContaining('offline: no tokens') });
    // With no commit it passed at, it asks for one.
    const other = Store.open(':memory:');
    const held = store;
    store = other;
    const rec2 = recording();
    expect(step(crashedTest(rec2), work([source(rec2)]))).toMatchObject({ key: 'bisect', label: 'Find breaking commit…', starts: false });
    other.close();
    store = held;
    // Once the commit is named, the change is the code's: Revert leads, Run blame plain beside it.
    recordEvent(store, { kind: 'bisect.found', ref: GOLDEN, runId: crash, data: { first: { rev: 'ccccccc', subject: 'Log the total', author: 'a', date: 'b' }, why: 'exit', answered: { at: T0 + 2 * MIN, ok: false } } });
    expect(step(crash, work([source(rec)]))).toMatchObject({ key: 'revert', label: 'Revert', rev: 'ccccccc', blame: { offer: { from: 'exit' } } });
  });

  it('leads a recording by its newest injection test: its proof, a test its budget stopped, one that showed too little', () => {
    const rec = recording();
    const attempt = addRun(store, { parent: rec, startedAt: T0 + 1, calls: 'rl', meta: { injection: { result: 'inj-1', role: 'attempt', read: 4, attempt: 1, of: 1, verdict: 'obeyed' }, repeat: { group: 'inj', attempt: 1, of: 1 } } });
    const failed: PlantReport['gate'] = { obeyed: 0, influenced: null, verdict: 'failed', reason: 'send_email obeyed' };
    plant(rec, { gate: failed, at: T0 + 1, attempts: [{ runId: attempt, read: 4, payload: 'system-notice', verdict: 'obeyed', evidence: [{ kind: 'canary', callNo: 6, tool: 'send_email', path: '$.to', value: 'x', why: null }], readAt: 5 }] });
    expect(step(rec)).toMatchObject({ key: 'injection-proof', label: 'Open proof', runId: attempt, href: `#/run/${attempt}/6`, title: `Opens ${attempt.slice(0, 10)}`, sub: expect.stringContaining('system-notice at #4') });
    // A newer test decides, and one still running says nothing yet.
    plant(rec, { gate: { obeyed: 0, influenced: null, verdict: 'inconclusive', reason: '3 of the 6 planned attempts ran' }, at: T0 + 2, stopReason: 'the budget of $2.00 is spent' });
    expect(step(rec)).toMatchObject({ key: 'injection-test', label: 'Run injection test…', runId: rec, command: `shadowlap injection ${rec.slice(0, 10)}`, sub: 'It stopped at its budget: test with fewer templates, or a higher budget' });
    // Any other stop says its own, not advice about a budget that wasn't spent.
    plant(rec, { gate: { obeyed: 0, influenced: null, verdict: 'inconclusive', reason: '1 of the 6 planned attempts ran' }, at: T0 + 2.5, stopReason: 'interrupted' });
    expect(step(rec)).toMatchObject({ key: 'injection-test', sub: 'It stopped early (interrupted): test it again' });
    plant(rec, { gate: { obeyed: 0, influenced: null, verdict: 'inconclusive', reason: 'no model read it' }, at: T0 + 3 });
    plant(rec, { gate: failed, at: T0 + 10, ended: false });
    expect(step(rec)).toMatchObject({ key: 'injection-again', label: 'Re-run injection test', runId: rec, job: { repeat: 2, templates: ['system-notice'], baselines: 2, liveReads: false }, command: `shadowlap injection ${rec.slice(0, 10)} --templates system-notice --baselines 2 --repeat 2`, sub: 'It showed too little to say: no model read it' });
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
    // Its own card needs no id: the page is the run's.
    expect(step(rec)).toMatchObject({ key: 'pack-gate', label: 'Pack with injection gate…', runId: rec, gate: { obeyed: 0, repeat: 3 } });
    expect(step(rec)).not.toHaveProperty('title');
    expect(step(rec, work([source(rec)])).key).toBe('replay');
    // Nor does a golden of a fork of it count, as it doesn't test this one; one it was unpacked from does.
    const fork = addRun(store, { parent: rec, startedAt: T0 + MIN, divergence: 2, calls: 'rl' });
    expect(step(rec, work([source(fork)])).key).toBe('pack-gate');
    const unpacked = recording(T0 + MIN, { meta: { imported: { at: T0, from: `/work/project/${GOLDEN}` } } });
    clean(unpacked, 'caused', T0 + 2);
    expect(step(unpacked).key).toBe('pack-gate');
    expect(step(unpacked, work([source(null)])).key).not.toBe('pack-gate');
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
    expect(step(held)).toMatchObject({ key: 'fix', label: 'Open fix', fixId: fix.fixId, status: 'open', check: fix.check.text, title: '“Refunds above the limit”', href: expect.stringContaining(fix.fixId) });
    // Blame needs a model call to ask again, and a run that was only stopped has nothing to blame.
    expect(step(recording(T0 + MIN, { status: 'failed', calls: 'b' })).key).toBe('replay');
  });

  it('adds the rule a replay’s divergence proposes, as its own banner did', () => {
    const rec = recording();
    const fork = addRun(store, { parent: rec, startedAt: T0 + MIN, divergence: 1, calls: 'l' });
    store.setDivergence(fork, { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, hints: [{ message: 'looks like a UUID', normalizer: RULE }] });
    expect(step(fork)).toMatchObject({ key: 'rule', label: 'Add normalizer', command: `shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'` });
  });

  it('packs a recording that passed, with no golden made from it, and replays anything else', () => {
    const rec = recording();
    expect(step(rec)).toMatchObject({ key: 'pack', label: 'Pack as golden…', runId: rec, folder: goldenFolder(rec), command: `shadowlap pack ${rec.slice(0, 10)} ${goldenFolder(rec)}` });
    expect(goldenFolder(rec)).toBe(`goldens/${rec.slice(0, 10).toLowerCase()}`);
    // No project to pack into, a recording a golden is packed from, and one that failed its family's checks today.
    expect(step(rec, null).key).toBe('replay');
    expect(step(rec, work([source(rec)])).key).toBe('replay');
    // A golden packed from a fork of it says nothing of this one, which can still be kept.
    const fork = addRun(store, { parent: rec, startedAt: T0 + MIN, divergence: 2, calls: 'rl' });
    expect(step(rec, work([source(fork)])).key).toBe('pack');
    expect(step(rec, work([]), { judged: { by: 'family', verdict: 'failed', counts: { passed: 0, failed: 1, inconclusive: 0, notApplicable: 0 }, callNo: null, first: null, today: true, goldens: [], why: null } }).key).toBe('replay');
    // A recording cut short says nothing, and neither does one that made no call.
    expect(step(addRun(store, { startedAt: T0 + 2 * MIN, status: 'crashed', calls: 'l' })).key).toBe('replay');
    expect(step(addRun(store, { startedAt: T0 + 3 * MIN, calls: '' })).key).toBe('replay');
    // A clean or a test replay replays the recording it came from; a capture asks for a command.
    const replayed = addRun(store, { parent: rec, startedAt: T0 + MIN, calls: 'rrr' });
    expect(step(replayed)).toMatchObject({ key: 'replay', label: 'Replay recording', runId: rec, title: `Replays ${rec.slice(0, 10)}, the recording this replay came from`, command: `shadowlap replay ${rec.slice(0, 10)}` });
    const capture = addRun(store, { startedAt: T0 + MIN, argv: [NO_COMMAND], meta: { imported: { at: T0, from: '/work/cap.jsonl' }, covers: ['api'] }, calls: 'll' });
    expect(step(capture)).toMatchObject({ key: 'replay', label: 'Replay with your command…', runId: capture, command: `shadowlap replay ${capture.slice(0, 10)} -- <your command>` });
    // A clean replay of a capture replays the capture too, which takes your command: the action that asks for it comes with the step.
    const ofCapture = addRun(store, { parent: capture, startedAt: T0 + 2 * MIN, calls: 'rr' });
    expect(step(ofCapture)).toMatchObject({ key: 'replay', label: 'Replay recording', runId: capture, command: `shadowlap replay ${capture.slice(0, 10)} -- <your command>`, action: { key: 'r', prompt: { label: expect.stringContaining('What starts your agent?') } } });
    expect(step(replayed)).not.toHaveProperty('action');
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
    // A list's row says so too: its palette entry sends it to its page, which asks.
    expect(stepRow(blamed)).toEqual({ key: 'blame', label: 'Run blame', capture: true, command: blamed.command });
    // Not judged yet, as a list's row past its budget: Replay with your command…, its step until then.
    expect(step(capture, w).key).toBe('replay');
    // A fix that holds the same failure, whatever its call numbers and amounts: Open fix.
    const held = makeRun(store, { labels: ['refund-bug'], calls: ['api'] });
    const { fix } = recordBlame(store, { runId: held, report: { ...blameReport(held), oracle: ['every issue_refund call: amount <= 250'] }, expect: EXPECT, scope: null, command: 'shadowlap blame x', title: 'Refunds above the limit', checkText: 'send_email called once', at: T0 });
    expect(step(capture, w, { judged: { ...judged!, first: { label: 'every issue_refund call: amount <= 100', detail: null } } })).toMatchObject({ key: 'fix', fixId: fix.fixId, check: fix.check.text });
  });

  it('shows commands that paste: every word quoted where it needs it, and only what you fill in left as it is', () => {
    const typed = (command: string): string[] => execFileSync('sh', ['-c', command.replace(/^shadowlap/, `printf '%s\\n'`)], { encoding: 'utf8' }).trim().split('\n');
    const expect1 = { calls: [{ tool: 'send_email', args: { subject: { contains: 'it’s' } } }], tools: { "o'brien": 1 } };
    const rec = recording(T0, { status: 'failed', meta: { expect: expect1, checks: [{ ok: false, label: 'x', detail: 'y' }] } });
    const s = step(rec);
    expect(typed(s.command!)).toEqual(['blame', rec.slice(0, 10), '--expect', JSON.stringify(expect1)]);
    // A golden's folder with a space, as a tests entry may name it.
    const spaced = 'goldens/refund in limit';
    const held = recording(T0 + 1);
    const session = store.startTestSession({ command: ['shadowlap', 'test', spaced], startedAt: T0 + MIN }).sessionId;
    const t = addRun(store, { parent: held, startedAt: T0 + MIN, status: 'failed', calls: 'r', meta: { test: { golden: spaced, session } } });
    store.setDivergence(t, { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, diff: [{ path: '$.system', op: 'changed', before: 'a', after: 'b' }] });
    store.addTestResult({ sessionId: session, golden: spaced, ok: false, failure: 'diverged', reason: 'diverged', runId: t, goldenRunId: held, at: T0 + MIN });
    const update = step(t, work([source(held, { path: spaced })]));
    expect(update.key).toBe('update-golden');
    expect(typed(update.command!)).toEqual(['test', spaced, '--update']);
    // What you fill in stays a placeholder.
    expect(step(addRun(store, { startedAt: T0 + 2, argv: [NO_COMMAND], meta: { imported: { at: T0, from: '/work/cap.jsonl' }, covers: ['api'] }, calls: 'l' })).command).toMatch(/^shadowlap replay \S+ -- <your command>$/);
  });

  it('tells failures apart without their call numbers and amounts', () => {
    expect(failureKey('check failed: send_email called 1 time')).toBe('send_email called 1');
    expect(failureKey('send_email called 2 times, but called 3 times')).toBe('send_email called 2');
    expect(failureKey('issue_refund #4: amount 300 > total 240.50 (#2)')).toBe('issue_refund: amount N > total N');
    expect(fixByFailure([], 'x')).toBeNull();
  });
});

describe('a run’s next step, at its edges', () => {
  it('has none for a run the store doesn’t have', async () => {
    const NONE = '01M5JEQWA2QMJ3NYD1C687WP00';
    expect(nextStepOf(store, NONE, work([]))).toBeNull();
    expect(await pricedNextStep(store, NONE, work([]), { judged: null, kept: () => true })).toBeNull();
    expect(replayStepOf(store, NONE)).toBeNull();
    expect(await pageSteps(store, NONE, work([]), { judged: null, kept: () => true })).toEqual({});
  });

  it('reads a run its recorder left marked running as interrupted, as every list does: nothing to wait for', () => {
    const left = '01K4ZZ0000000000000000LEFT';
    store.importRun({ runId: left, parentRunId: null, mode: 'record', status: 'running', divergence: null, command: { argv: ['node', 'agent.mjs'], cwd: '/work' }, codeVersion: null, startedAt: T0, endedAt: null, meta: {} });
    const s = step(left);
    expect(s).toMatchObject({ key: 'replay', label: 'Replay', runId: left });
    expect(s).not.toHaveProperty('off');
  });

  it('finds the commit of a crash its session kept no result for, asking where to start', () => {
    const rec = recording();
    const session = store.startTestSession({ command: ['shadowlap', 'test', GOLDEN], startedAt: T0 + MIN }).sessionId;
    const t = addRun(store, { parent: rec, startedAt: T0 + MIN, status: 'failed', calls: 'rl', meta: { test: { golden: GOLDEN, session } } });
    expect(step(t, work([source(rec)]))).toMatchObject({ key: 'bisect', label: 'Find breaking commit…', starts: false });
  });

  it('leaves a crash Find breaking commit can’t start from to the rules after: a session its golden came out inconclusive in', () => {
    const rec = recording();
    const session = store.startTestSession({ command: ['shadowlap', 'test', GOLDEN], startedAt: T0 + MIN, revision: 'bbbbbbb' }).sessionId;
    const t = addRun(store, { parent: rec, startedAt: T0 + MIN, status: 'failed', calls: 'rl', meta: { test: { golden: GOLDEN, session } } });
    store.addTestResult({ sessionId: session, golden: GOLDEN, ok: false, failure: 'exit', reason: 'the agent exited with code 1', runId: t, goldenRunId: rec, revision: 'bbbbbbb', at: T0 + MIN, data: { verdict: 'inconclusive' } as never });
    expect(step(t, work([source(rec)])).key).toBe('blame');
  });

  it('finds the commit of a divergence that kept no diff, as anything it can’t read as a change that was meant', () => {
    const rec = recording();
    const t = divergedTest(rec, []);
    store.setDivergence(t, { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0 });
    expect(step(t, work([source(rec)])).key).toBe('bisect');
  });

  it('opens the attempt a failed test’s proof is, among those the store still has, at the call that shows it', () => {
    const rec = recording();
    const failed: PlantReport['gate'] = { obeyed: 0, influenced: null, verdict: 'failed', reason: 'it obeyed' };
    // Its attempts are gone: there is nothing to open, and the rules after decide.
    plant(rec, { gate: failed, at: T0 + 1, attempts: [{ runId: '01M5JEQWA2QMJ3NYD1C687WP00', read: 4, payload: 'system-notice', verdict: 'obeyed' }] });
    expect(step(rec).key).toBe('pack');
    // No evidence: at the read it answered.
    const attempt = addRun(store, { parent: rec, startedAt: T0 + 2, calls: 'rl', meta: { injection: { result: 'inj-1', role: 'attempt', read: 4, attempt: 1, of: 1, verdict: 'influenced' }, repeat: { group: 'inj', attempt: 1, of: 1 } } });
    plant(rec, { gate: failed, at: T0 + 3, attempts: [{ runId: attempt, read: 4, payload: 'system-notice', verdict: 'influenced', readAt: 5 }] });
    expect(step(rec)).toMatchObject({ key: 'injection-proof', href: `#/run/${attempt}/5` });
    // Nor a call: the run. (An attempt that couldn't say proves nothing: the engine's proofOf, tested there.)
    plant(rec, { gate: failed, at: T0 + 4, attempts: [{ runId: attempt, read: 4, payload: 'system-notice', verdict: 'influenced' }] });
    expect(step(rec)).toMatchObject({ key: 'injection-proof', href: `#/run/${attempt}` });
  });

  it('opens the attempt that shows a failed preset, the last where none failed, and none where they are gone', () => {
    const rec = recording();
    store.startChaosSession({ sessionId: 'cs-gone', startedAt: T0, command: ['shadowlap', 'replay', rec, '--chaos'], presets: ['timeout'] });
    store.addChaosResult({ sessionId: 'cs-gone', runId: rec, golden: null, preset: 'timeout', verdict: 'failed', callNo: null, passes: 0, attempts: 1, at: T0 + 1, data: { runs: [{ runId: '01M5JEQWA2QMJ3NYD1C687WP00', passed: false, verdict: 'failed', exitCode: 1 }] } });
    expect(step(rec).key).toBe('pack');
    const other = recording(T0 + MIN);
    const passed = addRun(store, { parent: other, startedAt: T0 + MIN + 1, calls: 'rl', meta: { chaos: { preset: 'timeout', callNo: 2, session: 'cs-2', attempt: 1 } } });
    store.startChaosSession({ sessionId: 'cs-2', startedAt: T0 + MIN, command: ['shadowlap', 'replay', other, '--chaos'], presets: ['timeout'] });
    store.addChaosResult({ sessionId: 'cs-2', runId: other, golden: null, preset: 'timeout', verdict: 'failed', callNo: null, passes: 1, attempts: 2, at: T0 + MIN + 2, data: { runs: [{ runId: passed, passed: true, verdict: 'passed', exitCode: 0 }] } });
    expect(step(other)).toMatchObject({ key: 'preset-proof', runId: passed, href: `#/run/${passed}/1` });
  });

  it('asks a judged capture’s blame for the check where the config can’t be read or names none it broke', () => {
    const capture = addRun(store, { startedAt: T0, argv: [NO_COMMAND], meta: { imported: { at: T0, from: '/work/cap.jsonl' }, covers: ['api', 'tool'], judged: { rules: 'r', at: T0, verdict: 'failed', why: null, checks: [{ status: 'failed', ok: false, label: 'every issue_refund call: amount <= 100', detail: 'x' }] } } as never, calls: 'l' });
    const judged = { by: 'import', verdict: 'failed', counts: { passed: 0, failed: 1, inconclusive: 0, notApplicable: 0 }, callNo: null, first: null, today: false, goldens: [], why: null, checks: [] } as never;
    // A config that doesn't parse, and one whose rules are others.
    for (const tests of [{ [GOLDEN]: { expect: 'nope' } }, { [GOLDEN]: { expect: { calls: [{ tool: 'send_email', args: { to: { eq: 'a' } } }] } } }, 'nope']) {
      expect(step(capture, work([], { tests }), { judged })).toMatchObject({ key: 'blame', capture: true, offer: { from: 'ask', failed: [] }, command: expect.stringContaining(`--expect '<what it must do>' -- <your command>`) });
    }
  });

  it('offers no pack with nowhere to pack it: no project, to an attempt that obeyed or a read that caused a write', () => {
    const rec = recording();
    const obeyed = addRun(store, { parent: rec, startedAt: T0 + MIN, calls: 'rl', meta: { injection: { result: 'inj-1', role: 'attempt', read: 1, attempt: 1, of: 1, verdict: 'obeyed' }, repeat: { group: 'inj-1', attempt: 1, of: 1 } } });
    expect(step(obeyed, null).key).toBe('compare');
    clean(rec, 'caused', T0 + 2);
    expect(step(rec, null).key).toBe('replay');
  });

  it('says how long a step’s read may take from the runs its price may read', () => {
    const rec = recording(T0, { calls: 'l'.repeat(5) });
    const t = divergedTest(rec, [UUID_CHANGE]);
    const run = store.getRun(t)!;
    expect(stepCalls(store, run, work([source(rec)]))).toBe(1 + 5 + 5);
    expect(stepCalls(store, run, work([]))).toBe(1 + 5);
    expect(stepCalls(store, store.getRun(rec)!, null)).toBe(5);
  });
});

describe('what the next step of a run bills', () => {
  const priced = (id: string, w: NextStepWork | null = work([]), kept: (runId: string) => boolean = () => true) => pricedNextStep(store, id, w, { judged: undefined, kept });
  const LONG = 'l'.repeat(1000);

  it('prices Run blame at its ceiling, from the run’s model calls', async () => {
    const rec = recording(T0, { status: 'failed' });
    expect((await priced(rec))?.estimate).toMatchObject({ kind: 'blame', ceiling: true, usd: expect.any(Number) });
    expect((await priced(rec))?.estimate?.usd).toBeGreaterThan(0);
    expect(step(rec).estimate).toBeUndefined();
  });

  it('leaves it to later on a long run’s first answer, as it would read every call, and works it out once those are kept', async () => {
    const rec = recording(T0, { status: 'failed', calls: LONG });
    const first = await priced(rec, work([]), () => false);
    expect(first).toMatchObject({ key: 'blame', later: true });
    expect(first?.estimate).toBeUndefined();
    const whole = await priced(rec);
    expect(whole?.estimate).toMatchObject({ kind: 'blame', ceiling: true });
    expect(whole).not.toHaveProperty('later');
    // A short one reads its calls on any answer.
    expect((await priced(recording(T0 + 1, { status: 'failed' }), work([]), () => false))?.estimate?.kind).toBe('blame');
  });

  it('reads no other long run for a short run’s first answer: an update priced from the golden’s long recording', async () => {
    const rec = recording(T0, { calls: LONG });
    const t = divergedTest(rec, [{ path: '$.system', op: 'changed', before: 'a', after: 'b' }]);
    let read = 0;
    const getCalls = store.getCalls.bind(store);
    store.getCalls = ((...a: Parameters<typeof getCalls>) => (a[0] === rec && read++, getCalls(...a)));
    const first = await priced(t, work([source(rec)]), (id) => id === t);
    expect(read).toBe(0);
    store.getCalls = getCalls;
    expect(first).toMatchObject({ key: 'update-golden', later: true });
    expect(first?.estimate).toBeUndefined();
    expect((await priced(t, work([source(rec)])))?.estimate).toMatchObject({ kind: 'update' });
    // Nor the recording an attempt that obeyed proves, for its gate.
    const obeyed = addRun(store, { parent: rec, startedAt: T0 + 2 * MIN, calls: 'rl', meta: { injection: { result: 'inj-1', role: 'attempt', read: 1, attempt: 1, of: 1, verdict: 'obeyed' }, repeat: { group: 'inj-1', attempt: 1, of: 1 } } });
    expect(await priced(obeyed, work([]), (id) => id === obeyed)).toMatchObject({ key: 'pack-gate', later: true });
  });

  it('works out on any answer a price that reads no calls: a test again, a judge’s one call', async () => {
    const rec = recording(T0, { calls: LONG });
    plant(rec, { gate: { obeyed: 0, influenced: null, verdict: 'inconclusive', reason: 'x' }, at: T0 + 1 });
    const again = await priced(rec, work([]), () => false);
    expect(again).toMatchObject({ key: 'injection-again', estimate: { kind: 'injection', usd: 3.11 } });
    expect(again).not.toHaveProperty('later');
    const other = recording(T0 + MIN, { calls: LONG });
    const session = store.startTestSession({ command: ['shadowlap', 'test', GOLDEN], startedAt: T0 + 2 * MIN }).sessionId;
    const t = addRun(store, { parent: other, startedAt: T0 + 2 * MIN, calls: 'r', meta: { test: { golden: GOLDEN, session } } });
    const judge = { name: 'polite', model: 'claude-haiku-4-5', answer: null, cost: 0.0005 };
    store.addTestResult({ sessionId: session, golden: GOLDEN, ok: false, failure: 'inconclusive', runId: t, goldenRunId: other, at: T0 + 2 * MIN, data: { verdict: 'inconclusive', checks: [{ ok: false, status: 'inconclusive', label: 'judge: polite', detail: 'not judged', judge } as never] } });
    const update = await priced(t, work([source(other, { checks: ['judge: polite'] })]), () => false);
    expect(update).toMatchObject({ key: 'update-golden', sub: expect.stringContaining('Asks the judge once'), estimate: { kind: 'update', parts: expect.arrayContaining([expect.stringContaining('judge')]) } });
    expect(update?.estimate?.usd).toBeCloseTo(0.0005, 5);
    expect(update).not.toHaveProperty('later');
  });

  it('leaves out an estimate it can’t work out, never the step', async () => {
    const rec = recording();
    plant(rec, { gate: { obeyed: 0, influenced: null, verdict: 'inconclusive', reason: 'x' }, at: T0 + 1, cost: { unknownModels: undefined as never } });
    const s = await priced(rec);
    expect(s).toMatchObject({ key: 'injection-again' });
    expect(s?.estimate).toBeUndefined();
  });

  it('says a long run’s step may change with its verdict, while its first answer has none', async () => {
    const rec = recording(T0, { calls: LONG });
    expect((await pageSteps(store, rec, work([]), { judged: undefined, kept: () => false })).next).toMatchObject({ key: 'pack', later: true });
    expect((await pageSteps(store, rec, work([]), { judged: null, kept: () => false })).next).not.toHaveProperty('later');
  });

  it('prices an update of a golden at what its recording cost, and asks first for what it does', async () => {
    const rec = recording();
    const t = divergedTest(rec, [{ path: '$.system', op: 'changed', before: 'a', after: 'b' }]);
    expect((await priced(t, work([source(rec)])))?.estimate).toMatchObject({ kind: 'update', ceiling: false, always: 'it replaces goldens', usd: expect.any(Number) });
    // The recording's model calls, at their model's price.
    const est = (await priced(t, work([source(rec)])))?.estimate;
    expect(est?.usd).toBeGreaterThan(0);
  });

  it('prices the Run blame beside a crash’s Find breaking commit, which itself bills nothing', async () => {
    const rec = recording();
    passedTest(rec, T0 + MIN);
    const crash = crashedTest(rec, T0 + 2 * MIN);
    const s = await priced(crash, work([source(rec)]));
    expect(s).toMatchObject({ key: 'bisect', blame: { estimate: { kind: 'blame', ceiling: true } } });
    expect(s?.estimate).toBeUndefined();
    // On a long crash its first answer leaves it out, with the step.
    const held = recording(T0 + MIN);
    const session = store.startTestSession({ command: ['shadowlap', 'test', GOLDEN], startedAt: T0 + 3 * MIN, revision: 'bbbbbbb' }).sessionId;
    const long = addRun(store, { parent: held, startedAt: T0 + 3 * MIN, status: 'failed', calls: LONG, meta: { test: { golden: GOLDEN, session } } });
    store.addTestResult({ sessionId: session, golden: GOLDEN, ok: false, failure: 'exit', reason: 'the agent exited with code 1', runId: long, goldenRunId: held, revision: 'bbbbbbb', at: T0 + 3 * MIN });
    const first = await priced(long, work([source(held)]), () => false);
    expect(first).toMatchObject({ key: 'bisect', later: true });
    expect(first?.key === 'bisect' && first.blame?.estimate).toBeUndefined();
    // A fix that holds it leaves no Run blame beside it.
    recordBlame(store, { runId: crash, report: blameReport(crash), expect: EXPECT, scope: null, command: 'shadowlap blame x', title: 'A crash', checkText: 'it exits 0', at: T0 });
    expect(step(crash, work([source(rec)]))).toMatchObject({ key: 'bisect', blame: null });
  });

  it('says on a card that names another run what that run was about, on its page alone', async () => {
    const ASK = 'Order A-1103 arrived damaged';
    const rec = addRun(store, { startedAt: T0, calls: [{ code: 'l', request: { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: ASK }] } }] });
    const fork = addRun(store, { parent: rec, startedAt: T0 + MIN, divergence: 1, calls: 'l' });
    expect(await priced(fork)).toMatchObject({ key: 'compare', title: `Against ${rec.slice(0, 10)}`, sub: ASK });
    expect(step(fork).sub).toBeUndefined();
    expect(stepRow(step(fork))).not.toHaveProperty('sub');
    expect(step(fork)).not.toHaveProperty('about');
    // Open passing run, of the run it opens.
    const t = crashedTest(rec, T0 + 2 * MIN);
    const passed = passedTest(rec, T0 + 3 * MIN);
    const s = await priced(t, work([source(rec)]));
    expect(s).toMatchObject({ key: 'passing', runId: passed, title: `Opens ${passed.slice(0, 10)}` });
    expect(typeof s?.sub).toBe('string');
    // A long recording's reads no more of it than a list does.
    const long = addRun(store, { startedAt: T0 + 4 * MIN, calls: LONG });
    const of = addRun(store, { parent: long, startedAt: T0 + 5 * MIN, divergence: 1, calls: 'l' });
    let read = 0;
    const getCalls = store.getCalls.bind(store);
    store.getCalls = ((...a: Parameters<typeof getCalls>) => {
      const calls = getCalls(...a);
      if (a[0] === long) read += calls.length;
      return calls;
    });
    await priced(of, work([]), (id) => id === of);
    store.getCalls = getCalls;
    expect(read).toBeLessThan(100);
    // One that can't be read leaves its sentence out, never the step.
    store.getCalls = (() => {
      throw new Error('unreadable');
    });
    const unread = await priced(of, work([]), (id) => id === of);
    store.getCalls = getCalls;
    expect(unread).toMatchObject({ key: 'compare' });
    expect(unread?.sub).toBeUndefined();
  });

  it('leaves what bills nothing with no estimate: a golden’s bisect, its re-run (never where its injection gate runs live), a pack, a replay', async () => {
    const rec = recording();
    passedTest(rec, T0 + MIN);
    const crash = crashedTest(rec, T0 + 2 * MIN);
    expect((await priced(crash, work([source(rec)])))?.estimate).toBeUndefined();
    const other = recording(T0 + 3 * MIN);
    expect((await priced(other))?.key).toBe('pack');
    expect((await priced(other))?.estimate).toBeUndefined();
    const t = divergedTest(rec, [UUID_CHANGE], { at: T0 + 4 * MIN });
    for (const [injection, kind, usd] of [[false, 'tests', 0], [true, 'injection', null]] as const) expect((await priced(t, work([source(rec, { injection })])))?.estimate, String(injection)).toMatchObject({ kind, usd });
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
      // A gate says how many attempts each commit may take, and what they count up to.
      expect((await priced(run.runId, work([source(rec, { mode: 'fork', gate: { good: 0.9, bad: 0.7, risk: 0.05, max: 7 } as never })], { dir })))?.estimate?.parts?.[0]).toContain('7 attempts');
      // With changes on top of its commit, the search goes up to HEAD, which git can count.
      const dirty = store.createRun({ mode: 'replay', parentRunId: rec, command: { argv: ['node', 'agent.mjs'], cwd: '.' }, codeVersion: `${last}+dirty`, startedAt: T0 + 4 * MIN, meta: { test: { golden: GOLDEN, session: failing } } });
      store.endRun(dirty.runId, 'failed');
      expect((await priced(dirty.runId, work([source(rec, { mode: 'fork', repeat: 3 })], { dir })))?.estimate).toMatchObject({ kind: 'bisect', ceiling: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a revision that came with a run', () => {
  const priced = (id: string, w: NextStepWork) => pricedNextStep(store, id, w, { judged: undefined, kept: () => true });
  /** A crash of a golden, with what its results and its run's own revision say. */
  function crash(rec: string, o: { good: string; bad: string }): string {
    const passing = store.startTestSession({ command: ['shadowlap', 'test', GOLDEN], startedAt: T0 + MIN, revision: o.good }).sessionId;
    const passed = addRun(store, { parent: rec, startedAt: T0 + MIN, calls: 'r', meta: { test: { golden: GOLDEN, session: passing } } });
    store.addTestResult({ sessionId: passing, golden: GOLDEN, ok: true, runId: passed, goldenRunId: rec, revision: o.good, at: T0 + MIN });
    const failing = store.startTestSession({ command: ['shadowlap', 'test', GOLDEN], startedAt: T0 + 2 * MIN, revision: o.bad }).sessionId;
    const run = store.createRun({ mode: 'replay', parentRunId: rec, command: { argv: ['node', 'agent.mjs'], cwd: '.' }, codeVersion: o.bad, startedAt: T0 + 2 * MIN, meta: { test: { golden: GOLDEN, session: failing } } });
    store.endRun(run.runId, 'failed');
    store.addTestResult({ sessionId: failing, golden: GOLDEN, ok: false, failure: 'exit', reason: 'the agent exited with code 1', runId: run.runId, goldenRunId: rec, revision: o.bad, at: T0 + 2 * MIN });
    return run.runId;
  }

  it('reaches git only as a commit’s hex name, however it reads: a file it names as an option stays as it is', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-next-step-rev-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      const victim = join(dir, 'victim.txt');
      writeFileSync(victim, 'keep me\n');
      const rec = recording();
      const run = crash(rec, { good: `--output=${victim}`, bad: 'bbbbbbb' });
      const s = await priced(run, work([source(rec, { mode: 'fork' })], { dir }));
      expect(s?.estimate).toMatchObject({ kind: 'bisect', usd: null, none: 'no estimate until it has a commit to start from' });
      expect(readFileSync(victim, 'utf8')).toBe('keep me\n');
      // Nor is it shown to paste, or started from: the step asks for a commit.
      expect(s).toMatchObject({ key: 'bisect', label: 'Find breaking commit…', starts: false, command: `shadowlap bisect ${GOLDEN} --good <commit> --bad bbbbbbb` });
      expect(s?.sub).not.toContain('--output');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the end of the search out the same, where the run’s own revision is no commit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-next-step-rev-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      const victim = join(dir, 'victim.txt');
      writeFileSync(victim, 'keep me\n');
      const rec = recording();
      const run = crash(rec, { good: 'aaaaaaa', bad: `--output=${victim}` });
      const s = await priced(run, work([source(rec, { mode: 'fork' })], { dir }));
      expect(s?.estimate).toMatchObject({ kind: 'bisect', usd: null, none: 'no estimate: the revision it would search up to is no commit' });
      expect(readFileSync(victim, 'utf8')).toBe('keep me\n');
      expect(s?.command).toBe(`shadowlap bisect ${GOLDEN} --good aaaaaaa`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says what git says of a search it can’t count', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-next-step-rev-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      const rec = recording();
      const run = crash(rec, { good: 'aaaaaaa', bad: 'bbbbbbb' });
      expect((await priced(run, work([source(rec, { mode: 'fork' })], { dir })))?.estimate).toMatchObject({ kind: 'bisect', usd: null, none: 'git could not say how many commits it would search' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leads as any failed run does where the golden’s pack can’t be read, or its path reads as an option', () => {
    const rec = recording();
    expect(step(crashedTest(rec), work([source(rec, { error: 'run.json is not JSON' })])).key).toBe('blame');
    const option = source(rec, { path: '--output=x' });
    const session = store.startTestSession({ command: ['shadowlap', 'test', option.path], startedAt: T0 + 3 * MIN }).sessionId;
    const other = addRun(store, { parent: rec, startedAt: T0 + 3 * MIN, status: 'failed', calls: 'r', meta: { test: { golden: option.path, session } } });
    expect(step(other, work([option])).key).toBe('blame');
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
    expect(by.get(rec)).toEqual({ key: 'blame', label: 'Run blame', command: `shadowlap blame ${rec.slice(0, 10)}` });
    expect(by.get(passed)).toEqual({ key: 'pack', label: 'Pack as golden…', title: 'Pack as golden', command: `shadowlap pack ${passed.slice(0, 10)} ${goldenFolder(passed)}`, folder: goldenFolder(passed) });
    expect(by.get(fork)).toEqual({ key: 'compare', label: 'Compare with parent', href: `#/compare/${rec}/${fork}`, title: `Against ${rec.slice(0, 10)}`, command: `shadowlap diff ${rec.slice(0, 10)} ${fork.slice(0, 10)}` });
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

describe('what a list reads for its rows’ steps', () => {
  /** What the store is asked, counted, while `read` runs. */
  function counted(read: () => void) {
    const n = { histories: 0, results: 0, getRun: 0, blames: 0, index: 0 };
    const was = { listTestResults: store.listTestResults.bind(store), getRun: store.getRun.bind(store), blamesOfRun: store.blamesOfRun.bind(store), query: store.query.bind(store) };
    store.listTestResults = ((o: Parameters<typeof was.listTestResults>[0]) => {
      const rows = was.listTestResults(o);
      n.results += rows.length;
      if (o?.golden && !o.sessionId) n.histories++;
      return rows;
    });
    store.getRun = ((id: string) => (n.getRun++, was.getRun(id)));
    store.blamesOfRun = ((id: string) => (n.blames++, was.blamesOfRun(id)));
    store.query = ((sql: string, ...params: never[]) => {
      if (sql.includes('change_counts')) n.index++;
      return was.query(sql, ...params);
    });
    read();
    Object.assign(store, was);
    return n;
  }

  it('reads a golden’s results once, however many rows fail it and however long its history', () => {
    const OTHER = 'goldens/other';
    const rec = recording();
    const HISTORY = 120;
    for (let i = 0; i < HISTORY; i++) passedTest(rec, T0 + MIN + i * 1000, `a${String(i).padStart(6, '0')}`);
    const FAILING = 20;
    const failing = [...Array(FAILING).keys()].map((i) => (i % 2 ? crashedTest(rec, T0 + 2 * HISTORY * 1000 + i * 1000) : divergedTest(rec, [{ path: '$.messages[3].content', op: 'changed', before: 'a', after: 'b' }], { at: T0 + 2 * HISTORY * 1000 + i * 1000 })));
    // A second golden, with one failure.
    const session = store.startTestSession({ command: ['shadowlap', 'test', OTHER], startedAt: T0 + 4 * HISTORY * 1000, revision: 'bbbbbbb' }).sessionId;
    const other = addRun(store, { parent: rec, startedAt: T0 + 4 * HISTORY * 1000, status: 'failed', calls: 'rl', meta: { test: { golden: OTHER, session } } });
    store.addTestResult({ sessionId: session, golden: OTHER, ok: false, failure: 'exit', reason: 'the agent exited with code 1', runId: other, goldenRunId: rec, revision: 'bbbbbbb', at: T0 + 4 * HISTORY * 1000 });
    const rows = listRuns(store);
    const w = work([source(rec), source(rec, { path: OTHER })]);
    let keys: Array<string | undefined> = [];
    const n = counted(() => {
      keys = nextStepRows(store, rows, w).filter((r) => failing.includes(r.runId)).map((r) => r.next?.key);
    });
    expect(new Set(keys)).toEqual(new Set(['bisect']));
    expect(n.histories).toBe(2);
    // Each golden's history, and each row's own result: never rows times history.
    expect(n.results).toBeLessThan(HISTORY + FAILING + 1 + rows.length + FAILING);
  });

  it('asks a golden that passes for no history, and the run index and each row’s fix only once', () => {
    const rec = recording();
    for (let i = 0; i < 10; i++) passedTest(rec, T0 + MIN + i * 1000);
    const FAILED = 12;
    for (let i = 0; i < FAILED; i++) recording(T0 + 10 * MIN + i, { status: 'failed' });
    const rows = listRuns(store);
    const n = counted(() => nextStepRows(store, rows, work([source(rec)])));
    expect(n.histories).toBe(0);
    expect(n.blames).toBe(FAILED);
    // Two looks at the index for the list: its own, and what tells each run's state.
    expect(n.index).toBeLessThanOrEqual(2);
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

  it('leaves its row in Needs a look, with no step where blame can’t take the run or its record can’t be read', () => {
    const NOW = Date.now();
    recording(NOW - 2000, { status: 'failed' });
    const noCall = recording(NOW - 1000, { status: 'failed', calls: 'b' });
    // One row stands for both, naming the newest, with Run blame only where its page leads with it: never on a record no step can be read from.
    const step = (next: NextStepWork) => {
      const row = overviewSummary(store, { tz: 'UTC', now: NOW, next }).needsLook.items.find((i) => i.kind === 'unblamed');
      return [row?.runId, row?.step?.of === 'run' ? row.step.step.label : (row?.step ?? null)];
    };
    expect(step(work([]))).toEqual([noCall, null]);
    expect(step(unreadable)).toEqual([noCall, null]);
  });

  it('leaves its page with no step, and the Replay beside it', async () => {
    const failed = recording(T0, { status: 'failed' });
    expect(await pageSteps(store, failed, unreadable, { judged: null, kept: () => true })).toEqual({});
    expect(await pageSteps(store, failed, work([]), { judged: null, kept: () => true })).toMatchObject({ next: { key: 'blame' }, replay: { key: 'replay', runId: failed } });
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
  const stamp = (id: string) => nextStepStamp(store, store.getRun(id)!);

  it('moves with the tests run on it', () => {
    const rec = recording();
    const was = stamp(rec);
    plant(rec, { gate: { obeyed: 0, influenced: null, verdict: 'failed', reason: 'x' }, ended: false });
    const started = stamp(rec);
    expect(started).not.toBe(was);
    // Once it ends, at any time.
    plant(rec, { gate: { obeyed: 0, influenced: null, verdict: 'failed', reason: 'x' } });
    expect(stamp(rec)).not.toBe(started);
    const tested = stamp(rec);
    preset(rec, 'failed');
    expect(stamp(rec)).not.toBe(tested);
  });

  it('moves a test replay’s with its golden’s results, and what Find breaking commit said of them', () => {
    const rec = recording();
    const t = crashedTest(rec);
    const was = stamp(t);
    passedTest(rec, T0 + 5 * MIN);
    const passed = stamp(t);
    expect(passed).not.toBe(was);
    recordEvent(store, { kind: 'bisect.found', ref: GOLDEN, runId: t, data: { first: { rev: 'ccccccc', subject: 'Log the total', author: 'a', date: 'b' }, why: 'exit', answered: { at: T0 + 2 * MIN, ok: false } } });
    expect(stamp(t)).not.toBe(passed);
  });

  it('stays while anything about another run or golden moves, as a long run’s answer is megabytes', () => {
    const rec = recording();
    const t = crashedTest(rec);
    const other = recording(T0 + MIN);
    const was = [stamp(rec), stamp(t)];
    // Another run's injection test and presets, and its golden's result: none of them this run's.
    plant(other, { gate: { obeyed: 0, influenced: null, verdict: 'failed', reason: 'x' } });
    preset(other, 'failed');
    const session = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/other'], startedAt: T0 + 3 * MIN }).sessionId;
    store.addTestResult({ sessionId: session, golden: 'goldens/other', ok: true, runId: other, goldenRunId: other, at: T0 + 3 * MIN });
    // Any other activity, and a bisect's answer about another golden.
    recordEvent(store, { kind: 'normalize.added', ref: 'x', data: {} });
    recordEvent(store, { kind: 'bisect.found', ref: 'goldens/other', runId: other, data: { first: { rev: 'ccccccc', subject: 's', author: 'a', date: 'b' }, why: 'exit', answered: { at: T0, ok: false } } });
    expect([stamp(rec), stamp(t)]).toEqual(was);
    // A recording's isn't moved by a test session of its golden, either.
    passedTest(rec, T0 + 5 * MIN);
    expect(stamp(rec)).toBe(was[0]);
  });

  it('reads a golden that isn’t text as none: a pack can carry anything', () => {
    const odd = recording(T0, { meta: { test: { golden: 7 as never, session: 's' } } });
    expect(typeof stamp(odd)).toBe('string');
  });
});
