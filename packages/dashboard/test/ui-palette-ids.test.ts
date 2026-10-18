import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '../ui/api.js';
import type { Route } from '../ui/route.js';
import { Keyboard } from '../ui/shell/Keyboard.js';
import { Palette } from '../ui/shell/Palette.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { RunsPageRow, RunsQuery } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Search or jump to finds any run by its id. Its Runs group came from the run list, the newest 500
 * runs, so on a store of 3,000 the oldest run typed by its id was offered nothing, though Runs'
 * filter found it and #/run/<id> opened it. Rendered as the shell renders the palette, typed into
 * as a person types.
 */

function run(runId: string, startedAt: number): RunsPageRow {
  return {
    runId,
    parentRunId: null,
    mode: 'record',
    status: 'completed',
    divergence: null,
    command: 'node agent.js',
    codeVersion: null,
    startedAt,
    calls: 29,
    spent: 0,
    saved: 0,
    captured: 0,
    imported: false,
    covers: null,
    source: null,
    labels: [],
  } as unknown as RunsPageRow;
}

// The newest runs, as the run list holds them, and one from long before.
const NEWEST = run('01M584YR9AJ7Q2M8V7W3T1C5DE', 2_000_000);
const NEXT = run('01M584YR8ZK2P4N6R8T0V2X4Z6', 1_999_000);
const OLDEST = run('01M584YKT6Q8S0U2W4Y6A8C0E2', 1_000_000);

function app(client: Partial<Client>): AppState {
  const base = {
    client,
    exported: false,
    meta: null,
    conn: 'ok',
    runs: [NEWEST, NEXT],
    runCommands: [],
    actionsOff: null,
    hasKind: () => false,
    jobs: [],
    guard: (fn: () => void) => fn(),
    watchJob: () => undefined,
    palette: true,
    setPalette: () => undefined,
    help: false,
    setHelp: () => undefined,
    sideOpen: false,
    setSideOpen: () => undefined,
    closeTopLayer: () => false,
    blockingLayer: () => true,
    runKeys: { current: null },
    registerLayer: () => () => undefined,
  };
  return base as unknown as AppState;
}

const OVERVIEW: Route = { page: 'overview' };

/** The palette's rows: each run's short id and what it says of it, group by group. */
const rows = (r: Rendered) => r.all('.palit').map((el) => el.textContent.replace(/↵$/, '').trim());

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

describe('Search or jump to, by a run’s id', () => {
  it('asks the server for a run the run list doesn’t have, and offers it', async () => {
    const runsPage = vi.fn(async (q: RunsQuery) => ({ runs: q.q && OLDEST.runId.startsWith(q.q) ? [OLDEST] : [], total: 1, next: null, chipCounts: {} }));
    const search = vi.fn(async () => ({ hits: [] }));
    const page = (r = await render(createElement(AppContext.Provider, { value: app({ runsPage, search } as unknown as Client) }, createElement(Keyboard), createElement(Palette, { route: OVERVIEW }))));
    const input = page.one('.palin input');
    expect(page.focused()).toBe(input);
    await page.type(input, '01m584ykt6');
    await page.until('the palette to offer a run', () => rows(page).length > 0);
    expect(runsPage).toHaveBeenCalledWith({ q: '01M584YKT6', limit: 20 });
    expect(rows(page)).toEqual(['01M584YKT6recording · node agent.js']);
    // Tab stays in the palette, as in any dialog.
    await page.press('Tab');
    expect(page.focused().className).toContain('palit');
    await page.press('Tab');
    expect(page.focused()).toBe(input);
  });

  it('offers a run the list has from the list, without asking', async () => {
    const runsPage = vi.fn(async () => ({ runs: [], total: 0, next: null, chipCounts: {} }));
    const search = vi.fn(async () => ({ hits: [] }));
    r = await render(createElement(AppContext.Provider, { value: app({ runsPage, search } as unknown as Client) }, createElement(Palette, { route: OVERVIEW })));
    await r.type(r.one('.palin input'), '01M584YR9A');
    // What runs recorded is asked for last, after the palette would have asked for the id.
    await r.until('the palette to search what runs recorded', () => search.mock.calls.length > 0);
    expect(runsPage).not.toHaveBeenCalled();
    expect(rows(r)).toEqual(['01M584YR9Arecording · node agent.js']);
  });
});
