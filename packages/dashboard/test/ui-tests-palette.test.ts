import { describe, expect, it } from 'vitest';
import { gateResult, type SprtGate } from '../../engine/src/stats.js';
import { goldenHint } from '../ui/goldens.js';
import { keepTests, loadTests, onTestsChanged, testsPaletteCommands, type TestsPaletteApp } from '../ui/tests-palette.js';
import type { GateResultView, GoldenRow, TestsView } from '../ui/types.js';

/**
 * The palette's Tests group from any page, without a browser: the source answers with what it has,
 * loads the goldens when the palette opens, and says when they arrived so an open palette reads it
 * again; Update goldens goes to Tests with its dialog, through the app's guard.
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
  checkResults: [],
  injection: false,
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
  commands: { ci: '', pack: '', run: ['test', 'goldens/*'], updateAll: null },
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
      ['Actions', 'Update goldens', 'shadowlap test --update'],
      ['Tests', 'refund-flow', 'passed'],
      ['Tests', 'limit-two', 'failed'],
    ]);
    // Update goldens opens what starts a job: offline, the palette shows it paused.
    expect(entries.map((e) => e.job === true)).toEqual([true, false, false]);
    // The same answer again changes nothing an open palette shows.
    await loadTests(s.client);
    expect(changed).toBe(1);
    // Update goldens asks Tests for its dialog by the address, through the guard; a golden opens Tests.
    entries[0].run();
    entries[2].run();
    expect(s.went).toEqual(['#/tests?update', '#/tests']);
    expect(s.guarded).toEqual(['guard']);
    off();
  });

  it('leaves out Update goldens where actions can\'t run or the server doesn\'t update goldens', () => {
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
      ['refund-flow', 'passed'],
      ['limit-two', 'passed'],
    ]);
    off();
  });

  // The hints said passing and failing, words no other page uses for a verdict.
  it('says each golden’s verdict in the words Tests uses, a gate’s with its tally and bound', () => {
    expect(goldenHint(row('refund-flow', 'pass'))).toBe('passed');
    expect(goldenHint(row('limit-two', 'fail'))).toBe('failed');
    expect(goldenHint(row('new-one', null))).toBe('not run yet');
    expect(goldenHint({ ...row('broken', null), error: 'not a pack' })).toBe('can’t be read');
    const gate: SprtGate = { kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 40 };
    const gated = (outcomes: boolean[], verdict: 'passed' | 'failed' | 'inconclusive', decision?: 'inconclusive'): GoldenRow => {
      const g = gateResult(gate, outcomes, decision ? { decision } : {});
      const view: GateResultView = { ...g, tally: '', perAttempt: null, more: null };
      return { ...row('refund-over-limit', verdict === 'passed' ? 'pass' : 'fail'), last: { ...row('refund-over-limit', null).last, result: verdict === 'passed' ? 'pass' : 'fail', verdict, gate: view } };
    };
    expect(goldenHint(gated(Array(12).fill(true), 'passed'))).toMatch(/^passed · 12 of 12 · rate >= 0\.\d+ \(95%\)$/);
    expect(goldenHint(gated([false, false, false], 'failed'))).toMatch(/^failed · 0 of 3 · rate <= 0\.\d+ \(95%\)$/);
    expect(goldenHint(gated([true, false, true, true, false, true], 'inconclusive', 'inconclusive'))).toMatch(/^inconclusive · 4 of 6 · rate 0\.\d+ to 0\.\d+ \(95%\)$/);
    // Never the old words.
    for (const r of [row('a', 'pass'), row('b', 'fail')]) expect(goldenHint(r)).not.toMatch(/passing|failing/);
  });

  it('lists nothing in an exported copy, and loads nothing there', () => {
    const s = stand({ answer: view(['goldens/limit-two']), exported: true });
    expect(testsPaletteCommands(s.app, s.go, { update: true })).toEqual([]);
    expect(s.loads()).toBe(0);
  });
});
