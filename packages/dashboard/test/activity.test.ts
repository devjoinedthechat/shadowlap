import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packRun, recordEvent, Store, unpackRun, type CallKind, type CreateRunInput, type Origin, type RunMeta } from '@shadowlap/engine';
import { activity, describeEvent, type ActivityItem } from '../src/index.js';

/** The activity feed: what runs tell by themselves, merged with what commands recorded, newest first. */

function build(): { store: Store; ids: Record<string, string> } {
  const store = Store.open(':memory:');
  const ids: Record<string, string> = {};
  const run = (name: string, input: Partial<CreateRunInput> & { startedAt: number }, end?: { at: number; status?: 'completed' | 'failed' | 'crashed' }) => {
    const r = store.createRun({ mode: 'record', command: { argv: ['python', 'refund_agent.py'], cwd: '.' }, ...input });
    ids[name] = r.runId;
    if (end) store.endRun(r.runId, end.status ?? 'completed', end.at);
    return r.runId;
  };
  let n = 0;
  const call = (runId: string, callNo: number, kind: CallKind, name: string, origin: Origin, meta: Record<string, unknown> = {}) => {
    const id = { kind, name, fingerprint: `f${n++}`.padEnd(64, '0'), occurrence: 1 };
    store.appendCallStart({ runId, callNo, ...id, origin, effect: kind === 'tool' ? (name === 'send_email' ? 'write' : 'read') : null, requestRef: null, meta: {}, at: 1 });
    store.appendCallEnd(id, { runId, callNo, attempt: 0, responseRef: null, outcome: 'ok', meta, at: 2 });
  };
  const replayed = (runId: string) => {
    call(runId, 1, 'api', 'POST /v1/messages', 'replayed');
    call(runId, 2, 'tool', 'lookup_order', 'replayed');
    call(runId, 3, 'api', 'POST /v1/messages', 'replayed');
  };

  // A recording, by Dana, and one still going.
  const rec = run('rec', { startedAt: 1000, meta: { author: 'dana@example.com' } }, { at: 2000 });
  call(rec, 1, 'api', 'POST /v1/messages', 'live');
  call(rec, 2, 'tool', 'lookup_order', 'live');
  call(rec, 3, 'api', 'POST /v1/messages', 'live');
  const live = run('live', { startedAt: 9000 });
  call(live, 1, 'api', 'POST /v1/messages', 'live');

  // A clean replay, a --fail-at fork with a fenced write, and a fork from an overridden tool result.
  replayed(run('clean', { mode: 'replay', parentRunId: rec, startedAt: 2500 }, { at: 3000 }));
  const failAt = run('failAt', { mode: 'replay', parentRunId: rec, startedAt: 3500 }, { at: 4000, status: 'failed' });
  call(failAt, 1, 'api', 'POST /v1/messages', 'replayed');
  call(failAt, 2, 'api', 'POST /v1/messages', 'live', { status: 529, injected: true });
  call(failAt, 3, 'tool', 'send_email', 'blocked');
  store.setDivergence(failAt, { type: 'forced', callNo: 2, kind: 'api', name: 'POST /v1/messages', replayedBefore: 1, reason: "forced live by --fail-at 2=529: answered with HTTP 529 instead of the recording, so the agent's error path runs" });
  const override = run('override', { mode: 'replay', parentRunId: rec, startedAt: 4100 }, { at: 4200 });
  call(override, 1, 'api', 'POST /v1/messages', 'replayed');
  call(override, 2, 'tool', 'lookup_order', 'overridden');
  call(override, 3, 'api', 'POST /v1/messages', 'live');
  store.setDivergence(override, { type: 'request_changed', callNo: 3, kind: 'api', name: 'POST /v1/messages', replayedBefore: 1 });
  // Replays that did not fork: one whose agent failed, one interrupted, one that made no calls at all.
  replayed(run('replayFailed', { mode: 'replay', parentRunId: rec, startedAt: 4300 }, { at: 4310, status: 'failed' }));
  replayed(run('replayStopped', { mode: 'replay', parentRunId: rec, startedAt: 4320 }, { at: 4330, status: 'crashed' }));
  run('replayEmpty', { mode: 'replay', parentRunId: rec, startedAt: 4340 }, { at: 4350 });

  // replay --repeat 2: two attempts forked at #2 that took the same path.
  for (const attempt of [1, 2]) {
    const a = run(`attempt${attempt}`, { mode: 'replay', parentRunId: rec, startedAt: 4900 + attempt, meta: { repeat: { group: 'g1', attempt, of: 2 } } }, { at: 5000 + attempt * 100 });
    call(a, 1, 'api', 'POST /v1/messages', 'replayed');
    call(a, 2, 'api', 'POST /v1/messages', 'live');
    store.setDivergence(a, { type: 'request_changed', callNo: 2, kind: 'api', name: 'POST /v1/messages', replayedBefore: 1 });
  }

  // A capture, a pack of two runs unpacked at once, and a capture an import command already logged.
  const capture = run('capture', { startedAt: 100, meta: { imported: { at: 6000, from: '/tmp/x/session.har' }, covers: ['api'] } }, { at: 200 });
  call(capture, 1, 'api', 'POST /v1/messages', 'live');
  call(capture, 2, 'api', 'POST /v1/messages', 'live');
  const root = run('packRoot', { startedAt: 50, meta: { imported: { at: 6500, from: 'goldens/refund' } } }, { at: 60 });
  run('packChild', { mode: 'replay', parentRunId: root, startedAt: 70, meta: { imported: { at: 6500, from: 'goldens/refund' } } }, { at: 80 });
  const logged = run('logged', { startedAt: 300, meta: { imported: { at: 6600, from: 'traffic.har' }, covers: ['api'] } }, { at: 400 });
  recordEvent(store, { kind: 'capture.imported', runId: logged, ref: 'traffic.har', data: { source: 'traffic.har', calls: 12 }, actor: 'jonas', at: 6600 });
  // One LiteLLM log made two runs, and its event lists both.
  const lite = [run('lite1', { startedAt: 500, meta: { imported: { at: 6700, from: 'proxy.jsonl' }, covers: ['api'] } }, { at: 510 }), run('lite2', { startedAt: 520, meta: { imported: { at: 6700, from: 'proxy.jsonl' }, covers: ['api'] } }, { at: 530 })];
  recordEvent(store, { kind: 'capture.imported', ref: 'proxy.jsonl', data: { source: 'proxy.jsonl', calls: 4, runIds: lite }, at: 6700 });

  // Tests: one passing with its checks, one failing a check; and blame probes, which are bundled away.
  const passed: RunMeta = { test: { golden: 'goldens/refund-over-limit', session: 's1' }, checks: [{ ok: true, label: 'issue_refund never called', detail: null }, { ok: true, label: 'exits 0', detail: null }] };
  replayed(run('testPass', { mode: 'replay', parentRunId: root, startedAt: 6900, meta: passed }, { at: 7001 }));
  const failed: RunMeta = { test: { golden: 'goldens/refund-in-limit/', session: 's1' }, checks: [{ ok: false, label: 'issue_refund called once', detail: 'it was called twice' }] };
  replayed(run('testFail', { mode: 'replay', parentRunId: root, startedAt: 6900, meta: failed }, { at: 7002 }));
  run('probe', { mode: 'replay', parentRunId: rec, startedAt: 7050, meta: { probe: { of: rec, callNo: 3, passed: true } } }, { at: 7060 });
  store.updateRunMeta(rec, { blame: { at: 7100, outcome: 'blamed', callNo: 3, confidence: 'high', rescuedRunId: null, fields: {}, oracle: [], probes: [], spent: 0.1 } });

  // What commands recorded.
  recordEvent(store, { kind: 'normalizer.added', actor: 'maya@example.com', ref: '$.metadata.user_id', data: { path: '$.metadata.user_id', pattern: 'uuid' }, at: 7500 });
  recordEvent(store, { kind: 'golden.packed', runId: rec, ref: 'goldens/refund-flow', data: { runs: 1, calls: 3 }, at: 7600 });
  recordEvent(store, { kind: 'widget.frobbed', ref: 'w-1', at: 7700 });
  return { store, ids };
}

