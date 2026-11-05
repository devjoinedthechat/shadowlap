import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Client } from '../ui/api.js';
import { BLAME_ENTRIES, blameAsksOnItsPage, blameEntries, matchPalette, stepEntry } from '../ui/palette.js';
import { useRunCommands } from '../ui/run/run-commands.js';
import type { Route } from '../ui/route.js';
import { Palette } from '../ui/shell/Palette.js';
import { AppContext, type AppState, type PaletteCommand } from '../ui/state.js';
import type { NextStep, RunDetail, RunListItem } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * The palette says what a run's page leads with: This run's first entry is its next step, then what
 * else the page offers with none said twice, and Run blame for the newest failures nobody blamed is
 * found once something is typed, from what a list's rows say of them.
 */

const RUN = '01M5JEQWA2QMJ3NYD1C687WP08';
const PARENT = '01M5JEQXRGBX1QXGW0X8A3ZB4C';

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

function detail(next: NextStep | null, o: { actions?: unknown[]; replay?: NextStep; parent?: string; status?: string } = {}): RunDetail {
  return {
    run: { runId: RUN, parentRunId: o.parent ?? null, mode: 'record', status: o.status ?? 'completed', command: { argv: ['node', 'agent.mjs'], cwd: '.' }, meta: {} },
    actions: o.actions ?? [{ key: 'r', label: 'Replay' }],
    parent: o.parent ? { runId: o.parent, label: 'recording' } : null,
    source: null,
    ...(next ? { next } : {}),
    ...(o.replay ? { replay: o.replay } : {}),
  } as unknown as RunDetail;
}

/** What This run lists for a run's page, as the page's hook hands it to the palette. */
async function thisRun(run: RunDetail, app: Partial<AppState> = {}): Promise<PaletteCommand[]> {
  let items: PaletteCommand[] = [];
  const Page = () => {
    useRunCommands({ run, selected: 3, canFork: true, canMark: false, labels: [], mark: () => undefined, offers: null, actions: { run: () => undefined, findCommit: () => undefined }, forkMenu: { openAt: () => undefined }, setView: () => undefined });
    return null;
  };
  const value = { exported: false, actionsOff: null, hasKind: () => true, setRunCommands: (x: PaletteCommand[]) => (x.length ? (items = x) : undefined), ...app } as unknown as AppState;
  r = await render(createElement(AppContext.Provider, { value }, createElement(Page)));
  await r.unmount();
  r = null;
  return items;
}

