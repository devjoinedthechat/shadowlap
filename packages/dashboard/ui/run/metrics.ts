import { approx, ktok, money, receiptDuration } from '../format.js';
import type { OriginCounts } from '../origins.js';
import { judgedOutcome, runOutcome, type RunLike, type RunOutcomeWords } from '../runs.js';

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
  /** Of the failed calls, those an offline replay refused (not in the recording: HTTP 503, nothing sent). */
  refused?: number;
}

/** A number (or its words), what it counts, and its tone: `lime`, `err`, or `q` for the quiet receipt. */
export type MetricItem = [string | number, string, string?];

export function metricItems(m: MetricInput): MetricItem[] {
  const n = m.counts;
  const unpriced = m.cost.spent === 0 && m.cost.unknownModels.length > 0;
  const by = m.spentBy ? ` · by ${m.spentBy}` : '';
  const spent: MetricItem = m.capture ? [money(m.cost.captured), 'as captured'] : unpriced ? ['—', `spent${by} · no price for ${m.cost.unknownModels[0]!}`] : [approx(m.cost.spent), `spent${by}`];
  const upstream: MetricItem = [m.upstreamRequests, m.upstreamRequests === 1 ? 'upstream request' : 'upstream requests'];
  const plain = !n.rep && !n.block && !n.stub && !n.inject && !n.over;
  // Calls an offline replay refused are "refused", as the design says; any other failure, "failed".
  const failed: MetricItem = [n.fail, n.fail && m.refused === n.fail ? 'refused' : 'failed', 'err'];
  if (plain) {
    const items: MetricItem[] = [
      [m.total, m.live ? (m.total === 1 ? 'call so far' : 'calls so far') : m.total === 1 ? 'call' : 'calls'],
      [m.byKind.api, m.byKind.api === 1 ? 'model call' : 'model calls'],
      // A capture of the model calls alone never saw the tools: none were captured, which is no count of them.
      m.toolsCaptured === false && !m.byKind.tool ? ['—', 'tool calls not captured'] : [m.byKind.tool, m.byKind.tool === 1 ? 'tool call' : 'tool calls'],
    ];
    if (n.fail) items.push(failed);
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
  if (n.fail) items.push(failed);
  if (n.block + n.stub) items.push([n.block + n.stub, n.block && n.stub ? 'fenced' : n.stub ? 'stubbed' : 'blocked']);
  items.push(upstream, spent);
  if (m.cost.saved || m.tokensNotRespent) items.push([money(m.cost.saved), `not re-spent${m.tokensNotRespent ? ` · ${ktok(m.tokensNotRespent)} input tokens` : ''}`, 'q']);
  if (m.notWaitedMs) items.push([receiptDuration(m.notWaitedMs), 'not waited', 'q']);
  return items;
}

// ---- How the run came out: its first fact ----

/** A check as the run's outcome judged it, for the fact's hover (run-outcome.ts `JudgedCheck`). */
export interface FactCheck {
  label: string;
  status: 'passed' | 'failed' | 'inconclusive' | 'not-applicable';
  detail: string | null;
}

/** The first fact: a dot and a word in its verdict's colour, the call it turned on apart (a link), and what judged it, on hover. */
export interface OutcomeFact {
  tone: RunOutcomeWords['tone'];
  /** Its words, without the call: `check failed at`, `2 checks passed`, `no checks`. */
  words: string;
  callNo: number | null;
  /** Judged by checks its family's goldens added after it was recorded, or rules on calls changed since its import. */
  today: boolean;
  /** Its hover: a title, a line under it, and each check with how it came out. */
  tip: { title: string; sub: string | null; rows: Array<[string, string, string]> };
}

const STATUS_COLOUR: Readonly<Record<FactCheck['status'], string>> = { passed: 'var(--cq-lime)', failed: 'var(--err)', inconclusive: 'var(--cq-amber)', 'not-applicable': 'var(--faint)' };
const STATUS_WORD: Readonly<Record<FactCheck['status'], string>> = { passed: 'passed', failed: 'failed', inconclusive: 'inconclusive', 'not-applicable': 'not applicable' };

/** Each check as the hover lists it: its label, then how it came out and what it found. */
const rowsOf = (checks: readonly FactCheck[]): Array<[string, string, string]> => checks.map((c) => [c.label, `${STATUS_WORD[c.status]}${c.detail ? ` · ${c.detail}` : ''}`, STATUS_COLOUR[c.status]]);

/** What judged it, as the hover's title and the line under it says. */
function judgedTip(j: NonNullable<OutcomeInput['judged']>): Pick<OutcomeFact['tip'], 'title' | 'sub'> {
  const goldens = j.goldens.join(' and ');
  if (j.by === 'family') return j.today ? { title: 'Today’s checks, judged from the recording', sub: `It was recorded before them: ${goldens}’s checks, added with the golden or since.` } : { title: 'Its family’s checks', sub: `${goldens}’s checks, which it was made under.` };
  if (j.by === 'import') return { title: j.today ? 'Judged again by today’s rules on calls' : 'Judged when it was imported', sub: j.why ? `Not applicable: ${j.why}.` : 'By the rules on calls in shadowlap.config.json.' };
  return { title: 'Its checks', sub: null };
}

/** What the first fact reads: the run as the lists read it, with its outcome's checks and whether it made a tool call. */
export interface OutcomeInput extends RunLike {
  judged?: (NonNullable<RunLike['judged']> & { goldens: string[]; why: string | null; checks?: readonly FactCheck[] }) | null;
}

/**
 * How the run came out, its page's first fact, in the words Runs' Status has (runOutcome): the
 * verdict of the checks that judged it, the call it turned on apart, by today's checks after it when
 * they came after the run. A run no check judges says `no checks`, a clean replay and a fork too
 * (how faithful a replay was is no verdict), and its hover says how a check comes to judge it.
 */
export function outcomeFact(r: OutcomeInput, o: { tools: number }): OutcomeFact {
  const out = runOutcome(r);
  if (out.tone === 'live') return { tone: 'live', words: out.text, callNo: null, today: false, tip: { title: 'Still recording', sub: 'It is judged once it finishes.', rows: [] } };
  const j = r.judged;
  if (j && judgedOutcome(r)) return { tone: out.tone, words: out.at?.words ?? out.text, callNo: out.at?.callNo ?? null, today: !!out.today, tip: { ...judgedTip(j), rows: rowsOf(j.checks ?? []) } };
  if (out.text === 'interrupted') return { tone: 'n', words: out.text, callNo: null, today: false, tip: { title: 'Stopped before it ended', sub: 'Ctrl-C, a kill or a crash: it stopped, and did not fail.', rows: [] } };
  if (out.tone === 'n' || out.tone === 'fk' || out.text === 'clean') {
    const how = o.tools ? 'Pack it as a golden with checks, or give a golden of its family checks under "tests" in shadowlap.config.json.' : 'It made no tool call, and a check on calls reads them.';
    return { tone: 'n', words: 'no checks', callNo: null, today: false, tip: { title: 'No check judges this run', sub: how, rows: [] } };
  }
  return { tone: out.tone, words: out.text, callNo: null, today: false, tip: { title: out.text.charAt(0).toUpperCase() + out.text.slice(1), sub: null, rows: [] } };
}
