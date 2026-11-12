import { asNumber } from './grammar.js';

/**
 * The numbers a run's tool calls returned, as a check reads them, pure: nothing here needs Node, so
 * the dashboard's check builder bundles it beside the parser and the miner of suggested checks
 * (suggest-checks.ts) reads values by the same rule.
 */

/** A number a tool call's result recorded under a field: what a reference to it reads, `@lookup_order.result.total`. */
export interface RecordedField {
  tool: string;
  field: string;
  value: number | string;
  /** The call that recorded it: the latest of its tool that did. */
  callNo: number;
}

/**
 * A condition's threshold that the run itself recorded: another value of its results below this
 * one and above 0 (a policy's limit below an order's amount), the largest of them; null when there
 * is none.
 */
export function lowerRecorded(all: readonly Pick<RecordedField, 'tool' | 'field' | 'value'>[], f: Pick<RecordedField, 'tool' | 'field' | 'value'>): number | null {
  const v = asNumber(f.value);
  if (v === null) return null;
  const lower = all
    .filter((x) => !(x.tool === f.tool && x.field === f.field))
    .map((x) => asNumber(x.value))
    .filter((n): n is number => n !== null && n < v && n > 0)
    .sort((a, b) => b - a)[0];
  return lower ?? null;
}
