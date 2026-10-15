/**
 * The seven origins every view colours a call by. The store keeps five (live, replayed, blocked,
 * stubbed, overridden); the server adds `injected` for a call Shadowlap answered with `--fail-at`,
 * and a live call that ended in an error is drawn as `failed`. No DOM here: the tests import it.
 */

export type Origin7 = 'rep' | 'live' | 'over' | 'inject' | 'fail' | 'block' | 'stub';

/** Legend order. */
export const ORIGINS: readonly Origin7[] = ['rep', 'live', 'over', 'inject', 'fail', 'block', 'stub'];

export const ORIGIN_NAME: Record<Origin7, string> = {
  rep: 'replayed',
  live: 'live',
  over: 'overridden',
  inject: 'injected',
  fail: 'failed',
  block: 'blocked',
  stub: 'stubbed',
};

/** The colour token each origin is drawn in, for hover cards and legends. */
export const ORIGIN_COLOR: Record<Origin7, string> = {
  rep: 'var(--o-rep)',
  live: 'var(--o-live)',
  over: 'var(--o-over)',
  inject: 'var(--o-inject)',
  fail: 'var(--o-fail)',
  block: 'var(--o-block)',
  stub: 'var(--o-stub)',
};

/** Which origin a range of calls shows: the rarest wins, so one blocked write among replayed calls stays visible. */
export const ORIGIN_RANK: Record<Origin7, number> = { fail: 7, inject: 6, block: 5, stub: 4, over: 3, live: 2, rep: 1 };

const STORE_NAMES: Record<string, Origin7> = {
  replayed: 'rep',
  live: 'live',
  overridden: 'over',
  injected: 'inject',
  failed: 'fail',
  blocked: 'block',
  stubbed: 'stub',
};

/**
 * One character per call in a run's compact origin string (`RunListItem.origins`):
 * r replayed, l live, o overridden, i injected, f failed, b blocked, s stubbed.
 */
export const ORIGIN_CODE: Record<string, Origin7> = { r: 'rep', l: 'live', o: 'over', i: 'inject', f: 'fail', b: 'block', s: 'stub' };

export interface OriginCall {
  origin: string;
  outcome?: 'ok' | 'error' | null;
}

/**
 * Whether a call actually went wrong. A fenced write ends in an error so the agent's tool call
 * throws, but nothing failed: Shadowlap refused it on purpose, and its own colour already says so.
 * An injected failure is its own origin.
 */
export function isFailure(c: OriginCall): boolean {
  return c.outcome === 'error' && c.origin !== 'blocked' && c.origin !== 'stubbed' && c.origin !== 'injected';
}

/** The origin a call is drawn as. */
export function displayOrigin(c: OriginCall): Origin7 {
  const o = STORE_NAMES[c.origin] ?? (ORIGINS.includes(c.origin as Origin7) ? (c.origin as Origin7) : 'live');
  if (o === 'live' && c.outcome === 'error') return 'fail';
  return o;
}

/**
 * A run's origins as the API sends them: a compact string (one character per call), or an array of
 * names. Null when absent or unreadable, so a view falls back to what it can show without them.
 */
export function parseOrigins(v: unknown): Origin7[] | null {
  if (typeof v === 'string') {
    const out: Origin7[] = [];
    for (const ch of v) {
      const o = ORIGIN_CODE[ch];
      if (!o) return null;
      out.push(o);
    }
    return out;
  }
  if (Array.isArray(v)) {
    const out: Origin7[] = [];
    for (const x of v) {
      if (typeof x !== 'string') return null;
      const o = STORE_NAMES[x] ?? (ORIGINS.includes(x as Origin7) ? (x as Origin7) : undefined);
      if (!o) return null;
      out.push(o);
    }
    return out;
  }
  return null;
}

export type OriginCounts = Record<Origin7, number>;

export function emptyCounts(): OriginCounts {
  return { rep: 0, live: 0, over: 0, inject: 0, fail: 0, block: 0, stub: 0 };
}

export function countOrigins(list: Iterable<Origin7>): OriginCounts {
  const n = emptyCounts();
  for (const o of list) n[o]++;
  return n;
}

/** The origins present, in legend order. */
export function presentOrigins(counts: OriginCounts): Origin7[] {
  return ORIGINS.filter((o) => counts[o] > 0);
}
