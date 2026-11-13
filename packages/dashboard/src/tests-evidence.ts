import { apartWords, attemptVerdict, decisionWord, providerUnavailable, tallyApart, type BaselineEvidence, type GateResult, type SprtEvidence, type StoreOf, type TestResult } from '@shadowlap/engine';
import { attemptNote, runHref } from './fix-shared.js';
import { answer, failed, type ReadTable } from './read-registry.js';
import { runCalls } from './run-calls.js';

/**
 * The evidence behind a gated golden's verdict, as the row under it on Tests shows it: why its gate
 * stopped where it did, worded from the figures its result kept (never the defaults, so a suite's
 * split risk or an asymmetric failRisk reads as it was decided), and its attempts, each judged from
 * its own run, read in the pool when the row opens. Nothing new is kept for it.
 */

/** The words of a gated golden's evidence: its line's sentence, bounds and ends, its receipt, and its bar's hover. */
export interface EvidenceWords {
  /** Why it stopped where it did: `Stopped at attempt 12: the score reached +3.02, past +3.00, where it passes.` */
  why: string;
  /** After Run more attempts: ` Attempts 1–80 were carried over; its limit was raised to 160 for that session only.`; else empty. */
  carriedNote: string;
  /** Each bound's words, right of the line: `passes at +3.00` and `fails at −3.00`, or `fails above 0.95` and `passes at 0.50`. */
  hiLabel: string;
  loLabel: string;
  /** The axis' ends: where a history gate's line starts (`attempt 5`; empty for a score, which starts at 0), and `attempt 12` or `attempt 80, its limit`. */
  start: string;
  end: string;
  /** The receipt's parts: what each attempt weighs or where it decides from, pass^5 (empty before 5 attempts), where each attempt forked, and what the provider did. */
  step: string;
  passK: string;
  forked: string;
  provider: string;
  /** The bar's hover: its title after the golden's name (`passed at attempt 12`), its line, and its one row. */
  head: string;
  tip: string;
  row: [string, string] | null;
}

/** A score as the line prints it, its sign always shown and a minus a real one: `+3.00`, `−1.10`. */
const signed = (x: number): string => `${x < 0 ? '−' : '+'}${Math.abs(x).toFixed(2)}`;

/** Where a fork golden went live: `forked at call 3, live from there`; of its attempts, each attempt. Tests' evidence and a golden's report alike. */
export const forkedWords = (at: number, each = false): string => `forked at call ${at}, ${each ? 'each attempt ' : ''}live from there`;

