import { describe, expect, it } from 'vitest';
import { recordEvent, Store, type CallKind, type CreateRunInput, type Origin, type RunMeta } from '@shadowlap/engine';
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

  it('pages back in time without gaps or repeats, never splitting entries that share a time', () => {
    const seen: string[] = [];
    let before: number | undefined;
    for (let page = 0; page < 50; page++) {
      const p = activity(store, { limit: 3, ...(before !== undefined ? { before } : {}) });
      seen.push(...p.items.map((i) => i.id));
      if (p.next === null) break;
      expect(p.items.every((i) => i.at >= p.next!)).toBe(true);
      before = p.next;
    }
    expect(seen).toEqual(items.map((i) => i.id));
    // The two test runs ended 1 ms apart; two entries at the same time stay on one page.
    recordEvent(store, { kind: 'normalizer.added', ref: 'a', at: 7002 });
    const tied = activity(store, { limit: 1, before: 7003 });
    expect(tied.items.map((i) => i.at)).toEqual([7002, 7002]);
    expect(tied.next).toBe(7002);
  });
});
