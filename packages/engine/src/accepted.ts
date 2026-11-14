/**
 * A golden's accepted changes in words, as `shadowlap test` prints them and the dashboard's report
 * of a diverged golden shows them: who accepted a change, when and why, and the line that leads the
 * sentences a later change takes out of it. The record itself, `accepted.jsonl` beside the golden's
 * pack, is the CLI's (golden-accepted.ts). No file is read here: a browser imports it.
 */

/** A sentence a diverging request takes out that an accepted change put in, with when, by whom and why that change was accepted. */
export interface TakenOutNote {
  sentence: string;
  /** When it was accepted, as an ISO date and time. */
  at: string;
  /** Who accepted it, or null where no one is named. */
  by: string | null;
  reason: string;
  /** The fix it came with (`fx-…`). */
  fix?: string;
}

/** The most characters of a reason the dashboard's Update golden takes. */
export const REASON_MAX = 300;

/** What leads the sentences a change takes out, under a divergence. */
export const TAKEN_OUT_HEAD = 'this change takes out what an accepted change put in:';

/** An accepted change in a line: `accepted 2026-11-14 by dev@example.com: <reason> (fix fx-01M3…)`. */
export function acceptedWords(a: Pick<TakenOutNote, 'at' | 'by' | 'reason' | 'fix'>): string {
  return `accepted ${a.at.slice(0, 10)}${a.by ? ` by ${a.by}` : ''}: ${a.reason}${a.fix ? ` (fix ${a.fix})` : ''}`;
}
