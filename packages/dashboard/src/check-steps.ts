import { ACTIONS, checkStatus, type TestResult } from '@shadowlap/engine';
import { commandLine } from './fix-shared.js';
import { checksChanged } from './tests-checks.js';
import { nameOf, testPatterns, type GoldenSource } from './tests.js';

/*
 * The steps a golden's checks lead with, by its results and its checks as the config holds them
 * now, so Tests, its last test replay's page and Needs a look say the same (next-step.ts). Neither
 * reads a call.
 */

/**
 * `run-tests`: its checks changed since its last test (`gone`, the checks that result failed or
 * couldn't decide that the config no longer holds), so only a test judges them as they are now.
 * `edit-check`: its own recording fails `check`, a check added since its previous test.
 */
export type ChecksStep = { key: 'run-tests'; golden: string; gone: string[] } | { key: 'edit-check'; golden: string; check: string };

/**
 * A golden's step by its checks, from its results newest first and its checks now (`checks`, as the
 * CLI labels them); null when its checks lead with nothing.
 *
 * Edit check holds when its newest result failed a check the config still holds on a clean replay of
 * a golden marked replay, so that check's status is its recording's, and its previous result didn't
 * judge that check: it was added since. A golden with no previous result, and one marked fork (whose
 * telling needs the recording judged), keep the steps of a failed check.
 */
export function checksStep(golden: { path: string; mode: 'replay' | 'fork'; checks: readonly string[] }, results: readonly TestResult[]): ChecksStep | null {
  const [latest, previous] = results;
  const gone = checksChanged(latest ?? null, golden.checks);
  if (gone) return { key: 'run-tests', golden: golden.path, gone: gone.map((c) => c.label) };
  if (!latest || !previous || golden.mode !== 'replay' || latest.failure !== 'check' || latest.data?.divergence || latest.data?.mode === 'fork') return null;
  const judged = new Set((previous.data?.checks ?? []).map((c) => c.label));
  const added = (latest.data?.checks ?? []).find((c) => checkStatus(c) === 'failed' && golden.checks.includes(c.label) && !judged.has(c.label));
  return added ? { key: 'edit-check', golden: golden.path, check: added.label } : null;
}

/**
 * The step in words: Run tests runs the whole session, as Tests' header does (one golden alone would
 * be Re-run test), and says what it judges, `onRun` on the test replay's page; Edit check opens the
 * check builder at the check, on the golden.
 */
export function checksStepWords(step: ChecksStep, goldens: readonly GoldenSource[], onRun: boolean): ChecksStep & { label: string; sub: string; command?: string } {
  if (step.key === 'run-tests') return { ...step, label: ACTIONS.runTests.label, sub: `Its checks changed since ${onRun ? 'this test' : 'its last test'}: the session judges them as they are now`, command: commandLine(['test', ...testPatterns(goldens)]) };
  return { ...step, label: ACTIONS.editCheck.label, sub: `It fails ${nameOf(step.golden, 'goldens')}’s own recording: edit the check, or update the golden if the agent should now do this` };
}
