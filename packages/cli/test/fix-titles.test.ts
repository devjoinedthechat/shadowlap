import { describe, expect, it } from 'vitest';
import { BLAME_DEFAULTS, SPRT_DEFAULTS, type CallRecord, type SprtGate } from '@shadowlap/engine';
import { evaluateChecks, parseExpect, showValue, type CheckResult } from '../src/checks.js';
import { blameCommand, checkText, failureTitle, repairCommand, verifyCommand } from '../src/fixes.js';

/** Tool calls as a recording holds them, for judging checks against. */
function calls(...tools: Array<[string, Record<string, unknown>?]>): CallRecord[] {
  return tools.map(([name, args], i) => ({ runId: 'r', callNo: i + 1, kind: 'tool', name, fingerprint: `f${i}`, occurrence: 0, origin: 'live', effect: 'write', requestRef: JSON.stringify(args ?? {}), meta: {}, at: i, end: null, attempts: [] }));
}

function title(expect: unknown, recorded: CallRecord[], extra: { output?: string; answer?: string | null; failures?: string[]; models?: number; tokens?: number } = {}): string {
  const spec = parseExpect(expect, '--expect');
  const api: CallRecord[] = Array.from({ length: extra.models ?? 0 }, (_, i) => ({ runId: 'r', callNo: 100 + i, kind: 'api', name: 'POST /v1/messages', fingerprint: `m${i}`, occurrence: 0, origin: 'live', effect: null, requestRef: null, meta: {}, at: 0, end: { runId: 'r', callNo: 100 + i, attempt: 0, responseRef: null, outcome: 'ok', meta: { usage: { inputTokens: extra.tokens ?? 0, outputTokens: 0 } }, at: 0 }, attempts: [] }));
  const checks: CheckResult[] = evaluateChecks(spec, { calls: [...recorded, ...api], output: extra.output ?? '', answer: extra.answer ?? null, argsOf: (c) => JSON.parse(c.requestRef ?? '{}'), costOf: () => 0.08 });
  return failureTitle(spec, { checks, failures: extra.failures ?? [] });
}

