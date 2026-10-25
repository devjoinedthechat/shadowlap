import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Store, type RunRecord, type RunSummary } from '@shadowlap/engine';
import { callDetail, runCallsPage, runDetail, type RunDetail } from '../src/api.js';
import { exportHtml, startDashboard } from '../src/index.js';
import { runCalls } from '../src/run-calls.js';
import { analyseRun } from '../src/run-page.js';
import { recordLoop } from './long-run.js';
import { addRun, DAY } from './read-model-store.js';

/**
 * A run's calls come a page at a time (contract 8): `GET /api/runs/:id` answers with the run and its
 * first page, `callsTotal` and `callsNext`; `GET /api/runs/:id/calls?from=&limit=` with each next
 * page. A long run that ended is answered from the calls its first page shows, with what the page
 * says of the whole run read in SQL, and says it is warming while the whole run is analysed beside
 * the server; asked again once it is, the same calls say the same, and the run the same of itself.
 */

const NOW = Date.UTC(2026, 9, 1, 12);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const callNos = (d: { calls: Array<{ callNo: number }> }) => d.calls.map((c) => c.callNo);

/** The costs to the ninth decimal: the first answer prices tokens summed per model, reading every call prices each. */
function rounded(s: RunSummary): RunSummary {
  const r = (n: number) => Math.round(n * 1e9) / 1e9;
  return { ...s, cost: { ...s.cost, spent: r(s.cost.spent), saved: r(s.cost.saved), captured: r(s.cost.captured) } };
}

/** What a run's page says of the run itself, page aside. */
const ofRun = (d: RunDetail) => ({ run: d.run, label: d.label, source: d.source, summary: rounded(d.summary), callsTotal: d.callsTotal, origins: d.origins, parent: d.parent, children: d.children, attempts: d.attempts, actions: d.actions, models: d.models, blame: d.blame, checks: d.checks, notRecorded: d.notRecorded, forkAt: d.forkAt, intervention: d.intervention, interventions: d.interventions, rescuedBy: d.rescuedBy, fix: d.fix, state: d.state, attemptPlace: d.attemptPlace });

function longRun(store: Store, calls: number, o: { parent?: RunRecord; liveFrom?: number } = {}): RunRecord {
  const run = store.createRun({ mode: o.parent ? 'replay' : 'record', ...(o.parent ? { parentRunId: o.parent.runId } : {}), command: { argv: ['node', 'agent.js'], cwd: '/work' }, startedAt: NOW - DAY });
  recordLoop(store, run, calls, o.liveFrom ? { liveFrom: o.liveFrom } : {});
  if (o.parent && o.liveFrom) store.setDivergence(run.runId, { type: 'request_changed', callNo: o.liveFrom, kind: 'api', name: 'POST /v1/messages', replayedBefore: o.liveFrom - 1 });
  return store.getRun(run.runId)!;
}