const byId = (items: ActivityItem[], id: string) => items.find((i) => i.id === id);

describe('the activity feed', () => {
  const { store, ids } = build();
  const { items, next } = activity(store);

  it('tells what runs did, in the mock\'s words, newest first', () => {
    expect(next).toBeNull();
    expect(items.map((i) => i.at)).toEqual([...items.map((i) => i.at)].sort((a, b) => b - a));
    expect(byId(items, `r:${ids.live}:start`)).toMatchObject({ kind: 'live', live: true, text: 'Recording started · python refund_agent.py', href: `#/run/${ids.live}`, ref: ids.live!.slice(0, 10) });
    expect(byId(items, `r:${ids.live}:end`), 'a recording still going has not finished').toBeUndefined();
    expect(byId(items, `r:${ids.rec}:start`)).toMatchObject({ kind: 'live', at: 1000, actor: 'dana@example.com' });
    expect(byId(items, `r:${ids.rec}:start`)!.live).toBeUndefined();
    expect(byId(items, `r:${ids.rec}:end`)).toMatchObject({ kind: 'rec', at: 2000, text: 'Recorded 3 calls · python refund_agent.py', actor: 'dana@example.com' });
    expect(byId(items, `r:${ids.clean}:end`)).toMatchObject({ kind: 'clean', text: 'Replay clean · 3/3 · 0 upstream' });
    expect(byId(items, `r:${ids.failAt}:end`)).toMatchObject({ kind: 'fork', text: 'Forked at #2 with --fail-at 2=529 · 1 live · 1 blocked · the agent failed' });
    expect(byId(items, `r:${ids.override}:end`)).toMatchObject({ kind: 'fork', text: 'Forked at #3 with --override 2 · 1 live' });
    expect(byId(items, `r:${ids.replayFailed}:end`)).toMatchObject({ kind: 'fail', text: 'Replay failed · 3/3 replayed' });
    expect(byId(items, `r:${ids.replayStopped}:end`)).toMatchObject({ kind: 'clean', text: 'Replay stopped · 3/3 replayed' });
    expect(byId(items, `r:${ids.replayEmpty}:end`)).toMatchObject({ kind: 'clean', text: 'Replay finished · no calls' });
  });

  it('bundles --repeat attempts into one entry, and leaves blame probes out', () => {
    expect(items.filter((i) => i.runId === ids.attempt1 || i.runId === ids.attempt2)).toEqual([]);
    expect(byId(items, 'g:g1')).toMatchObject({ kind: 'fork', at: 5200, text: 'replay --repeat 2 at #2 · 2 of 2 took the same path', runId: ids.rec, href: `#/run/${ids.rec}/2/forks` });
    expect(items.some((i) => i.runId === ids.probe)).toBe(false);
    expect(byId(items, `r:${ids.rec}:blame`)).toMatchObject({ kind: 'blame', at: 7100, text: 'Blamed model call #3 · confidence high', href: '#/fixes' });
  });

  it('tells imports once: a capture, a pack unpacked in one go, and an import a command already logged', () => {
    expect(byId(items, `r:${ids.capture}:import`)).toMatchObject({ kind: 'cap', at: 6000, text: 'Imported session.har · 2 model calls' });
    expect(byId(items, `r:${ids.packRoot}:import`)).toMatchObject({ kind: 'cap', at: 6500, text: 'Unpacked refund · 2 runs' });
    expect(items.some((i) => i.runId === ids.packChild)).toBe(false);
    expect(items.filter((i) => i.runId === ids.logged).map((i) => [i.text, i.actor])).toEqual([['Imported traffic.har · 12 model calls', 'jonas']]);
    expect(items.filter((i) => i.at === 6700).map((i) => i.text)).toEqual(['Imported proxy.jsonl · 4 model calls']);
  });

  it('tells test runs by their golden and checks', () => {
    expect(byId(items, `r:${ids.testPass}:end`)).toMatchObject({ kind: 'test', text: 'Test passed · refund-over-limit · 2 of 2 checks passed' });
    expect(byId(items, `r:${ids.testFail}:end`)).toMatchObject({ kind: 'fail', text: 'Test failed · refund-in-limit check failed: issue_refund called once' });
  });

  it('words stored events, with who did them and where they open', () => {
    expect(items[0]).toMatchObject({ kind: 'live', at: 9000 });
    expect(items.find((i) => i.text.startsWith('Normalizer added'))).toMatchObject({ kind: 'setting', text: 'Normalizer added · $.metadata.user_id', actor: 'maya@example.com', href: '#/settings/matching', ref: '$.metadata.user_id' });
    expect(items.find((i) => i.text.startsWith('Golden packed'))).toMatchObject({ kind: 'test', text: 'Golden packed · goldens/refund-flow', href: '#/tests', runId: ids.rec });
    expect(items.find((i) => i.at === 7700)).toMatchObject({ kind: 'setting', text: 'Widget frobbed · w-1' });
    describeEvent('widget.frobbed', (e) => ({ kind: 'train', text: `Frobbed ${e.ref}`, href: '#/training' }));
    expect(activity(store).items.find((i) => i.at === 7700)).toMatchObject({ kind: 'train', text: 'Frobbed w-1', href: '#/training' });
  });

  it('pages back in time without gaps or repeats, a full page at a time', () => {
    const seen: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 50; page++) {
      const p = activity(store, { limit: 3, ...(before !== undefined ? { before } : {}) });
      seen.push(...p.items.map((i) => i.id));
      if (p.next === null) break;
      expect(p.items).toHaveLength(3);
      before = p.next;
    }
    expect(seen).toEqual(items.map((i) => i.id));
    // A time instead of a cursor: everything older than it.
    const older = activity(store, { limit: 2, before: 7002 });
    expect(older.items.map((i) => i.id)).toEqual(items.filter((i) => i.at < 7002).slice(0, 2).map((i) => i.id));
    expect(older.items[0]).toMatchObject({ id: `r:${ids.testPass}:end`, at: 7001 });
    expect(activity(store, { limit: 2, before: '7002' }).items).toEqual(older.items);
    expect(() => activity(store, { before: 'not a cursor' })).toThrow(/cursor/);
  });
});

