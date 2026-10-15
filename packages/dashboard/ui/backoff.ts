/**
 * How long the dashboard waits before trying the server again while it cannot reach it: 5, 10, 20,
 * then every 30 seconds. No DOM here: the tests import it.
 */

export const BACKOFF_SECONDS: readonly number[] = [5, 10, 20, 30];

/** The wait before retry number `attempt` (0 for the first). */
export function backoffSeconds(attempt: number): number {
  const i = Math.max(0, Math.min(Math.floor(attempt), BACKOFF_SECONDS.length - 1));
  return BACKOFF_SECONDS[i]!;
}

/** Whether a failed request means the server is gone, rather than that it answered with an error. */
export function isUnreachable(err: unknown): boolean {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status: unknown }).status;
    return status === 0 || status === 502 || status === 503 || status === 504;
  }
  // fetch rejects with a TypeError when nothing answered at all.
  return err instanceof TypeError;
}
