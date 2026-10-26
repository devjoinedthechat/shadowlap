import { agentCallsOf, estimateCost, formatUsd, gateHistory, planSuite, recentAttempts, riskPercent, type Gate, type Price, type RunRecord, type Store, type SuiteGolden, type SuitePlan } from '@shadowlap/engine';
import { oracleLabels } from './attempts.js';
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
}

/** The cost of an attempt of a recording that forks: at most what the whole recording's model calls cost. Null with a model that has no price. */
function recordingCost(store: Store, run: RunRecord, prices: Record<string, Price> | undefined): number | null {
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
 * `risk`. Its forecast reads each golden's recent results for its pass rate and cost per attempt,
 * else its gate's `good` rate (a gate against history: its baseline's) and the cost of its recording.
 * A pack that can't be read is left to fail on its own when it runs. Null with no gated golden.
 */
export function planSession(packs: readonly string[], o: { store: Store; tests: TestEntry[]; projectDir: string; prices?: Record<string, Price> | undefined; baselineBranch?: string | null | undefined; risk: number; inconclusive: 'fail' | 'warn'; maxAttempts?: number | undefined }): SessionPlan | null {
  const goldens: SuiteGolden[] = [];
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
    const history = spec.gate.kind === 'baseline' ? gateHistory(o.store, golden, { window: spec.gate.window, first: spec.gate.min, goldenRunId: parent.runId, checks, mode: 'fork', ...(o.baselineBranch !== undefined ? { branch: o.baselineBranch } : {}) }) : null;
    const recent = recentAttempts(o.store, golden, { window: RECENT, goldenRunId: parent.runId, checks });
    goldens.push({
      golden,
      gate: spec.gate,
      maxGiven: !!spec.gateMaxGiven,
      ...(history?.attempts ? { history: { passes: history.passes, attempts: history.attempts } } : {}),
      rate: recent ? recent.passes / recent.attempts : null,
      costPerAttempt: recent?.costPerAttempt ?? recordingCost(o.store, parent, o.prices),
    });
  }
  const plan = planSuite(goldens, { risk: o.risk, inconclusive: o.inconclusive });
  if (!plan) return null;
  // --max-attempts raises every gate's limit past what the session sized.
  if (o.maxAttempts) for (const p of plan.planned) p.most = Math.max(p.most, o.maxAttempts);
  plan.forecast.most = plan.planned.reduce((n, p) => n + p.most, 0);
  return { plan, gates: new Map(plan.planned.map((p) => [p.golden, p.gate])) };
}

const count = (n: number) => Math.round(n).toLocaleString('en-US');
const plural = (n: number, noun: string) => `${count(n)} ${noun}${Math.round(n) === 1 ? '' : 's'}`;

/**
 * What the session says before it runs: the forecast, and with more than one gated golden, how the
 * risk is split. `forecast: about 1,675 attempts (16.7 a golden on average), up to 17,900 · about
 * $41.87` and `suite risk 5%: 100 gated goldens, 0.05% each, so a healthy suite goes red for nothing
 * in 5% of runs or fewer`. A golden whose share can't be met says why, and the suite's line then says
 * what the plan works out instead of the risk it was given (`suiteRed`), which it would overstate.
 */
export function suiteLines(plan: SuitePlan): string[] {
  const f = plan.forecast;
  const each = plan.goldens > 1 ? ` (${+(f.attempts / plan.goldens).toFixed(1)} a golden on average)` : '';
  const cost = f.cost === null ? 'cost unknown: no price for their models' : `about ${formatUsd(f.cost)}${f.unpriced ? `, ${f.unpriced} without a price` : ''}`;
  const lines = [`forecast: about ${plural(f.attempts, 'attempt')}${each}, up to ${count(f.most)} · ${cost}`];
  if (plan.goldens > 1) {
    const red = plan.inconclusive === 'fail' ? 'goes red for nothing' : 'fails a golden for nothing';
    lines.push(`suite risk ${riskPercent(plan.risk)}: ${plan.goldens} gated goldens, ${riskPercent(plan.perGoldenRisk)} each, ${suiteRed({ ...plan, over: plan.planned.filter((p) => p.over).length }, red)}`);
  }
  for (const p of plan.planned) if (p.over) lines.push(`${p.golden}: ${p.over}`);
  return lines;
}

/** The plan as `--json` reports it, under `suite`: with `over`, the goldens whose share could not be met, when any could not. */
export function suiteJson(plan: SuitePlan): { risk: number; perGoldenRisk: number; method: 'bonferroni'; goldens: number; inconclusive: 'fail' | 'warn'; red: number; forecast: SuitePlan['forecast']; over?: number } {
  const over = plan.planned.filter((p) => p.over).length;
  return { risk: plan.risk, perGoldenRisk: plan.perGoldenRisk, method: plan.method, goldens: plan.goldens, inconclusive: plan.inconclusive, red: plan.red, forecast: plan.forecast, ...(over ? { over } : {}) };
}
