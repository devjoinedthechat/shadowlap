import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AFTER, BEFORE } from '../../engine/test/fix-fixtures.js';
import { forgetPatchAnswers, patchInTree } from '../src/patch-in-tree.js';

/**
 * Whether a fix's patch is in the working tree already, as `fix apply` recognises it: `git apply
 * --reverse --check` in the project's repository, from a folder inside it too, asked again once a
 * file the patch changes is no longer as it was.
 */

let repo: string;
const PATCH = `diff --git a/agent.mjs b/agent.mjs\n--- a/agent.mjs\n+++ b/agent.mjs\n@@ -1,1 +1,1 @@\n-${BEFORE}\n+${AFTER}\n`;

beforeEach(() => {
  forgetPatchAnswers();
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'sl-patch-in-tree-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  writeFileSync(join(repo, 'agent.mjs'), `${BEFORE}\n`);
  git('init', '-q', '-b', 'main');
  git('add', 'agent.mjs');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'agent');
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('a patch in the working tree', () => {
  it('is not there until its change is, and is once it is, merged or applied by hand', () => {
    const t = 1_000_000;
    expect(patchInTree(repo, PATCH, t)).toBe(false);
    // Applied by hand, not committed: the file changed, so git is asked again at once.
    writeFileSync(join(repo, 'agent.mjs'), `${AFTER}\n`);
    expect(patchInTree(repo, PATCH, t + 1)).toBe(true);
    // From the project's folder inside the repository, as the patch names files from its root.
    mkdirSync(join(repo, 'agents'));
    expect(patchInTree(join(repo, 'agents'), PATCH, t + 2)).toBe(true);
    // Taken out again: not there.
    writeFileSync(join(repo, 'agent.mjs'), `${BEFORE}\n// changed since\n`);
    expect(patchInTree(repo, PATCH, t + 3)).toBe(false);
  });

  it('keeps its answer while the files the patch changes stay as they were, for a minute', () => {
    const t = 1_000_000;
    expect(patchInTree(repo, PATCH, t)).toBe(false);
    // Moved out of git's reach: an answer kept is given again, not asked of git.
    rmSync(join(repo, '.git'), { recursive: true, force: true });
    expect(patchInTree(repo, PATCH, t + 30_000)).toBe(false);
  });

  it('says nothing outside a repository', () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'sl-patch-in-tree-plain-')));
    try {
      writeFileSync(join(plain, 'agent.mjs'), `${AFTER}\n`);
      expect(patchInTree(plain, PATCH)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
