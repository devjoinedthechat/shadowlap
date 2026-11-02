import { statSync } from 'node:fs';
import { Store, tildePath } from '@shadowlap/engine';
import { storeKeeper } from './keeper.js';
import { LocalReads, ReadPool, type ReadModels } from './read-pool.js';
import { LocalSearch, SearchIndexer, type SearchIndex } from './search-index.js';

/**
 * The store files a dashboard serves, and what reads each beside the server's thread: one set of
 * threads per store file, shared by a project's route instances; a store in memory is read on the
 * server's thread.
 *
 * - The read models (read-pool.ts). What the threads work out to keep (run totals, what users
 *   asked), a thread of its own writes, with a connection of its own (keeper.ts): this one only
 *   hands the rows over. While another command holds the store's write lock (a batch of the search
 *   index, gc's VACUUM, a pull) the rows wait there, and are written once it lets go.
 * - The search index, brought up to date beside the requests (search-index.ts); a store in memory's
 *   on this thread, while it answers no request.
 *
 * A store deleted while served (its folder removed, the file replaced by another) went on being read
 * through the connections open to the old file, each its own state: the status bar said 0 runs and
 * Runs 10,000, and the search index's thread spun on the deleted file. So each file is known by the
 * device and inode it was when the dashboard first read it, asked on every request and every few
 * seconds for the threads, which let go of a file that moved.
 */
export class StoreFiles {
  private readonly pools = new Map<string, ReadPool>();
  private readonly keepers = new Map<string, ReturnType<typeof storeKeeper>>();
  private readonly indexers = new Map<string, SearchIndexer>();
  private readonly locals = new Set<LocalReads>();
  /** Each store file served, by its path: its device and inode when the dashboard first read it. */
  private readonly files = new Map<string, string>();
  /** How many times each store file was opened again after it was replaced. */
  private readonly generations = new Map<string, number>();
  /** What a project whose store can't be opened is served from: empty, in memory, shared by every such project. */
  private standIn: Store | null = null;
  private readonly watch: ReturnType<typeof setInterval>;

  /** `realHome`: the home folder paths are shown from (`~/…`); `several`: the dashboard serves several projects. */
  constructor(private readonly o: { log: (line: string) => void; realHome: string; several: boolean }) {
    // The threads of a store deleted or replaced stop reading it, requests or none.
    this.watch = setInterval(() => {
      for (const path of new Set([...this.pools.keys(), ...this.indexers.keys()])) if (this.moved(path)) void this.letGo(path);
    }, 5000);
    this.watch.unref();
  }

  private identity(path: string): string | null {
    try {
      const st = statSync(path);
      return `${st.dev}:${st.ino}`;
    } catch {
      return null;
    }
  }

  /** Whether the store at `path` is still the file the dashboard read: 'deleted', 'replaced' by another, or null. */
  moved(path: string | null | undefined): 'deleted' | 'replaced' | null {
    if (!path || path === ':memory:') return null;
    const now = this.identity(path);
    const was = this.files.get(path);
    if (was === undefined) {
      if (now) this.files.set(path, now);
      return null;
    }
    return now === null ? 'deleted' : now === was ? null : 'replaced';
  }

  /** The file at `path`, which replaced the store the dashboard read, is the store there from now on: a new generation of it. */
  reopened(path: string): void {
    this.files.set(path, this.identity(path)!);
    this.generations.set(path, this.generation(path) + 1);
  }

  /** How many times the store file at `path` was found replaced and opened again. */
  generation(path: string): number {
    return this.generations.get(path) ?? 0;
  }

  /**
   * Lets go of the threads reading the store at `path`, which would go on reading the old file, or
   * whose project was removed: done once each has closed its connection to the store, or was ended.
   */
  letGo(path: string): Promise<void> {
    const closing: Array<Promise<void>> = [];
    const pool = this.pools.get(path);
    if (pool) {
      this.pools.delete(path);
      closing.push(pool.close());
    }
    const keeper = this.keepers.get(path);
    if (keeper) closing.push(keeper.close());
    this.keepers.delete(path);
    const indexer = this.indexers.get(path);
    if (indexer) {
      this.indexers.delete(path);
      closing.push(indexer.close());
    }
    return Promise.all(closing).then(() => undefined);
  }

  /** What the pages say of a store moved from under the dashboard. */
  movedWords(how: 'deleted' | 'replaced', path: string, name: string | null): string {
    const shown = tildePath(path, this.o.realHome);
    return how === 'deleted'
      ? `${name ? `${name}’s store` : 'The store'} (${shown}) was deleted while the dashboard served it: record a run to make a new one${this.o.several ? '' : ', then start the dashboard again'}`
      : `The store (${shown}) was replaced by another file while the dashboard served it: start the dashboard again to read it`;
  }

  /** The read models of the store at `dbPath`: its file's threads, or the server's own for a store in memory. */
  reads(dbPath: string | null | undefined, store: () => Store): ReadModels {
    this.moved(dbPath);
    if (!dbPath || dbPath === ':memory:') {
      const local = new LocalReads(store);
      this.locals.add(local);
      return local;
    }
    let pool = this.pools.get(dbPath);
    if (!pool) {
      const keep = storeKeeper(dbPath, { log: this.o.log });
      void this.keepers.get(dbPath)?.close();
      this.keepers.set(dbPath, keep);
      pool = new ReadPool({ dbPath, keep, log: this.o.log });
      this.pools.set(dbPath, pool);
    }
    return pool;
  }

  /** The search index of the store at `dbPath`: its file's thread, or the server's own for a store in memory. */
  search(dbPath: string | null | undefined, store: () => Store): SearchIndex {
    if (!dbPath || dbPath === ':memory:') return new LocalSearch(store);
    let indexer = this.indexers.get(dbPath);
    if (!indexer) this.indexers.set(dbPath, (indexer = new SearchIndexer({ dbPath, log: this.o.log })));
    return indexer;
  }

  standInStore(): Store {
    return (this.standIn ??= Store.open(':memory:'));
  }

  /** Stops looking for stores moved from under the dashboard, which is closing. */
  stopWatching(): void {
    clearInterval(this.watch);
  }

  /**
   * Ends what reads the stores: the read models' threads close their connections to the store before
   * they end; what the keepers' threads hold is written, as far as the store lets it, before they end.
   */
  async close(): Promise<void> {
    await Promise.all([...this.pools.values(), ...this.locals, ...this.indexers.values()].map((r) => r.close()));
    await Promise.all([...this.keepers.values()].map((keep) => keep.close()));
    this.standIn?.close();
  }
}
