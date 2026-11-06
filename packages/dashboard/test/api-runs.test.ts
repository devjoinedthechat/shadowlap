import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gateResult, Store } from '@shadowlap/engine';
import { ambiguousRunId, lineage, listRuns, noSuchRun, runDetail } from '../src/api.js';
import { exportHtml, type StaticPayload } from '../src/index.js';
import { recentRuns, type RunRow } from '../src/runs-list.js';
import { addRun, blameOf, DAY, HOUR } from './read-model-store.js';

/** `/api/runs`, the sidebar's Recent runs: attempts bundled under their run, every run with its kind and outcome. */

const NOW = Date.UTC(2026, 9, 1, 10, 15);
let store: Store;
let uiDir: string;
const id: Record<string, string> = {};

beforeAll(() => {
  store = Store.open(':memory:');
  id.rec = addRun(store, { startedAt: NOW - DAY, status: 'failed', calls: 'llllll' });
  id.rescued = addRun(store, { parent: id.rec, startedAt: NOW - 2 * HOUR, divergence: 3, calls: 'rrllll', meta: { probe: { of: id.rec, callNo: 3, passed: true }, repeat: { group: 'g-3', attempt: 1, of: 2 } } });
  id.probe = addRun(store, { parent: id.rec, startedAt: NOW - HOUR, divergence: 3, calls: 'rrllll', meta: { probe: { of: id.rec, callNo: 3, passed: false }, repeat: { group: 'g-3', attempt: 2, of: 2 } } });
  store.updateRunMeta(id.rec, { blame: blameOf(3, id.rescued, NOW - HOUR) });
  id.repeat = addRun(store, { parent: id.rec, startedAt: NOW - 30 * 60_000, status: 'failed', calls: 'rrrrrr', meta: { repeat: { group: 'r', attempt: 1, of: 1 } } });
  uiDir = mkdtempSync(join(tmpdir(), 'shadowlap-api-runs-ui-'));
  mkdirSync(join(uiDir, 'assets', 'fonts'), { recursive: true });
  writeFileSync(join(uiDir, 'assets', 'app.css'), '.app { color: red }\n');
  writeFileSync(join(uiDir, 'assets', 'app.js'), 'console.log(1);\n');
  writeFileSync(join(uiDir, 'assets', 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
});
afterAll(() => {
  store.close();
  rmSync(uiDir, { recursive: true, force: true });
});

describe('/api/runs', () => {
  it('lists runs, not attempts, each saying what it is, how it came out and what it bundles', () => {
    const runs = listRuns(store);
    expect(runs).toEqual(recentRuns(store));
    expect(runs.map((r) => [r.runId, r.depth, r.label])).toEqual([
      [id.rec, 0, 'recording'],
      [id.rescued, 1, 'fork @3'],
    ]);
    expect(runs[0]).toMatchObject({ kind: 'recording', outcome: { kind: 'lost', callNo: 3 }, failed: true, lostAt: 3, attempts: 2, origins: 'llllll' });
    expect(runs[1]).toMatchObject({ kind: 'fork', rescues: id.rec, attemptKind: null });
  });

  it('lists the attempts an exported copy holds, as the copy chose them', () => {
    const result = exportHtml({ store, runIds: [id.probe, id.rec], uiDir, now: NOW });
    const m = /<script type="application\/json" id="shadowlap-data">(.*?)<\/script>/s.exec(result.html)!;
    const data = JSON.parse(m[1].split('<\\/').join('</')) as StaticPayload;
    const listed = (data.responses['runs'] as { runs: RunRow[] }).runs;
    expect(listed.map((r) => [r.runId, r.depth, r.attemptKind])).toEqual([
      [id.rec, 0, null],
      [id.probe, 1, 'probe'],
    ]);
  });
});

describe('a run’s page and lineage', () => {
  it('call a replay that reproduced its failing recording a clean replay, as the run list does', () => {
    const local = Store.open(':memory:');
    try {
      const rec = addRun(local, { startedAt: NOW - DAY, status: 'failed', calls: 'llll' });
      const again = addRun(local, { parent: rec, startedAt: NOW - HOUR, status: 'failed', calls: 'rrrr' });
      expect(runDetail(local, again)).toMatchObject({ label: 'clean replay', parent: { runId: rec, label: 'recording' } });
      expect(runDetail(local, rec)!.children).toEqual([{ runId: again, label: 'clean replay', kind: 'clean', startedAt: NOW - HOUR }]);
      expect(lineage(local, again)!.map((n) => [n.runId, n.label])).toEqual([
        [rec, 'recording'],
        [again, 'clean replay'],
      ]);
      expect(listRuns(local).find((r) => r.runId === again)).toMatchObject({ label: 'clean replay', kind: 'clean' });
    } finally {
      local.close();
    }
  });

  it('gives each run of a family what its calls did and the test it belongs to, so Forks words a test from them', () => {
    const local = Store.open(':memory:');
    try {
      const rec = addRun(local, { startedAt: NOW - DAY, calls: 'llllll' });
      // Two attempts of one golden in a test session, forked live at #3; the same golden replayed once in another.
      const first = addRun(local, { parent: rec, startedAt: NOW - 3 * HOUR, divergence: 3, calls: 'rrllfb', meta: { test: { golden: 'goldens/refund', session: 'S1', attempt: 1, of: 'LATER' } } });
      const second = addRun(local, { parent: rec, startedAt: NOW - 2 * HOUR, divergence: 3, calls: 'rrllll', meta: { test: { golden: 'goldens/refund', session: 'S1', attempt: 2 } } });
      const once = addRun(local, { parent: rec, startedAt: NOW - HOUR, calls: 'rrrrrr', meta: { test: { golden: 'goldens/refund', session: 'S2' } } });
      expect(lineage(local, second)!.map((n) => [n.runId, n.origins, n.test])).toEqual([
        [rec, 'llllll', null],
        [first, 'rrllfb', { golden: 'goldens/refund', session: 'S1', attempt: 1, gate: null }],
        [second, 'rrllll', { golden: 'goldens/refund', session: 'S1', attempt: 2, gate: null }],
        [once, 'rrrrrr', { golden: 'goldens/refund', session: 'S2', attempt: null }],
      ]);
    } finally {
      local.close();
    }
  });

  it('gives a gated golden’s attempts in a session what its gate made of them, the rule apart, as Tests says it', () => {
    const local = Store.open(':memory:');
    try {
      const rec = addRun(local, { startedAt: NOW - DAY, calls: 'llllll' });
      const session = local.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], startedAt: NOW - 3 * HOUR }).sessionId;
      const runs = [1, 2, 3].map((k) => addRun(local, { parent: rec, startedAt: NOW - 3 * HOUR + k, divergence: 3, calls: 'rrllll', meta: { test: { golden: 'goldens/refund', session, attempt: k } } }));
      const gate = { kind: 'sprt' as const, good: 0.9, bad: 0.7, risk: 0.05, max: 3 };
      local.addTestResult({ sessionId: session, golden: 'goldens/refund', ok: false, failure: 'inconclusive', runId: runs[2], goldenRunId: rec, data: { verdict: 'inconclusive', gate: gateResult(gate, [true, false, true], { decision: 'inconclusive' }) } });
      const tests = lineage(local, runs[0])!.filter((n) => n.test).map((n) => n.test!.gate);
      expect(tests).toEqual([1, 2, 3].map(() => ({ verdict: 'inconclusive · 2 of 3 · rate 0.09 to 1.00 (95%)', rule: 'gate: tells 90%+ from 70%- at <= 5% risk, up to 3 attempts' })));
      // Never "passes at least": the verdict word, the tally and the bound.
      expect(JSON.stringify(tests)).not.toContain('at least');
    } finally {
      local.close();
    }
  });

  it('counts an attempt’s place among the attempts made with it, not the most its record says could be made', () => {
    const local = Store.open(':memory:');
    try {
      const rec = addRun(local, { startedAt: NOW - DAY, status: 'failed', calls: 'llllll' });
      // A gated verify stops when its gate decides: 3 attempts of the 80 it could have made.
      const verify = [1, 2, 3].map((k) => addRun(local, { parent: rec, startedAt: NOW - 3 * HOUR + k, divergence: 1, calls: 'llllll', meta: { verify: { role: 'target', passed: true }, repeat: { group: 'v1-rec', attempt: k, of: 80 } } }));
      // A probe settled early, its attempts started out of order: 4 of its 20.
      const probe = [2, 1, 4, 3].map((k) => addRun(local, { parent: rec, startedAt: NOW - 2 * HOUR + k, divergence: 3, calls: 'rrllll', meta: { probe: { of: rec, callNo: 3, passed: k !== 2 }, repeat: { group: 'b1-3', attempt: k, of: 20 } } }));
      expect(verify.map((r) => runDetail(local, r)!.attemptPlace)).toEqual([
        { k: 1, n: 3 },
        { k: 2, n: 3 },
        { k: 3, n: 3 },
      ]);
      expect(probe.map((r) => runDetail(local, r)!.attemptPlace)).toEqual([
        { k: 2, n: 4 },
        { k: 1, n: 4 },
        { k: 4, n: 4 },
        { k: 3, n: 4 },
      ]);
      // A run that is no attempt has no place; nor does one whose group names nothing.
      expect(runDetail(local, rec)!.attemptPlace).toBeNull();
      const odd = addRun(local, { parent: rec, startedAt: NOW - HOUR, calls: 'rrrrrr', meta: { repeat: { group: '', attempt: 1, of: 2 } } });
      expect(runDetail(local, odd)!.attemptPlace).toBeNull();
    } finally {
      local.close();
    }
  });

  it('places a golden’s test attempt among those its session made, the one its result shows among them', () => {
    const local = Store.open(':memory:');
    try {
      const rec = addRun(local, { startedAt: NOW - DAY, calls: 'llllll' });
      const session = local.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], startedAt: NOW - 3 * HOUR }).sessionId;
      const attempt = (k: number, of?: string) => addRun(local, { parent: rec, startedAt: NOW - 3 * HOUR + k, divergence: 3, calls: 'rrllll', meta: { test: { golden: 'goldens/refund', session, attempt: k, ...(of ? { of } : {}) } } });
      // The session's result shows its second attempt: the others are filed under it.
      const shown = attempt(2);
      const filed = [attempt(3, shown), attempt(1, shown)];
      expect(filed.map((r) => runDetail(local, r)!.attemptPlace)).toEqual([
        { k: 3, n: 3 },
        { k: 1, n: 3 },
      ]);
      // That one is the session's test replay, no attempt; one naming a run it can't be filed under (a pack can carry anything) has no place.
      expect(runDetail(local, shown)!.attemptPlace).toBeNull();
      expect(runDetail(local, attempt(4, rec))!.attemptPlace).toBeNull();
    } finally {
      local.close();
    }
  });

  it('counts the fork blame rescued a run with among its probe’s attempts, though it lists as a fork of its own', () => {
    expect(runDetail(store, id.rescued)!.attemptPlace).toEqual({ k: 1, n: 2 });
    expect(runDetail(store, id.probe)!.attemptPlace).toEqual({ k: 2, n: 2 });
    expect(runDetail(store, id.repeat)!.attemptPlace).toEqual({ k: 1, n: 1 });
  });

  it('tells a prefix of several runs’ ids from an id that names no run', () => {
    const local = Store.open(':memory:');
    try {
      const a = addRun(local, { startedAt: NOW - HOUR, calls: 'll' });
      const b = addRun(local, { startedAt: NOW - HOUR, calls: 'll' });
      let shared = 0;
      while (a[shared] === b[shared]) shared++;
      const prefix = a.slice(0, shared);
      expect(ambiguousRunId(local, prefix)).toBe(true);
      expect(noSuchRun(local, prefix)).toEqual({ status: 409, message: `run id prefix ${prefix} matches several runs: use more of the id` });
      expect(ambiguousRunId(local, a)).toBe(false);
      expect(ambiguousRunId(local, a.slice(0, shared + 1).toLowerCase())).toBe(false);
      expect(noSuchRun(local, '01ZZZZZZ')).toEqual({ status: 404, message: 'no run 01ZZZZZZ' });
    } finally {
      local.close();
    }
  });
});
