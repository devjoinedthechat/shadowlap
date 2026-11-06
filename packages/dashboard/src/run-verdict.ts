/**
 * A run's verdict as its Status says it (ui/runs.ts `outcomeOf`), in the five words the filter
 * field's `status:` reads: still recording (`live`), `failed`, `inconclusive`, `passed`, or `not
 * applicable`; none for a run nothing judges (a dash, a fork's writes, an interruption) and for a
 * failed test replay its golden's next replay passed (`fixed by <run>`). The server's filter and the
 * page's Status read the same rules here, so the two can't tell a run apart. No Node import: the
 * page's script imports it.
 */

export type RunVerdict = 'live' | 'failed' | 'inconclusive' | 'passed' | 'not-applicable';

/** What judged a run besides its outcome (run-outcome.ts `RunJudged`): who, and the verdict. */
export interface VerdictJudged {
  by: 'own' | 'import' | 'family';
  verdict: 'passed' | 'failed' | 'inconclusive' | 'not-applicable';
}

/** The fields of a run its verdict reads: a list row's, a run's page's or the index's. */
export interface VerdictRun {
  status: string;
  /** How the server classified it (engine `runOutcome`); absent from a run an older server listed. */
  outcome?: { kind: string; callNo?: number; checks?: number; check?: string | null } | null;
  judged?: VerdictJudged | null;
  fixedBy?: string | null;
  /** What a run with no outcome is read by, as outcomeOf reads it. */
  divergence?: { callNo: number } | null;
  test?: unknown;
  blame?: { callNo: number | null } | null;
  checks?: { passed: number; total: number; inconclusive?: number; notApplicable?: number } | null;
}

/**
 * Whether the checks that judged a run say how it came out: not while it records or where a test
 * diverged, nor where the agent's exit failed it with no check of its own failing. A run blame found
 * lost failed its own check, which it names; a family's verdict never stands for a run's own failure.
 */
export function judgedDecides(o: VerdictRun['outcome'], j: VerdictJudged): boolean {
  if (!o || o.kind === 'none' || o.kind === 'clean' || o.kind === 'passed' || o.kind === 'inconclusive') return true;
  return j.by === 'own' && j.verdict === 'failed' && (o.kind === 'lost' || (o.kind === 'check-failed' && !!o.check));
}

/** A diverged test replay's call, where its outcome says it diverged, or with none, where it has a divergence. */
function divergedAt(r: VerdictRun): number | null {
  const o = r.outcome;
  if (o) return o.kind === 'diverged' && typeof o.callNo === 'number' ? o.callNo : null;
  return r.test && r.divergence ? r.divergence.callNo : null;
}

/** By its checks, as counted, for a run whose outcome says nothing: failed, inconclusive, passed, or none. */
function byCounts(r: VerdictRun): RunVerdict | null {
  if (r.blame?.callNo) return 'failed';
  const c = r.checks;
  if (c?.total) {
    if (c.total - c.passed - (c.inconclusive ?? 0) - (c.notApplicable ?? 0) > 0) return 'failed';
    if (c.inconclusive) return 'inconclusive';
    return 'passed';
  }
  return r.status === 'failed' ? 'failed' : null;
}

/** By its outcome alone, where no verdict decides: undefined where it says nothing, for what it is counted by. */
function byOutcome(o: NonNullable<VerdictRun['outcome']>): RunVerdict | null | undefined {
  if (o.kind === 'lost' || o.kind === 'check-failed') return 'failed';
  if (o.kind === 'inconclusive') return 'inconclusive';
  if (o.kind === 'passed' && typeof o.checks === 'number') return 'passed';
  if (o.kind === 'clean' || o.kind === 'none') return null;
  return undefined;
}

/**
 * Whether what judged a run can change its verdict (`verdictOf`): not while it records, once a later
 * replay fixed it, or where its outcome has it failed already (diverged, lost, a check that failed),
 * since `judgedDecides` then only ever agrees. So a list's `status:` needs no call of such a run read.
 */
export function judgedCanChange(r: Pick<VerdictRun, 'status' | 'outcome' | 'fixedBy' | 'divergence' | 'test'>): boolean {
  if (r.status === 'running' || r.fixedBy || divergedAt(r) !== null) return false;
  const kind = r.outcome?.kind;
  return kind === undefined || kind === 'none' || kind === 'clean' || kind === 'passed' || kind === 'inconclusive';
}

/** A run's verdict, as its Status says it (see above); null where it says none. */
export function verdictOf(r: VerdictRun): RunVerdict | null {
  if (r.status === 'running' || r.outcome?.kind === 'running') return 'live';
  if (r.fixedBy) return null;
  if (divergedAt(r) !== null) return 'failed';
  if (r.judged && judgedDecides(r.outcome, r.judged)) return r.judged.verdict;
  const said = r.outcome ? byOutcome(r.outcome) : undefined;
  // an interrupted run, a fork's writes and a dash are no verdict
  return said !== undefined ? said : byCounts(r);
}
