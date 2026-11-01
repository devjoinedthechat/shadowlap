import { createHash } from 'node:crypto';
import type { Store } from '@shadowlap/engine';
import type { ReadJob } from './read-jobs.js';

/**
 * The pooled reads by the kind of job each answers: what reads every call of a run, or of every run,
 * worked out on a read-model thread beside the server (read-worker.ts) or, for a store in memory, on
 * the server's own (read-pool.ts `LocalReads`), both from the same tables of handlers.
 *
 * Each feature registers its reads from its own module, as a table: each kind of job it answers,
 * with the handler that answers it. read-jobs.ts lists the tables, its own first. Adding a read is
 * its job and its handler in the feature's table, and a feature's table is one line in that list:
 *
 *   // estimates.ts
 *   import { lookupRun } from './api.js';
 *   import { answer, failed, type ReadTable } from './read-registry.js';
 *
 *   export type EstimateJob = { kind: 'estimate'; runId: string; what: string };
 *
 *   export const ESTIMATE_READS: ReadTable<EstimateJob> = {
 *     estimate: (store, job) => {
 *       const run = lookupRun(store, job.runId);
 *       if (!run) return failed(404, `no run ${job.runId}`);
 *       return answer(estimateOf(store, run, job.what), { tagged: true });
 *     },
 *   };
 *
 *   // read-jobs.ts
 *   const READ_TABLES = [CORE_READS, ESTIMATE_READS] as const;
 *
 * test/read-registry.test.ts asks a job of every kind on a thread and on a store in memory, and wants
 * the same answer from both: a kind registered without a job there fails the tests' type check.
 *
 * A job is plain data, as a thread gets it in a message: what the server reads to ask it (who asks,
 * the project's config, what git says) is read on its own thread first and put in the job. Its route,
 * in routes/<feature>.ts, asks with `ctx.reads.run(job)` and answers with read-pool.ts `sendAnswer`,
 * and the job is checked there as its handler takes it. A kind two tables register stops the
 * dashboard as it loads.
 *
 * This module loads nothing of the dashboard's, so the module of any feature can register reads. A
 * table's module loads neither read-jobs.ts nor read-pool.ts, which load it.
 */

export interface ReadAnswer {
  status: number;
  /** The answer as JSON text. */
  body: string;
  /** For an answer a browser may keep and ask about again: its ETag; null for one it must not keep (a warming answer, the Overview). */
  etag: string | null;
  /** Set when the answer is not whole yet and says so (`warming`): asked again, it has more. */
  warming?: boolean;
  /** Work for beside the server once this is answered: the whole analysis of a long run answered from its first calls. */
  then?: ReadJob;
  /** A warm-up slice: whether it has been through every run, and how far it has gone. */
  warm?: { done: boolean; walked: number; total: number };
}

/**
 * Works out one kind of job against `store`. Never throws for what the job asks: a bad request or a
 * missing run is its answer (`failed`), and a RangeError it throws (a cursor or a time zone a read
 * model doesn't know) is answered 400. `whole`: work out what isn't known yet rather than answer with
 * how far the warm-up has got, as for a store in memory, whose read models run on the server's own
 * thread anyway.
 */
export type ReadHandler<J> = (store: Store, job: J, o: { whole: boolean }) => ReadAnswer | Promise<ReadAnswer>;

/** A feature's reads: for each kind of job it answers, the handler that answers it. */
export type ReadTable<J extends { kind: string }> = { readonly [K in J['kind']]: ReadHandler<Extract<J, { kind: K }>> };

/** The jobs a table answers, from its handlers; of a union of tables, every one's. */
export type JobOf<T> = T extends unknown ? { [K in keyof T]: T[K] extends ReadHandler<infer J> ? J : never }[keyof T] : never;

/** Any feature's table, whatever jobs it answers. */
type AnyTable = Readonly<Record<string, ReadHandler<never>>>;

/**
 * The tables' handlers by kind, as runJob looks one up by its job's. A kind two of them register is
 * refused, as a job kind for the CLI is (jobs.ts `registerJobKind`).
 */
export function readRegistry<T extends readonly AnyTable[]>(tables: T): ReadonlyMap<string, ReadHandler<JobOf<T[number]>>> {
  const handlers = new Map<string, ReadHandler<JobOf<T[number]>>>();
  for (const table of tables) {
    for (const [kind, handler] of Object.entries(table)) {
      if (handlers.has(kind)) throw new Error(`read job kind "${kind}" is registered twice`);
      // Handed only jobs of its own kind: runJob looks it up by the job's.
      handlers.set(kind, handler as ReadHandler<JobOf<T[number]>>);
    }
  }
  return handlers;
}

const tagOf = (text: string) => `"${createHash('sha1').update(text).digest('base64url')}"`;

/** A job's answer: `body` as JSON text, with its ETag when `tagged` and it isn't warming. */
export function answer(body: unknown, o: { tagged?: boolean; status?: number } = {}): ReadAnswer {
  const text = JSON.stringify(body);
  const warming = typeof body === 'object' && body !== null && 'warming' in body;
  return { status: o.status ?? 200, body: text, etag: o.tagged && !warming ? tagOf(text) : null, ...(warming ? { warming } : {}) };
}

/** A job that can't be answered: a missing run (404), a bad request (400), as the route says it. */
export const failed = (status: number, error: string): ReadAnswer => ({ status, body: JSON.stringify({ error }), etag: null });
