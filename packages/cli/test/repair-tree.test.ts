import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { projectFiles } from '../src/repair.js';
import { candidateTree, fileInside, readInside, writeInside } from '../src/repair-tree.js';

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

// Links stand in for files on Windows only with privileges a runner may not have.
describe.skipIf(process.platform === 'win32')('a prompt file that is a link', () => {
  /**
   * The reviewer's case: a repository whose prompts include links, tracked and not, to files outside
   * it and inside it, beside the folder they point out to.
   */
  function linked(): { base: string; repo: string; outside: string } {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'sl-repair-links-')));
    dirs.push(base);
    const outside = join(base, 'outside');
    write(join(outside, 'abs.md'), 'ORIGINAL abs\n');
    write(join(outside, 'rel.md'), 'ORIGINAL rel\n');
    write(join(outside, 'untracked.md'), 'ORIGINAL untracked\n');
    const repo = join(base, 'repo');
    write(join(repo, 'prompts', 'inside.md'), 'You are a support agent. Follow the refund policy.\n');
    symlinkSync(join(outside, 'abs.md'), join(repo, 'prompts', 'abs.md'));
    symlinkSync('../../outside/rel.md', join(repo, 'prompts', 'rel.md'));
    symlinkSync('inside.md', join(repo, 'prompts', 'alias.md'));
    sh(repo, 'init', '-q', '-b', 'main');
    sh(repo, 'add', '.');
    sh(repo, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'x');
    // An untracked link to an absolute path, as a local prompt kept outside the repository.
    symlinkSync(join(outside, 'untracked.md'), join(repo, 'prompts', 'local.md'));
    return { base, repo, outside };
  }

  it("is read as the file it names when that file is the repository's, and not at all when it is outside it", () => {
    const { repo } = linked();
    expect(['prompts/abs.md', 'prompts/rel.md', 'prompts/alias.md', 'prompts/local.md', 'prompts/inside.md', 'prompts/none.md'].map((f) => fileInside(repo, f))).toEqual([null, null, 'prompts/inside.md', null, 'prompts/inside.md', null]);
    // So the project's files hold the prompt once, under its own path, and nothing from outside.
    expect(projectFiles(repo).map((f) => f.path)).toEqual(['prompts/inside.md']);
  });

  it('is never written through, in a worktree or the working tree: nothing outside either changes', () => {
    const { repo, outside } = linked();
    const tree = candidateTree(repo, repo);
    const results: Record<string, string> = {};
    try {
      for (const f of ['prompts/abs.md', 'prompts/rel.md', 'prompts/alias.md', 'prompts/local.md']) {
        try {
          writeInside(tree.root, f, `CANDIDATE via ${f}\n`);
          results[f] = 'written';
        } catch (err) {
          results[f] = (err as Error).message;
        }
      }
      // The file the repository holds is written, in the worktree alone.
      writeInside(tree.root, 'prompts/inside.md', 'CANDIDATE\n');
      expect(readInside(tree.root, 'prompts/inside.md')).toBe('CANDIDATE\n');
    } finally {
      tree.remove();
    }
    expect(results).toEqual({
      'prompts/abs.md': 'prompts/abs.md is a link, which repair never writes through',
      'prompts/rel.md': 'prompts/rel.md is a link, which repair never writes through',
      'prompts/alias.md': 'prompts/alias.md is a link, which repair never writes through',
      'prompts/local.md': 'prompts/local.md is a link, which repair never writes through',
    });
    for (const f of ['abs', 'rel', 'untracked']) expect(readFileSync(join(outside, `${f}.md`), 'utf8')).toBe(`ORIGINAL ${f}\n`);
    expect(readFileSync(join(repo, 'prompts', 'inside.md'), 'utf8')).toBe('You are a support agent. Follow the refund policy.\n');
    expect(sh(repo, 'status', '--porcelain')).toBe('?? prompts/local.md\n');
    // Nor through a folder that is a link, nor out of the root by name.
    symlinkSync(outside, join(repo, 'linked-dir'));
    expect(() => writeInside(repo, 'linked-dir/abs.md', 'x')).toThrow('linked-dir is a link, which repair never writes through');
    expect(() => writeInside(repo, '../outside/abs.md', 'x')).toThrow('../outside/abs.md is not a path inside the repository');
    expect(() => writeInside(repo, 'prompts/missing.md', 'x')).toThrow(/ENOENT/);
    expect(readFileSync(join(outside, 'abs.md'), 'utf8')).toBe('ORIGINAL abs\n');
  });

  it("names the worktree's copy where the working tree's link names a path in the repository by its absolute name", () => {
    const root = repository();
    write(join(root, 'agent', 'policy.md'), 'Refunds above the limit go to a manager.\n');
    symlinkSync(join(root, 'agent', 'policy.md'), join(root, 'agent', 'current.md'));
    const tree = candidateTree(root, join(root, 'agent'), { copyLimit: 1_000_000 });
    try {
      expect(readlinkSync(join(tree.cwd, 'current.md'))).toBe(join(tree.root, 'agent', 'policy.md'));
    } finally {
      tree.remove();
    }
  });
});

