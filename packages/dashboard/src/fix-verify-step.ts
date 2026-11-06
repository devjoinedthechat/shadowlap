import { afterForkSentence, describeGate, expectArgs, type FixRecords, fixVerifyHead, footprintDelta, GATE_MAX_ATTEMPTS, gateOdds, keptAttemptVerdict, outcomeOf, type PulledFrom, rateBound, SPRT_DEFAULTS, type SprtGate, type StoredVerdict, unsettledReason, type VerdictStanding, verdictWord, type VerifiedRun, type VerifyOutcome } from '@shadowlap/engine';
import { verifyEvidence } from './evidence.js';
import { fieldArgs, rerunFlags, runIds, type RerunFlags } from './rerun.js';
import { changeName, commandLine, countArgs, finite, fixHref, gateArg, PULLED_CAP, pulledGate, ROLE, runHref, shortFailure, sprtGate, type VerifyRow } from './fix-shared.js';

/** A fix's Verify step: every verdict on a change for it, run by run, and how to ask again. */

/** A run's gate result as the Verify step shows it: its decision, the Wilson interval, its sentence and the bound beside its tally; null when there is none to read. */
function rateOf(g: unknown): VerifyRow['rate'] {
  if (!g || typeof g !== 'object') return null;
  const x = g as Record<string, unknown>;
  const i = x.interval as Record<string, unknown> | null | undefined;
  if (typeof x.decision !== 'string' || typeof x.sentence !== 'string' || !i || typeof i !== 'object' || !finite(i.lo) || !finite(i.hi) || !finite(i.confidence)) return null;
  const attempts = finite(x.attempts) ? x.attempts : 0;
  const decision = x.decision === 'pass' || x.decision === 'fail' || x.decision === 'inconclusive' || x.decision === 'continue' ? x.decision : undefined;
  // A clean replay's one attempt has no rate to show: it comes out the same every time.
  return { decision: x.decision, lo: i.lo, hi: i.hi, confidence: i.confidence, sentence: x.sentence, bound: decision && x.clean !== true ? rateBound({ attempts, interval: { lo: i.lo, hi: i.hi, confidence: i.confidence }, decision }) : null };
}

export interface VerifyStep {
  verifyId: string;
  href: string;
  at: number;
  verdict: VerifyOutcome;
  /** Whether it counts for this fix: it checked the fix's check on a run that failed it as recorded. */
  counts: boolean;
  /** That it was rejected after the fix was applied; null otherwise. One that doesn't count says why in its `headline`. */
  note: string | null;
  /** What was verified, named by what changed (`changeName`): "repair candidate 3", the request fields it set, or the code version. */
  code: string;
  /** How the switch between changes names it: "repair candidate 3 · accepted", and "· doesn't count" after one that doesn't count for the fix. */
  label: string;
  /** By the runs it checked ("Fixes 1 of 1 target run, keeps 1 of 1 good"), or for one that doesn't count, why ("Doesn't count for this fix: …"). */
  headline: string;
  /** "a run passes when 4 of 5 attempts meet the check: …" */
  oracle: string;
  needed: number;
  attemptsPerRun: number;
  rows: VerifyRow[];
  tokens: { before: number; after: number; change: string } | null;
  cost: { before: number; after: number; change: string } | null;
  attempts: number;
  upstreamRequests: number;
  spent: number;
  unknownModels: string[];
  reasons: string[];
  /** Those of `reasons` that say a run is inconclusive or not settled, not that the change failed it: shown in amber, the rest in red. */
  unsettled: string[];
  warnings: string[];
  /** What answered the change's tool calls after the fork, and the baselines' apart, in the engine's words (`afterForkSentence`), as the CLI's report prints it under its warnings; null when no attempt made one. */
  afterFork: string | null;
  /**
   * The command it ran: as it ran, for a verdict given here; for one a pull brought (`pulled`), the
   * same verify made here from its checked fields, so a teammate's command line is never offered to
   * copy.
   */
  command: string;
  /** The store a pull brought it from, and when; null for a verdict given here. */
  pulled: PulledFrom | null;
  repairId: string | null;
  candidate: number | null;
  /** What settles an incomplete verdict that counts for the fix (`verifyMore`); null for any other. */
  more: VerifyMore | null;
}

