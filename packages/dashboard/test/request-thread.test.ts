import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { recordBlame, Store } from '@shadowlap/engine';
import { blameReport, EXPECT } from '../../engine/test/fix-fixtures.js';
import { activity } from '../src/activity.js';
import { actionArgs, addNote, showRunJson } from '../src/api.js';
import { fixAttemptGroups } from '../src/attempt-groups.js';
import { forkDifferences } from '../src/fork-differences.js';
import { startDashboard, type Dashboard } from '../src/index.js';
import { addRun, DAY, HOUR } from './read-model-store.js';

/**
 * The server's own thread answers every request, so what reads every call of a run is worked out on
 * the threads beside it (read-pool.ts), each with a connection of its own: what a fork did
 * differently, a fix's attempts grouped, the activity feed and a run as JSON. What a run's page
 * offers asks SQL whether the run made a model call. A write that names one call (an action, a note,
 * Edit and fork) reads that call alone.
 */

const NOW = Date.now();
let dir: string;
let store: Store;
let dash: Dashboard;
const id: Record<string, string> = {};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sl-request-thread-'));
  const dbPath = join(dir, 'shadowlap.db');
  store = Store.open(dbPath);
  id.rec = addRun(store, { startedAt: NOW - DAY, calls: [{ code: 'l', request: { messages: [{ role: 'user', content: 'Refund order A-1131.' }] } }, { code: 'l', kind: 'tool' }, { code: 'l' }] });
  id.fork = addRun(store, { parent: id.rec, startedAt: NOW - HOUR, divergence: 3, calls: 'rrl' });
  // A blame of the recording whose probes' attempts were the fork.
  const report = blameReport(id.rec);
  for (const p of report.probes) p.attempts = p.attempts.map((a) => ({ ...a, runId: id.fork }));
  id.fix = recordBlame(store, { runId: id.rec, report, expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: NOW }).fix.fixId;
  // Actions on: no job here gets as far as running the CLI.
  dash = await startDashboard({ store, dbPath, port: 0, spawnCli: () => { throw new Error('no job runs the CLI in this test'); } });
});

afterAll(async () => {
  await dash.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = async (path: string) => {
  const res = await fetch(`${dash.url}/api/${path}`, { headers: { 'x-shadowlap-token': dash.token } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe('what the server’s own thread reads', () => {
  it('reads no run’s calls for the read models that read every one', async () => {
    const read = vi.spyOn(store, 'getCalls');
    try {
      const differences = await get(`runs/${id.fork}/differences`);
      const groups = await get(`fixes/${id.fix}/groups`);
      const feed = await get('activity?limit=20');
      const json = await get(`runs/${id.rec}/show`);
      const offers = await get(`runs/${id.rec}/offers`);
      for (const r of [differences, groups, feed, json, offers]) expect(r.status).toBe(200);
      // The search index reads calls here, a batch at a time between requests, as it writes them in:
      // none of a run's calls read whole.
      expect(read.mock.calls.filter(([, range]) => !range || (range.only === undefined && range.limit === undefined))).toEqual([]);
      read.mockRestore();
      // And they answer as the read models do, worked out here.
      expect(differences.body).toEqual(JSON.parse(JSON.stringify({ differences: forkDifferences(store, id.fork) })));
      expect(groups.body).toEqual(JSON.parse(JSON.stringify(fixAttemptGroups(store, id.fix))));
      expect(feed.body).toEqual(JSON.parse(JSON.stringify(activity(store, { limit: 20, before: null }))));
      expect(json.body).toEqual(JSON.parse(JSON.stringify(showRunJson(store, id.rec))));
      expect(offers.body).toMatchObject({ runId: id.rec });
    } finally {
      read.mockRestore();
    }
  });

  it('says a run or a fix isn’t there, as before', async () => {
    expect((await get('runs/01ZZZZZZZZZZZZZZZZZZZZZZZZ/differences')).status).toBe(404);
    expect((await get('fixes/fix_nothing/groups')).status).toBe(404);
    expect((await get('runs/01ZZZZZZZZZZZZZZZZZZZZZZZZ/show')).status).toBe(404);
  });

  it('reads the one call a write names, not the run’s every call', async () => {
    const read = vi.spyOn(store, 'getCalls');
    try {
      expect(actionArgs(store, id.rec, 2, 'no-such-action', undefined)).toHaveProperty('error');
      expect(actionArgs(store, id.rec, 9, 'no-such-action', undefined)).toEqual({ error: `no call #9 in run ${id.rec}` });
      expect(addNote(store, id.rec, 2, 'checked by hand')).toEqual({ notes: [expect.objectContaining({ callNo: 2, text: 'checked by hand' })] });
      expect(addNote(store, id.rec, 9, 'no such call')).toMatchObject({ status: 404 });
      // Edit and fork: the call it overrides read, then the upload it names found missing.
      const res = await fetch(`${dash.url}/api/jobs`, { method: 'POST', headers: { 'x-shadowlap-token': dash.token, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'override', runId: id.rec, callNo: 2, uploadId: 'up_missing' }) });
      expect(res.status, await res.clone().text()).toBe(400);
      expect(read.mock.calls.length).toBeGreaterThanOrEqual(5);
      for (const [, range] of read.mock.calls) expect(range).toMatchObject({ only: [expect.any(Number)] });
    } finally {
      read.mockRestore();
    }
  });
});