describe('This run', () => {
  it('sets the next step’s key by what it presses, never by what it says', () => {
    const blame: NextStep = { key: 'blame', label: 'Run blame', offer: { from: 'exit', expect: null, failed: [] } };
    expect(stepEntry(blame).key).toBe('b');
    expect(stepEntry({ key: 'replay', label: 'Replay recording', runId: PARENT }).key).toBe('r');
    expect(stepEntry({ key: 'replay', label: 'Replay with your command…', runId: RUN }).key).toBe('r');
    expect(stepEntry({ key: 'compare', label: 'Compare with parent', parent: PARENT, href: `#/compare/${PARENT}/${RUN}` }).key).toBe('c');
    // A step no key presses has none: its own button, or a link the header has no key for.
    expect(stepEntry({ key: 'fix', label: 'Open fix', fixId: 'F1', status: 'open', href: '#/fixes/F1' })).not.toHaveProperty('key');
    expect(stepEntry({ key: 'pack', label: 'Pack as golden…', runId: RUN, folder: 'goldens/x' })).not.toHaveProperty('key');
  });

  it('leads with the run’s next step, its command as its hint, and offers it once', async () => {
    const blame: NextStep = { key: 'blame', label: 'Run blame', offer: { from: 'exit', expect: null, failed: [] }, command: `shadowlap blame ${RUN.slice(0, 10)}` };
    const items = await thisRun(detail(blame, { replay: { key: 'replay', label: 'Replay', runId: RUN, command: `shadowlap replay ${RUN.slice(0, 10)}` } }));
    expect(items.map((x) => x.label).slice(0, 3)).toEqual(['Run blame', 'Replay', 'Fork at #3…']);
    expect(items[0]).toMatchObject({ group: 'This run', hint: `shadowlap blame ${RUN.slice(0, 10)}`, job: true });
    expect(matchPalette(items, '')[0]?.label).toBe('Run blame');
  });

  it('says Replay once where it is the step, and the recording’s where a replay came from one', async () => {
    const replay: NextStep = { key: 'replay', label: 'Replay', runId: RUN, command: `shadowlap replay ${RUN.slice(0, 10)}` };
    expect((await thisRun(detail(replay))).filter((x) => x.label === 'Replay')).toHaveLength(1);
    const recording: NextStep = { key: 'replay', label: 'Replay recording', runId: PARENT, command: `shadowlap replay ${PARENT.slice(0, 10)}` };
    const compare: NextStep = { key: 'compare', label: 'Compare with parent', parent: PARENT, href: `#/compare/${PARENT}/${RUN}`, title: 'Against it', command: 'shadowlap diff a b' };
    const items = await thisRun(detail(compare, { replay: recording, parent: PARENT }));
    expect(items.map((x) => x.label).slice(0, 2)).toEqual(['Compare with parent', 'Replay recording']);
    expect(items.filter((x) => x.label === 'Compare with parent')).toHaveLength(1);
    // A link is no job: it goes on while the server can't be reached, and on a read-only dashboard.
    expect(items[0]?.job).toBeUndefined();
    expect((await thisRun(detail(compare, { parent: PARENT }), { actionsOff: 'read-only' }))[0]?.label).toBe('Compare with parent');
    expect((await thisRun(detail({ key: 'blame', label: 'Run blame', offer: { from: 'exit', expect: null, failed: [] } }), { actionsOff: 'read-only' })).map((x) => x.label)).not.toContain('Run blame');
  });

  it('leaves out a step that can’t start, and its own Find breaking commit… where that is the step', async () => {
    const recording: NextStep = { key: 'replay', label: 'Replay', runId: RUN, off: 'Replay once the recording finishes' };
    const live = await thisRun(detail(recording, { status: 'running' }));
    expect(live.map((x) => x.label)).not.toContain('Replay');
    const bisect: NextStep = { key: 'bisect', label: 'Find breaking commit', golden: 'goldens/x', starts: true, blame: null, command: 'shadowlap bisect goldens/x --good a' };
    const items = await thisRun(detail(bisect));
    expect(items.filter((x) => x.label.startsWith('Find breaking commit')).map((x) => x.label)).toEqual(['Find breaking commit']);
  });

  it('words an entry from the step alone', () => {
    expect(stepEntry({ key: 'fix', label: 'Open fix', fixId: 'fx-1', status: 'open', href: '#/fixes/fx-1', title: '“Refunds”' })).toEqual({ group: 'This run', label: 'Open fix', hint: '“Refunds”' });
    expect(stepEntry({ key: 'rule', label: 'Add normalizer' })).toEqual({ group: 'This run', label: 'Add normalizer', hint: '', job: true });
  });
});

const row = (runId: string, startedAt: number, key: string, about = 'Order A-1042 arrived damaged'): RunListItem => ({ runId, startedAt, labels: [], mode: 'record', status: 'failed', calls: 3, command: 'node agent.mjs', parentRunId: null, next: { key, label: key === 'blame' ? 'Run blame' : 'Replay' }, about: { text: about, from: 'user' } }) as unknown as RunListItem;

