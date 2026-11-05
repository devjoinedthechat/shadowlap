import { act, createElement, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Client, TestsView } from '../ui/api.js';
import { TestsPage } from '../ui/pages/Tests.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';

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
    expect(runTests().props.disabled).toBe(true);
    expect(runTests().props.title).toBe('shadowlap test goldens/* --chaos is running: run the tests once it is done.');

    // The session ends: the store moves the chaos count, and nothing else.
    ended = true;
    await act(async () => moveFeeds({ chaos: 1 }));
    await r.until('the tests to load again', () => !runTests().props.disabled);
    expect(asked).toBe(2);
    expect(runTests().props.title).toBeUndefined();
  });
});
