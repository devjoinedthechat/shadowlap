import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PACK_FORMAT, PACK_LIMITS } from '@shadowlap/engine';
import { oracleLabels } from './attempts.js';
import { specFor, type TestEntry, type TestSpec } from './checks.js';
import { configPath } from './config.js';

/**
 * Goldens: packed recordings in the repository that `shadowlap test` replays. This finds them (the
 * goldens folder, and the packs the config's `tests` name), names them the way the store's test
 * history does, and describes each for the dashboard's Tests screen.
 */

/** The folder a project keeps its goldens in, relative to it. */
export const GOLDENS_FOLDER = 'goldens';

/** A golden's name in the test history: its pack folder relative to the project, with forward slashes. */
export function goldenName(dir: string, projectDir: string): string {
  const rel = relative(projectDir, resolve(projectDir, dir));
  const name = (rel === '' ? '.' : isAbsolute(rel) ? resolve(projectDir, dir) : rel).split(sep).join('/');
  return name.replace(/\/+$/, '');
}

const isPack = (dir: string) => {
  try {
    return statSync(dir).isDirectory() && existsSync(join(dir, 'run.json'));
  } catch {
    return false;
  }
};

const hasWildcard = (s: string) => /[*?]/.test(s);

/**
 * Recording directories from what was given: a path with `*` or `?` in its last part is matched
 * against the directories there that hold a pack (no shell needed, so a dashboard job can pass
 * `goldens/*` as it is); anything else is taken as given. Each directory once, in the order found.
 */