describe('paging through entries that share a millisecond', () => {
  it('splits them across pages without losing or repeating one', () => {
    const store = Store.open(':memory:');
    // A burst of 300 events in one millisecond (calibrate --write, a bulk command), three older ones,
    // and runs that start and end in that same millisecond.
    for (let i = 0; i < 300; i++) recordEvent(store, { kind: 'normalizer.added', ref: `$.f${i}`, at: 5000 });
    for (const at of [4000, 3000, 2000]) recordEvent(store, { kind: 'normalizer.added', ref: `older ${at}`, at });
    for (let i = 0; i < 3; i++) {
      const r = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '.' }, startedAt: 5000 });
      store.endRun(r.runId, 'completed', 5000);
    }
    const all = activity(store, { limit: 200 });
    expect(all.items).toHaveLength(200);
    const seen: string[] = [];
    let before: string | null = null;
    let pages = 0;
    do {
      const p = activity(store, { limit: 10, before });
      if (p.next !== null) expect(p.items).toHaveLength(10);
      seen.push(...p.items.map((i) => i.id));
      before = p.next;
      pages++;
    } while (before !== null && pages < 100);
    expect(seen).toHaveLength(309);
    expect(new Set(seen).size).toBe(309);
    expect(seen.slice(0, 200)).toEqual(all.items.map((i) => i.id));
    expect(seen.slice(-3).map((id) => id.startsWith('e:'))).toEqual([true, true, true]);
    // limit=1 is one entry, however many share its millisecond.
    expect(activity(store, { limit: 1 }).items).toHaveLength(1);
    store.close();
  });
});

