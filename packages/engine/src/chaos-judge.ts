import type { TestSpec } from './checks/grammar.js';
import { checkLabels } from './checks/labels.js';
import { DEFAULT_CHAOS, type ChaosSpec } from './checks/tests-entry.js';
import type { EffectOf } from './decisions.js';
import { describeGate, rateBound, tallyInterval, type GateDecision, type Tally } from './stats.js';
import type { CallRecord } from './types.js';

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

/** The gate a preset's attempts were decided by, as a result keeps it: a sequential gate's figures, or a fixed count. */
export type PresetGate = { good: number; bad: number; risk: number; max: number } | { repeat: number; passes: number };

/** A kept result's gate, read back from its JSON: null for one that keeps none it can read. */
export function keptGate(g: unknown): PresetGate | null {
  if (!g || typeof g !== 'object') return null;
  const o = g as Record<string, unknown>;
  const num = (k: string) => typeof o[k] === 'number' && Number.isFinite(o[k]);
  if (num('good') && num('bad') && num('risk') && num('max')) return { good: o.good as number, bad: o.bad as number, risk: o.risk as number, max: o.max as number };
  return num('repeat') && num('passes') ? { repeat: o.repeat as number, passes: o.passes as number } : null;
}

/** A preset's gate in words: a sequential gate's rule, or `2 of 3 attempts must pass`. */
export function gateWords(g: PresetGate): string {
  if ('good' in g) return describeGate({ kind: 'sprt', good: g.good, bad: g.bad, risk: g.risk, max: g.max });
  return `${g.passes} of ${g.repeat} attempt${g.repeat === 1 ? '' : 's'} must pass`;
}

/**
 * The rule a sequential gate (`chaos.gate`) decided a preset by, as a report states it beside the
 * tally; null when no gate decided it: no attempt ran, the golden's own repeat and passes decided (its
 * tally says the count), or it is inconclusive for a reason of its own (the replay never reached the
 * call, a check no attempt could decide), which only a gate that ran out of attempts leaves unsaid.
 */
export function presetRule(o: { attempts: number; gate: PresetGate; verdict: string; reason: string | null }): string | null {
  if (o.attempts === 0 || !('good' in o.gate) || (o.verdict === 'inconclusive' && o.reason !== null)) return null;
  return `gate: ${gateWords(o.gate)}`;
}

/** The rule a recording's presets were decided by, stated once under them; null as presetRule says. */
export function recordingRule(outcomes: ReadonlyArray<Parameters<typeof presetRule>[0]>): string | null {
  for (const o of outcomes) {
    const rule = presetRule(o);
    if (rule) return rule;
  }
  return null;
}

/**
 * A preset's bound beside its tally, under a sequential gate: exact under its stopping (stats.ts),
 * with the attempts the provider cut short counted against either verdict. Null under a fixed count,
 * or for fewer than two attempts, which no tally shows.
 */
export function presetBound(gate: PresetGate, tally: Tally, decision: GateDecision, cutShort = 0): string | null {
  if (!('good' in gate) || tally.attempts < 2) return null;
  const interval = tallyInterval({ kind: 'sprt', good: gate.good, bad: gate.bad, risk: gate.risk, max: gate.max }, tally, decision, null, cutShort);
  return rateBound({ attempts: tally.attempts, interval, decision });
}

/**
 * A kept result's bound, as the CLI printed it beside its tally: none where presetRule states no
 * rule. Its attempts are then the ones the gate counted, and its verdict the gate's decision.
 */
export function keptPresetBound(o: Parameters<typeof presetRule>[0] & { passes: number; cutShort?: number | undefined }): string | null {
  if (!presetRule(o)) return null;
  const decision: GateDecision = o.verdict === 'passed' ? 'pass' : o.verdict === 'failed' ? 'fail' : 'inconclusive';
  return presetBound(o.gate, { passes: o.passes, attempts: o.attempts }, decision, o.cutShort ?? 0);
}

/**
 * The gate a recording's presets are decided by, as a result keeps it: `chaos.gate` (a gate of
 * another kind runs its least attempts, all to pass), else the golden's own repeat and passes, one
 * attempt for a run no golden judges. The CLI decides by it, and the dashboard's dialog and its
 * estimate read it.
 */
export function presetsGate(chaos: Pick<ChaosSpec, 'gate'>, golden: Pick<TestSpec, 'repeat' | 'passes'> | null): PresetGate {
  const g = chaos.gate;
  if (g) return g.kind === 'sprt' ? { good: g.good, bad: g.bad, risk: g.risk, max: g.max } : { repeat: g.min, passes: g.min };
  return { repeat: golden?.repeat ?? 1, passes: golden?.passes ?? golden?.repeat ?? 1 };
}

/**
 * What Run error-path presets… puts in its `--expect` field for a run judged by its own checks (its
 * `--expect`): the upper bound its failed check set on a write, `{"tools":{"<tool>":"<= <max>"}}`,
 * the first write limit (writeLimits' rule) whose tool the run called more times than it allows.
 * Null when no such check failed: a bound on a write that held asks nothing of an error path that the
 * run didn't already do. A bound on some calls of a tool (one with `args`) is left out.
 */
export function expectPrefill(own: TestSpec | null, calls: ReadonlyArray<Pick<CallRecord, 'kind' | 'name'>>, effectOf: EffectOf): string | null {
  for (const t of writeLimits(own, effectOf)?.tools ?? []) {
    if (t.args) continue;
    const n = calls.filter((c) => c.kind === 'tool' && c.name === t.name).length;
    if (n > t.count.max) return JSON.stringify({ tools: { [t.name]: `<= ${t.count.max}` } });
  }
  return null;
}
