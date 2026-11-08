import { describe, expect, it } from 'vitest';
import { checkWords, evaluateChecks, type CallRecord } from '@shadowlap/engine';
import type { ToolCheck } from '../../engine/src/checks/grammar.js';
import { fixCheckText, type CheckCall } from '../ui/run/banner.js';

/**
 * A fix's check a run failed, on the run's page, in the words `shadowlap check` and `shadowlap test`
 * print for it: the label is the engine's `toolCheckLabel`, and what the calls did its
 * `toolCountDetail`, never a copy in the dashboard that drifts (`1,000 times` where the CLI writes
 * `1000 times`).
 */

interface Made {
  name: string;
  args: Record<string, unknown>;
  origin?: 'live' | 'blocked' | 'stubbed';
}

/** What the CLI says of the check, from the engine's evaluation, and what the page says of the fix's check, from the same calls. */
function both(check: string, spec: ToolCheck, made: readonly Made[]): { cli: string; page: string } {
  const records = made.map((m, i) => ({ kind: 'tool', name: m.name, origin: m.origin ?? 'live', callNo: i + 1, meta: {} }) as unknown as CallRecord);
  const [result] = evaluateChecks({ tools: [spec] }, { calls: records, output: '', answer: null, argsOf: (c) => made[records.indexOf(c)]?.args, costOf: () => 0 });
  const calls: CheckCall[] = made.map((m) => ({ kind: 'tool', name: m.name, origin: m.origin ?? 'live', detail: JSON.stringify(m.args) }));
  if (!result) throw new Error('no check evaluated');
  return { cli: `check failed: ${checkWords(result, ', but ')}`, page: fixCheckText(check, calls) };
}

describe('a fix’s check on a run’s page', () => {
  it('counts a tool checked at 1000 as the CLI does', () => {
    const sent = [{ name: 'send_email', args: { to: 'ops@example.com' } }, { name: 'send_email', args: { to: 'ops@example.com' }, origin: 'blocked' as const }];
    const { cli, page } = both('send_email called 1000 times', { name: 'send_email', count: { min: 1000, max: 1000 } }, sent);
    expect(cli).toBe('check failed: send_email called 1000 times, but called 2 times (1 blocked)');
    expect(page).toBe(cli);
  });

  it('says at least 1000 as the CLI does', () => {
    const { cli, page } = both('send_email called at least 1000 times', { name: 'send_email', count: { min: 1000, max: Infinity } }, [{ name: 'send_email', args: {} }]);
    expect(cli).toBe('check failed: send_email called at least 1000 times, but called 1 time');
    expect(page).toBe(cli);
  });

  it('names the arguments, the calls fenced after a fork and the calls with other arguments as the CLI does', () => {
    const made = [
      { name: 'issue_refund', args: { order_id: 'A-1042', amount: 240 }, origin: 'stubbed' as const },
      { name: 'issue_refund', args: { order_id: 'A-1042', amount: 240 }, origin: 'blocked' as const },
      { name: 'issue_refund', args: { order_id: 'A-1043', amount: 100 } },
      { name: 'lookup_order', args: { order_id: 'A-1042' } },
    ];
    const { cli, page } = both('issue_refund never called with {"amount":240}', { name: 'issue_refund', count: { min: 0, max: 0 }, args: { amount: 240 } }, made);
    // The calls with other arguments: of the three calls of it, the one that doesn't hold them.
    expect(cli).toBe('check failed: issue_refund with {"amount":240} called 0 times, but called 2 times (1 blocked, 1 stubbed); 1 call with other arguments');
    expect(page).toBe(cli);
  });

  it('lists the tools called when the one checked never was, as the CLI does', () => {
    const { cli, page } = both('send_email called once', { name: 'send_email', count: { min: 1, max: 1 } }, [{ name: 'lookup_order', args: {} }, { name: 'issue_refund', args: {} }]);
    expect(cli).toBe('check failed: send_email called 1 time, but called 0 times; tools called: lookup_order, issue_refund');
    expect(page).toBe(cli);
  });

  it('quotes a check its calls can’t settle, so it never reads as what happened', () => {
    expect(fixCheckText('send_email called once', [{ kind: 'tool', name: 'send_email', detail: '{}' }])).toBe('check failed: “send_email called once”');
    expect(fixCheckText('the agent apologises', [])).toBe('check failed: “the agent apologises”');
  });
});
