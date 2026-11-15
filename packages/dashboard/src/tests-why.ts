import { GATE_TOO_LITTLE, plural, testResultVerdict, unavailableStop, type TestResult } from '@shadowlap/engine';

/**
 * Why a golden's result failed or is inconclusive, in the few words Tests' verdict and the activity
 * feed give it. What the provider did is said as the provider's, never as a check's.
 */

/** How a fixed count's reason starts when the attempts the provider cut short decide it either way (golden-test.ts failureOf). */
const CUT_DECIDES = /^inconclusive: \d+ of \d+ attempts passed, (\d+) of them cut short by the provider, /;

/**
 * Its injection gate showed too little; the provider unavailable too many attempts in a row, which
 * stopped it while its gate or count was open, or stopped the session before it ran; attempts the
 * provider cut short that decide its count either way; else a check could not be judged (which stops
 * a gate before it decides).
 */
export function undecidedWhy(r: Pick<TestResult, 'failure' | 'reason'>): string {
  if (r.failure === 'injection') return GATE_TOO_LITTLE;
  if (unavailableStop(r.reason)) return 'the provider was unavailable';
  const cut = CUT_DECIDES.exec(r.reason ?? '');
  if (cut) return `${plural(Number(cut[1]), 'attempt')} cut short by the provider`;
  return 'a check could not be judged';
}

/** The reason a replay failed under --guard block for a process the guard can't watch (the sidecar's unguardedLine). */
const UNGUARDED = /^The network guard could not watch every process of the agent/;

/** Why a result failed, in a few words: `diverged at call 1`, `check failed: send_email called 0 times`, `inconclusive after 40 attempts`. */
export function shortReason(r: TestResult): string {
  if (r.ok) return 'passed';
  // Its gate ran out of attempts; else what left it undecided.
  if (testResultVerdict(r) === 'inconclusive') return r.data?.gate?.decision === 'inconclusive' ? `inconclusive after ${r.data.gate.attempts} attempts` : `inconclusive: ${undecidedWhy(r)}`;
  const reason = r.reason ?? 'failed';
  if (r.failure === 'diverged') return r.data?.divergence ? `diverged at call ${r.data.divergence.callNo}` : reason.replace(/\s*\(.*\)$/, '');
  if (r.failure === 'check') return reason.replace(/, but .*$/, '');
  if (r.failure === 'exit') return /exited with code \d+/.exec(reason)?.[0] ?? reason.replace(/^the agent /, '');
  if (r.failure === 'no-calls') return 'made no calls';
  // Under --guard block, a replay no preload loaded in, so the guard never watched it; or one a
  // process ran in that the guard can't watch, as the Claude Code CLI the Claude Agent SDK runs.
  if (r.failure === 'guard') return UNGUARDED.test(reason) ? 'unguarded: a process the network guard can’t watch ran' : 'no preload loaded: the network guard never watched it';
  // Its injection gate: what obeyed, without the limit and the proof the reason goes on with.
  if (r.failure === 'injection') return reason.replace(/ \(at most[^)]*\).*$/, '');
  return `couldn't run: ${reason}`;
}
