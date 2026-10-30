import { execFileSync, spawn } from 'node:child_process';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { releaseLock } from '@shadowlap/engine';
import { startRepair } from '../src/repair.js';
import { recoverWorkingTree } from '../src/repair-journal.js';

/**
 * Where a repair starts: the folder's repair lock, the worktrees a repair that died left, and the
 * journal of an older Shadowlap, which tried candidates in the working tree, that such a repair left.
 * A git repository of its own, in a folder of the temporary folder with room beside it for a file
 * outside the repository.
 */
let base: string;
let project: string;

const sh = (cwd: string, cmd: string, args: string[]) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

/** Whether a test may make a symbolic link: Windows makes one only with a privilege a runner may not have, so the cases that need one run elsewhere, as the other link tests do. */
const LINKS = process.platform !== 'win32';

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'sl-repair-start-')));
  project = join(base, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'agent.mjs'), "export const system = 'You are a support agent. Follow the refund policy.';\n");
  writeFileSync(join(project, '.gitignore'), '.shadowlap/\n');
  sh(project, 'git', ['init', '-q', '-b', 'main']);
  sh(project, 'git', ['config', 'user.name', 'Test']);
  sh(project, 'git', ['config', 'user.email', 'test@example.com']);
  sh(project, 'git', ['add', '.']);
  sh(project, 'git', ['commit', '-q', '-m', 'agent']);
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/**
 * A journal as an older Shadowlap, which tried candidates in the working tree, wrote it: its
 * process, and the file it edited, named by the repository's root as git gives it joined to the
 * file's path, with the file's text before and after the candidate, in base64. In `at`, the
 * project's .shadowlap folder unless said otherwise. Returns its path.
 */
function journal(files: Array<{ path: string; original: string; patched: string }>, at = join(project, '.shadowlap')): string {
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  mkdirSync(at, { recursive: true });
  const path = join(at, 'repair-journal.json');
  writeFileSync(path, JSON.stringify({ pid: 2 ** 22 - 1, files: files.map((f) => ({ path: f.path, original: b64(f.original), patched: b64(f.patched) })) }));
  return path;
}

/** The repository's root as git names it, as an older Shadowlap joined a file's path to it. */
const gitTop = () => sh(project, 'git', ['rev-parse', '--show-toplevel']).trim();

/** Starts a repair in the project and ends it, as one that stops at once would. */
function startAndEnd(): ReturnType<typeof startRepair> {
  const started = startRepair(project);
  releaseLock(started.lock);
  return started;
}