/**
 * What settles an incomplete verdict that counts for the fix, when it is a change `shadowlap verify`
 * checks by itself (not a repair's candidate, which only its repair can put in the working tree).
 * `more`: Run more attempts, its runs verified again from the start (verify has no `--continue`),
 * named by id in their roles, with twice the limit when a gate ran out of attempts, and without the
 * `--budget` that stopped it (`budget`); `again`: Verify again, the same command once the check
 * that couldn't be judged can be. `run` is the run it names first, and why it is open: its gate
 * ran out of attempts (`inconclusive`), the verify stopped first (`stopped`, with why), or an
 * attempt could not be judged (`unjudged`, with which attempt and why). `expected` is the attempts
 * it runs on average, each run at the rate it passed at so far, and `cost` what that would cost at
 * the verdict's own spend per attempt (null when it spent nothing it kept).
 */
export interface VerifyMore {
  kind: 'more' | 'again';
  run: { runId: string; state: 'inconclusive' | 'stopped' | 'unjudged'; why: string | null; attempt: number | null };
  max: number;
  expected: number;
  cost: number | null;
  /** The budget the verdict ran with, which Run more attempts leaves out; null when it had none. */
  budget: string | null;
  /** Built from the verdict's checked fields and flags (rerun.ts), never from its command line. */
  argv: string[];
  command: string;
  /** The store a pull brought the verdict from: it runs only once the user says yes to `command`. Null for one given here. */
  pulled: PulledFrom | null;
  /** What a pulled verdict ran with that runs on no other machine, left out: `--build`, `--base`, and `--` for the command after it. */
  left: string[];
}

/** Why a verdict doesn't count for a fix, as its heading says it: `Doesn't count for this fix: its check leaves out send_email called 1 time`. Null for one that counts. */
export function uncountedHead(st: VerdictStanding): string | null {
  if (st.counts) return null;
  const why = st.why === 'another-check' ? (st.missing?.length ? `its check leaves out ${st.missing.join('; ')}` : 'it was checked under another check') : st.why === 'already-passing' ? 'every run of this fix it checked already passed as recorded' : 'none of the runs it checked fails in this fix';
  return `Doesn't count for this fix: ${why}`;
}

/** A change in percent, as verify prints it: +20%, −5.0%, ±0%. */
function pct(before: number, after: number): string {
  if (before === 0) return after === 0 ? '±0%' : 'new';
  const d = ((after - before) / before) * 100;
  return `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d) < 10 ? Math.abs(d).toFixed(1) : Math.round(Math.abs(d))}%`;
}

/**
 * A verdict's heading, by the runs it checked, in the engine's words (`fixVerifyHead`): "Every failing
 * run fixed, every good run kept" only when it checked every failing run of the fix, else what it did
 * role by role. One that doesn't count for the fix says why instead (`uncountedHead`).
 */
function headline(rec: FixRecords, v: StoredVerdict, standing: VerdictStanding): string {
  return uncountedHead(standing) ?? fixVerifyHead(v.verdict, v.report.runs, rec.failing);
}

/**
 * A verdict as the Verify step shows it. `fallback` is the fix's own verify command, which a pulled
 * verdict shows when its fields can't be made into one.
 */
