import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { parseStoreUrl, pull, pullRequestLocation, push, recordCheck, StoreError } from '@shadowlap/remote';
import { countsOf, localRunSet, readTeamStoreInput, teamStoreStatus, type TeamStoreInput } from '../src/team-store.js';
import { MemoryStore } from '../../remote/test/fakes/memory.js';

/**
 * The team store as the dashboard reports it: the bucket from the config, the last sync, runs in
 * the store and only here (which ones, `localRunSet`), the last check, and whose credentials this
 * machine would use.
 */

/** The runs only here, as the Runs page's Local chip lists them: newest first. */
const localIds = (store: Store) => [...localRunSet(store, ID)];

const NOW = Date.parse('2027-01-15T10:00:00Z');
const URL_ = 's3://northwind-agent-runs/support-agent?region=eu-central-1';
const ID = 's3://northwind-agent-runs/support-agent';
const cmd = { argv: ['node', 'agent.js'], cwd: '/tmp' };
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function input(patch: Partial<TeamStoreInput> = {}): TeamStoreInput {
  return { store: URL_, ...patch };
}

function run(store: Store, meta: Record<string, unknown> = {}, ended = true): string {
  const r = store.createRun({ mode: 'record', command: cmd, meta });
  if (ended) store.endRun(r.runId, 'completed');
  return r.runId;
}

describe('the team store status', () => {
  it('is null without a store, or with one the config names wrong', () => {
    const store = Store.open(':memory:');
    expect(teamStoreStatus(store, input({ store: null }))).toBeNull();
    expect(teamStoreStatus(store, input({ store: 'S3:/typo' }))).toBeNull();
    store.close();
  });

  it('names the bucket, the region and the folder, and what this machine knows of the store, and nothing else', () => {
    const store = Store.open(':memory:');
    const status = teamStoreStatus(store, input())!;
    expect(status).toMatchObject({ url: ID, key: ID, configured: URL_, provider: 's3', providerName: 'Amazon S3', bucket: 'northwind-agent-runs', prefix: 'support-agent', region: 'eu-central-1', name: 'northwind-agent-runs/support-agent', syncedAt: null, check: null, ciPush: true, settingUp: false });
    // Set up from the setup page: setting up until it is finished.
    store.setTeamSync(ID, { data: { setup: { startedAt: NOW, ci: null, ciProvider: null, finishedAt: null } } });
    expect(teamStoreStatus(store, input())!.settingUp).toBe(true);
    store.setTeamSync(ID, { data: { setup: { startedAt: NOW, ci: 'added', ciProvider: 'github', finishedAt: NOW } } });
    expect(teamStoreStatus(store, input())!.settingUp).toBe(false);
    expect(Object.keys(status).sort()).toEqual(
      ['access', 'account', 'bucket', 'check', 'ciPush', 'configured', 'inStore', 'key', 'localAttempts', 'name', 'onlyLocal', 'prefix', 'provider', 'providerName', 'pulledAt', 'pushedAt', 'queued', 'region', 'settingUp', 'syncedAt', 'url'].sort(),
    );
    store.close();
  });

  it('follows pushes and pulls: runs in the store, only here, and the last sync', async () => {
    const store = Store.open(':memory:');
    const local = [run(store), run(store), run(store, {}, false)];
    expect(teamStoreStatus(store, input())).toMatchObject({ onlyLocal: 2, inStore: 0, queued: 0, pushedAt: null });
    const remote = new MemoryStore(parseStoreUrl(URL_));
    await push({ store, remote, actor: 'dana@northwind.example', now: () => NOW }, { all: true });
    expect(teamStoreStatus(store, input())).toMatchObject({ inStore: 2, onlyLocal: 0, queued: 1, pushedAt: NOW, syncedAt: NOW });
    expect(localIds(store)).toEqual([]);
    expect(local.slice(0, 2).every((id) => store.teamRun(ID, id)!.state === 'pushed')).toBe(true);
    // Settings → Store's switch is the config's.
    expect(teamStoreStatus(store, input({ ciPush: false }))!.ciPush).toBe(false);
    store.close();
  });

  it("says whose credentials this machine would use: the last check's, else those found here, else where they come from", () => {
    const store = Store.open(':memory:');
    expect(teamStoreStatus(store, input())!.access).toMatch(/^your AWS credentials: AWS_PROFILE/);
    const found = { uses: 'AWS profile northwind-shadowlap', from: 'from ~/.aws/config; AWS_PROFILE picks it' };
    expect(teamStoreStatus(store, input({ credentials: found }))!.access).toBe('AWS profile northwind-shadowlap, from ~/.aws/config; AWS_PROFILE picks it');
    recordCheck(store, ID, { ok: true, at: NOW, encryption: 'aws:kms', versioning: 'on', objectLock: 'off', credentials: 'AWS profile northwind' });
    const status = teamStoreStatus(store, input({ credentials: found }))!;
    expect(status.access).toBe('AWS profile northwind');
    expect(status.check).toEqual({ ok: true, at: NOW, encryption: 'aws:kms', versioning: 'on', objectLock: 'off', credentials: 'AWS profile northwind' });
    store.close();
  });

  it('counts a run as in the store once the index lists it: a push cut short before that leaves it local', async () => {
    const store = Store.open(':memory:');
    run(store);
    const remote = new MemoryStore(parseStoreUrl(URL_));
    remote.beforePut = (key) => {
      if (key.startsWith('index/')) throw new StoreError('network', 'Amazon S3: the connection was reset');
    };
    const ctx = { store, remote, actor: 'dana@northwind.example', now: () => NOW };
    await expect(push(ctx, { all: true })).rejects.toThrow(/connection was reset/);
    expect(teamStoreStatus(store, input())).toMatchObject({ inStore: 0, onlyLocal: 1, pushedAt: null });
    remote.beforePut = null;
    await push(ctx, { all: true });
    expect(teamStoreStatus(store, input())).toMatchObject({ inStore: 1, onlyLocal: 0, pushedAt: NOW });
    store.close();
  });

  it("leaves a pull request's runs out of the local ones", async () => {
    const store = Store.open(':memory:');
    for (const author of ['maya@northwind.example', 'ci']) run(store, { author });
    const remote = new MemoryStore(parseStoreUrl(URL_));
    await push({ store, remote, actor: 'jonas@northwind.example', ci: 'gitlab', now: () => NOW }, { all: true });

    // A pull request's job pushed a run to its own folder; pulled here, it isn't a local run to push.
    const ci = Store.open(':memory:');
    run(ci, { author: 'ci' });
    const folder = new MemoryStore(pullRequestLocation(parseStoreUrl(URL_), '42'));
    await push({ store: ci, remote: folder, actor: 'ci', pullRequest: '42', now: () => NOW }, { all: true });
    await pull({ store, remote: folder, actor: 'dana@northwind.example', pullRequest: '42', now: () => NOW });
    expect(teamStoreStatus(store, input())).toMatchObject({ inStore: 2, onlyLocal: 0 });
    expect(localIds(store)).toEqual([]);
    ci.close();
    store.close();
  });
});