describe.skipIf(process.platform === 'win32')('a prompt file whose folder another process swaps for a link while repair opens it', () => {
  // A process of the same user racing repair: between repair's walk of the path and its open, the
  // folder on the way becomes a link to a folder outside, which holds a file of the same name. The
  // swap happens through the race hooks, at the one point the walk can't see, so the test is exact.
  function setup() {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'sl-repair-race-')));
    dirs.push(base);
    const root = join(base, 'repo');
    write(join(root, 'prompts', 'policy.md'), 'Follow the refund policy, which is long enough to be cut short.\n');
    write(join(base, 'outside', 'policy.md'), 'a file outside the repository\n');
    const swap = () => {
      renameSync(join(root, 'prompts'), join(root, 'prompts-real'));
      symlinkSync(join(base, 'outside'), join(root, 'prompts'));
    };
    const back = () => {
      rmSync(join(root, 'prompts'));
      renameSync(join(root, 'prompts-real'), join(root, 'prompts'));
    };
    const outside = () => readFileSync(join(base, 'outside', 'policy.md'), 'utf8');
    const inside = () => readFileSync(join(root, existsSync(join(root, 'prompts-real')) ? 'prompts-real' : 'prompts', 'policy.md'), 'utf8');
    return { root, swap, back, outside, inside };
  }

  it('writes nothing, and empties nothing, outside: the link the open went through is found on the walk after it', () => {
    const t = setup();
    expect(() => writeInside(t.root, 'prompts/policy.md', 'rewritten\n', { walked: t.swap })).toThrow(/prompts is a link/);
    expect(t.outside()).toBe('a file outside the repository\n');
    expect(t.inside()).toBe('Follow the refund policy, which is long enough to be cut short.\n');
  });

  it('writes nothing outside when the folder is put back before the check: what was opened is not the file the path names', () => {
    const t = setup();
    expect(() => writeInside(t.root, 'prompts/policy.md', 'rewritten\n', { walked: t.swap, opened: t.back })).toThrow(/changed while repair opened it/);
    expect(t.outside()).toBe('a file outside the repository\n');
    expect(t.inside()).toBe('Follow the refund policy, which is long enough to be cut short.\n');
    // Read the same way, the file outside is never what repair reads.
    const r = setup();
    expect(() => readInside(r.root, 'prompts/policy.md', { walked: r.swap, opened: r.back })).toThrow(/changed while repair opened it/);
  });

  it('with no race, empties the file it checked and writes it whole, shorter than it was', () => {
    const t = setup();
    writeInside(t.root, 'prompts/policy.md', 'Escalate.\n');
    expect(t.inside()).toBe('Escalate.\n');
  });
});

describe("a candidate's worktree, its size and a build", () => {
  it("copies the working tree's untracked files within the limit, as what git ignores, and links what is past it, naming it", () => {
    const root = repository();
    write(join(root, 'agent', 'dump.bin'), 'x'.repeat(5000));
    const tree = candidateTree(root, join(root, 'agent'), { copyLimit: 1000 });
    try {
      // The small untracked note is copied; the dump past the limit is linked, and said.
      expect(lstatSync(join(tree.cwd, 'notes.txt')).isFile()).toBe(true);
      expect(lstatSync(join(tree.cwd, 'dump.bin')).isSymbolicLink()).toBe(true);
      expect(tree.linked).toEqual(expect.arrayContaining(['agent/dump.bin']));
    } finally {
      tree.remove();
    }
    expect(readFileSync(join(root, 'agent', 'dump.bin'), 'utf8')).toHaveLength(5000);
  });

  it("gives a build node_modules of its own, so what it writes there never reaches the working tree's, and no virtual environment to write into", () => {
    const root = repository();
    // A package of the repository itself, linked into node_modules as a workspace's is.
    write(join(root, 'packages', 'tools', 'index.js'), 'module.exports = "tools";\n');
    sh(root, 'add', 'packages');
    sh(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'tools');
    symlinkSync('../packages/tools', join(root, 'node_modules', 'tools'));
    const tree = candidateTree(root, join(root, 'agent'), { copyLimit: 1_000_000, build: true });
    try {
      // Copied, not linked: a build writing a cache or a generated client there writes the worktree's.
      expect(lstatSync(join(tree.root, 'node_modules', 'left-pad')).isSymbolicLink()).toBe(false);
      writeFileSync(join(tree.root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 2;\n');
      mkdirSync(join(tree.root, 'node_modules', '.cache'));
      // The workspace package is the worktree's own copy, as without a build.
      expect(realpathSync(join(tree.root, 'node_modules', 'tools'))).toBe(realpathSync(join(tree.root, 'packages', 'tools')));
      // The build makes its own environment: the working tree's isn't there to write into.
      expect(existsSync(join(tree.root, '.venv'))).toBe(false);
    } finally {
      tree.remove();
    }
    expect(readFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe('module.exports = 1;\n');
    expect(existsSync(join(root, 'node_modules', '.cache'))).toBe(false);
    // Without a build, they are linked as before.
    const plain = candidateTree(root, join(root, 'agent'), { copyLimit: 1_000_000 });
    try {
      expect(realpathSync(join(plain.root, 'node_modules', 'left-pad'))).toBe(join(root, 'node_modules', 'left-pad'));
      expect(readlinkSync(join(plain.root, '.venv'))).toBe(join(root, '.venv'));
    } finally {
      plain.remove();
    }
  });
});