export function verifyStep(rec: FixRecords, v: StoredVerdict, fallback: string): VerifyStep {
  const r = v.report;
  const fixId = rec.fix.fixId;
  const standing = rec.standing.get(v.verifyId) ?? { counts: true, why: null };
  const appliedAt = rec.fix.appliedAt;
  const regressed = standing.counts && v.verdict === 'rejected' && rec.fix.status === 'applied' && appliedAt !== null && v.at > appliedAt;
  const code = changeName(v);
  const rows: VerifyRow[] = r.runs.map((x) => {
    const failure = x.verdict === 'fail' ? x.attempts.find((a) => !a.passed)?.failures[0] : undefined;
    const forks = [...new Set(x.attempts.map((a) => a.forkedAt).filter((f): f is number => f !== null))];
    const n = x.attempts.length;
    const mean = (pick: (a: (typeof x.attempts)[number]) => number | null) => {
      if (!n) return null;
      let sum = 0;
      for (const a of x.attempts) {
        const value = pick(a);
        if (value === null) return null;
        sum += value;
      }
      return sum / n;
    };
    const now = mean((a) => a.footprint.inputTokens);
    // A run an attempt it could not judge stopped was decided by no gate: no rate, as verify's JSON has none.
    const rate = x.undecided ? null : rateOf(x.gate);
    return {
      role: ROLE[x.role],
      runId: x.runId,
      href: runHref(x.runId),
      attempts: n,
      passes: x.passes,
      inconclusive: x.attempts.filter((a) => keptAttemptVerdict(a) === 'inconclusive').length,
      deterministic: x.deterministic,
      outcome: outcomeOf(x),
      rate,
      note: failure ? shortFailure(failure) : x.undecided ? 'an attempt could not be judged' : !n ? 'not started' : x.deterministic ? 'clean replay' : forks.length ? `forked at ${forks.map((f) => `#${f}`).join(', ')}` : '',
      tokens: now === null ? null : { recorded: x.recorded.footprint.inputTokens, now },
      cost: n ? { recorded: x.recorded.footprint.cost, now: mean((a) => a.footprint.cost) } : null,
      evidence: verifyEvidence(x),
    };
  });
  const d = footprintDelta(r.runs);
  return {
    verifyId: v.verifyId,
    href: fixHref(fixId, 'verify', v.verifyId),
    at: v.at,
    verdict: v.verdict,
    counts: standing.counts,
    // One that doesn't count says why in its heading.
    note: regressed ? 'Rejected after the fix was applied: it no longer holds.' : null,
    code,
    label: `${code} · ${verdictWord(v.verdict)}${standing.counts ? '' : " · doesn't count"}`,
    headline: headline(rec, v, standing),
    oracle: sprtGate(r.gate) ? `a run's attempts must meet the check: ${r.oracle.join('; ')}; its gate decides after each one: ${describeGate(sprtGate(r.gate)!)}` : `a run passes when ${r.needed} of ${r.attemptsPerRun} attempts meet the check: ${r.oracle.join('; ')}`,
    needed: r.needed,
    attemptsPerRun: r.attemptsPerRun,
    rows,
    tokens: d ? { before: d.recorded.inputTokens, after: d.now.inputTokens, change: pct(d.recorded.inputTokens, d.now.inputTokens) } : null,
    cost: d && d.recorded.cost !== null && d.now.cost !== null ? { before: d.recorded.cost, after: d.now.cost, change: pct(d.recorded.cost, d.now.cost) } : null,
    attempts: r.attempts,
    upstreamRequests: r.upstreamRequests,
    spent: r.spent,
    unknownModels: r.unknownModels,
    reasons: r.reasons,
    unsettled: r.reasons.filter(unsettledReason),
    warnings: [...r.warnings, ...(r.replayWarnings ?? [])],
    afterFork: afterForkSentence(r.runs),
    // A teammate's command line is never offered to copy: the same verify, made here from its checked fields.
    command: v.pulled ? sameVerify(v, fallback) : v.command,
    pulled: v.pulled ?? null,
    repairId: v.repairId,
    candidate: v.candidate,
    more: standing.counts ? verifyMore(v) : null,
  };
}

const VERIFY_ROLE_FLAG: Readonly<Record<VerifiedRun['role'], string>> = { target: '--fixes', holdout: '--holdout', good: '--keeps' };

/**
 * A kept verdict as `shadowlap verify` arguments, from its checked fields: its runs named by id in
 * their roles, its check, the request fields it set, its gate (`gate` in its place, when given) or
 * fixed count, and its flags (rerun.ts) but `drop`. Null when any of them isn't of its shape, or it
 * kept no flags.
 */
