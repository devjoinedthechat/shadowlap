import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { configFilePath, isObject, parseTests, readConfigFile, testsEntryFor, type TestEntry } from '@shadowlap/engine';
import { keepSeenChecks, seenChecks, type SeenChecks } from './checks-seen.js';
import type { RouteContext } from './context.js';
import type { OutcomeWork } from './run-outcome.js';
import { goldensOf } from './routes/overview.js';

/**
 * What the server reads of the project, on its own thread, for the read models to judge runs by the
 * checks they were not given (run-outcome.ts): the config's version and its `tests` as written, and
 * the goldens on disk with the run each pack holds, when it was packed and when its checks last
 * changed (checks-seen.ts). Null outside a project, or while its config can't be read: then only
 * runs' own verdicts, and those kept on captures, say anything.
 *
 * Listing the goldens reads every pack's head, so the work is kept per project and read again only
 * once a file it was read from changes, as stat tells: the config, the goldens folder, the folders
 * its tests entries name, and each pack's run.json. A request pays a stat of each; the same work,
 * and so its key, answers until then.
 */

/** The folder the CLI lists goldens in (its GOLDENS_FOLDER): a pack added there or taken out changes it. */
const GOLDENS = 'goldens';

interface Kept {
  /** The files the work was read from, and what stat said of each before it was read. */
  watched: string[];
  stats: string;
  prices: unknown;
  work: OutcomeWork | null;
}

const kept = new WeakMap<RouteContext, Kept>();

/** A file as stat sees it, so that a write shows: when it was modified, its size and its inode (a file replaced in one step is another). */
function statOf(path: string): string {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}:${s.ino}`;
  } catch {
    return '-';
  }
}

const statsOf = (paths: readonly string[]): string => paths.map(statOf).join('|');

/** When the config was last written (ms), or null without one. */
function writtenAt(path: string): number | null {
  try {
    return Math.floor(statSync(path).mtimeMs);
  } catch {
    return null;
  }
}

/** A key for a golden's checks: its tests entry's `expect`, as written. */
function checksKey(tests: unknown, entries: readonly TestEntry[], golden: string, dir: string): string {
  const entry = testsEntryFor(entries, golden, dir);
  const raw = entry && isObject(tests) ? tests[entry.recording] : undefined;
  return createHash('sha1')
    .update(JSON.stringify(isObject(raw) ? (raw.expect ?? null) : null))
    .digest('base64url')
    .slice(0, 16);
}

function readWork(ctx: RouteContext, dir: string): Omit<Kept, 'prices'> {
  const config = configFilePath(dir);
  const folder = join(dir, GOLDENS);
  // Stat before reading: a write while it is read shows on the next request.
  const before = [statOf(config), statOf(folder)];
  let file: ReturnType<typeof readConfigFile>;
  try {
    file = readConfigFile(dir);
  } catch {
    return { watched: [config, folder], stats: before.join('|'), work: null };
  }
  const tests = isObject(file.data) ? file.data.tests : undefined;
  let entries: TestEntry[] = [];
  try {
    entries = parseTests(tests);
  } catch {
    // the read model's thread parses them again, and says why they can't be read
  }
  const changedAt = file.exists ? writtenAt(file.path) : null;
  const seen = seenChecks(dir);
  const now = new Map<string, SeenChecks>();
  const goldens = goldensOf(ctx).map((g) => {
    const key = checksKey(tests, entries, g.path, dir);
    const was = seen.get(g.path);
    // First seen: its checks came with it. Changed since: by the config's write that changed them.
    const at = !was ? null : was.key === key ? was.at : (changedAt ?? Date.now());
    now.set(g.path, { key, at });
    return { path: g.path, runId: g.runId, packedAt: g.packedAt, checksAt: at };
  });
  if (now.size !== seen.size || [...now].some(([path, v]) => seen.get(path)?.key !== v.key)) keepSeenChecks(dir, now);
  const others = [...new Set([...entries.map((e) => dirname(resolve(dir, e.recording))), ...goldens.map((g) => join(resolve(dir, g.path), 'run.json'))])];
  return {
    watched: [config, folder, ...others],
    stats: [...before, ...others.map(statOf)].join('|'),
    work: { version: file.version, tests, dir, goldens, ...(ctx.read.prices ? { prices: ctx.read.prices } : {}) },
  };
}

/** The outcome work for the current request: the one kept for the project while nothing it was read from changed, else read again. */
export function outcomeWork(ctx: RouteContext): OutcomeWork | null {
  const dir = ctx.project?.path;
  if (!dir) return null;
  const k = kept.get(ctx);
  if (k && k.prices === ctx.read.prices && statsOf(k.watched) === k.stats) return k.work;
  const read = readWork(ctx, dir);
  kept.set(ctx, { ...read, prices: ctx.read.prices });
  return read.work;
}
