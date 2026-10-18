import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { classifyRun, commandIsImported, importedCommandSource, pulledRun, sha256, storeApiRequest, Store, summarizeRun, type BlameRecord, type RunRecord } from '@shadowlap/engine';
import { INDEX_FORMAT, keys, LAYOUT_VERSION, metaHash, parseSegment, parseStoreUrl, pull, pullRequestLocation, push, queuedRuns, reconcile, runBlobs, SCHEMES, StoreError, syncedMeta, teamRunInStore, type IndexEntry, type ObjectStore, type SyncContext } from '@shadowlap/remote';
import { MemoryStore } from './fakes/memory.js';

/**
 * Push and pull between two machines' stores through one bucket: content-addressed blobs, runs
 * with their lineage, metadata merged three ways, a run queued while it records, and a bucket that
 * is someone else's data, checked as strictly as a pack.
 */

const cmd = { argv: ['node', 'agent.js'], cwd: '/tmp' };
const loc = parseStoreUrl('s3://agent-runs/team');
const id = (fp: string) => ({ kind: 'api' as const, name: 'POST /v1/messages', fingerprint: fp.repeat(64).slice(0, 64), occurrence: 1 });

/** A recorded run with one model call whose request shares its system prompt with every other run. */
function record(store: Store, text: string, opts: { parent?: string; author?: string; running?: boolean; argv?: string[] } = {}): RunRecord {
  const run = store.createRun({ mode: opts.parent ? 'replay' : 'record', command: opts.argv ? { ...cmd, argv: opts.argv } : cmd, ...(opts.parent ? { parentRunId: opts.parent } : {}), ...(opts.author ? { meta: { author: opts.author } } : {}) });
  const req = storeApiRequest(store, { model: 'm', system: 'You are a support agent with a long shared system prompt.', messages: [{ role: 'user', content: text }] });
  const res = store.putBlob(Buffer.from(`event: message_start\ndata: {"text":${JSON.stringify(text)}}\n\n`));
  const call = id(text.charCodeAt(0).toString(16));
  store.appendCallStart({ runId: run.runId, callNo: 1, ...call, origin: 'live', effect: null, requestRef: req, meta: { provider: 'anthropic' }, at: 1 });
  store.appendCallEnd(call, { runId: run.runId, callNo: 1, attempt: 0, responseRef: res, outcome: 'ok', meta: { status: 200 }, at: 2 });
  if (!opts.running) store.endRun(run.runId, 'completed');
  return store.getRun(run.runId)!;
}

function machine(remote: MemoryStore, actor: string, store = Store.open(':memory:')): SyncContext & { store: Store } {
  return { store, remote, actor, now: () => Date.now() };
}

/** The run documents in the bucket, as JSON, for a test to read or change behind push's back. */
function readDoc(remote: MemoryStore, runId: string): { run: RunRecord } & Record<string, unknown> {
  return JSON.parse(remote.objects.get(keys.run(runId))!.body.toString()) as { run: RunRecord } & Record<string, unknown>;
}

function writeDoc(remote: MemoryStore, runId: string, doc: unknown): void {
  remote.objects.set(keys.run(runId), { body: Buffer.from(JSON.stringify(doc)), version: `edited-${Math.random()}`, contentType: 'application/json' });
}

/** An index segment as anyone with write access to the bucket could add one. */
function writeSegment(remote: MemoryStore, id: string, runs: unknown[], extra: Record<string, unknown> = {}): void {
  remote.objects.set(keys.segment(id), { body: Buffer.from(JSON.stringify({ format: INDEX_FORMAT, version: LAYOUT_VERSION, at: 1, by: 'mallory@evil.example', runs, ...extra })), version: 'x', contentType: 'application/json' });
}

/** The run ids an index segment in the bucket lists. */
function listed(remote: MemoryStore): string[] {
  return remote
    .keysUnder('index/')
    .flatMap((k) => parseSegment(remote.objects.get(k)!.body, k).runs.map((e) => e.runId))
    .sort();
}

describe('push', () => {
  it('uploads each blob once, a run as its record and calls, and an index segment', async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const r1 = record(a.store, 'refund order 1');
    const r2 = record(a.store, 'refund order 2');
    const first = await push(a, { all: true });
    expect(first.pushed.sort()).toEqual([r1.runId, r2.runId].sort());
    expect(first.segment).toMatch(/^index\/[0-9A-Z]{26}\.json$/);
    // The shared system prompt went up once: 2 runs × (manifest, message, response) + 1 shared = 7 blobs.
    expect(first.blobs.uploaded).toBe(remote.keysUnder('blobs/').length);
    const blobPuts = remote.log.filter((l) => l.op === 'put' && l.key.startsWith('blobs/')).map((l) => l.key);
    expect(new Set(blobPuts).size).toBe(blobPuts.length);
    expect(remote.keysUnder('runs/')).toEqual([`runs/${r1.runId}/calls.jsonl.gz`, `runs/${r1.runId}/run.json`, `runs/${r2.runId}/calls.jsonl.gz`, `runs/${r2.runId}/run.json`].sort());
    // Blobs are stored gzipped under the hash of what they hold.
    for (const key of remote.keysUnder('blobs/')) expect(sha256(gunzipSync(remote.objects.get(key)!.body))).toBe(key.slice(6));

    // Nothing changed: a second push sends nothing and writes no segment.
    remote.log.length = 0;
    const again = await push(a, { all: true });
    expect(again.pushed).toEqual([]);
    expect(again.unchanged.sort()).toEqual([r1.runId, r2.runId].sort());
    expect(again.segment).toBeNull();
    expect(remote.log.filter((l) => l.op === 'put')).toEqual([]);
  });

  it('names the CI provider with ci as the author, in the run and the index', async () => {
    const remote = new MemoryStore(loc);
    const ci = { ...machine(remote, 'ci'), ci: 'github' };
    const r = record(ci.store, 'from CI');
    const stamped = record(ci.store, 'stamped when it ran', { author: 'ci' });
    await push(ci, { all: true });
    expect(ci.store.getRun(r.runId)!.meta).toMatchObject({ author: 'ci', ci: 'github' });
    expect(ci.store.getRun(stamped.runId)!.meta).toMatchObject({ author: 'ci', ci: 'github' });
    const entries = remote.keysUnder('index/').flatMap((k) => parseSegment(remote.objects.get(k)!.body, k).runs);
    expect(entries.map((e) => [e.author, e.ci])).toEqual([
      ['ci', 'github'],
      ['ci', 'github'],
    ]);
    // A person's run says nothing about CI, and a provider that isn't a name doesn't come down.
    const dana = machine(remote, 'dana@northwind.example');
    const mine = record(dana.store, 'mine');
    await push({ ...dana, ci: null }, { runIds: [mine.runId] });
    expect(dana.store.getRun(mine.runId)!.meta?.ci).toBeUndefined();
    const segment = Buffer.from(JSON.stringify({ format: INDEX_FORMAT, version: LAYOUT_VERSION, at: 1, by: 'ci', runs: [{ runId: r.runId, parentRunId: null, startedAt: 1, metaHash: 'a'.repeat(64), author: 'ci', ci: 'GitHub Actions\u001b[2J' }] }));
    expect(parseSegment(segment, 'index/x.json').runs[0]!.ci).toBeNull();
  });

  it("gives a run made here the pusher's name, and leaves one that came from elsewhere alone", async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const mine = record(a.store, 'mine');
    const theirs = record(a.store, 'theirs');
    a.store.updateRunMeta(theirs.runId, { imported: { at: 1, from: 'golden-pack' } });
    await push(a, { all: true });
    expect(a.store.getRun(mine.runId)!.meta?.author).toBe('dana@northwind.example');
    expect(a.store.getRun(theirs.runId)!.meta?.author).toBeUndefined();
    // The import marker is this machine's own: it never goes to the store.
    const doc = JSON.parse(remote.objects.get(keys.run(theirs.runId))!.body.toString()) as { run: RunRecord };
    expect(doc.run.meta?.imported).toBeUndefined();
  });

  it('takes a fork with its ancestors, so its lineage holds in the store', async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const parent = record(a.store, 'parent');
    const fork = record(a.store, 'fork', { parent: parent.runId });
    const result = await push(a, { runIds: [fork.runId] });
    expect(result.pushed).toEqual([parent.runId, fork.runId]);
  });

  it('queues a run still recording, and sends it on a push after it ends', async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'ci');
    const live = record(a.store, 'live', { running: true });
    const first = await push(a, { runIds: [live.runId] });
    expect(first.queued).toEqual([live.runId]);
    expect(first.pushed).toEqual([]);
    expect(queuedRuns(a.store, loc.url)).toEqual({ ready: [], recording: [live.runId] });
    expect(a.store.teamRun(loc.url, live.runId)!.state).toBe('queued');
    a.store.endRun(live.runId, 'completed');
    expect(queuedRuns(a.store, loc.url)).toEqual({ ready: [live.runId], recording: [] });
    // Any later push sends what was queued, whatever it names.
    const second = await push(a, { runIds: [] });
    expect(second.pushed).toEqual([live.runId]);
    expect(a.store.teamRun(loc.url, live.runId)!.state).toBe('pushed');
  });
});

