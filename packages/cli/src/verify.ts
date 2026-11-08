import { addPair, afterForkOf, attemptsToPass, BASELINE_DEFAULTS, baselineSaysNothing, messageOf, unavailableStop, decideAgainstHistoryAround, decidePairedAround, decideVerify, dropEndsRisk, footprintOf, gateHistory, gateResult, gateVerdict, historyDrop, KEPT_DEFAULTS, keptMaxOf, keptVerdict, NO_PAIRS, outcomeOf, pairedDrop, pairsOf, recordingsOfRun, runVerdict, sameModel, SPRT_DEFAULTS, verifyTally, verifyTallyLine, type BaselineRule, type GateHistory, type Palette, type PairCounts, type SprtGate, type StoreOf, type VerifiedRun, type VerifyAttempt, type VerifyReport, type VerifyRole, providerRefused, type BaselineDecision } from '@shadowlap/engine';
import { type Interventions } from '@shadowlap/sidecar';
import { AttemptRunner, formatBudget, type Attempt, type AttemptSettings, type AttemptTarget } from './attempts.js';
import { describeAttempt } from './blame.js';
import { codeVersion } from './config.js';
import { goldenName } from './goldens.js';
import { type GlobalOpts } from './shared.js';
import { palette as p, shortId } from './ui.js';
import { BaseCheckout, resolveBase, type BaseSpec } from './verify-base.js';

/**
 * `shadowlap verify`: the gate a change passes before it ships. `decideVerify` in @shadowlap/engine says
 * what it accepts. Every run is replayed under the code as it is now, so a change is tested as it will
 * ship: a changed prompt forks at the first model call and runs live, and a harness fix that changes
 * no request replays in full, for free.
 *
 * A target or held-out run is fixed when it passes its gate. A good run that forks is kept when it is
 * not worse than its own baseline by the margin or more (engine noninferiority.ts): by default the
 * same run under the code before the change, each attempt of the change paired with one of the
 * baseline's run straight after it, so whatever drifts over the run (the provider, its load) moves
 * both arms alike; or, with `--baseline history`, its golden's test history.
 */

/**
 * What good runs are kept against: a paired baseline at a base, the golden's history, or nothing
 * (each good run then judged by the gate on its own), with why. A paired base with `open` is checked
 * out by the caller (`baseCheckout`), not by verify.
 */
export type VerifyBaseline = { source: 'paired'; base: BaseSpec; open?: () => BaseCheckout } | { source: 'history' } | { source: 'none'; why: string };

export interface VerifySettings extends AttemptSettings {
  /** A fixed count: attempts per run, and how many must pass. Used when `gate` is null. */
  attempts: number;
  needed: number;
  /** The gate that decides each run after every attempt (stats.ts); null for the fixed count, which judges every run on its own. */
  gate: SprtGate | null;
  /** Runs verified at once; a run's own attempts go one after another, or a pair at a time. */
  concurrency: number;
  /** Request fields the change sets from each run's first model call (`--model`, `--set`). */
  fields: Record<string, unknown>;
  /** `--from`: the fields change only at model calls made with one of these models, from the first of them on. */
  fromModels?: string[];
  /** Start nothing new once any run has failed. */
  failFast: boolean;
  /**
   * What good runs are kept against. Absent: the config's `verify.baseline`, else paired, on
   * `baseCheckout` when given, else at the base `resolveBase` finds for the working tree (HEAD when it
   * has a change).
   */
  baseline?: VerifyBaseline;
  /** The drop from its baseline that breaks a good run: absent, the config's `verify.margin`, else 0.1. */
  margin?: number;
  /** The most pairs (or attempts, against history) a good run takes: absent, the config's `verify.max`, else 200. */
  keptMax?: number;
  /**
   * The code without the change, for a caller that verifies the change somewhere else than the
   * working tree: `shadowlap repair` verifies each candidate in a worktree of its own (`cwd`), and a
   * good run's paired baseline runs the code without the candidate, in another one. `open` checks it
   * out the first time a good run forks, and its `argv` points a run's command, as verify was given
   * it, there; verify removes it when done. Absent, the base is a commit of `cwd`'s repository, or
   * `cwd` itself for a change that is only request fields (`resolveBase`).
   */
  baseCheckout?: { label: string; open: () => BaseCheckout };
}

export interface VerifyInput {
  opts: GlobalOpts;
  runs: Array<AttemptTarget & { role: VerifyRole }>;
  settings: VerifySettings;
  log: (line: string) => void;
}

