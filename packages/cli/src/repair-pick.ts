import { riskPercent } from '@shadowlap/engine';

/**
 * Which candidate `shadowlap repair` keeps. Candidates are verified one at a time, smallest first, and
 * the first the gate accepts is verified once more, with fresh attempts, in a worktree of its own: it
 * is kept only if it passes again. One that doesn't is rejected, and the next is tried.
 *
 * Why twice. One verify accepts a bad candidate (one that leaves a failing run at the gate's `bad` or
 * below, or breaks a good run) at most `risk` of the time; but the first of several to pass is likelier
 * than any one of them to have passed by chance. Of four candidates each just short of fixing the run
 * (70% under the default gate), one passes 16% of the time at 5% risk. The second verify knows nothing
 * of the first, so a bad candidate passes both at most risk² of the time, and the chance that any bad
 * one is kept, summed over the candidates verify decides, is at most decided · risk², within `risk`
 * while no more than 1/risk are decided: past ⌊1/risk⌋ (20 at 5%), none is tried. A fixed count
 * (`--attempts`, `--passes`) states no risk and has no limit. The figures are worked out exactly, on a
 * grid, in test/repair-pick.test.ts.
 */

/** What verify made of a candidate: `undecided` when no gate decided it (an edit that couldn't be applied, a build that failed). */
export type Verified = 'accepted' | 'rejected' | 'undecided';

export interface Picking<C> {
  /** Verifies the candidate with fresh attempts: `again` is its second verify, after the gate accepted it once. */
  verify: (c: C, again: boolean) => Promise<Verified>;
  /** Whether the repair stops before the next verify: Ctrl-C, the budget spent, a provider that stays unavailable. */
  stopped: () => boolean;
}

/** The most candidates verify may decide at `risk` and keep a bad one within it: ⌊1/risk⌋, or no limit without one. */
export function mostDecided(risk: number | null): number {
  if (!risk) return Infinity;
  // A hair of slack: a risk written as a decimal that floating point holds a hair above it (0.1 is
  // 0.1000000000000000055) still allows its whole 1/risk.
  return Math.max(1, Math.floor(1 / risk + 1e-9));
}

/** Why a candidate past the limit was never tried, and the warning that says how many were left so. */
export function untriedWords(most: number, risk: number, left: number): { reason: string; warning: string } {
  return {
    reason: `not tried: ${most} candidates were decided, the most a repair verifies at ${riskPercent(risk)} risk`,
    warning: `${left} candidate${left === 1 ? ' was' : 's were'} left untried: at ${riskPercent(risk)} risk a repair decides ${most} at most, so the chance it keeps a bad fix stays within that risk`,
  };
}

/**
 * Picks across the lists a repair tries in turn (the fix that needs no model, then the repairer's), so
 * the limit counts every candidate decided, whichever list it came from.
 */
export class CandidatePicker<C> {
  /** The candidates a first verify decided, accepted or not: what the limit counts. */
  decided = 0;
  /** The one kept: the gate accepted it twice. */
  kept: C | null = null;
  /** One the gate accepted once that the repair stopped before verifying again: it is not kept. */
  unconfirmed: C | null = null;
  readonly most: number;

  constructor(risk: number | null) {
    this.most = mostDecided(risk);
  }

  /** Whether another candidate may be tried: none is kept, and the limit isn't reached. */
  get open(): boolean {
    return !this.kept && this.decided < this.most;
  }

  /** Tries `ordered` in turn until one is kept, the repair stops, or the limit is reached. */
  async pick(ordered: readonly C[], o: Picking<C>): Promise<C | null> {
    for (const c of ordered) {
      if (!this.open || o.stopped()) break;
      const first = await o.verify(c, false);
      if (first === 'undecided') continue;
      this.decided++;
      if (first === 'rejected') continue;
      if (o.stopped()) {
        this.unconfirmed = c;
        break;
      }
      if ((await o.verify(c, true)) === 'accepted') this.kept = c;
    }
    return this.kept;
  }
}
