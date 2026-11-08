import { attemptsToFail, attemptsToPass, BASELINE_DEFAULTS, BLAME_DEFAULTS, decide, describeGate, explainGate, gateOdds, gateOddsAt, gateResult, parseGate, parseTestSettings, passesPerFailure, planSuite, readConfigFile, runsRed, SPRT_DEFAULTS, SUITE_RISK, verdictLine, type Gate, type GateDecision, type GateHistory, type Tally } from '@shadowlap/engine';
import type { GoldenSource } from './tests.js';

/**
 * Gates on the server: what a gate's figures would do before they are saved, as Settings → CI's
 * Gates previews them (`GET /api/tests/gate`). Its answer is a function of its query alone.
 */

/** What a gate would do, before it is saved: Settings → CI's preview of the gate's figures. */
export interface GatePreview {
  gate: Gate;
  /** The gate's rule: `tells 90%+ from 70%- at <= 5% risk, up to 80 attempts`. */
  description: string;
  /** What its verdicts state, in one sentence: `Tells an agent that passes 90% of the time or more from one that passes 70% or less, …`. */
  sentence: string;
  /**
   * The attempts an agent that always passes needs (12 at 0.9, 0.7, 0.05; against history, its
   * baseline's), null when it never passes in `max`; for an SPRT gate, one that always fails (3), and
   * the passes that make up for a failure (about 4.4), null for history.
   */
  toPass: number | null;
  toFail: number | null;
  passesPerFailure: number | null;
  /**
   * Each extreme's verdict line, a golden on its own: an agent whose every attempt passes
   * (`passed · 12 of 12 · rate >= 0.73 (95%)`), and for an SPRT gate one whose every attempt fails
   * (`failed · 0 of 3 · rate <= 0.71 (95%)`); null for history, whose drop needs a baseline to fall from.
   */
  extremes: { pass: string; fail: string | null };
  /**
   * The exact odds of each verdict, and attempts on average, for agents that pass at these rates.
   * A gate against history is figured against `history`, a baseline it says (47 of 50 unless the
   * query names one): the chance it fails, by the pass rate now, is its power to catch a drop.
   */
  odds: Array<{ rate: number; pass: number; fail: number; inconclusive: number; attempts: number }>;
  /** A gate against history: the baseline its odds are figured against. Null for an SPRT gate. */
  history: { passes: number; attempts: number } | null;
  /**
   * With 100 forked goldens of an agent that passes 95% of the time, how often a CI run goes red for
   * nothing, under `--inconclusive fail` and `warn`: the session as `shadowlap test` plans it, the
   * suite's risk (`risk`, the query's `suiteRisk`, 5% unless the config says) split across them.
   */
  ci: { goldens: number; rate: number; risk: number; red: number; redWarn: number };
  /** What `{}` and `{ "baseline": "history" }` stand for in a golden's gate, and blame's own figures. */
  defaults: { sprt: Omit<Gate & { kind: 'sprt' }, 'kind'>; baseline: Omit<Gate & { kind: 'baseline' }, 'kind'>; blame: Omit<Gate & { kind: 'sprt' }, 'kind'> };
}

/** What Settings → CI's Gates needs of the project: the suite's risk its CI figure splits, and each kind's goldens on the defaults. */
export interface CiGates {
  /** The config's `tests.suiteRisk`, else 5%: what the preview's `suiteRisk` sends. */
  suiteRisk: number;
  /** The readable goldens whose gate is of that kind with every figure the kind's default, named as Tests names them. */
  uses: { sprt: string[]; baseline: string[] };
}

/** The project's suite risk and its goldens on each kind's defaults, for Gates' defaults note. */
export function ciGates(project: string | null, goldens: readonly GoldenSource[], folder: string): CiGates {
  let suiteRisk = SUITE_RISK;
  try {
    const tests = project ? readConfigFile(project).data.tests : undefined;
    suiteRisk = parseTestSettings(tests).suiteRisk ?? SUITE_RISK;
  } catch {
    // A config that can't be read, or a suiteRisk it refuses: every session refuses it too, and the page says so.
  }
  const uses: CiGates['uses'] = { sprt: [], baseline: [] };
  for (const g of goldens) {
    if (g.error || !g.gate) continue;
    const defaults = (g.gate.kind === 'sprt' ? SPRT_DEFAULTS : BASELINE_DEFAULTS) as unknown as Readonly<Record<string, number>>;
    const figures = g.gate as unknown as Readonly<Record<string, unknown>>;
    if (Object.keys(defaults).every((k) => figures[k] === defaults[k]) && figures.failRisk === undefined) uses[g.gate.kind].push(g.path.startsWith(`${folder}/`) ? g.path.slice(folder.length + 1) : g.path);
  }
  return { suiteRisk, uses };
}

const PREVIEW_RATES = [0.99, 0.95, 0.9, 0.8, 0.7, 0.5];
/** A history gate's preview by the pass rate now, against its baseline: unchanged, then by how far it dropped. */
const HISTORY_RATES = [0.95, 0.9, 0.85, 0.75, 0.6, 0.5, 0.2];
/** The baseline a history gate's preview is figured against when the query names none: a golden that passed 47 of its last 50 attempts. */
export const PREVIEW_HISTORY = { passes: 47, attempts: 50 } as const;

