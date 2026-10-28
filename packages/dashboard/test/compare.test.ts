import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareRuns, parseJsonExact, Store, storeApiRequest, storeView, type RunMeta, type RunRecord } from '@shadowlap/engine';
import { codeChangeCache, compareHead, HEAD_READS, parseRevision, readCodeChange, type CompareView } from '../src/compare.js';
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
  git('checkout', '-q', '-b', 'side', rev.start);
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
    expect(await readCodeChange(repo, rev.start, rev.limit)).toEqual({ commits: 1, newer: 'b', subjects: ['harness: pass refund_limit through'], uncommitted: false });
    expect(await readCodeChange(repo, rev.start, rev.policy)).toEqual({ commits: 2, newer: 'b', subjects: ['Shorten the policy summary', 'harness: pass refund_limit through'], uncommitted: false });
    // Compared the other way round, the newer run is a.
    expect(await readCodeChange(repo, rev.policy, rev.start)).toEqual({ commits: 2, newer: 'a', subjects: ['Shorten the policy summary', 'harness: pass refund_limit through'], uncommitted: false });
  });

  it('says only uncommitted changes differ on the same commit, and that branches went separate ways', async () => {
    expect(await readCodeChange(repo, rev.limit, `${rev.limit}+dirty`)).toEqual({ commits: 0, newer: null, subjects: [], uncommitted: true });
    expect(await readCodeChange(repo, rev.policy, rev.side)).toEqual({ commits: null, newer: null, subjects: [], uncommitted: false });
  });

  it('knows one commit named by abbreviations of two lengths, as git gives more digits as a repository grows', async () => {
    const full = execFileSync('git', ['rev-parse', rev.limit], { cwd: repo }).toString().trim();
    const longer = full.slice(0, 10);
    expect(await readCodeChange(repo, rev.limit, longer)).toEqual({ commits: 0, newer: null, subjects: [], uncommitted: false, same: true });
    expect(await readCodeChange(repo, longer, rev.limit)).toEqual({ commits: 0, newer: null, subjects: [], uncommitted: false, same: true });
    // The same commit with uncommitted changes on one side still says so.
    expect(await readCodeChange(repo, rev.limit, `${longer}+dirty`)).toEqual({ commits: 0, newer: null, subjects: [], uncommitted: true });
  });

  it('says nothing for the same revision, a commit this checkout lacks, a name that is no commit, or no folder', async () => {
    expect(await readCodeChange(repo, rev.limit, rev.limit)).toBeNull();
    expect(await readCodeChange(repo, rev.limit, '1fb4209c0ffee00000000000000000000000beef')).toBeNull();
    expect(await readCodeChange(repo, rev.limit, 'main')).toBeNull();
    expect(await readCodeChange(repo, null, rev.limit)).toBeNull();
    expect(await readCodeChange(null, rev.start, rev.limit)).toBeNull();
    // A folder that isn't a repository.
    const plain = realpathSync.native(mkdtempSync(join(tmpdir(), 'sl-compare-plain-')));
    try {
      expect(await readCodeChange(plain, rev.start, rev.limit)).toBeNull();
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
    ids.before = run(rev.start);
    ids.after = run(rev.policy);
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
    const c = await get(ids.before, ids.after);
    expect(c.changes.code).toEqual({ a: rev.start, b: rev.policy });
    expect(c.code).toEqual({ commits: 2, newer: 'b', subjects: ['Shorten the policy summary', 'harness: pass refund_limit through'], uncommitted: false });
    expect((await get(ids.after, ids.dirty)).code).toEqual({ commits: 0, newer: null, subjects: [], uncommitted: true });
    expect((await get(ids.after, ids.after)).code).toBeNull();
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
    while (ids.before[shared] === ids.after[shared]) shared++;
    const prefix = ids.before.slice(0, shared);
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
    const c = await get(ids.recorded, ids.forked);
    expect(c.firstRequestDifference?.diff).toEqual([{ path: '$.messages[2].content[0].content', op: 'changed', before: '{"approval":"tier2"}', after: '{"refund_limit":100,"approval":"tier2"}', what: 'tool_result lookup_policy' }]);
  });
});

