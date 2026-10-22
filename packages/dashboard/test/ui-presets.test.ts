import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { testsView, type GoldenSource } from '../src/tests.js';
import type { Client, TestsView } from '../ui/api.js';
import { testsPalette } from '../ui/goldens.js';
import { TestsPage } from '../ui/pages/Tests.js';
import { bannerFor, type BannerInput } from '../ui/run/banner.js';
import { exitWords, presetAttempt, presetTag, presetWhy } from '../ui/run/preset.js';
import { RunHeader } from '../ui/run/RunHeader.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { ChaosMatrix, RunDetail } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * An error-path preset's attempt is a fork whose failure Shadowlap injected, so its run alone reads
 * as a healthy fork: its page takes the preset and its verdict from its recording's presets
 * (`/api/chaos/runs/:id`), for its banner, its status chip and its exit. Tests says how a golden's
 * presets came out, and never calls a golden whose presets ran "not run yet".
 */

const REC = '01M5GRZVBY8R1P6XETDBV1Z6N0';
const ATTEMPT = '01M5GRZVY1P4DYJZVXZ6F0KEMM';
const PASSED = '01M5GRZW2G2G43STN6FXX48NAN';

const matrix: ChaosMatrix = {
  runId: REC,
  golden: 'goldens/list-inbox',
  at: 1,
  counts: { passed: 1, failed: 1, inconclusive: 0, notApplicable: 0 },
  cells: [
    { preset: 'timeout', label: 'tool timeout', verdict: 'failed', callNo: 2, target: { kind: 'tool', name: 'list_inbox' }, passes: 0, attempts: 1, detail: 'list_inbox (#2) timed out: the agent exited with code 1 (TimeoutError: list_inbox timed out)', reason: 'the agent exited with code 1 (TimeoutError: list_inbox timed out)', runs: [{ runId: ATTEMPT, verdict: 'failed', passed: false, exitCode: 1 }], gate: null, at: 1, sessionId: 'S' },
    { preset: 'empty', label: 'empty result', verdict: 'passed', callNo: 2, target: { kind: 'tool', name: 'list_inbox' }, passes: 1, attempts: 1, detail: 'list_inbox (#2) answered with nothing: the agent exited 0', reason: null, runs: [{ runId: PASSED, verdict: 'passed', passed: true, exitCode: 0 }], gate: null, at: 1, sessionId: 'S' },
  ],
};

describe('a preset’s attempt', () => {
  it('is found among its recording’s presets, in the preset’s words', () => {
    const p = presetAttempt(matrix, ATTEMPT)!;
    expect(p).toEqual({ label: 'tool timeout', golden: 'goldens/list-inbox', callNo: 2, target: 'list_inbox', verdict: 'failed', outcome: 'the agent exited with code 1 (TimeoutError: list_inbox timed out)', exitCode: 1 });
    expect(presetWhy(p)).toBe('tool timeout preset · failed: the agent exited with code 1 (TimeoutError: list_inbox timed out) · on goldens/list-inbox');
    expect(presetTag(p)).toEqual({ cls: 'fail', text: 'failed' });
    expect(exitWords('failed', p)).toBe('exited 1');
    expect(presetWhy(presetAttempt(matrix, PASSED)!)).toBe('empty result preset · passed: the agent exited 0 · on goldens/list-inbox');
    // One that passed keeps its kind's chip; a run no preset made has none.
    expect(presetTag(presetAttempt(matrix, PASSED))).toBeNull();
    expect(presetAttempt(matrix, REC)).toBeNull();
    expect(presetAttempt(null, ATTEMPT)).toBeNull();
    // A fork that exited with an error, its code unknown: said without one.
    expect(exitWords('failed', null)).toBe('exited with an error');
    expect(exitWords('completed', null)).toBeNull();
  });

  it('leads its banner with the preset and its verdict, before the fork it is', () => {
    const input: BannerInput = {
      status: 'failed',
      type: 'fork',
      divergence: { callNo: 2, type: 'forced', name: 'list_inbox', replayedBefore: 1, reason: 'forced by --fail-at 2=timeout' },
      intervention: { flag: '--fail-at', value: '2=timeout', callNo: 2 },
      rescued: null,
      blame: null,
      notRecorded: null,
      checks: [],
      fix: null,
      upstreamRequests: 0,
      outcome: { kind: 'none' },
      failed: false,
    };
    // Without the preset: a healthy fork, which is what the page said.
    expect(bannerFor(input)!.kind).toBe('fork');
    expect(bannerFor({ ...input, preset: presetAttempt(matrix, ATTEMPT) })).toEqual({ kind: 'preset', callNo: 2, name: 'list_inbox', verdict: 'failed', why: 'tool timeout preset · failed: the agent exited with code 1 (TimeoutError: list_inbox timed out) · on goldens/list-inbox', golden: 'goldens/list-inbox' });
  });

  it('gives its header the preset’s status chip, and its exit in the meta line', () => {
    const run = {
      run: { runId: ATTEMPT, parentRunId: REC, mode: 'replay', status: 'failed', divergence: { type: 'forced', callNo: 2, kind: 'tool', name: 'list_inbox', replayedBefore: 1 }, command: { argv: ['node', 'inbox.mjs'], cwd: '/w' }, codeVersion: null, startedAt: 1, endedAt: 2, meta: { chaos: { preset: 'timeout', callNo: 2, session: 'S', attempt: 1, golden: 'goldens/list-inbox' } } },
      label: 'fork @2',
      about: { text: 'tool timeout #2', from: 'change', change: null },
      source: null,
      summary: { cost: { spent: 0, saved: 0, captured: 0 }, imported: false, durationMs: 100, upstreamRequests: 0, byKind: { api: 1, tool: 1, clock: 0, random: 0 } },
      calls: [],
      parent: { runId: REC, label: 'recording' },
      children: [],
      actions: [],
      fix: null,
      state: { status: 'failed', endedAt: 2, kind: 'fork', outcome: { kind: 'none' }, failed: false, interrupted: false, label: 'fork @2' },
    } as unknown as RunDetail;
    const app = { client: {}, exported: false, meta: null, runs: [], actionsOff: null, hasKind: () => true, guard: (fn: () => void) => fn(), watchJob: () => undefined, toast: () => undefined, refresh: () => undefined, registerLayer: () => () => undefined, jobs: [], live: [], feeds: {}, tick: 0, runsTick: 0 } as unknown as AppState;
    const header = (preset: ReturnType<typeof presetAttempt>) =>
      renderToStaticMarkup(createElement(AppContext.Provider, { value: app }, createElement(RunHeader, { run, call: null, selected: 2, rescued: false, offers: null, forkMenu: { open: false, anchor: null, toggle: () => undefined, close: () => undefined } as never, onAction: () => undefined, onFindCommit: () => undefined, preset })));
    const failed = header(presetAttempt(matrix, ATTEMPT));
    expect(failed).toContain('<span class="tag fail">failed</span>');
    expect(failed).toContain('<span class="bad">exited 1</span>');
    // Before the presets are read: the fork's own chip, and that it exited with an error, plainly.
    const plain = header(null);
    expect(plain).toContain('<span class="tag fork">fork @2</span>');
    expect(plain).toContain('<span>exited with an error</span>');
  });
});

