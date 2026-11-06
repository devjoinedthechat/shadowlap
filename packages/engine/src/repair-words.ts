import type { RepairOutcome } from './repair.js';

/**
 * How a repair ended, in a word or two, wherever a list or a job's status line says it: `shadowlap fix
 * show` in a terminal, and the dashboard's job drawer, its status bar chip and the toast a hidden
 * repair's end raises. No imports but a type: the dashboard's pages bundle it as it is.
 */
const WORDS: Readonly<Record<RepairOutcome, string>> = { fixed: 'fixed', 'not-fixed': 'not fixed', 'no-diagnosis': 'no fix to try', stopped: 'stopped' };

/** `fixed`, `not fixed`, `no fix to try` (its blame named no call to repair) or `stopped`, by hand or at its budget. */
export function repairOutcomeWord(outcome: RepairOutcome): string {
  return WORDS[outcome];
}