describe('a run a page at a time', () => {
  it('sends a short run whole: every call, and no next page', () => {
    const store = Store.open(':memory:');
    const id = addRun(store, { startedAt: NOW - DAY, calls: 'lrlrlrbsol' });
    const d = runDetail(store, id)!;
    expect(callNos(d)).toEqual(range(1, 10));
    expect(d).toMatchObject({ callsTotal: 10, callsNext: null });
    expect(d.origins).toBeUndefined();
    expect(d.warming).toBeUndefined();
    store.close();
  });

  it('answers a long run that ended from its first calls, says of the whole run what every call says, and pages the rest', () => {
    const store = Store.open(':memory:');
    const rec = longRun(store, 3001);
    const quick = runDetail(store, rec.runId)!;
    // Its first 200 calls, the facts of those read from its first 300, and every call's origin for the strip.
    expect(callNos(quick)).toEqual(range(1, 200));
    expect(quick).toMatchObject({ callsTotal: 3001, callsNext: 201, warming: { done: 300, total: 3001 } });
    expect(quick.origins).toBe('l'.repeat(3001));
    expect(quick.summary).toMatchObject({ total: 3001, byKind: { api: 1501, tool: 1500 } });

    // The next pages, the calls up to each read for it.
    const second = runCallsPage(store, rec.runId, { from: 201 })!;
    expect(callNos(second)).toEqual(range(201, 700));
    expect(second).toMatchObject({ runId: rec.runId, callsTotal: 3001, callsNext: 701, warming: { done: 800, total: 3001 } });
    const short = runCallsPage(store, rec.runId, { from: 1001, limit: 50 })!;
    expect(callNos(short)).toEqual(range(1001, 1050));
    // A page far into the run reads the calls around it: two hundred before it, and those after up to the run's end.
    const last = runCallsPage(store, rec.runId, { from: 2801, limit: 900 })!;
    expect(callNos(last)).toEqual(range(2801, 3001));
    expect(last).toMatchObject({ callsNext: null, around: { from: 2601, to: 3001 }, warming: { done: 401, total: 3001 } });
    const deep = runCallsPage(store, rec.runId, { from: 2001 })!;
    expect(callNos(deep)).toEqual(range(2001, 2500));
    expect(deep).toMatchObject({ callsNext: 2501, around: { from: 1801, to: 2600 } });
    // Each call's conversation is left unnumbered there: the run's conversations are counted from its first call.
    expect(deep.calls.every((c) => c.conversation === null && !c.conversationStart)).toBe(true);
    const deepCall = callDetail(store, rec.runId, 2002)!;
    expect(deepCall).toMatchObject({ around: { from: 1802, to: 2102 }, conversation: { fromCallNo: 2001, n: null } });
    // Asked for the whole analysis, the same calls with every fact.
    const unnumbered = (d: { calls: readonly object[] }) => d.calls.map((c) => ({ ...c, conversation: null, conversationStart: false }));
    const exact = runCallsPage(store, rec.runId, { from: 2001 }, {}, { whole: true })!;
    expect(exact.around).toBeUndefined();
    expect(exact.calls.every((c) => c.conversation === 1)).toBe(true);
    expect(unnumbered(deep)).toEqual(unnumbered(exact));
    expect({ ...deepCall, around: undefined, call: { ...deepCall.call, conversation: 1 }, conversation: { ...deepCall.conversation, n: 1 } }).toEqual({ ...callDetail(store, rec.runId, 2002, {}, { whole: true })!, around: undefined });

    // Once the whole run is read and analysed (beside the server, after the first answer): the same calls, the same run.
    analyseRun(store, rec, runCalls(store, rec.runId));
    const whole = runDetail(store, rec.runId)!;
    expect(whole.warming).toBeUndefined();
    expect(callNos(whole)).toEqual(range(1, 500));
    expect(whole.callsNext).toBe(501);
    expect(ofRun(quick)).toEqual(ofRun(whole));
    expect(quick.calls).toEqual(whole.calls.slice(0, 200));
    expect(second.calls).toEqual(runCallsPage(store, rec.runId, { from: 201 })!.calls);
    store.close();
  });

  it('says the same of a long fork, its flags and blame among it, first as after', () => {
    const store = Store.open(':memory:');
    const rec = longRun(store, 1500);
    const fork = longRun(store, 1500, { parent: rec, liveFrom: 1201 });
    store.updateRunMeta(fork.runId, { blame: { at: NOW, outcome: 'blamed', callNo: 1301, confidence: 'high', rescuedRunId: null, fields: {}, oracle: [], probes: [], spent: 0 } as never });
    const quick = runDetail(store, fork.runId)!;
    expect(quick.warming).toBeDefined();
    expect(quick.blame?.modelCall).toEqual({ k: 651, m: 750 });
    analyseRun(store, store.getRun(fork.runId)!, runCalls(store, fork.runId));
    const whole = runDetail(store, fork.runId)!;
    expect(ofRun(quick)).toEqual(ofRun(whole));
    store.close();
  });

  it('gives a page deep in a long fork the time its recording waited for each replayed call, reading only those calls of it', () => {
    const store = Store.open(':memory:');
    const rec = longRun(store, 2600);
    const fork = longRun(store, 2600, { parent: rec, liveFrom: 2401 });
    const reads: string[] = [];
    const spy = Object.create(store, { getCalls: { value: (runId: string, range?: { after?: number; limit?: number; only?: readonly number[] }) => (reads.push(`${runId === rec.runId ? 'parent' : 'fork'}:${range?.only ? `only ${range.only.length}` : range ? `after ${range.after}` : 'all'}`), store.getCalls(runId, range)) } }) as Store;
    const deep = runCallsPage(spy, fork.runId, { from: 2101 })!;
    expect(deep.around).toEqual({ from: 1901, to: 2600 });
    // The replayed calls the page and the calls around it hold, read of the recording one by one: not every call of it.
    expect(reads).toEqual(['fork:after 1900', 'parent:only 500']);
    expect(deep.calls.find((c) => c.callNo === 2101)).toMatchObject({ origin: 'replayed', recordedMs: 900 });
    expect(deep.calls.find((c) => c.callNo === 2102)).toMatchObject({ origin: 'replayed', recordedMs: 2 });
    expect(deep.calls.find((c) => c.callNo === 2401)).toMatchObject({ origin: 'live', recordedMs: null });
    const unnumbered = (d: { calls: readonly object[] }) => d.calls.map((c) => ({ ...c, conversation: null, conversationStart: false }));
    expect(unnumbered(deep)).toEqual(unnumbered(runCallsPage(store, fork.runId, { from: 2101 }, {}, { whole: true })!));
    store.close();
  });

  it('answers a recording it follows with the calls after those it has, a page at a time', () => {
    const store = Store.open(':memory:');
    const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '/work' }, startedAt: NOW - DAY });
    recordLoop(store, run, 1200, { end: false });
    const after = runDetail(store, run.runId, {}, { after: 600 })!;
    expect(callNos(after)).toEqual(range(601, 1100));
    expect(after).toMatchObject({ after: 600, callsTotal: 1200, callsNext: 1101 });
    // A recording is placed as its calls arrive: never answered from its first calls.
    expect(after.warming).toBeUndefined();
    store.close();
  });
});