describe('what Compare shows first', () => {
  /**
   * A run of model calls, each asking `ask[i]` (its request, and its fingerprint after `keeps`, as
   * another normalizer list would keep it) and answered `got[i]`; a call in `judge` is a judge
   * check's, and one in `served` was served from its parent's call at the same place.
   */
  function run(store: Store, o: { parent?: RunRecord; ask: string[]; got: string[]; judge?: number[]; keeps?: string; served?: number[] }): RunRecord {
    const r = store.createRun({ mode: o.parent ? 'replay' : 'record', ...(o.parent ? { parentRunId: o.parent.runId } : {}), command: { argv: ['node', 'agent.mjs'], cwd: '/work' }, startedAt: 1_760_000_000_000 });
    o.ask.forEach((ask, i) => {
      const callNo = i + 1;
      const judge = o.judge?.includes(callNo) ?? false;
      const served = o.served?.includes(callNo) ?? false;
      const identity = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: `${judge ? 'judge-' : ''}${o.keeps ?? ''}${ask}`, occurrence: 1 };
      const requestRef = storeApiRequest(store, { model: 'claude-sonnet-4-5', max_tokens: 512, system: ask === 'x' ? 'Be brief.' : 'Be thorough.', messages: [{ role: 'user', content: `Question ${ask}` }] });
      store.appendCallStart({ runId: r.runId, callNo, ...identity, origin: served ? 'replayed' : 'live', effect: null, requestRef, meta: judge ? { scope: 'shadowlap:judge' } : {}, at: callNo });
      store.appendCallEnd(identity, { runId: r.runId, callNo, attempt: 0, responseRef: store.putJson({ said: o.got[i] }), outcome: 'ok', meta: served ? { replayedFrom: callNo, latencyMs: 0 } : { latencyMs: 10 }, at: callNo + 1 });
    });
    store.endRun(r.runId, 'completed', 99);
    return store.getRun(r.runId)!;
  }
  const whole = (store: Store, a: RunRecord, b: RunRecord) => compareRuns(store, a, store.getCalls(a.runId), b, store.getCalls(b.runId));
  const same = (store: Store, a: RunRecord, b: RunRecord) => {
    const h = compareHead(store, a.runId, b.runId)!;
    const c = whole(store, a, b);
    expect({ a: h.a, b: h.b, identicalPrefix: h.identicalPrefix, firstRequestDifference: h.firstRequestDifference, onlyInA: h.onlyInA, onlyInB: h.onlyInB }).toEqual({ a: c.a, b: c.b, identicalPrefix: c.identicalPrefix, firstRequestDifference: c.firstRequestDifference, onlyInA: c.onlyInA, onlyInB: c.onlyInB });
    expect(h.answersDiffer).toBe(c.responseDifferences.length);
    return h;
  };

  it('says the identical prefix and the first request that differs as the whole comparison does, reading two requests', () => {
    const store = Store.open(':memory:');
    const rec = run(store, { ask: ['a', 'b', 'c', 'd', 'e'], got: ['1', '2', '3', '4', '5'] });
    // A fork: the same until #4, whose request differs.
    const fork = run(store, { parent: rec, ask: ['a', 'b', 'c', 'x', 'y'], got: ['1', '2', '3', '6', '7'] });
    const h = same(store, rec, fork);
    expect(h).toMatchObject({ identicalPrefix: 3, firstRequestDifference: { callNo: 4 } });
    expect(h.firstRequestDifference!.diff!.length).toBeGreaterThan(0);
    // Another answer to the same request before it: the prefix ends there, and the answer is counted.
    const other = run(store, { parent: rec, ask: ['a', 'b', 'c', 'x'], got: ['1', '9', '3', '6'] });
    expect(same(store, rec, other)).toMatchObject({ identicalPrefix: 1, answersDiffer: 1, firstRequestDifference: { callNo: 4 } });
    // The same calls, one run going on further; a judge check's calls left out, as the whole comparison leaves them.
    const longer = run(store, { parent: rec, ask: ['a', 'j', 'b', 'c', 'd', 'e', 'f'], got: ['1', 'yes', '2', '3', '4', '5', '8'], judge: [2] });
    expect(same(store, rec, longer)).toMatchObject({ identicalPrefix: 5, firstRequestDifference: null, onlyInB: 1 });
    expect(same(store, rec, rec)).toMatchObject({ identicalPrefix: 5, firstRequestDifference: null, onlyInA: 0, onlyInB: 0 });
    // Of the requests, only the two at the first difference are read whole.
    const reads: string[] = [];
    const spy = storeView(store, { getCalls: (id: string, range?: { only?: readonly number[] }) => (reads.push(`${id === rec.runId ? 'a' : 'b'}:${range?.only?.join(',') ?? 'all'}`), store.getCalls(id, range)) });
    compareHead(spy, rec.runId, fork.runId);
    expect(reads).toEqual(['a:4', 'b:4']);
    store.close();
  });

  it('takes two calls whose fingerprints differ for the same request when the whole comparison does', () => {
    const store = Store.open(':memory:');
    const rec = run(store, { ask: ['a', 'b', 'c', 'd'], got: ['1', '2', '3', '4'] });
    // A replay made under another normalizer list: its calls keep other fingerprints, and the recorded call each was served from.
    const replay = run(store, { parent: rec, ask: ['a', 'b', 'c', 'x'], got: ['1', '2', '3', '6'], keeps: 'v2:', served: [1, 2, 3] });
    expect(same(store, rec, replay)).toMatchObject({ identicalPrefix: 3, firstRequestDifference: { callNo: 4 } });
    // Served calls are the same request without reading any: only the call that wasn't is read whole.
    const reads: string[] = [];
    const spy = storeView(store, { getCalls: (id: string, range?: { only?: readonly number[] }) => (reads.push(`${id === rec.runId ? 'a' : 'b'}:${range?.only?.join(',') ?? 'all'}`), store.getCalls(id, range)) });
    compareHead(spy, rec.runId, replay.runId);
    expect(reads).toEqual(['a:4', 'b:4']);
    // Two recordings of the same requests fingerprinted under other normalizers: read whole, they ask the same.
    const again = run(store, { ask: ['a', 'b', 'c', 'd'], got: ['1', '2', '3', '5'], keeps: 'v2:' });
    expect(same(store, rec, again)).toMatchObject({ identicalPrefix: 3, answersDiffer: 1, firstRequestDifference: null });
    // More such calls than the head reads whole: it leaves them to the whole comparison, rather than read every request.
    const asks = Array.from({ length: HEAD_READS + 1 }, (_, i) => `q${i}`);
    const long = run(store, { ask: asks, got: asks });
    const other = run(store, { ask: asks, got: asks, keeps: 'v2:' });
    expect(compareHead(store, long.runId, other.runId)).toBeNull();
    expect(whole(store, long, other)).toMatchObject({ identicalPrefix: HEAD_READS + 1, firstRequestDifference: null });
    store.close();
  });

  it('shows an id past 2^53 that changed, as the whole comparison does, and reads an older run rounded on both sides', () => {
    const store = Store.open(':memory:');
    const asked = (order: string) => `{"model":"claude-sonnet-4-5","max_tokens":512,"messages":[{"role":"user","content":"Refund it."}],"metadata":{"order":${order}}}`;
    /** A recording of one model call that sent `request`, under `fingerprint`. */
    const recorded = (request: unknown, fingerprint: string, meta?: RunMeta): RunRecord => {
      const r = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: '/work' }, startedAt: 1_760_000_000_000, ...(meta ? { meta } : {}) });
      const identity = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint, occurrence: 1 };
      store.appendCallStart({ runId: r.runId, callNo: 1, ...identity, origin: 'live', effect: null, requestRef: storeApiRequest(store, request), meta: {}, at: 1 });
      store.appendCallEnd(identity, { runId: r.runId, callNo: 1, attempt: 0, responseRef: store.putJson({ said: 'Refunded.' }), outcome: 'ok', meta: { latencyMs: 10 }, at: 2 });
      store.endRun(r.runId, 'completed', 99);
      return store.getRun(r.runId)!;
    };
    // Each kept as it was sent: two ids a double rounds alike.
    const a = recorded(parseJsonExact(asked('12345678901234567891')), 'f-1', { exactNumbers: true });
    const b = recorded(parseJsonExact(asked('12345678901234567892')), 'f-2', { exactNumbers: true });
    expect(same(store, a, b).firstRequestDifference).toMatchObject({ callNo: 1, diff: [{ path: '$.metadata.order', op: 'changed', before: '12345678901234567891', after: '12345678901234567892' }] });
    // A recording made before requests kept their numbers stored the id rounded: the same id sent.
    const older = recorded(JSON.parse(asked('12345678901234567891')), 'f-3');
    expect(same(store, older, a)).toMatchObject({ identicalPrefix: 1, firstRequestDifference: null });
    store.close();
  });
});
