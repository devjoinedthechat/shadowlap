import { agentCallsOf, estimateCost, formatUsd, gateHistory, planSuite, recentAttempts, riskPercent, RECORD_WINDOWS, type Gate, type Price, type RunRecord, type Store, type StoreOf, type SuiteGolden, type SuitePlan, type Tally } from '@shadowlap/engine';
import { oracleLabels } from './oracle.js';
import { suiteRed } from './test-report.js';
import { specFor, type TestEntry, type TestSpec } from './checks.js';
import { importGolden } from './golden-test.js';
import { goldenName } from './goldens.js';

/**
 * A test session's one risk, split across its gated goldens before any of them runs (suite.ts in
 * the engine): each golden's gate as it runs this session, and the forecast of what the session costs.
 */

/** How many of a golden's last results its forecast reads: its recent pass rate and cost per attempt. */
const RECENT = 10;

export interface SessionPlan {
  plan: SuitePlan;
  /** Each gated golden's gate as it runs this session, by its name in the test history. */
  gates: Map<string, Gate>;
  /**
   * The goldens gated against history whose inconclusive only warns this session, by name: with no
   * `--inconclusive` given, one whose record holds fewer sessions than it reads (30 by default) is
   * too new to tell a drop from chance by its gate's own limit. How many it has, and of how many.
   */
  short: Map<string, { sessions: number; of: number }>;
  /** Of those, the ones whose inconclusive counts all the same, by name: their last sessions sit below the sessions before them (`PlannedGolden.counts`). */
  counts: Map<string, string>;
}

/** The cost of an attempt of a recording that forks: at most what the whole recording's model calls cost. Null with a model that has no price. */
function recordingCost(store: StoreOf<'recording'>, run: RunRecord, prices: Record<string, Price> | undefined): number | null {
  let total = 0;
  for (const c of agentCallsOf(store.getCalls(run.runId))) {
    if (c.kind !== 'api' || !c.end) continue;
    const cost = estimateCost((c.end.meta.model ?? c.meta.model), c.end.meta.usage, prices);
    if (cost === null) return null;
    total += cost;
  }
  return total;
}

/**
 * The plan for the packs a session tests: every pack whose tests entry has a gate takes its share of
 * `risk`. A gate against history is sized against its baseline for the agent its last sessions show,
 * every attempt of them, those that went red included. Its forecast reads each golden's recent
 * results for its pass rate and cost per attempt, else its gate's `good` rate (a gate against
 * history: its sessions') and the cost of its recording. A pack that can't be read is left to fail on
 * its own when it runs. Null with no gated golden.
 */
export function planSession(packs: readonly string[], o: { store: Store; tests: TestEntry[]; projectDir: string; prices?: Record<string, Price> | undefined; baselineBranch?: string | null | undefined; risk: number; inconclusive: 'fail' | 'warn' | null; maxAttempts?: number | undefined }): SessionPlan | null {
  const goldens: SuiteGolden[] = [];
  const short = new Map<string, { sessions: number; of: number }>();
  for (const dir of packs) {
    const spec: TestSpec | null = specFor(o.tests, dir, o.projectDir);
    if (!spec?.gate) continue;
    const golden = goldenName(dir, o.projectDir);
    let parent: RunRecord;
    try {
      parent = importGolden(o.store, dir);
    } catch {
      continue;
    }
    const checks = oracleLabels(spec).slice(1);
    const filter = spec.gate.kind === 'baseline' ? { window: spec.gate.window, goldenRunId: parent.runId, checks, mode: 'fork' as const, ...(o.baselineBranch !== undefined ? { branch: o.baselineBranch } : {}) } : null;
    const history = filter && spec.gate.kind === 'baseline' ? gateHistory(o.store, golden, { ...filter, first: spec.gate.min }) : null;
    // What the same sessions show of the agent, every attempt of those that went red too, which a baseline
    // that came out lucky leaves out: its last window of them, and its last RECORD_WINDOWS windows.
    const record = filter && spec.gate.kind === 'baseline' ? gateHistory(o.store, golden, { ...filter, window: RECORD_WINDOWS * spec.gate.window, verdicts: 'any' }) : null;
    const sum = (xs: readonly Tally[]): Tally => ({ passes: xs.reduce((n, x) => n + x.passes, 0), attempts: xs.reduce((n, x) => n + x.attempts, 0) });
    const sessions = record && spec.gate.kind === 'baseline' ? sum(record.pooled.slice(0, spec.gate.window)) : null;
    const recent = recentAttempts(o.store, golden, { window: RECENT, goldenRunId: parent.runId, checks });
    // Too few sessions for its record: with no --inconclusive given, its inconclusive only warns.
    if (spec.gate.kind === 'baseline' && o.inconclusive === null && (record?.pooled.length ?? 0) < RECORD_WINDOWS * spec.gate.window) short.set(golden, { sessions: record?.pooled.length ?? 0, of: RECORD_WINDOWS * spec.gate.window });
    goldens.push({
      golden,
      gate: spec.gate,
      maxGiven: !!spec.gateMaxGiven,
      ...(short.has(golden) ? { inconclusive: 'warn' as const } : {}),
      ...(history?.attempts ? { history: { passes: history.passes, attempts: history.attempts } } : {}),
      ...(sessions?.attempts ? { sessions } : {}),
      ...(record?.attempts ? { record: { passes: record.passes, attempts: record.attempts, sessions: record.pooled.length } } : {}),
      rate: recent ? recent.passes / recent.attempts : null,
      costPerAttempt: recent?.costPerAttempt ?? recordingCost(o.store, parent, o.prices),
    });
  }
  const plan = planSuite(goldens, { risk: o.risk, inconclusive: o.inconclusive ?? 'fail' });
  if (!plan) return null;
  // --max-attempts raises every gate's limit past what the session sized.
  if (o.maxAttempts) for (const p of plan.planned) p.most = Math.max(p.most, o.maxAttempts);
  plan.forecast.most = plan.planned.reduce((n, p) => n + p.most, 0);
  return { plan, gates: new Map(plan.planned.map((p) => [p.golden, p.gate])), short, counts: new Map(plan.planned.flatMap((p) => (p.counts ? [[p.golden, p.counts] as const] : []))) };
}

