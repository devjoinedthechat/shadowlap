import type { Tone } from '../components/Status.js';
import { approx, ktok, money, receiptDuration } from '../format.js';
import type { OriginCounts } from '../origins.js';
import { outcomeTip, type OutcomeTip } from '../outcome-tip.js';
import { outcomeOf, type RunLike, type RunOutcomeWords } from '../runs.js';

/**
 * The run's facts after how it came out, in the order the header shows them: its calls, then, quieter,
 * what it spent, and on a replay or a fork the receipts (not re-spent, not waited). What made each up
 * is on its card: the calls' kinds and origins, the upstream requests, the input tokens not sent
 * again. No DOM here: the tests import it, and `parts.tsx` draws it.
 */

export interface MetricInput {
  total: number;
  byKind: { api: number; tool: number };
  upstreamRequests: number;
  cost: { spent: number; saved: number; captured: number; unknownModels: readonly string[] };
  /** Input tokens the replayed calls did not send again: uncached, written to the cache and read from it, as `show` and `test` count them. */
  tokensNotRespent: number;
  counts: OriginCounts;
  /** A run imported from a capture: its cost is what the traffic cost where it ran. */
  capture: boolean;
  /** False for a capture that recorded the model calls alone (a nock or VCR file of the provider's traffic): it never saw the tools. */
  toolsCaptured?: boolean;
  /**
   * A run pulled from the team store: who recorded it, by name. What it spent was spent there, and
   * says so ("spent · by maya"). Absent for a run made here, or one that names no one.
   */
  spentBy?: string;
  live: boolean;
  /** Every replayed call's recorded duration, summed. */
  notWaitedMs: number | null;
  /** Replayed calls whose recorded duration wasn't found, which `notWaitedMs` leaves out. */
  notWaitedUnknown?: number;
  /** Of the failed calls, those an offline replay refused (not in the recording: HTTP 503, nothing sent). */
  refused?: number;
}

/** What a fact's card says: a title, rows of what made it up, and a line under them. */
export interface MetricCard {
  title: string;
  rows: Array<[string, string | number]>;
  sub?: string;
}

/** A number (or its words), what it counts, its tone (`q` for a quieter one), and what made it up, on its card. */
export interface MetricItem {
  value: string | number;
  label: string;
  cls: '' | 'q';
  tip: MetricCard;
}

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/** What the calls were, each kind or origin it had any of: the calls' card's rows. */
function callRows(m: MetricInput): MetricCard['rows'] {
  const n = m.counts;
  // Calls an offline replay refused are "refused", as the design says; any other failure, "failed".
  const failed: [string, number] = [n.fail && m.refused === n.fail ? 'refused' : 'failed', n.fail];
  const made: MetricCard['rows'] =
    n.rep || n.block || n.stub || n.inject || n.over
      ? [['replayed', n.rep], ['live', n.live], ['overridden', n.over], ['injected', n.inject], ['blocked', n.block], ['stubbed', n.stub], failed]
      : // A capture of the model calls alone never saw the tools: none were captured, which is no count of them.
        [['model calls', m.byKind.api], m.toolsCaptured === false && !m.byKind.tool ? ['tool calls not captured', '—'] : ['tool calls', m.byKind.tool], failed];
  return made.filter(([, v]) => v !== 0);
}

export function metricItems(m: MetricInput): MetricItem[] {
  const unpriced = m.cost.spent === 0 && m.cost.unknownModels.length > 0;
  const by = m.spentBy ? ` · by ${m.spentBy}` : '';
  const upstream: MetricCard['rows'] = [[plural(m.upstreamRequests, 'upstream request'), m.upstreamRequests]];
  const items: MetricItem[] = [
    { value: m.total, label: m.live ? plural(m.total, 'call so far', 'calls so far') : plural(m.total, 'call'), cls: '', tip: { title: `${m.total.toLocaleString('en-US')} ${plural(m.total, 'call')}`, rows: callRows(m) } },
    m.capture
      ? { value: money(m.cost.captured), label: 'as captured', cls: 'q', tip: { title: 'As the capture recorded it', rows: upstream } }
      : { value: unpriced ? '—' : approx(m.cost.spent), label: unpriced ? `spent${by} · no price for ${m.cost.unknownModels[0]!}` : `spent${by}`, cls: 'q', tip: { title: 'Spent live', rows: upstream } },
  ];
  if (m.cost.saved || m.tokensNotRespent) items.push({ value: money(m.cost.saved), label: 'not re-spent', cls: 'q', tip: { title: 'Replayed from the recording', rows: m.tokensNotRespent ? [['input tokens not sent again', ktok(m.tokensNotRespent)]] : [] } });
  if (m.notWaitedMs) items.push({ value: receiptDuration(m.notWaitedMs), label: 'not waited', cls: 'q', tip: { title: 'The recorded time of the replayed calls', rows: [], ...(m.notWaitedUnknown ? { sub: `${m.notWaitedUnknown} replayed calls’ recorded durations were not found` } : {}) } });
  return items;
}

// ---- How the run came out: its first fact ----

/** The first fact: a status, a dot and a word in its verdict's colour, the call it turned on apart (a link), and what judged it, on hover. */
export interface OutcomeFact {
  /** Its tone as Status draws it: muted for no checks, nothing yet and an interrupted run, none of them a verdict. */
  tone: Tone;
  /** Its words, without the call: `check failed at`, `2 checks passed`, `no checks`. */
  words: string;
  callNo: number | null;
  /** Judged by checks its family's goldens added after it was recorded, or rules on calls changed since its import. */
  today: boolean;
  /** Its hover, the card Runs' Status shows too (outcome-tip.ts). */
  tip: OutcomeTip;
}

/**
 * How the run came out, its page's first fact, in the words Runs' Status has (outcomeOf): the
 * verdict of the checks that judged it, the call it turned on apart, by today's checks after it when
 * they came after the run. A run no check judges says `no checks`, by a grey dot, a clean replay and a
 * fork too (how faithful a replay was is no verdict), and its hover says how a check comes to judge
 * it. `pending`: a long run whose first answer came before its analysis judged it, which says nothing
 * yet. An interrupted run says so muted, by a grey dot, as every status that is no verdict.
 */
export function outcomeFact(r: RunLike, o: { tools: number; pending?: boolean }): OutcomeFact {
  if (o.pending) return { tone: 'mu', words: '…', callNo: null, today: false, tip: { title: 'Judging it by its checks', sub: 'Read from all its calls, beside the server.', rows: [], said: 'judging it by its checks' } };
  const out = outcomeOf(r);
  const tip = outcomeTip(r, out, o.tools);
  if (out.of === 'none' || out.of === 'fork') return { tone: 'mu', words: 'no checks', callNo: null, today: false, tip };
  return { tone: factTone(out.tone), words: out.at?.words ?? out.text, callNo: out.at?.callNo ?? null, today: !!out.today, tip };
}

/** The first fact's tone as Status draws it: what Runs sets with no dot (an interrupted run) or a neutral one (a fork's writes) is no verdict, so muted. */
const factTone = (t: RunOutcomeWords['tone']): Tone => (t === 'n' || t === 'fk' ? 'mu' : t);
