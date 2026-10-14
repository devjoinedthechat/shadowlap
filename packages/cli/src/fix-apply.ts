import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixRecords, markFixApplied, recordEvent, resolveAuthor, type Store, type StoredFix, type StoredRepair } from '@shadowlap/engine';

/**
 * `shadowlap fix apply <fix>`: hands a verified fix over to the working tree. It `git apply`s the
 * patch of the repair whose candidate was accepted, copies the recordings that repair made with the
 * fixed code into the project's goldens folder, runs `shadowlap test` on them, and marks the fix
 * applied. A patch already in the tree (applied by hand, or committed) is recognised with
 * `git apply --reverse --check` and only marked. A tree whose changes conflict with the patch is
 * left alone, with what to do about it. A fix verified on the working tree itself, with no repair
 * behind it, has no patch: its change is already where it belongs, so it is only marked applied.
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
  /** `already-applied` when the fix was marked applied before this run. */
  status: 'applied' | 'already-applied';
  /** What happened to the patch: applied now, found in the tree already, or none to apply. */
  patch: 'applied' | 'already' | 'none';
  repairId: string | null;
  /** Each golden, where it was copied to, and whether it was copied or already there. */
  goldens: Array<{ from: string; to: string; copied: boolean }>;
  tests: 'passed' | 'failed' | 'skipped';
}

const CLI_BIN = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));

const git = (cwd: string, args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** The repair whose candidate a fix was verified with: the latest accepted one linked to it. */
export function acceptedRepair(store: Store, fix: StoredFix): StoredRepair | null {
  return [...fixRecords(store, fix).repairs].reverse().find((r) => r.accepted && r.report.patch) ?? null;
}

/** Files a unified diff touches, by their path in the repository. */
function patchedFiles(patch: string): string[] {
  return [...new Set([...patch.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]!))];
}

export async function applyFix(store: Store, fix: StoredFix, o: ApplyOptions): Promise<ApplyResult> {
  if (fix.status === 'applied') return { fixId: fix.fixId, status: 'already-applied', patch: fix.data.applied?.patch ?? 'none', repairId: fix.data.applied?.repairId ?? null, goldens: [], tests: 'skipped' };
  const repair = acceptedRepair(store, fix);
  const result: ApplyResult = { fixId: fix.fixId, status: 'applied', patch: 'none', repairId: repair?.repairId ?? null, goldens: [], tests: 'skipped' };

  if (repair) {
    const top = git(o.cwd, ['rev-parse', '--show-toplevel']);
    if (top.status !== 0) throw new ApplyError('shadowlap fix apply changes the working tree with git apply, so it has to run inside the git repository the repair ran in');
    const root = top.stdout.trim();
    const patch = resolve(o.cwd, repair.dir, 'fix.patch');
    if (!existsSync(patch)) throw new ApplyError(`the repair's patch is not in this folder (${repair.dir}/fix.patch): run shadowlap fix apply in the folder ${repair.repairId} ran in`);

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
    // build if the fix is ever undone.
    for (const g of repair.report.output.goldens) {
      const from = resolve(o.cwd, g);
      const to = resolve(o.cwd, o.goldens, basename(g));
      if (!existsSync(from)) {
        o.log(`  ! ${g} is gone, so it was not copied`);
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
    }
    if (o.test && result.goldens.length) result.tests = (await runTests(result.goldens.map((x) => x.to), o)) ? 'passed' : 'failed';
  } else {
    o.log('  verified on the working tree, with no repair behind it: there is no patch to apply');
  }

  const who = resolveAuthor({ cwd: o.cwd });
  markFixApplied(store, fix.fixId, { patch: result.patch, repairId: result.repairId, goldens: result.goldens.map((x) => x.to.split(/[\\/]+/).join('/')), tests: result.tests, by: who });
  recordEvent(store, { kind: 'fix.applied', actor: who, ref: fix.fixId, data: { title: fix.title, repairId: result.repairId, patch: result.patch, goldens: result.goldens.length, tests: result.tests } });
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
