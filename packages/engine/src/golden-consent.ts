import { execFileSync } from 'node:child_process';
import { join, relative, resolve, sep } from 'node:path';
import { sameCommandLine } from './http.js';
import { commandIsImported, hasRecordedCommand, PACK_FORMAT, readPackFile } from './pack.js';
import { PACK_LIMITS } from './pack-schema.js';
import type { StoreOf } from './store.js';
import type { RunRecord } from './types.js';

/**
 * When running a golden's recorded command needs a yes. A golden's pack holds the command its replay
 * runs: `shadowlap test`, `bisect`, `injection`, `decisions`, `migrate` and `tasks score` run it. One
 * this machine recorded is the user's own; one the project's git repository tracks is reviewed as its
 * code is, which is where CI's goldens are. Any other came from a pack someone sent, outside the
 * repository or not added to it, and runs only once the user says yes, as `replay` asks of an
 * imported run: a pack that reuses the id of a run recorded here, with another command, is one.
 */

/**
 * The pack folders among `dirs` (relative to `projectDir`, or absolute) whose run.json the index of
 * the git repository `projectDir` is in holds: in one call to git, or one a pack when that call
 * fails (a pack outside the repository makes git refuse the whole list). A pack outside the
 * repository (in another repository too), one reached through a symbolic link, one not added, and
 * any where the project is no git repository, isn't among them.
 */
export function trackedPacks(dirs: readonly string[], projectDir: string): Set<string> {
  const out = new Set<string>();
  if (!dirs.length) return out;
  const named = new Map(dirs.map((d) => [relative(projectDir, resolve(projectDir, d, 'run.json')).split(sep).join('/'), d] as const));
  const listed = (paths: readonly string[]): string[] | null => {
    try {
      return execFileSync('git', ['ls-files', '-z', '--', ...paths], { cwd: projectDir, stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000, maxBuffer: 16 * 1024 * 1024 })
        .toString('utf8')
        .split('\0')
        .filter(Boolean);
    } catch {
      return null;
    }
  };
  const all = listed([...named.keys()]);
  if (all) {
    for (const name of all) {
      const dir = named.get(name);
      if (dir !== undefined) out.add(dir);
    }
    return out;
  }
  for (const [path, dir] of named) if (listed([path])?.length) out.add(dir);
  return out;
}

/** Whether the project's git repository tracks a pack: its run.json is in the index (trackedPacks). */
export function packTracked(dir: string, projectDir: string): boolean {
  return trackedPacks([dir], projectDir).has(dir);
}

/**
 * Whether a golden's recorded command runs only after a yes: `run` as the golden's import reads it
 * (importGolden, which marks a pack's command that differs from the store's copy) came from
 * elsewhere, and the repository doesn't track its pack.
 */
export function goldenNeedsConsent(run: RunRecord, dir: string, projectDir: string): boolean {
  return commandIsImported(run) && hasRecordedCommand(run) && !packTracked(dir, projectDir);
}

/** A golden's recorded run as its pack's run.json lists it last, read without bringing the pack in; null when it can't be read. */
export function packHeadRun(dir: string): { runId: string; argv: string[] } | null {
  try {
    const manifest = JSON.parse(readPackFile(join(dir, 'run.json'), PACK_LIMITS.manifestBytes, 'run.json').toString('utf8')) as { format?: unknown; runs?: unknown };
    if (manifest.format !== PACK_FORMAT || !Array.isArray(manifest.runs)) return null;
    const run = manifest.runs.at(-1) as { runId?: unknown; command?: { argv?: unknown } } | undefined;
    const argv = run?.command?.argv;
    if (!run || typeof run.runId !== 'string' || !Array.isArray(argv) || !argv.every((a) => typeof a === 'string')) return null;
    return { runId: run.runId, argv };
  } catch {
    return null;
  }
}

/**
 * The goldens among `dirs` whose recorded command needs a yes, read without bringing their packs in
 * (a dashboard job asks before it starts one), each with the command it runs. A golden's command runs
 * without one when this machine recorded it (the store holds its run under the pack's id, unmarked,
 * with the same command, but for the credentials a pack masks in it: sameCommandLine) or the
 * repository tracks its pack; one whose pack can't be read is left for the command, which refuses it.
 */
export function goldensNeedingConsent(store: StoreOf<'recording'>, dirs: readonly string[], projectDir: string): Array<{ dir: string; runId: string; argv: string[] }> {
  const asked: Array<{ dir: string; runId: string; argv: string[] }> = [];
  for (const dir of dirs) {
    const head = packHeadRun(resolve(projectDir, dir));
    if (!head || !head.argv.length) continue;
    const held = store.getRun(head.runId);
    const own = held !== null && !commandIsImported(held) && sameCommandLine(held.command.argv, head.argv);
    if (!own && hasRecordedCommand({ command: { argv: head.argv } })) asked.push({ dir, runId: head.runId, argv: head.argv });
  }
  if (!asked.length) return asked;
  const tracked = trackedPacks(
    asked.map((a) => a.dir),
    projectDir,
  );
  return asked.filter((a) => !tracked.has(a.dir));
}