function verdictArgs(v: StoredVerdict, o: { gate?: SprtGate | null; drop?: ReadonlySet<string> } = {}): { argv: string[]; rerun: RerunFlags } | null {
  const r = v.report;
  const rerun = rerunFlags('verify', v.rerun, { pulled: !!v.pulled, ...(o.drop ? { drop: o.drop } : {}) });
  const check = expectArgs(v.expect);
  const fields = fieldArgs(r.fields);
  if (!rerun || !check || !fields || !runIds(r.runs.map((x) => x.runId))) return null;
  const roles = (['target', 'holdout', 'good'] as const).flatMap((role) => {
    const ids = r.runs.filter((x) => x.role === role).map((x) => x.runId);
    return ids.length ? [VERIFY_ROLE_FLAG[role], ...ids] : [];
  });
  const gate = pulledGate(o.gate !== undefined ? o.gate : sprtGate(r.gate), !!v.pulled, PULLED_CAP.verify);
  const decide = gate ? gateArg(gate, SPRT_DEFAULTS) : countArgs(r.attemptsPerRun, r.needed, !!v.pulled);
  if (!decide) return null;
  return { argv: ['verify', ...roles, ...check, ...fields, ...decide, ...rerun.flags, ...(rerun.command ? ['--', ...rerun.command] : [])], rerun };
}

/** What a verdict decided each run by: its gate, else its fixed count of attempts, each held to a pulled record's cap. */
export function verdictRule(v: StoredVerdict): { gate: SprtGate | null; attempts: number } {
  const pulled = !!v.pulled;
  return { gate: pulledGate(sprtGate(v.report.gate), pulled, PULLED_CAP.verify), attempts: pulled ? Math.min(v.report.attemptsPerRun, PULLED_CAP.count) : v.report.attemptsPerRun };
}

/**
 * What Verify this run is expected to take, worked out as `verifyMore` works its own: each of `runs`
 * runs from the start at the rate the accepted verdict `v`'s failing runs passed at, by its gate,
 * else its fixed count; and what that costs at what an attempt of `v` cost, null when it spent nothing.
 */
export function verifyLeftExpected(v: StoredVerdict, runs: number): { expected: number; cost: number | null } {
  const r = v.report;
  const { gate, attempts } = verdictRule(v);
  const failing = r.runs.filter((x) => x.role !== 'good');
  const tried = failing.reduce((n, x) => n + x.attempts.length, 0);
  const rate = tried ? failing.reduce((n, x) => n + x.passes, 0) / tried : 0.5;
  const expected = Math.round(runs * (gate ? gateOdds(gate, rate).attempts : attempts));
  const spent = r.spent + (r.judge?.spent ?? 0);
  return { expected, cost: spent > 0 && r.attempts > 0 ? (spent / r.attempts) * expected : null };
}

/** What a good run is kept against: Verify this run names no good run, so they have nothing to say. */
const GOOD_RUN_FLAGS: ReadonlySet<string> = new Set(['--margin', '--baseline', '--base', '--build']);

/**
 * Verify this run (`FixActions['verifyLeft']`) as `shadowlap verify` arguments: `runs`, failing runs
 * no accepted verdict checked, verified on the code as it is now under the fix's check as it is, by
 * what `v`, the accepted verdict, decided: the request fields it set, its gate (held to a pulled
 * record's cap) or fixed count, and its flags but `--budget` and what only a good run reads. A
 * repair's verdict kept no flags, so its gate alone, as the CLI runs it. Null when any of them isn't
 * of its shape.
 */
export function verifyLeftArgs(rec: FixRecords, v: StoredVerdict, runs: readonly string[]): { argv: string[]; pulled: PulledFrom | null; left: string[] } | null {
  const r = v.report;
  const pulled = !!v.pulled;
  const rerun = v.rerun ? rerunFlags('verify', v.rerun, { pulled, drop: new Set(['--budget', ...GOOD_RUN_FLAGS]) }) : null;
  const check = expectArgs(rec.fix.check.expect);
  const fields = fieldArgs(r.fields);
  if ((v.rerun && !rerun) || !check || !fields || !runs.length || !runIds(runs)) return null;
  const { gate } = verdictRule(v);
  const decide = gate ? gateArg(gate, SPRT_DEFAULTS) : countArgs(r.attemptsPerRun, r.needed, pulled);
  if (!decide) return null;
  return { argv: ['verify', '--fixes', ...runs, ...check, ...fields, ...decide, ...(rerun?.flags ?? []), ...(rerun?.command ? ['--', ...rerun.command] : [])], pulled: v.pulled ?? null, left: rerun?.left ?? [] };
}