describe('Run blame in the palette', () => {
  const OVERVIEW: Route = { page: 'overview' };
  const app = (over: Partial<AppState>, client: Partial<Client> = {}): AppState =>
    ({
      client: { search: async () => ({ hits: [] }), runsPage: async () => ({ runs: [], total: 0, next: null, chipCounts: {} }), ...client },
      exported: false,
      meta: null,
      conn: 'ok',
      runs: [],
      runCommands: [],
      actionsOff: null,
      hasKind: () => true,
      jobs: [],
      guard: (fn: () => void) => fn(),
      watchJob: () => undefined,
      toast: () => undefined,
      palette: true,
      setPalette: () => undefined,
      setHelp: () => undefined,
      closeTopLayer: () => false,
      blockingLayer: () => true,
      registerLayer: () => () => undefined,
      ...over,
    }) as unknown as AppState;
  const shown = (p: Rendered) => p.all('.palit').map((el) => el.querySelector('.pl')!.textContent);
  const type = async (p: Rendered, q: string) => {
    await p.type(p.one('.palin input'), q);
  };

  it('finds the newest failures whose next step it is, but the run open', () => {
    const runs = [row('A', 1, 'blame'), row('B', 4, 'blame'), row('C', 3, 'replay'), row('D', 2, 'blame'), row('E', 5, 'blame'), row('F', 6, 'blame')];
    expect(blameEntries(runs, 'F').map((x) => x.run.runId)).toEqual(['E', 'B', 'D']);
    expect(blameEntries(runs, null)).toHaveLength(BLAME_ENTRIES);
    expect(blameEntries(runs, null)[0]?.entry).toEqual({ group: 'Actions', label: 'Run blame', hint: 'shadowlap blame F', job: true, typed: true, match: 'failed Order A-1042 arrived damaged' });
  });

  it('shows them only once something is typed, by what they did too, and starts the job', async () => {
    const started: Array<[string, unknown]> = [];
    const watched = vi.fn();
    r = await render(createElement(AppContext.Provider, { value: app({ runs: [row(RUN, 1, 'blame')], watchJob: watched }, { startJob: (kind: string, fields: unknown) => (started.push([kind, fields]), Promise.resolve({ id: 'j' })) } as never) }, createElement(Palette, { route: OVERVIEW })));
    expect(shown(r)).not.toContain('Run blame');
    await type(r, 'damaged');
    expect(shown(r)).toContain('Run blame');
    await r.click(r.byText('.palit .pl', 'Run blame'));
    await r.wait(0);
    expect(started).toEqual([['blame', { runId: RUN }]]);
    expect(watched).toHaveBeenCalledOnce();
  });

  it('leaves to the run’s page the check and the yes it asks first, and nothing else', () => {
    expect(blameAsksOnItsPage(new ApiError(422, 'say what a passing run must do'))).toBe(true);
    expect(blameAsksOnItsPage(new ApiError(409, 'This run came from an imported pack: node agent.mjs', 'node agent.mjs'))).toBe(true);
    expect(blameAsksOnItsPage(new ApiError(409, 'A job is already running'))).toBe(false);
    expect(blameAsksOnItsPage(new ApiError(500, 'broke'))).toBe(false);
    expect(blameAsksOnItsPage(null)).toBe(false);
  });

  it('opens the run where what it asks first is its page’s to ask, and offers none where nothing runs', async () => {
    const location = { hash: '#/', search: '', pathname: '/' };
    vi.stubGlobal('location', location);
    try {
      r = await render(createElement(AppContext.Provider, { value: app({ runs: [row(RUN, 1, 'blame')] }, { startJob: () => Promise.reject(new ApiError(422, 'say what a passing run must do')) }) }, createElement(Palette, { route: OVERVIEW })));
      await type(r, 'blame');
      await r.click(r.byText('.palit .pl', 'Run blame'));
      await r.wait(0);
      expect(location.hash).toBe(`#/run/${RUN}`);
      await r.unmount();
      r = await render(createElement(AppContext.Provider, { value: app({ runs: [row(RUN, 1, 'blame')], actionsOff: 'read-only' }) }, createElement(Palette, { route: OVERVIEW })));
      await type(r, 'blame');
      expect(shown(r)).not.toContain('Run blame');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
