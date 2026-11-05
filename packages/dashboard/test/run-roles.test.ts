import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, type RunMeta } from '@shadowlap/engine';
import { listRuns } from '../src/api.js';
import { exportHtml, type StaticPayload } from '../src/index.js';
import { nextStepOf } from '../src/next-step.js';
import { cachedRuns } from '../src/run-cache.js';
import { loadRunIndex } from '../src/run-index.js';
import { countRuns } from '../src/runs-list.js';
import { normalizeRuns } from '../ui/normalize.js';
import { isAttempt } from '../ui/runs.js';
import type { MetaView } from '../src/views.js';
import { addRun, blameOf, DAY, HOUR } from './read-model-store.js';

// Which runs are attempts is one rule (the engine's run-roles.ts): the server's counts, the cached
// runs the activity feed reads, an exported copy's status bar, the page's lists and a run's page all
// go by it. They used to disagree: the cached count took a golden's repeated test replay for a run and
// the fork blame rescued a run with for an attempt, and the run page offered Run blame on that replay.

const NOW = Date.UTC(2026, 9, 1, 10, 15);
const MIN = 60_000;
let store: Store;
let uiDir: string;
const id: Record<string, string> = {};
const failedCheck = [{ ok: false, label: 'issue_refund never called', detail: 'it was called 1 time' }];

beforeAll(() => {
  store = Store.open(':memory:');
  id.rec = addRun(store, { startedAt: NOW - DAY, status: 'failed', calls: 'llllll' });
  const at = (m: number) => NOW - 20 * HOUR + m * MIN;
  const marks = (group: string, more: RunMeta): RunMeta => ({ repeat: { group, attempt: 1, of: 2 }, ...more });
  id.rescued = addRun(store, { parent: id.rec, startedAt: at(1), divergence: 3, calls: 'rrllll', meta: marks('g-3', { probe: { of: id.rec, callNo: 3, passed: true } }) });
  id.probe = addRun(store, { parent: id.rec, startedAt: at(2), status: 'failed', divergence: 3, calls: 'rrllll', meta: marks('g-3', { probe: { of: id.rec, callNo: 3, passed: false }, checks: failedCheck }) });
  store.updateRunMeta(id.rec, { blame: blameOf(3, id.rescued, NOW - 19 * HOUR) });
  id.verify = addRun(store, { parent: id.rec, startedAt: at(3), status: 'failed', calls: 'rrrrrr', meta: marks('v-rec', { verify: { role: 'target', passed: false }, checks: failedCheck }) });
  id.repeat = addRun(store, { parent: id.rec, startedAt: at(4), status: 'failed', calls: 'rrrrrr', meta: marks('r', {}) });
  id.chaos = addRun(store, { parent: id.rec, startedAt: at(5), status: 'failed', divergence: 2, calls: 'rlllll', meta: { chaos: { preset: 'timeout', callNo: 2, session: 'cs-1', attempt: 1 } } });
  id.injection = addRun(store, { parent: id.rec, startedAt: at(6), status: 'failed', divergence: 2, calls: 'rolll', meta: marks('inj-1', { injection: { result: 'inj-1', role: 'attempt', read: 2, attempt: 1, of: 2 }, checks: failedCheck }) });
  id.task = addRun(store, { parent: id.rec, startedAt: at(7), status: 'failed', divergence: 4, calls: 'rrrlll', meta: marks('ts-1-refund', { task: { golden: 'goldens/refund', model: 'qwen3', takeover: 4, attempt: 1, of: 2, score: 0, session: 'ts-1' } }) });
  // A golden replayed twice in one session: the result it shows, and the attempt filed under it.
  id.head = addRun(store, { parent: id.rec, startedAt: at(8), status: 'failed', calls: 'rrrrrr', meta: { test: { golden: 'goldens/refund', session: 's1' }, checks: failedCheck } });
  id.again = addRun(store, { parent: id.rec, startedAt: at(9), status: 'failed', calls: 'rrrrrr', meta: { test: { golden: 'goldens/refund', session: 's1', attempt: 2, of: id.head }, checks: failedCheck } });
  id.again3 = addRun(store, { parent: id.rec, startedAt: at(9) + 1, calls: 'rrrrrr', meta: { test: { golden: 'goldens/refund', session: 's1', attempt: 3, of: id.head } } });
  id.fork = addRun(store, { parent: id.rec, startedAt: at(10), divergence: 5, calls: 'rrrrll' });
  uiDir = mkdtempSync(join(tmpdir(), 'shadowlap-run-roles-ui-'));
  mkdirSync(join(uiDir, 'assets', 'fonts'), { recursive: true });
  writeFileSync(join(uiDir, 'assets', 'app.css'), '.app { color: red }\n');
  writeFileSync(join(uiDir, 'assets', 'app.js'), 'console.log(1);\n');
  writeFileSync(join(uiDir, 'assets', 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
});
afterAll(() => {
  store.close();
  rmSync(uiDir, { recursive: true, force: true });
});

const ATTEMPTS = ['probe', 'verify', 'repeat', 'chaos', 'injection', 'task', 'again', 'again3'];
const bundled = () => new Set(loadRunIndex(store).runs.filter((r) => r.bundled).map((r) => r.runId));

describe('which runs are attempts, everywhere', () => {
  it('bundles every kind of attempt, and leaves the rescued fork and a golden’s result runs of their own', () => {
    expect(bundled()).toEqual(new Set(ATTEMPTS.map((k) => id[k])));
    expect(countRuns(store)).toEqual({ runs: 4, attempts: ATTEMPTS.length });
  });

  it('counts the cached runs the activity feed reads as the run index does', () => {
    expect(cachedRuns(store).attempts).toBe(countRuns(store).attempts);
  });

  it('counts an exported copy’s runs and attempts as the store does', () => {
    const result = exportHtml({ store, runIds: Object.values(id), uiDir, now: NOW });
    const m = /<script type="application\/json" id="shadowlap-data">(.*?)<\/script>/s.exec(result.html)!;
    const data = JSON.parse(m[1].split('<\\/').join('</')) as StaticPayload;
    expect((data.responses['meta'] as MetaView).counts).toEqual(countRuns(store));
  });

  it('leaves out of the page’s lists exactly the runs the server bundles', () => {
    const rows = normalizeRuns(listRuns(store, { includeAttempts: true }));
    expect(new Set(rows.filter((r) => isAttempt(r)).map((r) => r.runId))).toEqual(bundled());
  });

  it('reads every attempt against the run it came from on its page, never offering Run blame for it', () => {
    for (const k of ATTEMPTS) expect(nextStepOf(store, id[k], null), k).toMatchObject({ key: 'compare', parent: id.rec });
    // The golden's result itself failed: it is blamed like any failed run.
    expect(nextStepOf(store, id.head, null)?.key).toBe('blame');
    // The fork blame rescued the run with is a fork, compared with its parent.
    expect(nextStepOf(store, id.rescued, null)).toMatchObject({ key: 'compare', parent: id.rec });
  });
});
