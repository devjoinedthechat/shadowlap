import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { patchFiles, rewriteHere, type StoredRepair } from '@shadowlap/engine';
import type { PatchCheck, RewriteCheck } from './fixes.js';

/**
 * Whether a fix's patch is in the working tree already, as `shadowlap fix apply` recognises it:
 * `git apply --reverse --check` passes in the project's repository. A patch a pull request merged,
 * or one applied by hand, needs no applying: the fix's page offers Mark applied rather than Apply
 * the patch, and Needs a look leaves the fix out of what is ready to apply.
 *
 * git runs beside the server, never in its way: each question is a child process the server waits
 * for without stopping (`execFile`), so other requests are answered meanwhile. It reads the working
 * tree's files that the patch changes, nothing else, so an answer stands while those files are as
 * they were (their size and modification time): each project's answers are kept per patch and asked
 * again once a file changed, or after a minute. The same question asked twice at once runs git once.
 * Null when git can't say (no git, not a repository, a patch it can't read).
 *
 * Beside it, why `fix apply` refuses a pulled repair's patch in the working tree (`rewritesHere`):
 * it goes in only as a rewrite repair itself makes there, which the file as it is tells.
 */

/** How long an answer stands while the files look the same: a file rewritten within its timestamp's grain looks the same. */
const STANDS_FOR_MS = 60_000;
const KEPT = 200;
/** How long git gets to answer. */
const GIT_TIMEOUT_MS = 5000;

interface Answer {
  files: string;
  at: number;
  inTree: boolean | null;
}
const answers = new Map<string, Answer>();
const roots = new Map<string, { root: string | null; at: number }>();
/** Questions on their way to git, so the same one asked again meanwhile waits for the same answer. */
const asking = new Map<string, Promise<unknown>>();

/** Forgets what git said, for a test that changes the working tree between questions within a file's timestamp grain. */
export function forgetPatchAnswers(): void {
  answers.clear();
  roots.clear();
}

/** Runs git in `cwd` and resolves with its exit code and output, never throwing: a code of null when it could not run or was stopped. */
export function gitAsync(cwd: string, args: readonly string[], o: { input?: string; timeoutMs?: number; maxBuffer?: number } = {}): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof execFile>;
    try {
      child = execFile('git', [...args], { cwd, encoding: 'utf8', timeout: o.timeoutMs ?? GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: o.maxBuffer ?? 4 * 1024 * 1024 }, (err, stdout) => {
        if (!err) return resolve({ code: 0, stdout });
        const code = (err as { code?: unknown }).code;
        // A number is git's own exit code; anything else (ENOENT, a timeout's signal) means it did not answer.
        resolve({ code: typeof code === 'number' && !(err as { killed?: boolean }).killed ? code : null, stdout: String(stdout ?? '') });
      });
    } catch {
      return resolve({ code: null, stdout: '' });
    }
    // git may stop reading before the end of what it is given (a patch it can't parse): that is its answer, not an error here.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(o.input ?? '');
  });
}

/** Asks once for a key at a time: a question already on its way is waited for. */
function once<T>(key: string, ask: () => Promise<T>): Promise<T> {
  const known = asking.get(key) as Promise<T> | undefined;
  if (known) return known;
  const p = ask().finally(() => asking.delete(key));
  asking.set(key, p);
  return p;
}

/** The repository a project folder is in, as git names it; asked again after a minute. */
async function rootOf(dir: string, now: number): Promise<string | null> {
  const known = roots.get(dir);
  if (known && now - known.at < STANDS_FOR_MS) return known.root;
  return once(`root\0${dir}`, async () => {
    const out = await gitAsync(dir, ['rev-parse', '--show-toplevel']);
    const root = out.code === 0 ? out.stdout.trim() || null : null;
    if (roots.size >= 32) roots.delete(roots.keys().next().value!);
    roots.set(dir, { root, at: now });
    return root;
  });
}

/** The files a patch changes, each by its size and time, or that it is missing. */
function filesNow(root: string, patch: string): string {
  return patchFiles(patch)
    .map((f) => {
      try {
        const st = statSync(join(root, f));
        return `${f}:${st.size}:${st.mtimeMs}`;
      } catch {
        return `${f}:none`;
      }
    })
    .join('\n');
}

/** Whether `patch` is in the working tree of the repository `dir` is in; null when git can't say. */
export async function patchInTree(dir: string, patch: string, now: number = Date.now()): Promise<boolean | null> {
  const root = await rootOf(dir, now);
  if (!root) return null;
  const key = `${root}\0${createHash('sha256').update(patch).digest('hex')}`;
  const files = filesNow(root, patch);
  const known = answers.get(key);
  if (known && known.files === files && now - known.at < STANDS_FOR_MS) return known.inTree;
  return once(`patch\0${key}\0${files}`, async () => {
    // As fix apply checks it: the change as the repair verified it, no whitespace fixed or ignored.
    const out = await gitAsync(root, ['-c', 'apply.ignoreWhitespace=no', 'apply', '--whitespace=nowarn', '--reverse', '--check'], { input: patch });
    const inTree = out.code === null ? null : out.code === 0;
    if (answers.size >= KEPT) answers.delete(answers.keys().next().value!);
    answers.set(key, { files, at: now, inTree });
    return inTree;
  });
}

/**
 * Asks git about each of `patches` at once, and returns the check a read model takes
 * (`PatchCheck`), which looks each answer up: a read model works synchronously, so what it will ask
 * is asked here first. A patch not among them reads as one git can't say about.
 */
export async function patchesInTree(dir: string, patches: readonly string[], now: number = Date.now()): Promise<PatchCheck> {
  const unique = [...new Set(patches)];
  const found = await Promise.all(unique.map((p) => patchInTree(dir, p, now)));
  const byPatch = new Map(unique.map((p, i) => [p, found[i]!]));
  return (patch) => byPatch.get(patch) ?? null;
}

/**
 * The text of `file` in the working tree at `root`, as `fix apply` would write it: a plain file
 * reached through no link. Null for anything else, which apply refuses by itself, saying why.
 */
async function plainFileText(root: string, file: string): Promise<string | null> {
  const parts = file.split('/');
  try {
    for (let i = 1; i <= parts.length; i++) {
      const st = await lstat(join(root, ...parts.slice(0, i)));
      if (st.isSymbolicLink() || (i === parts.length && !st.isFile())) return null;
    }
    return await readFile(join(root, file), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Why `fix apply` refuses each of `repairs`' patches in the working tree of the repository `dir` is
 * in (`rewriteHere`): a pull brought them, and such a patch goes in only as a rewrite repair itself
 * makes there, which only the file as it is can tell. Read beside the server, as git is asked, and
 * handed to a read model as the check it takes (`RewriteCheck`), which looks each answer up.
 */
export async function rewritesHere(dir: string, repairs: readonly StoredRepair[], now: number = Date.now()): Promise<RewriteCheck> {
  const root = repairs.length ? await rootOf(dir, now) : null;
  const refused = new Map<string, string>();
  for (const r of root ? repairs : []) {
    const file = r.report.candidates.find((c) => c.id === r.report.accepted)?.file;
    const text = file ? await plainFileText(root!, file) : null;
    const problem = text === null ? null : rewriteHere(r.report, text)?.problem;
    if (problem) refused.set(r.repairId, problem);
  }
  return (repairId) => refused.get(repairId) ?? null;
}