describe('a failure in plain words', () => {
  it('says what the recording did against each kind of check', () => {
    expect(title({ tools: { issue_refund: { count: 0, args: { amount: 240 } } } }, calls(['issue_refund', { order_id: 'A-1042', amount: 240 }]))).toBe('issue_refund called with amount 240');
    expect(title({ tools: { issue_refund: 0 } }, calls(['issue_refund']))).toBe('issue_refund called');
    expect(title({ tools: { send_email: 1 } }, calls(['send_email'], ['send_email']))).toBe('send_email called twice, not once');
    expect(title({ tools: { escalate: '>= 1' } }, calls(['issue_refund']))).toBe('escalate never called');
    expect(title({ tools: { send_email: '<= 2' } }, calls(['send_email'], ['send_email'], ['send_email']))).toBe('send_email called 3 times, more than twice');
    expect(title({ tools: { send_email: { count: 2, args: { to: 'ops@example.com', subject: 'Your refund' } } } }, calls(['send_email', { to: 'ops@example.com', subject: 'Your refund' }]))).toBe('send_email called once with to ops@example.com, subject "Your refund", not twice');
    expect(title({ modelCalls: '<= 2' }, [], { models: 3 })).toBe('3 model calls, more than 2');
    expect(title({ inputTokens: '<= 60000' }, [], { models: 1, tokens: 71_940 })).toBe('71,940 input tokens, more than 60,000');
    expect(title({ cost: '<= 0.05' }, [], { models: 1 })).toBe('Costs more than $0.05');
    expect(title({ output: { includes: 'refund issued' } }, [])).toBe('Output never says "refund issued"');
    expect(title({ answer: { excludes: 'cannot help' } }, [], { answer: 'Sorry, I cannot help with that.' })).toBe('Final answer says "cannot help"');
  });

  it('takes a calls rule\'s first problem whole, a quoted value\'s own "; " and "#12" with it', () => {
    const email = (body: string) => calls(['send_email', { to: 'team@example.com', body }]);
    // The reference agent's email body, against a rule that wants another one.
    expect(title({ calls: [{ tool: 'send_email', args: { body: 'Replay works.' } }] }, email('Replay works; forks fence writes.'))).toBe('send_email: body "Replay works; forks fence writes." != "Replay works."');
    expect(title({ calls: [{ tool: 'send_email', args: { body: { includes: 'ok; go' } } }] }, email('See #12; then reply.'))).toBe('send_email: body "See #12; then reply." doesn\'t include "ok; go"');
    // The call numbers outside the values still go, and the next problem still ends the title.
    expect(title({ calls: [{ tool: 'send_email', after: 'lookup', args: { body: 'x' } }] }, email('a; b'))).toBe('send_email: no lookup call before it');
    expect(title({ calls: [{ tool: 'send_email', args: { body: 'x', to: 'ops@example.com' } }] }, email('a; b'))).toBe('send_email: body "a; b" != "x"');
    // A value cut short is closed after its mark, so the title ends where its problem does.
    const long = `${'Replay works; '.repeat(8)}end`;
    expect(title({ calls: [{ tool: 'send_email', args: { body: 'x', to: 'ops@example.com' } }] }, email(long))).toBe(`send_email: body "${long.slice(0, 78)}…" != "x"`);
  });

  it('shows a long value cut short with its quotes paired', () => {
    expect(showValue('a'.repeat(100))).toBe(`"${'a'.repeat(78)}…"`);
    expect(showValue({ body: 'a'.repeat(100) })).toBe(`{"body":"${'a'.repeat(70)}…"`);
    const numbers = Array.from({ length: 30 }, (_, i) => i);
    expect(showValue(numbers)).toBe(`${JSON.stringify(numbers).slice(0, 79)}…`);
    // An escape cut in two loses its backslash, which would escape the closing quote.
    expect(showValue(`${'a'.repeat(77)}"${'b'.repeat(20)}`)).toBe(`"${'a'.repeat(77)}…"`);
    expect(showValue('a'.repeat(78))).toBe(`"${'a'.repeat(78)}"`);
  });

  it('takes the first check the recording failed, and the exit code when it failed none', () => {
    expect(title({ tools: { escalate: 1, issue_refund: 0 } }, calls(['escalate'], ['issue_refund']))).toBe('issue_refund called');
    expect(failureTitle(null, { checks: [], failures: ['the agent exited with code 2'] })).toBe('The agent exited with code 2');
    expect(failureTitle(null, { checks: [], failures: ['timed out after 30s'] })).toBe('The agent timed out');
    expect(failureTitle(null, { checks: [], failures: [] })).toBe('The run failed');
  });
});

describe('a check in plain words', () => {
  it('says what a passing run does', () => {
    expect(checkText(parseExpect({ tools: { issue_refund: { count: 0, args: { amount: 240 } } } }, 'e'))).toBe('issue_refund never called with {"amount":240}');
    expect(checkText(parseExpect({ tools: { send_email: 1, escalate: '>= 1' } }, 'e'))).toBe('send_email called once; escalate called at least once');
    expect(checkText(parseExpect({ modelCalls: '<= 12', inputTokens: '<= 60000', cost: '<= 0.05' }, 'e'))).toBe('at most 12 model calls; at most 60,000 input tokens; cost at most $0.05');
    expect(checkText(parseExpect({ output: { includes: 'done', excludes: 'error' } }, 'e'))).toBe('output includes "done"; output doesn\'t include "error"');
    expect(checkText(null)).toBe('the agent exits 0');
  });
});