const count = (n: number) => Math.round(n).toLocaleString('en-US');
const plural = (n: number, noun: string) => `${count(n)} ${noun}${Math.round(n) === 1 ? '' : 's'}`;

/**
 * What the session says before it runs: the forecast, and with more than one gated golden, how the
 * risk is split. `forecast: about 1,675 attempts (16.7 a golden on average), up to 17,900 · about
 * $41.87` and `suite risk 5%: 100 gated goldens, 0.05% each, so a healthy suite goes red for nothing
 * in 5% of runs or fewer, with the provider answering`. When the goldens' chances together go past
 * the suite's risk, the line says what the plan works out instead (`suiteRed`), and each golden that
 * can't keep within its share, or has too few sessions yet to, says why: one over its own share
 * whose suite keeps within its risk takes room the others leave, and isn't named. A gate against
 * history whose last sessions sit below the sessions before them beyond chance is always named.
 */
export function suiteLines(plan: SuitePlan): string[] {
  const f = plan.forecast;
  const each = plan.goldens > 1 ? ` (${+(f.attempts / plan.goldens).toFixed(1)} a golden on average)` : '';
  const cost = f.cost === null ? 'cost unknown: no price for their models' : `about ${formatUsd(f.cost)}${f.unpriced ? `, ${f.unpriced} without a price` : ''}`;
  const lines = [`forecast: about ${plural(f.attempts, 'attempt')}${each}, up to ${count(f.most)} · ${cost}`];
  if (plan.goldens > 1) {
    const red = plan.inconclusive === 'fail' ? 'goes red for nothing' : 'fails a golden for nothing';
    lines.push(`suite risk ${riskPercent(plan.risk)}: ${plan.goldens} gated goldens, ${riskPercent(plan.perGoldenRisk)} each, ${suiteRed(suiteCounts(plan), red)}`);
  }
  const over = plan.red > plan.risk;
  for (const p of plan.planned) {
    const why = p.drop ?? (over ? (p.over ?? p.early) : undefined);
    if (why) lines.push(`${p.golden}: ${why}`);
  }
  return lines;
}

/**
 * The plan's figures as its suite line reads them: how many goldens can't keep within their share,
 * how many have too few sessions yet to, and whether its chance is averaged over the pass rates a
 * golden's sessions leave open (a gate against history's), or exact at each gate's good rate.
 */
function suiteCounts(plan: SuitePlan): { risk: number; red: number; over: number; early: number; averaged: boolean } {
  return { risk: plan.risk, red: plan.red, over: plan.planned.filter((p) => p.over).length, early: plan.planned.filter((p) => p.early).length, averaged: plan.planned.some((p) => p.gate.kind === 'baseline') };
}

/**
 * The plan as `--json` reports it, under `suite`: with `over`, the goldens whose share could not be
 * met, `early`, those with too few sessions yet, and `drop`, those whose last sessions sit below
 * the sessions before them beyond chance, when there are any; `averaged`, when gates against history
 * make its `red` an average over the pass rates their sessions leave open rather than a bound; and
 * `short`, the gates against history whose inconclusive only warns, their history short.
 */
export function suiteJson(plan: SuitePlan): { risk: number; perGoldenRisk: number; method: 'bonferroni'; goldens: number; inconclusive: 'fail' | 'warn'; red: number; forecast: SuitePlan['forecast']; over?: number; early?: number; drop?: number; averaged?: true; short?: number } {
  const { over, early, averaged } = suiteCounts(plan);
  const drop = plan.planned.filter((p) => p.drop).length;
  const short = plan.planned.filter((p) => p.inconclusive === 'warn').length;
  return { risk: plan.risk, perGoldenRisk: plan.perGoldenRisk, method: plan.method, goldens: plan.goldens, inconclusive: plan.inconclusive, red: plan.red, forecast: plan.forecast, ...(over ? { over } : {}), ...(early ? { early } : {}), ...(drop ? { drop } : {}), ...(averaged ? { averaged: true as const } : {}), ...(short ? { short } : {}) };
}
