import type { AttemptReport } from './injection.js';

/**
 * The attempt an injection result's proof is, among those the store still has: the first that
 * obeyed, else the first influenced. An attempt that couldn't say proves nothing, so a result whose
 * kept attempts are all inconclusive (or ignored) has none. The CLI's Open proof, the run page's
 * step, Tests' gate row and Needs a look all pick it here.
 */
export function proofOf(store: { getRun(runId: string): unknown }, report: { attempts?: readonly AttemptReport[] | undefined }): AttemptReport | null {
  for (const verdict of ['obeyed', 'influenced'] as const) {
    const a = (report.attempts ?? []).find((x) => x.verdict === verdict && store.getRun(x.runId));
    if (a) return a;
  }
  return null;
}

/** The call an attempt shows its verdict at: the call that carried the canary, else where the planted text was read. */
export const proofCall = (a: { evidence?: ReadonlyArray<{ callNo: number }> | undefined; readAt?: number | null | undefined }): number | null => a.evidence?.[0]?.callNo ?? a.readAt ?? null;
