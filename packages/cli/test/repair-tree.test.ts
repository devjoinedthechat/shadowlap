import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { candidateTree } from '../src/repair-tree.js';

/**
 * The worktree repair verifies a candidate in: the working tree as it is, outside it. A repository
 * with every kind of file it treats apart: committed, changed and not committed, deleted, untracked,
 * and of what git ignores a .env, build output, data past the copy limit, packages, a virtual
 * environment and Python's caches.
 */
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const write = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};

function repository(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sl-repair-tree-')));
  dirs.push(root);
  sh(root, 'init', '-q', '-b', 'main');
  write(join(root, '.gitignore'), '.env\ndist/\ndata/\nnode_modules/\n.venv/\n__pycache__/\n');
  write(join(root, 'agent', 'agent.mjs'), "export const system = 'Follow the refund policy.';\n");
  write(join(root, 'agent', 'gone.mjs'), 'export {};\n');
  write(join(root, 'README.md'), 'The agent.\n');
  sh(root, 'add', '.');
  sh(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'agent');
  // The working tree as a repair finds it.
  write(join(root, 'agent', 'agent.mjs'), "export const system = 'Follow the refund policy, as changed.';\n");
  rmSync(join(root, 'agent', 'gone.mjs'));
  write(join(root, 'agent', 'notes.txt'), 'untracked');
  write(join(root, '.env'), 'KEY=1\n');
  write(join(root, 'dist', 'agent.js'), 'built');
  write(join(root, 'data', 'big.json'), 'x'.repeat(4000));
  write(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  write(join(root, '.venv', 'pyvenv.cfg'), 'home = /usr/bin\n');
  write(join(root, 'agent', '__pycache__', 'agent.cpython-312.pyc'), 'cached');
  return root;
}

describe("a candidate's worktree", () => {
  it('is the working tree as it is, outside it: changes copied, ignored files copied, linked or left out by kind, and gone once removed', () => {
    const root = repository();
    const tree = candidateTree(root, join(root, 'agent'), { copyLimit: 1000 });
    try {
      expect(tree.root.startsWith(root)).toBe(false);
      expect(tree.cwd).toBe(join(tree.root, 'agent'));
      // Committed, changed, deleted and untracked, as the working tree has them.
      expect(readFileSync(join(tree.root, 'README.md'), 'utf8')).toBe('The agent.\n');
      expect(readFileSync(join(tree.cwd, 'agent.mjs'), 'utf8')).toContain('as changed');
      expect(existsSync(join(tree.cwd, 'gone.mjs'))).toBe(false);
      expect(readFileSync(join(tree.cwd, 'notes.txt'), 'utf8')).toBe('untracked');
      // Ignored: small files and folders copied, past the limit linked and named, packages and a
      // virtual environment linked, Python's caches left out.
      expect(lstatSync(join(tree.root, '.env')).isFile()).toBe(true);
      expect(lstatSync(join(tree.root, 'dist')).isDirectory()).toBe(true);
      expect(readFileSync(join(tree.root, 'dist', 'agent.js'), 'utf8')).toBe('built');
      expect(lstatSync(join(tree.root, 'data')).isSymbolicLink()).toBe(true);
      expect(tree.linked).toEqual(['data']);
      expect(realpathSync(join(tree.root, 'node_modules', 'left-pad'))).toBe(join(root, 'node_modules', 'left-pad'));
      expect(readlinkSync(join(tree.root, '.venv'))).toBe(join(root, '.venv'));
      expect(existsSync(join(tree.cwd, '__pycache__'))).toBe(false);
      // A recorded absolute path into the repository runs the worktree's copy.
      expect(tree.argv(['node', join(root, 'agent', 'agent.mjs')])).toEqual(['node', join(tree.root, 'agent', 'agent.mjs')]);
      // The working tree itself is as it was, and git knows the worktree.
      expect(sh(root, 'status', '--porcelain')).toBe(' M agent/agent.mjs\n D agent/gone.mjs\n?? agent/notes.txt\n');
      expect(sh(root, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '))).toHaveLength(2);
    } finally {
      tree.remove();
    }
    expect(existsSync(tree.root)).toBe(false);
    expect(sh(root, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '))).toHaveLength(1);
    // The data that was linked is still there, untouched.
    expect(readFileSync(join(root, 'data', 'big.json'), 'utf8')).toHaveLength(4000);
  });

  it('copies everything from a repository with no commit yet', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sl-repair-tree-')));
    dirs.push(root);
    sh(root, 'init', '-q');
    write(join(root, 'agent.mjs'), 'export {};\n');
    const tree = candidateTree(root, root);
    try {
      expect(readFileSync(join(tree.root, 'agent.mjs'), 'utf8')).toBe('export {};\n');
    } finally {
      tree.remove();
    }
    expect(existsSync(tree.root)).toBe(false);
  });
});
