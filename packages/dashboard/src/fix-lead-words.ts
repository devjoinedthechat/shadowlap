/**
 * The labels a fix's lead takes that no ACTIONS entry has (fix-lead.ts), which the fix's page and the
 * lists that lead with it (Fixes, Needs a look) say alike: one place, so they can't drift. No imports:
 * the page reads it as it is.
 */

/** A verified fix with no patch to apply, or one whose patch is in the tree already: nothing runs, so no ACTIONS entry. */
export const MARK_APPLIED = 'Mark applied';

/** A fix applied part way, its goldens not copied or not tested yet: applying it again does the rest. */
export const FINISH_APPLYING = 'Finish applying';