describe('a golden’s presets on Tests', () => {
  let r: Rendered | null = null;
  afterEach(async () => {
    await r?.unmount();
    r = null;
    delete (globalThis as { location?: unknown }).location;
  });

  function view(): TestsView {
    const store = Store.open(':memory:');
    try {
      const rec = store.createRun({ mode: 'record', command: { argv: ['node', 'inbox.mjs'], cwd: '.' }, startedAt: 1 }).runId;
      store.endRun(rec, 'completed', 2);
      const attempt = store.createRun({ mode: 'replay', parentRunId: rec, command: { argv: ['node', 'inbox.mjs'], cwd: '.' }, startedAt: 3, meta: { chaos: { preset: 'timeout', callNo: 2, session: 'S', attempt: 1, golden: 'goldens/list-inbox' } } }).runId;
      store.endRun(attempt, 'failed', 4);
      store.startChaosSession({ sessionId: 'S', startedAt: 3, command: ['shadowlap', 'test', 'goldens/list-inbox', '--chaos'], presets: ['timeout', 'empty'] });
      store.addChaosResult({ sessionId: 'S', runId: rec, golden: 'goldens/list-inbox', preset: 'timeout', verdict: 'failed', callNo: 2, passes: 0, attempts: 1, at: 5, data: { detail: 'list_inbox (#2) timed out: the agent exited with code 1', reason: 'the agent exited with code 1', runs: [{ runId: attempt, verdict: 'failed', passed: false, exitCode: 1 }] } });
      store.addChaosResult({ sessionId: 'S', runId: rec, golden: 'goldens/list-inbox', preset: 'empty', verdict: 'passed', callNo: 2, passes: 1, attempts: 1, at: 6, data: { detail: 'list_inbox (#2) answered with nothing: the agent exited 0', runs: [] } });
      store.finishChaosSession('S', { passed: 1, failed: 1, inconclusive: 0, upstreamRequests: 0, endedAt: 7 });
      const goldens: GoldenSource[] = [{ path: 'goldens/list-inbox', runId: rec, packedAt: 1, mode: 'replay', repeat: 1, passes: 1, checks: [] }];
      return testsView(store, goldens) as unknown as TestsView;
    } finally {
      store.close();
    }
  }

  it('says its presets failed, which attempt to open, and never that it has not run', async () => {
    const v = view();
    (globalThis as { location?: unknown }).location = { hash: '#/tests' };
    const client = { tests: () => Promise.resolve(v), jobs: () => Promise.resolve([]) } as unknown as Client;
    const app = { client, exported: false, meta: null, tick: 0, feeds: {}, jobs: [], actionsOff: null, hasKind: () => true, guard: (fn: () => void) => fn(), watchJob: () => undefined, toast: () => undefined, registerLayer: () => () => undefined };
    r = await render(createElement(AppContext.Provider, { value: app as unknown as AppState }, createElement(TestsPage)));
    await r.until('the golden to load', () => r!.all('td.glast').length === 1);
    const last = r.one('td.glast');
    expect(last.querySelector('.st')!.textContent).toBe('presets failed');
    expect(last.querySelector('.st')!.className).toBe('st err');
    const line = last.querySelector('a.gpre')!;
    expect(line.textContent).toBe('1 of 2 presets failed: tool timeout #2 · replay not tested yet');
    expect(line.getAttribute('href')).toBe(`#/run/${v.rows[0]!.presets!.runId}`);
    expect(r.document.body.textContent).not.toContain('not run yet');
    // The palette's hint for it says the same.
    expect(testsPalette(v, { update: false }).find((e) => e.label === 'list-inbox')?.hint).toBe('presets failed');
  });
});
