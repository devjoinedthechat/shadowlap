import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { startDashboard, type Dashboard } from '../src/index.js';

/**
 * Settings → Gates asks for a preview each time a figure changes, and the preview's CI figure
 * plans a session as `shadowlap test` does: about half a second the first time a gate against
 * history's figures are seen. It is worked out beside the server (tests-gate.ts `GATE_READS`), so
 * while cold previews come one after another, the status bar's poll of /api/meta keeps to its few
 * milliseconds of the server's thread and the thread's event loop is never held up as long as a
 * preview takes, as dashboard-budgets.test.ts holds the reads of every run to it.
 */

const TIMEOUT = 120_000;
/** How long the server's event loop may be held up at the 99th percentile meanwhile, as dashboard-budgets.test.ts allows. */
const HELD_P99_MS = 60;
/** What one poll of /api/meta may cost the server's thread (the median), as dashboard-budgets.test.ts allows. */
const META_MS = 10;
/** Gates against history, each with figures no preview has planned yet in this process. */
const COLD = ['baseline=history', 'baseline=history&drop=0.15', 'baseline=history&risk=0.01', 'baseline=history&window=5', 'baseline=history&drop=0.1&window=20'];

let dir: string;
let store: Store;
let d: Dashboard;

async function ask(path: string): Promise<{ status: number; ms: number; body: any }> {
  const t0 = performance.now();
  const res = await fetch(`${d.url}/api/${path}`, { headers: { 'x-shadowlap-token': d.token } });
  const text = await res.text();
  return { status: res.status, ms: performance.now() - t0, body: text ? JSON.parse(text) : null };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: readonly number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sl-gate-budget-'));
  const dbPath = join(dir, 'shadowlap.db');
  // A store with a file, whose pooled reads are worked out on threads beside the server.
  store = Store.open(dbPath);
  d = await startDashboard({ store, dbPath, port: 0 });
}, TIMEOUT);

afterAll(async () => {
  await d.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Gates’ preview of a gate against history, its figures never seen', () => {
  it('leaves the status bar’s poll a few milliseconds of the server’s thread, and never holds it up', async () => {
    // As a browser finds it: the threads started.
    expect((await ask('meta')).status).toBe(200);
    const metas: number[] = [];
    const costs: number[] = [];
    const previews: Array<{ status: number; ms: number; red: unknown }> = [];
    const held = monitorEventLoopDelay({ resolution: 5 });
    held.enable();
    let busy = true;
    const polls = (async () => {
      while (busy) {
        const before = performance.eventLoopUtilization();
        const m = await ask('meta');
        costs.push(performance.eventLoopUtilization(before).active);
        expect(m.status).toBe(200);
        metas.push(m.ms);
        await wait(20);
      }
    })();
    try {
      for (const query of COLD) {
        const p = await ask(`tests/gate?${query}&suiteRisk=0.05`);
        previews.push({ status: p.status, ms: p.ms, red: p.body?.ci?.red });
      }
    } finally {
      busy = false;
      await polls;
      held.disable();
    }
    const p99 = held.percentile(99) / 1e6;
    process.stdout.write(`${COLD.length} cold previews (${previews.map((p) => p.ms.toFixed(0)).join(', ')} ms): ${metas.length} polls of /api/meta, median ${median(metas).toFixed(1)} ms, each costing the server's thread ${median(costs).toFixed(1)} ms (median); its event loop held up ${p99.toFixed(0)} ms at the 99th percentile, ${(held.max / 1e6).toFixed(0)} ms at most\n`);
    // Each answered whole, its CI figure planned.
    for (const p of previews) expect(p).toMatchObject({ status: 200, red: expect.any(Number) });
    expect(metas.length).toBeGreaterThan(COLD.length);
    expect(median(costs), 'what a poll costs the server’s thread (median)').toBeLessThan(META_MS);
    expect(p99, 'the server’s event loop, 99th percentile').toBeLessThan(HELD_P99_MS);
  }, TIMEOUT);
});
