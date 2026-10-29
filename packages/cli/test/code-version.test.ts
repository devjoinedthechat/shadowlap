import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeVersion, readCodeVersion } from '../src/config.js';

/**
 * The code a run ran, as each run keeps it: `<short sha>`, `+dirty` when a tracked file has changes,
 * null outside a git repository. An attempt reads it with readCodeVersion, which leaves the process
 * free meanwhile: the sidecar answering other attempts' agents runs in the same process.
 */
let base = '';
let repo = '';

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'sl-code-version-'));
  repo = join(base, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  writeFileSync(join(repo, 'agent.py'), 'print("hi")\n');
  git('add', 'agent.py');
  git('commit', '-q', '-m', 'agent');
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('the code version an attempt records', () => {
  it('says what codeVersion says: the commit, then +dirty for a change to a tracked file only', async () => {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    expect(await readCodeVersion(repo)).toBe(sha);
    expect(codeVersion(repo)).toBe(sha);
    writeFileSync(join(repo, 'notes.txt'), 'untracked\n');
    expect(await readCodeVersion(repo)).toBe(sha);
    writeFileSync(join(repo, 'agent.py'), 'print("bye")\n');
    expect(await readCodeVersion(repo)).toBe(`${sha}+dirty`);
    expect(codeVersion(repo)).toBe(`${sha}+dirty`);
  });

  it('is null outside a git repository', async () => {
    const plain = join(base, 'plain');
    mkdirSync(plain);
    // git looks no further up than the test's own folder, wherever the temporary folder is.
    const ceiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = base;
    try {
      expect(await readCodeVersion(plain)).toBeNull();
      expect(codeVersion(plain)).toBeNull();
    } finally {
      if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = ceiling;
    }
  });

  it('leaves the process free while git answers, where codeVersion holds it', async () => {
    /** The turns of the event loop while `read` runs. */
    const turnsDuring = async (read: () => unknown): Promise<number> => {
      let turns = 0;
      let reading = true;
      const turn = () => {
        if (!reading) return;
        turns++;
        setImmediate(turn);
      };
      setImmediate(turn);
      await read();
      reading = false;
      return turns;
    };
    expect(await turnsDuring(() => readCodeVersion(repo))).toBeGreaterThan(0);
    expect(await turnsDuring(() => codeVersion(repo))).toBe(0);
  });
});
