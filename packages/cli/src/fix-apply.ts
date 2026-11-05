import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyLeft, fixRecords, markFixApplied, messageOf, patchFiles, quoteArgv, recordEvent, repairPatchProblem, repairToApply, resolveAuthor, rewriteHere, safeLine, type Store, type StoreOf, type StoredFix, type StoredRepair } from '@shadowlap/engine';
import { fieldChange } from '@shadowlap/dashboard';
import { EXIT } from './exit-codes.js';
import { planCopies, type GivenName, type GoldenCopy } from './fix-apply-names.js';
import { outdatedGoldens, type OutdatedGolden } from './fix-outdated.js';
import { physicalPath } from './real-path.js';

/**
 * `shadowlap fix apply <fix>`: hands a verified fix over to the working tree. It applies the patch
 * of the repair whose candidate was accepted with `git apply`, to the file's bytes as they are
 * (`applyToBytes`), copies the recordings that repair made with the fixed code into the project's
 * goldens folder, each under a name of its own (`--name <run>=<name>`, else the fix's label: see
 * fix-apply-names.ts), runs `shadowlap test` on them, and marks the fix applied. A patch already in the
 * tree (applied by hand, committed, or by `repair --apply`) is recognised with `git apply --reverse
 * --check` and only marked. A tree whose changes conflict with the patch is left alone, with what
 * to do about it. A fix verified on the working tree itself, with no repair behind it, has no
 * patch: its change is already where it belongs, so it is only marked applied. On a fix applied
 * already, it finishes what was left: goldens not copied yet, and a test that hasn't passed. With
 * the patch in, it replays the project's other goldens offline and names those that now diverge on
 * what the patch changed, with the command that re-records them (`fix-outdated.ts`).
 *
 * A repair that came with a pull from the team store ran on a teammate's machine: its patch goes in
 * here only as a rewrite repair itself would make here (`rewriteHere`), and its recordings, which
 * stayed there, are neither copied nor tested here (they are committed from that machine). Nothing
 * here runs the code it put in, no build, test or replay, until someone has read it: the bucket is
 * someone else's data, and the patch is code.
 *
 * What it reads from the store decides what it touches, so it trusts no path there: the repair's
 * directory must be `.shadowlap/repairs/<its id>`, its goldens inside that directory's `goldens/`,
 * its patch the one rewrite its accepted candidate makes, to that candidate's file alone and in
 * place (`repairPatchProblem`), and its fix.patch that patch. The file it writes is a plain file of
 * the working tree, reached through no link to a folder.
 */

export class ApplyError extends Error {
  /** The status `fix apply` ends with: 1 for a patch refused or failed, 2 where it was run (not the repair's repository or folder) or what it was given (an open fix) can't be applied. */
  constructor(
    message: string,
    readonly exitCode: number = EXIT.failed,
  ) {
    super(message);
    this.name = 'ApplyError';
  }
}

export interface ApplyOptions {
  cwd: string;
  /** The project's goldens folder, relative to `cwd`. */
  goldens: string;
  /** The names the recordings of the fixed runs are copied under (`--name <run>=<name>`); one not named takes the name the fix's label makes. */
  names?: readonly GivenName[];
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
  /** Each golden: the run it holds a recording of (its short id), where it was copied from and to, and whether it was copied or already there. */
  goldens: Array<{ run: string; from: string; to: string; copied: boolean }>;
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

/**
 * `git apply` as apply runs it: the change as the repair verified it, whatever git's config says,
 * with no whitespace fixed (apply.whitespace) and none ignored to find where it goes
 * (apply.ignoreWhitespace, which would also take a line that ends with CRLF for one with LF).
 */
const APPLY = ['-c', 'apply.ignoreWhitespace=no', 'apply', '--whitespace=nowarn'];

/**
 * What the patch makes of the file's bytes as they are: whether it is in them already, else the
 * bytes with it applied, or null when it applies to neither. git apply in the working tree converts
 * what it reads and writes as core.autocrlf and the file's text, eol, ident and filter attributes
 * ask: where Git for Windows sets core.autocrlf, or where .gitattributes says `* text=auto` and the
 * line ending git writes is CRLF (Git for Windows' own), it writes a file whose lines end with LF
 * back with CRLF, every line of it, and the file is no longer the one the repair verified. Here git
 * applies the patch to the bytes as a blob, in an index of its own, where nothing is converted.
 */
function applyToBytes(root: string, file: string, patch: string): { already: boolean; bytes: Buffer | null } {
  let now: Buffer;
  try {
    now = readFileSync(join(root, file));
  } catch {
    // Not there, or not readable: git apply in the working tree says why.
    return { already: false, bytes: null };
  }
  const scratch = mkdtempSync(join(tmpdir(), 'shadowlap-apply-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') };
    const run = (args: string[], input?: Buffer) => spawnSync('git', args, { cwd: root, env, input, maxBuffer: 64 * 1024 * 1024 });
    const blob = run(['hash-object', '-w', '--stdin'], now);
    const staged = blob.status === 0 && run(['update-index', '--add', '--cacheinfo', `100644,${blob.stdout.toString().trim()},${file}`]).status === 0;
    if (staged && run([...APPLY, '--cached', '--reverse', '--check', patch]).status === 0) return { already: true, bytes: null };
    const out = staged && run([...APPLY, '--cached', patch]).status === 0 ? run(['cat-file', 'blob', `:0:${file}`]) : null;
    return { already: false, bytes: out?.status === 0 ? out.stdout : null };
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Held a moment longer on Windows (a virus scanner reading the new index, say): an index left
      // in the temporary folder harms nothing, and the patch still goes in.
    }
  }
}