describe('blobs this machine pushed before', () => {
  it('asks the bucket about each before a new run relies on it, and sends what it lost', async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    record(a.store, 'first');
    await push(a, { all: true });
    const shared = remote.keysUnder('blobs/');
    // Present: a run sharing them asks about each instead of sending it again.
    const second = record(a.store, 'second');
    remote.log.length = 0;
    const kept = await push(a, { runIds: [second.runId] });
    expect(kept.blobs.present).toBeGreaterThan(0);
    const blobPuts = remote.log.filter((l) => l.op === 'put' && l.key.startsWith('blobs/')).map((l) => l.key);
    expect(blobPuts.filter((k) => shared.includes(k))).toEqual([]);

    // Gone: someone empties the bucket. A new run that shares blobs with the old ones sends them
    // again, whatever this machine remembers having pushed.
    for (const key of [...remote.objects.keys()]) remote.objects.delete(key);
    const third = record(a.store, 'third');
    const result = await push(a, { runIds: [third.runId] });
    expect(result.pushed).toEqual([third.runId]);
    const b = machine(remote, 'maya@northwind.example');
    const pulled = await pull(b);
    expect(pulled.failed).toEqual([]);
    expect(pulled.pulled).toEqual([third.runId]);
    expect(b.store.getCalls(third.runId)).toEqual(a.store.getCalls(third.runId));
  });

  it('mends a run named again when the bucket lost part of it, and says so on a pull', async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const parent = record(a.store, 'parent');
    const fork = record(a.store, 'fork', { parent: parent.runId });
    await push(a, { all: true });
    // A rule removed one of the parent's own blobs, and the fork's calls.
    const own = a.store.getCalls(parent.runId)[0]!.end!.responseRef!;
    remote.objects.delete(keys.blob(own));
    remote.objects.delete(keys.calls(fork.runId));
    const b = machine(remote, 'maya@northwind.example');
    const broken = await pull(b);
    expect(broken.failed).toEqual([
      { runId: parent.runId, reason: `blob ${own} is listed by the run but isn't in the store; whoever has the run can send it again with shadowlap push ${parent.runId}` },
      { runId: fork.runId, reason: `its parent ${parent.runId} couldn't be pulled` },
    ]);
    // Named, the fork is mended; its parent, pushed along as an ancestor, isn't looked into.
    const forkOnly = await push(a, { runIds: [fork.runId] });
    expect(forkOnly.repaired).toEqual([fork.runId]);
    expect(remote.objects.has(keys.calls(fork.runId))).toBe(true);
    expect(remote.objects.has(keys.blob(own))).toBe(false);
    // Named itself, the parent is too, and the next pull brings both.
    const mended = await push(a, { runIds: [parent.runId] });
    expect(mended.repaired).toEqual([parent.runId]);
    expect(mended.blobs.uploaded).toBe(1);
    const fixed = await pull(b);
    expect(fixed.failed).toEqual([]);
    expect(fixed.pulled).toEqual([parent.runId, fork.runId]);
    // Nothing lost: naming a run asks about its parts and sends nothing.
    remote.log.length = 0;
    expect((await push(a, { runIds: [parent.runId] })).repaired).toEqual([]);
    expect(remote.log.filter((l) => l.op === 'put')).toEqual([]);
  });

  it("leaves a run here when this machine's copy lacks a blob, and pushes the others", async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const good = record(a.store, 'good');
    const broken = a.store.createRun({ mode: 'record', command: cmd });
    const call = id('b');
    const gone = 'e'.repeat(64);
    a.store.appendCallStart({ runId: broken.runId, callNo: 1, ...call, origin: 'live', effect: null, requestRef: gone, meta: {}, at: 1 });
    a.store.endRun(broken.runId, 'completed');
    const result = await push(a, { all: true });
    expect(result.pushed).toEqual([good.runId]);
    expect(result.refused).toEqual([{ runId: broken.runId, reason: `this machine's copy is missing blob ${gone}` }]);
    expect(remote.objects.has(keys.run(broken.runId))).toBe(false);
  });
});

describe('a run the store got cut short', () => {
  /** A second call on a run, as its recorder (an import) writes on after a push took it for one its process left. */
  function moreCalls(store: Store, runId: string, from: number, to: number): void {
    for (let callNo = from; callNo <= to; callNo++) {
      const req = storeApiRequest(store, { model: 'm', messages: [{ role: 'user', content: `call ${callNo}` }] });
      const call = id(callNo.toString(16));
      store.appendCallStart({ runId, callNo, ...call, origin: 'live', effect: null, requestRef: req, meta: { provider: 'anthropic' }, at: callNo * 10 });
      store.appendCallEnd(call, { runId, callNo, attempt: 0, responseRef: store.putBlob(Buffer.from(`answer ${callNo}`)), outcome: 'ok', meta: { status: 200 }, at: callNo * 10 + 1 });
    }
  }

  it('is sent whole again once it has ended here, by --all as by name, and a teammate pulls it whole', async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const r = record(a.store, 'imported', { running: true });
    moreCalls(a.store, r.runId, 2, 3);
    // An older push ended it as interrupted while it was still being written, and sent 3 calls.
    a.store.endRun(r.runId, 'crashed', 31);
    await push(a, { all: true });
    expect(readDoc(remote, r.runId)).toMatchObject({ calls: 3, run: { status: 'crashed' } });
    // The import went on and finished: 5 calls, completed.
    moreCalls(a.store, r.runId, 4, 5);
    a.store.endRun(r.runId, 'completed', 51);
    const pushed = await push(a, { all: true });
    expect(pushed.repaired).toEqual([r.runId]);
    expect(pushed.updated).toEqual([r.runId]);
    expect(readDoc(remote, r.runId)).toMatchObject({ calls: 5, run: { status: 'completed', endedAt: 51 } });
    expect(gunzipSync(remote.objects.get(keys.calls(r.runId))!.body).toString().trim().split('\n')).toHaveLength(5);
    const b = machine(remote, 'maya@northwind.example');
    await pull(b);
    expect(b.store.getRun(r.runId)).toMatchObject({ status: 'completed', endedAt: 51 });
    expect(b.store.getCalls(r.runId)).toHaveLength(5);
    // Nothing more to send.
    const again = await push(a, { all: true });
    expect([again.repaired, again.updated]).toEqual([[], []]);
    expect((await push(a, { runIds: [r.runId] })).repaired).toEqual([]);
  });

  it('is left as it is when this machine holds no more of it', async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const r = record(a.store, 'killed', { running: true });
    a.store.endRun(r.runId, 'crashed', 2);
    await push(a, { all: true });
    remote.log.length = 0;
    expect((await push(a, { all: true })).repaired).toEqual([]);
    expect(remote.log.filter((l) => l.op === 'put')).toEqual([]);
  });
});