/** 1st, 2nd, 3rd, 4th, 11th, 21st. */
const ordinal = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`;

/**
 * A gated result's evidence in words (null for a clean replay's, which one attempt settled). `why`
 * follows the decision, not the count: a gate stopped before either bound and short of its limit (a
 * signal, the provider) says so rather than that it ran out.
 */
export function evidenceWords(g: GateResult, forkedAt: number | null): EvidenceWords | null {
  const n = g.attempts;
  if (g.clean || !n) return null;
  const ranOut = g.decision === 'inconclusive' && n >= g.max;
  const carried = g.carried ?? 0;
  const k5 = g.passK.find((x) => x.k === 5);
  const cut = g.unavailableAt?.length ?? 0;
  const common = {
    carriedNote: carried ? ` Attempts 1–${carried} were carried over; its limit was raised to ${g.max} for that session only.` : '',
    end: ranOut ? `attempt ${n}, its limit` : `attempt ${n}`,
    passK: k5 ? k5.value.toFixed(2) : '',
    forked: forkedAt ? forkedWords(forkedAt, true) : '',
    provider: tallyApart({ cutShort: cut, unavailable: g.unavailable }).join(' · '),
    head: g.decision === 'inconclusive' ? `inconclusive after ${n} attempts` : `${decisionWord(g.decision)} at attempt ${n}`,
  };
  return g.evidence.kind === 'sprt' ? sprtWords(g, g.evidence, common, ranOut) : historyWords(g, g.evidence, common, ranOut);
}

type CommonWords = Pick<EvidenceWords, 'carriedNote' | 'end' | 'passK' | 'forked' | 'provider' | 'head'>;

/** An SPRT's: the score after each attempt, between the bounds it passes and fails at. */
function sprtWords(g: GateResult, e: SprtEvidence, common: CommonWords, ranOut: boolean): EvidenceWords {
  const n = g.attempts;
  const carried = g.carried ?? 0;
  const s = e.scores.at(-1) ?? 0;
  const between = `between ${signed(e.lower)} and ${signed(e.upper)}`;
  const step = `a pass adds ${e.pass.toFixed(2)}, a failure ${signed(e.fail)}`;
  const why =
    g.decision === 'pass'
      ? `Stopped at attempt ${n}: the score reached ${signed(s)}, past ${signed(e.upper)}, where it passes.`
      : g.decision === 'fail'
        ? `Stopped at attempt ${n}: the score fell to ${signed(s)}, past ${signed(e.lower)}, where it fails.`
        : ranOut
          ? `Ran out at attempt ${n}, the most it runs: the score ended at ${signed(s)}, ${between}, where neither verdict holds.`
          : `Stopped at attempt ${n} before either bound: the score was ${signed(s)}, ${between}.`;
  const tip = `the score after each attempt: ${step}; it passes at ${signed(e.upper)} and fails at ${signed(e.lower)}${carried ? `, up to ${g.max} attempts` : ''}`;
  return { ...common, why, hiLabel: `passes at ${signed(e.upper)}`, loLabel: `fails at ${signed(e.lower)}`, start: '', step, tip, row: common.passK ? ['pass^5', common.passK] : null };
}

/** A gate against history's: the chance of a drop after each attempt from its first decision, between 0.50 and 1 − risk. */
function historyWords(g: GateResult, e: BaselineEvidence, common: CommonWords, ranOut: boolean): EvidenceWords {
  const n = g.attempts;
  const min = g.kind === 'baseline' ? g.min : 1;
  const drop = g.kind === 'baseline' ? g.drop : 0;
  const from = e.probabilities.findIndex((p) => p !== null) + 1;
  const q = e.probabilities.at(-1) ?? null;
  const [top, at] = [e.threshold.toFixed(2), e.passAt.toFixed(2)];
  const why =
    q === null
      ? `Stopped at attempt ${n} before either bound: it decides from attempt ${min} on.`
      : g.decision === 'fail'
        ? `Stopped at attempt ${n}: the chance of a drop reached ${q.toFixed(2)}, above ${top}, where it fails.`
        : g.decision === 'pass'
          ? `Stopped at attempt ${n}: the chance of a drop was ${q.toFixed(2)}, at ${at} or less, where it passes.`
          : ranOut
            ? `Ran out at attempt ${n}, the most it runs: the chance of a drop ended at ${q.toFixed(2)}, between ${at} and ${top}.`
            : `Stopped at attempt ${n} before either bound: the chance of a drop was ${q.toFixed(2)}, between ${at} and ${top}.`;
  const h = e.history;
  const baseline = h ? `${h.passes} of ${h.attempts} over ${h.sessions > 1 ? `its last ${h.sessions} sessions` : 'its last session'}` : 'its recording, 1 of 1 (no history yet)';
  return {
    ...common,
    why,
    hiLabel: `fails above ${top}`,
    loLabel: `passes at ${at}`,
    start: from > 0 && from < n ? `attempt ${from}` : '',
    step: `it decides from attempt ${min} on`,
    tip: `the chance of a drop of ${Math.round(drop * 100)} points or more after each attempt from the ${ordinal(min)}: it passes at ${at} or less and fails above ${top}`,
    row: ['baseline', baseline],
  };
}

/** One attempt as the evidence row lists it: its run, how it came out judged from that run, and why it didn't pass. */
export interface EvidenceAttempt {
  runId: string;
  href: string;
  outcome: 'passed' | 'failed' | 'inconclusive';
  note: string | null;
}

/** A gated golden's attempts (`GET /api/tests/evidence`): those carried over first, oldest first; `carried` of them; `gone`, runs no longer in the store, left out. */
export interface TestEvidence {
  attempts: EvidenceAttempt[];
  carried: number;
  gone: number;
}

export type TestsEvidenceJob = { kind: 'tests-evidence'; golden: string };

type EvidenceStore = StoreOf<'tests' | 'recording' | 'readModels' | 'activity'>;

/**
 * One result's runs, in the order they ran, each judged from its own record (never by its place in
 * the gate's outcomes, which leave out the provider's retries and start with the carried ones). Where
 * the result kept attempts the provider was unavailable for, a run that didn't pass is read for that:
 * one retried and never counted is left out, as the gate left it out; one it cut short and counted is
 * amber with what happened, never the agent's failure; with both kept, it can't be told which, and
 * says only that the provider was unavailable.
 */
function judgeRuns(store: EvidenceStore, r: TestResult, into: TestEvidence): number {
  const kept = r.data?.attempts;
  const [cut, retried] = [kept?.cutShort ?? 0, kept?.unavailable ?? 0];
  let shown = 0;
  for (const runId of kept?.runs ?? []) {
    const run = store.getRun(runId);
    if (!run) {
      into.gone++;
      continue;
    }
    const { verdict } = attemptVerdict({ status: run.status, checks: run.meta?.checks ?? [] });
    if (verdict !== 'passed' && (cut || retried) && providerUnavailable(runCalls(store, runId))) {
      if (!cut) continue;
      into.attempts.push({ runId, href: runHref(runId), outcome: 'inconclusive', note: retried ? 'the provider was unavailable' : apartWords('cutShort') });
    } else {
      const outcome = verdict === 'passed' ? 'passed' : verdict === 'inconclusive' ? 'inconclusive' : 'failed';
      into.attempts.push({ runId, href: runHref(runId), outcome, note: outcome === 'passed' ? null : attemptNote(false, undefined, run, outcome) });
    }
    shown++;
  }
  return shown;
}

/** A golden's newest result's attempts: those of the sessions it continued, oldest first, then its own. */
export function goldenEvidence(store: EvidenceStore, r: TestResult): TestEvidence {
  const out: TestEvidence = { attempts: [], carried: 0, gone: 0 };
  const sessions = r.data?.continued?.sessions ?? [];
  const earlier = new Map(store.listTestResults({ sessionIds: sessions, golden: r.golden }).map((x) => [x.sessionId, x]));
  for (const id of sessions) {
    const x = earlier.get(id);
    if (x) out.carried += judgeRuns(store, x, out);
  }
  judgeRuns(store, r, out);
  return out;
}

/** The pooled read: the golden's newest result, which the route already found on disk; a 404 for one no gate decided. */
export const TESTS_EVIDENCE_READS: ReadTable<TestsEvidenceJob> = {
  'tests-evidence': (store, job) => {
    const r = store.listTestResults({ golden: job.golden, limit: 1 })[0];
    if (!r?.data?.gate || r.data.gate.clean) return failed(404, `${job.golden} has no result a gate decided`);
    return answer(goldenEvidence(store, r));
  },
};