export function expandRecordings(patterns: readonly string[], projectDir: string): { dirs: string[]; unmatched: string[] } {
  const dirs: string[] = [];
  const unmatched: string[] = [];
  const add = (d: string) => {
    if (!dirs.some((x) => resolve(projectDir, x) === resolve(projectDir, d))) dirs.push(d);
  };
  for (const pattern of patterns) {
    // A path that exists as given wins, even if its name has a `*` in it.
    if (existsSync(resolve(projectDir, pattern))) {
      add(pattern);
      continue;
    }
    const parent = dirname(pattern);
    if (hasWildcard(parent)) throw new Error(`only the last part of a recordings path may contain a wildcard: ${pattern}`);
    const last = basename(pattern);
    if (!hasWildcard(last)) {
      add(pattern);
      continue;
    }
    const re = new RegExp(`^${last.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    const base = resolve(projectDir, parent);
    let names: string[] = [];
    try {
      names = readdirSync(base).sort();
    } catch {
      // the folder doesn't exist: nothing matches
    }
    const found = names.filter((n) => re.test(n) && !n.startsWith('.') && isPack(join(base, n))).map((n) => (parent === '.' ? n : join(parent, n)));
    if (!found.length) unmatched.push(pattern);
    found.forEach(add);
  }
  return { dirs, unmatched };
}

/** What a pack's run.json says about the recording a golden replays, read without importing it. */
export interface PackHead {
  /** The packed run: the last one in run.json. */
  runId: string;
  /** When it was packed. */
  packedAt: number | null;
  /** When the packed run was recorded. */
  recordedAt: number | null;
  argv: string[];
  /** The packed run's own parent: a golden re-recorded by `test --update` names the one it replaced. */
  parentRunId: string | null;
}

/** Reads a pack's run.json, or explains why it can't. Untrusted: only the fields used here, checked. */
export function readPackHead(dir: string): PackHead | { error: string } {
  const path = join(dir, 'run.json');
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return { error: 'run.json is not a regular file' };
    if (st.size > PACK_LIMITS.manifestBytes) return { error: 'run.json is too large' };
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { format?: unknown; createdAt?: unknown; runs?: unknown };
    if (manifest.format !== PACK_FORMAT) return { error: 'not a Shadowlap pack' };
    const runs = Array.isArray(manifest.runs) ? manifest.runs : [];
    const run = runs.at(-1) as { runId?: unknown; startedAt?: unknown; command?: { argv?: unknown }; parentRunId?: unknown } | undefined;
    if (!run || typeof run.runId !== 'string') return { error: 'run.json lists no run' };
    const argv = Array.isArray(run.command?.argv) ? run.command.argv.filter((a): a is string => typeof a === 'string') : [];
    return {
      runId: run.runId,
      packedAt: typeof manifest.createdAt === 'number' ? manifest.createdAt : null,
      recordedAt: typeof run.startedAt === 'number' ? run.startedAt : null,
      argv,
      parentRunId: typeof run.parentRunId === 'string' ? run.parentRunId : null,
    };
  } catch (err) {
    return { error: existsSync(path) ? `run.json can't be read: ${(err as Error).message}` : 'no run.json: not a pack' };
  }
}

/**
 * The key under `tests` in the config that applies to a recording directory, as `specFor` picks it
 * (an exact path wins over a pattern), or null.
 */
export function testsKeyFor(entries: readonly TestEntry[], recordingDir: string, configDir: string): string | null {
  const exact = entries.find((e) => !e.recording.includes('*') && specFor([e], recordingDir, configDir) !== null);
  if (exact) return exact.recording;
  return entries.find((e) => e.recording.includes('*') && specFor([e], recordingDir, configDir) !== null)?.recording ?? null;
}

/** The `expect` object of a recording's tests entry, as written in the config, or null. */
export function rawExpectFor(entries: readonly TestEntry[], recordingDir: string, configDir: string): Record<string, unknown> | null {
  const key = testsKeyFor(entries, recordingDir, configDir);
  if (key === null) return null;
  try {
    const raw = JSON.parse(readFileSync(configPath(configDir), 'utf8')) as { tests?: Record<string, { expect?: unknown }> };
    const expect = raw.tests?.[key]?.expect;
    return typeof expect === 'object' && expect !== null && !Array.isArray(expect) ? (expect as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** How a golden is tested, in the words the Tests screen uses. */
export function goldenMode(spec: TestSpec | null): { mode: 'replay' | 'fork'; repeat: number; passes: number; checks: string[] } {
  return {
    mode: spec?.fork ? 'fork' : 'replay',
    repeat: spec?.repeat ?? 1,
    passes: spec?.passes ?? 1,
    // The exit status is part of every golden's oracle; the screen lists the checks someone wrote.
    checks: spec ? oracleLabels(spec).slice(1) : [],
  };
}

/** One golden as the dashboard's Tests screen lists it: `GoldenSource` in @shadowlap/dashboard. */
export interface GoldenInfo {
  path: string;
  runId: string | null;
  packedAt: number | null;
  mode: 'replay' | 'fork';
  repeat: number;
  passes: number;
  checks: string[];
  error: string | null;
}

/**
 * Every golden of a project: the packs in its goldens folder and the packs named under `tests` in
 * its config (decision: Tests lists packs only; recordings in `__recordings__/` belong to the
 * pytest and Vitest plugins and run under their own test runner).
 */
export function listGoldens(projectDir: string, entries: readonly TestEntry[], folder = GOLDENS_FOLDER): GoldenInfo[] {
  const patterns = [`${folder}/*`, ...entries.map((e) => e.recording)];
  const dirs: string[] = [];
  for (const p of patterns) {
    let found: string[];
    try {
      found = expandRecordings([p], projectDir).dirs.filter((d) => isPack(resolve(projectDir, d)) || !hasWildcard(basename(p)));
    } catch {
      continue;
    }
    for (const d of found) if (!dirs.some((x) => goldenName(x, projectDir) === goldenName(d, projectDir))) dirs.push(d);
  }
  return dirs.map((d) => {
    const head = readPackHead(resolve(projectDir, d));
    const spec = specFor([...entries], resolve(projectDir, d), projectDir);
    return {
      path: goldenName(d, projectDir),
      runId: 'error' in head ? null : head.runId,
      packedAt: 'error' in head ? null : head.packedAt,
      ...goldenMode(spec),
      error: 'error' in head ? head.error : null,
    };
  });
}
