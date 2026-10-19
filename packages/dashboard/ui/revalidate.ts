/**
 * The last answer to each GET the server tagged (an ETag), so asking again sends If-None-Match and a
 * 304 hands back the same object: nothing redraws. Bounded, so a tab open all day doesn't keep every
 * answer it was ever given. A small answer (the run list, meta, a page of runs, a recording's newest
 * calls) is kept as it is, the most recently used first, within a count and a total size. A large
 * one (a run of thousands of calls, a call with a long prompt, `show --json`) is kept only while the
 * page still holds what was made of it (`holdWhile`): revalidating the run on screen costs nothing
 * more, and once the page lets go of it, it can be collected and its path is asked for afresh.
 */

export interface Kept {
  etag: string;
  body: unknown;
}

interface Entry {
  etag: string;
  /** A small answer, kept as it is. */
  body?: unknown;
  /** A large answer, kept while something else holds it. */
  ref?: { deref(): object | undefined };
  bytes: number;
}

export interface RevalidationLimits {
  /** Past this size an answer is kept only while the page holds what was made of it. */
  small: number;
  /** The small answers kept together, at most. */
  bytes: number;
  /** Paths kept, at most, small and large. */
  entries: number;
}

export const REVALIDATION_LIMITS: RevalidationLimits = { small: 256 * 1024, bytes: 4 * 1024 * 1024, entries: 64 };

type Weak = (o: object) => { deref(): object | undefined };

export class Revalidation {
  private readonly entries = new Map<string, Entry>();
  private smallBytes = 0;

  constructor(
    private readonly limits: RevalidationLimits = REVALIDATION_LIMITS,
    private readonly weak: Weak = (o) => new WeakRef(o),
  ) {}

  /** What was last answered for `path`, when it is still kept. */
  get(path: string): Kept | undefined {
    const e = this.entries.get(path);
    if (!e) return undefined;
    const body = e.ref ? e.ref.deref() : e.body;
    if (body === undefined) {
      this.drop(path, e);
      return undefined;
    }
    // Used again: the most recent.
    this.entries.delete(path);
    this.entries.set(path, e);
    return { etag: e.etag, body };
  }

  /** Keeps `body`, the answer for `path` tagged `etag`, `bytes` long as the server sent it. */
  set(path: string, etag: string, body: unknown, bytes: number): void {
    const had = this.entries.get(path);
    if (had) this.drop(path, had);
    const large = bytes > this.limits.small;
    if (large && (typeof body !== 'object' || body === null)) return;
    const e: Entry = large ? { etag, ref: this.weak(body as object), bytes } : { etag, body, bytes };
    this.entries.set(path, e);
    if (!large) this.smallBytes += bytes;
    // The least recently used go first, the large ones already let go of before anything.
    for (const [p, x] of this.entries) if (x.ref && x.ref.deref() === undefined) this.drop(p, x);
    for (const [p, x] of this.entries) {
      if (this.entries.size <= this.limits.entries && this.smallBytes <= this.limits.bytes) break;
      if (p !== path) this.drop(p, x);
    }
  }

  /** How many paths are kept, and the size of the small answers among them. */
  get size(): { entries: number; bytes: number } {
    return { entries: this.entries.size, bytes: this.smallBytes };
  }

  private drop(path: string, e: Entry): void {
    this.entries.delete(path);
    if (!e.ref) this.smallBytes -= e.bytes;
  }
}

/**
 * What the page made of an answer (`made`, the views' shape of it) keeps the answer itself
 * (`body`): while the page shows it, a large answer stays kept for revalidation; once the page lets
 * go of it, both can be collected.
 */
const holders = new WeakMap<object, object>();
export function holdWhile(made: unknown, body: unknown): void {
  if (made !== body && typeof made === 'object' && made !== null && typeof body === 'object' && body !== null) holders.set(made, body);
}