/** A pulled verdict's verify as this machine would run it again, from its checked fields; `fallback` when they make none. */
function sameVerify(v: StoredVerdict, fallback: string): string {
  const made = verdictArgs(v);
  return made ? commandLine(made.argv) : fallback;
}

/**
 * Run more attempts, or Verify again, for an incomplete verdict (`VerifyMore`), from its checked
 * fields (`verdictArgs`): its runs named in their roles, its change and check as they were, and the
 * gate's limit doubled when a run's gate ran out of attempts. Null for a verdict that isn't
 * incomplete, a repair's candidate, a fixed count with nothing stopped, or one whose fields can't
 * be checked (kept before its flags were, or with one of another shape).
 */
export function verifyMore(v: StoredVerdict): VerifyMore | null {
  const r = v.report;
  if (v.verdict !== 'incomplete' || v.candidate !== null || v.repairId !== null) return null;
  const open = r.runs.filter((x) => x.verdict === 'open');
  if (!open.length) return null;
  const gate = pulledGate(sprtGate(r.gate), !!v.pulled, PULLED_CAP.verify);
  const ranOut = open.filter((x) => x.decision === 'inconclusive' && !x.undecided);
  const stopped = open.filter((x) => x.decision !== 'inconclusive' && !x.undecided);
  const unjudged = open.filter((x) => !!x.undecided);
  const kind: VerifyMore['kind'] = ranOut.length || stopped.length ? 'more' : 'again';
  // A fixed count that ran out decides nothing more with more of the same.
  if (kind === 'more' && !gate && !stopped.length) return null;
  const max = gate ? (ranOut.length ? Math.min(v.pulled ? PULLED_CAP.verify : GATE_MAX_ATTEMPTS, gate.max * 2) : gate.max) : v.pulled ? Math.min(r.attemptsPerRun, PULLED_CAP.count) : r.attemptsPerRun;
  if (kind === 'more' && gate && ranOut.length && max <= gate.max) return null;
  const raised: SprtGate | null = gate ? { ...gate, max } : null;
  // Run more attempts leaves out the budget that stopped it; Verify again runs as it ran.
  const made = verdictArgs(v, { gate: raised, ...(kind === 'more' ? { drop: new Set(['--budget']) } : {}) });
  if (!made) return null;
  // What it would take, each run from the start at the rate it passed at so far: a clean replay settles in one.
  let expected = 0;
  for (const x of r.runs) {
    if (x.deterministic) expected += 1;
    else if (raised) expected += gateOdds(raised, x.attempts.length ? x.passes / x.attempts.length : 0.5).attempts;
    else expected += r.attemptsPerRun;
  }
  expected = Math.round(expected);
  const spent = r.spent + (r.judge?.spent ?? 0);
  const perAttempt = spent > 0 && r.attempts > 0 ? spent / r.attempts : null;
  const first = ranOut[0] ?? stopped[0] ?? unjudged[0]!;
  const state = first.undecided ? 'unjudged' : first.decision === 'inconclusive' ? 'inconclusive' : 'stopped';
  return {
    kind,
    run: { runId: first.runId, state, why: state === 'unjudged' ? (first.undecided ?? null) : state === 'stopped' ? r.stopReason : null, attempt: state === 'unjudged' ? first.attempts.length : null },
    max,
    expected,
    cost: perAttempt === null ? null : perAttempt * expected,
    budget: kind === 'more' ? (made.rerun.dropped['--budget'] ?? null) : null,
    argv: made.argv,
    command: commandLine(made.argv),
    pulled: v.pulled ?? null,
    left: made.rerun.left,
  };
}