describe('a pack unpacked', () => {
  const recording = (store: Store, startedAt: number, parentRunId?: string) => {
    const r = store.createRun({ mode: parentRunId ? 'replay' : 'record', ...(parentRunId ? { parentRunId } : {}), command: { argv: ['node', 'agent.js'], cwd: '.' }, startedAt });
    const id = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: createHash('sha256').update(r.runId).digest('hex'), occurrence: 1 };
    store.appendCallStart({ runId: r.runId, callNo: 1, ...id, origin: 'live', effect: null, requestRef: null, meta: {}, at: startedAt });
    store.appendCallEnd(id, { runId: r.runId, callNo: 1, attempt: 0, responseRef: null, outcome: 'ok', meta: {}, at: startedAt + 1 });
    store.endRun(r.runId, 'completed', startedAt + 10);
    return r.runId;
  };

  it('is one entry, through the real pack and unpack', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-activity-pack-'));
    const source = Store.open(':memory:');
    const target = Store.open(':memory:');
    try {
      const fork = recording(source, 2000, recording(source, 1000));
      packRun(source, fork, join(dir, 'lineage'), { lineage: true });
      expect(unpackRun(target, join(dir, 'lineage')).imported).toHaveLength(2);
      const entries = activity(target).items;
      expect(entries.map((i) => [i.kind, i.text])).toEqual([['cap', 'Unpacked lineage · 2 runs']]);
    } finally {
      source.close();
      target.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is one entry even when its runs were stamped moments apart, and a pack of the same name later is another', () => {
    const store = Store.open(':memory:');
    const imported = (runId: string, parentRunId: string | null, at: number) =>
      store.importRun({ runId, parentRunId, mode: parentRunId ? 'replay' : 'record', status: 'completed', divergence: null, command: { argv: ['node', 'agent.js'], cwd: '.' }, codeVersion: null, startedAt: 100, endedAt: 200, meta: { imported: { at, from: 'lineage' } } });
    // Unpacked by an older build: one time per run.
    imported('01K5CQ4P2R0000000000000001', null, 9001);
    imported('01K5CQ4P2R0000000000000002', '01K5CQ4P2R0000000000000001', 9002);
    imported('01K5CQ4P2R0000000000000003', '01K5CQ4P2R0000000000000002', 9004);
    // Another pack with the same folder name: unrelated runs, unpacked a second later.
    imported('01K5CQ4P2R0000000000000004', null, 10_004);
    expect(activity(store).items.map((i) => [i.at, i.text])).toEqual([
      [10_004, 'Unpacked lineage · 0 calls'],
      [9004, 'Unpacked lineage · 3 runs'],
    ]);
    store.close();
  });
});

