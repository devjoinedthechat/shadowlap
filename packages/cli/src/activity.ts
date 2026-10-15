import { existsSync } from 'node:fs';
import { recordEvent, resolveAuthor, Store, type RecordEventInput, type RunMeta } from '@shadowlap/engine';
import { defaultDbPath } from './config.js';
import type { GlobalOpts } from './shared.js';

/**
 * Who did what, for the dashboard's activity feed: the author stamped on runs this command makes,
 * and the events it records when it changes the project's config or writes an artifact.
 */

let author: string | null | undefined;
let extra: Partial<RunMeta> = {};

/** Who runs this command (SHADOWLAP_AUTHOR, `ci`, git's user.email, the OS user), worked out once. */
export function currentAuthor(): string | null {
  if (author === undefined) author = resolveAuthor({ cwd: process.cwd() });
  return author;
}

/**
 * Meta every run this command makes from now on carries besides its author: `replay` marks its
 * forks with the flags that made them before it starts one.
 */
export function stampNewRunsWith(meta: Partial<RunMeta>): void {
  extra = { ...extra, ...meta };
}

/** What a run this command makes is stamped with: its author, and anything `stampNewRunsWith` added. */
export function newRunMeta(): Partial<RunMeta> {
  const who = currentAuthor();
  return { ...(who ? { author: who } : {}), ...extra };
}

/** Marks a run with who made it (and, for a fork, how). Never throws: a run without an author is still a run. */
export function stampAuthor(store: Store, runId: string): void {
  const meta = newRunMeta();
  if (!Object.keys(meta).length) return;
  try {
    store.updateRunMeta(runId, meta);
  } catch {
    // the run is what matters
  }
}

/** Records an activity event in a store the command has open, as the person running it. Never throws. */
export function logActivity(store: Store, input: Omit<RecordEventInput, 'actor'>): void {
  recordEvent(store, { ...input, actor: currentAuthor() });
}

/**
 * Records an activity event from a command that has no store open (it edited the config). The store
 * is opened only when it exists: a project without one has no feed to show it in, and adding a
 * normalizer should not create a store as a side effect. Never throws.
 */
export function recordActivity(opts: GlobalOpts, input: Omit<RecordEventInput, 'actor'>): void {
  const path = opts.db ?? defaultDbPath(process.cwd());
  if (!existsSync(path)) return;
  let store: Store | null = null;
  try {
    store = Store.open(path);
    logActivity(store, input);
  } catch {
    // an activity line is never worth failing the command that did the work
  } finally {
    store?.close();
  }
}