/** `47/50`: a baseline's passes and attempts, as the preview's `history` query value gives them. */
function historyQuery(raw: string | null): { passes: number; attempts: number } {
  if (raw === null || raw === '') return { ...PREVIEW_HISTORY };
  const m = /^(\d{1,6})\/(\d{1,6})$/.exec(raw);
  const passes = m ? Number(m[1]) : NaN;
  const attempts = m ? Number(m[2]) : NaN;
  if (!m || attempts < 1 || passes > attempts) throw new Error('history must be passes/attempts, such as 47/50');
  return { passes, attempts };
}

/** The suite's risk a session splits across its gated goldens, as the query gives it: the config's `tests.suiteRisk`. */
function suiteRiskQuery(raw: string | null): number {
  if (raw === null || raw === '') return SUITE_RISK;
  const risk = Number(raw);
  if (!(risk > 0 && risk < 0.5)) throw new Error('suiteRisk must be a number above 0 and below 0.5, such as 0.05');
  return risk;
}

/** What an agent whose every attempt passes (or fails) comes to, the gate asked after each as a session asks it: its decision, attempts and verdict line. */
function always(gate: Gate, pass: boolean, history: GateHistory | null): { decision: GateDecision; attempts: number; line: string } {
  const outcomes: boolean[] = [];
  let decision: GateDecision = 'continue';
  while (decision === 'continue' && outcomes.length < gate.max) {
    outcomes.push(pass);
    decision = decide(pass ? outcomes.length : 0, outcomes.length, gate, history);
  }
  if (decision === 'continue') decision = 'inconclusive';
  return { decision, attempts: outcomes.length, line: verdictLine(gateResult(gate, outcomes, { history, decision })) };
}

/** A healthy agent's history, against which a gate against history is planned and figured in CI: 95 of its last 100 attempts passed. */
const HEALTHY: Tally = { passes: 95, attempts: 100 };
const CI_GOLDENS = 100;
/** Sessions planned so far, by figures and risk: planning one walks the gate's curves many times over. */
const planned = new Map<string, { red: number; redWarn: number }>();

/**
 * How often a CI run of 100 goldens with these figures goes red for nothing, for an agent that
 * passes 95% of the time: the session `shadowlap test` plans (each golden's gate at its share of the
 * suite's risk, its `max` kept only where the golden's entry names it), under each `inconclusive`.
 */
function sessionRed(gate: Gate, risk: number): { red: number; redWarn: number } {
  const key = JSON.stringify([gate, risk]);
  const known = planned.get(key);
  if (known) return known;
  const defaults: { max: number } = gate.kind === 'sprt' ? SPRT_DEFAULTS : BASELINE_DEFAULTS;
  const history = gate.kind === 'baseline' ? HEALTHY : null;
  // One golden at its share of the suite's risk plans as each of the hundred does, the forecast worked out once.
  const golden = { golden: 'goldens/one', gate, maxGiven: gate.max !== defaults.max, history };
  const red = (mode: 'fail' | 'warn'): number => {
    const plan = planSuite([golden], { risk: risk / CI_GOLDENS, inconclusive: mode });
    const own = plan?.planned[0]?.gate ?? gate;
    return runsRed(gateOdds(own, 0.95, history), CI_GOLDENS, mode);
  };
  const out = { red: red('fail'), redWarn: red('warn') };
  if (planned.size >= 64) planned.clear();
  planned.set(key, out);
  return out;
}

/**
 * A gate's preview from its figures as a page sends them (query values, all optional): `good`,
 * `bad`, `risk`, `max`, or `baseline=history` with `drop`, `risk`, `window`, `min`, `max` and the
 * baseline to figure it against, `history=47/50`; and `suiteRisk`, the config's, which CI's figure
 * splits. Throws with the config's own message for a gate it would refuse.
 */
export function gatePreview(query: { get(name: string): string | null }): GatePreview {
  const json: Record<string, unknown> = {};
  for (const key of ['baseline', 'good', 'bad', 'risk', 'max', 'drop', 'window', 'min']) {
    const raw = query.get(key);
    if (raw === null || raw === '') continue;
    json[key] = key === 'baseline' ? raw : Number(raw);
  }
  const gate = parseGate(json, 'gate');
  const history = gate.kind === 'baseline' ? historyQuery(query.get('history')) : null;
  const risk = suiteRiskQuery(query.get('suiteRisk'));
  const odds = gateOddsAt(gate, gate.kind === 'sprt' ? PREVIEW_RATES : HISTORY_RATES, history);
  // Its verdict lines say over how many sessions the baseline was pooled: the window's.
  const pooled = gate.kind === 'baseline' && history ? { ...history, sessions: gate.window } : null;
  const up = always(gate, true, pooled);
  const sprt = gate.kind === 'sprt';
  return {
    gate,
    description: describeGate(gate),
    sentence: explainGate(gate),
    toPass: sprt ? attemptsToPass(gate) : up.decision === 'pass' ? up.attempts : null,
    toFail: sprt ? attemptsToFail(gate) : null,
    passesPerFailure: sprt ? passesPerFailure(gate) : null,
    extremes: { pass: up.line, fail: sprt ? always(gate, false, null).line : null },
    odds: odds.map((o) => ({ rate: o.rate, pass: o.pass, fail: o.fail, inconclusive: o.inconclusive, attempts: o.attempts })),
    history,
    ci: { goldens: CI_GOLDENS, rate: 0.95, risk, ...sessionRed(gate, risk) },
    defaults: { sprt: { ...SPRT_DEFAULTS }, baseline: { ...BASELINE_DEFAULTS }, blame: { ...BLAME_DEFAULTS } },
  };
}