describe('how a replay parted from its recording', () => {
  it('reads a value that changes on every run as a drift, an edit as a fork, and a fork by the flags it was made with', () => {
    const store = Store.open(':memory:');
    const rec = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '.' }, startedAt: 100 });
    store.endRun(rec.runId, 'completed', 200);
    const replay = (at: number, meta?: RunMeta) => {
      const r = store.createRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['node', 'agent.js'], cwd: '.' }, startedAt: at, ...(meta ? { meta } : {}) });
      store.endRun(r.runId, 'completed', at + 10);
      return r.runId;
    };
    const model = { kind: 'api' as const, name: 'POST /v1/messages', replayedBefore: 0 };
    const uuid = { path: '$.metadata.user_id', op: 'changed' as const, before: '1b4e28ba-2fa1-41d2-883f-0016d3cca427', after: '6fa459ea-ee8a-4ca4-894e-db77e160355e' };
    // Only a UUID changed: nobody forked this replay.
    const drifted = replay(300);
    store.setDivergence(drifted, { type: 'request_changed', callNo: 1, ...model, diff: [uuid] });
    // An edit next to a UUID: a fork.
    const edited = replay(400);
    store.setDivergence(edited, { type: 'request_changed', callNo: 1, ...model, diff: [uuid, { path: '$.system', op: 'changed', before: 'Refunds up to 500', after: 'Refunds up to 1000' }] });
    // A fork shadowlap replay stamped with its flags.
    const injected = replay(500, { fork: { flags: ['--inject 3', '--model 3:claude-opus-5'] } });
    store.setDivergence(injected, { type: 'request_changed', callNo: 3, ...model, diff: [{ path: '$.messages[4]', op: 'added', after: { role: 'user', content: 'Prefer sources from 2026' } }] });
    // A test whose golden drifted.
    const test = replay(600, { test: { golden: 'goldens/refund-in-limit', session: 's1' } });
    store.setDivergence(test, { type: 'request_changed', callNo: 1, ...model, diff: [uuid] });
    // What a pack and a redaction rule leave behind.
    recordEvent(store, { kind: 'run.packed', runId: rec.runId, ref: 'share/refund', data: { runs: 1, calls: 30 }, at: 700 });
    recordEvent(store, { kind: 'redaction.added', ref: '<IBAN>', data: { pattern: '/DE89 3704 0044 0532 0130 00/', path: '$.messages', replace: '<IBAN>' }, at: 800 });

    const items = activity(store).items;
    expect(byId(items, `r:${drifted}:end`)).toMatchObject({ kind: 'fail', text: 'Replay diverged at #1 · a UUID' });
    expect(byId(items, `r:${edited}:end`)).toMatchObject({ kind: 'fork', text: 'Forked at #1 · 0 live' });
    expect(byId(items, `r:${injected}:end`)).toMatchObject({ kind: 'fork', text: 'Forked at #3 with --inject 3 --model 3:claude-opus-5 · 0 live' });
    expect(byId(items, `r:${test}:end`)).toMatchObject({ kind: 'fail', text: 'Test failed · refund-in-limit diverged at call 1, a UUID' });
    expect(items.find((i) => i.at === 700)).toMatchObject({ kind: 'project', text: 'Packed · share/refund · 30 calls' });
    expect(items.find((i) => i.at === 800)).toMatchObject({ kind: 'setting', text: 'Redaction rule added · <IBAN> at $.messages' });
    expect(JSON.stringify(items)).not.toContain('DE89');
    store.close();
  });
});

