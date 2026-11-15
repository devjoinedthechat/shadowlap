import { FixIdError, lookupRun, resolveFix, Store } from '@shadowlap/engine';
import { ambiguousRunId } from './api.js';
import { answer, type ReadTable } from './read-registry.js';

/**
 * Which other project holds a run, a fix, a preview or a migration this one doesn't, so a link from
 * another project (a job's, a pasted address, the browser's history) can say where it is: the In
 * page, with Switch to (ui/pages/Elsewhere.tsx). Worked out beside the server (`held-by`), since it
 * opens other projects' stores, each from its file, read-only, by the engine's own lookups: a run by
 * its whole id or a unique prefix (`lookupRun`), a fix the same way (`resolveFix`), a preview or a
 * migration by its id and kind. Nothing is created, migrated or written in another store, and each
 * is closed before the next is opened: `Store.openReadOnly` refuses one that isn't a regular file of
 * this user's, or was written by a newer shadowlap, and SQLite any write.
 *
 * Each id the address names is looked for in turn. One this project holds, or that names several of
 * its runs or fixes at once, isn't asked of the others: its own page says what it is. Otherwise the
 * first project in the list's order whose store holds it answers, with the id as the address had it;
 * a store that can't be read (an older one without the table, a newer one, a file that isn't a
 * store) holds nothing. The route lists the stores (routes/cross-project.ts): the projects on the
 * list but the current one, whose folder and store are on disk.
 */

/** What a link can name that another project's store may hold. */
export type HeldWhat = 'run' | 'fix' | 'preview' | 'migration';

export const HELD_WHATS: readonly HeldWhat[] = ['run', 'fix', 'preview', 'migration'];

/** A project and its store, as the route lists them. */
export interface OtherStore {
  id: string;
  name: string;
  dbPath: string;
}

/** The project that holds what was asked, and the id it holds, as the address had it; null when none does. */
export interface Held {
  held: { project: { id: string; name: string }; id: string } | null;
}

/** What `GET /api/projects/holding` answers: the project the dashboard serves now, and the one that holds what was asked. */
export interface HoldingView extends Held {
  current: { id: string; name: string };
}

export type CrossProjectJob = { kind: 'held-by'; what: HeldWhat; ids: string[]; stores: OtherStore[] };

/** The session kind each of a preview and a migration is (decisions.ts). */
const SESSION_KIND = { preview: 'decisions', migration: 'migrate' } as const;

/** Whether `store` holds the item, by the engine's lookup of its kind; an ambiguous fix prefix throws. */
function finds(store: Store, what: HeldWhat, id: string): boolean {
  if (what === 'run') return lookupRun(store, id) !== null;
  if (what === 'fix') return resolveFix(store, id) !== null;
  return store.getDecisionSession(id)?.kind === SESSION_KIND[what];
}

/** Whether this project's own page answers for the id: it holds it, or it names several of its runs or fixes. */
function answersHere(store: Store, what: HeldWhat, id: string): boolean {
  try {
    return finds(store, what, id) || (what === 'run' && ambiguousRunId(store, id));
  } catch (err) {
    // A fix prefix several fixes here start with: the fix page says so.
    return err instanceof FixIdError;
  }
}

/** Whether another project's store, opened read-only from its file and closed again, holds the item. */
function holdsIn(dbPath: string, what: HeldWhat, id: string): boolean {
  let other: Store;
  try {
    other = Store.openReadOnly(dbPath);
  } catch {
    return false;
  }
  try {
    return finds(other, what, id);
  } catch {
    // An older store without the table, or a prefix several of its fixes start with.
    return false;
  } finally {
    other.close();
  }
}

/** The first project, in the list's order, that holds an id the address names, the first id first. */
export function heldBy(store: Store, job: Omit<CrossProjectJob, 'kind'>): Held {
  for (const id of job.ids) {
    if (answersHere(store, job.what, id)) continue;
    const holder = job.stores.find((s) => holdsIn(s.dbPath, job.what, id));
    if (holder) return { held: { project: { id: holder.id, name: holder.name }, id } };
  }
  return { held: null };
}

export const CROSS_PROJECT_READS: ReadTable<CrossProjectJob> = {
  'held-by': (store, job) => answer(heldBy(store, job)),
};
