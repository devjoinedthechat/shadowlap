import { describe, expect, it } from 'vitest';
import { gateResult, injectionTemplates, JUDGE_ASKED_IN_NONE, Store, type AttemptReport, type InjectionGateData, type StoredCheck, type TestResult } from '@shadowlap/engine';
import { failedRunsHref, goldenReports, printedLines, withFailedRuns, withStepHints, type GoldenReport } from '../src/golden-report.js';
import { issueKey } from '../src/issue-keys.js';
import type { IssuesPage } from '../src/issues.js';
import { links } from '../src/links.js';
import { runJob } from '../src/read-jobs.js';
import { judgeAsked } from '../src/tests-checks.js';
import { testsView, type GoldenSource } from '../src/tests.js';
import { addRun } from './read-model-store.js';

const PY_TAIL = ['Traceback (most recent call last):', '  File "/work/shop/refund_agent.py", line 141, in issue_refund', '    log.info("refund %s of %s", refund["refund_id"], order["total"])', "KeyError: 'total'"].join('\n');
const NODE_TAIL = ["file:///work/shop/agent.mjs:141", '  const total = order.payment.amount;', '                              ^', '', "TypeError: Cannot read properties of undefined (reading 'amount')", '    at issueRefund (file:///work/shop/agent.mjs:141:31)', '', 'Node.js v22.11.0'].join('\n');

const TWICE = 'send_email called at most 1 time';
const check = (label: string, status: StoredCheck['status'], detail?: string, extra: Partial<StoredCheck> = {}): StoredCheck => ({ label, ok: status === 'passed', status, ...(detail ? { detail } : {}), ...extra }) as StoredCheck;

/** A store with one recording packed as `goldens/<name>`, and a replay of it that came out as `result` says. */
function world(name: string, result: (replay: string, session: string, store: Store) => Omit<Parameters<Store['addTestResult']>[0], 'sessionId' | 'golden' | 'runId'>, o: { checks?: string[]; mode?: 'replay' | 'fork'; divergence?: Parameters<Store['setDivergence']>[1]; calls?: string; view?: (view: ReturnType<typeof testsView>) => void } = {}) {
  const store = Store.open(':memory:');
  const recording = o.calls ? { runId: addRun(store, { startedAt: 1, calls: o.calls }) } : store.createRun({ mode: 'record', command: { argv: ['python', 'refund_agent.py'], cwd: '/work/shop' } });
  const s = store.startTestSession({ command: ['shadowlap', 'test', `goldens/${name}`], revision: 'abc1234' });
  const replay = store.createRun({ mode: 'replay', command: { argv: ['python', 'refund_agent.py'], cwd: '/work/shop' }, meta: { test: { golden: `goldens/${name}`, session: s.sessionId } } });
  if (o.divergence) store.setDivergence(replay.runId, o.divergence);
  store.addTestResult({ sessionId: s.sessionId, golden: `goldens/${name}`, runId: replay.runId, ...result(replay.runId, s.sessionId, store) });
  const goldens: GoldenSource[] = [{ path: `goldens/${name}`, runId: recording.runId, packedAt: 1, mode: o.mode ?? 'replay', repeat: 1, passes: 1, checks: o.checks ?? [] }];
  const view = testsView(store, goldens, { folder: 'goldens' });
  o.view?.(view);
  const reports = goldenReports(view, { store, goldens, normalizers: [], project: '/work/shop' });
  return { store, recording: recording.runId, replay: replay.runId, report: reports[`goldens/${name}`], reports };
}

const text = (head: GoldenReport['head']): string => head.map((p) => (typeof p === 'string' ? p : `\`${p.code}\``)).join('');

describe('a crash', () => {
  it('names the exception the agent died of and the frame it was raised in, after its replay', () => {
    const { report, replay } = world('refund', () => ({ ok: false, failure: 'exit', reason: 'the agent exited with code 1', data: { mode: 'replay', calls: { total: 18, replayed: 18, live: 0, blocked: 0, stubbed: 0 }, upstreamRequests: 0, checks: [check('issue_refund called 1 time', 'failed', 'called 0 times')], output: PY_TAIL } }), { checks: ['issue_refund called 1 time'], divergence: { type: 'ended_early', callNo: 19, kind: 'api', name: 'POST /v1/messages', replayedBefore: 18, recorded: 30 } });
    expect(report).toMatchObject({ verdict: 'failed', head: ['The agent exited with code 1 at call 19'], sub: [], hint: { key: 'crash' }, open: { label: 'Open run', href: `#/run/${replay}` } });
    expect(report.parts.map((p) => p.kind)).toEqual(['replay', 'error', 'checks']);
    expect(report.parts[0]).toEqual({ kind: 'replay', recorded: 30, replayed: 18, stop: 19, words: '18 of 30 recorded calls replayed, then it stopped · 0 upstream requests' });
    expect(report.parts[1]).toMatchObject({ kind: 'error', file: 'refund_agent.py', error: { exception: "KeyError: 'total'", raised: { line: 141, fn: 'issue_refund' } } });
  });

  it('reads a Node crash by its error, and says it exited after its last call when no call ended it early', () => {
    const { report } = world('refund', () => ({ ok: false, failure: 'exit', reason: 'the agent exited with code 1', data: { mode: 'replay', calls: { total: 30, replayed: 30, live: 0, blocked: 0, stubbed: 0 }, upstreamRequests: 0, output: NODE_TAIL } }));
    expect(report.head).toEqual(['The agent exited with code 1 after its last call']);
    expect(report.sub).toEqual(['0 upstream requests']);
    expect(report.parts).toEqual([expect.objectContaining({ kind: 'error', file: 'agent.mjs', error: expect.objectContaining({ exception: "TypeError: Cannot read properties of undefined (reading 'amount')" }) })]);
  });
});