/** The repair whose change a fix is applied with: the one it was applied with, else the latest accepted one that counts for it. */
export function acceptedRepair(store: StoreOf<'fixes'>, fix: StoredFix): StoredRepair | null {
  return repairToApply(fixRecords(store, fix));
}

/** A repair a teammate ran, which came with a fix from the team store: its recordings stayed on their machine. */
const cameWithPull = (store: StoreOf<'team'>, repair: StoredRepair | null) => !!repair && store.repairPulled(repair.repairId) !== null;

const lstatOrNull = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

/** The first folder on the way to a file of the repository that is a link (a symbolic link, a junction), or null. */
function linkOnTheWay(root: string, file: string): string | null {
  const dirs = file.split('/').slice(0, -1);
  for (let i = 1; i <= dirs.length; i++) {
    const dir = dirs.slice(0, i).join('/');
    if (lstatOrNull(join(root, dir))?.isSymbolicLink()) return dir;
  }
  return null;
}

const slashes = (p: string) => p.split(/[\\/]+/).join('/');

/** A path as apply reports it: relative to the folder it runs in, with forward slashes on every system. */
const shown = (cwd: string, path: string) => relative(cwd, path).split(sep).join('/');

/**
 * A file of the repository as apply reports it, from the folder it runs in: both named as the system
 * names them, since git gives the root with links resolved and, on Windows, its long name, where the
 * folder may have been reached through a link or by a short name (C:\Users\RUNNER~1).
 */
const shownInRepo = (cwd: string, root: string, file: string) => shown(physicalPath(cwd), join(physicalPath(root), file));

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

/** A patch from the store that is not the change its repair verified, or not one a repair makes here: nothing goes in, and it says why. */
const refused = (repair: StoredRepair, problem: string, dir: string) =>
  new ApplyError(`the patch ${repair.repairId} holds is not the change it verified: ${problem}. Nothing was changed: a repair only ever rewrites one span of one file, so read ${dir}/fix.patch before you apply any of it by hand`);

/**
 * Refuses a teammate's patch unless it is a rewrite repair itself would make in this working tree
 * (`rewriteHere`): a teammate's machine or the bucket could have written it, so it goes in only as
 * one rewrite of text inside a string of the agent's code, or of a prose file, read in `path` as it
 * is here. Git has found where the patch goes; the check finds that place too, or nothing goes in.
 */
function heldToRepair(repair: StoredRepair, path: string, dir: string): void {
  const file = repair.report.candidates.find((c) => c.id === repair.report.accepted)!.file;
  const here = rewriteHere(repair.report, readFileSync(path, 'utf8'));
  const problem = here ? here.problem : `here, git apply finds a place for it in ${file} where the lines it changes are not, as the check reads the file`;
  if (problem) throw refused(repair, problem, dir);
}

/**
 * Puts the patch in: the file's bytes as git applied it to them (`applyToBytes`), else as `git apply`
 * puts it in the working tree, converting line endings. `before` runs once git has found where the
 * patch goes, before anything is written. A tree whose changes conflict with the patch is left alone,
 * with what to do about it.
 */
