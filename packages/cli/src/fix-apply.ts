import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyLeft, fixRecords, markFixApplied, patchFiles, quoteArgv, recordEvent, repairPatchProblem, repairToApply, resolveAuthor, type Store, type StoredFix, type StoredRepair } from '@shadowlap/engine';
import { outdatedGoldens, type OutdatedGolden } from './fix-outdated.js';

/**
 * `shadowlap fix apply <fix>`: hands a verified fix over to the working tree. It `git apply`s the
 * patch of the repair whose candidate was accepted, copies the recordings that repair made with the
 * fixed code into the project's goldens folder, runs `shadowlap test` on them, and marks the fix
 * applied. A patch already in the tree (applied by hand, committed, or by `repair --apply`) is
 * recognised with `git apply --reverse --check` and only marked. A tree whose changes conflict with
 * the patch is left alone, with what to do about it. A fix verified on the working tree itself,
 * with no repair behind it, has no patch: its change is already where it belongs, so it is only
 * marked applied. On a fix applied already, it finishes what was left: goldens not copied yet, and
 * a test that hasn't passed. With the patch in, it replays the project's other goldens offline and
 * names those that now diverge on what the patch changed, with the command that re-records them
 * (`fix-outdated.ts`).
 *
 * A repair that came with a pull from the team store ran on a teammate's machine: its patch goes in
 * here, and its recordings, which stayed there, are neither copied nor tested here (they are
 * committed from that machine). Nothing here runs the code it put in, no build, test or replay,
 * until someone has read it: the bucket is someone else's data, and the patch is code.
 *
 * What it reads from the store decides what it touches, so it trusts no path there: the repair's
 * directory must be `.shadowlap/repairs/<its id>`, its goldens inside that directory's `goldens/`,
 * its patch the one rewrite its accepted candidate makes, to that candidate's file alone and in
 * place (`repairPatchProblem`), and its fix.patch that patch.
 */

export class ApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplyError';
  }
}

export interface ApplyOptions {
  cwd: string;
  /** The project's goldens folder, relative to `cwd`. */
  goldens: string;
  /** Run `shadowlap test` on the goldens after copying them. */
  test: boolean;
  /** A command that rebuilds the agent before the test. */
  build: string | null;
  /** The store, passed on to `shadowlap test` so its runs land in it too. */
  db: string | undefined;
  log: (line: string) => void;
}

export interface ApplyResult {
  fixId: string;
  /** `already-applied` when the fix was applied before and nothing was left to do. */
  status: 'applied' | 'already-applied';
  /** The fix was applied before (by `repair --apply`, or with a test that failed), and this finished it. */
  again: boolean;
  /** What happened to the patch: applied now, found in the tree already, or none to apply. */
  patch: 'applied' | 'already' | 'none';
  repairId: string | null;
  /** Each golden, where it was copied to, and whether it was copied or already there. */
  goldens: Array<{ from: string; to: string; copied: boolean }>;
  tests: 'passed' | 'failed' | 'skipped';
  /**
   * The project's other goldens that now diverge on what the patch changed, each with the call and
   * the request field; empty when none does, or when nothing was tested.
   */
  outdated: OutdatedGolden[];
  /** The command that re-records them, or null. */
  update: string | null;
}

const CLI_BIN = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));