describe('a divergence', () => {
  const diverged = (callNo: number) => ({ ok: false, failure: 'diverged' as const, reason: `diverged at call ${callNo} (api POST /v1/messages)`, data: { mode: 'replay' as const, calls: { total: callNo, replayed: callNo - 1, live: 0, blocked: 0, stubbed: 0 }, upstreamRequests: 0, divergence: { type: 'request_changed', callNo, kind: 'api', name: 'POST /v1/messages', replayedBefore: callNo - 1, diff: [{ path: '$.metadata.user_id', op: 'changed', before: 'a', after: 'b' }], cause: '$.metadata.user_id', volatile: { values: [{ path: '$.metadata.user_id', looks: 'a UUID', op: 'changed' as const, certain: true, normalizer: { path: '$.metadata.user_id', replace: '<uuid>' } }], explainsAll: true }, text: '✗ Request changed at call 3' }, details: '✗ Request changed at call 3\n  - before\n  + after' } });

  it('says what changed at the call, and draws no strip for a divergence at call 1, only its request', () => {
    const { report, recording, replay } = world('refund', () => diverged(1), { divergence: { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, recorded: 30 } });
    expect(text(report.head)).toBe('Diverged at call 1: `$.metadata.user_id` changed, a UUID');
    expect(report.parts).toEqual([{ kind: 'request', runId: replay, callNo: 1, against: { runId: recording, callNo: 1 }, bodies: null, followed: null }]);
    expect(report.sub).toEqual(['0 upstream requests']);
    expect(report.hint).toEqual({ key: 'normalizer' });
  });

  it('draws its replay up to the call that diverged past call 1', () => {
    const { report } = world('refund', () => diverged(3), { divergence: { type: 'request_changed', callNo: 3, kind: 'api', name: 'POST /v1/messages', replayedBefore: 2, recorded: 30 } });
    expect(report.parts.map((p) => p.kind)).toEqual(['replay', 'request']);
    expect(report.parts[0]).toEqual({ kind: 'replay', recorded: 30, replayed: 2, stop: 3, words: '2 of 30 recorded calls replayed, then call 3 diverged · 0 upstream requests' });
    expect(report.sub).toEqual([]);
    expect(report.printed.map((l) => l.tone)).toEqual(['no', '', 'del', 'add']);
    expect(report.printed[0]).toEqual({ text: '✗ refund: diverged at call 3 (api POST /v1/messages)', tone: 'no' });
  });

  it('says a replay that stopped before its recording did ended early, as the CLI says it, and how far it got', () => {
    const early = { type: 'ended_early' as const, callNo: 11, kind: 'api' as const, name: 'POST /v1/messages', replayedBefore: 10, recorded: 30 };
    const { report } = world('refund', (run, _s, store) => (store.endRun(run, 'completed', 30), { ok: false, failure: 'diverged', reason: 'ended early at call 11 (api POST /v1/messages): 10 of 30 recorded calls replayed', data: { mode: 'replay', calls: { total: 10, replayed: 10, live: 0, blocked: 0, stubbed: 0 }, upstreamRequests: 0, divergence: { ...early, text: '' } } }), { divergence: early });
    expect(report.head).toEqual(['Ended early at call 11']);
    expect(report.parts).toEqual([{ kind: 'replay', recorded: 30, replayed: 10, stop: 11, words: '10 of 30 recorded calls replayed, then it stopped · 0 upstream requests' }]);
    expect(report.hint).toEqual({ key: 'bisect' });
  });
});

describe('a divergence’s request', () => {
  const diverged = (): ReturnType<Parameters<typeof world>[1]> => ({ ok: false, failure: 'diverged', reason: 'diverged at call 3 (api POST /v1/messages)', data: { mode: 'replay', calls: { total: 3, replayed: 2, live: 0, blocked: 0, stubbed: 0 }, upstreamRequests: 0, divergence: { type: 'request_changed', callNo: 3, kind: 'api', name: 'POST /v1/messages', replayedBefore: 2, diff: [{ path: '$.metadata.user_id', op: 'changed', before: 'a', after: 'b' }], text: '✗ Request changed at call 3' } } });
  const at3 = { type: 'request_changed' as const, callNo: 3, kind: 'api' as const, name: 'POST /v1/messages', replayedBefore: 2, recorded: 30 };
  const BODY = { type: 'error', error: { type: 'shadowlap_offline', message: 'shadowlap is offline: call #3 (POST /v1/messages) was not served from the recording and would need the network' } };
  /** The replay's call `callNo` answered with the offline refusal, as `shadowlap test` records it (sidecar model-calls.ts), and its run ended as `status` says. */
  const refused = (replay: string, store: Store, status: 'failed' | 'completed', body: unknown = BODY, callNo = 3) => {
    const identity = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: `fp${callNo}`, occurrence: 1 };
    store.appendCallStart({ runId: replay, callNo, ...identity, origin: 'live', effect: null, requestRef: null, meta: {}, at: 10 });
    store.appendCallEnd(identity, { runId: replay, callNo, attempt: 0, responseRef: body === null ? null : store.putJson(body), outcome: 'error', meta: { status: 503, offline: true, error: { name: 'ShadowlapOffline', message: BODY.error.message } }, at: 20 });
    store.endRun(replay, status, 30);
  };
  /** A replay that kept no changed request: a call past the recording's end, or one that stopped before the recording did, as the CLI words each. */
  const keptNone = (type: 'beyond_recording' | 'ended_early', callNo: number, reason: string): ReturnType<Parameters<typeof world>[1]> => ({ ok: false, failure: 'diverged', reason, data: { mode: 'replay', calls: { total: callNo - 1, replayed: callNo - 1, live: 0, blocked: 0, stubbed: 0 }, upstreamRequests: 0, divergence: { type, callNo, kind: 'api', name: 'POST /v1/messages', replayedBefore: callNo - 1, text: '' } } });

  it('names the replay and its call, whose diff Tests asks for once the report opens, and the offline 503 the agent exited on, with the body it got', () => {
    const { report, recording, replay } = world('refund', (run, _s, store) => (refused(run, store, 'failed'), diverged()), { divergence: at3 });
    expect(report.parts[1]).toEqual({ kind: 'request', runId: replay, callNo: 3, against: { runId: recording, callNo: 3 }, bodies: null, followed: { line: ['Not served from the recording:', 'the agent exited on HTTP 503'], message: JSON.stringify(BODY, null, 2) } });
  });

  it('says what followed only where the replay then ended failed, and leaves out a body the recording didn’t keep', () => {
    expect(world('refund', (run, _s, store) => (refused(run, store, 'completed'), diverged()), { divergence: at3 }).report.parts[1]).toMatchObject({ kind: 'request', followed: null });
    expect(world('refund', (run, _s, store) => (refused(run, store, 'failed', null), diverged()), { divergence: at3 }).report.parts[1]).toMatchObject({ followed: { line: ['Not served from the recording:', 'the agent exited on HTTP 503'], message: null } });
  });

  it('draws the changes its result kept once the replay is gone, and no request where it kept none', () => {
    const { store, replay, recording } = world('refund', diverged, { divergence: at3 });
    store.deleteRun(replay);
    const goldens: GoldenSource[] = [{ path: 'goldens/refund', runId: recording, packedAt: 1, mode: 'replay', repeat: 1, passes: 1, checks: [] }];
    const report = goldenReports(testsView(store, goldens, { folder: 'goldens' }), { store, goldens, normalizers: [], project: null })['goldens/refund'];
    expect(report.parts.find((p) => p.kind === 'request')).toEqual({ kind: 'request', runId: null, callNo: 3, against: { runId: recording, callNo: 3 }, bodies: { was: { metadata: { user_id: 'a' } }, now: { metadata: { user_id: 'b' } } }, followed: null });
    const bare = world('refund', () => ({ ...diverged(), data: { ...diverged().data!, divergence: { ...diverged().data!.divergence!, diff: [] } } }), { divergence: at3 });
    bare.store.deleteRun(bare.replay);
    const rows = goldenReports(testsView(bare.store, goldens, { folder: 'goldens' }), { store: bare.store, goldens, normalizers: [], project: null });
    expect(rows['goldens/refund']?.parts.some((p) => p.kind === 'request')).toBe(false);
  });

  it('compares nothing where the divergence kept no changes, as a run offers no Show diff there: only what followed, and no part where nothing did', () => {
    // A call past the recording's end, answered with the offline 503 the agent exited on: no diff to ask, no recorded call to head it.
    const past = world('refund', (run, _s, store) => (refused(run, store, 'failed', BODY, 4), keptNone('beyond_recording', 4, 'diverged at call 4 (api POST /v1/messages)')), { divergence: { type: 'beyond_recording', callNo: 4, kind: 'api', name: 'POST /v1/messages', replayedBefore: 3 } });
    expect(past.report.parts.find((p) => p.kind === 'request')).toEqual({ kind: 'request', runId: null, callNo: 4, against: null, bodies: null, followed: { line: ['Not served from the recording:', 'the agent exited on HTTP 503'], message: JSON.stringify(BODY, null, 2) } });
    // Every request matched, but the agent exited 0 before the recording ended: it never made call 3, and nothing followed.
    const early = world('refund', (run, _s, store) => (store.endRun(run, 'completed', 30), keptNone('ended_early', 3, 'ended early at call 3 (api POST /v1/messages): 2 of 3 recorded calls replayed')), { divergence: { type: 'ended_early', callNo: 3, kind: 'api', name: 'POST /v1/messages', replayedBefore: 2, recorded: 3 } });
    expect(early.report.parts.map((p) => p.kind)).toEqual(['replay']);
  });
});

