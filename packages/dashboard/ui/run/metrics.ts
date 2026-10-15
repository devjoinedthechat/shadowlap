import { approx, ktok, money, receiptDuration } from '../format.js';
import type { OriginCounts } from '../origins.js';

/**
 * The run's numbers, in the order the page shows them: the counts lead; what replaying saved comes
 * last, as a quieter receipt (not re-spent, its tokens, and the time not waited). No DOM here: the
 * tests import it, and `parts.tsx` draws it.
 */

export interface MetricInput {
  total: number;
  byKind: { api: number; tool: number };
  upstreamRequests: number;
  cost: { spent: number; saved: number; captured: number; unknownModels: readonly string[] };
  /** Input tokens the replayed calls did not send again. */
  tokensNotRespent: number;
  counts: OriginCounts;
  /** A run imported from a capture: its cost is what the traffic cost where it ran. */
  capture: boolean;
  live: boolean;
  /** Every replayed call's recorded duration, summed. */
  notWaitedMs: number | null;
}

/** A number (or its words), what it counts, and its tone: `lime`, `err`, or `q` for the quiet receipt. */
export type MetricItem = [string | number, string, string?];

export function metricItems(m: MetricInput): MetricItem[] {
  const n = m.counts;
  const unpriced = m.cost.spent === 0 && m.cost.unknownModels.length > 0;
  const spent: MetricItem = m.capture ? [money(m.cost.captured), 'as captured'] : unpriced ? ['—', `spent · no price for ${m.cost.unknownModels[0]}`] : [approx(m.cost.spent), 'spent'];
  const upstream: MetricItem = [m.upstreamRequests, m.upstreamRequests === 1 ? 'upstream request' : 'upstream requests'];
  const plain = !n.rep && !n.block && !n.stub && !n.inject && !n.over;
  if (plain) {
    const items: MetricItem[] = [
      [m.total, m.live ? (m.total === 1 ? 'call so far' : 'calls so far') : m.total === 1 ? 'call' : 'calls'],
      [m.byKind.api, m.byKind.api === 1 ? 'model call' : 'model calls'],
      [m.byKind.tool, m.byKind.tool === 1 ? 'tool call' : 'tool calls'],
    ];
    if (n.fail) items.push([n.fail, 'failed', 'err']);
    items.push(upstream, spent);
    return items;
  }
  const items: MetricItem[] = [
    [m.total, m.total === 1 ? 'call' : 'calls'],
    [n.rep, 'replayed', n.rep ? 'lime' : ''],
    [n.live, 'live'],
  ];
  if (n.over) items.push([n.over, 'overridden']);
  if (n.inject) items.push([n.inject, 'injected']);
  if (n.fail) items.push([n.fail, 'failed', 'err']);
  if (n.block + n.stub) items.push([n.block + n.stub, n.block && n.stub ? 'fenced' : n.stub ? 'stubbed' : 'blocked']);
  items.push(upstream, spent);
  if (m.cost.saved || m.tokensNotRespent) items.push([money(m.cost.saved), `not re-spent${m.tokensNotRespent ? ` · ${ktok(m.tokensNotRespent)} tokens` : ''}`, 'q']);
  if (m.notWaitedMs) items.push([receiptDuration(m.notWaitedMs), 'not waited', 'q']);
  return items;
}
