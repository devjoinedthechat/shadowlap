import { existsSync, readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { andList, migrateApplyProblem, patchFiles, quoteArgv, recordEvent, resolveAuthor, shortSessionId, staysWords, type MigrateApplyInput, type MigratePassRun, type MigrationApplied, type Store } from '@shadowlap/engine';
import { DecisionsError } from './decisions.js';
import { findSession } from './decisions-verify.js';
import { EXIT } from './exit-codes.js';
import { outdatedGoldens, type OutdatedGolden } from './fix-outdated.js';
import { ApplyError, APPLY, applyToBytes, checkTreeFile, git, putIn, rebuild, shown } from './patch-apply.js';
import type { ConfigChange } from './migrate-mentions.js';

/**
 * `shadowlap migrate apply <id>`: puts a migration's config change in the working tree. It takes only
 * a migration that is all clear and whose patch is the whole switch (migrateApplyProblem), checks the
 * patch as fix apply checks a repair's (the file the migration wrote, unchanged since, naming only the
 * files it switched, each a plain file of the working tree that git sees), applies it with `git apply`
 * to the files' bytes as they are, replays the project's goldens offline in a store of their own that
 * nothing keeps, and names each that now diverges on `$.model`, with the command that re-records it
 * under the new model. A patch already in the tree is only marked. The migration keeps its applied
 * state (`setMigrationApplied`), and `migrate.applied` goes in Activity.
 */

export interface MigrateApplyOptions {
  cwd: string;
  /** The project's goldens folder, relative to `cwd`: the goldens replayed offline. */
  goldens: string;
  /** A command that rebuilds the agent before the replay, as fix apply's `--build`. */
  build: string | null;
  /** Said as it runs when the config named it, nobody having typed --build (buildCommand). */
  buildNote?: string | null;
  log: (line: string) => void;
  /** Said once the migration is found and clear, before anything is checked in the tree; not when it was applied before. */
  start?: (from: readonly string[], to: string, sessionId: string) => void;
  now?: number;
}

export interface MigrateApplyResult {
  migrateId: string;
  /** `already-applied` when the migration was applied before and its patch is in the tree. */
  status: 'applied' | 'already-applied';
  /** What happened to the patch: applied now, or found in the tree already. */
  patch: 'applied' | 'already';
  /** The files the patch changes, and the fields it takes out with the model. */
  files: string[];
  leftOut: ConfigChange['leftOut'];
  /** The goldens that now diverge on `$.model`, each with the call and its kind and name; empty when none does. */
  outdated: OutdatedGolden[];
  /** The command that re-records them, or null. */
  update: string | null;
}

/** What `migrate apply` reads of a kept migration: its report, as `migrate --json` printed it. */
type KeptMigration = Omit<MigrateApplyInput, 'configChange' | 'files' | 'passes'> & {
  passes: { verdict: MigrateApplyInput['passes']['verdict']; runs: ReadonlyArray<MigrateApplyInput['passes']['runs'][number] & Pick<MigratePassRun, 'golden' | 'diverges' | 'stays'>> };
  configChange: ConfigChange | null;
  files: { dir: string; pullRequest: string; patch: string | null } | null;
};

const slashes = (p: string) => p.split(/[\\/]+/).join('/');

/** The migration an id names, whole or by a unique prefix (as `decisions --verify` finds a session), else exit 2. */
function migrationOf(store: Store, id: string): { sessionId: string; report: KeptMigration; applied: MigrationApplied | null } {
  let found: ReturnType<typeof findSession>;
  try {
    found = findSession(store, id);
  } catch (err) {
    if (err instanceof DecisionsError) throw new ApplyError(err.message, EXIT.usage);
    throw err;
  }
  if (!found || found.kind !== 'migrate') throw new ApplyError(`no migration ${id}: give a migration's mg-… id, as shadowlap migrate printed it`, EXIT.usage);
  return { sessionId: found.sessionId, report: { ...(found.data as unknown as KeptMigration), migrateId: found.sessionId }, applied: found.applied };
}

/**
 * The patch as the migration wrote it, checked: a store can come from elsewhere, so its path must be
 * the migration's own file, its text the patch the report kept, and every file it names one the
 * migration switched, a plain file of this working tree, reached through no link, that git sees.
 */
function checkedPatch(r: KeptMigration, sessionId: string, o: MigrateApplyOptions, root: string): { path: string; text: string; files: string[]; prefix: string } {
  const short = shortSessionId(sessionId);
  const want = `.shadowlap/migrations/${sessionId}/config.patch`;
  const given = slashes(r.files!.patch!);
  if (given !== want) throw new ApplyError(`the store gives ${short} the config change "${r.files!.patch!}", not ${want}, so it is not used: run the migration again`);
  const path = resolve(o.cwd, want);
  if (!existsSync(path)) throw new ApplyError(`the migration's config change is not in this folder (${want}): run shadowlap migrate apply in the folder ${short} ran in`, EXIT.usage);
  const text = readFileSync(path, 'utf8');
  if (text !== r.configChange!.patch) throw new ApplyError(`${want} is not the config change ${short} checked: it changed since. Nothing was changed: apply it by hand if you changed it on purpose, or run the migration again`);
  const switched = new Set(r.configChange!.files.map((f) => slashes(f.path)));
  // The patch names files from the folder migrate ran in, which may be inside the repository: where,
  // as git finds it, since the folder's path may be spelled otherwise than the repository's top is
  // (through a link, or as Windows' short name, C:\Users\RUNNER~1, for C:\Users\runneradmin).
  const prefix = git(o.cwd, ['rev-parse', '--show-prefix']).stdout.trim().replace(/\/+$/, '');
  const files = patchFiles(text);
  for (const f of files) {
    if (!switched.has(f)) throw new ApplyError(`the config change names ${f}, which is not among the files ${short} switched, so nothing was changed: run the migration again`);
    checkTreeFile(root, prefix ? posix.join(prefix, f) : f, { only: 'A migration only switches files git sees', read: want });
  }
  return { path, text, files, prefix };
}

/** The line that says what went in: the patch, its files and places, and the fields it took out. */
function appliedLine(r: KeptMigration, want: string): string {
  const c = r.configChange!;
  const places = c.files.reduce((n, f) => n + f.places, 0);
  const out = [...new Set(c.leftOut.map((x) => x.field))];
  return `  applied ${want}: ${c.files.map((f) => f.path).join(', ')} · ${places} place${places === 1 ? '' : 's'}${out.length ? ` · ${andList(out)} left out` : ''}`;
}

/** The goldens the switch now leaves behind, replayed offline; each that diverges named, with the command that re-records them. */
async function replayGoldens(store: Store, r: KeptMigration, text: string, o: MigrateApplyOptions): Promise<{ outdated: OutdatedGolden[]; update: string | null }> {
  const check = await outdatedGoldens(store, { cwd: o.cwd, goldens: o.goldens, patch: text, skip: [], log: o.log, checking: (n) => `▸ replaying the goldens offline, in a store of their own that nothing keeps: ${n} golden${n === 1 ? '' : 's'}` });
  const outdated = check.outdated;
  for (const g of outdated) o.log(`    ✗ ${g.golden}: diverged at call ${g.callNo} (${g.kind} ${g.name}) · ~ ${g.path}`);
  const others = check.checked - outdated.length;
  // Why the others replay as recorded, by migrate's marks; their count where the marks don't say.
  const why = staysWords(r.passes.runs, r.from, { diverged: outdated.map((g) => g.golden) });
  const said = !outdated.length ? `    none of them diverges on it${why ? `: ${why}` : ''}` : !others ? '' : why ? `    the others don't diverge on it: ${why}` : `    the other ${others} ${others === 1 ? "doesn't" : "don't"} diverge on it`;
  if (check.checked && said) o.log(said);
  if (!outdated.length) return { outdated, update: null };
  const update = quoteArgv(['shadowlap', 'test', ...outdated.map((g) => g.golden), '--update']);
  const n = outdated.length;
  o.log(`  ! ${n === 1 ? '1 golden diverges' : `${n} goldens diverge`} on the model the config change switched (${r.from.join(', ')} → ${r.to}): ${outdated.map((g) => g.golden).join(', ')}`);
  o.log(`    re-record ${n === 1 ? 'it' : 'them'} under ${r.to} once the switch is what you meant: ${update}`);
  return { outdated, update };
}

export async function applyMigration(store: Store, id: string, o: MigrateApplyOptions): Promise<MigrateApplyResult> {
  const { sessionId, report: r, applied } = migrationOf(store, id);
  const problem = migrateApplyProblem(r);
  if (problem) throw new ApplyError(problem, EXIT.usage);
  if (!applied) o.start?.(r.from, r.to, sessionId);
  const top = git(o.cwd, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) throw new ApplyError('shadowlap migrate apply changes the working tree with git apply, so it has to run inside the git repository the migration ran in', EXIT.usage);
  const root = top.stdout.trim();
  const patch = checkedPatch(r, sessionId, o, root);
  const want = `.shadowlap/migrations/${sessionId}/config.patch`;
  // Applied from the repository's top, each path under the folder migrate ran in.
  const where = patch.prefix ? [`--directory=${patch.prefix}`] : [];
  const result: MigrateApplyResult = { migrateId: sessionId, status: 'applied', patch: 'applied', files: patch.files, leftOut: r.configChange!.leftOut ?? [], outdated: [], update: null };
  const asIs = applyToBytes(root, patch.files.map((f) => (patch.prefix ? posix.join(patch.prefix, f) : f)), patch.path, where);
  if (asIs.already || git(root, [...APPLY, ...where, '--reverse', '--check', patch.path]).status === 0) {
    result.patch = 'already';
    if (applied) return { ...result, status: 'already-applied', outdated: [], update: null };
    o.log(`  the config change is already in the working tree (${shown(o.cwd, patch.path)})`);
  } else {
    putIn({ root, patch: patch.path, text: patch.text, bytes: asIs.bytes, cwd: o.cwd, args: where, prefix: patch.prefix }, { rerun: `shadowlap migrate apply ${shortSessionId(sessionId)}`, since: 'the migration', redo: 'run the migration again' }, null);
    o.log(appliedLine(r, want));
  }
  if (r.configChange!.review.length) o.log(`  left for review: ${r.configChange!.review.map((m) => `${m.path}:${m.line}`).join(', ')}`);
  const by = resolveAuthor({ cwd: o.cwd });
  const at = o.now ?? Date.now();
  // Marked applied before the replay, so a stop meanwhile loses nothing but the list.
  store.setMigrationApplied(sessionId, { at, by, outdated: [] });
  rebuild(o);
  const left = await replayGoldens(store, r, patch.text, o);
  result.outdated = left.outdated;
  result.update = left.update;
  store.setMigrationApplied(sessionId, { at, by, outdated: left.outdated.map((g) => ({ golden: g.golden, callNo: g.callNo, path: g.path })) });
  recordEvent(store, { kind: 'migrate.applied', actor: by, ref: sessionId, data: { from: r.from, to: r.to, files: patch.files, outdated: left.outdated.map((g) => g.golden), patch: result.patch } });
  return result;
}