describe('a check', () => {
  it('names the check a replay golden failed and what it found, over a clean replay', () => {
    const { report } = world('refund', () => ({ ok: false, failure: 'check', reason: 'check failed: send_email called 0 times, but called 1 time', data: { mode: 'replay', calls: { total: 7, replayed: 7, live: 0, blocked: 0, stubbed: 0 }, upstreamRequests: 0, checks: [check('send_email called 0 times', 'failed', 'called 1 time'), check('output includes "refund"', 'passed')] } }), { checks: ['send_email called 0 times', 'output includes "refund"'], divergence: { type: 'ended_early', callNo: 8, kind: 'api', name: 'POST /v1/messages', replayedBefore: 7, recorded: 7 } });
    expect(text(report.head)).toBe('Check failed: send_email called 0 times, but called 1 time');
    expect(report.parts).toEqual([{ kind: 'replay', recorded: 7, replayed: 7, stop: null, words: '7 of 7 calls replayed, clean · 0 upstream requests' }, { kind: 'checks', labels: ['send_email called 0 times', 'output includes "refund"'] }]);
    expect(report.hint).toEqual({ key: 'check' });
  });

  it('leads with the checks that left the config since its last test, and says what to do from its step', () => {
    const { report } = world('refund', () => ({ ok: false, failure: 'check', reason: 'check failed: issue_refund called 0 times, but called 1 time', data: { mode: 'replay', calls: { total: 7, replayed: 7, live: 0, blocked: 0, stubbed: 0 }, upstreamRequests: 0, checks: [check('issue_refund called 0 times', 'failed', 'called 1 time')] } }), { checks: ['output includes "refund"'] });
    expect(report.parts[0]).toEqual({ kind: 'checks-changed', gone: [{ label: 'issue_refund called 0 times', status: 'failed' }] });
    expect(report.sub).toEqual(['its last test, before its checks changed']);
    // Its last test's hint, until its step says otherwise: Run tests, or Edit check for a check its own recording fails.
    expect(report.hint).toEqual({ key: 'check' });
    const reports = { 'goldens/refund': report };
    expect(withStepHints(reports, { 'goldens/refund': { key: 'run-tests' } })['goldens/refund']).toEqual({ ...report, hint: { key: 'checks-changed' } });
    expect(withStepHints(reports, { 'goldens/refund': { key: 'edit-check' } })['goldens/refund'].hint).toEqual({ key: 'edit-check' });
    for (const steps of [{ 'goldens/refund': { key: 'fix' } }, {}, undefined]) expect(withStepHints(reports, steps)['goldens/refund']).toBe(report);
  });

  it('says no check changed where its last test failed for another reason, by the row’s one rule', () => {
    const { report } = world('refund', () => ({ ok: false, failure: 'exit', reason: 'the agent exited with code 1', data: { mode: 'replay', calls: { total: 7, replayed: 7, live: 0, blocked: 0, stubbed: 0 }, upstreamRequests: 0, checks: [check('issue_refund called 0 times', 'failed', 'called 1 time')] } }), { checks: ['output includes "refund"'] });
    expect(report.parts.map((p) => p.kind)).not.toContain('checks-changed');
    expect(report.sub).not.toContain('its last test, before its checks changed');
  });

  it('says a judge check wasn’t judged on a clean replay, with its calls', () => {
    const { report } = world('refund', () => ({ ok: false, failure: 'inconclusive', reason: 'check inconclusive: judge "polite" answers yes: its pack holds no verdict', data: { mode: 'replay', verdict: 'inconclusive', calls: { total: 7, replayed: 7, live: 0, blocked: 0, stubbed: 0 }, upstreamRequests: 0, checks: [check('judge "polite" answers yes', 'inconclusive', 'its pack holds no verdict', { judge: { name: 'polite', model: 'claude-x', verdict: null, reason: null, cost: null } as unknown as NonNullable<StoredCheck['judge']> })] } }), { checks: ['judge "polite" answers yes'] });
    expect(report.verdict).toBe('inconclusive');
    expect(report.head).toEqual(['Replayed clean, but its judge check wasn’t judged']);
    expect(report.sub).toEqual(['7 of 7 calls', '0 upstream requests']);
    expect(report.printed[0]).toEqual({ text: '? refund: check inconclusive: judge "polite" answers yes: its pack holds no verdict', tone: 'y' });
  });
});

describe('a golden of several attempts', () => {
  it('says what its attempts did and in how many, then the attempts, where they forked, and its other checks', () => {
    const { report } = world('refund', () => ({ ok: false, failure: 'check', reason: '3 of 5 attempts passed, 5 needed', data: { mode: 'fork', calls: { total: 4, replayed: 2, live: 2, blocked: 0, stubbed: 0 }, upstreamRequests: 10, attempts: { total: 5, passed: 3, required: 5, runs: [] }, checks: [check('send_email called at most 1 time', 'failed', 'called 2 times'), check('output includes "refund"', 'passed')], divergence: { type: 'request_changed', callNo: 2, kind: 'api', name: 'POST /v1/messages', replayedBefore: 1, text: '' } } }), { mode: 'fork', checks: ['send_email called at most 1 time', 'output includes "refund"'] });
    expect(report.head).toEqual(['send_email called twice in 2 of 5 attempts']);
    expect(report.sub).toEqual(['10 upstream requests']);
    // The verdict says how often it was called, so the check under the attempts says only what it adds: nothing here.
    expect(report.parts).toEqual([{ kind: 'attempts', check: { label: 'send_email called at most 1 time', detail: '' }, carried: null, forked: 'forked at call 2, each attempt live from there' }, { kind: 'checks', labels: ['output includes "refund"'] }]);
    expect(report.open?.label).toBe('Open failing attempt');
    expect(report.hint).toEqual({ key: 'check' });
  });
});