function putIn(at: { root: string; file: string; patch: string; text: string; bytes: Buffer | null; cwd: string; fixId: string }, before: (() => void) | null): void {
  const { root, file, patch } = at;
  if (at.bytes) {
    before?.();
    try {
      writeFileSync(join(root, file), at.bytes);
    } catch (err) {
      throw new ApplyError(`writing ${file} failed: ${messageOf(err)}`);
    }
    return;
  }
  const check = git(root, [...APPLY, '--check', patch]);
  if (check.status !== 0) {
    const files = patchFiles(at.text);
    const dirty = files.length ? git(root, ['status', '--porcelain', '--', ...files]).stdout.trim() : '';
    const why = (check.stderr || check.stdout).trim().split('\n')[0] ?? '';
    throw new ApplyError(
      dirty
        ? `${files.join(', ')} ${files.length === 1 ? 'has' : 'have'} uncommitted changes the patch conflicts with (${why}). Nothing was changed: commit or stash them, then run shadowlap fix apply ${at.fixId} again`
        : `the patch no longer applies: ${files.join(', ') || 'the file it changes'} changed since the repair (${why}). Nothing was changed: apply it by hand with git apply --3way ${shown(at.cwd, patch)}, or repair again`,
    );
  }
  before?.();
  const applied = git(root, [...APPLY, patch]);
  if (applied.status !== 0) throw new ApplyError(`git apply failed: ${(applied.stderr || applied.stdout).trim()}`);
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
    if (top.status !== 0) throw new ApplyError('shadowlap fix apply changes the working tree with git apply, so it has to run inside the git repository the repair ran in', EXIT.usage);
    const root = top.stdout.trim();
    // The patch is the store's too: git apply would write whatever it names, so it goes in only as
    // the change the repair verified, one span of one file rewritten.
    const problem = repairPatchProblem(repair.report);
    if (problem) throw refused(repair, problem, paths.dir);
    const file = repair.report.candidates.find((c) => c.id === repair.report.accepted)!.file;
    const target = lstatOrNull(join(root, file));
    if (target && !target.isFile()) throw new ApplyError(`${file} is not a plain file in this working tree (a symbolic link or a folder), so the patch was not applied: apply it by hand if you mean to`);
    // The file is written here, and a link to a folder on the way could lead it out of the working
    // tree: git apply writes nothing beyond one either.
    const link = linkOnTheWay(root, file);
    if (link) throw new ApplyError(`${file} is reached through ${link}, which is a link in this working tree, so the patch was not applied: apply it by hand if you mean to`);
    // A repair rewrites only files git sees: a change to one git ignores (a dependency's code, say)
    // would show in neither git status nor git diff, so nobody would ever read it.
    if (git(root, ['check-ignore', '-q', '--', file]).status === 0) throw new ApplyError(`${file} is a path git ignores here, so a change to it would show in neither git status nor git diff: the patch was not applied. A repair only rewrites files git sees; read ${paths.dir}/fix.patch, and apply it by hand if you mean to`);
    const patch = resolve(o.cwd, paths.dir, 'fix.patch');
    if (!existsSync(patch)) throw new ApplyError(`the repair's patch is not in this folder (${paths.dir}/fix.patch): run shadowlap fix apply in the folder ${repair.repairId} ran in`, EXIT.usage);
    if (readFileSync(patch, 'utf8') !== repair.report.patch) throw new ApplyError(`${paths.dir}/fix.patch is not the patch ${repair.repairId} verified: it changed since. Nothing was changed: apply it by hand if you changed it on purpose, or repair again`);
    // Where each recording goes, under the name it is given: one that won't do changes nothing.
    const plan = planCopies(store, fix, repair, { cwd: o.cwd, goldens: o.goldens, given: o.names ?? [], pulled, sources: paths.goldens.map((g) => g.path) });
    if ('problem' in plan) throw new ApplyError(plan.problem, EXIT.usage);

    // The patch goes in on the file's bytes as they are, so the file is the one the repair verified. A
    // patch whose lines end otherwise than the file's (a teammate's, made in a checkout with LF, for a
    // Windows checkout's file with CRLF) applies only through git's conversion: then it goes in as
    // git apply puts it in, with git's own settings, which give the file back its CRLF.
    const asIs = applyToBytes(root, file, patch);
    if (asIs.already || git(root, [...APPLY, '--reverse', '--check', patch]).status === 0) {
      result.patch = 'already';
      o.log(`  the patch is already in the working tree (${shown(o.cwd, patch)})`);
    } else {
      // A teammate's patch goes in only as a rewrite repair itself would make here.
      putIn({ root, file, patch, text: repair.report.patch ?? '', bytes: asIs.bytes, cwd: o.cwd, fixId: fix.fixId }, pulled ? () => heldToRepair(repair, join(root, file), paths.dir) : null);
      result.patch = 'applied';
      o.log(`  applied ${shown(o.cwd, patch)}`);
    }
    // A teammate's patch, just put in from the team store: nothing here runs it before it is read.
    const unread = pulled && result.patch === 'applied';

    // The recordings the repair made with the fixed code: replayed by `shadowlap test`, they fail the
    // build if the fix is ever undone. One copied before (by `repair --apply --goldens <dir>`, or an
    // earlier run of this) is tested where it is. A teammate's repair, from the team store: its
    // recordings are on the machine that ran it, and none is copied.
    const elsewhere = pulled ? paths.goldens.length : 0;
    result.goldens.push(...copyGoldens(plan.copies, o));
    if (elsewhere) o.log(`  ${elsewhere === 1 ? 'the recording' : `the ${elsewhere} recordings`} the fixed code made ${elsewhere === 1 ? 'stays' : 'stay'} on the machine that ran ${repair.repairId}, which came with a pull: commit ${elsewhere === 1 ? 'it' : 'them'} from there`);
    if (unread) o.log(`  it came with a pull from the team store, so nothing here runs it yet: read the change (git diff -- ${shownInRepo(o.cwd, root, file)}), then ${o.build ? `rebuild (${o.build}) and ` : ''}check your goldens against it with shadowlap test`);

    if (o.build && !unread) {
      const b = spawnSync(o.build, { cwd: o.cwd, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (b.status !== 0) o.log(`  ! ${o.build} failed: ${`${b.stdout ?? ''}${b.stderr ?? ''}`.trim().split('\n').slice(-3).join(' ')}`);
      else o.log(`  rebuilt: ${o.build}`);
    }
    if (o.test && result.goldens.length) result.tests = (await runTests(result.goldens.map((x) => x.to), o)) ? 'passed' : 'failed';
  } else {
    // A change of request fields (--set, --model) is in no file: making it in the agent is left to you.
    const change = fieldChange(fixRecords(store, fix));
    o.log(change ? `  verified with ${safeLine(change)}, a change to the requests no patch carries: make it in your agent` : '  verified on the working tree, with no repair behind it: there is no patch to apply');
  }

  const who = resolveAuthor({ cwd: o.cwd });
  // Applied before: the goldens it had already are still there, and when no test ran now, the last
  // one's result stands. Each is kept with the run it holds a recording of: its name may be any.
  const goldens = [...new Set([...(before?.goldens ?? []), ...result.goldens.map((x) => slashes(x.to))])];
  const from = { ...before?.from, ...Object.fromEntries(result.goldens.map((x) => [slashes(x.to), x.run])) };
  const tests = result.tests === 'skipped' ? (before?.tests ?? 'skipped') : result.tests;
  markFixApplied(store, fix.fixId, { patch: again && before ? before.patch : result.patch, repairId: result.repairId, goldens, tests, by: who, via: 'fix apply', ...(Object.keys(from).length ? { from } : {}) });
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

/**
 * Copies each recording of the fixed runs where the plan puts it, unless one is there already
 * (copied before, or by an apply stopped before it marked the fix applied), saying which: a golden
 * named otherwise than its run says which run's recording it holds.
 */
function copyGoldens(copies: readonly GoldenCopy[], o: ApplyOptions): ApplyResult['goldens'] {
  const done: ApplyResult['goldens'] = [];
  for (const c of copies) {
    const from = resolve(o.cwd, c.source);
    const to = resolve(o.cwd, c.to);
    if (!existsSync(from)) {
      o.log(`  ! ${c.source} is gone, so it was not copied`);
      continue;
    }
    const copied = !existsSync(to);
    if (copied) cpSync(from, to, { recursive: true });
    done.push({ run: c.run, from: shown(o.cwd, from), to: shown(o.cwd, to), copied });
    o.log(copied ? `  copied ${shown(o.cwd, to)}${basename(to) === c.run ? '' : ` from ${c.run}`}` : `  already there: ${shown(o.cwd, to)}`);
  }
  return done;
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