describe('a run queued while it recorded', () => {
  it('goes with its lineage, even when nothing named the parent', async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const parent = record(a.store, 'parent');
    const fork = record(a.store, 'fork', { parent: parent.runId, running: true });
    // Queued by a push from another process (the dashboard, a second terminal).
    a.store.setTeamRun(loc.url, { runId: fork.runId, state: 'queued', at: 1, base: null, baseHash: null, remoteHash: null, entry: null });
    a.store.endRun(fork.runId, 'completed');
    const result = await push(a, {});
    expect(result.pushed).toEqual([parent.runId, fork.runId]);
    const b = machine(remote, 'maya@northwind.example');
    await pull(b);
    expect(b.store.getRun(fork.runId)!.parentRunId).toBe(parent.runId);
  });

  it("is said once when it can't go, then no longer waits", async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const live = record(a.store, 'live', { running: true, argv: ['node', '-e', '\u001b[2J'] });
    expect((await push(a, { runIds: [live.runId] })).queued).toEqual([live.runId]);
    a.store.endRun(live.runId, 'completed');
    expect((await push(a, {})).refused.map((r) => r.runId)).toEqual([live.runId]);
    expect(queuedRuns(a.store, loc.url)).toEqual({ ready: [], recording: [] });
    expect((await push(a, {})).refused).toEqual([]);
  });

  it('is forgotten once a store from before deleted it with its queued row left', async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const live = record(a.store, 'live', { running: true });
    expect((await push(a, { all: true })).queued).toEqual([live.runId]);
    // An older Shadowlap deleted the run and kept its row: nothing records it, nothing sends it.
    a.store.endRun(live.runId, 'completed');
    a.store.deleteRun(live.runId);
    a.store.setTeamRun(loc.url, { runId: live.runId, state: 'queued', at: 1, base: null, baseHash: null, remoteHash: null, entry: null });
    expect(a.store.teamSummary(loc.url)).toMatchObject({ queued: 0 });
    const result = await push(a, { all: true });
    expect(result.queued).toEqual([]);
    expect(a.store.teamRun(loc.url, live.runId)).toBeNull();
  });
});

