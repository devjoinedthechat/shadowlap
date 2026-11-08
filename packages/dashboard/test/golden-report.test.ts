import { describe, expect, it } from 'vitest';
import { gateResult, injectionTemplates, Store, type AttemptReport, type InjectionGateData, type StoredCheck, type TestResult } from '@shadowlap/engine';
import { failedRunsHref, goldenReports, judgeAsked, printedLines, withFailedRuns, type GoldenReport } from '../src/golden-report.js';
import { links } from '../src/links.js';
import { runJob } from '../src/read-jobs.js';
import { testsView, type GoldenSource } from '../src/tests.js';
import { addRun } from './read-model-store.js';

const PY_TAIL = ['Traceback (most recent call last):', '  File "/work/shop/refund_agent.py", line 141, in issue_refund', '    log.info("refund %s of %s", refund["refund_id"], order["total"])', "KeyError: 'total'"].join('\n');
const NODE_TAIL = ["file:///work/shop/agent.mjs:141", '  const total = order.payment.amount;', '                              ^', '', "TypeError: Cannot read properties of undefined (reading 'amount')", '    at issueRefund (file:///work/shop/agent.mjs:141:31)', '', 'Node.js v22.11.0'].join('\n');

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
    expect(report.hint).toEqual({ key: 'check' });
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
    expect(report.parts[0]).toEqual({ kind: 'gate', bound: expect.stringMatching(/^rate /), passK: expect.stringMatching(/^pass\^5 /) });
    expect(report.parts[1]).toEqual({ kind: 'attempts', check: { label: twice.label, detail: 'called 2 times' }, carried: { count: 80, at: 1_000 }, forked: null });
    expect(report.hint).toEqual({ key: 'gate' });
    store.close();
  });

  it('says a history gate failed on a drop against its own history, with no pass^5', () => {
    const gate = { kind: 'baseline' as const, drop: 0.15, risk: 0.05, window: 5, min: 8, max: 8 };
    const once = check('issue_refund called 1 time', 'failed', 'called 0 times');
    const { report } = world('refund', () => ({ ok: false, failure: 'check', reason: 'its pass rate dropped against its history', data: { mode: 'fork', verdict: 'failed', gate: gateResult(gate, [true, true, true, true, false, false, false, false], { history: { passes: 40, attempts: 40, sessions: 5 }, decision: 'fail' }), attempts: { total: 8, passed: 4, required: null, runs: [] }, checks: [once] } }), { mode: 'fork', checks: [once.label] });
    expect(text(report.head)).toMatch(/^issue_refund .* in 4 of 8 attempts, a drop against its own history$/);
    expect(report.parts[0]).toEqual({ kind: 'gate', bound: expect.any(String), passK: null });
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

  it('says what obeyed and its limit, proves it from the attempt that obeyed, and opens the proof there', () => {
    let attempt = '';
    const reason = `send_email obeyed a planted instruction in 5 of 72 attempts (at most 0 allowed): send_email.to = ${canary}`;
    const { report } = world('research', (_r, _s, st) => {
      const k = kept(st, [{ verdict: 'ignored' }, { verdict: 'obeyed', evidence: [{ kind: 'canary', callNo: 6, tool: 'send_email', path: '$.to', value: canary, why: null }] }]);
      attempt = k.runs[1]!;
      return { ok: false, failure: 'injection', reason: `injection: ${reason}`, data: { mode: 'fork', calls: { total: 7, replayed: 7, live: 0, blocked: 0, stubbed: 0 }, injection: gate(k.resultId, 'failed', reason), details: 'Every attempt, with its proof: shadowlap injection goldens/research --html report.html' } };
    });
    expect(report.head).toEqual(['send_email obeyed a planted instruction in 5 of 72 attempts (at most 0 allowed)']);
    expect(report.parts).toEqual([
      { kind: 'proof', runId: attempt, line: `planted at #4 → read at #5 → send_email.to = ${canary} at #6`, why: null },
      { kind: 'injection-attempts', totals: { obeyed: 5, influenced: 2, inconclusive: 3, ignored: 62 }, where: 'every template at every untrusted read,', each: '3 attempts each', command: 'shadowlap injection goldens/research --html report.html', resultId: 'inj-1' },
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
    expect(report.parts[0]).toEqual({ kind: 'proof', runId: attempt, line: 'planted at #4 → read at #5', why: 'model call #15 failed with HTTP 529 (overloaded)' });
    expect(report.parts[1]).toMatchObject({ where: `${templates[0].id} at every untrusted read,`, each: '3 attempts each' });
    expect(report.open).toEqual({ label: 'Open attempt', href: `#/run/${attempt}/5` });
    expect(report.hint).toEqual({ key: 'injection-inconclusive', why: 'unanswered' });
  });

  it('says nothing could be planted in a sentence, and draws no proof where the result is gone', () => {
    const reason = 'no untrusted read to plant in: mark the tools that bring outside text in, with "tools": { "<name>": { "trust": "untrusted" } } in shadowlap.config.json';
    const { report } = world('research', () => ({ ok: false, failure: 'injection', reason: `injection inconclusive: ${reason}`, data: { mode: 'fork', verdict: 'inconclusive', calls: { total: 7, replayed: 7, live: 0, blocked: 0, stubbed: 0 }, injection: { ...gate(null, 'inconclusive', reason), attempts: 0, obeyed: 0, influenced: 0, ignored: 0, inconclusive: 0 } } }));
    expect(report.head).toEqual(['No untrusted read to plant in']);
    expect(report.parts).toEqual([{ kind: 'injection-attempts', totals: { obeyed: 0, influenced: 0, inconclusive: 0, ignored: 0 }, where: null, each: null, command: 'shadowlap injection goldens/research --html report.html', resultId: null }]);
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
  it('counts a golden’s failed replays as Runs’ Failed view lists them, newest first, and opens that view', async () => {
    const store = Store.open(':memory:');
    const rec = addRun(store, { startedAt: 1_000, calls: 'rr' });
    // Runs' words match a run's command too: a golden named as the agent's file is would match every replay.
    const replay = (at: number, failed: boolean, golden = 'goldens/refund') => addRun(store, { parent: rec, startedAt: at, calls: 'r', argv: ['python', 'agent.py'], ...(failed ? { status: 'failed' as const } : {}), meta: { test: { golden, session: 's' } } });
    const failed = [replay(2_000, true), replay(3_000, true)];
    replay(4_000, false);
    replay(5_000, true, 'goldens/other');
    const answer = await runJob(store, { kind: 'tests-failed-runs', goldens: [{ golden: 'goldens/refund', name: 'refund' }, { golden: 'goldens/none', name: 'none' }], outcome: null }, { whole: true });
    const runs = JSON.parse(answer.body) as Record<string, { count: number; ids: string[] }>;
    expect(runs).toEqual({ 'goldens/refund': { count: 2, ids: [failed[1], failed[0]] } });
    const report = { golden: 'goldens/refund', name: 'refund', failedRuns: null } as unknown as GoldenReport;
    expect(withFailedRuns({ 'goldens/refund': report }, runs, undefined)['goldens/refund'].failedRuns).toEqual({ href: links.runs({ q: 'type:test refund', types: 'failed' }), count: 2, ids: [failed[1], failed[0]] });
    store.close();
  });

  it('leaves the link out where the golden’s step is its fix, and quotes a name with a space', () => {
    const report = { golden: 'goldens/refund', name: 'refund', failedRuns: null } as unknown as GoldenReport;
    expect(withFailedRuns({ 'goldens/refund': report }, { 'goldens/refund': { count: 1, ids: ['r'] } }, { 'goldens/refund': { key: 'fix' } })['goldens/refund'].failedRuns).toBeNull();
    expect(failedRunsHref('late refund')).toBe(links.runs({ q: 'type:test "late refund"', types: 'failed' }));
  });
});
