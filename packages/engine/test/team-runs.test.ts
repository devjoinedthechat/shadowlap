import { describe, expect, it } from 'vitest';
import { abandonedRuns, Store, teamRunCounts, type RunMeta, type TeamRunRow } from '../src/index.js';

/**
 * The team store's counts, by run: attempts are filed under the run they came from, as the Runs
 * page, the Overview and the status bar file them, and never counted on their own.
 */

const KEY = 's3://northwind-agent-runs/support-agent';
const cmd = { argv: ['node', 'agent.js'], cwd: '/tmp' };
let clock = Date.parse('2026-10-01T09:00:00Z');

function run(store: Store, o: { parent?: string; meta?: RunMeta; running?: boolean } = {}): string {
  const r = store.createRun({ mode: o.parent ? 'replay' : 'record', parentRunId: o.parent ?? null, command: cmd, startedAt: (clock += 1000), ...(o.meta ? { meta: o.meta } : {}) });
  if (!o.running) store.endRun(r.runId, 'completed', clock + 500);
  return r.runId;
}

function listed(store: Store, runId: string, entry: Record<string, unknown> = {}): void {
  const row: TeamRunRow = { runId, state: 'pushed', at: clock, base: {}, baseHash: 'h', remoteHash: 'h', entry: { runId, ...entry } };
  store.setTeamRun(KEY, row);
}