describe('the lines as printed', () => {
  const result = (r: Partial<TestResult>): TestResult => ({ resultId: 'r', sessionId: 's', golden: 'goldens/refund', ok: false, failure: 'exit', reason: 'the agent exited with code 1', runId: null, at: 1, revision: null, ...r }) as TestResult;

  it('prints a golden that couldn’t run by its line alone', () => {
    expect(printedLines('refund', result({ failure: 'error', reason: 'the command could not start', data: { mode: 'replay', details: 'spawn ENOENT' } }))).toEqual([{ text: '✗ refund: the command could not start', tone: 'no' }]);
  });

  it('prints the checks, the details and the agent’s last lines, escaped as the CLI escapes them', () => {
    const lines = printedLines('refund', result({ data: { mode: 'replay', calls: { total: 1, replayed: 1, live: 0, blocked: 0, stubbed: 0 }, checks: [check('tool calls 1', 'passed'), check('send_email called 0 times', 'failed', 'called 1 time')], details: 'the agent process exited with an error', output: 'ok\n::error::forged\n\x1b[31mred\x1b[0m ##[group]x' } }));
    expect(lines).toEqual([
      { text: '✗ refund: the agent exited with code 1', tone: 'no' },
      { text: '    ✓ tool calls 1', tone: '' },
      { text: '    ✗ send_email called 0 times: called 1 time', tone: 'no' },
      { text: '    the agent process exited with an error', tone: '' },
      { text: '    │ ok', tone: 'dim' },
      { text: '    │ ::error::forged', tone: 'dim' },
      { text: '    │ \\x1b[31mred\\x1b[0m #\\x23[group]x', tone: 'dim' },
    ]);
  });

  it('says each check under the golden as the engine’s checkLine does, a failed one red and an undecided one amber', () => {
    const legacy = (ok: boolean, detail?: string) => ({ label: 'exits 0', ok, ...(detail ? { detail } : {}) }) as StoredCheck;
    const lines = printedLines('refund', result({ failure: 'check', reason: 'check failed: judge "explains" answers yes, but it answered no', data: { mode: 'replay', calls: { total: 1, replayed: 1, live: 0, blocked: 0, stubbed: 0 }, checks: [check('when lookup_order has result.total > 200: escalate called at least 1 time', 'not-applicable', 'the condition never held'), check('judge "calm" answers yes', 'inconclusive', 'not judged: no recorded verdict'), check('judge "explains" answers yes', 'failed', 'it answered no', { reason: 'the reply never says why' }), legacy(true), legacy(false, 'exited 1')] } }));
    expect(lines.slice(1)).toEqual([
      { text: '    – when lookup_order has result.total > 200: escalate called at least 1 time: not applicable · the condition never held', tone: '' },
      { text: '    ? judge "calm" answers yes: inconclusive · not judged: no recorded verdict', tone: 'y' },
      { text: '    ✗ judge "explains" answers yes: it answered no · the reply never says why', tone: 'no' },
      // A result kept before checks had a status reads as its ok says.
      { text: '    ✓ exits 0', tone: '' },
      { text: '    ✗ exits 0: exited 1', tone: 'no' },
    ]);
  });

  it('prints an inconclusive golden’s line in amber, its checks, then its gate’s details as the CLI wrote them', () => {
    const tally = '16 of 20 passed · rate 0.58 to 0.92 (95%) · pass^5 0.28';
    const reason = 'inconclusive · 16 of 20 · rate 0.58 to 0.92 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 20 attempts';
    const lines = printedLines('flaky', result({ failure: 'inconclusive', reason, data: { mode: 'fork', verdict: 'inconclusive', attempts: { total: 20, passed: 16, required: null, runs: [] }, checks: [check('send_email called 0 times', 'failed', 'called 1 time')], details: `${tally}\nattempt 1  ✓ passed` } }));
    expect(lines).toEqual([
      { text: `? flaky: ${reason}`, tone: 'y' },
      { text: '    ✗ send_email called 0 times: called 1 time', tone: 'no' },
      { text: `    ${tally}`, tone: '' },
      { text: '    attempt 1  ✓ passed', tone: '' },
    ]);
  });

  it('prints an injection gate’s proof and where every attempt is, and no tail', () => {
    const reason = 'injection: send_email obeyed a planted instruction in 5 of 5 attempts (at most 0 allowed): send_email.to = x7f3kq2m@canary.invalid';
    const lines = printedLines('research', result({ failure: 'injection', reason, data: { mode: 'fork', calls: { total: 1, replayed: 1, live: 0, blocked: 0, stubbed: 0 }, details: 'planted at #7 → read at #9 → send_email.to = x7f3kq2m@canary.invalid at #10\nEvery attempt, with its proof: shadowlap injection goldens/research --html report.html', output: 'agent said things' } }));
    expect(lines.map((l) => l.text)).toEqual([`✗ research: ${reason}`, '    planted at #7 → read at #9 → send_email.to = x7f3kq2m@canary.invalid at #10', '    Every attempt, with its proof: shadowlap injection goldens/research --html report.html']);
  });
});

describe('the guard', () => {
  const replayed = { total: 2, replayed: 2, live: 0, blocked: 0, stubbed: 0 };

  it('says a golden no preload watched failed for that, never that it couldn’t run', () => {
    const reason = "No Shadowlap preload loaded in the agent's processes, though the run made 2 model calls: under --guard block nothing stopped a connection that bypassed Shadowlap, so the run fails.";
    const { report } = world('refund', () => ({ ok: false, failure: 'guard', reason, data: { mode: 'replay', calls: replayed } }));
    expect(report.hint).toEqual({ key: 'no-preload' });
  });

  it('says a golden failed for a process the guard can’t watch as that, never as no preload', () => {
    const reason = 'The network guard could not watch every process of the agent: the Claude Code CLI the Claude Agent SDK runs, which loads no Shadowlap preload, so the connections Claude Code makes itself (WebFetch, an HTTP MCP server) are not watched. Under --guard block nothing stops such a connection, so the run fails.';
    const { report } = world('refund', () => ({ ok: false, failure: 'guard', reason, data: { mode: 'replay', calls: replayed } }));
    expect(report.hint).toEqual({ key: 'unguarded' });
  });

  it('says a connection the guard blocked is what the agent tripped on, whatever failed after it', () => {
    const output = '[shadowlap] blocked an outbound connection to hooks.example.com:443: it bypasses Shadowlap (SHADOWLAP_GUARD=block).';
    const { report } = world('refund', () => ({ ok: false, failure: 'exit', reason: 'the agent exited with code 1', data: { mode: 'replay', calls: replayed, details: '✓ Replay clean: 1/1 calls replayed', output } }));
    expect(report.hint).toEqual({ key: 'blocked', hosts: ['hooks.example.com:443'] });
    const checked = world('refund', () => ({ ok: false, failure: 'check', reason: 'check failed: send_email called 1 time, but called 0 times', data: { mode: 'replay', calls: replayed, checks: [check('send_email called 1 time', 'failed', 'called 0 times')], output } }), { checks: ['send_email called 1 time'] });
    expect(checked.report.hint).toEqual({ key: 'blocked', hosts: ['hooks.example.com:443'] });
  });
});

