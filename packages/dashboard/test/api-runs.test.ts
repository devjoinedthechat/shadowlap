import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { lineage, listRuns, runDetail } from '../src/api.js';
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
    const data = JSON.parse(m[1]!.split('<\\/').join('</')) as StaticPayload;
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
      expect(runDetail(local, rec)!.children).toEqual([{ runId: again, label: 'clean replay', startedAt: NOW - HOUR }]);
      expect(lineage(local, again)!.map((n) => [n.runId, n.label])).toEqual([
        [rec, 'recording'],
        [again, 'clean replay'],
      ]);
      expect(listRuns(local).find((r) => r.runId === again)).toMatchObject({ label: 'clean replay', kind: 'clean' });
    } finally {
      local.close();
    }
  });
});
