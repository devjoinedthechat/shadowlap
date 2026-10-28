import { fixLabels, fixOfRun, isObject, recordingsOfRun, testsEntryFor, type RunRecord, type StoreOf } from '@shadowlap/engine';
import { checkSuggestion, labelledFixes } from './fix-shared.js';

/** The check blame is asked to find a run failing: the run's own failed checks, its golden's, or what a fix holds it to. */

export interface BlameCheck {
  /** The check as `--expect` takes it; null to blame on the exit code alone. */
  expect: unknown;
  /**
   * Where it came from: the run was judged by it with `--expect` (`replay`); shadowlap.config.json's
   * `tests` give it for the recording the run replays, found through its ancestors as the CLI finds
   * it (`config`); the fix the run fails in has it (`fix`); a fix the run's labels point to has it
   * (`labels`); or the agent exited with an error, which every blame checks (`exit`).
   */
  from: 'replay' | 'config' | 'fix' | 'labels' | 'exit';
}

/** The checks a run failed, as it recorded them (`meta.checks`). */
export function failedChecks(run: RunRecord): string[] {
  const checks: unknown = run.meta?.checks;
  if (!Array.isArray(checks)) return [];
  return checks.flatMap((c) => (isObject(c) && c.ok === false && typeof c.label === 'string' ? [c.label] : []));
}

/**
 * The `expect` shadowlap.config.json's `tests` give the recording a run replays (the golden a test
 * replayed, or the pack it was unpacked from, through its ancestors), or undefined when no entry
 * names one. `tests` is the config's `tests` as written; `configDir` the folder it is in.
 */
export function configExpect(store: StoreOf<'recording'>, run: RunRecord, tests: unknown, configDir: string): Record<string, unknown> | undefined {
  if (!isObject(tests)) return undefined;
  const entries = Object.entries(tests).map(([recording, spec]) => ({ recording, spec }));
  for (const dir of recordingsOfRun(store, run)) {
    const entry = testsEntryFor(entries, dir, configDir);
    if (entry) return isObject(entry.spec) && isObject(entry.spec.expect) ? entry.spec.expect : undefined;
  }
  return undefined;
}

/**
 * The check a blame of a run can use when nobody named one, or null when nothing says what a
 * passing run must do: then the dashboard asks for it. In order: the run's own `--expect`; the
 * config's, for the recording it replays (`tests`, the config's `tests`, and `configDir`, its
 * folder); the fix it fails in; a fix its labels point to; the agent's exit, for a run that exited
 * with an error. A run that failed a check none of these name gets null rather than the exit code:
 * blaming on the exit alone would look for another failure than the one it had.
 */
export function blameCheckFor(store: StoreOf<'recording' | 'fixes'>, run: RunRecord, options: { tests?: unknown; configDir?: string | null } = {}): BlameCheck | null {
  const judged = run.meta?.expect;
  if (isObject(judged)) return { expect: judged, from: 'replay' };
  const configured = options.configDir ? configExpect(store, run, options.tests, options.configDir) : undefined;
  if (configured) return { expect: configured, from: 'config' };
  const failing = fixOfRun(store, run.runId);
  if (failing) return { expect: failing.check.expect ?? null, from: 'fix' };
  const suggested = fixLabels(run).length ? checkSuggestion(run, labelledFixes(store)) : null;
  if (suggested) return { expect: suggested.expect ?? null, from: 'labels' };
  if (failedChecks(run).length) return null;
  if (run.status === 'failed') return { expect: null, from: 'exit' };
  return null;
}
