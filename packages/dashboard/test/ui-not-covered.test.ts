import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JOB_KINDS } from '../ui/api.js';
import type { Route } from '../ui/route.js';
import { Palette } from '../ui/shell/Palette.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Tests › Not covered and what scans and packs from elsewhere: what production did that no golden
 * tests. Rendered as the shell renders each part.
 */

const OVERVIEW: Route = { page: 'overview' };

function app(over: Partial<AppState> & { startJob?: () => Promise<unknown> } = {}): AppState {
  const { startJob = () => Promise.resolve({ id: 'j1' }), ...rest } = over;
  const base = {
    client: { search: async () => ({ hits: [] }), runsPage: async () => ({ runs: [], total: 0, next: null, chipCounts: {} }), jobs: async () => [], startJob },
    exported: false,
    meta: null,
    conn: 'ok',
    runs: [],
    runCommands: [],
    actionsOff: null,
    hasKind: (k: string) => k === JOB_KINDS.coverage,
    jobs: [],
    guard: (fn: () => void) => fn(),
    watchJob: () => undefined,
    toast: () => undefined,
    palette: true,
    setPalette: () => undefined,
    setSideOpen: () => undefined,
    setHelp: () => undefined,
  };
  return { ...base, ...rest } as unknown as AppState;
}

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

describe('Rescan coverage in the palette', () => {
  const row = (label: string) => r!.all('.palit').find((el) => el.querySelector('.pl')!.textContent === label);

  it('scans again from Actions where the server runs the scan, with the command as its hint, and never in a copy', async () => {
    const startJob = vi.fn(() => Promise.resolve({ id: 'j1' }));
    r = await render(createElement(AppContext.Provider, { value: app({ startJob }) }, createElement(Palette, { route: OVERVIEW })));
    await r.type(r.one('.palin input'), 'Rescan');
    expect(row('Rescan coverage')!.querySelector('.ph2')!.textContent).toBe('shadowlap coverage');
    await r.click(row('Rescan coverage')!);
    expect(startJob).toHaveBeenCalledWith(JOB_KINDS.coverage, {});
    await r.unmount();
    for (const over of [{ exported: true }, { hasKind: () => false }]) {
      r = await render(createElement(AppContext.Provider, { value: app(over) }, createElement(Palette, { route: OVERVIEW })));
      await r.type(r.one('.palin input'), 'Rescan');
      expect(row('Rescan coverage')).toBeUndefined();
      await r.unmount();
    }
    r = null;
  });
});
