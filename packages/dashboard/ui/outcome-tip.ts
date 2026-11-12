import { checkWords } from '../../engine/src/checks/labels.js';
import { shortId } from './format.js';
import { DIVERGED } from './run/banner.js';
import type { JudgedLike, OutcomeOf, RunLike, RunOutcomeWords } from './runs.js';

/**
 * What a run's status says to a screen reader, kept on the run page: the check it names, or the line
 * under its card's title. The card itself, what judged it and each check (outcome-card.ts), loads as
 * the pointer or the focus first reaches the status. No DOM here: the tests import it.
 */

export interface OutcomeTip {
  title: string;
  sub: string | null;
  /** Each check: its label, how it came out and what it found, and its colour. */
  rows: Array<[string, string, string]>;
  /** The first check that failed, or could not be decided, in a line: what a screen reader is told of the status. */
  said: string | null;
}

/** What a run's card is worked out from (outcome-card.ts): its outcome as outcomeOf says it, the tool calls it made, and whether the page offers Add check… on them. */
export interface CardAsk {
  r: RunLike;
  out: RunOutcomeWords & { of: OutcomeOf };
  tools: number;
  offered: boolean;
}

/** The check a status names, in a line: `send_email called at most 1 time, but called 2 times`, `judge "polite" answers yes: inconclusive · not judged: …`. */
export function firstWords(j: JudgedLike): string | null {
  const f = j.first;
  if (!f) return j.why ?? null;
  const failed = j.verdict === 'failed';
  return checkWords({ label: f.label, detail: f.detail, ok: false, status: failed ? 'failed' : 'inconclusive' }, ', but ');
}

export const upper = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** What a divergence was, as a fork's banner says it: `a request changed`, with the path its diff found first where the run says it. */
export function divergedWhy(r: Pick<RunLike, 'divergence'>): string | null {
  const d = r.divergence;
  if (!d) return null;
  const path = d.type === 'request_changed' ? d.diff?.[0]?.path : undefined;
  return `${upper(DIVERGED[d.type] ?? d.type)}${path ? ` (~ ${path})` : ''}.`;
}

/** The lines under a status's title that a screen reader is told too: a run still recording, one a fix passes since, one that stopped. */
export const LIVE = 'It is judged once it finishes.';
export const FIXED_SUB = (r: Pick<RunLike, 'fixedBy'>): string => `${shortId(r.fixedBy ?? '')} replays it and passes.`;
export const INTERRUPTED = 'Ctrl-C, a kill or a crash: it stopped, and did not fail.';

/** How a run that failed by its agent's exit says so: with its code where it was one, on Runs and Fixes alike. */
export const exitWords = (code: number | null | undefined): string => (typeof code === 'number' && code !== 0 ? `The agent exited with code ${code}` : 'The agent exited with an error');

/** What a screen reader is told of a run's status, as its card's `said` (outcome-card.ts `outcomeTip`). */
export function outcomeSaid(r: RunLike, out: RunOutcomeWords & { of: OutcomeOf }): string | null {
  switch (out.of) {
    case 'judged':
      return firstWords(r.judged!);
    case 'live':
      return LIVE;
    case 'fixed':
      return FIXED_SUB(r);
    case 'diverged':
      return divergedWhy(r);
    case 'check':
    case 'inconclusive':
      return r.outcome?.check ?? null;
    case 'interrupted':
      return INTERRUPTED;
    default:
      return null;
  }
}