describe('the pages over HTTP', () => {
  const store = Store.open(':memory:');
  const rec = longRun(store, 1201);
  let dash: Awaited<ReturnType<typeof startDashboard>> | null = null;
  const get = async (path: string) => {
    dash ??= await startDashboard({ store, dbPath: ':memory:' });
    const res = await fetch(`${dash.url}/api/${path}`, { headers: { 'x-shadowlap-token': dash.token } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> & { calls?: Array<{ callNo: number }> } };
  };
  afterAll(async () => {
    await dash?.close();
    store.close();
  });

  it('answers a run with its first page, and each next one from the call asked for', async () => {
    const first = await get(`runs/${rec.runId}`);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ callsTotal: 1201, callsNext: 201 });
    const next = await get(`runs/${rec.runId}/calls?from=${String(first.body.callsNext)}&limit=100`);
    expect(next.status).toBe(200);
    expect(callNos(next.body as never)).toEqual(range(201, 300));
    expect(next.body).toMatchObject({ runId: rec.runId, callsTotal: 1201, callsNext: 301 });
    // At most 500 at a time, whatever is asked.
    const big = await get(`runs/${rec.runId.slice(0, 12)}/calls?from=1&limit=5000`);
    expect(big.body.calls).toHaveLength(500);
  });

  it('refuses a page it can’t read, and says when the run isn’t there', async () => {
    expect((await get(`runs/${rec.runId}/calls?from=-1`)).status).toBe(400);
    expect((await get(`runs/${rec.runId}/calls?from=2&limit=lots`)).status).toBe(400);
    expect((await get(`runs/01ZZZZZZZZZZZZZZZZZZZZZZZZ/calls?from=1`)).status).toBe(404);
  });
});

describe('an exported copy', () => {
  it('holds every call of a long run: it has no server to ask for the next page', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-paging-export-'));
    const store = Store.open(join(dir, 'shadowlap.db'));
    try {
      const rec = longRun(store, 1201);
      const out = exportHtml({ store, runIds: [rec.runId], now: NOW });
      const data = JSON.parse(/<script type="application\/json" id="shadowlap-data">([\s\S]*?)<\/script>/.exec(out.html)![1].replace(/\\u003c/g, '<')) as { responses: Record<string, RunDetail> };
      const d = data.responses[`runs/${rec.runId}`];
      expect(d.calls).toHaveLength(1201);
      expect(d.callsNext).toBeNull();
      expect(d.warming).toBeUndefined();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
