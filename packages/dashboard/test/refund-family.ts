import type { RunRecord, Store } from '@shadowlap/engine';
import { RunBuilder, text, toolUse, usage, user } from '../../engine/test/run-fixtures.js';
import type { OutcomeWork } from '../src/run-outcome.js';

/** A refund agent's runs and a project whose golden was packed from one of them: a family's checks to judge a run by (run-outcome.ts). */

export const T0 = 1_760_000_000_000;
const ASK = [user('Order A-1042 arrived damaged. Refund it, please.')];
export const WITHIN_TOTAL = { tool: 'issue_refund', after: 'lookup_order', args: { amount: { '<=': '@lookup_order.result.total' } } };

/** A refund run: the order looked up (total 240), refunded for `amount`, and an email sent. */
export function refund(store: Store, o: { amount: number; parent?: string; startedAt?: number; meta?: RunRecord['meta'] }): string {
  const b = RunBuilder.start(store, { startedAt: o.startedAt ?? T0, ...(o.parent ? { parent: o.parent } : {}), ...(o.meta ? { meta: o.meta } : {}) });
  b.model({ messages: ASK }, [toolUse('lookup_order', { order_id: 'A-1042' }, 'toolu_1')], { usage: usage(120) });
  b.tool('lookup_order', { order_id: 'A-1042' }, { order_id: 'A-1042', total: 240 });
  b.model({ messages: ASK }, [toolUse('issue_refund', { order_id: 'A-1042', amount: o.amount }, 'toolu_2')], { usage: usage(160) });
  b.tool('issue_refund', { order_id: 'A-1042', amount: o.amount }, { refund_id: 'R-5401' }, { effect: 'write' });
  b.tool('send_email', { to: 'ada@example.com' }, { sent: true }, { effect: 'write' });
  b.model({ messages: ASK }, [text('Refund issued for order A-1042.')], { usage: usage(200) });
  return b.end();
}

/** What the server would read of a project whose golden `goldens/refund` was packed from `runId` at `packedAt`, its checks changed since at `checksAt`. */
export function work(runId: string, o: { tests?: unknown; version?: string; packedAt?: number; checksAt?: number | null } = {}): OutcomeWork {
  return {
    version: o.version ?? 'v1',
    tests: o.tests ?? { 'goldens/refund': { expect: { calls: [WITHIN_TOTAL], tools: { send_email: '<= 1' } } } },
    dir: '/work/project',
    goldens: [{ path: 'goldens/refund', runId, packedAt: o.packedAt ?? T0 + 60_000, checksAt: o.checksAt ?? null }],
  };
}