describe('pull', () => {
  it("marks a teammate's run so it reads as their recording, with what it spent, from any kind of store", async () => {
    const urls: Record<keyof typeof SCHEMES, string> = { s3: 's3://agent-runs/team', gcs: 'gs://agent-runs/team', azure: 'az://northwind/agent-runs/team', r2: 'r2://0123abcd/agent-runs/team' };
    for (const [provider, url] of Object.entries(urls)) {
      expect(url.startsWith(SCHEMES[provider as keyof typeof SCHEMES]), provider).toBe(true);
      const remote = new MemoryStore(parseStoreUrl(url));
      const a = machine(remote, 'maya@northwind.example');
      const theirs = record(a.store, 'refund order 7', { author: 'maya@northwind.example' });
      await push(a, { all: true });
      const b = machine(remote, 'dana@northwind.example');
      await pull(b);
      const got = b.store.getRun(theirs.runId)!;
      expect(pulledRun(got), url).toBe(true);
      expect(classifyRun(got).kind, url).toBe('recording');
      // Its calls were spent where it was recorded, by Maya: the team's, not a pack's captured traffic.
      const s = summarizeRun(got, b.store.getCalls(got.runId));
      expect(s, url).toMatchObject({ imported: false, upstreamRequests: 1 });
      // Its command is still someone else's: a replay asks, naming the store.
      expect(commandIsImported(got)).toBe(true);
      expect(importedCommandSource(got)).toBe('the team store');
    }
  });

  it("brings a teammate's runs with their calls and blobs, marked as from the store", async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'maya@northwind.example');
    const parent = record(a.store, 'parent');
    const fork = record(a.store, 'fork', { parent: parent.runId });
    await push(a, { all: true });

    const b = machine(remote, 'dana@northwind.example');
    const result = await pull(b);
    expect(result.pulled).toEqual([parent.runId, fork.runId]);
    expect(result.byAuthor).toEqual({ 'maya@northwind.example': 2 });
    expect(result.inStore).toBe(2);
    for (const r of [parent, fork]) {
      expect(b.store.getCalls(r.runId)).toEqual(a.store.getCalls(r.runId));
      const got = b.store.getRun(r.runId)!;
      expect(got.meta?.author).toBe('maya@northwind.example');
      // Replaying a pulled run runs someone else's command: it is marked like an import.
      expect(got.meta?.imported?.from).toBe(loc.url);
    }
    expect(b.store.getRun(fork.runId)!.parentRunId).toBe(parent.runId);
    // Pulling again finds nothing new and reads no segment twice.
    remote.log.length = 0;
    const again = await pull(b);
    expect(again.pulled).toEqual([]);
    expect(again.segments).toBe(0);
    expect(remote.log.filter((l) => l.op === 'get' && l.key.startsWith('index/'))).toEqual([]);
  });

  it('pulls one run by a prefix of its id, with its ancestors, and says which names match nothing', async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'maya@northwind.example');
    const parent = record(a.store, 'parent');
    const fork = record(a.store, 'fork', { parent: parent.runId });
    const other = record(a.store, 'other');
    await push(a, { all: true });
    const b = machine(remote, 'dana@northwind.example');
    const result = await pull(b, { runIds: [fork.runId.slice(0, 20).toLowerCase(), 'ZZZZZZZZ'] });
    expect(result.pulled).toEqual([parent.runId, fork.runId]);
    expect(result.unknown).toEqual(['ZZZZZZZZ']);
    expect(b.store.getRun(other.runId)).toBeNull();
  });

  it('forgets a run deleted from the bucket after saying so once', async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const r = record(a.store, 'retired');
    await push(a, { all: true });
    remote.objects.delete(keys.run(r.runId));
    const b = machine(remote, 'maya@northwind.example');
    expect((await pull(b)).missing).toEqual([r.runId]);
    expect(b.store.teamRun(loc.url, r.runId)).toBeNull();
    expect((await pull(b)).missing).toEqual([]);
  });

  it("doesn't bring back a run deleted here unless it is named", async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const r = record(a.store, 'gone');
    await push(a, { all: true });
    a.store.deleteRun(r.runId);
    const result = await pull(a);
    expect(result.skippedDeleted).toEqual([r.runId]);
    expect(a.store.getRun(r.runId)).toBeNull();
    expect((await pull(a, { runIds: [r.runId] })).pulled).toEqual([r.runId]);
  });

  it("brings a teammate's replay of a run deleted here without the run, unlinked, as unpack would", async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const b = machine(remote, 'maya@northwind.example');
    const r = record(a.store, 'refund order 1');
    await push(a, { all: true });
    await pull(b);
    b.store.deleteRun(r.runId);
    expect((await pull(b)).skippedDeleted).toEqual([r.runId]);
    // Dana replays it and pushes the replay.
    const fork = record(a.store, 'refund order 1, again', { parent: r.runId });
    await push(a, { all: true });
    const result = await pull(b);
    expect(result.pulled).toEqual([fork.runId]);
    expect(result.skippedDeleted).toEqual([r.runId]);
    expect(b.store.getRun(r.runId)).toBeNull();
    expect(b.store.getRun(fork.runId)!.parentRunId).toBeNull();
    // Named, the run comes back, and the replay is linked to it again, as the store links them.
    expect((await pull(b, { runIds: [r.runId] })).pulled).toEqual([r.runId]);
    expect(b.store.getRun(fork.runId)!.parentRunId).toBe(r.runId);
    expect(b.store.childRuns(r.runId).map((x) => x.runId)).toEqual([fork.runId]);
  });

  it('refuses a blob changed in the bucket, and skips an index segment that is not one', async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const r = record(a.store, 'tamper');
    await push(a, { all: true });
    remote.objects.set('index/00000000000000000000000000.json', { body: Buffer.from('not json'), version: 'x', contentType: 'application/json' });
    const blob = remote.keysUnder('blobs/')[0]!;
    remote.objects.get(blob)!.body = gzipSync(Buffer.from('something else'));
    const lines: string[] = [];
    const b = { ...machine(remote, 'ravi@northwind.example'), log: (l: string) => lines.push(l) };
    const result = await pull(b);
    expect(result.failed).toEqual([{ runId: r.runId, reason: expect.stringMatching(/doesn't match its hash/) }]);
    expect(result.skippedSegments).toEqual([{ key: 'index/00000000000000000000000000.json', reason: expect.stringMatching(/isn't JSON/) }]);
    expect(lines.join('\n')).toMatch(/skipped index\/0{26}\.json/);
    expect(b.store.listRuns()).toEqual([]);
  });

  it('refuses calls that belong to another run', async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const r1 = record(a.store, 'one');
    const r2 = record(a.store, 'two');
    await push(a, { all: true });
    remote.objects.get(keys.calls(r1.runId))!.body = remote.objects.get(keys.calls(r2.runId))!.body;
    const result = await pull(machine(remote, 'x'), { runIds: [r1.runId] });
    expect(result.failed).toEqual([{ runId: r1.runId, reason: expect.stringMatching(/belongs to another run/) }]);
  });

  it('brings the other runs when one in the store is bad, and tries that one again next time', async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const r1 = record(a.store, 'first');
    const bad = record(a.store, 'second');
    const fork = record(a.store, 'fork of the second', { parent: bad.runId });
    const r3 = record(a.store, 'third');
    await push(a, { all: true });
    // Someone with write access to the bucket puts an escape sequence in a command line.
    const doc = readDoc(remote, bad.runId);
    doc.run.command.argv = ['node', 'agent.js\u001b]0;owned\u0007'];
    writeDoc(remote, bad.runId, doc);

    const b = machine(remote, 'maya@northwind.example');
    const first = await pull(b);
    expect(first.pulled).toEqual([r1.runId, r3.runId]);
    expect(first.failed).toEqual([
      { runId: bad.runId, reason: expect.stringMatching(/argv\[1\]: contains control characters/) },
      { runId: fork.runId, reason: `its parent ${bad.runId} couldn't be pulled` },
    ]);
    // The pull still counts: the next one reads no segment twice, and tries the bad run again.
    expect(b.store.teamSync(loc.url)!.pulledAt).not.toBeNull();
    const second = await pull(b);
    expect(second.segments).toBe(0);
    expect(second.pulled).toEqual([]);
    expect(second.failed.map((f) => f.runId)).toEqual([bad.runId, fork.runId]);
    // Once the run is fixed in the store, the next pull brings it and its fork.
    writeDoc(remote, bad.runId, { ...doc, run: { ...doc.run, command: cmd } });
    expect((await pull(b)).pulled).toEqual([bad.runId, fork.runId]);
  });
});

describe('labels and notes on more than one machine', () => {
  it('merges what each side added and removed, both ways', async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const b = machine(remote, 'maya@northwind.example');
    const r = record(a.store, 'shared run');
    a.store.updateRunMeta(r.runId, { labels: ['refund-flow', 'old'] });
    await push(a, { all: true });
    await pull(b);

    // Each side changes the labels and adds a note, without seeing the other's.
    b.store.updateRunMeta(r.runId, { labels: ['refund-flow', 'old', 'bug'], notes: [{ callNo: 1, text: 'lost here', at: 10 }] });
    a.store.updateRunMeta(r.runId, { labels: ['refund-flow', 'good'], notes: [{ callNo: null, text: 'run note', at: 5 }] });
    const pushedB = await push(b, { all: true });
    expect(pushedB.updated).toEqual([r.runId]);
    const pushedA = await push(a, { all: true });
    expect(pushedA.updated).toEqual([r.runId]);
    // A merged with B's push on the way: A has both now.
    expect(a.store.getRun(r.runId)!.meta?.labels?.sort()).toEqual(['bug', 'good', 'refund-flow']);
    const pulled = await pull(b);
    expect(pulled.merged).toEqual([r.runId]);
    const meta = b.store.getRun(r.runId)!.meta!;
    expect(meta.labels?.sort()).toEqual(['bug', 'good', 'refund-flow']);
    expect(meta.notes?.map((n) => n.text)).toEqual(['run note', 'lost here']);
    expect(meta.imported?.from).toBe(loc.url); // still this machine's own marker
    // Both sides now agree: nothing more to push or pull.
    expect((await push(a, { all: true })).updated).toEqual([]);
    expect((await pull(b)).merged).toEqual([]);
  });

  it('merges with a push that won the race for the same run', async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const r = record(a.store, 'raced');
    await push(a, { all: true });
    const b = machine(remote, 'maya@northwind.example');
    await pull(b);
    a.store.updateRunMeta(r.runId, { labels: ['from-a'] });
    b.store.updateRunMeta(r.runId, { labels: ['from-b'] });
    // B's write lands between A reading run.json and writing it back.
    let raced = false;
    remote.beforePut = (key) => {
      if (raced || key !== keys.run(r.runId)) return;
      raced = true;
      const doc = JSON.parse(remote.objects.get(key)!.body.toString()) as { run: RunRecord };
      doc.run.meta = { ...doc.run.meta, labels: ['from-b'] };
      remote.objects.set(key, { body: Buffer.from(JSON.stringify(doc)), version: 'b-wrote', contentType: 'application/json' });
    };
    await push(a, { all: true });
    const doc = JSON.parse(remote.objects.get(keys.run(r.runId))!.body.toString()) as { run: RunRecord };
    expect(doc.run.meta?.labels?.sort()).toEqual(['from-a', 'from-b']);
  });

  /** Runs `edit` once, while the machine waits for the store's run.json of `runId`. */
  function whileFetching(remote: MemoryStore, runId: string, edit: () => void): void {
    const get = remote.get.bind(remote);
    let done = false;
    remote.get = async (key, options) => {
      const got = await get(key, options);
      if (!done && key === keys.run(runId)) {
        done = true;
        edit();
      }
      return got;
    };
  }
  const addLabel = (m: { store: Store }, runId: string, label: string) => m.store.updateRunMeta(runId, { labels: [...(m.store.getRun(runId)!.meta?.labels ?? []), label] });

  it('keeps a label added while a pull merges the run, and sends it with the next push', async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const b = machine(remote, 'maya@northwind.example');
    const r = record(a.store, 'labelled during a pull');
    a.store.updateRunMeta(r.runId, { labels: ['good'] });
    await push(a, { all: true });
    await pull(b);
    addLabel(a, r.runId, 'from-alice');
    await push(a, { all: true });
    // Maya labels the run while her pull waits for its run.json from the store.
    whileFetching(remote, r.runId, () => addLabel(b, r.runId, 'from-bob'));
    const pulled = await pull(b);
    expect(pulled.merged).toEqual([r.runId]);
    expect(pulled.needPush).toEqual([r.runId]);
    expect(b.store.getRun(r.runId)!.meta?.labels?.sort()).toEqual(['from-alice', 'from-bob', 'good']);
    await push(b, { all: true });
    await pull(a);
    expect(a.store.getRun(r.runId)!.meta?.labels?.sort()).toEqual(['from-alice', 'from-bob', 'good']);
  });

  it('keeps a label added while a push merges the run, and sends it with the next push', async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const b = machine(remote, 'maya@northwind.example');
    const r = record(a.store, 'labelled during a push');
    await push(a, { all: true });
    await pull(b);
    addLabel(a, r.runId, 'from-alice');
    await push(a, { all: true });
    addLabel(b, r.runId, 'from-bob');
    whileFetching(remote, r.runId, () => addLabel(b, r.runId, 'from-bob-later'));
    expect((await push(b, { all: true })).updated).toEqual([r.runId]);
    expect(b.store.getRun(r.runId)!.meta?.labels?.sort()).toEqual(['from-alice', 'from-bob', 'from-bob-later']);
    expect((await push(b, { all: true })).updated).toEqual([r.runId]);
    await pull(a);
    expect(a.store.getRun(r.runId)!.meta?.labels?.sort()).toEqual(['from-alice', 'from-bob', 'from-bob-later']);
  });
});