const git = (cwd: string, args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** The repair whose change a fix is applied with: the one it was applied with, else the latest accepted one that counts for it. */
export function acceptedRepair(store: Store, fix: StoredFix): StoredRepair | null {
  return repairToApply(fixRecords(store, fix));
}

/** A repair a teammate ran, which came with a fix from the team store: its recordings stayed on their machine. */
const cameWithPull = (store: Store, repair: StoredRepair | null) => !!repair && store.repairPulled(repair.repairId) !== null;

const lstatOrNull = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

const slashes = (p: string) => p.split(/[\\/]+/).join('/');

/** A path as apply reports it: relative to the folder it runs in, with forward slashes on every system. */
const shown = (cwd: string, path: string) => relative(cwd, path).split(sep).join('/');

/**
 * The repair's directory and goldens, checked: a store can come from elsewhere (a copied file, a
 * shared bucket), and a path in it must not make apply read a patch, or copy a folder, from outside
 * the repair's own directory.
 */
function repairPaths(repair: StoredRepair): { dir: string; goldens: Array<{ path: string; name: string }> } {
  const dir = slashes(repair.dir).replace(/\/+$/, '');
  if (!/^repair-[0-9a-z]+$/.test(repair.repairId) || dir !== `.shadowlap/repairs/${repair.repairId}`) {
    throw new ApplyError(`the store gives ${repair.repairId} the directory "${repair.dir}", not .shadowlap/repairs/${repair.repairId}, so it is not used: repair again`);
  }
  const goldens = repair.report.output.goldens.map((g) => {
    const path = slashes(g);
    const name = path.slice(`${dir}/goldens/`.length);
    if (!path.startsWith(`${dir}/goldens/`) || !/^[\w.-]+$/.test(name) || name === '.' || name === '..') {
      throw new ApplyError(`the store lists "${g}" among ${repair.repairId}'s goldens, which is not inside ${dir}/goldens/, so nothing was applied: repair again`);
    }
    return { path, name };
  });
  return { dir, goldens };
}

export async function applyFix(store: Store, fix: StoredFix, o: ApplyOptions): Promise<ApplyResult> {
  const repair = acceptedRepair(store, fix);
  const pulled = cameWithPull(store, repair);
  const before = fix.data.applied ?? null;
  const again = fix.status === 'applied';
  const left = applyLeft(fix, repair, { pulled });
  if (again && !(left && (left.goldens || (left.test && o.test)))) {
    return { fixId: fix.fixId, status: 'already-applied', again: false, patch: before?.patch ?? 'none', repairId: before?.repairId ?? null, goldens: [], tests: before?.tests ?? 'skipped', outdated: [], update: null };
  }
  const result: ApplyResult = { fixId: fix.fixId, status: 'applied', again, patch: 'none', repairId: repair?.repairId ?? null, goldens: [], tests: 'skipped', outdated: [], update: null };

  if (repair) {
    const paths = repairPaths(repair);
    const top = git(o.cwd, ['rev-parse', '--show-toplevel']);
    if (top.status !== 0) throw new ApplyError('shadowlap fix apply changes the working tree with git apply, so it has to run inside the git repository the repair ran in');
    const root = top.stdout.trim();
    // The patch is the store's too: git apply would write whatever it names, so it goes in only as
    // the change the repair verified, one span of one file rewritten.
    const problem = repairPatchProblem(repair.report);
    if (problem) throw new ApplyError(`the patch ${repair.repairId} holds is not the change it verified: ${problem}. Nothing was changed: a repair only ever rewrites one span of one file, so read ${paths.dir}/fix.patch before you apply any of it by hand`);
    const file = repair.report.candidates.find((c) => c.id === repair.report.accepted)!.file;
    const target = lstatOrNull(join(root, file));
    if (target && !target.isFile()) throw new ApplyError(`${file} is not a plain file in this working tree (a symbolic link or a folder), so the patch was not applied: apply it by hand if you mean to`);
    // A repair rewrites only files git sees: a change to one git ignores (a dependency's code, say)
    // would show in neither git status nor git diff, so nobody would ever read it.
    if (git(root, ['check-ignore', '-q', '--', file]).status === 0) throw new ApplyError(`${file} is a path git ignores here, so a change to it would show in neither git status nor git diff: the patch was not applied. A repair only rewrites files git sees; read ${paths.dir}/fix.patch, and apply it by hand if you mean to`);
    const patch = resolve(o.cwd, paths.dir, 'fix.patch');
    if (!existsSync(patch)) throw new ApplyError(`the repair's patch is not in this folder (${paths.dir}/fix.patch): run shadowlap fix apply in the folder ${repair.repairId} ran in`);
    if (readFileSync(patch, 'utf8') !== repair.report.patch) throw new ApplyError(`${paths.dir}/fix.patch is not the patch ${repair.repairId} verified: it changed since. Nothing was changed: apply it by hand if you changed it on purpose, or repair again`);

    if (git(root, ['apply', '--reverse', '--check', patch]).status === 0) {
      result.patch = 'already';
      o.log(`  the patch is already in the working tree (${shown(o.cwd, patch)})`);
    } else {
      const check = git(root, ['apply', '--check', patch]);
      if (check.status !== 0) {
        const files = patchFiles(repair.report.patch ?? '');
        const dirty = files.length ? git(root, ['status', '--porcelain', '--', ...files]).stdout.trim() : '';
        const why = (check.stderr || check.stdout).trim().split('\n')[0] ?? '';
        throw new ApplyError(
          dirty
            ? `${files.join(', ')} ${files.length === 1 ? 'has' : 'have'} uncommitted changes the patch conflicts with (${why}). Nothing was changed: commit or stash them, then run shadowlap fix apply ${fix.fixId} again`
            : `the patch no longer applies: ${files.join(', ') || 'the file it changes'} changed since the repair (${why}). Nothing was changed: apply it by hand with git apply --3way ${shown(o.cwd, patch)}, or repair again`,
        );
      }
      const applied = git(root, ['apply', patch]);
      if (applied.status !== 0) throw new ApplyError(`git apply failed: ${(applied.stderr || applied.stdout).trim()}`);
      result.patch = 'applied';
      o.log(`  applied ${shown(o.cwd, patch)}`);
    }
    // A teammate's patch, just put in from the team store: nothing here runs it before it is read.
    const unread = pulled && result.patch === 'applied';

    // The recordings the repair made with the fixed code: replayed by `shadowlap test`, they fail the
    // build if the fix is ever undone. One copied before (by `repair --apply --goldens <dir>`, or an
    // earlier run of this) is tested where it is.
    const copiedBefore = (before?.goldens ?? []).map(slashes).filter((p) => !isAbsolute(p) && !/^[a-z]:/i.test(p) && !p.split('/').includes('..'));
    // A teammate's repair, from the team store: its recordings are on the machine that ran it.
    const elsewhere = pulled ? paths.goldens.length : 0;
    for (const g of pulled ? [] : paths.goldens) {
      const from = resolve(o.cwd, g.path);
      const known = copiedBefore.find((p) => basename(p) === g.name);
      const to = known ? resolve(o.cwd, known) : resolve(o.cwd, o.goldens, g.name);
      if (!existsSync(from)) {
        o.log(`  ! ${g.path} is gone, so it was not copied`);
        continue;
      }
      const copied = !existsSync(to);
      if (copied) cpSync(from, to, { recursive: true });
      result.goldens.push({ from: shown(o.cwd, from), to: shown(o.cwd, to), copied });
      o.log(`  ${copied ? 'copied' : 'already there:'} ${shown(o.cwd, to)}`);
    }
    if (elsewhere) o.log(`  ${elsewhere === 1 ? 'the recording' : `the ${elsewhere} recordings`} the fixed code made ${elsewhere === 1 ? 'stays' : 'stay'} on the machine that ran ${repair.repairId}, which came with a pull: commit ${elsewhere === 1 ? 'it' : 'them'} from there`);
    if (unread) o.log(`  it came with a pull from the team store, so nothing here runs it yet: read the change (git diff -- ${shown(o.cwd, join(root, file))}), then ${o.build ? `rebuild (${o.build}) and ` : ''}check your goldens against it with shadowlap test`);

    if (o.build && !unread) {
      const b = spawnSync(o.build, { cwd: o.cwd, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (b.status !== 0) o.log(`  ! ${o.build} failed: ${`${b.stdout ?? ''}${b.stderr ?? ''}`.trim().split('\n').slice(-3).join(' ')}`);
      else o.log(`  rebuilt: ${o.build}`);
    }
    if (o.test && result.goldens.length) result.tests = (await runTests(result.goldens.map((x) => x.to), o)) ? 'passed' : 'failed';
  } else {
    o.log('  verified on the working tree, with no repair behind it: there is no patch to apply');
  }

  const who = resolveAuthor({ cwd: o.cwd });
  // Applied before: the goldens it had already are still there, and when no test ran now, the last one's result stands.
  const goldens = [...new Set([...(before?.goldens ?? []), ...result.goldens.map((x) => slashes(x.to))])];
  const tests = result.tests === 'skipped' ? (before?.tests ?? 'skipped') : result.tests;
  markFixApplied(store, fix.fixId, { patch: again && before ? before.patch : result.patch, repairId: result.repairId, goldens, tests, by: who, via: 'fix apply' });
  recordEvent(store, { kind: 'fix.applied', actor: who, ref: fix.fixId, data: { title: fix.title, repairId: result.repairId, patch: result.patch, goldens: result.goldens.length, tests: result.tests, ...(again ? { again: true } : {}) } });

  // The patch is in, and the fix is marked applied: what it changed in every request may leave the
  // project's other goldens behind. Checked last, so a stop meanwhile loses nothing but the list.
  if (repair?.report.patch && result.patch !== 'none' && o.test && !(pulled && result.patch === 'applied')) {
    const check = await outdatedGoldens(store, { cwd: o.cwd, goldens: o.goldens, patch: repair.report.patch, skip: goldens, log: o.log });
    result.outdated = check.outdated;
    if (result.outdated.length) {
      result.update = quoteArgv(['shadowlap', 'test', ...result.outdated.map((g) => g.golden), '--update']);
      const where = [...new Set(result.outdated.map((g) => `#${g.callNo} ${g.path}`))];
      const n = result.outdated.length;
      o.log(`  ! ${n === 1 ? '1 golden diverges' : `${n} goldens diverge`} on what the patch changed (${where.slice(0, 2).join(', ')}${where.length > 2 ? ', …' : ''}): ${result.outdated.map((g) => g.golden).join(', ')}`);
      o.log(`    re-record ${n === 1 ? 'it' : 'them'} once the change is what you meant: ${result.update}`);
    } else if (check.checked) o.log('  none of them diverges on what the patch changed');
  }
  return result;
}

/** `shadowlap test` on the goldens, its output passed on line by line. True when every one passed. */
function runTests(dirs: string[], o: ApplyOptions): Promise<boolean> {
  const env = { ...process.env };
  delete env.SHADOWLAP_EVENTS_FD;
  o.log(`  shadowlap test ${dirs.join(' ')}`);
  return new Promise((resolveDone) => {
    const child = spawn(process.execPath, [CLI_BIN, ...(o.db ? ['--db', o.db] : []), 'test', ...dirs], { cwd: o.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let rest = '';
    const pass = (d: Buffer) => {
      rest += d.toString();
      const lines = rest.split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) o.log(`    ${line}`);
    };
    child.stdout.on('data', pass);
    child.stderr.on('data', pass);
    child.on('error', (err) => {
      o.log(`  ! shadowlap test could not start: ${err.message}`);
      resolveDone(false);
    });
    child.on('exit', (code) => {
      if (rest.trim()) o.log(`    ${rest}`);
      resolveDone(code === 0);
    });
  });
}
