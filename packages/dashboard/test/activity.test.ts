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
    // Only a clean replay gets the icon the mock calls "Clean replay".
    expect(byId(items, `r:${ids.replayStopped}:end`)).toMatchObject({ kind: 'rec', text: 'Replay stopped · 3/3 replayed' });
    expect(byId(items, `r:${ids.replayEmpty}:end`)).toMatchObject({ kind: 'rec', text: 'Replay finished · no calls' });
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
    expect(items.filter((i) => i.at === 6700).map((i) => i.text)).toEqual(['Imported proxy.jsonl · 2 runs · 4 model calls']);
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
    // A fork that keeps the flags it was made with (`meta.interventions`, as a replay records them);
    // a command given after -- is not one of them.
    const kept = (list: unknown[]) => ({ interventions: list }) as unknown as RunMeta;
    const injected = replay(500, kept([{ kind: 'command', at: null, flag: '-- node agent-v2.js' }, { kind: 'inject', at: 3, flag: '--inject 3=Prefer sources from 2026' }, { kind: 'model', at: 3, flag: '--model 3:claude-opus-5' }]));
    store.setDivergence(injected, { type: 'request_changed', callNo: 3, ...model, diff: [{ path: '$.messages[4]', op: 'added', after: { role: 'user', content: 'Prefer sources from 2026' } }] });
    // A replay that kept an empty list changed no flag: a code change forked it.
    const changed = replay(510, kept([]));
    store.setDivergence(changed, { type: 'request_changed', callNo: 2, ...model, diff: [{ path: '$.system', op: 'changed', before: 'a', after: 'b' }] });
    // From before replays kept their flags: the forced divergence names the flag, without what follows it.
    const older = replay(520);
    store.setDivergence(older, { type: 'forced', callNo: 4, ...model, reason: 'forced live by --inject 4, a change the normalizers or --prompt-from hide from matching' });
    // A test whose golden drifted.
    const test = replay(600, { test: { golden: 'goldens/refund-in-limit', session: 's1' } });
    store.setDivergence(test, { type: 'request_changed', callNo: 1, ...model, diff: [uuid] });
    // What a pack and a redaction rule leave behind.
    recordEvent(store, { kind: 'run.packed', runId: rec.runId, ref: 'share/refund', data: { runs: 1, calls: 30 }, at: 700 });
    recordEvent(store, { kind: 'redaction.added', ref: '<IBAN>', data: { pattern: '/DE89 3704 0044 0532 0130 00/', path: '$.messages', replace: '<IBAN>' }, at: 800 });

    const items = activity(store).items;
    expect(byId(items, `r:${drifted}:end`)).toMatchObject({ kind: 'fail', text: 'Replay diverged at #1 · a UUID' });
    expect(byId(items, `r:${edited}:end`)).toMatchObject({ kind: 'fork', text: 'Forked at #1 · 0 live' });
    expect(byId(items, `r:${injected}:end`)).toMatchObject({ kind: 'fork', text: 'Forked at #3 with --inject 3=Prefer sources from 2026 --model 3:claude-opus-5 · 0 live' });
    expect(byId(items, `r:${changed}:end`)).toMatchObject({ kind: 'fork', text: 'Forked at #2 · 0 live' });
    expect(byId(items, `r:${older}:end`)).toMatchObject({ kind: 'fork', text: 'Forked at #4 with --inject 4 · 0 live' });
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
    odd('01K5CQ4P2R0000000000000013', { blame: { at: 400, outcome: 'blamed', callNo: 3, confidence: 'high' } });
    // A fork whose list of flags holds things that are not flags.
    store.importRun({ runId: '01K5CQ4P2R0000000000000014', parentRunId: '01K5CQ4P2R0000000000000013', mode: 'replay', status: 'completed', divergence: { type: 'request_changed', callNo: 2, kind: 'api', name: 'POST /v1/messages', replayedBefore: 1 }, command: { argv: ['node', 'agent.js'], cwd: '.' }, codeVersion: null, startedAt: 500, endedAt: 600, meta: { interventions: [7, null, { flag: 9 }, { kind: 'set', flag: ' ' }, { kind: 'inject', flag: '--inject 2=x' }] } as unknown as RunMeta });
    const items = activity(store).items;
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) expect(Number.isFinite(i.at)).toBe(true);
    expect(items.find((i) => i.id === 'r:01K5CQ4P2R0000000000000011:blame')).toMatchObject({ at: 200, text: 'Blame stopped · 0 calls probed' });
    expect(items.find((i) => i.id === 'r:01K5CQ4P2R0000000000000014:end')).toMatchObject({ kind: 'fork', text: 'Forked at #2 with --inject 2=x · 0 live' });
    // Paging still works through them.
    const first = activity(store, { limit: 1 });
    expect(activity(store, { limit: 50, before: first.next }).items.length).toBe(items.length - 1);
    store.close();
  });
});

