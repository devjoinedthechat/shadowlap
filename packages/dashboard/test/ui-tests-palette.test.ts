import { describe, expect, it } from 'vitest';
import { keepTests, loadTests, onTestsChanged, testsPaletteCommands, type TestsPaletteApp } from '../ui/tests-palette.js';
import type { GoldenRow, TestsView } from '../ui/types.js';

/**
 * The palette's Tests group from any page, without a browser: the source answers with what it has,
 * loads the goldens when the palette opens, and says when they arrived so an open palette reads it
 * again; Update goldens… goes to Tests with its dialog, through the app's guard.
 */
const row = (name: string, result: 'pass' | 'fail' | null): GoldenRow => ({
  path: `goldens/${name}`,
  name,
  source: { kind: 'pack', packedAt: null },
  mode: 'replay',
  modeLabel: 'replay',
  modeHint: '',
  gate: null,
  checks: [],
  history: [],
  last: { result, verdict: result === 'fail' ? 'failed' : result === 'pass' ? 'passed' : null, failure: result === 'fail' ? 'diverged' : null, line: '', at: null, updated: false, gate: null },
  runId: null,
  error: null,
});

const view = (diverged: string[], rows = [row('refund-flow', 'pass'), row('limit-two', 'fail')]): TestsView => ({
  empty: false,
  goldens: rows.length,
  verdict: null,
  revisions: [],
  rows,
  divergences: [],
  inconclusive: [],
  running: null,
  chaosRunning: null,
  failures: [],
  diverged,
  commands: { ci: '', inCi: '', pack: '', run: ['test', 'goldens/*'], updateAll: null },
  note: '',
});

function stand(o: { answer: TestsView; exported?: boolean; actionsOff?: string | null }) {
  const went: string[] = [];
  const guarded: string[] = [];
  let loads = 0;
  const client = { exported: !!o.exported, tests: () => (loads++, Promise.resolve(o.answer)) };
  const app: TestsPaletteApp = {
    exported: !!o.exported,
    client,
    actionsOff: o.actionsOff ?? null,
    guard: (fn) => {
      guarded.push('guard');
      fn();
    },
  };
  return { app, go: (to: string) => went.push(to), went, guarded, loads: () => loads, client };
}

describe('the palette\'s Tests group', () => {
  it('fills in once the goldens load, from a page other than Tests', async () => {
    const s = stand({ answer: view(['goldens/limit-two']) });
    let changed = 0;
    const off = onTestsChanged(() => changed++);
    // A fresh load of another page: nothing known yet, so the source answers with nothing and loads.
    expect(testsPaletteCommands(s.app, s.go, { update: true })).toEqual([]);
    expect(s.loads()).toBe(1);
    await loadTests(s.client);
    expect(changed).toBe(1);
    const entries = testsPaletteCommands(s.app, s.go, { update: true });
    expect(entries.map((e) => [e.group, e.label, e.hint])).toEqual([
      ['Actions', 'Update goldens…', 'shadowlap test --update'],
      ['Tests', 'refund-flow', 'passing'],
      ['Tests', 'limit-two', 'failing'],
    ]);
    // The same answer again changes nothing an open palette shows.
    await loadTests(s.client);
    expect(changed).toBe(1);
    // Update goldens… asks Tests for its dialog by the address, through the guard; a golden opens Tests.
    entries[0]!.run();
    entries[2]!.run();
    expect(s.went).toEqual(['#/tests?update', '#/tests']);
    expect(s.guarded).toEqual(['guard']);
    off();
  });

  it('leaves out Update goldens… where actions can\'t run or the server doesn\'t update goldens', () => {
    keepTests(view(['goldens/limit-two']));
    const readOnly = stand({ answer: view(['goldens/limit-two']), actionsOff: 'this dashboard is read-only' });
    expect(testsPaletteCommands(readOnly.app, readOnly.go, { update: true }).map((e) => e.label)).toEqual(['refund-flow', 'limit-two']);
    const noJob = stand({ answer: view(['goldens/limit-two']) });
    expect(testsPaletteCommands(noJob.app, noJob.go, { update: false }).map((e) => e.label)).toEqual(['refund-flow', 'limit-two']);
    // Nothing diverged any more: the goldens alone, and the palette is told.
    let changed = 0;
    const off = onTestsChanged(() => changed++);
    keepTests(view([], [row('refund-flow', 'pass'), row('limit-two', 'pass')]));
    expect(changed).toBe(1);
    const s = stand({ answer: view([]) });
    expect(testsPaletteCommands(s.app, s.go, { update: true }).map((e) => [e.label, e.hint])).toEqual([
      ['refund-flow', 'passing'],
      ['limit-two', 'passing'],
    ]);
    off();
  });

  it('lists nothing in an exported copy, and loads nothing there', () => {
    const s = stand({ answer: view(['goldens/limit-two']), exported: true });
    expect(testsPaletteCommands(s.app, s.go, { update: true })).toEqual([]);
    expect(s.loads()).toBe(0);
  });
});
