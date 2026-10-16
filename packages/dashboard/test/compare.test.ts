import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { codeChangeCache, parseRevision, readCodeChange, type CompareView } from '../src/compare.js';
import { startDashboard, type Dashboard } from '../src/index.js';

/**
 * Compare's code card: the commits between two runs' revisions and the newest one's subject, read
 * from the project's own git, and nothing when the checkout doesn't have them.
 */

let repo: string;
const rev: Record<string, string> = {};

beforeAll(() => {
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'sl-compare-')));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=dana@northwind.example', '-c', 'user.name=Dana', '-c', 'commit.gpgsign=false', ...args], { cwd: repo }).toString().trim();
  git('init', '-q', '-b', 'main', '.');
  writeFileSync(join(repo, 'harness.mjs'), 'export const limit = null;\n');
  git('add', '-A');
  git('commit', '-qm', 'Start');
  rev.start = git('rev-parse', '--short=7', 'HEAD');
  writeFileSync(join(repo, 'harness.mjs'), 'export const limit = 100;\n');
  git('commit', '-qam', 'harness: pass refund_limit through');
  rev.limit = git('rev-parse', '--short=7', 'HEAD');
  writeFileSync(join(repo, 'policy.txt'), 'Refunds above the limit need approval.\n');
  git('add', '-A');
  git('commit', '-qm', 'Shorten the policy summary');
  rev.policy = git('rev-parse', '--short=7', 'HEAD');
  // A branch from the first commit that went its own way.
  git('checkout', '-q', '-b', 'side', rev.start!);
  writeFileSync(join(repo, 'side.txt'), 'elsewhere\n');
  git('add', '-A');
  git('commit', '-qm', 'Try another prompt');
  rev.side = git('rev-parse', '--short=7', 'HEAD');
  git('checkout', '-q', 'main');
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('the code between two revisions', () => {
  it('reads a run revision, dirty or not, and nothing that is not a commit name', () => {
    expect(parseRevision('a7b3c2e')).toEqual({ commit: 'a7b3c2e', dirty: false });
    expect(parseRevision('a7b3c2e+dirty')).toEqual({ commit: 'a7b3c2e', dirty: true });
    expect(parseRevision('--upload-pack=x')).toBeNull();
    expect(parseRevision('HEAD~1')).toBeNull();
    expect(parseRevision(null)).toBeNull();
  });

  it('counts the commits from the older revision to the newer, newest subject first', async () => {
    expect(await readCodeChange(repo, rev.start!, rev.limit!)).toEqual({ commits: 1, newer: 'b', subjects: ['harness: pass refund_limit through'], uncommitted: false });
    expect(await readCodeChange(repo, rev.start!, rev.policy!)).toEqual({ commits: 2, newer: 'b', subjects: ['Shorten the policy summary', 'harness: pass refund_limit through'], uncommitted: false });
    // Compared the other way round, the newer run is a.
    expect(await readCodeChange(repo, rev.policy!, rev.start!)).toEqual({ commits: 2, newer: 'a', subjects: ['Shorten the policy summary', 'harness: pass refund_limit through'], uncommitted: false });
  });

  it('says only uncommitted changes differ on the same commit, and that branches went separate ways', async () => {
    expect(await readCodeChange(repo, rev.limit!, `${rev.limit}+dirty`)).toEqual({ commits: 0, newer: null, subjects: [], uncommitted: true });
    expect(await readCodeChange(repo, rev.policy!, rev.side!)).toEqual({ commits: null, newer: null, subjects: [], uncommitted: false });
  });

  it('says nothing for the same revision, a commit this checkout lacks, a name that is no commit, or no folder', async () => {
    expect(await readCodeChange(repo, rev.limit!, rev.limit!)).toBeNull();
    expect(await readCodeChange(repo, rev.limit!, '1fb4209c0ffee00000000000000000000000beef')).toBeNull();
    expect(await readCodeChange(repo, rev.limit!, 'main')).toBeNull();
    expect(await readCodeChange(repo, null, rev.limit!)).toBeNull();
    expect(await readCodeChange(null, rev.start!, rev.limit!)).toBeNull();
    // A folder that isn't a repository.
    const plain = realpathSync.native(mkdtempSync(join(tmpdir(), 'sl-compare-plain-')));
    try {
      expect(await readCodeChange(plain, rev.start!, rev.limit!)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('asks git once a minute per pair of revisions', async () => {
    let asked = 0;
    const cached = codeChangeCache(async () => {
      asked++;
      return null;
    });
    await cached(repo, 'a1b2c3d', 'b2c3d4e');
    await cached(repo, 'a1b2c3d', 'b2c3d4e');
    expect(asked).toBe(1);
    await cached(repo, 'b2c3d4e', 'a1b2c3d');
    expect(asked).toBe(2);
  });
});

describe('GET /api/compare', () => {
  let store: Store;
  let dash: Dashboard;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    store = Store.open(':memory:');
    const run = (codeVersion: string) => {
      const r = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: repo }, codeVersion });
      store.endRun(r.runId, 'completed');
      return r.runId;
    };
    ids.before = run(rev.start!);
    ids.after = run(rev.policy!);
    ids.dirty = run(`${rev.policy}+dirty`);
    dash = await startDashboard({ store, readOnly: true, project: { path: repo } });
  });

  afterAll(async () => {
    await dash?.close();
    store?.close();
  });

  const get = async (a: string, b: string) => {
    const res = await fetch(`${dash.url}/api/compare?a=${a}&b=${b}`, { headers: { 'x-shadowlap-token': dash.token } });
    expect(res.status).toBe(200);
    return (await res.json()) as CompareView;
  };

  it('adds what git says about the code between the runs, read from the project folder', async () => {
    const c = await get(ids.before!, ids.after!);
    expect(c.changes.code).toEqual({ a: rev.start, b: rev.policy });
    expect(c.code).toEqual({ commits: 2, newer: 'b', subjects: ['Shorten the policy summary', 'harness: pass refund_limit through'], uncommitted: false });
    expect((await get(ids.after!, ids.dirty!)).code).toEqual({ commits: 0, newer: null, subjects: [], uncommitted: true });
    expect((await get(ids.after!, ids.after!)).code).toBeNull();
  });
});