describe('counted by run', () => {
  it('files attempts under their run, as the Runs page, Needs a look and store show count them', async () => {
    const store = Store.open(':memory:');
    const rec = run(store);
    for (const attempt of [1, 2, 3]) {
      const a = store.createRun({ mode: 'replay', parentRunId: rec, command: cmd, meta: { repeat: { group: 'g', attempt, of: 3 } } });
      store.endRun(a.runId, 'completed');
    }
    expect(teamStoreStatus(store, input())).toMatchObject({ onlyLocal: 1, localAttempts: 3, inStore: 0 });
    expect(localIds(store)).toEqual([rec]);
    const remote = new MemoryStore(parseStoreUrl(URL_));
    const ctx = { store, remote, actor: 'dana@northwind.example', now: () => NOW };
    // shadowlap push <run> sends the run alone: its attempts keep it local.
    await push(ctx, { runIds: [rec] });
    expect(teamStoreStatus(store, input())).toMatchObject({ onlyLocal: 1, localAttempts: 3, inStore: 1 });
    expect(localIds(store)).toEqual([rec]);
    await push(ctx, { all: true });
    expect(teamStoreStatus(store, input())).toMatchObject({ onlyLocal: 0, localAttempts: 0, inStore: 1 });
    expect(localIds(store)).toEqual([]);
    store.close();
  });

  it('keeps what it knows of a store under its identity: another endpoint is another store', async () => {
    const store = Store.open(':memory:');
    run(store);
    const minio = 's3://northwind-agent-runs/support-agent?endpoint=https://minio.internal:9000';
    await push({ store, remote: new MemoryStore(parseStoreUrl(minio)), actor: 'dana@northwind.example', now: () => NOW }, { all: true });
    expect(teamStoreStatus(store, input({ store: minio }))).toMatchObject({ url: ID, key: `${ID}?endpoint=https://minio.internal:9000`, inStore: 1, onlyLocal: 0, pushedAt: NOW });
    // The same bucket and folder on another server holds nothing this machine pushed.
    expect(teamStoreStatus(store, input({ store: 's3://northwind-agent-runs/support-agent?endpoint=https://ceph.internal' }))).toMatchObject({ inStore: 0, onlyLocal: 1, pushedAt: null });
    expect(teamStoreStatus(store, input())).toMatchObject({ inStore: 0, onlyLocal: 1, pushedAt: null });
    store.close();
  });
});

