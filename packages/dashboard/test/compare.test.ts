import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, storeApiRequest } from '@shadowlap/engine';
import { codeChangeCache, parseRevision, readCodeChange, type CompareView } from '../src/compare.js';
import { startDashboard, type Dashboard } from '../src/index.js';
import { compareTarget } from '../ui/runs.js';

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

  it('knows one commit named by abbreviations of two lengths, as git gives more digits as a repository grows', async () => {
    const full = execFileSync('git', ['rev-parse', rev.limit!], { cwd: repo }).toString().trim();
    const longer = full.slice(0, 10);
    expect(await readCodeChange(repo, rev.limit!, longer)).toEqual({ commits: 0, newer: null, subjects: [], uncommitted: false, same: true });
    expect(await readCodeChange(repo, longer, rev.limit!)).toEqual({ commits: 0, newer: null, subjects: [], uncommitted: false, same: true });
    // The same commit with uncommitted changes on one side still says so.
    expect(await readCodeChange(repo, rev.limit!, `${longer}+dirty`)).toEqual({ commits: 0, newer: null, subjects: [], uncommitted: true });
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
    // Two runs whose model call #2 saw the policy tool answer differently.
    const policy = (result: string) => ({
      model: 'claude-sonnet-5',
      messages: [
        { role: 'user', content: 'Refund order A-1042.' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup_policy', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: result }] },
      ],
    });
    for (const [name, result] of [['recorded', '{"approval":"tier2"}'], ['forked', '{"refund_limit":100,"approval":"tier2"}']] as const) {
      const r = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: repo } });
      const body = policy(result);
      const identity = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: result, occurrence: 1 };
      store.appendCallStart({ runId: r.runId, callNo: 1, ...identity, origin: 'live', effect: null, requestRef: storeApiRequest(store, body), meta: { provider: 'anthropic' }, at: 1 });
      store.endRun(r.runId, 'completed');
      ids[name] = r.runId;
    }
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

  it('marks the attempts among a run\'s children, so Compare on a recording opens its first fork or replay, never a probe', async () => {
    const recording = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: repo }, startedAt: 10_000 });
    store.endRun(recording.runId, 'completed');
    // Blame probed it before anyone forked it.
    const probe = store.createRun({ mode: 'replay', parentRunId: recording.runId, command: { argv: ['node', 'agent.mjs'], cwd: repo }, startedAt: 11_000, meta: { probe: { of: recording.runId, callNo: 1, passed: false }, repeat: { group: 'b1-1', attempt: 1, of: 2 } } });
    store.endRun(probe.runId, 'completed');
    const fork = store.createRun({ mode: 'replay', parentRunId: recording.runId, command: { argv: ['node', 'agent.mjs'], cwd: repo }, startedAt: 12_000 });
    store.endRun(fork.runId, 'completed');
    const res = await fetch(`${dash.url}/api/runs/${recording.runId}`, { headers: { 'x-shadowlap-token': dash.token } });
    const detail = (await res.json()) as { children: Array<{ runId: string; startedAt: number; attempt?: true }> };
    expect(detail.children.map((c) => [c.runId, c.attempt ?? false])).toEqual([
      [probe.runId, true],
      [fork.runId, false],
    ]);
    expect(compareTarget(recording, detail.children)).toEqual([recording.runId, fork.runId]);
  });

  it('says a prefix of several runs’ ids matches several runs, on the run endpoint and here, and a missing run is not there', async () => {
    let shared = 0;
    while (ids.before![shared] === ids.after![shared]) shared++;
    const prefix = ids.before!.slice(0, shared);
    const ask = (path: string) => fetch(`${dash.url}${path}`, { headers: { 'x-shadowlap-token': dash.token } });
    const several = await ask(`/api/runs/${prefix}`);
    expect(several.status).toBe(409);
    expect(await several.json()).toEqual({ error: `run id prefix ${prefix} matches several runs: use more of the id` });
    const compared = await ask(`/api/compare?a=${prefix}&b=${ids.after}`);
    expect(compared.status).toBe(409);
    expect(((await compared.json()) as { error: string }).error).toBe(`run id prefix ${prefix} matches several runs: use more of the id`);
    const none = await ask('/api/runs/01ZZZZZZZZ');
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({ error: 'no run 01ZZZZZZZZ' });
    expect((await ask(`/api/compare?a=01ZZZZZZZZ&b=${ids.after}`)).status).toBe(404);
  });

  it('names what differs in the first request that differs, as the design does, with its path kept', async () => {
    const c = await get(ids.recorded!, ids.forked!);
    expect(c.firstRequestDifference?.diff).toEqual([{ path: '$.messages[2].content[0].content', op: 'changed', before: '{"approval":"tier2"}', after: '{"refund_limit":100,"approval":"tier2"}', what: 'tool_result lookup_policy' }]);
  });
});