describe('events as each feature records them', () => {
  /** A capture run of `models` model calls, as an import makes one. */
  const capture = (store: Store, from: string, at: number, models: number, author?: string) => {
    const r = store.createRun({ mode: 'record', command: { argv: ['<external>'], cwd: '.' }, startedAt: at - 50, meta: { imported: { at, from }, covers: ['api'], ...(author ? { author } : {}) } });
    for (let callNo = 1; callNo <= models; callNo++) {
      const id = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: createHash('sha256').update(`${r.runId}:${callNo}`).digest('hex'), occurrence: 1 };
      store.appendCallStart({ runId: r.runId, callNo, ...id, origin: 'live', effect: null, requestRef: null, meta: {}, at });
      store.appendCallEnd(id, { runId: r.runId, callNo, attempt: 0, responseRef: null, outcome: 'ok', meta: {}, at });
    }
    store.endRun(r.runId, 'completed', at - 10);
    return r.runId;
  };

  it('reads the fields the commands write, in the mock\'s words', () => {
    const store = Store.open(':memory:');
    const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '.' }, startedAt: 10 }).runId;
    store.endRun(run, 'failed', 20);
    // The team store: push, pull, share links.
    recordEvent(store, { kind: 'store.pushed', actor: 'dana@example.com', ref: 's3://northwind/agent', data: { pushed: 2, updated: 1, queued: 0, refused: 0, blobs: 10, bytes: 1234 }, at: 2000 });
    recordEvent(store, { kind: 'store.pushed', actor: 'dana@example.com', ref: 's3://northwind/agent', data: { pushed: 1, updated: 0, queued: 2, refused: 1, blobs: 1, bytes: 10 }, at: 2010 });
    recordEvent(store, { kind: 'store.pushed', actor: 'dana@example.com', ref: 's3://northwind/agent', data: { pushed: 1, updated: 0, refused: 0, queued: true }, at: 2020 });
    recordEvent(store, { kind: 'store.pulled', actor: 'maya@example.com', ref: 's3://northwind/agent', data: { pulled: 3, merged: 1, failed: 0, byAuthor: { 'dana@example.com': 3 } }, at: 2100 });
    recordEvent(store, { kind: 'run.shared', runId: run, ref: 'reports/01k5cq.html', data: { expiresAt: 9_999_999, redacted: true, runs: 2 }, at: 2300 });
    recordEvent(store, { kind: 'store.set', actor: 'dana@example.com', ref: 's3://northwind/agent', data: { provider: 's3', previous: null }, at: 2400 });
    recordEvent(store, { kind: 'store.set', actor: 'dana@example.com', ref: 's3://northwind/agent-runs', data: { provider: 's3', previous: 's3://northwind/agent' }, at: 2410 });
    recordEvent(store, { kind: 'store.checked', actor: 'dana@example.com', ref: 's3://northwind/agent-runs', data: { ok: true, versioning: 'on', objectLock: 'on', encryption: 'aws:kms' }, at: 2420 });
    recordEvent(store, { kind: 'store.checked', actor: 'maya@example.com', ref: 's3://northwind/agent-runs', data: { ok: true, versioning: 'suspended', objectLock: 'off', encryption: null }, at: 2430 });
    recordEvent(store, { kind: 'store.checked', actor: 'jonas@example.com', ref: 's3://northwind/agent-runs', data: { ok: false, versioning: 'unknown', objectLock: 'unknown', encryption: null }, at: 2440 });
    recordEvent(store, { kind: 'store.ci', actor: 'dana@example.com', ref: 's3://northwind/agent-runs', data: { push: false, previous: true }, at: 2450 });
    recordEvent(store, { kind: 'store.ci', actor: 'dana@example.com', data: { push: true, previous: false }, at: 2460 });
    // The fixes slice: blame, repair, verify, apply.
    recordEvent(store, { kind: 'blame.done', runId: run, ref: 'fx-double-email', data: { outcome: 'blamed', callNo: 9, confidence: 'high', title: 'confirmation email sent twice', opened: true }, at: 3000 });
    recordEvent(store, { kind: 'blame.done', ref: 'fx-refund-limit', data: { outcome: 'blamed', callNo: 5, confidence: 'high', title: null, opened: false }, at: 3010 });
    recordEvent(store, { kind: 'blame.done', ref: 'fx-budget', data: { outcome: 'stopped', callNo: null, confidence: 'low', title: 'refund over the limit', opened: false }, at: 3020 });
    recordEvent(store, { kind: 'blame.done', ref: 'fx-lost', data: { outcome: 'unrescuable', callNo: null, confidence: 'low', title: 'wrong ticket closed', opened: true }, at: 3030 });
    recordEvent(store, { kind: 'repair.accepted', ref: 'fx-refund-limit', data: { repairId: 'r-munzln2i', outcome: 'accepted', fixes: ['fx-refund-limit'], title: 'Escalate refunds above the policy limit', verifyId: 'v-1', counts: ['fx-refund-limit'], candidates: 2 }, at: 3100 });
    recordEvent(store, { kind: 'repair.empty', ref: 'fx-budget', data: { repairId: 'r-2', outcome: 'empty', fixes: ['fx-budget'], why: 'no candidate passed its replays', candidates: 3 }, at: 3110 });
    recordEvent(store, { kind: 'verify.rejected', ref: 'fx-refund-limit', data: { verifyId: 'v-370712a', fixes: ['fx-refund-limit'], counts: [], code: 'c91d0f4', reasons: ['good run 01K5CQ4N9A broken: 2 of 5 passed (refund issued twice)'] }, at: 3200 });
    recordEvent(store, { kind: 'verify.rejected', ref: 'fx-budget', data: { verifyId: 'v-2', fixes: ['fx-budget'], counts: [], code: 'c91d0f4', reasons: ['failing run 01K5CQ2E8M not fixed: 1 of 5 passed'] }, at: 3210 });
    recordEvent(store, { kind: 'fix.applied', ref: 'fx-refund-limit', data: { title: 'Escalate refunds above the policy limit', repairId: 'r-munzln2i', patch: 'applied', goldens: 1, tests: 'passed' }, at: 3300 });
    // The tests slice: a session, one cut short, a golden updated.
    recordEvent(store, { kind: 'test.session', actor: 'ci', ref: 'sess-1', data: { passed: 3, failed: 1, goldens: 4, revision: 'd2e8a1f', upstreamRequests: 0 }, at: 4000 });
    recordEvent(store, { kind: 'test.session', actor: 'ci', ref: 'sess-2', data: { passed: 1, failed: 0, goldens: 4, revision: 'd2e8a1f', upstreamRequests: 0, interrupted: true, notRun: 3 }, at: 4010 });
    recordEvent(store, { kind: 'golden.updated', runId: run, ref: 'goldens/refund-flow', data: { session: 'sess-3', previous: run, calls: 31, checks: 2, changes: [] }, at: 4100 });
    // The training slice.
    recordEvent(store, { kind: 'pairs.exported', ref: 'pairs.jsonl', data: { count: 4, format: 'dpo', minConfidence: 'high', leftOut: 0, redaction: 1, sources: [] }, at: 5000 });
    recordEvent(store, { kind: 'model.scored', ref: 'qwen3-8b', data: { model: 'qwen3-8b', baseUrl: 'http://gpu:8000/v1', via: 'tasks score', tasks: 12, attempts: 36, mean: 0.8333, spent: 0, session: 's' }, at: 5100 });
    // The projects slice, and init.
    recordEvent(store, { kind: 'project.added', ref: 'p-1', data: { path: '~/code/support-agent', name: 'support-agent', again: true }, at: 6000 });
    recordEvent(store, { kind: 'project.setup', ref: 'p-1', data: { stage: 'done', name: 'support-agent', skipped: true, golden: null }, at: 6010 });
    recordEvent(store, { kind: 'project.setup', ref: 'support-agent', data: { name: 'support-agent', config: 'created', languages: ['python'] }, at: 6020 });
    recordEvent(store, { kind: 'project.removed', ref: 'p-2', data: { path: '~/code/old-agent', name: 'old-agent' }, at: 6030 });
    // The settings slice.
    recordEvent(store, { kind: 'runs.cleaned', data: { runs: 12, blobs: 40, bytes: 1000, interrupted: 0, olderThanDays: 30, keep: null }, at: 7000 });
    recordEvent(store, { kind: 'clock.set', ref: 'exact', data: { clock: 'exact', was: 'auto' }, at: 7010 });

    const items = activity(store, { limit: 200 }).items;
    const at = (t: number) => items.find((i) => i.at === t);
    expect([2000, 2010, 2020, 2100].map((t) => at(t)?.text)).toEqual(['Pushed 3 runs to the store', 'Pushed 1 run to the store · 2 waiting · 1 refused', 'Pushed 1 run to the store', 'Pulled 3 runs from the store']);
    expect(at(2300)).toMatchObject({ kind: 'project', text: `Shared ${run.slice(0, 10)} as a link · with 1 more run · redacted`, href: `#/run/${run}` });
    expect([2400, 2410, 2420, 2430, 2440, 2450, 2460].map((t) => at(t)?.text)).toEqual(['Store set', 'Store changed', 'Store checked', 'Store checked · versioning off · no object lock', 'Store check failed', 'Push from CI off', 'Push from CI on']);
    expect(at(2410)).toMatchObject({ kind: 'setting', ref: 's3://northwind/agent-runs', actor: 'dana@example.com' });
    expect(at(2440)?.kind).toBe('fail');
    expect(at(3000)).toMatchObject({ kind: 'blame', text: 'Blamed · confirmation email sent twice, lost at model call #9', href: '#/fixes/fx-double-email/blame', runId: run });
    expect(at(3010)?.text).toBe('Blamed model call #5 · confidence high');
    expect(at(3020)?.text).toBe('Blame stopped · refund over the limit');
    expect(at(3030)?.text).toBe('Blamed · wrong ticket closed, no single call rescued the run');
    expect(at(3100)).toMatchObject({ kind: 'fixok', text: 'Repair accepted · Escalate refunds above the policy limit', href: '#/fixes/fx-refund-limit/repair' });
    expect(at(3110)).toMatchObject({ kind: 'fixbad', text: 'Repair found no fix · no candidate passed its replays' });
    expect(at(3200)).toMatchObject({ kind: 'fixbad', text: 'Verify rejected · breaks a good run', href: '#/fixes/fx-refund-limit/verify/v-370712a' });
    expect(at(3210)?.text).toBe('Verify rejected · failing run 01K5CQ2E8M not fixed: 1 of 5 passed');
    expect(at(3300)).toMatchObject({ kind: 'fixok', text: 'Patch applied · Escalate refunds above the policy limit', href: '#/fixes/fx-refund-limit' });
    expect(at(4000)).toMatchObject({ kind: 'fail', text: 'Tests ran · 3 passed, 1 failed', actor: 'ci' });
    expect(at(4010)).toMatchObject({ kind: 'fail', text: 'Tests stopped · 1 passed, 0 failed, 3 not run' });
    expect(at(4100)).toMatchObject({ kind: 'test', text: 'Golden updated · goldens/refund-flow re-recorded · 31 calls' });
    expect(at(5000)?.text).toBe('Exported 4 preference pairs');
    expect(at(5100)).toMatchObject({ kind: 'train', text: 'Scored qwen3-8b on 12 tasks · mean 0.83' });
    expect([6000, 6010, 6020, 6030].map((t) => at(t)?.text)).toEqual(['Project added back · ~/code/support-agent', 'Set up support-agent · skipped the rest', 'Inspected support-agent · wrote shadowlap.config.json', 'Removed from the dashboard · ~/code/old-agent']);
    expect(at(7000)).toMatchObject({ kind: 'setting', text: 'Cleaned up 12 old runs' });
    expect(at(7010)?.text).toBe('Clock set to exact');
    // A blame recorded with its fix stands in for the one the run tells by itself.
    store.updateRunMeta(run, { blame: { at: 3000, outcome: 'blamed', callNo: 9, confidence: 'high', rescuedRunId: null, fields: {}, oracle: [], probes: [], spent: 0 } });
    expect(activity(store, { limit: 200 }).items.filter((i) => i.kind === 'blame' && i.runId === run).map((i) => i.text)).toEqual(['Blamed · confirmation email sent twice, lost at model call #9']);
    store.close();
  });

  it('tells an import once, however many runs it made and events it recorded', () => {
    const store = Store.open(':memory:');
    // cli-imports: a LiteLLM log of three conversations, an event per run kept, moments apart.
    const conversations = [0, 1, 2].map((i) => capture(store, 'proxy.jsonl', 1000 + i * 40, 2 + i, 'jonas@example.com'));
    conversations.forEach((runId, i) => recordEvent(store, { kind: 'capture.imported', actor: 'jonas@example.com', runId, ref: 'proxy.jsonl', data: { format: 'litellm', from: 'proxy.jsonl', key: `conv-${i}`, modelCalls: 2 + i, toolCalls: 1 }, at: 1100 + i }));
    // The same file imported again a minute later, and another person's import at the same moment.
    const again = capture(store, 'proxy.jsonl', 61_000, 1, 'jonas@example.com');
    recordEvent(store, { kind: 'capture.imported', actor: 'jonas@example.com', runId: again, ref: 'proxy.jsonl', data: { format: 'litellm', from: 'proxy.jsonl', key: 'conv-0', modelCalls: 1, toolCalls: 0 }, at: 61_100 });
    const theirs = capture(store, 'proxy.jsonl', 1050, 1, 'maya@example.com');
    recordEvent(store, { kind: 'capture.imported', actor: 'maya@example.com', runId: theirs, ref: 'proxy.jsonl', data: { format: 'litellm', from: 'proxy.jsonl', key: 'conv-9', modelCalls: 1, toolCalls: 0 }, at: 1101 });
    // Without events (imported by a build that recorded none): two runs of one trace import, grouped the same way.
    const trace = [capture(store, '/home/dana/traces/trace.json', 30_000, 3, 'dana@example.com'), capture(store, '/home/dana/traces/trace.json', 30_020, 4, 'dana@example.com')];
    // Something else in between, so paging has to step over the import.
    recordEvent(store, { kind: 'normalizer.added', ref: '$.id', at: 1101 });

    const all = activity(store).items;
    expect(all.map((i) => [i.at, i.kind, i.text, i.actor])).toEqual([
      [61_100, 'cap', 'Imported proxy.jsonl · 1 model call', 'jonas@example.com'],
      [30_020, 'cap', 'Imported trace.json · 2 runs · 7 model calls', 'dana@example.com'],
      [1102, 'cap', 'Imported proxy.jsonl · 3 runs · 9 model calls', 'jonas@example.com'],
      // Two events in one millisecond: the one recorded last first.
      [1101, 'setting', 'Normalizer added · $.id', undefined],
      [1101, 'cap', 'Imported proxy.jsonl · 1 model call', 'maya@example.com'],
    ]);
    const grouped = all.find((i) => i.at === 1102)!;
    expect(grouped).toMatchObject({ runId: conversations[0], href: `#/run/${conversations[0]}` });
    expect(all.find((i) => i.at === 30_020)).toMatchObject({ runId: trace[0], href: `#/run/${trace[0]}` });
    // Page by page, the import is still one entry, and nothing is lost or repeated.
    const seen: string[] = [];
    let before: string | null = null;
    do {
      const p = activity(store, { limit: 1, before });
      seen.push(...p.items.map((i) => i.id));
      before = p.next;
    } while (before !== null && seen.length < 20);
    expect(seen).toEqual(all.map((i) => i.id));
    store.close();
  });
});
