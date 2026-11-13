import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitIndexStamp } from '../src/git-index.js';

/**
 * The stamp a read that asks git what it tracks is revalidated by (Run error-path presets…'s plan):
 * the repository's index, found from any folder in it, a worktree's too, which every `git add` rewrites.
 */

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

describe('the git index stamp', () => {
  it('is empty outside a repository, and moves with the index from any folder in one', () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'sl-git-index-')));
    const sub = join(root, 'goldens', 'refund');
    mkdirSync(sub, { recursive: true });
    expect(gitIndexStamp(sub)).toBe('');
    git(root, 'init', '-q');
    writeFileSync(join(sub, 'run.json'), '{}');
    git(root, 'add', '-f', '--', 'goldens/refund/run.json');
    const added = gitIndexStamp(sub);
    expect(added).not.toBe('');
    expect(gitIndexStamp(root)).toBe(added);
    git(root, 'rm', '-q', '--cached', '--', 'goldens/refund/run.json');
    expect(gitIndexStamp(sub)).not.toBe(added);
  });

  it("follows a worktree's .git file to the index it names", () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'sl-git-index-')));
    const meta = join(root, 'meta');
    const tree = join(root, 'tree');
    mkdirSync(meta, { recursive: true });
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(meta, 'index'), 'DIRC');
    writeFileSync(join(tree, '.git'), 'gitdir: ../meta\n');
    expect(gitIndexStamp(tree)).toMatch(/^4:/);
  });
});