describe('a feed polled while things happen', () => {
  it('shows a recording as it starts and ends, and an event as it is recorded', () => {
    const store = Store.open(':memory:');
    const r = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '.' }, startedAt: 1000 });
    expect(activity(store).items.map((i) => [i.id, i.live])).toEqual([[`r:${r.runId}:start`, true]]);
    // Calls arriving change nothing the feed says, and it answers the same.
    const id = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: 'a'.repeat(64), occurrence: 1 };
    store.appendCallStart({ runId: r.runId, callNo: 1, ...id, origin: 'live', effect: null, requestRef: null, meta: {}, at: 1100 });
    store.appendCallEnd(id, { runId: r.runId, callNo: 1, attempt: 0, responseRef: null, outcome: 'ok', meta: {}, at: 1200 });
    expect(activity(store).items).toHaveLength(1);
    store.endRun(r.runId, 'completed', 2000);
    expect(activity(store).items.map((i) => [i.text, i.live])).toEqual([
      ['Recorded 1 call · node agent.js', undefined],
      ['Recording started · node agent.js', undefined],
    ]);
    recordEvent(store, { kind: 'normalizer.added', ref: '$.x', at: 3000 });
    expect(activity(store).items[0]).toMatchObject({ text: 'Normalizer added · $.x' });
    store.close();
  });
});

describe('runs from a pack someone else made', () => {
  it('cannot break the feed with meta it does not expect', () => {
    const store = Store.open(':memory:');
    const odd = (runId: string, meta: Record<string, unknown>) =>
      store.importRun({ runId, parentRunId: null, mode: 'record', status: 'completed', divergence: null, command: { argv: ['node', 'agent.js'], cwd: '.' }, codeVersion: null, startedAt: 100, endedAt: 200, meta: meta as RunMeta });
    odd('01K5CQ4P2R0000000000000011', { imported: { at: 'yesterday', from: 'odd' }, blame: { at: 'soon', outcome: 'stopped' } });
    odd('01K5CQ4P2R0000000000000012', { imported: { at: 300, from: 42 }, covers: ['api'], repeat: { group: { x: 1 }, attempt: 'one', of: 2 } });
    odd('01K5CQ4P2R0000000000000013', { blame: { at: 400, outcome: 'blamed', callNo: 3, confidence: 'high' }, fork: { flags: [7, '--inject 3'] } });
    const items = activity(store).items;
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) expect(Number.isFinite(i.at)).toBe(true);
    expect(items.find((i) => i.id === 'r:01K5CQ4P2R0000000000000011:blame')).toMatchObject({ at: 200, text: 'Blame stopped · 0 calls probed' });
    // Paging still works through them.
    const first = activity(store, { limit: 1 });
    expect(activity(store, { limit: 50, before: first.next }).items.length).toBe(items.length - 1);
    store.close();
  });
});
