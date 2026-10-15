import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyLeft, fixRecords, markFixApplied, recordEvent, repairToApply, resolveAuthor, type Store, type StoredFix, type StoredRepair } from '@shadowlap/engine';

/**
 * `shadowlap fix apply <fix>`: hands a verified fix over to the working tree. It `git apply`s the
 * patch of the repair whose candidate was accepted, copies the recordings that repair made with the
 * fixed code into the project's goldens folder, runs `shadowlap test` on them, and marks the fix
 * applied. A patch already in the tree (applied by hand, committed, or by `repair --apply`) is
 * recognised with `git apply --reverse --check` and only marked. A tree whose changes conflict with
 * the patch is left alone, with what to do about it. A fix verified on the working tree itself,
 * with no repair behind it, has no patch: its change is already where it belongs, so it is only
 * marked applied. On a fix applied already, it finishes what was left: goldens not copied yet, and
 * a test that hasn't passed.
 *
 * What it reads from the store decides what it touches, so it trusts no path there: the repair's
 * directory must be `.shadowlap/repairs/<its id>`, its goldens inside that directory's `goldens/`,
 * and its fix.patch the patch the repair verified.
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
}

const CLI_BIN = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));

const git = (cwd: string, args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** The repair whose change a fix is applied with: the one it was applied with, else the latest accepted one that counts for it. */
export function acceptedRepair(store: Store, fix: StoredFix): StoredRepair | null {
  return repairToApply(fixRecords(store, fix));
}

/** Files a unified diff touches, by their path in the repository. */
function patchedFiles(patch: string): string[] {
  return [...new Set([...patch.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]!))];
}

const slashes = (p: string) => p.split(/[\\/]+/).join('/');

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
  const before = fix.data.applied ?? null;
  const again = fix.status === 'applied';
  const left = applyLeft(fix, repair);
  if (again && !(left && (left.goldens || (left.test && o.test)))) {
    return { fixId: fix.fixId, status: 'already-applied', again: false, patch: before?.patch ?? 'none', repairId: before?.repairId ?? null, goldens: [], tests: before?.tests ?? 'skipped' };
  }
  const result: ApplyResult = { fixId: fix.fixId, status: 'applied', again, patch: 'none', repairId: repair?.repairId ?? null, goldens: [], tests: 'skipped' };

  if (repair) {
    const paths = repairPaths(repair);
    const top = git(o.cwd, ['rev-parse', '--show-toplevel']);
    if (top.status !== 0) throw new ApplyError('shadowlap fix apply changes the working tree with git apply, so it has to run inside the git repository the repair ran in');
    const root = top.stdout.trim();
    const patch = resolve(o.cwd, paths.dir, 'fix.patch');
    if (!existsSync(patch)) throw new ApplyError(`the repair's patch is not in this folder (${paths.dir}/fix.patch): run shadowlap fix apply in the folder ${repair.repairId} ran in`);
    if (readFileSync(patch, 'utf8') !== repair.report.patch) throw new ApplyError(`${paths.dir}/fix.patch is not the patch ${repair.repairId} verified: it changed since. Nothing was changed: apply it by hand if you changed it on purpose, or repair again`);

    if (git(root, ['apply', '--reverse', '--check', patch]).status === 0) {
      result.patch = 'already';
      o.log(`  the patch is already in the working tree (${relative(o.cwd, patch)})`);
    } else {
      const check = git(root, ['apply', '--check', patch]);
      if (check.status !== 0) {
        const files = patchedFiles(repair.report.patch ?? '');
        const dirty = files.length ? git(root, ['status', '--porcelain', '--', ...files]).stdout.trim() : '';
        const why = (check.stderr || check.stdout).trim().split('\n')[0] ?? '';
        throw new ApplyError(
          dirty
            ? `${files.join(', ')} ${files.length === 1 ? 'has' : 'have'} uncommitted changes the patch conflicts with (${why}). Nothing was changed: commit or stash them, then run shadowlap fix apply ${fix.fixId} again`
            : `the patch no longer applies: ${files.join(', ') || 'the file it changes'} changed since the repair (${why}). Nothing was changed: apply it by hand with git apply --3way ${relative(o.cwd, patch)}, or repair again`,
        );
      }
      const applied = git(root, ['apply', patch]);
      if (applied.status !== 0) throw new ApplyError(`git apply failed: ${(applied.stderr || applied.stdout).trim()}`);
      result.patch = 'applied';
      o.log(`  applied ${relative(o.cwd, patch)}`);
    }

    // The recordings the repair made with the fixed code: replayed by `shadowlap test`, they fail the
    // build if the fix is ever undone. One copied before (by `repair --apply --goldens <dir>`, or an
    // earlier run of this) is tested where it is.
    const copiedBefore = (before?.goldens ?? []).map(slashes).filter((p) => !isAbsolute(p) && !/^[a-z]:/i.test(p) && !p.split('/').includes('..'));
    for (const g of paths.goldens) {
      const from = resolve(o.cwd, g.path);
      const known = copiedBefore.find((p) => basename(p) === g.name);
      const to = known ? resolve(o.cwd, known) : resolve(o.cwd, o.goldens, g.name);
      if (!existsSync(from)) {
        o.log(`  ! ${g.path} is gone, so it was not copied`);
        continue;
      }
      const copied = !existsSync(to);
      if (copied) cpSync(from, to, { recursive: true });
      result.goldens.push({ from: relative(o.cwd, from), to: relative(o.cwd, to), copied });
      o.log(`  ${copied ? 'copied' : 'already there:'} ${relative(o.cwd, to)}`);
    }

    if (o.build) {
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