describe('a run that came here another way', () => {
  it("takes the store's labels the first time a pull meets it", async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const r = record(a.store, 'packed and pushed');
    a.store.updateRunMeta(r.runId, { labels: ['refund-flow'] });
    await push(a, { all: true });
    // Maya has the same run from a pack, with a label of her own.
    const b = machine(remote, 'maya@northwind.example');
    b.store.importRun({ ...a.store.getRun(r.runId)!, meta: { labels: ['mine'], imported: { at: 1, from: 'goldens/refund' } } });
    const result = await pull(b);
    expect(result.pulled).toEqual([]);
    expect(result.merged).toEqual([r.runId]);
    expect(b.store.getRun(r.runId)!.meta?.labels).toEqual(['mine', 'refund-flow']);
    expect(result.needPush).toEqual([r.runId]);
    expect(b.store.teamRun(loc.url, r.runId)!.state).toBe('pulled');
  });
});

describe("a result made here of a teammate's run", () => {
  const blame = { at: 1, outcome: 'unrescuable', callNo: 1, confidence: 'high', rescuedRunId: null, fields: {}, oracle: [], probes: [], spent: 0 } as unknown as BlameRecord;

  it("stays on this machine's copy when the store's has none, through push and pull, and never goes up", async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const b = machine(remote, 'maya@northwind.example');
    const r = record(a.store, 'failed for dana');
    await push(a, { all: true });
    await pull(b);
    // Maya blames Dana's run on her machine.
    b.store.updateRunMeta(r.runId, { blame });
    remote.log.length = 0;
    const pushed = await push(b, { all: true });
    expect(pushed.updated).toEqual([]);
    expect(b.store.getRun(r.runId)!.meta?.blame).toEqual(blame);
    // Nothing of it to send: the run wasn't even read from the store again.
    expect(remote.log.filter((l) => l.key === keys.run(r.runId))).toEqual([]);
    expect(readDoc(remote, r.runId).run.meta?.blame).toBeUndefined();
    // Pushed by name, the store's copy is read and merged: still hers, still not the store's.
    await push(b, { runIds: [r.runId] });
    expect(b.store.getRun(r.runId)!.meta?.blame).toEqual(blame);
    expect(readDoc(remote, r.runId).run.meta?.blame).toBeUndefined();
    // A pull that merges Dana's new label keeps it too.
    a.store.updateRunMeta(r.runId, { labels: ['refund-flow'] });
    await push(a, { all: true });
    expect((await pull(b)).merged).toEqual([r.runId]);
    expect(b.store.getRun(r.runId)!.meta).toMatchObject({ labels: ['refund-flow'], blame });
    await pull(a);
    expect(a.store.getRun(r.runId)!.meta?.blame).toBeUndefined();
    // Once the run's own machine gives the store a blame, that is the one every machine takes.
    const hers = { ...blame, callNo: 2 } as BlameRecord;
    a.store.updateRunMeta(r.runId, { blame: hers });
    await push(a, { all: true });
    await pull(b);
    expect(b.store.getRun(r.runId)!.meta?.blame).toEqual(hers);
  });
});

describe('reconcile', () => {
  const blame = (callNo: number) => ({ at: 1, outcome: 'blamed', callNo, confidence: 'high', rescuedRunId: null, fields: {}, oracle: [], probes: [], spent: 0 }) as BlameRecord;

  it('merges labels and notes three ways, and takes results from whichever side made the run', () => {
    const base = { labels: ['a'], blame: blame(3) };
    const local = { labels: ['a', 'b'], blame: blame(4), author: 'dana@northwind.example', covers: ['api'] };
    const remote = { labels: [], blame: blame(5), author: 'mallory@evil.example' };
    // Made here: this machine's blame stands; the label removed in the store is removed.
    expect(reconcile(local, remote, base, true)).toEqual({ labels: ['b'], blame: blame(4) });
    // Made elsewhere: the store's blame is the one that counts.
    expect(reconcile(local, remote, base, false)).toEqual({ labels: ['b'], blame: blame(5) });
  });

  it('without a base, joins labels and notes', () => {
    const merged = reconcile({ labels: ['x'], notes: [{ callNo: null, text: 'mine', at: 2 }] }, { labels: ['y'], notes: [{ callNo: 1, text: 'theirs', at: 1 }] }, null, true);
    expect(merged.labels).toEqual(['x', 'y']);
    expect((merged.notes as Array<{ text: string }>).map((n) => n.text)).toEqual(['theirs', 'mine']);
  });

  it('hashes the part that syncs only: labels, notes and results', () => {
    expect(metaHash({ labels: ['a'], imported: { at: 1, from: 'x' }, covers: ['api'], author: 'x' })).toBe(metaHash({ labels: ['a'] }));
    expect(metaHash({ labels: [] })).toBe(metaHash({}));
    expect(syncedMeta({ labels: ['a'], checks: [], redactions: [] })).toEqual({ labels: ['a'], checks: [] });
  });
});

