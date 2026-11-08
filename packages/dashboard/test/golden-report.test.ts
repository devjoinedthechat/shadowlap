import { describe, expect, it } from 'vitest';
import { Store, type StoredCheck, type TestResult } from '@shadowlap/engine';
import { goldenReports, judgeAsked, printedLines, type GoldenReport } from '../src/golden-report.js';
import { testsView, type GoldenSource } from '../src/tests.js';

const PY_TAIL = ['Traceback (most recent call last):', '  File "/work/shop/refund_agent.py", line 141, in issue_refund', '    log.info("refund %s of %s", refund["refund_id"], order["total"])', "KeyError: 'total'"].join('\n');
const NODE_TAIL = ["file:///work/shop/agent.mjs:141", '  const total = order.payment.amount;', '                              ^', '', "TypeError: Cannot read properties of undefined (reading 'amount')", '    at issueRefund (file:///work/shop/agent.mjs:141:31)', '', 'Node.js v22.11.0'].join('\n');

const check = (label: string, status: StoredCheck['status'], detail?: string, extra: Partial<StoredCheck> = {}): StoredCheck => ({ label, ok: status === 'passed', status, ...(detail ? { detail } : {}), ...extra }) as StoredCheck;

/** A store with one recording packed as `goldens/<name>`, and a replay of it that came out as `result` says. */
function world(name: string, result: (replay: string, session: string) => Omit<Parameters<Store['addTestResult']>[0], 'sessionId' | 'golden' | 'runId'>, o: { checks?: string[]; mode?: 'replay' | 'fork'; divergence?: Parameters<Store['setDivergence']>[1] } = {}) {
  const store = Store.open(':memory:');
  const recording = store.createRun({ mode: 'record', command: { argv: ['python', 'refund_agent.py'], cwd: '/work/shop' } });
  const s = store.startTestSession({ command: ['shadowlap', 'test', `goldens/${name}`], revision: 'abc1234' });
  const replay = store.createRun({ mode: 'replay', command: { argv: ['python', 'refund_agent.py'], cwd: '/work/shop' }, meta: { test: { golden: `goldens/${name}`, session: s.sessionId } } });
  if (o.divergence) store.setDivergence(replay.runId, o.divergence);
  store.addTestResult({ sessionId: s.sessionId, golden: `goldens/${name}`, runId: replay.runId, ...result(replay.runId, s.sessionId) });
  const goldens: GoldenSource[] = [{ path: `goldens/${name}`, runId: recording.runId, packedAt: 1, mode: o.mode ?? 'replay', repeat: 1, passes: 1, checks: o.checks ?? [] }];
  const view = testsView(store, goldens, { folder: 'goldens' });
  const reports = goldenReports(view, { store, goldens, normalizers: [], project: '/work/shop' });
  return { store, replay: replay.runId, report: reports[`goldens/${name}`], reports };
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

  it('says what changed at the call, and draws no strip for a divergence at call 1', () => {
    const { report } = world('refund', () => diverged(1), { divergence: { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, recorded: 30 } });
    expect(text(report.head)).toBe('Diverged at call 1: `$.metadata.user_id` changed, a UUID');
    expect(report.parts).toEqual([]);
    expect(report.sub).toEqual(['0 upstream requests']);
    expect(report.hint).toEqual({ key: 'normalizer' });
  });

  it('draws its replay up to the call that diverged past call 1', () => {
    const { report } = world('refund', () => diverged(3), { divergence: { type: 'request_changed', callNo: 3, kind: 'api', name: 'POST /v1/messages', replayedBefore: 2, recorded: 30 } });
    expect(report.parts).toEqual([{ kind: 'replay', recorded: 30, replayed: 2, stop: 3, words: '2 of 30 recorded calls replayed, then call 3 diverged · 0 upstream requests' }]);
    expect(report.sub).toEqual([]);
    expect(report.printed.map((l) => l.tone)).toEqual(['no', '', 'del', 'add']);
  });
});

