import { attemptsToFail, attemptsToPass, BASELINE_DEFAULTS, BLAME_DEFAULTS, describeGate, gateOdds, gateOddsAt, parseGate, passesPerFailure, runsRed, SPRT_DEFAULTS, type Gate } from '@shadowlap/engine';

/**
 * Gates on the server: what a gate's figures would do before they are saved, as Settings → CI's
 * Gates previews them (`GET /api/tests/gate`). Its answer is a function of its query alone.
 */

/** What a gate would do, before it is saved: Settings → CI's preview of the gate's figures. */
export interface GatePreview {
  gate: Gate;
  /** The gate's rule: `tells 90%+ from 70%- at <= 5% risk, up to 80 attempts`. */
  description: string;
  /** An SPRT gate: the attempts an agent that always passes needs (12 at 0.9, 0.7, 0.05), one that always fails (3), and the passes that make up for a failure (about 4.4). Null for history. */
  toPass: number | null;
  toFail: number | null;
  passesPerFailure: number | null;
  /**
   * The exact odds of each verdict, and attempts on average, for agents that pass at these rates.
   * A gate against history is figured against `history`, a baseline it says (47 of 50 unless the
   * query names one): the chance it fails, by the pass rate now, is its power to catch a drop.
   */
  odds: Array<{ rate: number; pass: number; fail: number; inconclusive: number; attempts: number }>;
  /** A gate against history: the baseline its odds are figured against. Null for an SPRT gate. */
  history: { passes: number; attempts: number } | null;
  /** With 100 forked goldens of an agent that passes 95% of the time, how often a CI run goes red for nothing, under `--inconclusive fail` and `warn`. */
  ci: { goldens: number; rate: number; red: number; redWarn: number };
  /** What `{}` and `{ "baseline": "history" }` stand for in a golden's gate, and blame's own figures. */
  defaults: { sprt: Omit<Gate & { kind: 'sprt' }, 'kind'>; baseline: Omit<Gate & { kind: 'baseline' }, 'kind'>; blame: Omit<Gate & { kind: 'sprt' }, 'kind'> };
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

/**
 * A gate's preview from its figures as a page sends them (query values, all optional): `good`,
 * `bad`, `risk`, `max`, or `baseline=history` with `drop`, `risk`, `window`, `min`, `max` and the
 * baseline to figure it against, `history=47/50`. Throws with the config's own message for a gate it
 * would refuse.
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
  const odds = gateOddsAt(gate, gate.kind === 'sprt' ? PREVIEW_RATES : HISTORY_RATES, history);
  // A healthy agent's CI: the baseline it is figured against is its own rate, for a gate against history.
  const healthy = gate.kind === 'sprt' ? odds.find((o) => o.rate === 0.95)! : gateOdds(gate, 0.95, { passes: 95, attempts: 100 });
  return {
    gate,
    description: describeGate(gate),
    toPass: gate.kind === 'sprt' ? attemptsToPass(gate) : null,
    toFail: gate.kind === 'sprt' ? attemptsToFail(gate) : null,
    passesPerFailure: gate.kind === 'sprt' ? passesPerFailure(gate) : null,
    odds: odds.map((o) => ({ rate: o.rate, pass: o.pass, fail: o.fail, inconclusive: o.inconclusive, attempts: o.attempts })),
    history,
    ci: { goldens: 100, rate: 0.95, red: runsRed(healthy, 100, 'fail'), redWarn: runsRed(healthy, 100, 'warn') },
    defaults: { sprt: { ...SPRT_DEFAULTS }, baseline: { ...BASELINE_DEFAULTS }, blame: { ...BLAME_DEFAULTS } },
  };
}