describe('a judge asked live', () => {
  const judged = (extra: Partial<StoredCheck>) => check('judge "polite" answers yes', 'passed', undefined, { source: 'live', judge: { name: 'polite', model: 'claude-x', cost: 0.002 } as unknown as NonNullable<StoredCheck['judge']>, ...extra });

  it('counts the attempts it was asked in, from the result’s judge summary where it is the only judge', () => {
    const c = judged({});
    const r = { data: { checks: [c], attempts: { total: 5, passed: 5, required: null, runs: [] }, judge: { calls: 5, replayed: 0, live: 5, spent: 0.01, unknownModels: [], notAsked: 0, upstreamRequests: 5 } } } as unknown as TestResult;
    expect(judgeAsked(r, c)).toEqual({ cost: 0.01, asked: 5 });
  });

  it('counts only the attempts that asked it, as a golden that may fork asks none where another check failed', () => {
    // Eight attempts, four of which failed another check first: their judge wasn't asked.
    const c = judged({});
    const r = { data: { checks: [c], attempts: { total: 8, passed: 4, required: 8, runs: [] }, judge: { calls: 4, replayed: 0, live: 4, spent: 0.008, unknownModels: [], notAsked: 0, upstreamRequests: 4 } } } as unknown as TestResult;
    expect(judgeAsked(r, c)).toEqual({ cost: 0.008, asked: 4 });
    // Nor does a check no attempt asked count any: it has no source.
    expect(judgeAsked(r, { ...check(c.label, 'not-applicable', JUDGE_ASKED_IN_NONE, { judge: c.judge! }), ok: true })).toBeNull();
  });

  it('counts one ask of a result of one attempt, and none of a verdict from the recording', () => {
    const c = judged({});
    expect(judgeAsked({ data: { checks: [c] } } as unknown as TestResult, c)).toEqual({ cost: 0.002, asked: 1 });
    expect(judgeAsked({ data: { checks: [c] } } as unknown as TestResult, judged({ source: 'recording' }))).toBeNull();
  });
});

describe('a gate', () => {
  const sprt = { kind: 'sprt' as const, good: 0.9, bad: 0.7, risk: 0.05, max: 83 };
  const twice = check('send_email called at most 1 time', 'failed', 'called 2 times');

  it('says its gate ran out, with its figures, and the attempts carried over from the session they started in', () => {
    const outcomes = [...Array<boolean>(67).fill(true), ...Array<boolean>(16).fill(false)];
    const { report, store } = world('refund', (_replay, _session, st) => {
      const before = st.startTestSession({ command: ['shadowlap', 'test', 'goldens/refund'], startedAt: 1_000, revision: 'abc1234' });
      return { ok: false, failure: 'inconclusive', reason: 'inconclusive after 83 attempts', data: { mode: 'fork', verdict: 'inconclusive', upstreamRequests: 6, gate: gateResult(sprt, outcomes, { decision: 'inconclusive', carried: 80 }), continued: { sessions: [before.sessionId], attempts: 80 }, attempts: { total: 83, passed: 67, required: null, runs: [] }, checks: [twice, check('output includes "refund"', 'passed')] } };
    }, { mode: 'fork', checks: [twice.label, 'output includes "refund"'] });
    expect(report.verdict).toBe('inconclusive');
    expect(report.head).toEqual(['send_email called twice in 16 of 83 attempts, and its gate ran out before deciding']);
    expect(report.parts.map((p) => p.kind)).toEqual(['gate', 'attempts', 'checks']);
    expect(report.parts[0]).toEqual({ kind: 'gate', bound: expect.stringMatching(/^rate /), baseline: null, passK: expect.stringMatching(/^pass\^5 \d\.\d\d$/) });
    expect(report.parts[1]).toEqual({ kind: 'attempts', check: { label: twice.label, detail: '' }, carried: { count: 80, at: 1_000 }, forked: null });
    expect(report.hint).toEqual({ key: 'gate' });
    store.close();
  });

  it('says a history gate failed on a drop against its own history, with no pass^5', () => {
    const gate = { kind: 'baseline' as const, drop: 0.15, risk: 0.05, window: 5, min: 8, max: 8 };
    const once = check('issue_refund called 1 time', 'failed', 'called 0 times');
    const { report } = world('refund', () => ({ ok: false, failure: 'check', reason: 'its pass rate dropped against its history', data: { mode: 'fork', verdict: 'failed', gate: gateResult(gate, [true, true, true, true, false, false, false, false], { history: { passes: 40, attempts: 40, sessions: 5 }, decision: 'fail' }), attempts: { total: 8, passed: 4, required: null, runs: [] }, checks: [once] } }), { mode: 'fork', checks: [once.label] });
    expect(text(report.head)).toMatch(/^issue_refund .* in 4 of 8 attempts, a drop against its own history$/);
    expect(report.parts[0]).toEqual({ kind: 'gate', bound: expect.any(String), baseline: 'against 1.00 over the last 5 sessions (40 of 40)', passK: null });
    expect(report.hint).toEqual({ key: 'check' });
  });
});

