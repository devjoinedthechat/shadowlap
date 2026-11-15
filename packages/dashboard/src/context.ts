import type { Normalizer, Price, Store } from '@shadowlap/engine';
import type { ReadOptions } from './api.js';
import type { JobManager, ProjectInfo } from './jobs.js';
import type { ReadModels } from './read-pool.js';
import type { SearchIndex } from './search-index.js';
import type { DashboardOptions } from './server.js';
import type { UploadStore } from './uploads.js';

/**
 * The project's `shadowlap.config.json` as the CLI reads it (its `loadConfig`, checked): the rules
 * every command applies and the settings the dashboard shows. A feature that needs another key adds
 * it here as the CLI's config type has it.
 */
export interface ProjectConfig {
  normalize: Normalizer[];
  redact: Normalizer[];
  prices?: Record<string, Price>;
  clock?: string;
  http?: Array<{ host: string; effect: string }>;
  mcp?: { effects: Record<string, string> };
  repair?: { repairer?: string; baseUrl?: string };
  /** `verify`: what a good run is kept against, and the most pairs (or attempts) it takes, as a repair's candidates and Run more attempts are verified. */
  verify?: { baseline?: 'paired' | 'history'; max?: number };
  /** Tools by name: `trust` marks the reads shadowlap injection plants in (Settings → Tools' Trust column). */
  tools?: Record<string, { trust: 'trusted' | 'untrusted' }>;
  /** `tools.unrecorded`: the effect of each tool the agent runs without shadowlap recording it, which decides whether a replay may run it again. */
  unrecorded?: Record<string, 'read' | 'write'>;
}

/**
 * What every route module gets from the server: `register(router, ctx)`.
 *
 * A dashboard can serve several projects (`DashboardOptions.projects`), one of them current. Each
 * project then gets its own instance of every route module, registered the first time it is
 * current, with a context of its own: `store`, `project`, `read`, `config()`, `instance` and the
 * options' `store`, `dbPath`, `project`, `prices` and `loadConfig` are that project's. A module is
 * written as for one store and may keep what it reads in `register`; requests go to the current
 * project's instance. Job kinds registered by each instance build the jobs that run in its project,
 * and `jobs.onJob` hears only those.
 */
export interface RouteContext {
  store: Store;
  /** The options the dashboard was started with; with several projects, their store, path, folder and config are this project's. */
  options: DashboardOptions;
  /** Starts and tracks CLI jobs; `ctx.jobs.registerJobKind(kind, …)` adds a kind. A job runs in the project current when it starts. */
  jobs: JobManager;
  /** Files the browser sent for jobs. */
  uploads: UploadStore;
  /** What read models take: the price table for costs. */
  read: ReadOptions;
  /**
   * The read models that read every call of a run, or of every run (read-jobs.ts: the Overview, a
   * run's page and its calls, Compare, the run list): worked out on threads beside the server for a
   * store with a file (read-pool.ts), so a first look at a big store holds up no other request.
   */
  reads: ReadModels;
  /** The store's search index, brought up to date beside the requests (search-index.ts). */
  search: SearchIndex;
  /** The project folder jobs run in, or null; its `id` with several projects. */
  project: ProjectInfo | null;
  /**
   * The project's config, read fresh on every call (Settings edits it, so does the CLI). Throws a
   * 500 naming the file when it cannot be read.
   */
  config(): ProjectConfig;
  /** Nothing can be changed from this dashboard. */
  readOnly: boolean;
  /** Why it is read-only, or null. */
  readOnlyReason: string | null;
  /** Throws a 403 with the reason on a read-only dashboard. Every write route gets this check already. */
  requireWritable(): void;
  /** Where the dashboard listens, such as "127.0.0.1:4777". */
  address(): string;
  /** Names this server instance: what the browser learned from another one (a cursor) no longer holds. */
  instance: string;
}

/**
 * The project's matching rules (its config's `normalize`), as a fork's differences and Compare mask
 * what they compare: none where the dashboard reads no config, or the config can't be read, so the
 * comparison goes on as recorded rather than fail.
 */
export function projectNormalizers(ctx: Pick<RouteContext, 'options' | 'config'>): Normalizer[] {
  if (!ctx.options.loadConfig) return [];
  try {
    return ctx.config().normalize;
  } catch {
    return [];
  }
}
