/**
 * The oracle a replay is judged by, in words: the agent exits 0, and passes the checks of `--expect`
 * (the engine's checks/oracle.ts, which the dashboard reads a check's oracle with too). Apart from
 * the runners that judge by it (attempts.ts), so what lists a golden's checks (goldens.ts) loads none
 * of them.
 */

export { EXIT_LABEL, oracleLabels } from '@shadowlap/engine';