describe('teamRunCounts', () => {
  it("files a run's attempts under it: one run only here, however many attempts it made", () => {
    const store = Store.open(':memory:');
    const rec = run(store);
    const attempts = [1, 2, 3].map((n) => run(store, { parent: rec, meta: { repeat: { group: 'g1', attempt: n, of: 3 } } }));
    expect(teamRunCounts(store, KEY)).toEqual({ inStore: 0, onlyLocal: 1, localRuns: [rec], localAttempts: 3, queued: 0, pushedHere: 0 });

    // The run went up alone (shadowlap push <run>): it is still only here, through its attempts.
    listed(store, rec);
    expect(teamRunCounts(store, KEY)).toMatchObject({ inStore: 1, onlyLocal: 1, localRuns: [rec], localAttempts: 3 });
    // With its attempts, nothing is left; the store still holds one run.
    for (const id of attempts) listed(store, id);
    expect(teamRunCounts(store, KEY)).toEqual({ inStore: 1, onlyLocal: 0, localRuns: [], localAttempts: 0, queued: 0, pushedHere: 1 });
    store.close();
  });

  it("counts blame's probes and verify's attempts as attempts, and the fork blame rescued a run with as a run", () => {
    const store = Store.open(':memory:');
    const failed = run(store);
    const probe = run(store, { parent: failed, meta: { probe: { of: failed, callNo: 3, passed: false } } as RunMeta });
    const rescued = run(store, { parent: failed, meta: { probe: { of: failed, callNo: 5, passed: true } } as RunMeta });
    store.updateRunMeta(failed, { blame: { rescuedRunId: rescued } } as unknown as RunMeta);
    const verify = run(store, { parent: failed, meta: { verify: { role: 'target', passed: true } } as RunMeta });
    const c = teamRunCounts(store, KEY);
    expect(c).toMatchObject({ onlyLocal: 2, localAttempts: 2 });
    expect(c.localRuns.sort()).toEqual([failed, rescued].sort());
    expect([probe, verify].some((id) => c.localRuns.includes(id))).toBe(false);
    store.close();
  });

  it('leaves out runs still recording and runs pulled from a pull request’s folder', () => {
    const store = Store.open(':memory:');
    run(store, { running: true });
    run(store, { meta: { imported: { at: clock, from: `${KEY}/pr/42`, pr: '42' } } as RunMeta });
    const mine = run(store);
    expect(teamRunCounts(store, KEY)).toMatchObject({ onlyLocal: 1, localRuns: [mine] });
    store.close();
  });

  it("counts runs in the store that aren't here by what their push said: an attempt stays under its run", () => {
    const store = Store.open(':memory:');
    const theirs = '01K5CQ4N7G0000000000000000';
    listed(store, theirs);
    for (const n of [1, 2]) listed(store, `01K5CQ4N7G00000000000000A${n}`, { attemptOf: theirs });
    // An attempt whose run the store doesn't list is listed like any run, as the Runs page lists it.
    listed(store, '01K5CQ4N7G00000000000000B1', { attemptOf: '01K5CQ4N7G00000000000000ZZ' });
    // An older push named no run: counted as a run.
    listed(store, '01K5CQ4N7G00000000000000C1');
    expect(teamRunCounts(store, KEY)).toMatchObject({ inStore: 3, onlyLocal: 0 });
    store.close();
  });

  it('counts runs queued while they record, and keeps each store apart', () => {
    const store = Store.open(':memory:');
    const live = run(store, { running: true });
    store.setTeamRun(KEY, { runId: live, state: 'queued', at: clock, base: null, baseHash: null, remoteHash: null, entry: null });
    const done = run(store);
    listed(store, done);
    expect(teamRunCounts(store, KEY)).toMatchObject({ inStore: 1, onlyLocal: 0, queued: 1 });
    expect(teamRunCounts(store, `${KEY}?endpoint=https://minio.internal:9000`)).toMatchObject({ inStore: 0, onlyLocal: 1, queued: 0 });
    store.close();
  });

  it('counts as still recording only a queued run that is, not one that ended or was deleted since', () => {
    const store = Store.open(':memory:');
    const queue = (runId: string) => store.setTeamRun(KEY, { runId, state: 'queued', at: clock, base: null, baseHash: null, remoteHash: null, entry: null });
    // An SDK run over shadowlap serve's sidecar: queued by push --all while it recorded, ended over the API since.
    const ended = run(store, { running: true });
    const gone = run(store, { running: true });
    const live = run(store, { running: true });
    for (const id of [ended, gone, live]) queue(id);
    store.endRun(ended, 'completed');
    store.endRun(gone, 'completed');
    store.deleteRun(gone);
    // The ended one goes with the next push: it is only here until then.
    expect(teamRunCounts(store, KEY)).toMatchObject({ queued: 1, onlyLocal: 1, localRuns: [ended] });
    expect(store.teamSummary(KEY)).toMatchObject({ queued: 1 });
    // A deleted run leaves no queued row behind.
    expect(store.teamRun(KEY, gone)).toBeNull();
    expect(store.teamRun(KEY, live)).toMatchObject({ state: 'queued' });
    store.close();
  });

  it('counts a recording whose recorder is gone, which a push ends and sends, but not one still recording', () => {
    const store = Store.open(':memory:');
    const now = Date.parse('2026-10-03T09:00:00Z');
    // Killed two days ago, before it ended: still marked running, with nothing recording it.
    store.importRun({ runId: '01K4ZZ0000000000000000LEFT', parentRunId: null, mode: 'record', status: 'running', divergence: null, command: cmd, codeVersion: null, startedAt: now - 2 * 86_400_000, endedAt: null });
    // This process records this one.
    run(store, { running: true });
    expect(abandonedRuns(store, now)).toEqual(new Set(['01K4ZZ0000000000000000LEFT']));
    expect(teamRunCounts(store, KEY, 500, abandonedRuns(store, now))).toMatchObject({ onlyLocal: 1, localRuns: ['01K4ZZ0000000000000000LEFT'] });
    store.close();
  });

  it('returns the newest runs only here first, as many as asked for, and counts them all', () => {
    const store = Store.open(':memory:');
    const ids = Array.from({ length: 6 }, () => run(store));
    const c = teamRunCounts(store, KEY, 2);
    expect(c.onlyLocal).toBe(6);
    expect(c.localRuns).toEqual([ids[5], ids[4]]);
    store.close();
  });
});
