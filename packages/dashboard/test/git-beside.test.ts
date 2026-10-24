import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AFTER, BEFORE } from '../../engine/test/fix-fixtures.js';
import { commitsHere, commitSubjects, forgetCommits, parentlessHere } from '../src/commits-here.js';
import { forgetPatchAnswers, patchInTree } from '../src/patch-in-tree.js';
import { readableHosts } from '../src/pr-state.js';

/**
 * The dashboard asks git whether a fix's patch is in the tree, which commits a checkout has and
 * which host its origin is on, while it answers pages. git can take seconds (a cold disk, a large
 * repository): it runs beside the server's thread, which keeps answering meanwhile. Here git takes
 * 400 ms to answer each question, and a timer every 10 ms must keep firing while it does; one that
 * waited for git would fire once it had answered, not meanwhile.
 */

const SLOW_MS = 400;
const PATCH = `diff --git a/agent.mjs b/agent.mjs\n--- a/agent.mjs\n+++ b/agent.mjs\n@@ -1,1 +1,1 @@\n-${BEFORE}\n+${AFTER}\n`;

let bin: string;
let repo: string;
let path: string | undefined;
let start: string;

/** How many times a 10 ms timer fired while `work` ran, and what it gave. */
async function ticksDuring<T>(work: () => Promise<T>): Promise<{ out: T; ticks: number }> {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    const out = await work();
    return { out, ticks };
  } finally {
    clearInterval(timer);
  }
}

// The slow git is a shell script, which Windows won't run by name.
describe.skipIf(process.platform === 'win32')('git asked beside the server', () => {
  beforeAll(() => {
    const realGit = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'sl-git-beside-')));
    const git = (...args: string[]) => execFileSync(realGit, ['-c', 'user.email=dana@northwind.example', '-c', 'user.name=Dana', '-c', 'commit.gpgsign=false', ...args], { cwd: repo }).toString().trim();
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'agent.mjs'), `${BEFORE}\n`);
    git('add', 'agent.mjs');
    git('commit', '-qm', 'Start the agent');
    git('remote', 'add', 'origin', 'git@ghes.acme.example:acme/agent.git');
    start = git('rev-parse', 'HEAD');
    // git that thinks for a while, then answers as git does.
    bin = mkdtempSync(join(tmpdir(), 'sl-git-slow-'));
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nsleep ${SLOW_MS / 1000}\nexec "${realGit}" "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    path = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
  });

  afterAll(() => {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  beforeEach(() => {
    forgetPatchAnswers();
    forgetCommits();
  });

  it('asks whether a fix’s patch is in the tree', async () => {
    const { out, ticks } = await ticksDuring(() => patchInTree(repo, PATCH));
    expect(out).toBe(false);
    // Two questions (where the repository is, then the patch): 800 ms, eighty ticks; a few are enough.
    expect(ticks).toBeGreaterThanOrEqual(10);
    // Asked again with nothing changed: from what git said, at once.
    const again = await ticksDuring(() => patchInTree(repo, PATCH));
    expect(again.out).toBe(false);
    expect(again.ticks).toBeLessThan(10);
  });

  it('asks which commits this checkout has, and their subjects', async () => {
    const theirs = '1fb4209c0ffee00000000000000000000000beef';
    const { out, ticks } = await ticksDuring(async () => [await commitsHere(repo, [start, theirs]), await commitSubjects(repo, [start])] as const);
    expect(out).toEqual([new Set([start]), new Map([[start, 'Start the agent']])]);
    expect(ticks).toBeGreaterThanOrEqual(10);
  });

  it('asks whether a commit has a parent here', async () => {
    const { out, ticks } = await ticksDuring(() => parentlessHere(repo, start));
    expect(out).toEqual({ shallow: false });
    expect(ticks).toBeGreaterThanOrEqual(10);
  });

  it('asks which host the project’s origin is on', async () => {
    const { out, ticks } = await ticksDuring(() => readableHosts(repo, {}));
    expect([...out].sort()).toEqual(['ghes.acme.example', 'github.com']);
    expect(ticks).toBeGreaterThanOrEqual(10);
  });
});