describe('a push cut short', () => {
  it('lists the runs that went up before a later one failed, and the next push sends the rest', async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const r1 = record(a.store, 'one');
    const r2 = record(a.store, 'two');
    let failOnce = true;
    remote.beforePut = (key) => {
      if (failOnce && key === keys.calls(r2.runId)) {
        failOnce = false;
        throw new StoreError('network', 'Amazon S3: the connection was reset');
      }
    };
    await expect(push(a, { all: true })).rejects.toThrow(/connection was reset/);
    // r1 is in the bucket and listed: a teammate gets it now.
    expect(listed(remote)).toEqual([r1.runId]);
    const b = machine(remote, 'maya@northwind.example');
    expect((await pull(b)).pulled).toEqual([r1.runId]);
    expect(a.store.teamSync(loc.url)?.pushedAt ?? null).toBeNull();

    const again = await push(a, { all: true });
    expect(again.pushed).toEqual([r2.runId]);
    expect(again.unchanged).toEqual([r1.runId]);
    expect((await pull(b)).pulled).toEqual([r2.runId]);
  });

  it('lists runs whose upload landed when writing the index failed', async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const r1 = record(a.store, 'one');
    const r2 = record(a.store, 'two');
    let failOnce = true;
    remote.beforePut = (key) => {
      if (failOnce && key.startsWith('index/')) {
        failOnce = false;
        throw new StoreError('network', 'Amazon S3: the connection was reset');
      }
    };
    await expect(push(a, { all: true })).rejects.toThrow(/connection was reset/);
    expect(remote.objects.has(keys.run(r1.runId))).toBe(true);
    expect(listed(remote)).toEqual([]);
    // Up there, but not for the team yet: this machine doesn't count them as in the store.
    expect(a.store.teamRuns(loc.url).filter(teamRunInStore)).toEqual([]);

    remote.log.length = 0;
    const again = await push(a, { all: true });
    expect(again.pushed).toEqual([r1.runId, r2.runId]);
    // Nothing is uploaded twice: the runs are there, only the index was missing.
    expect(again.blobs.uploaded).toBe(0);
    expect(remote.log.filter((l) => l.op === 'put').map((l) => l.key)).toEqual([again.segment]);
    expect(listed(remote)).toEqual([r1.runId, r2.runId].sort());
    expect((await pull(machine(remote, 'maya@northwind.example'))).pulled).toEqual([r1.runId, r2.runId]);
  });

  it('lists a run whose write was retried after it had landed', async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const r = record(a.store, 'retried');
    // The first write lands, its answer is lost, and the retry meets it: a precondition failure.
    const put = remote.put.bind(remote);
    let first = true;
    remote.put = async (key, body, options) => {
      const out = await put(key, body, options);
      if (first && key === keys.run(r.runId)) {
        first = false;
        throw new StoreError('precondition', `${key} exists`, 412);
      }
      return out;
    };
    const result = await push(a, { all: true });
    expect(result.pushed).toEqual([r.runId]);
    expect(result.segment).not.toBeNull();
    expect(listed(remote)).toEqual([r.runId]);
    expect((await pull(machine(remote, 'maya@northwind.example'))).pulled).toEqual([r.runId]);
  });

  it('sends a named run again when the bucket lost it, but --all leaves what the bucket let go', async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const r = record(a.store, 'expired');
    await push(a, { all: true });
    // A retention rule removed the run and its blobs.
    for (const key of [...remote.keysUnder('runs/'), ...remote.keysUnder('blobs/')]) remote.objects.delete(key);
    expect((await push(a, { all: true })).unchanged).toEqual([r.runId]);
    expect(remote.objects.has(keys.run(r.runId))).toBe(false);

    const named = await push(a, { runIds: [r.runId] });
    expect(named.pushed).toEqual([r.runId]);
    // Its blobs went up again too: this machine's memory of them was no longer true.
    expect(named.blobs.uploaded).toBeGreaterThan(0);
    const b = machine(remote, 'maya@northwind.example');
    const pulled = await pull(b, { runIds: [r.runId] });
    expect(pulled.failed).toEqual([]);
    expect(b.store.getCalls(r.runId)).toEqual(a.store.getCalls(r.runId));
  });
});

describe('what the bucket may hold', () => {
  it('takes a command line over several lines both ways, and keeps one that could rewrite a terminal here', async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const multi = record(a.store, 'python -c', { argv: ['python', '-c', 'import agent\n\tagent.main()'] });
    const hostile = record(a.store, 'escape', { argv: ['node', '-e', 'console.log(1)\u001b]0;owned\u0007'] });
    const fork = record(a.store, 'fork of escape', { parent: hostile.runId });
    const result = await push(a, { all: true });
    expect(result.pushed).toEqual([multi.runId]);
    expect(result.refused).toEqual([
      { runId: hostile.runId, reason: expect.stringMatching(/argv\[2\]: contains control characters/) },
      { runId: fork.runId, reason: `its parent ${hostile.runId} can't go to the store` },
    ]);
    expect(remote.objects.has(keys.run(hostile.runId))).toBe(false);
    expect(listed(remote)).toEqual([multi.runId]);

    const b = machine(remote, 'maya@northwind.example');
    expect((await pull(b)).pulled).toEqual([multi.runId]);
    expect(b.store.getRun(multi.runId)!.command.argv).toEqual(['python', '-c', 'import agent\n\tagent.main()']);
  });

  it('brings a run marked running as interrupted, and refuses one that starts years ahead', async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const r = record(a.store, 'left running');
    const ahead = record(a.store, 'from the future');
    await push(a, { all: true });
    // Anyone who can write to the bucket marks them running; the index needs nothing new.
    const doc = readDoc(remote, r.runId);
    writeDoc(remote, r.runId, { ...doc, run: { ...doc.run, status: 'running', endedAt: null } });
    const later = readDoc(remote, ahead.runId);
    writeDoc(remote, ahead.runId, { ...later, run: { ...later.run, status: 'running', endedAt: null, startedAt: Date.now() + 10 * 365 * 24 * 3600_000 } });

    const b = machine(remote, 'maya@northwind.example');
    const pulled = await pull(b);
    expect(pulled.pulled).toEqual([r.runId]);
    expect(pulled.failed).toEqual([{ runId: ahead.runId, reason: expect.stringMatching(/startedAt: is more than a day in the future/) }]);
    // Ended at the last thing it recorded (its calls here are stamped before its start): no process
    // here records it, so nothing takes it for a recording.
    expect(b.store.getRun(r.runId)).toMatchObject({ status: 'crashed', endedAt: r.startedAt });
    expect(b.store.recordingRuns().live).toEqual([]);
  });

  it("can't change how a run made here replays, or who made it, whatever run.json says", async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const r = record(a.store, 'mine');
    a.store.updateRunMeta(r.runId, { labels: ['refund-flow'], checks: [{ ok: false, label: 'answer includes "refund"', detail: 'not found in the answer' }] });
    await push(a, { all: true });

    // Anyone who can write to the bucket (CI included) edits the run, and lists the edit.
    const doc = readDoc(remote, r.runId);
    doc.run.meta = {
      ...doc.run.meta,
      author: 'mallory@evil.example',
      covers: ['api'],
      redactions: [{ pattern: '/\\$/g', replace: 'X' }],
      normalizersHash: 'f'.repeat(64),
      checks: [{ ok: true, label: 'all good', detail: null }],
      labels: ['refund-flow', 'triaged'],
    };
    writeDoc(remote, r.runId, doc);
    const entry: IndexEntry = { runId: r.runId, parentRunId: null, mode: 'record', status: 'completed', startedAt: r.startedAt, endedAt: r.endedAt, author: 'mallory@evil.example', codeVersion: null, ci: null, labels: ['refund-flow', 'triaged'], calls: 1, metaHash: metaHash(doc.run.meta) };
    writeSegment(remote, '01ZZZZZZZZZZZZZZZZZZZZZZZZ', [entry]);

    const pulled = await pull(a);
    expect(pulled.merged).toEqual([r.runId]);
    const meta = a.store.getRun(r.runId)!.meta!;
    // A label is anyone's to add.
    expect(meta.labels).toEqual(['refund-flow', 'triaged']);
    // The rest is this run's own: who made it, what it covers, its redactions, its results.
    expect(meta.author).toBe('dana@northwind.example');
    expect(meta.covers).toBeUndefined();
    expect(meta.redactions).toBeUndefined();
    expect(meta.normalizersHash).toBeUndefined();
    expect(meta.checks).toEqual([{ ok: false, label: 'answer includes "refund"', detail: 'not found in the answer' }]);
    // And the next push puts its results back in the store.
    expect(pulled.needPush).toEqual([r.runId]);
    expect((await push(a, { all: true })).updated).toEqual([r.runId]);
    expect(readDoc(remote, r.runId).run.meta?.checks).toEqual([{ ok: false, label: 'answer includes "refund"', detail: 'not found in the answer' }]);
  });

  it("takes a teammate's results for their run, and never sends this machine's over them", async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const r = record(a.store, 'dana made this');
    await push(a, { all: true });
    const b = machine(remote, 'maya@northwind.example');
    await pull(b);
    // Dana checks her run later; Maya's copy gets the result.
    a.store.updateRunMeta(r.runId, { checks: [{ ok: true, label: 'answer includes "refund"', detail: null }] });
    expect((await push(a, { all: true })).updated).toEqual([r.runId]);
    expect((await pull(b)).merged).toEqual([r.runId]);
    expect(b.store.getRun(r.runId)!.meta?.checks).toEqual([{ ok: true, label: 'answer includes "refund"', detail: null }]);
    // Maya's own run of the checks stays on her machine: the run is Dana's.
    b.store.updateRunMeta(r.runId, { checks: [{ ok: false, label: 'mine', detail: 'x' }], labels: ['seen'] });
    await push(b, { all: true });
    const meta = readDoc(remote, r.runId).run.meta!;
    expect(meta.checks).toEqual([{ ok: true, label: 'answer includes "refund"', detail: null }]);
    expect(meta.labels).toEqual(['seen']);
    // Her copy shows Dana's result again, with her label.
    expect(b.store.getRun(r.runId)!.meta).toMatchObject({ checks: [{ ok: true, label: 'answer includes "refund"', detail: null }], labels: ['seen'] });
  });

  it("refuses an author that could rewrite a terminal, and drops one from the index", async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const r = record(a.store, 'authored');
    await push(a, { all: true });
    const doc = readDoc(remote, r.runId);
    doc.run.meta = { ...doc.run.meta, author: 'mallory\u001b]0;owned\u0007\u001b[2J@evil.example' };
    writeDoc(remote, r.runId, doc);
    const result = await pull(machine(remote, 'maya@northwind.example'));
    expect(result.failed).toEqual([{ runId: r.runId, reason: expect.stringMatching(/meta\.author: contains control characters/) }]);
    expect(result.byAuthor).toEqual({});

    const segment = Buffer.from(JSON.stringify({ format: INDEX_FORMAT, version: LAYOUT_VERSION, at: 1, by: 'eve\u001b[2J', runs: [{ runId: r.runId, parentRunId: null, startedAt: 1, metaHash: 'a'.repeat(64), author: 'eve\u001b[2J@evil.example', labels: ['ok', 'bad\u001b'], codeVersion: 'abc\u0007' }] }));
    const parsed = parseSegment(segment, 'index/x.json');
    expect(parsed.by).toBeNull();
    expect(parsed.runs[0]).toMatchObject({ author: null, labels: ['ok'], codeVersion: null });
  });
});