describe('a large store', () => {
  it('counts what is in the store and only here without reading every run', async () => {
    const store = Store.open(':memory:');
    const ids = Array.from({ length: 30 }, () => run(store));
    const remote = new MemoryStore(parseStoreUrl(URL_));
    await push({ store, remote, actor: 'dana@northwind.example', now: () => NOW }, { runIds: ids.slice(0, 10) });
    run(store, {}, false); // still recording: neither
    const status = teamStoreStatus(store, input())!;
    expect(status).toMatchObject({ inStore: 10, onlyLocal: 20, queued: 0 });
    // Newest first, as the Runs page lists them.
    const newest = store.allRuns().filter((r) => r.status !== 'running' && !ids.slice(0, 10).includes(r.runId)).sort((a, b) => b.startedAt - a.startedAt || (a.runId < b.runId ? 1 : -1));
    expect(localIds(store)).toEqual(newest.map((r) => r.runId));
    expect(store.teamLocalOnly(ID, 5).ids).toEqual(localIds(store).slice(0, 5));
    store.close();
  });

  it('counts again when runs or the store rows change, never for a call a recording appends', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-team-counts-'));
    dirs.push(dir);
    const path = join(dir, 'shadowlap.db');
    const store = Store.open(path);
    const ids = Array.from({ length: 4 }, () => run(store));
    const live = run(store, {}, false);
    const counts = countsOf(store, ID);
    expect(counts).toMatchObject({ onlyLocal: 4, inStore: 0 });
    // The recorder, a process of its own, appends calls: the same counts, not counted again.
    const recorder = Store.open(path);
    for (let n = 1; n <= 3; n++) recorder.appendCallStart({ runId: live, callNo: n, kind: 'api', name: 'messages', fingerprint: `f${n}`, occurrence: 1, origin: 'live', effect: null, requestRef: null, meta: {}, at: NOW + n });
    expect(countsOf(store, ID)).toBe(counts);
    // A run that ends, one added, a push: each counts again.
    recorder.endRun(live, 'completed');
    expect(countsOf(store, ID)).toMatchObject({ onlyLocal: 5 });
    run(recorder);
    expect(countsOf(store, ID)).toMatchObject({ onlyLocal: 6 });
    const remote = new MemoryStore(parseStoreUrl(URL_));
    await push({ store: recorder, remote, actor: 'dana@northwind.example', now: () => NOW }, { runIds: ids.slice(0, 2) });
    expect(countsOf(store, ID)).toMatchObject({ onlyLocal: 4, inStore: 2 });
    recorder.close();
    store.close();
  });
});

describe('readTeamStoreInput', () => {
  it("reads the config and the store's credentials found on this machine", () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sl-team-store-'));
    dirs.push(cwd);
    writeFileSync(join(cwd, 'shadowlap.config.json'), JSON.stringify({ store: URL_, ciPush: false }));
    const home = join(cwd, 'home');
    mkdirSync(join(home, '.aws'), { recursive: true });
    writeFileSync(join(home, '.aws', 'config'), '[profile northwind-shadowlap]\nregion = eu-central-1\n');
    const read = readTeamStoreInput({ cwd, env: { AWS_PROFILE: 'northwind-shadowlap' }, home });
    expect(read).toEqual({ store: URL_, ciPush: false, credentials: { uses: 'AWS profile northwind-shadowlap', from: 'from ~/.aws/config; AWS_PROFILE picks it' } });
    // No config, or a broken one: no store.
    const empty = mkdtempSync(join(tmpdir(), 'sl-team-store-'));
    dirs.push(empty);
    expect(readTeamStoreInput({ cwd: empty, env: {}, home })).toEqual({ store: null, ciPush: true, credentials: null });
    writeFileSync(join(empty, 'shadowlap.config.json'), '{ not json');
    expect(readTeamStoreInput({ cwd: empty, env: {}, home }).store).toBeNull();
  });
});
