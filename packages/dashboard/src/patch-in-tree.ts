import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { patchFiles } from '@shadowlap/engine';

/**
 * Whether a fix's patch is in the working tree already, as `shadowlap fix apply` recognises it:
 * `git apply --reverse --check` passes in the project's repository. A patch a pull request merged,
 * or one applied by hand, needs no applying: the fix's page offers Mark applied rather than Apply
 * the patch, and Needs a look leaves the fix out of what is ready to apply.
 *
 * git reads the working tree's files that the patch changes, nothing else, so an answer stands while
 * those files are as they were (their size and modification time): each project's answers are kept
 * per patch and asked again once a file changed, or after a minute. Null when git can't say (no git,
 * not a repository, a patch it can't read).
 */

/** How long an answer stands while the files look the same: a file rewritten within its timestamp's grain looks the same. */
const STANDS_FOR_MS = 60_000;
const KEPT = 200;

interface Answer {
  files: string;
  at: number;
  inTree: boolean | null;
}
const answers = new Map<string, Answer>();
const roots = new Map<string, { root: string | null; at: number }>();

/** Forgets what git said, for a test that changes the working tree between questions within a file's timestamp grain. */
export function forgetPatchAnswers(): void {
  answers.clear();
  roots.clear();
}

/** The repository a project folder is in, as git names it; asked again after a minute. */
function rootOf(dir: string, now: number): string | null {
  const known = roots.get(dir);
  if (known && now - known.at < STANDS_FOR_MS) return known.root;
  const out = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  const root = out.status === 0 ? out.stdout.trim() || null : null;
  if (roots.size >= 32) roots.delete(roots.keys().next().value!);
  roots.set(dir, { root, at: now });
  return root;
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

export function patchInTree(dir: string, patch: string, now: number = Date.now()): boolean | null {
  const root = rootOf(dir, now);
  if (!root) return null;
  const key = `${root}\0${createHash('sha256').update(patch).digest('hex')}`;
  const files = filesNow(root, patch);
  const known = answers.get(key);
  if (known && known.files === files && now - known.at < STANDS_FOR_MS) return known.inTree;
  // As fix apply checks it: the change as the repair verified it, no whitespace fixed or ignored.
  const out = spawnSync('git', ['-c', 'apply.ignoreWhitespace=no', 'apply', '--whitespace=nowarn', '--reverse', '--check'], { cwd: root, input: patch, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'ignore', 'ignore'] });
  const inTree = out.error || out.status === null ? null : out.status === 0;
  if (answers.size >= KEPT) answers.delete(answers.keys().next().value!);
  answers.set(key, { files, at: now, inTree });
  return inTree;
}