describe('a journal planted in the repository', () => {
  it('writes nothing outside the repository: by a path out of it, absolute or relative, or through a link or a hard link out of it', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'sl-journal-outside-')));
    try {
      // Files outside the repository whose text a planted journal can guess: empty ones, and ones it knows.
      const empty = join(outside, 'empty.txt');
      const known = join(outside, 'known.txt');
      const linked = join(outside, 'linked.txt');
      const hard = join(outside, 'hard.txt');
      const beside = join(project, '..', 'beside.txt');
      for (const f of [empty, beside]) writeFileSync(f, '');
      for (const f of [known, linked, hard]) writeFileSync(f, 'KNOWN\n');
      // In the repository, a link out of it, and a hard link: the same file as one outside.
      mkdirSync(join(project, 'docs'));
      if (LINKS) symlinkSync(linked, join(project, 'docs', 'escape.txt'));
      linkSync(hard, join(project, 'docs', 'hard.txt'));
      const root = gitTop();
      // From the process's folder; a temporary folder on another drive, as on a Windows runner, has only its absolute path.
      const rel = relative(process.cwd(), empty);
      const planted = [
        { path: rel, patched: '' },
        { path: known, patched: 'KNOWN\n' },
        { path: join(root, '..', 'beside.txt'), patched: '' },
        ...(LINKS ? [{ path: join(root, 'docs', 'escape.txt'), patched: 'KNOWN\n' }] : []),
        { path: join(root, 'docs', 'hard.txt'), patched: 'KNOWN\n' },
      ];
      // One at a time, as an older Shadowlap journaled one file, then all at once.
      const ignored: Array<string | null> = [];
      for (const files of [...planted.map((p) => [p]), planted]) {
        journal(files.map((p) => ({ path: p.path, original: 'PLANTED\n', patched: p.patched })));
        const started = startAndEnd();
        expect(started.restored).toEqual([]);
        ignored.push(started.ignored);
      }
      // A path out of the repository is no repair's of it: none of the journal is taken. The hard link
      // is the repository's by its path, and is left as it is: it is a file outside too.
      const outOf = 'it names a file outside the repository, which no repair of it edited';
      const byRel = isAbsolute(rel) ? outOf : 'it names a file by a relative path, which no Shadowlap writes';
      expect(ignored).toEqual([byRel, outOf, outOf, ...(LINKS ? [outOf] : []), null, byRel]);
      for (const f of [empty, beside]) expect(readFileSync(f, 'utf8'), f).toBe('');
      for (const f of [known, linked, hard]) expect(readFileSync(f, 'utf8'), f).toBe('KNOWN\n');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('is ignored when git tracks it: it came with the repository, not from a repair that died here', () => {
    mkdirSync(join(project, 'prompts'));
    writeFileSync(join(project, 'prompts', 'policy.md'), 'Escalate refunds above the limit.\n');
    const planted = journal([{ path: join(gitTop(), 'prompts', 'policy.md'), original: 'Refund everything.\n', patched: 'Escalate refunds above the limit.\n' }]);
    // Committed past the .gitignore that keeps .shadowlap out, as a repository can ship it.
    sh(project, 'git', ['add', '-f', 'prompts/policy.md', '.shadowlap/repair-journal.json']);
    sh(project, 'git', ['commit', '-qm', 'a journal, committed']);
    expect(startAndEnd()).toMatchObject({ restored: [], ignored: 'git tracks it, so it came with the repository' });
    expect(readFileSync(join(project, 'prompts', 'policy.md'), 'utf8')).toBe('Escalate refunds above the limit.\n');
    // Left where it is: a tracked file is the repository's, not Shadowlap's to delete.
    expect(existsSync(planted)).toBe(true);
    expect(sh(project, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('is ignored when git tracks it under another case of its name, which macOS and Windows read as the same file', () => {
    mkdirSync(join(project, '.SHADOWLAP'));
    // Only where the file system reads both cases as one name: elsewhere they are two folders.
    if (!existsSync(join(project, '.shadowlap'))) return;
    writeFileSync(join(project, 'prompt.md'), 'Escalate refunds above the limit.\n');
    const planted = journal([{ path: join(gitTop(), 'prompt.md'), original: 'Refund everything.\n', patched: 'Escalate refunds above the limit.\n' }], join(project, '.SHADOWLAP'));
    sh(project, 'git', ['add', '-f', 'prompt.md', '.SHADOWLAP/repair-journal.json']);
    sh(project, 'git', ['commit', '-qm', 'a journal, committed under another case']);
    expect(startAndEnd()).toMatchObject({ restored: [], ignored: 'git tracks it, so it came with the repository' });
    expect(readFileSync(join(project, 'prompt.md'), 'utf8')).toBe('Escalate refunds above the limit.\n');
    expect(existsSync(planted)).toBe(true);
  });

  it.skipIf(!LINKS)("is ignored when it is reached through a link: .shadowlap a link to a folder that holds one", () => {
    writeFileSync(join(project, 'prompt.md'), 'Escalate refunds above the limit.\n');
    const planted = journal([{ path: join(gitTop(), 'prompt.md'), original: 'Refund everything.\n', patched: 'Escalate refunds above the limit.\n' }], join(project, 'state'));
    symlinkSync('state', join(project, '.shadowlap'));
    expect(startAndEnd()).toMatchObject({ restored: [], ignored: expect.stringMatching(/^it can't be read as a file of the repository's own \(\.shadowlap is a link/) });
    expect(readFileSync(join(project, 'prompt.md'), 'utf8')).toBe('Escalate refunds above the limit.\n');
    expect(existsSync(planted)).toBe(true);
  });
});

describe('recoverWorkingTree', () => {
  it('puts back the edit an interrupted repair left, as an older Shadowlap journaled it, and leaves a file someone changed since alone', () => {
    mkdirSync(join(project, 'prompts'));
    writeFileSync(join(project, 'prompts', 'policy.md'), 'candidate');
    writeFileSync(join(project, 'prompts', 'notes.md'), 'edited by hand');
    const root = gitTop();
    const path = journal([
      { path: join(root, 'prompts', 'policy.md'), original: 'original', patched: 'candidate' },
      { path: join(root, 'prompts', 'notes.md'), original: 'original notes', patched: 'patched notes' },
    ]);
    expect(recoverWorkingTree(project)).toEqual({ restored: [join(root, 'prompts', 'policy.md')], ignored: null });
    expect(readFileSync(join(project, 'prompts', 'policy.md'), 'utf8')).toBe('original');
    expect(readFileSync(join(project, 'prompts', 'notes.md'), 'utf8')).toBe('edited by hand');
    expect(existsSync(path)).toBe(false);
    expect(recoverWorkingTree(project)).toEqual({ restored: [], ignored: null });
    // In a folder of the repository's, from its own .shadowlap.
    writeFileSync(join(project, 'prompts', 'notes.md'), 'patched notes');
    journal([{ path: join(root, 'prompts', 'notes.md'), original: 'original notes', patched: 'patched notes' }], join(project, 'prompts', '.shadowlap'));
    expect(recoverWorkingTree(join(project, 'prompts'), root)).toEqual({ restored: [join(root, 'prompts', 'notes.md')], ignored: null });
    expect(readFileSync(join(project, 'prompts', 'notes.md'), 'utf8')).toBe('original notes');
  });

  it.skipIf(!LINKS)('puts back an edit through a link in the repository into the file it names, the link left a link', () => {
    mkdirSync(join(project, 'prompts'));
    writeFileSync(join(project, 'prompts', 'notes.md'), 'patched notes');
    symlinkSync('notes.md', join(project, 'prompts', 'current.md'));
    const root = gitTop();
    journal([{ path: join(root, 'prompts', 'current.md'), original: 'original notes', patched: 'patched notes' }]);
    expect(recoverWorkingTree(project)).toEqual({ restored: [join(root, 'prompts', 'notes.md')], ignored: null });
    expect(readFileSync(join(project, 'prompts', 'notes.md'), 'utf8')).toBe('original notes');
    expect(lstatSync(join(project, 'prompts', 'current.md')).isSymbolicLink()).toBe(true);
  });
});

describe('startRepair', () => {
  it('stops while another repair runs in the folder, leaving its candidate in place, and puts it back once that repair died', async () => {
    const dir = project;
    // A repair runs in the folder: it started there, and holds it until it ends.
    const running = spawn(process.execPath, ['--input-type=module', '-e', `
      const { startRepair } = await import(${JSON.stringify(new URL('../dist/repair.js', import.meta.url).href)});
      startRepair(${JSON.stringify(dir)});
      setInterval(() => {}, 1000);
      process.stdout.write('up\\n');`], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise<void>((resolve, reject) => {
        let err = '';
        running.stdout.on('data', (d: Buffer) => d.toString().includes('up') && resolve());
        running.stderr.on('data', (d: Buffer) => (err += d.toString()));
        running.on('exit', (c) => reject(new Error(`exited with ${c}: ${err}`)));
      });
      // It is verifying a candidate: the file is edited, and the journal holds the original.
      const agent = join(dir, 'agent.txt');
      const journal = join(dir, '.shadowlap', 'repair-journal.json');
      const b64 = (s: string) => Buffer.from(s).toString('base64');
      writeFileSync(agent, 'candidate');
      writeFileSync(journal, JSON.stringify({ pid: running.pid, files: [{ path: agent, original: b64('original'), patched: b64('candidate') }] }));
      // A second repair started there stops before it touches anything.
      expect(() => startRepair(dir)).toThrow(/another shadowlap repair is running in this folder/);
      expect(readFileSync(agent, 'utf8')).toBe('candidate');
      expect(existsSync(journal)).toBe(true);
      // Killed with its candidate applied: the next repair takes the folder over at once and puts the file back.
      running.kill('SIGKILL');
      await new Promise((resolve) => (running.exitCode !== null || running.signalCode !== null ? resolve(null) : running.once('exit', resolve)));
      const { lock, restored } = startRepair(dir);
      expect(restored).toEqual([agent]);
      expect(readFileSync(agent, 'utf8')).toBe('original');
      releaseLock(lock);
      expect(readdirSync(join(dir, '.shadowlap'))).toEqual([]);
    } finally {
      running.kill('SIGKILL');
    }
  });

  it('removes the worktree a repair that died left in the temporary folder, and what git keeps of it', () => {
    const base = mkdtempSync(join(tmpdir(), 'shadowlap-repair-'));
    sh(project, 'git', ['worktree', 'add', '--detach', join(base, 'tree'), 'HEAD']);
    const trees = () => sh(project, 'git', ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree '));
    expect(trees()).toHaveLength(2);
    const { lock } = startRepair(project);
    releaseLock(lock);
    expect(trees()).toHaveLength(1);
    expect(existsSync(base)).toBe(false);
  });

  it('never takes over by its age the lock of a repair it can’t check, one in a container or on another machine sharing the folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-repair-lock-'));
    try {
      mkdirSync(join(dir, '.shadowlap'));
      const path = join(dir, '.shadowlap', 'repair.lock');
      // Written an hour ago by a repair on another boot of a Linux kernel: its process can't be asked about from here.
      const text = JSON.stringify({ v: 2, pid: 7, host: 'build-box', start: 'another-boot:1', born: Date.now() - 3_600_000, token: 'there' });
      writeFileSync(path, text);
      const hourAgo = (Date.now() - 3_600_000) / 1000;
      utimesSync(path, hourAgo, hourAgo);
      expect(() => startRepair(dir)).toThrow(/another shadowlap repair is running in this folder.*if none is running, delete/);
      expect(readFileSync(path, 'utf8')).toBe(text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
