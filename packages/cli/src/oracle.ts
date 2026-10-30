import { evaluateChecks, LABEL_INPUT, type TestSpec } from './checks.js';

/**
 * The oracle a replay is judged by, in words: the agent exits 0, and passes the checks of `--expect`.
 * Apart from the runners that judge by it (attempts.ts), so what lists a golden's checks (goldens.ts)
 * loads none of them.
 */

export const EXIT_LABEL = 'the agent exits 0';

/** The oracle, as the labels of what a passing run must do. */
export function oracleLabels(spec: TestSpec | null): string[] {
  return [EXIT_LABEL, ...(spec ? evaluateChecks(spec, LABEL_INPUT).map((c) => c.label) : [])];
}
