import { patchLines } from '../fixes/model.js';
import type { FoundChange } from '../types.js';

/**
 * The way back once Find breaking commit named a crash's first bad commit: its change as the commit
 * made it, Copy git revert, Open in editor at the line it added, and Revert, which undoes it in the
 * working tree (src/revert-job.ts). No DOM here: the tests import it.
 */

/** A change's lines, each kept, added or removed, as a box of marked lines takes them (CodeBox's `lines`). */
export type ChangeLines = ReturnType<typeof patchLines>;

/** What Copy git revert copies: the commit undone in a commit of its own, a merge against its first parent. */
export const gitRevertCommand = (rev: string, merge: boolean): string => `git revert ${merge ? '-m 1 ' : ''}${rev}`;

/** Copy git revert's card, under its name. */
export const COPY_REVERT_SUB = 'Undoes the commit in a new one; review it before you push';

/** The change the commit made to its file, each line it added or removed marked; none without a hunk (a binary or deleted file). */
export const changeLines = (change: Pick<FoundChange, 'hunk'>): ChangeLines | null => (change.hunk ? patchLines(change.hunk) : null);

/** The change undone, as Revert's dialog shows what it does: each line the commit added taken out, each it removed put back. */
export function revertedLines(hunk: string): ChangeLines {
  return patchLines(hunk).map((l) => (l.op === '+' ? { ...l, op: '-' as const } : l.op === '-' ? { ...l, op: '+' as const } : l));
}

/** Revert's warning where the commit changed files outside the project folder: git reverts the whole commit, those too. */
export const outsideWords = (n: number): string => (n === 1 ? '1 of the commit’s files is outside this project, and git reverts it too' : `${n} of the commit’s files are outside this project, and git reverts them too`);
