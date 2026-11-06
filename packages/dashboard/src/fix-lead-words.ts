/**
 * The words of a fix's lead step that both the fix's page and Needs a look show (fix-lead.ts): one
 * place, so the two can't drift. No imports: the page reads it as it is.
 */

/** A verified fix with no patch to apply, or one whose patch is in the tree already: nothing runs, so no ACTIONS entry. */
export const MARK_APPLIED = 'Mark applied';

/** Apply fix's card: what pressing it does to your files. */
export const APPLY_SUB = 'It changes your working tree';

/** Run blame with stronger model…'s card. */
export const BLAME_STRONGER_SUB = 'Another model answers from each probed call instead of the recorded one';

/** Run blame again's card: a blame that stopped runs to the end; one that couldn't settle asks more often, with a lower bar. */
export function blameAgainSub(again: { kind: 'unsettled' | 'stopped'; gate?: { good?: number; max?: number } | null }): string {
  if (again.kind === 'stopped') return 'Runs the search to the end, without the budget that stopped it';
  return `More attempts and a lower bar: a rescue at ${Math.round((again.gate?.good ?? 0.4) * 100)}% or more, up to ${again.gate?.max ?? 40} attempts`;
}

/** Run repair's card: who proposes the rewrites, the default repairer being your own Claude Code. */
export function repairSub(repairer: string | null): string {
  return `${repairer && repairer !== 'claude-code' ? repairer : 'Your own Claude Code'} proposes rewrites, each tried in a worktree of its own`;
}