const ROLE: Record<VerifyRole, string> = { target: 'target', holdout: 'held-out', good: 'good' };

/** A good run's golden, as `shadowlap test` names it in its history: the one it was replayed from, or the pack it came from. */
function goldenOf(store: StoreOf<'recording'>, run: AttemptTarget['parent'], cwd: string): string | null {
  const dir = recordingsOfRun(store, run)[0];
  return dir ? goldenName(dir, cwd) : null;
}

/** An attempt as the report keeps it. */
function kept(a: Attempt, costOf: AttemptRunner['costOf']): VerifyAttempt {
  const forkedAt = a.summary.divergence?.callNo ?? null;
  const afterFork = afterForkOf(a.calls, forkedAt);
  return {
    runId: a.run.runId,
    passed: a.passed,
    verdict: a.verdict,
    ...(a.cutShort ? { cutShort: true as const } : a.unavailable ? { unavailable: true } : {}),
    exitCode: a.code,
    failures: a.failures,
    forkedAt,
    spent: a.summary.cost.spent,
    upstreamRequests: a.summary.upstreamRequests,
    footprint: footprintOf(a.calls, costOf),
    unrecordedTools: a.unrecorded,
    ...(afterFork ? { afterFork } : {}),
  };
}

/**
 * Why an attempt says nothing of the change's effect: it could not be judged, or (for the baseline) it
 * never reached its model through Shadowlap. Null when it does, and for one the provider cut short,
 * which is counted against either verdict.
 */
function unjudged(a: Attempt): string | null {
  if (a.cutShort) return null;
  if (a.verdict === 'inconclusive') return a.failures[0] ?? 'a check could not be decided';
  if (a.verdict !== 'passed' && a.verdict !== 'failed') return a.failures[0] ?? `the attempt came out ${String(a.verdict)}`;
  return null;
}

/**
 * What an attempt of the baseline can't say of the change beside it, and why, or null when it counts. No
 * verdict may rest on one that never reached its model through Shadowlap, which ran nothing the
 * recording holds. With `none`, the provider turned its model away for good, as it does once a model
 * retires: nothing this arm can show says what the change did, and its failing is no failure to keep
 * up with. `where` says where the baseline ran, in words.
 */
function baselineOpen(b: Attempt, n: number, where: string): { none: boolean; why: string } | null {
  if (b.bypassed) return { none: false, why: `the baseline${where} could not run the agent: ${b.failures[0] ?? 'it made no model calls through Shadowlap'}` };
  const refused = !b.passed && !b.unavailable ? providerRefused(b.calls) : null;
  if (refused) return { none: true, why: `the baseline could not ask its model: ${refused}` };
  const why = unjudged(b);
  if (!why) return null;
  return { none: false, why: b.unavailable ? why : `the baseline's attempt ${n} could not be judged: ${why}` };
}

/** Why a run kept against its baseline is kept on nothing, or null: the baseline passes too rarely to drop from. */
function hollowKept(decision: BaselineDecision, answered: PairCounts, rule: BaselineRule): string | null {
  const baseline = { passes: answered.basePasses, attempts: pairsOf(answered) };
  return decision === 'kept' && baselineSaysNothing(baseline, rule) ? `the baseline passed only ${baseline.passes} of ${baseline.attempts}, which no run can drop from` : null;
}

/**
 * The baseline says nothing after all: it can't ask its model, or passes too rarely to keep a run to.
 * The change's attempts so far stand, and its gate decides the run on its own.
 */
function withoutBaseline(result: VerifiedRun, why: string): false {
  result.noBaseline = why;
  for (const k of ['baseline', 'margin', 'drop', 'decision'] as const) delete result[k];
  result.verdict = 'open';
  return false;
}

/**
 * A run's line once verify is done with it, after its label: its outcome, then its tally as verify's
 * report says it (engine `verifyTally`): `fixed · 12 of 12 passed · rate >= 0.76 (95%)`, `kept · 38
 * of 38 passed, baseline 38 of 38 · drop <= 0.10 (95%)`. The rule was said once, above. A clean
 * replay, a fixed count and a gate that decided nothing give the outcome alone, as does a run an
 * attempt it could not judge stopped: its attempt's line says why.
 */
