import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { conversationRequestFor, Store, unpackRun } from '@shadowlap/engine';
import { callDetail, callDetailFrom } from '../src/api.js';
import { runCalls } from '../src/run-calls.js';
import { analyseRun } from '../src/run-page.js';
import { exportHtml } from '../src/static.js';
import { addRun, HOUR } from './read-model-store.js';

/**
 * A call's details are worked out from its whole run (conversations, the prompt cache), so reading
 * the run again for each call made an export take time with the square of the run's length: 2,000
 * calls took 18 s, 10,000 took 9 minutes. An export reads each run once, and the dashboard keeps a
 * run's calls while they stay the same.
 */

const GOLDEN = fileURLToPath(new URL('../../../testing/golden/reference-agent', import.meta.url));

let uiDir: string;
beforeAll(() => {
  uiDir = mkdtempSync(join(tmpdir(), 'sl-export-scale-ui-'));
  mkdirSync(join(uiDir, 'assets', 'fonts'), { recursive: true });
  writeFileSync(join(uiDir, 'assets', 'app.css'), '.app { color: red }\n');
  writeFileSync(join(uiDir, 'assets', 'app.js'), 'console.log(1);\n');
  writeFileSync(join(uiDir, 'assets', 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
});
afterAll(() => rmSync(uiDir, { recursive: true, force: true }));

/** How many times each run's calls were read from the store while `fn` ran. */
function readsOf(store: Store, fn: () => void): Map<string, number> {
  const spy = vi.spyOn(store, 'getCalls');
  try {
    fn();
    const reads = new Map<string, number>();
    for (const [runId] of spy.mock.calls) reads.set(runId, (reads.get(runId) ?? 0) + 1);
    return reads;
  } finally {
    spy.mockRestore();
  }
}

describe('exporting a long run', () => {
  it('reads the run’s calls once, not once per call', () => {
    const store = Store.open(':memory:');
    try {
      const runId = addRun(store, { startedAt: Date.now() - HOUR, calls: 'lo'.repeat(300) });
      let calls = 0;
      const reads = readsOf(store, () => {
        calls = exportHtml({ store, runIds: [runId], uiDir, now: 1 }).calls;
      });
      expect(calls).toBe(600);
      // The run page's answer and every call's: one read. Before, one more for each of the 600 calls.
      expect(reads.get(runId)).toBeLessThanOrEqual(2);
    } finally {
      store.close();
    }
  });

  it('gives each call the details the dashboard gives it, conversation and all', () => {
    const store = Store.open(':memory:');
    try {
      const runId = unpackRun(store, GOLDEN).imported[0];
      const run = store.getRun(runId)!;
      const calls = store.getCalls(runId);
      const analysis = analyseRun(store, run, calls);
      for (const c of calls) {
        // The conversation each call shows is the one the engine finds for it.
        expect(analysis.requestFor(c.callNo)?.callNo ?? null, `call ${c.callNo}`).toBe(conversationRequestFor(calls, analysis.conversations, c.callNo)?.callNo ?? null);
        expect(callDetailFrom(store, run, calls, analysis, c.callNo, {}, {})).toEqual(callDetail(store, runId, c.callNo));
      }
      expect(callDetailFrom(store, run, calls, analysis, 999)).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe('a run’s calls on the dashboard', () => {
  it('are read once while the run stays the same, and again when a call arrives', () => {
    const store = Store.open(':memory:');
    try {
      const runId = addRun(store, { startedAt: Date.now() - HOUR, status: 'running', calls: 'lolo' });
      const other = addRun(store, { startedAt: Date.now() - HOUR, status: 'running', calls: 'l' });
      let reads = readsOf(store, () => {
        for (let n = 1; n <= 4; n++) expect(callDetail(store, runId, n)?.call.callNo).toBe(n);
      });
      expect(reads.get(runId)).toBe(1);
      // Another run recording leaves this one's calls as they were.
      store.appendCallStart({ runId: other, callNo: 2, kind: 'tool', name: 'lookup', fingerprint: 'x', occurrence: 0, origin: 'live', effect: 'read', requestRef: null, meta: {}, at: Date.now() });
      reads = readsOf(store, () => void callDetail(store, runId, 2));
      expect(reads.get(runId)).toBeUndefined();
      // A call of its own arrives: read again, and the new call is there.
      store.appendCallStart({ runId, callNo: 5, kind: 'tool', name: 'lookup', fingerprint: 'y', occurrence: 0, origin: 'live', effect: 'read', requestRef: null, meta: {}, at: Date.now() });
      reads = readsOf(store, () => expect(callDetail(store, runId, 5)?.call.callNo).toBe(5));
      expect(reads.get(runId)).toBe(1);
      expect(runCalls(store, runId)).toHaveLength(5);
    } finally {
      store.close();
    }
  });
});
