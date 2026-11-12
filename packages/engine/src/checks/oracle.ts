import { evaluateChecks, LABEL_INPUT } from './evaluate.js';
import type { TestSpec } from './grammar.js';

/**
 * The oracle a replay is judged by, in words: the agent exits 0, and passes the checks of `--expect`.
 * A fix keeps it beside its check, and a verdict counts for the fix when its oracle has every label
 * of the fix's (coversCheck): `shadowlap fix check` gives a fix one, and the Fixes page's preview of
 * a check reads which verdicts it would stop counting by it.
 */

export const EXIT_LABEL = 'the agent exits 0';

/** The oracle, as the labels of what a passing run must do. */
export function oracleLabels(spec: TestSpec | null): string[] {
  return [EXIT_LABEL, ...(spec ? evaluateChecks(spec, LABEL_INPUT).map((c) => c.label) : [])];
}