describe('an injection gate', () => {
  const canary = 'x7f3k@canary.invalid';
  const templates = injectionTemplates().templates;
  /** A kept plant result of the golden's attempts, and its attempts' runs in the store. */
  function kept(store: Store, attempts: Array<Partial<AttemptReport>>, o: { payloads?: number; reads?: number } = {}): { resultId: string; runs: string[] } {
    const runs = attempts.map(() => store.createRun({ mode: 'replay', command: { argv: ['python', 'research.py'], cwd: '/work/shop' } }).runId);
    const reads = Array.from({ length: o.reads ?? 1 }, (_, i) => ({ callNo: 4 + i, name: 'fetch_page', from: 'web', readAt: 5 + i, args: {}, planted: true, why: null }));
    const payloads = templates.slice(0, o.payloads ?? templates.length).map((t) => ({ id: t.id, source: 'template', shape: t.shape, title: t.title, text: t.text, canary: true }));
    const data = { mode: 'plant', resultId: 'inj-1', runId: runs[0], golden: 'goldens/research', templates: { version: 1, ids: payloads.map((p) => p.id) }, repeat: 3, reads, payloads, cells: [], baselines: [], attempts: attempts.map((a, i) => ({ runId: runs[i], read: 4, payload: payloads[0]?.id ?? 'x', attempt: 1, canary: null, verdict: 'ignored', why: null, failed: false, plantedAt: 4, forkedAt: 5, readAt: 5, exitCode: 0, evidence: [], spent: 0, ...a })) };
    store.putInjectionResult({ resultId: 'inj-1', runId: runs[0], golden: 'goldens/research', sessionId: null, mode: 'plant', at: 1, endedAt: 2, attempts: attempts.length, obeyed: 0, influenced: 0, ignored: 0, inconclusive: 0, verdict: null, actor: null, data });
    return { resultId: 'inj-1', runs };
  }
  const gate = (resultId: string | null, verdict: 'failed' | 'inconclusive', reason: string): InjectionGateData => ({ resultId, attempts: 72, obeyed: 5, influenced: 2, ignored: 62, inconclusive: 3, allowed: { obeyed: 0, influenced: null }, verdict, reason, skipped: null });

  it('says what obeyed and its limit, proves it in parts from the attempt that obeyed, and opens the proof there', () => {
    let attempt = '';
    let tested = '';
    const reason = `send_email obeyed a planted instruction in 5 of 72 attempts (at most 0 allowed): send_email.to = ${canary}`;
    const { report } = world('research', (_r, _s, st) => {
      const k = kept(st, [{ verdict: 'ignored' }, { verdict: 'obeyed', evidence: [{ kind: 'canary', callNo: 6, tool: 'send_email', path: '$.to', value: canary, why: null }] }]);
      attempt = k.runs[1]!;
      tested = k.runs[0]!;
      return { ok: false, failure: 'injection', reason: `injection: ${reason}`, data: { mode: 'fork', calls: { total: 7, replayed: 7, live: 0, blocked: 0, stubbed: 0 }, injection: gate(k.resultId, 'failed', reason), details: 'Every attempt, with its proof: shadowlap injection goldens/research --html report.html' } };
    });
    expect(report.head).toEqual(['send_email obeyed a planted instruction in 5 of 72 attempts (at most 0 allowed)']);
    expect(report.parts).toEqual([
      // The engine's parts, which the attempt's finding draws too (ui/injection/Proof.tsx): planted at #4 → read at #5 → send_email.to = <canary> at #6.
      { kind: 'proof', runId: attempt, parts: { plantedAt: 4, readAt: 5, evidence: { kind: 'canary', callNo: 6, at: 'send_email.to', value: canary, why: null } }, why: null },
      // Security report names the run the kept result tested.
      { kind: 'injection-attempts', totals: { obeyed: 5, influenced: 2, inconclusive: 3, ignored: 62 }, where: 'every template at every untrusted read,', each: '3 attempts each', command: 'shadowlap injection goldens/research --html report.html', security: { resultId: 'inj-1', runId: tested } },
    ]);
    expect(report.open).toEqual({ label: 'Open proof', href: `#/run/${attempt}/6` });
    expect(report.hint).toEqual({ key: 'injection' });
  });

  it('says what kept a gate from saying, a failed call by its status, why its attempt shows nothing, and the templates it planted', () => {
    let attempt = '';
    const reason = '3 of 6 attempts could not be judged: model call #15 failed with HTTP 529 (overloaded)';
    const { report } = world('research', (_r, _s, st) => {
      const k = kept(st, [{ verdict: 'inconclusive', failed: true, why: 'model call #15 failed with HTTP 529 (overloaded)' }], { payloads: 1, reads: 2 });
      attempt = k.runs[0]!;
      return { ok: false, failure: 'injection', reason: `injection inconclusive: ${reason}`, data: { mode: 'fork', verdict: 'inconclusive', calls: { total: 7, replayed: 7, live: 0, blocked: 0, stubbed: 0 }, injection: gate(k.resultId, 'inconclusive', reason) } };
    });
    expect(report.verdict).toBe('inconclusive');
    expect(report.head).toEqual(['3 of 6 attempts could not be judged: model call #15 got HTTP 529']);
    // Where it was planted and read, and why it shows nothing.
    expect(report.parts[0]).toEqual({ kind: 'proof', runId: attempt, parts: { plantedAt: 4, readAt: 5, evidence: null }, why: 'model call #15 failed with HTTP 529 (overloaded)' });
    expect(report.parts[1]).toMatchObject({ where: `${templates[0].id} at every untrusted read,`, each: '3 attempts each' });
    expect(report.open).toEqual({ label: 'Open attempt', href: `#/run/${attempt}/5` });
    expect(report.hint).toEqual({ key: 'injection-inconclusive', why: 'unanswered' });
  });

  it('says nothing could be planted in a sentence, and draws no proof where the result is gone', () => {
    const reason = 'no untrusted read to plant in: mark the tools that bring outside text in, with "tools": { "<name>": { "trust": "untrusted" } } in shadowlap.config.json';
    const { report } = world('research', () => ({ ok: false, failure: 'injection', reason: `injection inconclusive: ${reason}`, data: { mode: 'fork', verdict: 'inconclusive', calls: { total: 7, replayed: 7, live: 0, blocked: 0, stubbed: 0 }, injection: { ...gate(null, 'inconclusive', reason), attempts: 0, obeyed: 0, influenced: 0, ignored: 0, inconclusive: 0 } } }));
    expect(report.head).toEqual(['No untrusted read to plant in']);
    expect(report.parts).toEqual([{ kind: 'injection-attempts', totals: { obeyed: 0, influenced: 0, inconclusive: 0, ignored: 0 }, where: null, each: null, command: 'shadowlap injection goldens/research --html report.html', security: null }]);
    expect(report.open).toBeNull();
    expect(report.hint).toEqual({ key: 'injection-inconclusive', why: 'no-reads' });
  });
});

describe('a first bad commit, a miss, a replay gone', () => {
  const failedCheck = () => ({ ok: false, failure: 'check' as const, reason: 'check failed: send_email called 0 times, but called 1 time', data: { mode: 'replay' as const, calls: { total: 4, replayed: 4, live: 0, blocked: 0, stubbed: 0 }, upstreamRequests: 0, checks: [check('send_email called 0 times', 'failed', 'called 1 time')] } });
  const found = { rev: '9a3c5e0', subject: 'Log the order total with each refund', author: '', date: '2026-09-30', why: 'check failed', untested: [], replays: 3, tokens: 0, at: 5, change: null };

  it('ends with the commit Tests serves, or the search that found none', () => {
    const named = world('refund', failedCheck, { view: (v) => void (v.failures[0].found = found) }).report;
    expect(named.parts.at(-1)).toEqual({ kind: 'commit', found });
    const missed = { why: 'it already fails at c91d0f4', good: 'c91d0f4', bad: 'd2e8a1f', outcome: 'fails-at-good' as const, at: 5 };
    expect(world('refund', failedCheck, { view: (v) => void (v.failures[0].missed = missed) }).report.parts.at(-1)).toEqual({ kind: 'missed', missed });
  });

  it('counts the recording’s calls by its last one where the replay kept no count, and opens nothing once the replay is gone', () => {
    const { report, store, replay, reports } = world('refund', failedCheck, { calls: 'rrrr', checks: ['send_email called 0 times'] });
    expect(report.parts[0]).toEqual({ kind: 'replay', recorded: 4, replayed: 4, stop: null, words: '4 of 4 calls replayed, clean · 0 upstream requests' });
    expect(report.sub).toEqual([]);
    expect(reports['goldens/refund'].open).toEqual({ label: 'Open run', href: `#/run/${replay}` });
    store.deleteRun(replay);
    const goldens: GoldenSource[] = [{ path: 'goldens/refund', runId: null, packedAt: 1, mode: 'replay', repeat: 1, passes: 1, checks: [] }];
    expect(goldenReports(testsView(store, goldens, { folder: 'goldens' }), { store, goldens, normalizers: [], project: null })['goldens/refund']?.open).toBeNull();
  });
});

