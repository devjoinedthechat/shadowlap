/**
 * Reads of other projects' stores from their files, beside the server: the switcher's counts and a
 * project's setup (read-jobs.ts `store-facts`) and a link into another project (cross-project.ts
 * `held-by`), each worked out on a thread of the current project, which opens each store read-only,
 * reads it and closes it. A project removed meanwhile waits for each such read of its store to end,
 * as it waits for its store's own threads (ProjectHost.holdStores, server.ts): Also delete its
 * recordings never deletes a file one of them has open, and the read itself, asked after the project
 * left the list, never names it (the routes read the list each time).
 */

/** What a removal waits on: the projects a dashboard serves (engine `ProjectHost`). */
interface Holds {
  holdStores(letGo: (dbPath: string) => Promise<void>): () => void;
}

/** The reads running now, by the store each reads, for each dashboard's projects. */
const running = new WeakMap<Holds, Map<string, Set<Promise<void>>>>();

/**
 * Runs `read`, which reads the stores at `dbPaths` (null: the current project's own, which its threads
 * hold already) beside the server: until it ends, a removal of one of their projects waits.
 */
export function readingStores<T>(host: Holds, dbPaths: ReadonlyArray<string | null>, read: () => Promise<T>): Promise<T> {
  let reads = running.get(host);
  if (!reads) {
    const byPath = new Map<string, Set<Promise<void>>>();
    running.set(host, (reads = byPath));
    host.holdStores((dbPath) => Promise.all([...(byPath.get(dbPath) ?? [])]).then(() => undefined));
  }
  const answered = read();
  const ended = answered.then(
    () => undefined,
    () => undefined,
  );
  for (const path of new Set(dbPaths)) {
    if (path === null) continue;
    const now = reads.get(path) ?? new Set<Promise<void>>();
    reads.set(path, now.add(ended));
    void ended.then(() => {
      now.delete(ended);
      if (!now.size && reads.get(path) === now) reads.delete(path);
    });
  }
  return answered;
}