export function settledLine(r: VerifiedRun, palette: Palette = p): string {
  if (!r.attempts.length) return palette.yellow('not started');
  const o = outcomeOf(r);
  const word = o === 'fixed' || o === 'kept' ? palette.green(o) : o === 'unsettled' || o === 'inconclusive' ? palette.yellow(o) : palette.red(o);
  const said = !r.undecided && (r.baseline || (r.gate && !r.deterministic && r.decision !== 'continue'));
  return said ? `${word}${palette.dim(` · ${verifyTallyLine(verifyTally(r))}`)}` : word;
}

export async function runVerify(input: VerifyInput): Promise<VerifyReport> {
  const { settings: s, log } = input;
  const runner = await AttemptRunner.start(input.opts, s);
  const { store } = runner;
  const cwd = s.cwd ?? process.cwd();
  // How good runs are kept: against their own baseline, with the gate's risk. A fixed count judges
  // every run on its own, as it did before baselines.
  const config = runner.config.verify ?? {};
  // The most pairs a good run takes: --kept-max, verify.max, a gate's max other than its default
  // (--gate '{"max":20}': no run takes more than 20 attempts an arm), else the baseline test's own.
  // An estimate reads it by the same rule (keptMaxOf), so what it prices is what runs.
  const rule: BaselineRule = { margin: s.margin ?? config.margin ?? KEPT_DEFAULTS.margin, risk: s.gate?.risk ?? SPRT_DEFAULTS.risk, max: keptMaxOf(s.keptMax ?? config.max, s.gate) };
  const anyGood = input.runs.some((r) => r.role === 'good');
  const baseline: VerifyBaseline = !s.gate
    ? { source: 'none', why: 'a fixed count (--attempts, --passes) judges every run on its own' }
    : (s.baseline ??
      (!anyGood
        ? { source: 'none', why: '' }
        : (config.baseline ?? 'paired') === 'history'
          ? { source: 'history' }
          : s.baseCheckout
            ? { source: 'paired', base: { revision: null, label: s.baseCheckout.label, build: null }, open: s.baseCheckout.open }
            : (() => {
                const found = resolveBase(cwd, { fields: Object.keys(s.fields).length > 0 });
                return 'base' in found ? { source: 'paired' as const, base: found.base } : { source: 'none' as const, why: found.none };
              })()));

  // The baseline's arm, opened for the first good run that forks: the base checked out, its own runner.
  // Assigned in openArm, which the runs call: declared so its type isn't narrowed to its first value.
  let arm = null as { runner: AttemptRunner; checkout: BaseCheckout } | { why: string } | null;
  const openArm = async (): Promise<{ runner: AttemptRunner; checkout: BaseCheckout } | { why: string }> => {
    if (arm) return arm;
    if (baseline.source !== 'paired') return (arm = { why: 'no paired baseline' });
    let checkout: BaseCheckout;
    try {
      checkout = baseline.open ? baseline.open() : BaseCheckout.open(baseline.base, cwd, process.cwd());
    } catch (err) {
      return (arm = { why: messageOf(err) });
    }
    try {
      // The same settings, in the base's checkout; the budget is counted over both arms, here.
      const baseRunner = await AttemptRunner.start(input.opts, { ...s, budget: null, cwd: checkout.cwd }, { store });
      if (baseline.base.revision) log(p.dim(`  baseline: the same runs at ${baseline.base.label}, checked out on its own`));
      else if (baseline.open) log(p.dim(`  baseline: the same runs on ${baseline.base.label}, checked out on its own`));
      return (arm = { runner: baseRunner, checkout });
    } catch (err) {
      checkout.close();
      return (arm = { why: messageOf(err) });
    }
  };
  const baseRunner = () => (arm && 'runner' in arm ? arm.runner : null);
  const spentBoth = () => runner.spent + runner.judgeSpent + (baseRunner()?.spent ?? 0) + (baseRunner()?.judgeSpent ?? 0);
  /** Whether another attempt (or pair) may start: nothing interrupted, and budget left over both arms. */
  const canStart = (): boolean => {
    if (!runner.canStart()) return false;
    if (baseRunner()?.interrupted) {
      runner.stopReason ??= 'interrupted';
      return false;
    }
    // The provider stayed unavailable for the baseline's arm: it is the change's provider too.
    const down = baseRunner()?.stopReason;
    if (unavailableStop(down)) {
      runner.stopReason ??= down!;
      return false;
    }
    if (s.budget !== null && spentBoth() >= s.budget) {
      runner.stopReason ??= `the budget of ${formatBudget(s.budget)} is spent`;
      return false;
    }
    return true;
  };
  const interrupted = () => runner.interrupted || !!baseRunner()?.interrupted;

  try {
    const group = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const results = new Array<VerifiedRun>(input.runs.length);
    let failed = false;

    const verifyOne = async (i: number): Promise<void> => {
      const { role, ...target } = input.runs[i]!;
      const { parent } = target;
      const parentCalls = store.getCalls(parent.runId);
      const recorded = { ...runner.judgeRecorded(parent, parentCalls), footprint: footprintOf(parentCalls, runner.costOf) };
      // With --from, the first model call made with one of those models: a call before it is another model's.
      const from = s.fromModels?.length ? s.fromModels : null;
      const firstModelCall = parentCalls.find((c) => c.kind === 'api' && (!from || from.some((m) => sameModel((c.end?.meta.model ?? c.meta.model), m))))?.callNo;
      const interventions: Interventions | undefined = Object.keys(s.fields).length && firstModelCall !== undefined ? { set: { fromCall: firstModelCall, fields: s.fields, ...(from ? { models: from } : {}) } } : undefined;
      const result: VerifiedRun = { runId: parent.runId, role, attempts: [], passes: 0, deterministic: false, verdict: 'open', recorded };
      results[i] = result;
      const label = `${ROLE[role].padEnd(8)}  ${shortId(parent.runId)}`;
      // A gate decides after each attempt, up to its max; a fixed count runs until it is settled; a good
      // run against its baseline, up to the baseline test's.
      const limit = s.gate ? s.gate.max : s.attempts;
      const of = role === 'good' && baseline.source !== 'none' ? Math.max(limit, rule.max) : limit;

      /**
       * Attempts the provider was unavailable for, the change's and the baseline's: the runner retried
       * each and never counted it; the one it returns after too many in a row is unavailable itself.
       * One it cut short after the model answered is counted, against either verdict, apart.
       */
      const countUnavailable = (a: Attempt) => {
        const n = (a.unavailableBefore ?? 0) + (a.unavailable && !a.cutShort ? 1 : 0);
        if (n) result.unavailable = (result.unavailable ?? 0) + n;
        if (a.cutShort) result.cutShort = (result.cutShort ?? 0) + 1;
      };
      // Under a gate, an attempt the provider cut short after the model answered is counted against either verdict; a fixed count runs it again.
      // A gate and a fixed count alike count an attempt cut short after the model answered, against either verdict.
      const late = 'count' as const;
      /** The change's attempts the gate counted, and which of them the provider cut short. */
      const counted = () => {
        const judged = result.attempts.filter((x) => x.verdict !== 'inconclusive' || x.cutShort);
        return { outcomes: judged.map((x) => x.passed), unavailableAt: judged.flatMap((x, i) => (x.cutShort ? [i] : [])) };
      };

      /** One attempt of the change, kept in the run's report. */
      const changed = async (n: number): Promise<Attempt | null> => {
        const marks = { repeat: { group: `${group}-${parent.runId}`, attempt: n, of }, verify: { role, passed: false } };
        const a = await runner.attempt(target, { ...(interventions ? { interventions } : {}), meta: marks }, true, { late });
        // Stopped by Ctrl-C part way: what it did is no evidence either way.
        if (interrupted()) return null;
        countUnavailable(a);
        if (n === 1) result.deterministic = !a.summary.divergence && !a.bypassed && !a.unavailable;
        if (a.passed) result.passes++;
        result.attempts.push(kept(a, runner.costOf));
        store.updateRunMeta(a.run.runId, { verify: { role, passed: a.passed, verdict: a.unavailable ? 'unavailable' : a.verdict }, ...(a.checks.length ? { checks: a.checks } : {}) });
        return a;
      };

      // The change's attempts, decided by the gate (or the fixed count) on their own: on those already
      // run first (a clean replay settles the run there), then one at a time until it settles.
      const byGate = async (): Promise<void> => {
        const settle = () => {
          if (s.gate) Object.assign(result, gateVerdict(result.passes, result.attempts.length, s.gate, result.deterministic, result.cutShort ?? 0));
          else result.verdict = runVerdict(result.passes, result.attempts.length, s.attempts, s.needed, result.deterministic, result.cutShort ?? 0);
        };
        if (result.attempts.length) settle();
        // A gate's max counts the attempts the provider didn't cut short (decideUnavailable), up to twice it in all.
        const room = () => (s.gate ? result.attempts.length - (result.cutShort ?? 0) < limit && result.attempts.length < 2 * limit : result.attempts.length < limit);
        while (result.verdict === 'open' && result.decision !== 'inconclusive' && room() && !(s.failFast && failed) && canStart()) {
          const n = result.attempts.length + 1;
          const a = await changed(n);
          if (!a) break;
          log(`  ${label}  ${p.dim(`attempt ${n}`)}  ${describeAttempt(a)}`);
          // A check no attempt can decide here (a judge that could not answer, a condition it can't
          // read) says nothing of the change, and the next attempt wouldn't either: the run stops,
          // inconclusive, with why. It never counts as a failure, nor as a pass.
          const why = unjudged(a);
          if (why) {
            result.undecided = why;
            break;
          }
          settle();
        }
      };

      /**
       * A good run that forked, against the same run at the base revision: from the change's first
       * attempt on, each paired with an attempt of the baseline forced live at the same call, run
       * straight after it, until the paired test decides.
       */
      const againstPaired = async (first: Attempt): Promise<boolean> => {
        const opened = await openArm();
        if ('why' in opened) {
          result.noBaseline = `the baseline could not run: ${opened.why}`;
          return false;
        }
        const base = baseline.source === 'paired' ? baseline.base : null;
        // The commit the baseline runs at, as reports name it: null for code that is no commit.
        const at = base?.revision ? base.label : null;
        // Where the change forked, as the recording numbers it: the baseline is forced live there, so
        // both arms sample the run from the same call on.
        const d = first.summary.divergence!;
        const forkAt = d.counterpart?.callNo ?? d.callNo;
        const baseTarget: AttemptTarget = { ...target, argv: opened.checkout.argv(target.argv) };
        const baseRuns: VerifyAttempt[] = [];
        result.baselineRuns = baseRuns;
        const baseAttempt = async (n: number): Promise<Attempt | null> => {
          const marks = { repeat: { group: `${group}-${parent.runId}-baseline`, attempt: n, of: rule.max }, verify: { role, passed: false, arm: 'baseline' as const, revision: at } };
          const b = await opened.runner.attempt(baseTarget, { divergeAt: forkAt, meta: marks }, true, { late: 'count' });
          if (interrupted()) return null;
          countUnavailable(b);
          baseRuns.push(kept(b, opened.runner.costOf));
          store.updateRunMeta(b.run.runId, { verify: { role, passed: b.passed, verdict: b.unavailable ? 'unavailable' : b.verdict, arm: 'baseline', revision: at }, ...(b.checks.length ? { checks: b.checks } : {}) });
          if (b.unavailable && !b.cutShort) runner.stopReason ??= opened.runner.stopReason ?? b.failures[0] ?? null;
          return b;
        };
        // Two tallies of the same pairs: an attempt the provider cut short counts against keeping in
        // the one (the change's as a failure, the baseline's as a pass) and against breaking in the
        // other, and kept must hold on the first, broken on the second (decidePairedAround). The pairs
        // both arms answered are tallied apart, for the report.
        let keeping: PairCounts = NO_PAIRS;
        let breaking: PairCounts = NO_PAIRS;
        let answered: PairCounts = NO_PAIRS;
        let changedNow: Attempt | null = first;
        for (let n = 1; ; n++) {
          // A pair: the change's attempt, then the baseline's, one after the other, as a run's attempts go.
          if (n > 1) {
            if (!canStart() || (s.failFast && failed)) break;
            changedNow = await changed(n);
            if (!changedNow) break;
          }
          // The provider stayed unavailable for the change's attempt: it says nothing, and neither would
          // a baseline attempt beside it (the provider is the same), so none runs.
          if (changedNow.unavailable && !changedNow.cutShort) {
            log(`  ${label}  ${p.dim(`attempt ${n}`)}  ${describeAttempt(changedNow)}`);
            result.undecided = unjudged(changedNow);
            break;
          }
          if (changedNow.cutShort) {
            // Cut short after the model answered: counted, with no baseline attempt beside it, a
            // failure against a pass toward keeping and a pass against a failure toward breaking.
            if (n > 1) log(`  ${label}  ${p.dim(`attempt ${n}`)}  ${describeAttempt(changedNow)}`);
            keeping = addPair(keeping, false, true);
            breaking = addPair(breaking, true, false);
          } else {
            const b = await baseAttempt(n);
            if (!b) break;
            if (n > 1) log(`  ${label}  ${p.dim(`attempt ${n}`)}  ${describeAttempt(changedNow)}`);
            log(`  ${label}  ${p.dim(`baseline ${n}`)}  ${describeAttempt(b)}`);
            const why = unjudged(changedNow);
            if (why) {
              result.undecided = why;
              break;
            }
            const open = baselineOpen(b, n, at ? ` at ${at}` : base ? ` on ${base.label}` : '');
            if (open?.none) return withoutBaseline(result, open.why);
            if (open) {
              result.undecided = open.why;
              break;
            }
            // The baseline's attempt cut short: a pass toward keeping, a failure toward breaking.
            keeping = addPair(keeping, changedNow.passed, b.cutShort ? true : b.passed);
            breaking = addPair(breaking, changedNow.passed, b.cutShort ? false : b.passed);
            if (!b.cutShort) answered = addPair(answered, changedNow.passed, b.passed);
          }
          const decision = decidePairedAround(keeping, breaking, rule);
          const hollow = hollowKept(decision, answered, rule);
          if (hollow) return withoutBaseline(result, hollow);
          Object.assign(result, keptVerdict(decision));
          result.baseline = { passes: answered.basePasses, attempts: baseRuns.filter((x) => !x.unavailable).length, source: 'paired', revision: at };
          result.margin = rule.margin;
          // Each end of the drop's interval from the tally against its own verdict: a verdict's end at the
          // whole risk, both ends of an undecided run at half each, so the two hold together.
          const ends = dropEndsRisk(decision, rule.risk);
          result.drop = { ...(pairsOf(keeping) === pairsOf(answered) ? pairedDrop(answered, ends) : { ...pairedDrop(keeping, ends), lo: pairedDrop(breaking, ends).lo }), confidence: 1 - rule.risk };
          if (decision !== 'continue') break;
        }
        // An attempt it could not judge stopped it: inconclusive, as no attempt after it would say more.
        if (result.undecided) Object.assign(result, { verdict: 'open', decision: 'inconclusive' });
        return true;
      };

      /** A good run that forked, against its golden's test history: only the change's arm runs. */
      const againstHistory = async (): Promise<boolean> => {
        // Named from the project's folder, as `shadowlap test` names it, wherever verify runs the change.
        const golden = goldenOf(store, parent, process.cwd());
        // Pooled as a gate against history pools it: under the same recording and checks, each session
        // by its first `min` attempts, the ones every session runs whatever they show.
        const history: GateHistory | null = golden ? gateHistory(store, golden, { window: BASELINE_DEFAULTS.window, first: BASELINE_DEFAULTS.min, goldenRunId: parent.runId, checks: runner.oracle().slice(1), mode: 'fork' }) : null;
        if (!golden || !history?.attempts) {
          result.noBaseline = golden ? `${golden} has no test history under these checks yet` : `${shortId(parent.runId)} is no golden's run, so it has no test history`;
          return false;
        }
        if (baselineSaysNothing(history, rule)) return withoutBaseline(result, `${golden}'s test history passed only ${history.passes} of ${history.attempts}, which no run can drop from`);
        result.baseline = { passes: history.passes, attempts: history.attempts, source: 'history' };
        result.margin = rule.margin;
        for (let n = result.attempts.length; ; n++) {
          if (n > result.attempts.length) {
            if (!canStart() || (s.failFast && failed)) break;
            const a = await changed(n);
            if (!a) break;
            log(`  ${label}  ${p.dim(`attempt ${n}`)}  ${describeAttempt(a)}`);
            const why = unjudged(a);
            if (why) {
              result.undecided = why;
              Object.assign(result, { verdict: 'open', decision: 'inconclusive' });
              break;
            }
          }
          const judged = { passes: result.passes, attempts: result.attempts.length };
          // Attempts the provider cut short are among them, against either verdict.
          const cut = result.cutShort ?? 0;
          const decision = decideAgainstHistoryAround(judged, cut, history, rule);
          Object.assign(result, keptVerdict(decision));
          const ends = dropEndsRisk(decision, rule.risk);
          result.drop = { ...(cut ? { ...historyDrop(judged, history, ends), lo: historyDrop({ passes: judged.passes + cut, attempts: judged.attempts }, history, ends).lo } : historyDrop(judged, history, ends)), confidence: 1 - rule.risk };
          if (decision !== 'continue') break;
        }
        return true;
      };

      // The first attempt: a replay that forks nowhere settles the run, whatever its role.
      const first = canStart() && !(s.failFast && failed) ? await changed(1) : null;
      if (first) {
        log(`  ${label}  ${p.dim('attempt 1')}  ${describeAttempt(first)}${result.deterministic ? p.dim(' · clean replay, so it settles the run') : ''}`);
        const why = unjudged(first);
        if (why) result.undecided = why;
        // A replay that went around Shadowlap ran nothing the recording holds: no evidence, and no
        // fork to pair a baseline with. Its gate fails the run, as it always has.
        else if (role === 'good' && !result.deterministic && first.summary.divergence && !first.bypassed && baseline.source !== 'none') {
          // A good run that forked: against its baseline, or, when none can be had, by the gate alone.
          const decided = baseline.source === 'paired' ? await againstPaired(first) : await againstHistory();
          if (!decided) await byGate();
        } else {
          if (role === 'good' && !result.deterministic && baseline.source === 'none' && baseline.why) result.noBaseline = baseline.why;
          await byGate();
        }
      }
      // What the gate made of the attempts it judged: the rate's interval and the risk it decided at.
      if (s.gate && result.attempts.length && !result.baseline) {
        const c = counted();
        result.gate = gateResult(s.gate, c.outcomes, { clean: result.deterministic && !result.undecided, decision: result.decision ?? 'continue', ...(result.unavailable ? { unavailable: result.unavailable } : {}), ...(c.unavailableAt.length ? { unavailableAt: c.unavailableAt } : {}) });
      }
      if (result.verdict === 'fail') failed = true;
      // The outcome, then the tally and its bound in the words of verify's report.
      log(`  ${label}  ${settledLine(result)}`);
    };

    let next = 0;
    const worker = async () => {
      while (next < input.runs.length) await verifyOne(next++);
    };
    await Promise.all(Array.from({ length: Math.min(s.concurrency, input.runs.length) }, worker));

    // A run that never started (interrupted, out of budget, --fail-fast) is still in the report, unsettled.
    const runs = results;
    const stopReason = s.failFast && failed && !runner.stopReason ? 'a run failed (--fail-fast)' : runner.stopReason;
    const both = baseRunner();
    const keptAgainst = runs.some((r) => r.baseline);
    return {
      ...decideVerify(runs, stopReason),
      runs,
      attemptsPerRun: s.gate ? s.gate.max : s.attempts,
      needed: s.gate ? attemptsToPass(s.gate) : s.needed,
      gate: s.gate,
      oracle: runner.oracle(),
      fields: s.fields,
      codeVersion: codeVersion(cwd),
      // Both arms: the baseline's attempts are what verifying cost too.
      attempts: runner.attempts + (both?.attempts ?? 0),
      ...(runner.unavailable + (both?.unavailable ?? 0) ? { unavailable: runner.unavailable + (both?.unavailable ?? 0) } : {}),
      ...(runner.cutShort + (both?.cutShort ?? 0) ? { cutShort: runner.cutShort + (both?.cutShort ?? 0) } : {}),
      spent: runner.spent + (both?.spent ?? 0),
      upstreamRequests: runner.upstreamRequests + (both?.upstreamRequests ?? 0),
      // Judge checks' calls, apart from the agent's.
      ...(runner.judgeRequests || runner.judgeSpent || both?.judgeRequests || both?.judgeSpent ? { judge: { spent: runner.judgeSpent + (both?.judgeSpent ?? 0), upstreamRequests: runner.judgeRequests + (both?.judgeRequests ?? 0) } } : {}),
      unknownModels: [...new Set([...runner.unknownModels, ...(both?.unknownModels ?? [])])],
      stopReason,
      replayWarnings: [...new Set([...runner.warnings, ...(both?.warnings ?? [])])],
      kept: keptAgainst ? { ...rule, source: baseline.source === 'history' ? 'history' : 'paired', revision: baseline.source === 'paired' ? baseline.base.revision : null, label: baseline.source === 'paired' && baseline.base.revision ? baseline.base.label : null } : null,
    };
  } finally {
    const opened = arm && 'runner' in arm ? arm : null;
    try {
      await opened?.runner.close();
    } finally {
      opened?.checkout.close();
      await runner.close();
    }
  }
}