describe('the index', () => {
  it('tries a segment it could not read again on the next pull, instead of forgetting it', async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const r = record(a.store, 'from a newer Shadowlap');
    await push(a, { all: true });
    const key = remote.keysUnder('index/')[0]!;
    const body = remote.objects.get(key)!.body;
    // As a newer Shadowlap would write it.
    remote.objects.get(key)!.body = Buffer.from(JSON.stringify({ ...JSON.parse(body.toString()), version: 2 }));
    const b = machine(remote, 'maya@northwind.example');
    const first = await pull(b);
    expect(first.skippedSegments).toEqual([{ key, reason: expect.stringMatching(/version 2.*Update Shadowlap/) }]);
    expect(first.pulled).toEqual([]);
    expect((await pull(b)).skippedSegments.map((x) => x.key)).toEqual([key]);
    // Once it can be read (here: written again as this version reads it), the run comes.
    remote.objects.get(key)!.body = body;
    const later = await pull(b);
    expect(later.skippedSegments).toEqual([]);
    expect(later.pulled).toEqual([r.runId]);
  });
});

/** The same bucket seen from a pull request's folder, as a driver opened at pr/<number>/ sees it. */
function prFolder(remote: MemoryStore, number: string): ObjectStore {
  const prefix = `pr/${number}/`;
  return {
    location: pullRequestLocation(remote.location, number),
    credentials: () => remote.credentials(),
    get: (key) => remote.get(prefix + key),
    head: async (key) => {
      const info = await remote.head(prefix + key);
      return info && { ...info, key };
    },
    put: (key, body, options) => remote.put(prefix + key, body, options),
    delete: (key) => remote.delete(prefix + key),
    list: async function* (sub) {
      for await (const o of remote.list(prefix + sub)) yield { ...o, key: o.key.slice(prefix.length) };
    },
    presign: (key, seconds) => remote.presign(prefix + key, seconds),
    bucketInfo: () => remote.bucketInfo(),
  };
}

