import { ACTIONS, GATE_MAX_ATTEMPTS } from '@shadowlap/engine';
import type { GoldenSource, TestsJob, TestsOptions } from './tests.js';
import { knownGolden, testPatterns } from './tests-paths.js';

/**
 * The jobs that run the goldens again (Run tests, Run tests on…, Run more attempts) and re-record
 * them (Update golden): their command lines, from checked fields.
 */

/**
 * Run tests: every golden (`test goldens/*` and any kept elsewhere), the one `golden` names, or those
 * `goldens` names (Run tests on…), each once and each a golden on disk.
 * `maxAttempts` is Run more attempts: each gate's limit raised for this session only (`--max-attempts`).
 */
export function runTestsJob(goldens: readonly GoldenSource[], req: Record<string, unknown>, options: TestsOptions = {}): TestsJob {
  let more: string[] = [];
  if (req.maxAttempts !== undefined) {
    const n = req.maxAttempts;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > GATE_MAX_ATTEMPTS) return { error: `maxAttempts is a whole number from 1 to ${GATE_MAX_ATTEMPTS}` };
    more = ['--max-attempts', String(n)];
  }
  // Run more attempts carries an inconclusive gate's attempts over rather than starting again.
  if (req.continue !== undefined) {
    if (typeof req.continue !== 'boolean') return { error: 'continue is true or false' };
    if (req.continue) more.push('--continue');
  }
  if (req.golden !== undefined) {
    const golden = knownGolden(goldens, req.golden);
    return golden ? { title: more.length ? ACTIONS.runMoreAttempts.doing : ACTIONS.runTests.doing, args: ['test', golden, ...more] } : { error: 'no such golden: name one of the packs in the goldens folder or under "tests" in the config' };
  }
  if (req.goldens !== undefined) {
    const picked = knownGoldens(goldens, req.goldens, 'name the goldens to run');
    return 'error' in picked ? picked : { title: ACTIONS.runTests.doing, args: ['test', ...picked, ...more] };
  }
  if (!goldens.length) return { error: `no goldens yet: pack a run you consider correct into ${options.folder ?? 'goldens'}/ first` };
  return { title: ACTIONS.runTests.doing, args: ['test', ...testPatterns(goldens, options.folder), ...more] };
}

/** The goldens a job names, each a golden on disk and each once, in the order named; `none` is what to say when it names none. */
function knownGoldens(goldens: readonly GoldenSource[], raw: unknown, none: string): string[] | { error: string } {
  if (!Array.isArray(raw) || !raw.length || raw.length > 500) return { error: none };
  const paths: string[] = [];
  for (const r of raw) {
    const golden = knownGolden(goldens, r);
    if (!golden) return { error: `no such golden: ${typeof r === 'string' ? r : 'a name that is not text'}` };
    if (!paths.includes(golden)) paths.push(golden);
  }
  return paths;
}

/** Update golden, or Update goldens for several: each re-recorded live with writes stubbed, and replaced only when its checks pass. */
export function updateGoldensJob(goldens: readonly GoldenSource[], req: Record<string, unknown>): TestsJob {
  const paths = knownGoldens(goldens, Array.isArray(req.goldens) ? req.goldens : req.golden !== undefined ? [req.golden] : [], 'name the goldens to update');
  if ('error' in paths) return paths;
  return { title: paths.length === 1 ? ACTIONS.updateGolden.doing : ACTIONS.updateGoldens.doing, args: ['test', ...paths, '--update'] };
}