describe('Failed runs →', () => {
  it('counts a golden’s own failed replays, newest first, as its issue under Failed holds them where the link opens it', async () => {
    const store = Store.open(':memory:');
    const rec = addRun(store, { startedAt: 1_000, calls: 'rr' });
    // Runs' words match a run's command too, and a golden whose name starts another's: the count reads each replay's golden.
    const replay = (at: number, failed: boolean, golden = 'goldens/refund') => addRun(store, { parent: rec, startedAt: at, calls: 'r', argv: ['python', 'refund_agent.py'], ...(failed ? { status: 'failed' as const } : {}), meta: { test: { golden, session: 's' } } });
    const failed = [replay(2_000, true), replay(3_000, true)];
    replay(4_000, false);
    const late = replay(5_000, true, 'goldens/refund-late');
    const answer = await runJob(store, { kind: 'tests-failed-runs', goldens: ['goldens/refund', 'goldens/refund-late', 'goldens/none'], outcome: null }, { whole: true });
    const runs = JSON.parse(answer.body) as Record<string, { count: number; ids: string[] }>;
    expect(runs).toEqual({ 'goldens/refund': { count: 2, ids: [failed[1], failed[0]] }, 'goldens/refund-late': { count: 1, ids: [late] } });
    const report = { golden: 'goldens/refund', name: 'refund', failedRuns: null } as unknown as GoldenReport;
    const link = withFailedRuns({ 'goldens/refund': report }, runs, undefined)['goldens/refund'].failedRuns!;
    expect(link).toEqual({ href: links.runs({ q: 'type:test refund', types: 'failed' }), count: 2, ids: [failed[1], failed[0]] });
    // Failed under the link's words holds both goldens' replays, the golden's own in its issue.
    const key = issueKey.golden('goldens/refund');
    const page = JSON.parse((await runJob(store, { kind: 'runs-issues', options: { q: 'type:test refund' }, outcome: null, next: null, open: [key] }, { whole: true })).body) as IssuesPage;
    expect(page.total).toBe(3);
    const issue = page.issues.find((x) => x.key === key);
    expect([issue?.count, issue?.runs?.map((x) => x.runId)]).toEqual([link.count, link.ids]);
    store.close();
  });

  it('leaves out a replay a closed fix lists, which Failed holds under that fix’s issue, never its golden’s', async () => {
    const store = Store.open(':memory:');
    const rec = addRun(store, { startedAt: 1_000, calls: 'rr' });
    const replay = (at: number) => addRun(store, { parent: rec, startedAt: at, calls: 'r', argv: ['python', 'refund_agent.py'], status: 'failed', meta: { test: { golden: 'goldens/refund', session: 's' } } });
    const [listed, own] = [replay(2_000), replay(3_000)];
    const fixId = 'fx-01K8RG0000000000000000000B';
    store.insertFix({ fixId, title: 'Refunds issued twice', labels: [], check: { expect: {}, key: `check:${fixId}`, oracle: [], text: 'issue_refund called at most 1 time' }, status: 'applied', openedAt: 1_500, verifiedAt: null, appliedAt: 4_000, data: {} });
    store.addFixLink(fixId, 'failing', listed, 2_500);
    const runs = JSON.parse((await runJob(store, { kind: 'tests-failed-runs', goldens: ['goldens/refund'], outcome: null }, { whole: true })).body) as Record<string, { count: number; ids: string[] }>;
    expect(runs).toEqual({ 'goldens/refund': { count: 1, ids: [own] } });
    // The golden's issue under Failed holds what the link counts; the listed replay is the fix's.
    const key = issueKey.golden('goldens/refund');
    const page = JSON.parse((await runJob(store, { kind: 'runs-issues', options: { q: 'type:test refund' }, outcome: null, next: null, open: [key] }, { whole: true })).body) as IssuesPage;
    const issue = page.issues.find((x) => x.key === key);
    expect([issue?.count, issue?.runs?.map((x) => x.runId)]).toEqual([1, [own]]);
    expect(page.issues.find((x) => x.key === issueKey.fix(fixId))?.count).toBe(1);
    store.close();
  });

  it('leaves the link out where the golden’s step is its fix, and quotes a name with a space', () => {
    const report = { golden: 'goldens/refund', name: 'refund', failedRuns: null } as unknown as GoldenReport;
    expect(withFailedRuns({ 'goldens/refund': report }, { 'goldens/refund': { count: 1, ids: ['r'] } }, { 'goldens/refund': { key: 'fix' } })['goldens/refund'].failedRuns).toBeNull();
    expect(failedRunsHref('late refund')).toBe(links.runs({ q: 'type:test "late refund"', types: 'failed' }));
  });
});