describe('a check', () => {
  it('names the check a replay golden failed and what it found, over a clean replay', () => {
    const { report } = world('refund', () => ({ ok: false, failure: 'check', reason: 'check failed: send_email called 0 times, but called 1 time', data: { mode: 'replay', calls: { total: 7, replayed: 7, live: 0, blocked: 0, stubbed: 0 }, upstreamRequests: 0, checks: [check('send_email called 0 times', 'failed', 'called 1 time'), check('output includes "refund"', 'passed')] } }), { checks: ['send_email called 0 times', 'output includes "refund"'], divergence: { type: 'ended_early', callNo: 8, kind: 'api', name: 'POST /v1/messages', replayedBefore: 7, recorded: 7 } });
    expect(text(report.head)).toBe('Check failed: `send_email called 0 times`, but called 1 time');
    expect(report.parts).toEqual([{ kind: 'replay', recorded: 7, replayed: 7, stop: null, words: '7 of 7 calls replayed, clean · 0 upstream requests' }, { kind: 'checks', labels: ['send_email called 0 times', 'output includes "refund"'] }]);
    expect(report.hint).toEqual({ key: 'check' });
  });

  it('leads with the checks that left the config since its last test', () => {
    const { report } = world('refund', () => ({ ok: false, failure: 'check', reason: 'check failed: issue_refund called 0 times, but called 1 time', data: { mode: 'replay', calls: { total: 7, replayed: 7, live: 0, blocked: 0, stubbed: 0 }, upstreamRequests: 0, checks: [check('issue_refund called 0 times', 'failed', 'called 1 time')] } }), { checks: ['output includes "refund"'] });
    expect(report.parts[0]).toEqual({ kind: 'checks-changed', gone: [{ label: 'issue_refund called 0 times', status: 'failed' }] });
    expect(report.sub).toEqual(['its last test, before its checks changed']);
    expect(report.hint).toEqual({ key: 'checks-changed' });
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
    expect(report.parts).toEqual([{ kind: 'attempts', check: { label: 'send_email called at most 1 time', detail: 'called 2 times' }, carried: null, forked: 2 }, { kind: 'checks', labels: ['output includes "refund"'] }]);
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

  it('prints no tail for an injection gate', () => {
    const lines = printedLines('refund', result({ failure: 'injection', reason: 'injection: send_email obeyed a planted instruction in 1 of 3 attempts (at most 0 allowed)', data: { mode: 'fork', calls: { total: 1, replayed: 1, live: 0, blocked: 0, stubbed: 0 }, details: 'Every attempt, with its proof: shadowlap injection goldens/refund --html report.html', output: 'agent said things' } }));
    expect(lines.map((l) => l.text)).toEqual(['✗ refund: injection: send_email obeyed a planted instruction in 1 of 3 attempts (at most 0 allowed)', '    Every attempt, with its proof: shadowlap injection goldens/refund --html report.html']);
  });
});

describe('a judge asked live', () => {
  const judged = (extra: Partial<StoredCheck>) => check('judge "polite" answers yes', 'passed', undefined, { source: 'live', judge: { name: 'polite', model: 'claude-x', cost: 0.002 } as unknown as NonNullable<StoredCheck['judge']>, ...extra });

  it('counts the attempts it was asked in, from the result’s judge summary where it is the only judge', () => {
    const c = judged({});
    const r = { data: { checks: [c], attempts: { total: 5, passed: 5, required: null, runs: [] }, judge: { calls: 5, replayed: 0, live: 5, spent: 0.01, unknownModels: [], notAsked: 0, upstreamRequests: 5 } } } as unknown as TestResult;
    expect(judgeAsked(r, c)).toEqual({ cost: 0.01, asked: 5 });
  });

  it('counts one ask of a result of one attempt, and none of a verdict from the recording', () => {
    const c = judged({});
    expect(judgeAsked({ data: { checks: [c] } } as unknown as TestResult, c)).toEqual({ cost: 0.002, asked: 1 });
    expect(judgeAsked({ data: { checks: [c] } } as unknown as TestResult, judged({ source: 'recording' }))).toBeNull();
  });
});
