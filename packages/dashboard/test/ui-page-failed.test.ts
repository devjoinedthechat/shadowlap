import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client, Meta } from '../ui/api.js';
import { DashboardPages } from '../ui/pages/lazy.js';
import { href } from '../ui/route.js';
import { navigate, useRoute } from '../ui/router.js';
import type { RunLike } from '../ui/runs.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';

/**
 * A page whose code didn't come from the dashboard server (pages/lazy.tsx): its title, as the
 * browser's tab names it, over one line in the error tone, with Retry, which loads the page again,
 * since a browser never asks a second time for a script it failed to load. A run's page is titled by
 * the run's id, in the code face. While the server can't be reached, Retry waits for it. Here the
 * scripts of Tests and of a run's page fail to come, as when the dashboard stopped.
 */

vi.mock('../ui/pages/Tests.js', () => {
  throw new TypeError('Failed to fetch dynamically imported module');
});
vi.mock('../ui/pages/Run.js', () => {
  throw new TypeError('Failed to fetch dynamically imported module');
});

const RUN = '01M5GRX8K406H4KHQ7DEKYWTSZ';

function app(o: { paused?: string[] } = {}): AppState {
  return {
    client: { exported: false } as unknown as Client,
    exported: false,
    meta: { version: '1.0.0', project: { name: 'support-agent', path: '/work/support-agent' } } as unknown as Meta,
    runs: [{ runId: RUN, mode: 'record', parentRunId: null, status: 'completed', meta: {} } as unknown as RunLike],
    live: [],
    tick: 0,
    runsTick: 0,
    feeds: {},
    jobs: [],
    actionsOff: null,
    hasKind: () => false,
    // Offline, an action says it waits rather than run.
    guard: (fn: () => void) => (o.paused ? void o.paused.push('Actions are paused until the dashboard server is back.') : fn()),
    toast: () => undefined,
  } as unknown as AppState;
}

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  vi.unstubAllGlobals();
});

/** The page the address bar names, as the dashboard's shell draws it; the address bar it reads. */
async function open(hash: string, state = app()) {
  const bar = { hash, search: '', pathname: '/', reload: vi.fn() };
  vi.stubGlobal('location', bar);
  vi.stubGlobal('history', { state: null, replaceState: (_s: unknown, _t: string, url: string) => void (bar.hash = url.slice(url.indexOf('#'))) });
  function Routed() {
    return createElement(DashboardPages, { route: useRoute() });
  }
  r = await render(createElement(AppContext.Provider, { value: state }, createElement(Routed)));
  await r.until('the line that says the page’s code didn’t come', () => r!.all('.loaderr').length === 1);
  return bar;
}

describe('a page whose code didn’t come', () => {
  it('keeps its title over one line in the error tone, and Retry loads the page again', async () => {
    const bar = await open('#/tests');
    expect(r!.one('.ph h1').textContent).toBe('Tests');
    expect(r!.one('.ph').className).toBe('ph');
    expect(r!.one('.ph .eyebrow').textContent).toBe('support-agent');
    const line = r!.one('.loaderr');
    expect(line.getAttribute('role')).toBe('alert');
    expect(line.querySelector('.st.err')!.textContent).toBe('couldn’t load');
    expect(line.querySelector('p span:not(.st)')!.textContent).toBe('This page’s code didn’t come from the dashboard server. Retry loads the page again.');
    await r!.click(r!.byText('.loaderr button', 'Retry'));
    expect(bar.reload).toHaveBeenCalledTimes(1);
  });

  it('titles a run’s page by the run’s id, in the code face, and follows the address to the next page', async () => {
    await open('#/tests');
    await act(async () => navigate(href.run(RUN), true));
    await r!.until('the run’s title', () => r!.one('.ph h1').textContent !== 'Tests');
    expect(r!.one('.ph').className).toBe('ph rerr');
    expect(r!.one('.ph h1').textContent).toBe(RUN.slice(0, 10));
    expect(r!.one('.ph .eyebrow').textContent).toBe('support-agent · run');
    expect(r!.all('.loaderr')).toHaveLength(1);
  });

  it('waits while the dashboard server can’t be reached: Retry says so and loads nothing', async () => {
    const paused: string[] = [];
    const bar = await open('#/tests', app({ paused }));
    await r!.click(r!.byText('.loaderr button', 'Retry'));
    expect(bar.reload).not.toHaveBeenCalled();
    expect(paused).toEqual(['Actions are paused until the dashboard server is back.']);
  });
});