describe('commands that run a step again', () => {
  const expect_ = { tools: { issue_refund: 0 } };
  const blameGate: SprtGate = { kind: 'sprt', ...BLAME_DEFAULTS };
  const verifyGate: SprtGate = { kind: 'sprt', ...SPRT_DEFAULTS };
  it('quote the check and keep only the flags that differ from the defaults', () => {
    expect(blameCommand('01M3RZ4XKN0000000000000000', { expect: expect_, fields: {}, attempts: 10, needed: 2, gate: blameGate })).toBe(`shadowlap blame 01M3RZ4XKN --expect '{"tools":{"issue_refund":0}}'`);
    expect(blameCommand('01M3RZ4XKN0000000000000000', { expect: null, scope: 'agent', fields: { model: 'big-model', temperature: 1 }, attempts: 3, needed: 1, gate: null })).toBe('shadowlap blame 01M3RZ4XKN --scope agent --model big-model --set temperature=1 --attempts 3 --passes 1');
    expect(verifyCommand({ fixes: ['01M3RXQ4VB'], holdout: ['01M3RXQ51B'], keeps: ['label:good'] }, { expect: expect_, attempts: 40, gate: verifyGate, fields: {}, liveTools: ['read_policy'] })).toBe(`shadowlap verify --fixes 01M3RXQ4VB --holdout 01M3RXQ51B --keeps label:good --expect '{"tools":{"issue_refund":0}}' --live-tool read_policy`);
    expect(repairCommand({ fixes: ['label:refund-bug'], keeps: ['label:good'] }, { expect: expect_, repairer: 'claude-code', attempts: 40, gate: verifyGate })).toBe(`shadowlap repair --fixes label:refund-bug --keeps label:good --expect '{"tools":{"issue_refund":0}}' --repairer claude-code`);
  });

  it('keep the figures of a gate that differ from its defaults, and write a fixed count out in full', () => {
    expect(blameCommand('01M3RZ4XKN0000000000000000', { expect: null, fields: {}, attempts: 10, needed: 2, gate: { ...blameGate, good: 0.5, max: 10 } })).toBe(`shadowlap blame 01M3RZ4XKN --gate '{"good":0.5,"max":10}'`);
    // The gate is what runs without flags, so a fixed count is given whole, the old default too.
    expect(blameCommand('01M3RZ4XKN0000000000000000', { expect: null, fields: {}, attempts: 5, needed: 2, gate: null })).toBe('shadowlap blame 01M3RZ4XKN --attempts 5 --passes 2');
    expect(verifyCommand({ fixes: ['label:refund-bug'] }, { attempts: 40, gate: { ...verifyGate, risk: 0.01 }, fields: {}, liveTools: [] })).toBe(`shadowlap verify --fixes label:refund-bug --gate '{"risk":0.01}'`);
    expect(verifyCommand({ fixes: ['label:refund-bug'] }, { attempts: 5, gate: null, fields: {}, liveTools: [] })).toBe('shadowlap verify --fixes label:refund-bug --attempts 5');
  });

  it('keep every flag that changes what a step finds, and the command given after --', () => {
    const flags = { writes: 'block' as const, reads: 'replay' as const, budget: 0.5, timeoutMs: 30_000, argv: ['python', 'agent.py', '--order', 'A 1042'] };
    expect(blameCommand('01M3RZ4XKN0000000000000000', { expect: null, fields: {}, attempts: 10, needed: 2, gate: blameGate, scan: 4, ...flags })).toBe(`shadowlap blame 01M3RZ4XKN --scan 4 --writes block --reads replay --budget 0.5 --timeout 30 -- python agent.py --order 'A 1042'`);
    // Defaults are left out.
    expect(blameCommand('01M3RZ4XKN0000000000000000', { expect: null, fields: {}, attempts: 10, needed: 2, gate: blameGate, scan: 2, writes: 'stub', reads: 'live', budget: null, timeoutMs: null, argv: null })).toBe('shadowlap blame 01M3RZ4XKN');
    expect(verifyCommand({ fixes: ['label:refund-bug'] }, { attempts: 3, passes: 2, gate: null, fields: { temperature: 1 }, liveTools: [], failFast: true, ...flags })).toBe(`shadowlap verify --fixes label:refund-bug --set temperature=1 --attempts 3 --passes 2 --fail-fast --writes block --reads replay --budget 0.5 --timeout 30 -- python agent.py --order 'A 1042'`);
    expect(
      repairCommand({ fixes: ['label:refund-bug'], holdout: ['01M3RXQ51B'] }, { expect: expect_, repairer: 'anthropic', candidates: 5, stronger: 'claude-opus-5-5', scope: 'agent', set: { temperature: 1 }, attempts: 40, gate: verifyGate, maxGrowth: 0.125, build: 'npm run build', ...flags }),
    ).toBe(`shadowlap repair --fixes label:refund-bug --holdout 01M3RXQ51B --expect '{"tools":{"issue_refund":0}}' --repairer anthropic --candidates 5 --stronger claude-opus-5-5 --scope agent --set temperature=1 --max-growth 12.5 --build 'npm run build' --writes block --reads replay --budget 0.5 --timeout 30 -- python agent.py --order 'A 1042'`);
    expect(repairCommand({ fixes: ['label:refund-bug'] }, { attempts: 40, gate: verifyGate, candidates: 3, maxGrowth: 0.25, build: null })).toBe('shadowlap repair --fixes label:refund-bug');
  });
});
