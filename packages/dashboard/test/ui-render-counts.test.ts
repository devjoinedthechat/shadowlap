import { createElement, Fragment, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Changes, Client, Meta, RunListItem } from '../ui/api.js';
import { AppProvider, useApp, useAppSelector } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Every screen reads what the dashboard shares (the client, the server's meta, the run list, the
 * connection, the jobs) from one state the shell polls every two seconds. Each poll moves when the
 * page last heard from the server, and the run list moves whenever runs do. A component re-renders
 * when a field it reads changes, and for no other: the pages, which never read when the shell last
 * synced, don't redraw on every poll.
 */

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  vi.unstubAllGlobals();
});

const META = { version: '0.1.0', dbPath: null, actions: true, readOnly: false, readOnlyReason: null, address: '127.0.0.1:4777', storeBytes: null, counts: { runs: 1, attempts: 0 }, live: [], jobKinds: [], uploadLimit: null, project: null } as unknown as Meta;

/** A server that has nothing new to say: each poll answers that nothing moved. */
function quietClient(): { client: Client; polls: () => number } {
  let changes = 0;
  const client = {
    exported: false,
    meta: () => Promise.resolve(META),
    runs: () => Promise.resolve([{ runId: '01K4ZQ8D2M6V7N9P3R5T7W9X1Y', status: 'completed', calls: 3 }] as unknown as RunListItem[]),
    changes: (since: string | null): Promise<Changes> => {
      changes++;
      return Promise.resolve(since === null ? { cursor: 'c0', changed: true, runs: true, calls: false, live: [] } : { cursor: `c${changes}`, changed: false, runs: false, calls: false, live: [] });
    },
  } as unknown as Client;
  // The first ask is the cursor the page starts from; the rest are its polls.
  return { client, polls: () => Math.max(0, changes - 1) };
}

describe('re-rendering on what the shell polls', () => {
  it('redraws a component when a field it reads changes, and for no other', async () => {
    vi.stubGlobal('location', { search: '', hash: '#/', pathname: '/', host: '127.0.0.1:4777' });
    const renders = { actions: 0, synced: 0, runs: 0, loaded: 0 };
    // A page that only acts: it reads the client and toast, which never change.
    function Actions() {
      const { client, toast } = useApp();
      renders.actions++;
      void client;
      void toast;
      return null;
    }
    // The status bar's sync time: it moves on every poll.
    function Synced() {
      const { syncedAt } = useApp();
      renders.synced++;
      return createElement('span', { className: 'synced' }, String(syncedAt));
    }
    // A list of runs, through a selector.
    function Runs() {
      const runs = useAppSelector((a) => a.runs);
      renders.runs++;
      return createElement('span', { className: 'runs' }, String(runs?.length ?? 'none'));
    }
    // A field read in an effect, not while rendering: tracked all the same.
    function Loaded() {
      const app = useApp();
      renders.loaded++;
      useEffect(() => void app.loadedAt, [app]);
      return null;
    }
    const { client, polls } = quietClient();
    r = await render(createElement(AppProvider, { client, children: createElement(Fragment, null, createElement(Actions), createElement(Synced), createElement(Runs), createElement(Loaded)) }));
    await r.until('the first look and two polls', () => polls() >= 2);
    await r.wait(50);
    // The first look moved the meta, the runs, when they loaded and when the page synced; each poll moved the sync time.
    expect(renders.synced).toBeGreaterThanOrEqual(3);
    expect(r.one('.runs').textContent).toBe('1');
    // The run list loaded once: drawn empty, then with it.
    expect(renders.runs).toBe(2);
    // Read in an effect: drawn again when it loaded, not on each poll.
    expect(renders.loaded).toBe(2);
    // Nothing it reads changed: drawn once.
    expect(renders.actions).toBe(1);
  });
});
