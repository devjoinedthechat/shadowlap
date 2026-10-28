import { retryDelay, type Unavailable } from '@shadowlap/engine';

/**
 * How a run of attempts treats its provider being unavailable, one attempt at a time, as `shadowlap
 * test` and `test --chaos` run a golden's (blame and verify run theirs through attempts.ts, which does
 * the same): every attempt the provider was unavailable for is followed by a pause, what its
 * `retry-after` asked or 5 s, then 15 s; `inARow` of them in a row stop the run, with the provider
 * named. One it failed before the model answered is run again, never counted: it says nothing of how
 * the attempt would have gone. One it cut short after the model answered may have failed with the
 * course the attempt took, so where a gate decides (`count`) it is counted, against either verdict
 * (the engine's `decideUnavailable`); a fixed count runs it again.
 */
/**
 * Unavailable attempts in a row across a test session, whichever goldens ran them, or a chaos
 * session, whichever presets: shared by their ProviderRetry, so one's success resets it, and
 * `limit` of them stop the session (`sessionInARow`): the provider is down for all of them alike.
 */
export class ProviderStreak {
  inARow = 0;
  /** The provider's failure that stopped the session, once `limit` came in a row. */
  gaveUp: Unavailable | null = null;
  constructor(readonly limit: number) {}
}

export class ProviderRetry {
  /** Attempts the provider was unavailable for that are never counted, the one that stopped the run included. */
  unavailable = 0;
  /** Attempts the provider cut short that are counted against either verdict. */
  cutShort = 0;
  /** Unavailable in a row, up to the last attempt. */
  inARow = 0;
  /** The provider's failure that stopped the run, once `inARow` came in a row. */
  gaveUp: Unavailable | null = null;

  constructor(private readonly o: { retry: { inARow: number; firstDelayMs: number; maxDelayMs: number }; sleep: (ms: number) => Promise<void>; onUnavailable?: ((u: Unavailable, waitMs: number, counted: boolean) => void) | undefined; count: boolean; streak?: ProviderStreak | null | undefined }) {}

  /**
   * What to do with an attempt that just ended, given what the provider did in it (`down`: null when
   * it answered): count it as it came out (`counted`), count it cut short (`cut`), run another in its
   * place (`retry`), or stop (`stop`). Every outcome but `counted` and `stop` comes after the pause.
   */
  async after(down: Unavailable | null): Promise<'counted' | 'cut' | 'retry' | 'stop'> {
    const streak = this.o.streak;
    if (!down) {
      this.inARow = 0;
      if (streak) streak.inARow = 0;
      return 'counted';
    }
    this.inARow++;
    // In a row across the session when a streak is shared, else this run's own.
    const run = streak ? ++streak.inARow : this.inARow;
    if (run >= (streak ? streak.limit : this.o.retry.inARow)) {
      this.unavailable++;
      this.gaveUp = down;
      if (streak) streak.gaveUp = down;
      return 'stop';
    }
    const wait = retryDelay(run, down.retryAfterMs, Math.random, this.o.retry);
    this.o.onUnavailable?.(down, wait, this.o.count && !down.early);
    await this.o.sleep(wait);
    if (this.o.count && !down.early) {
      this.cutShort++;
      return 'cut';
    }
    this.unavailable++;
    return 'retry';
  }
}

/**
 * What a line says of an attempt the provider was unavailable for: `the provider was unavailable
 * (HTTP 529 from anthropic at call #3), so that attempt isn't counted`, or, for one it cut short that
 * a gate counts, `the provider cut that attempt short (…), so it is counted against either verdict`.
 */
export function unavailableWords(u: Unavailable, counted: boolean): string {
  return counted ? `the provider cut that attempt short (${u.reason}), so it is counted against either verdict` : `the provider was unavailable (${u.reason}), so that attempt isn't counted`;
}