describe("a pull request's folder", () => {
  it("keeps a pull request's runs out of a pull, and never lets them into the store's own runs", async () => {
    const remote = new MemoryStore(loc);
    const dana = machine(remote, 'dana@northwind.example');
    const ours = record(dana.store, 'the team run');
    await push(dana, { all: true });

    // A pull request's CI job pushes to its own folder: nothing outside pr/42/ is written.
    const before = new Set(remote.objects.keys());
    const ci = { ...machine(remote, 'ci'), ci: 'github', remote: prFolder(remote, '42'), pullRequest: '42' };
    const theirs = record(ci.store, 'a run from the pull request');
    expect((await push(ci, { all: true })).pushed).toEqual([theirs.runId]);
    const written = [...remote.objects.keys()].filter((k) => !before.has(k));
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((k) => k.startsWith('pr/42/'))).toBe(true);

    // A pull leaves pr/ out: it isn't even listed.
    const maya = machine(remote, 'maya@northwind.example');
    remote.log.length = 0;
    expect((await pull(maya)).pulled).toEqual([ours.runId]);
    expect(remote.log.some((l) => l.key.startsWith('pr/'))).toBe(false);

    // Asked for, the pull request's runs come, marked as its.
    const fromPr = await pull({ ...maya, remote: prFolder(remote, '42'), pullRequest: '42' });
    expect(fromPr.pulled).toEqual([theirs.runId]);
    expect(maya.store.getRun(theirs.runId)!.meta?.imported).toMatchObject({ from: `${loc.url}/pr/42`, pr: '42' });

    // They never go into the store's own runs: --all leaves them out, named they are refused.
    expect(maya.store.teamLocalOnly(loc.url, 10)).toEqual({ count: 0, ids: [] });
    const all = await push(maya, { all: true });
    expect(all.pushed).toEqual([]);
    expect(all.refused).toEqual([]);
    expect(remote.objects.has(keys.run(theirs.runId))).toBe(false);
    const named = await push(maya, { runIds: [theirs.runId] });
    expect(named.refused).toEqual([{ runId: theirs.runId, reason: expect.stringMatching(/came from pull request 42's folder in the store/) }]);
    // Nor does a fork of one made here: a fork goes with its lineage or not at all.
    const fork = record(maya.store, 'forked from it', { parent: theirs.runId });
    const forked = await push(maya, { all: true });
    expect(forked.refused).toEqual([{ runId: fork.runId, reason: `its parent ${theirs.runId} can't go to the store` }]);
    expect(remote.keysUnder('runs/').some((k) => k.includes(theirs.runId) || k.includes(fork.runId))).toBe(false);
    // Into a pull request's folder, a pull request's run may go.
    expect((await push({ ...maya, remote: prFolder(remote, '43'), pullRequest: '43' }, { runIds: [theirs.runId] })).pushed).toEqual([theirs.runId]);
  });

  it("never takes its copy of one of the store's own runs, even as the parent of one of its runs", async () => {
    const remote = new MemoryStore(loc);
    const dana = machine(remote, 'dana@northwind.example');
    const golden = record(dana.store, 'a golden the team trusts');
    await push(dana, { all: true });
    // The pull request's job forks the golden and pushes the fork, with the golden, to its folder,
    // where it can write the golden's copy as it likes.
    const ci = { ...machine(remote, 'ci'), remote: prFolder(remote, '42'), pullRequest: '42' };
    await pull({ ...ci, remote });
    const fork = record(ci.store, 'the fork', { parent: golden.runId });
    await push(ci, { runIds: [fork.runId] });
    const key = `pr/42/${keys.run(golden.runId)}`;
    const doc = JSON.parse(remote.objects.get(key)!.body.toString()) as { run: RunRecord };
    doc.run.meta = { ...doc.run.meta, author: 'mallory@evil.example' };
    remote.objects.get(key)!.body = Buffer.from(JSON.stringify(doc));

    const maya = machine(remote, 'maya@northwind.example');
    const asked: string[] = [];
    const own = new Set([golden.runId]);
    const fetchExcluded = async (ids: string[]) => {
      asked.push(...ids);
      await pull(maya, { runIds: ids });
    };
    const result = await pull({ ...maya, remote: prFolder(remote, '42'), pullRequest: '42' }, { exclude: own, fetchExcluded });
    expect(asked).toEqual([golden.runId]);
    expect(result.pulled).toEqual([fork.runId]);
    const here = maya.store.getRun(golden.runId)!;
    expect(here.meta?.author).toBe('dana@northwind.example');
    expect(here.meta?.imported).toEqual({ at: expect.any(Number), from: loc.url });
    expect(maya.store.getRun(fork.runId)!.parentRunId).toBe(golden.runId);
    // Named, it is the store's, not the pull request's: nothing to bring from here.
    const other = machine(remote, 'ravi@northwind.example');
    expect((await pull({ ...other, remote: prFolder(remote, '42'), pullRequest: '42' }, { runIds: [golden.runId], exclude: own })).pulled).toEqual([]);
    expect(other.store.getRun(golden.runId)).toBeNull();
  });

  it('takes nothing it says about a run that is already here', async () => {
    const remote = new MemoryStore(loc);
    const dana = machine(remote, 'dana@northwind.example');
    const golden = record(dana.store, 'a golden the team trusts');
    await push(dana, { all: true });
    const maya = machine(remote, 'maya@northwind.example');
    await pull(maya);

    // The pull request's job has the golden too, labels it and writes a result for it into its own folder.
    const ci = { ...machine(remote, 'ci'), remote: prFolder(remote, '42'), pullRequest: '42' };
    await pull({ ...ci, remote });
    ci.store.updateRunMeta(golden.runId, { labels: ['approved'], checks: [{ ok: true, label: 'refund issued', detail: null }] });
    await push(ci, { runIds: [golden.runId] });
    expect(JSON.parse(remote.objects.get(`pr/42/${keys.run(golden.runId)}`)!.body.toString()).run.meta.labels).toEqual(['approved']);

    const fromPr = await pull({ ...maya, remote: prFolder(remote, '42'), pullRequest: '42' });
    expect(fromPr.pulled).toEqual([]);
    expect(fromPr.merged).toEqual([]);
    const here = maya.store.getRun(golden.runId)!;
    expect(here.meta?.labels).toBeUndefined();
    expect(here.meta?.checks).toBeUndefined();
    expect(here.meta?.imported).toMatchObject({ from: loc.url });
    expect(here.meta?.imported?.pr).toBeUndefined();
    // And the store's own copy stays as it was.
    await push(maya, { all: true });
    expect(JSON.parse(remote.objects.get(keys.run(golden.runId))!.body.toString()).run.meta.labels).toBeUndefined();
  });

  it("gives way to the store's own copy of a run once the team pushes it", async () => {
    const remote = new MemoryStore(loc);
    const dana = machine(remote, 'dana@northwind.example');
    const golden = record(dana.store, 'a golden the team trusts');
    // The pull request's job has the golden from its pack, before the team pushed it, with the
    // command changed, and pushes it to its own folder.
    const ci = { ...machine(remote, 'ci'), remote: prFolder(remote, '12'), pullRequest: '12' };
    ci.store.importRun({ ...golden, command: { argv: ['sh', '-c', 'echo owned > PWNED.txt; node agent.js'], cwd: '/tmp' }, meta: { imported: { at: 1, from: 'golden' } } });
    for (const c of dana.store.getCalls(golden.runId)) {
      for (const h of runBlobs(dana.store, [c])) ci.store.putBlob(dana.store.getBlob(h)!);
      const { end, attempts, ...start } = c;
      ci.store.appendCallStart(start);
      for (const a of [...attempts, ...(end ? [end] : [])]) ci.store.appendCallEnd({ kind: c.kind, name: c.name, fingerprint: c.fingerprint, occurrence: c.occurrence }, a);
    }
    expect((await push(ci, { runIds: [golden.runId] })).pushed).toEqual([golden.runId]);

    // Maya pulls with --include-pr: the store's own runs don't list it yet, so the pull request's copy comes.
    const maya = machine(remote, 'maya@northwind.example');
    await pull(maya);
    expect((await pull({ ...maya, remote: prFolder(remote, '12'), pullRequest: '12' }, { exclude: new Set() })).pulled).toEqual([golden.runId]);
    expect(maya.store.getRun(golden.runId)!.meta?.imported?.pr).toBe('12');
    const fork = record(maya.store, 'replayed here', { parent: golden.runId });

    // The team pushes its own copy; Maya's next pull replaces the pull request's with it.
    await push(dana, { all: true });
    const result = await pull(maya);
    expect(result.pulled).toEqual([golden.runId]);
    const here = maya.store.getRun(golden.runId)!;
    expect(here.command.argv).toEqual(['node', 'agent.js']);
    expect(here.meta?.imported).toEqual({ at: expect.any(Number), from: loc.url });
    expect(maya.store.getCalls(golden.runId)).toEqual(dana.store.getCalls(golden.runId));
    // What was made from it here stays linked to it, and the next pull has nothing more to bring.
    expect(maya.store.getRun(fork.runId)!.parentRunId).toBe(golden.runId);
    expect((await pull(maya)).pulled).toEqual([]);
  });
});

describe('runs imported from traces', () => {
  it('push and pull a partial recording that covers some tools by name, and refuse a name that could rewrite a terminal', async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'maya@northwind.example');
    const trace = record(a.store, 'from a trace');
    a.store.updateRunMeta(trace.runId, { covers: ['api', 'tool:lookup_order'], imported: { at: 1, from: 'langfuse:7f3a9c2e' } });
    const hostile = record(a.store, 'hostile trace');
    a.store.updateRunMeta(hostile.runId, { covers: ['api', 'tool:x\u001b]0;owned\u0007'], imported: { at: 1, from: 'otel.json' } });
    const result = await push(a, { all: true });
    expect(result.pushed).toEqual([trace.runId]);
    expect(result.refused).toEqual([{ runId: hostile.runId, reason: expect.stringMatching(/covers/) }]);
    const b = machine(remote, 'dana@northwind.example');
    expect((await pull(b)).pulled).toEqual([trace.runId]);
    expect(b.store.getRun(trace.runId)!.meta?.covers).toEqual(['api', 'tool:lookup_order']);
  });
});

describe('attempts in the index', () => {
  it('names the run each attempt is filed under, so a teammate counts it with its run before pulling it', async () => {
    const remote = new MemoryStore(loc);
    const a = machine(remote, 'dana@northwind.example');
    const rec = record(a.store, 'the recording');
    const attempt = record(a.store, 'an attempt', { parent: rec.runId });
    a.store.updateRunMeta(attempt.runId, { repeat: { group: 'g', attempt: 1, of: 1 } });
    const fork = record(a.store, 'a fork', { parent: rec.runId });
    await push(a, { all: true });
    const entries = new Map(remote.keysUnder('index/').flatMap((k) => parseSegment(remote.objects.get(k)!.body, k).runs).map((e) => [e.runId, e]));
    expect(entries.get(attempt.runId)!.attemptOf).toBe(rec.runId);
    expect(entries.get(rec.runId)).not.toHaveProperty('attemptOf');
    expect(entries.get(fork.runId)).not.toHaveProperty('attemptOf');
    // A segment that says something else than a run id is read without it.
    writeSegment(remote, '01K5CQ4N7G00000000000000ZZ', [{ runId: '01K5CQ4N7G00000000000000AA', parentRunId: null, startedAt: 1, metaHash: 'a'.repeat(64), attemptOf: '../../etc' }]);
    const seg = parseSegment(remote.objects.get(keys.segment('01K5CQ4N7G00000000000000ZZ'))!.body, 'x');
    expect(seg.runs[0]).not.toHaveProperty('attemptOf');
  });
});
