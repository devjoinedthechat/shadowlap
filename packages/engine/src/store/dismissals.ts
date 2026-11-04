/**
 * Dismissals (v6): the advice Needs a look shows that whoever keeps this store put away
 * (dismissals), each by the advice's key, with the facts it stated then, when, and who. The
 * dashboard's server says which items are advice, with their keys and facts; a failure is never
 * one. Kept in this store alone, so it is per project and its owner's: a push and a pull leave it
 * out (packages/remote), and nobody's Dismiss changes what a teammate sees.
 */
import { parseJsonColumn, StorePart } from './core.js';

// ---- dismissals (v6): the shape of the dismissals table ----

/** An advice item put away, with what it said when it was. */
export interface StoredDismissal {
  /** The advice's key, the same for as long as it is the same advice: `coverage`, `local`, `retire <model>`. */
  key: string;
  /**
   * The facts it stated, each once: a date, a behaviour's key, a run's id, a golden. It stays put
   * away while every fact it states is one of these (stillDismissed).
   */
  facts: string[];
  /** When it was put away, and who put it away (resolveAuthor). */
  at: number;
  actor: string | null;
}

export type NewDismissal = Pick<StoredDismissal, 'key' | 'facts'> & Partial<Pick<StoredDismissal, 'at' | 'actor'>>;

export abstract class Dismissals extends StorePart {
  // ---- dismissals (v6): what Needs a look's advice its owner put away ----

  /**
   * Puts an advice item away with the facts it states, in place of what was kept for its key: Dismiss,
   * and Undo of a Dismiss, which writes back the facts kept before it. A fact given twice is kept once.
   */
  putDismissal(input: NewDismissal): StoredDismissal {
    if (!input.key) throw new Error('a dismissal needs the key of the advice it puts away');
    const dismissal: StoredDismissal = { key: input.key, facts: [...new Set(input.facts)], at: input.at ?? Date.now(), actor: input.actor ?? null };
    this.db.prepare(`INSERT OR REPLACE INTO dismissals (key, facts, at, actor) VALUES (?, ?, ?, ?)`).run(dismissal.key, JSON.stringify(dismissal.facts), dismissal.at, dismissal.actor);
    return dismissal;
  }

  /** What was kept when the advice under `key` was put away, or null while it is not. */
  getDismissal(key: string): StoredDismissal | null {
    const row = this.db.prepare(`SELECT * FROM dismissals WHERE key = ?`).get(key);
    return row ? rowToDismissal(row) : null;
  }

  /** Every advice item put away, the most recent first. */
  listDismissals(): StoredDismissal[] {
    return this.db.prepare(`SELECT * FROM dismissals ORDER BY at DESC, key ASC`).all().map(rowToDismissal);
  }

  /** Brings the advice under `key` back (Restore, and Undo of a first Dismiss): false when it wasn't put away. */
  deleteDismissal(key: string): boolean {
    return Number(this.db.prepare(`DELETE FROM dismissals WHERE key = ?`).run(key).changes) > 0;
  }
}

/**
 * Whether advice stating `facts` now stays put away by what was kept for it: while every fact it
 * states is one of those kept, so only a new fact brings it back, and one that went away never does.
 * Never when nothing was kept.
 */
export function stillDismissed(kept: Pick<StoredDismissal, 'facts'> | null, facts: readonly string[]): boolean {
  if (!kept) return false;
  const known = new Set(kept.facts);
  return facts.every((f) => known.has(f));
}

function rowToDismissal(row: Record<string, unknown>): StoredDismissal {
  const facts = parseJsonColumn<unknown>(row.facts, []);
  return {
    key: String(row.key),
    facts: Array.isArray(facts) ? facts.filter((f): f is string => typeof f === 'string') : [],
    at: Number(row.at),
    actor: row.actor === null || row.actor === undefined ? null : String(row.actor),
  };
}
