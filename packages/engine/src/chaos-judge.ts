import type { TestSpec } from './checks/grammar.js';
import { checkLabels } from './checks/labels.js';
import { DEFAULT_CHAOS, type ChaosSpec } from './checks/tests-entry.js';
import type { EffectOf } from './decisions.js';

/**
 * What judges a recording's error-path presets besides the agent exiting 0, as `test --chaos`,
 * `replay --chaos` and the dashboard's Run error-path presets… say it: the checks an error path must
 * pass (`chaos.expect` in the golden's tests entry, or `--expect`), else the upper bounds the golden's
 * own expect sets on write tools, else nothing but the exit status. And which attempt proves presets
 * that failed, which a presets job ends on and a run's page leads with.
 */

/** What judged a recording's presets besides the agent exiting 0. */
export interface ChaosJudge {
  /**
   * `chaos.expect` (the golden's tests entry), `--expect` (replay --chaos), `write-limits` (the upper
   * bounds the golden's own expect sets on write tools), or `exit` (nothing but the exit status).
   */
  source: 'chaos.expect' | '--expect' | 'write-limits' | 'exit';
  /** The checks, as a failure names them: `issue_refund called at most 1 time`. */
  checks: string[];
}

/**
 * The checks every error path must pass when `chaos.expect` doesn't say: the upper bounds the
 * golden's own expect sets on write tools, a tool of unknown effect counted as one. They hold on any
 * path (an agent whose lookup timed out may escalate rather than refund, but never refunds more than
 * the golden allows). A lower bound, or a bound on a read, says what the recorded path did, which a
 * path through a failure needn't do: a read retried after a timeout is the agent doing its job.
 * Null when the golden's expect sets no such bound.
 */
export function writeLimits(golden: TestSpec | null, effectOf: EffectOf): TestSpec | null {
  if (!golden) return null;
  const tools = golden.tools
    .filter((t) => Number.isFinite(t.count.max) && effectOf(t.name) !== 'read' && effectOf(t.name) !== 'pure')
    .map((t) => ({ name: t.name, count: { min: 0, max: t.count.max }, ...(t.args ? { args: t.args } : {}) }));
  return tools.length ? { fork: true, repeat: 1, passes: 1, tools } : null;
}

/**
 * The checks every attempt of a recording's presets is judged by, and where they came from:
 * `chaos.expect` (or `--expect`, which replay --chaos puts there), else the write limits of the
 * golden's own expect (`golden`, its spec), else none, and the agent exiting 0 alone judges them.
 */
export function chaosJudge(chaos: Pick<ChaosSpec, 'expect' | 'expectFrom'>, golden: TestSpec | null, effectOf: EffectOf): { checks: TestSpec | null; judge: ChaosJudge } {
  const checks = chaos.expect ?? writeLimits(golden, effectOf);
  // As a failure names them, without running them (the engine's labels, in evaluateChecks' order).
  const judge: ChaosJudge = checks ? { source: chaos.expect ? (chaos.expectFrom ?? 'chaos.expect') : 'write-limits', checks: checkLabels(checks) } : { source: 'exit', checks: [] };
  return { checks, judge };
}

/** Where checks that judged the presets came from, as the CLI's table's last line says it. */
export const JUDGED_FROM: Readonly<Record<Exclude<ChaosJudge['source'], 'exit'>, string>> = {
  'chaos.expect': 'chaos.expect',
  '--expect': '--expect',
  'write-limits': "the write limits of the golden's expect",
};

/** The hint under a table whose presets only the exit status judged: what would say more, in two lines. */
export function judgedOnExit(where: 'chaos.expect' | '--expect'): string {
  const example = `{"tools":{"issue_refund":"<= 1"}}`;
  const first = 'Each preset was judged on the agent exiting 0 alone: no checks say what an error path must do.';
  return where === '--expect' ? `${first}\nSay it with --expect, such as --expect '${example}'.` : `${first}\nSay it in its tests entry, as "chaos": { "expect": ${example} }, or as upper bounds on write tools in its "expect".`;
}

/**
 * The presets `replay <run> --chaos` runs, and the golden's spec whose write limits judge them, from
 * the checks the run is judged by (`--expect`, or recordedChecks: a golden's tests entry found through
 * the run and its ancestors). `--expect` judges the defaults. A golden's entry gives its own presets,
 * judged by its chaos.expect or its write limits; where it says `"chaos": false`, the defaults, as a
 * run asked for by name runs them anyway. A run no entry names runs the defaults, judged on the exit
 * alone. `chaosOf` reads the entry's `"chaos"` for the folder the checks came from.
 */
export function replayChaosSpec(checks: { spec: TestSpec; source: string } | null, chaosOf: (folder: string) => ChaosSpec | false): { chaos: ChaosSpec; golden: TestSpec | null } {
  if (checks?.source === '--expect') return { chaos: { ...DEFAULT_CHAOS, expect: checks.spec, expectFrom: '--expect' }, golden: null };
  const own = checks ? chaosOf(checks.source) : DEFAULT_CHAOS;
  return { chaos: own === false ? DEFAULT_CHAOS : own, golden: checks?.spec ?? null };
}

/**
 * The attempt that proves a recording's presets failed: in the first preset that failed, its first
 * attempt still kept that failed, else one kept that didn't pass, else its last kept; the next preset
 * that failed when none of its attempts is kept. Null when none failed. A run's page leads with it
 * (Open proof), and a presets job ends on it.
 */
export function presetProof<C extends { verdict: string; runs: ReadonlyArray<{ runId: string; verdict: string }> }>(cells: readonly C[], kept: (runId: string) => boolean): { cell: C; attempt: C['runs'][number] } | null {
  for (const cell of cells) {
    if (cell.verdict !== 'failed') continue;
    const runs = cell.runs.filter((x) => kept(x.runId));
    const attempt = runs.find((x) => x.verdict === 'failed') ?? runs.find((x) => x.verdict !== 'passed') ?? runs.at(-1);
    if (attempt) return { cell, attempt };
  }
  return null;
}
