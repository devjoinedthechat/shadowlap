import { Store } from '@shadowlap/engine';
import { act, createElement, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { testsView, type GoldenSource } from '../src/tests.js';
import type { Client, TestsView } from '../ui/api.js';
import { TestsPage } from '../ui/pages/Tests.js';
import { ServedPartsContext, type PresetsDialogProps } from '../ui/served-parts.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';
import { shownNow } from './ui-served-now.js';

/**
 * The Tests page waits for error-path presets on goldens started elsewhere (`chaosRunning`), as the
 * server does. A session of them ends by moving the change feed's `chaos` count alone, not runs or
 * calls (`tick`), so the page reads the tests again on that count too: otherwise its buttons went on
 * saying the presets were running, after the server had stopped refusing the jobs.
 */

const PRESETS = { id: 'S1', command: 'shadowlap test goldens/* --chaos', startedAt: 1 };

function view(chaosRunning: TestsView['chaosRunning']): TestsView {
  return {
    empty: false,
    goldens: 1,
    verdict: null,
    revisions: [],
    rows: [],
    divergences: [],
    failures: [],
    inconclusive: [],
    diverged: [],
    running: null,
    chaosRunning,
    commands: { ci: `shadowlap test 'goldens/*' --junit report.xml --markdown "$GITHUB_STEP_SUMMARY" --annotations`, pack: 'shadowlap pack <run> goldens/<name>', run: ['test', 'goldens/*'], updateAll: null },
    note: '',
  };
}

/** The server's answer now: the presets run until `ended`. */
let ended = false;
let asked = 0;
const client = {
  injectionSecurity: () => Promise.resolve({ goldens: [], none: [], unread: [] }),
  coverage: () => Promise.resolve(null),
  tests: () => {
    asked++;
    return Promise.resolve(view(ended ? null : PRESETS));
  },
  jobs: () => Promise.resolve([]),
} as unknown as Client;

let moveFeeds: (feeds: Record<string, number>) => void = () => undefined;

/** The app as the shell gives it, with the change feed's counts in its state, as the shell keeps them. */
function Shell() {
  const [feeds, setFeeds] = useState<Record<string, number>>({});
  moveFeeds = setFeeds;
  const app = {
    client,
    exported: false,
    meta: null,
    tick: 0,
    feeds,
    jobs: [],
    actionsOff: null,
    hasKind: () => true,
    guard: (fn: () => void) => fn(),
    watchJob: () => undefined,
    toast: () => undefined,
  };
  return createElement(AppContext.Provider, { value: app as unknown as AppState }, createElement(TestsPage));
}

const g = globalThis as { location?: unknown };
let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  delete g.location;
});

describe('the Tests page while error-path presets run on goldens', () => {
  it('waits for them, and reads the tests again when their session ends, though no run or call moved', async () => {
    g.location = { hash: '#/tests' };
    r = await render(createElement(Shell));
    const runTests = () => r!.byText('button', 'Run tests');
    await r.until('the tests to load', () => r!.all('button').some((b) => b.textContent.trim() === 'Run tests'));
    expect(runTests().props['aria-disabled']).toBe('true');
    expect(runTests().props['data-why']).toBe('shadowlap test goldens/* --chaos is running: run the tests once it is done.');

    // The session ends: the store moves the chaos count, and nothing else.
    ended = true;
    await act(async () => moveFeeds({ chaos: 1 }));
    await r.until('the tests to load again', () => !runTests().props['aria-disabled']);
    expect(asked).toBe(2);
    expect(runTests().props['data-why']).toBeUndefined();
  });
});

