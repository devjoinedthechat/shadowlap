import { describe, expect, it } from 'vitest';
import { Revalidation } from '../ui/revalidate.js';

/**
 * The page's answers kept for revalidation: every answer the tab had fetched stayed in memory until
 * the page reloaded, 57 MB after opening sixteen calls with long prompts, still 57 MB on other
 * pages. Now small answers are kept within a count and a size, and large ones only while the page
 * still holds them.
 */

/** Weak references the test lets go of by hand, as the collector would. */
function collector() {
  const held = new Map<object, boolean>();
  return {
    weak: (o: object) => {
      held.set(o, true);
      return { deref: () => (held.get(o) ? o : undefined) };
    },
    collect: (o: object) => held.set(o, false),
  };
}

const limits = { small: 1000, bytes: 3000, entries: 5 };

describe('the answers kept for revalidation', () => {
  it('keeps small answers within a size, the least recently used going first', () => {
    const r = new Revalidation(limits);
    r.set('meta', '"a"', { v: 1 }, 900);
    r.set('runs', '"b"', { v: 2 }, 900);
    r.set('changes', '"c"', { v: 3 }, 900);
    // Asked again: the most recent now.
    expect(r.get('meta')).toEqual({ etag: '"a"', body: { v: 1 } });
    r.set('settings', '"d"', { v: 4 }, 900);
    expect(r.get('runs')).toBeUndefined();
    expect(r.get('meta')?.etag).toBe('"a"');
    expect(r.size.bytes).toBeLessThanOrEqual(limits.bytes);
    // An answer to the same path replaces the one before.
    r.set('meta', '"e"', { v: 5 }, 100);
    expect(r.get('meta')).toEqual({ etag: '"e"', body: { v: 5 } });
  });

  it('keeps no more paths than its count, however small', () => {
    const r = new Revalidation(limits);
    for (let n = 1; n <= 40; n++) r.set(`runs/R?after=${n}`, `"${n}"`, { n }, 10);
    expect(r.size.entries).toBe(limits.entries);
    expect(r.get('runs/R?after=40')?.body).toEqual({ n: 40 });
    expect(r.get('runs/R?after=1')).toBeUndefined();
  });

  it('keeps a large answer only while something else holds it', () => {
    const gc = collector();
    const r = new Revalidation(limits, gc.weak);
    const call = { prompt: 'x'.repeat(10) };
    r.set('runs/R/calls/1', '"c1"', call, 2_000_000);
    // Large answers don't count against the small ones' size.
    expect(r.size.bytes).toBe(0);
    expect(r.get('runs/R/calls/1')?.body).toBe(call);
    gc.collect(call);
    expect(r.get('runs/R/calls/1')).toBeUndefined();
    expect(r.size.entries).toBe(0);
  });

  it('lets go of every call opened once the page has, whatever their number', () => {
    const gc = collector();
    const r = new Revalidation(limits, gc.weak);
    const calls = Array.from({ length: 16 }, (_, i) => ({ n: i + 1 }));
    for (const c of calls) r.set(`runs/HUGE/calls/${c.n}`, `"${c.n}"`, c, 3_000_000);
    expect(r.size.entries).toBe(limits.entries);
    for (const c of calls) gc.collect(c);
    r.set('runs', '"list"', { runs: [] }, 500);
    expect(r.size.entries).toBe(1);
    expect(r.get('runs')?.etag).toBe('"list"');
  });
});