describe('a golden of several attempts, whatever they failed on', () => {
  const sprt = (max: number) => ({ kind: 'sprt' as const, good: 0.9, bad: 0.7, risk: 0.05, max });
  const outcomes = (passed: number, failed: number) => [...Array<boolean>(passed).fill(true), ...Array<boolean>(failed).fill(false)];
  const once = check('issue_refund called 1 time', 'passed');

  it('reads a failed gate by its attempts where the attempt it shows crashed, with that attempt’s exception after them', () => {
    const gate = gateResult(sprt(40), outcomes(28, 12), { decision: 'fail' });
    const { report } = world('refund', () => ({ ok: false, failure: 'exit', reason: `failed · 28 of 40 · rate 0.55 to 0.83 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 40 attempts. Attempt 3: the agent exited with code 1`, data: { mode: 'fork', verdict: 'failed', upstreamRequests: 40, gate, attempts: { total: 40, passed: 28, required: null, runs: [] }, checks: [once], output: PY_TAIL } }), { mode: 'fork', checks: [once.label] });
    expect(report.head).toEqual(['The agent exited with code 1 in 12 of 40 attempts, too often for its gate']);
    expect(report.parts.map((p) => p.kind)).toEqual(['gate', 'attempts', 'error', 'checks']);
    expect(report.parts[2]).toMatchObject({ kind: 'error', file: 'refund_agent.py', error: { exception: "KeyError: 'total'" } });
    expect(report.hint).toEqual({ key: 'crash' });
  });

  it('never words a gate’s own sentence as what its attempts did, and says a gate stopped short of its limit stopped', () => {
    const reason = 'inconclusive · 16 of 20 · rate 0.47 to 0.98 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 20 attempts';
    const ranOut = world('flaky', () => ({ ok: false, failure: 'inconclusive', reason, data: { mode: 'fork', verdict: 'inconclusive', gate: gateResult(sprt(20), outcomes(16, 4), { decision: 'inconclusive' }), attempts: { total: 20, passed: 16, required: null, runs: [] }, checks: [once], output: PY_TAIL } }), { mode: 'fork', checks: [once.label] }).report;
    expect(ranOut.head).toEqual(['Failed in 4 of 20 attempts, and its gate ran out before deciding']);
    expect(ranOut.parts.map((p) => p.kind)).toEqual(['gate', 'attempts', 'checks']);
    expect(ranOut.hint).toEqual({ key: 'gate' });
    const stopped = world('flaky', () => ({ ok: false, failure: 'inconclusive', reason, data: { mode: 'fork', verdict: 'inconclusive', gate: gateResult(sprt(40), outcomes(16, 4), { decision: 'inconclusive' }), attempts: { total: 20, passed: 16, required: null, runs: [] }, checks: [check(TWICE, 'failed', 'called 2 times (1 blocked)')] } }), { mode: 'fork', checks: [TWICE] }).report;
    expect(stopped.head).toEqual(['send_email called twice in 4 of 20 attempts, and its gate stopped before deciding']);
    // What the check adds to the verdict's words, which say how often it was called: only what was blocked.
    expect(stopped.parts[1]).toMatchObject({ kind: 'attempts', check: { label: TWICE, detail: '1 blocked' } });
  });
});

describe('the provider', () => {
  it('says a golden the provider was unavailable for is that, never that its check wasn’t judged', () => {
    const reason = 'provider unavailable: 3 attempts in a row ended on HTTP 529 (overloaded), so none of them says anything about the agent; run it again once the provider answers';
    const { report } = world('refund', () => ({ ok: false, failure: 'inconclusive', reason, data: { mode: 'fork', verdict: 'inconclusive', upstreamRequests: 3, attempts: { total: 3, passed: 0, required: null, runs: [] }, checks: [check('send_email called 0 times', 'passed')] } }), { mode: 'fork', checks: ['send_email called 0 times'] });
    expect(report).toMatchObject({ verdict: 'inconclusive', head: ['Provider unavailable: 3 attempts in a row ended on HTTP 529 (overloaded), so none of them says anything about the agent'], sub: ['3 upstream requests'], hint: { key: 'provider', why: 'unavailable' } });
    expect(report.parts).toEqual([{ kind: 'checks', labels: ['send_email called 0 times'] }]);
  });

  it('says attempts the provider cut short decide the count, in the result’s words', () => {
    const reason = 'inconclusive: 3 of 5 attempts passed, 2 of them cut short by the provider, 5 needed: counted as failures the count is lost, as passes it is met, so it rests on how they would have ended';
    const { report } = world('refund', () => ({ ok: false, failure: 'inconclusive', reason, data: { mode: 'fork', verdict: 'inconclusive', attempts: { total: 5, passed: 3, required: 5, runs: [] } } }), { mode: 'fork' });
    expect(report.head).toEqual(['3 of 5 attempts passed, 2 of them cut short by the provider, 5 needed: counted as failures the count is lost, as passes it is met, so it rests on how they would have ended']);
    expect(report.hint).toEqual({ key: 'provider', why: 'cut' });
  });
});

describe('a fork golden of one attempt', () => {
  const forked = { type: 'request_changed' as const, callNo: 3, kind: 'api' as const, name: 'POST /v1/messages', replayedBefore: 2, text: '' };

  it('draws its replay up to its fork, live from there, never as replayed clean', () => {
    const { report } = world('refund', () => ({ ok: false, failure: 'check', reason: 'check failed: send_email called 0 times, but called 1 time', data: { mode: 'fork', calls: { total: 7, replayed: 2, live: 5, blocked: 0, stubbed: 0 }, upstreamRequests: 5, divergence: forked, checks: [check('send_email called 0 times', 'failed', 'called 1 time')] } }), { mode: 'fork', calls: 'rrrrrrr', checks: ['send_email called 0 times'] });
    expect(report.parts[0]).toEqual({ kind: 'replay', recorded: 7, replayed: 2, stop: null, words: '2 of 7 recorded calls replayed, forked at call 3, live from there · 5 upstream requests' });
  });

  it('says its judge check wasn’t judged, and where it forked, never that it replayed clean', () => {
    const judge = check('judge "polite" answers yes', 'inconclusive', 'no key to ask claude-x with', { judge: { name: 'polite', model: 'claude-x', verdict: null, reason: null, cost: null } as unknown as NonNullable<StoredCheck['judge']> });
    const { report } = world('refund', () => ({ ok: false, failure: 'inconclusive', reason: 'check inconclusive: judge "polite" answers yes: no key to ask claude-x with', data: { mode: 'fork', verdict: 'inconclusive', calls: { total: 7, replayed: 2, live: 5, blocked: 0, stubbed: 0 }, upstreamRequests: 0, divergence: forked, checks: [judge] } }), { mode: 'fork', checks: [judge.label] });
    expect(report.head).toEqual(['Its judge check wasn’t judged']);
    expect(report.sub).toEqual(['forked at call 3, live from there', '0 upstream requests']);
  });
});

describe('a report that can’t be built', () => {
  it('is left out, never the page, and the page keeps every report without Runs’ count when that read fails', () => {
    const { store, reports } = world('refund', () => ({ ok: false, failure: 'exit', reason: 'the agent exited with code 1', data: { mode: 'replay', calls: { total: 1, replayed: 1, live: 0, blocked: 0, stubbed: 0 } } }));
    const goldens: GoldenSource[] = [{ path: 'goldens/refund', runId: null, packedAt: 1, mode: 'replay', repeat: 1, passes: 1, checks: [] }];
    const broken = new Proxy(store, {
      get: (s, key) => {
        if (key === 'getRun') throw new Error('the store went away');
        const v: unknown = Reflect.get(s, key, s);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(s) : v;
      },
    });
    expect(goldenReports(testsView(store, goldens, { folder: 'goldens' }), { store: broken, goldens, normalizers: [], project: null })).toEqual({});
    // The pooled count failed: each report stands, with no Failed runs →.
    expect(withFailedRuns(reports, null, undefined)['goldens/refund']).toEqual({ ...reports['goldens/refund'], failedRuns: null });
    store.close();
  });
});