describe('a golden’s error-path presets under its checks', () => {
  /** A golden recorded here; with `ran`, its presets ran on its recording: tool timeout failed at call 2, empty passed, provider 429 couldn't apply. */
  function golden(ran: boolean): { view: TestsView; rec: string; attempt: string } {
    const store = Store.open(':memory:');
    try {
      const rec = store.createRun({ mode: 'record', command: { argv: ['node', 'inbox.mjs'], cwd: '.' }, startedAt: 1 }).runId;
      store.endRun(rec, 'completed', 2);
      const attempt = store.createRun({ mode: 'replay', parentRunId: rec, command: { argv: ['node', 'inbox.mjs'], cwd: '.' }, startedAt: 3, meta: { chaos: { preset: 'timeout', callNo: 2, session: 'S', attempt: 1, golden: 'goldens/list-inbox' } } }).runId;
      store.endRun(attempt, 'failed', 4);
      if (ran) {
        store.startChaosSession({ sessionId: 'S', startedAt: 3, command: ['shadowlap', 'test', 'goldens/list-inbox', '--chaos'], presets: ['timeout', 'empty', '429'] });
        store.addChaosResult({ sessionId: 'S', runId: rec, golden: 'goldens/list-inbox', preset: 'timeout', verdict: 'failed', callNo: 2, passes: 0, attempts: 1, at: 5, data: { detail: 'list_inbox (#2) timed out: the agent exited with code 1', reason: 'the agent exited with code 1', runs: [{ runId: attempt, verdict: 'failed', passed: false, exitCode: 1 }] } });
        store.addChaosResult({ sessionId: 'S', runId: rec, golden: 'goldens/list-inbox', preset: 'empty', verdict: 'passed', callNo: 2, passes: 3, attempts: 3, at: 6, data: { detail: 'list_inbox (#2) answered with nothing: the agent exited 0', runs: [] } });
        // As the CLI's notApplicable keeps one with no call to hit (cli chaos.ts): its detail is why.
        store.addChaosResult({ sessionId: 'S', runId: rec, golden: 'goldens/list-inbox', preset: '429', verdict: 'not-applicable', callNo: null, passes: 0, attempts: 0, at: 6, data: { detail: 'the recording makes no model call', runs: [] } });
        store.finishChaosSession('S', { passed: 1, failed: 1, inconclusive: 0, upstreamRequests: 0, endedAt: 7 });
      }
      const goldens: GoldenSource[] = [{ path: 'goldens/list-inbox', runId: rec, packedAt: 1, mode: 'replay', repeat: 1, passes: 1, checks: [] }];
      return { view: testsView(store, goldens), rec, attempt };
    } finally {
      store.close();
    }
  }

  const opened: string[] = [];
  function PresetsDialog({ runId }: PresetsDialogProps) {
    opened.push(runId);
    return createElement('p', { id: 'presets-dialog' }, runId);
  }
  const page = (v: TestsView) => {
    g.location = { hash: '#/tests' };
    const client = { tests: () => Promise.resolve(v), jobs: () => Promise.resolve([]), injectionSecurity: () => Promise.resolve({ goldens: [], none: [], unread: [] }), coverage: () => Promise.resolve(null) } as unknown as Client;
    const app = { client, exported: false, meta: null, tick: 0, feeds: {}, jobs: [], actionsOff: null, hasKind: () => true, guard: (fn: () => void) => fn(), watchJob: () => undefined, toast: () => undefined };
    return createElement(AppContext.Provider, { value: app as unknown as AppState }, createElement(ServedPartsContext.Provider, { value: { PresetsDialog: shownNow(PresetsDialog) } }, createElement(TestsPage)));
  };

  it('draws them as one picture of a cell a preset, named by its counts, which open the attempt that proves them', async () => {
    const { view: v, rec, attempt } = golden(true);
    // A golden whose replay passed too: its presets are its checks' strip alone, never a short line under its last result.
    const passed: TestsView = { ...v, rows: v.rows.map((row) => ({ ...row, last: { ...row.last, result: 'pass', verdict: 'passed', line: '12/12 replayed · exited 0' } })) };
    r = await render(page(passed));
    await r.until('the golden to load', () => r!.all('td.gck .gpstrip').length === 1);
    const strip = r.one('td.gck .gpstrip');
    const head = strip.querySelector('a.gpk')!;
    expect(head.textContent).toBe('error-path presets');
    expect(head.getAttribute('href')).toBe(`#/run/${rec}`);
    const picture = strip.querySelector('.pcells')!;
    expect(picture.getAttribute('role')).toBe('img');
    expect(picture.getAttribute('aria-label')).toBe('2 presets: 1 failed, 1 passed');
    // A preset that couldn't apply is a muted cell, its card saying so, and left out of the counts.
    expect([...picture.querySelectorAll('i')].map((c) => c.className)).toEqual(['pc err', 'pc ok', 'pc n']);
    expect(JSON.parse(picture.querySelectorAll('i')[2].getAttribute('data-tip')!)).toEqual({ t: 'provider 429', s: 'the recording makes no model call', rows: [['not applicable', '', 'var(--cq-muted)']] });
    // One that failed says why it failed, as its result kept it.
    expect(JSON.parse(picture.querySelector('i')!.getAttribute('data-tip')!)).toEqual({ t: 'tool timeout', s: 'the agent exited with code 1', rows: [['failed', '', 'var(--cq-red)'], ['at', '#2', '']] });
    expect(JSON.parse(picture.querySelectorAll('i')[1].getAttribute('data-tip')!).rows[0]).toEqual(['passed', '3 of 3', 'var(--cq-lime)']);
    const counts = strip.querySelector('a.gpn')!;
    expect(counts.textContent).toBe('1 failed · 1 passed');
    expect(counts.getAttribute('href')).toBe(`#/run/${attempt}`);
    expect(r.one('td.glast').querySelector('.gpre')).toBeNull();
    expect(r.document.body.textContent).not.toContain('presets · ');
    expect(r.document.body.textContent).not.toContain('not run yet');
  });

  it('offers Run error-path presets… where its tests entry sets them and none ran, waiting while a session runs', async () => {
    const { view: v, rec } = golden(false);
    const set = (running: TestsView['chaosRunning']): TestsView => ({ ...v, chaosRunning: running, rows: v.rows.map((row) => ({ ...row, presetsEntry: true as const })) });
    r = await render(page(set(PRESETS)));
    await r.until('the golden to load', () => r!.all('td.gck .gpstrip').length === 1);
    const strip = r.one('td.gck .gpstrip');
    expect(strip.querySelector('.gpn')!.textContent).toBe('not run yet');
    const button = strip.querySelector('button')!;
    expect(button.textContent).toBe('Run error-path presets…');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('data-why')).toBe('shadowlap test goldens/* --chaos is running: run its presets once it is done.');
    await r.unmount();
    // Once nothing runs, it opens their dialog on the golden's recording.
    r = await render(page(set(null)));
    await r.until('the golden to load', () => r!.all('td.gck .gpstrip button').length === 1);
    await r.click(r.one('td.gck .gpstrip button'));
    await r.until('the dialog to open', () => r!.all('#presets-dialog').length === 1);
    expect(opened.at(-1)).toBe(rec);
    // A golden whose entry doesn't set them shows nothing until they run.
    await r.unmount();
    r = await render(page(v));
    await r.until('the golden to load', () => r!.all('td.gck').length === 1);
    expect(r.all('.gpstrip')).toHaveLength(0);
  });
});
