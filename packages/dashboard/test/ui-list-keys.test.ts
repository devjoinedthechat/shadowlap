import { act, createElement, useRef, useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '../ui/components/Dialog.js';
import { MenuItem, Popover, useMenu } from '../ui/components/Popover.js';
import { Tabs } from '../ui/components/Tabs.js';
import { backRowKey, isDetail, pageSig, samePage, trailAfter, type TrailStop } from '../ui/focus.js';
import { headingRef, stepsSideways } from '../ui/focus-manager.js';
import { shownRuns, useListKeys } from '../ui/list-keys.js';
import { OverlaySlots } from '../ui/overlays/slots.js';
import { noteParent } from '../ui/parents.js';
import { runRowScope } from '../ui/run-row.js';
import { noteShownRuns } from '../ui/runspage/shown-runs.js';
import { href, parseRoute } from '../ui/route.js';
import { navigate, useRoute } from '../ui/router.js';
import { Keyboard } from '../ui/shell/Keyboard.js';
import { Palette } from '../ui/shell/Palette.js';
import { RecentRuns } from '../ui/shell/Sidebar.js';
import { keyColumn, setSingleKeys, shortcut } from '../ui/shortcuts.js';
import { helpRowKey, parentCrumbKey } from '../ui/shell/top.js';
import { recentRunIds } from '../ui/runs.js';
import type { RunListItem } from '../ui/types.js';
import { AppContext, type AppState } from '../ui/state.js';
import { addressBar, app, watchThePage } from './ui-route-helpers.js';
import { render, type Rendered } from './ui-render.js';

/**
 * One list hook for every list a page holds, and the way back Esc takes to it: rows registered as
 * data, drawn `.krow`, walked with j and k, opened, picked, and offered to ⌘K; a page's move handing
 * the focus to its heading or to the row Esc came back for.
 */

interface Item {
  id: string;
}
const ITEMS: Item[] = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
const keyOf = (x: Item) => `#/run/${x.id}`;

/** A list as a page draws one: its rows, each keyed by where it leads (a run, unless `to` says; nowhere where `leads` says not), the one in focus `.krow`, a checkbox in each where it picks. */
function List({ rows = ITEMS, to = keyOf, picks, drawn, show, actions, leads }: { rows?: Item[]; to?: (x: Item) => string; picks?: (x: Item) => void; drawn?: number; show?: (i: number) => void; actions?: (x: Item) => { name: string; items: () => Array<{ label: string; hint: string; run: () => void }> } | null; leads?: (x: Item) => boolean }) {
  const root = useRef<HTMLUListElement>(null);
  const open = (x: Item) => {
    if (leads && !leads(x)) return false;
    location.hash = to(x);
  };
  const at = useListKeys({ rows, keyOf: to, root, open, pick: picks ?? null, actions: actions ?? null, show: show ?? null });
  return createElement(
    'ul',
    { ref: root },
    rows.slice(0, drawn ?? rows.length).map((x) => createElement('li', { key: x.id, 'data-rowkey': to(x), className: at === to(x) ? 'krow' : undefined }, createElement('input', { type: 'checkbox', 'aria-label': x.id }), x.id)),
  );
}

/** A menu's button, its menu in the slot beside the app where the shell draws one. */
function ShareMenu() {
  const menu = useMenu();
  return createElement(
    'span',
    null,
    createElement('button', { type: 'button', id: 'share', onClick: (e: { currentTarget: HTMLElement }) => menu.toggle(e.currentTarget) }, 'Share'),
    menu.open && menu.anchor ? createElement(Popover, { anchor: menu.anchor, onClose: menu.close, label: 'Share', children: [createElement(MenuItem, { key: 'html', label: 'HTML file', onPick: menu.close }), createElement(MenuItem, { key: 'har', label: 'HAR', onPick: menu.close })] }) : null,
  );
}

let r: Rendered | null = null;
beforeAll(() => {
  // No layout here: a menu is placed against a window of this size.
  Object.assign(globalThis, { innerWidth: 1440, innerHeight: 900 });
});
beforeEach(() => {
  addressBar('#/runs');
});
afterEach(async () => {
  await r?.unmount();
  r = null;
  setSingleKeys(true);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const page = (children: unknown, state: AppState = app()) =>
  createElement(AppContext.Provider, { value: state }, createElement('main', { id: 'view', tabIndex: -1 }, createElement('h1', { ref: headingRef }, 'Runs'), children as never), createElement(Keyboard));

const rowInFocus = () => r!.focused().getAttribute('data-rowkey');
const krows = () => r!.all('.krow').map((x) => x.getAttribute('data-rowkey'));

describe('the list keys', () => {
  it('start at the first row with j and the last with k, stop at the ends, and draw the row in focus', async () => {
    r = await render(page(createElement(List)));
    await r.press('k');
    expect(rowInFocus()).toBe('#/run/C');
    expect(krows()).toEqual(['#/run/C']);
    expect(r.focused().getAttribute('tabindex')).toBe('-1');
    await r.press('j');
    expect(rowInFocus()).toBe('#/run/C');
    await r.press('k');
    await r.press('k');
    await r.press('k');
    expect(rowInFocus()).toBe('#/run/A');
    expect(krows()).toEqual(['#/run/A']);
  });

  it('move with the arrows only with the focus in a row, its checkbox included', async () => {
    r = await render(page(createElement(List)));
    const down = await r.press('ArrowDown');
    expect(down.defaultPrevented).toBe(false);
    expect(krows()).toEqual([]);
    await r.press('j');
    await r.press('ArrowDown');
    expect(rowInFocus()).toBe('#/run/B');
    await r.press('ArrowUp', {}, r.one('input[aria-label="B"]'));
    expect(rowInFocus()).toBe('#/run/A');
  });

  it('open on Enter only from the row itself, and pick with x from it or its checkbox', async () => {
    const picks = vi.fn();
    r = await render(page(createElement(List, { picks })));
    await r.press('j');
    await r.press('x');
    expect(picks).toHaveBeenLastCalledWith(ITEMS[0]);
    await r.press('x', {}, r.one('input[aria-label="A"]'));
    expect(picks).toHaveBeenCalledTimes(2);
    await r.focus(r.one('input[aria-label="A"]'));
    await r.press('Enter');
    expect(location.hash).toBe('#/runs');
    await r.press('k');
    await r.press('Enter');
    expect(location.hash).toBe('#/run/A');
  });

  it('let go on Esc, the heading taking the focus as -1, and j starts over', async () => {
    r = await render(page(createElement(List)));
    await r.press('j');
    await r.press('j');
    await r.press('Escape');
    expect(krows()).toEqual([]);
    expect(r.focused().tagName).toBe('H1');
    expect(r.focused().getAttribute('tabindex')).toBe('-1');
    await r.press('j');
    expect(rowInFocus()).toBe('#/run/A');
  });

  it('leave the focus where it is on Esc with no row in focus, a row’s checkbox or link keeping its place for Tab', async () => {
    r = await render(page(createElement(List)));
    const box = r.all('input')[0];
    await r.focus(box);
    const esc = await r.press('Escape');
    expect(r.focused()).toBe(box);
    expect(esc.defaultPrevented).toBe(false);
  });

  it('let go on Esc of the list that holds the row in focus, with the focus in another', async () => {
    r = await render(page([createElement(List, { key: 'one', rows: [ITEMS[0]] }), createElement(List, { key: 'two', rows: [ITEMS[1]] })]));
    await r.press('j');
    expect(krows()).toEqual(['#/run/A']);
    await r.focus(r.all('input')[1]);
    await r.press('Escape');
    expect(krows()).toEqual([]);
    expect(r.focused().tagName).toBe('H1');
  });

  it('keep the row’s place as the page draws again, and let go of a row that leaves the rows', async () => {
    let set!: (rows: Item[]) => void;
    function Filtered() {
      const [rows, setRows] = useState(ITEMS);
      set = setRows;
      return createElement(List, { rows });
    }
    r = await render(page(createElement(Filtered)));
    await r.press('j');
    await r.press('j');
    await act(async () => set([...ITEMS]));
    expect(krows()).toEqual(['#/run/B']);
    await act(async () => set([ITEMS[0], ITEMS[2]]));
    expect(krows()).toEqual([]);
    await r.press('j');
    expect(rowInFocus()).toBe('#/run/A');
  });

  it('bring a row not drawn into a window before it takes the focus', async () => {
    const shown: number[] = [];
    function Windowed() {
      const [drawn, setDrawn] = useState(1);
      return createElement(List, {
        drawn,
        show: (i: number) => {
          shown.push(i);
          setDrawn(i + 1);
        },
      });
    }
    r = await render(page(createElement(Windowed)));
    await r.press('j');
    expect(rowInFocus()).toBe('#/run/A');
    await r.press('j');
    expect(shown).toEqual([1]);
    expect(rowInFocus()).toBe('#/run/B');
  });

  it('take no key from a field, / going to the page’s filter and Esc leaving it for the row in focus', async () => {
    r = await render(page([createElement('input', { key: 'f', type: 'search', id: 'runsQuery' }), createElement(List, { key: 'l' })]));
    await r.press('j', {}, r.one('#runsQuery'));
    expect(krows()).toEqual([]);
    await r.press('j');
    await r.press('/');
    expect(r.focused().getAttribute('id')).toBe('runsQuery');
    const esc = await r.press('Escape');
    expect(esc.defaultPrevented).toBe(true);
    expect(rowInFocus()).toBe('#/run/A');
  });

  it('stop while a dialog is open', async () => {
    r = await render(page([createElement(List, { key: 'l' }), createElement(Dialog, { key: 'd', title: 'Delete run', ok: 'Delete run', tone: 'danger', onOk: () => undefined, onClose: () => undefined })]));
    await r.press('j');
    expect(krows()).toEqual([]);
    expect(r.focused().closest('[role="dialog"]')).not.toBeNull();
  });
});

describe('⌘K on a row', () => {
  const actions = (x: Item) => ({
    name: x.id,
    items: () => [
      { label: 'Open run', hint: 'about it', run: () => undefined },
      { label: 'Copy ID', hint: x.id, run: () => undefined },
    ],
  });

  function Opener({ leads }: { leads?: (x: Item) => boolean }) {
    const [open, setOpen] = useState(false);
    return createElement(AppContext.Provider, { value: app({ palette: open, setPalette: setOpen }) }, createElement('main', { id: 'view' }, createElement('button', { type: 'button', id: 'other' }, 'Other'), createElement(List, { actions, ...(leads ? { leads } : {}) })), createElement(Keyboard), createElement(Palette, { route: { page: 'runs' } }));
  }
  const labels = () => r!.all('.palit .pl').map((x) => x.textContent);

  it('opens on the row’s actions under its name; ⌫ shows everything; closing hands the focus back', async () => {
    r = await render(createElement(Opener));
    await r.press('j');
    await r.press('k', { metaKey: true });
    await r.until('the palette', () => r!.all('.palette').length === 1);
    expect(labels()).toEqual(['Open run', 'Copy ID']);
    expect(r.one('.palg code').textContent).toBe('A');
    const field = r.one('.palin input');
    expect(field.getAttribute('placeholder')).toBe('Actions for A');
    expect(r.one('.palfoot').textContent).toContain('everything');
    // It matches on the label and the hint alone.
    await r.type(field, 'about');
    expect(labels()).toEqual(['Open run']);
    await r.type(field, '');
    await r.press('Backspace', {}, field);
    expect(labels()).toContain('Runs');
    expect(r.one('.palfoot').textContent).not.toContain('everything');
    await r.press('Escape', {}, field);
    await r.until('it to close', () => r!.all('.palette').length === 0);
    expect(rowInFocus()).toBe('#/run/A');
  });

  it('opens on the row’s actions on Enter where the row leads nowhere of its own, and opens one that does', async () => {
    const before = location.hash;
    r = await render(createElement(Opener, { leads: (x: Item) => x.id !== 'B' }));
    await r.press('j');
    await r.press('j');
    await r.press('Enter');
    await r.until('the palette', () => r!.all('.palette').length === 1);
    expect([r.one('.palg code').textContent, labels(), location.hash]).toEqual(['B', ['Open run', 'Copy ID'], before]);
    await r.press('Escape', {}, r.one('.palin input'));
    await r.until('it to close', () => r!.all('.palette').length === 0);
    await r.press('j');
    await r.press('Enter');
    expect([location.hash, r.all('.palette').length]).toEqual(['#/run/C', 0]);
  });

  it('opens the whole palette with the focus outside a row', async () => {
    r = await render(createElement(Opener));
    await r.press('j');
    await r.focus(r.one('#other'));
    await r.press('k', { metaKey: true });
    await r.until('the palette', () => r!.all('.palette').length === 1);
    expect(labels()).toContain('Runs');
    expect(r.all('.palg code')).toEqual([]);
  });
});

describe('the palette’s key column', () => {
  const opened = (state: AppState) => render(createElement(AppContext.Provider, { value: state }, createElement(Palette, { route: parseRoute('#/run/A') })));

  it('draws by the switch as it opens, on a row built while the switch was off', async () => {
    setSingleKeys(false);
    const state = app({ palette: true, runCommands: [{ group: 'This run', label: 'Replay', hint: 'again', key: keyColumn('replay'), run: () => undefined }] });
    r = await opened(state);
    expect(r.all('.palk')).toEqual([]);
    await r.unmount();
    setSingleKeys(true);
    r = await opened(state);
    expect(r.all('.palk kbd').map((k) => k.textContent)).toContain('r');
  });

  it('gives a row of Runs its key from the table, and the sidebar’s row none, having nothing to select', () => {
    const runs = [{ runId: 'RUNONE', parentRunId: null, startedAt: 1, mode: 'record', status: 'completed' }];
    const row = (o: Partial<Parameters<typeof runRowScope>[1]>) =>
      runRowScope(runs[0] as never, { runs: runs as never, toast: () => undefined, ...o })
        .items()
        .map((x) => [x.label, x.key]);
    expect(row({ pick: () => undefined, pickKey: keyColumn('rowPick') })).toContainEqual(['Select run', 'x']);
    expect(row({}).map((x) => x[0])).toEqual(['Open run', 'Copy ID']);
  });
});

describe('the parent’s crumb', () => {
  it('says p as the keys’ table has it, and none while single keys are off', () => {
    for (const on of [true, false]) {
      setSingleKeys(on);
      expect(parentCrumbKey(on)['aria-keyshortcuts']).toBe(shortcut('parent')['aria-keyshortcuts']);
    }
    setSingleKeys(true);
    expect(parentCrumbKey(true)).toEqual({ 'aria-keyshortcuts': 'p' });
  });
});

describe('the help menu’s Keyboard shortcuts row', () => {
  it('shows ? as the keys’ table has it, and none while single keys are off', () => {
    for (const on of [true, false]) {
      setSingleKeys(on);
      expect(helpRowKey(on) ?? undefined).toBe(shortcut('help')['aria-keyshortcuts']);
    }
    setSingleKeys(true);
    expect(helpRowKey(true)).toBe(keyColumn('help'));
  });
});

describe('a move between pages', () => {
  /** Runs, a run, and what the shell draws around them, the route read as the shell reads it. */
  function Routed() {
    const route = useRoute();
    return createElement(
      AppContext.Provider,
      { value: app() },
      createElement('nav', {}, createElement('a', { href: '#/runs', id: 'side' }, 'Runs')),
      createElement('main', { id: 'view', tabIndex: -1 }, createElement('h1', { ref: headingRef }, route.page === 'run' ? route.id : route.page), route.page === 'runs' ? createElement(List) : createElement('a', { href: '#/run/B', id: 'other' }, 'Run B')),
      createElement(Keyboard),
    );
  }
  const moved = (to: string) => act(async () => void (location.hash = to));

  it('gives the new page’s heading the focus, a first load nothing, and a replace nothing', async () => {
    r = await render(createElement(Routed));
    expect(r.focused().tagName).not.toBe('H1');
    await moved('#/run/A/2');
    expect(r.focused().textContent).toBe('A');
    await r.focus(r.one('#other'));
    // A call picked in the same run stays on the page: the focus stays too.
    await moved('#/run/A/3');
    expect(r.focused().getAttribute('id')).toBe('other');
  });

  it('goes back on Esc to the row you left, in focus', async () => {
    r = await render(createElement(Routed));
    await r.press('j');
    await r.press('j');
    await r.press('Enter');
    expect(location.hash).toBe('#/run/B');
    expect(r.focused().textContent).toBe('B');
    await r.press('Escape');
    expect(location.hash).toBe('#/runs');
    expect(rowInFocus()).toBe('#/run/B');
    expect(krows()).toEqual(['#/run/B']);
  });

  it('goes up to the crumbs’ parent from a page opened cold', async () => {
    addressBar('#/run/Z');
    r = await render(createElement(Routed));
    await r.press('Escape');
    expect(location.hash).toBe('#/runs');
    expect(r.focused().tagName).toBe('H1');
  });

  /** Changes › Verdicts, a row per revision leading to its page, and a revision's page, the route read as the shell reads it. */
  function Verdicts() {
    const route = useRoute();
    const rev = route.page === 'changes' ? route.id : null;
    const list = createElement(List, { to: (x: Item) => href.changes(x.id) });
    return createElement(AppContext.Provider, { value: app() }, createElement('main', { id: 'view', tabIndex: -1 }, createElement('h1', { ref: headingRef }, rev ?? 'Verdicts'), rev ? null : list), createElement(Keyboard));
  }

  it('goes up from a revision’s page opened cold to Verdicts, the revision’s row in focus', async () => {
    addressBar('#/changes/verdicts/B');
    r = await render(createElement(Verdicts));
    await r.press('Escape');
    expect(location.hash).toBe('#/changes');
    expect(rowInFocus()).toBe('#/changes/verdicts/B');
    expect(krows()).toEqual(['#/changes/verdicts/B']);
  });

  it('counts a replace as no move, and the page it settles on as the page', async () => {
    addressBar('#/run/ABC');
    r = await render(createElement(Routed));
    await r.focus(r.one('#other'));
    await act(async () => navigate('#/run/ABCDEF', true));
    expect(r.focused().getAttribute('id')).toBe('other');
    // A link inside the run its short id settled on is a step within it.
    await moved('#/run/ABCDEF/2');
    expect(r.focused().getAttribute('id')).toBe('other');
  });

  it('goes up to a run’s parent where its detail named one, and on to Runs', async () => {
    addressBar('#/run/KID');
    noteParent(['KID'], 'PARENT');
    r = await render(createElement(Routed));
    await r.press('Escape');
    expect(location.hash).toBe('#/run/PARENT');
    await r.press('Escape');
    expect(location.hash).toBe('#/runs');
  });

  it('adds nothing to the way back for a step along a list, so Esc lands on the run you stepped to', async () => {
    r = await render(createElement(Routed));
    await r.press('j');
    await r.press('Enter');
    expect(location.hash).toBe('#/run/A');
    stepsSideways();
    await moved('#/run/C');
    await r.press('Escape');
    expect(location.hash).toBe('#/runs');
    expect(rowInFocus()).toBe('#/run/C');
  });

  it('adds nothing for opening a run above this one, and cuts back to a page it passed', async () => {
    noteParent(['B'], 'A');
    r = await render(createElement(Routed));
    await r.press('j');
    await r.press('j');
    await r.press('Enter');
    expect(location.hash).toBe('#/run/B');
    await moved('#/run/A');
    await r.press('Escape');
    expect(location.hash).toBe('#/runs');
    await r.press('j');
    await r.press('Enter');
    await moved('#/run/Q');
    await moved('#/run/C');
    await moved('#/run/Q');
    // Q was on the way back: it is cut to there, and goes on from B, never round again.
    await r.press('Escape');
    expect(location.hash).toBe('#/run/B');
    await r.press('Escape');
    expect(location.hash).toBe('#/runs');
  });

  it('comes back to the link you left from where no row holds it, focused', async () => {
    addressBar('#/run/A');
    r = await render(createElement(Routed));
    await r.click(r.one('#other'));
    await moved('#/run/B');
    expect(r.focused().textContent).toBe('B');
    await r.press('Escape');
    expect(location.hash).toBe('#/run/A');
    expect(r.focused().getAttribute('id')).toBe('other');
  });

  it('with no link noted, comes back to a link that leads to the page it left, before the heading', async () => {
    addressBar('#/run/A');
    r = await render(createElement(Routed));
    await moved('#/run/B');
    await r.press('Escape');
    expect(location.hash).toBe('#/run/A');
    expect(r.focused().getAttribute('id')).toBe('other');
  });

  it('takes the focus from a control of the page it left, the heading kept', async () => {
    r = await render(createElement(Routed));
    await moved('#/run/A');
    await r.focus(r.one('#other'));
    await moved('#/run/B');
    expect(r.focused().textContent).toBe('B');
  });

  /** A page whose heading comes once its read has answered, the shell's link and a menu's button beside it. */
  function Late() {
    const route = useRoute();
    const [came, setCame] = useState(false);
    arrive = () => setCame(true);
    return createElement(
      AppContext.Provider,
      { value: app() },
      createElement('div', { id: 'app' }, createElement('nav', {}, createElement('a', { href: '#/runs', id: 'side' }, 'Runs'), createElement(ShareMenu)), createElement('main', { id: 'view', tabIndex: -1 }, route.page === 'run' && came ? createElement('h1', { ref: headingRef }, route.id) : createElement('p', {}, 'Loading'))),
      createElement(OverlaySlots),
      createElement(Keyboard),
    );
  }
  let arrive!: () => void;

  it('leaves the focus where you moved it while the page comes', async () => {
    r = await render(createElement(Late));
    await moved('#/run/A');
    await r.focus(r.one('#side'));
    await act(async () => arrive());
    expect(r.one('h1').textContent).toBe('A');
    expect(r.focused().getAttribute('id')).toBe('side');
  });

  it('gives the heading the focus as it comes, with the focus left alone', async () => {
    r = await render(createElement(Late));
    await moved('#/run/A');
    expect(r.focused().getAttribute('id')).toBe('view');
    await act(async () => arrive());
    expect(r.focused().tagName).toBe('H1');
  });

  it('leaves a menu opened while the page comes its focus, the heading arriving behind it', async () => {
    const changed = watchThePage();
    r = await render(createElement(Late));
    await moved('#/run/A');
    await r.click(r.one('#share'));
    await r.until('the menu to take the focus', () => r!.focused().textContent === 'HTML file');
    expect(r.focused().closest('#menu')).not.toBeNull();
    await act(async () => arrive());
    await changed();
    expect(r.focused().textContent).toBe('HTML file');
  });

  it('leaves a menu opened after Esc went up its focus, and closing it hands the focus to its button', async () => {
    const changed = watchThePage();
    addressBar('#/run/FORK');
    noteParent(['FORK'], 'PARENT');
    function Up() {
      const route = useRoute();
      return createElement(
        AppContext.Provider,
        { value: app() },
        createElement('div', { id: 'app' }, createElement('main', { id: 'view', tabIndex: -1 }, createElement('h1', { ref: headingRef }, route.page === 'run' ? route.id : route.page), createElement(ShareMenu))),
        createElement(OverlaySlots),
        createElement(Keyboard),
      );
    }
    r = await render(createElement(Up));
    await r.press('Escape');
    expect(location.hash).toBe('#/run/PARENT');
    expect(r.focused().tagName).toBe('H1');
    await r.click(r.one('#share'));
    await r.until('the menu to take the focus', () => r!.focused().textContent === 'HTML file');
    await changed();
    expect(r.focused().textContent).toBe('HTML file');
    await r.press('Escape');
    expect(r.focused().getAttribute('id')).toBe('share');
    await changed();
    expect(r.focused().getAttribute('id')).toBe('share');
  });
});

describe('the sidebar’s runs', () => {
  const run = (id: string, startedAt: number) => ({ runId: id, parentRunId: null, mode: 'record', status: 'completed', label: 'recording', divergence: null, command: 'node a.mjs', codeVersion: null, startedAt, endedAt: startedAt + 1, calls: 1, spent: 0, saved: 0, captured: 0, imported: false, labels: [], about: { text: id, from: 'user' } }) as unknown as RunListItem;
  const RUNS = [run('RUNONE', 3), run('RUNTWO', 2), run('RUNTHREE', 1)];
  const keyed = (id: string) => `#/run/${id}`;

  function Side({ keys, setPalette }: { keys: (e: unknown) => boolean; setPalette: (on: boolean) => void }) {
    return createElement(
      AppContext.Provider,
      { value: app({ runKeys: { current: keys }, setPalette }) },
      createElement('aside', { id: 'side' }, createElement(RecentRuns, { runs: RUNS, current: null, loading: false, rowActions: (x: RunListItem) => ({ name: x.runId, items: () => [] }) })),
      createElement('main', { id: 'view', tabIndex: -1 }, createElement('h1', {}, 'A run')),
      createElement(Keyboard),
    );
  }

  it('owns j and k and the arrows with the focus on one, ahead of a run’s, each staying its own Tab stop', async () => {
    const keys = vi.fn(() => true);
    r = await render(createElement(Side, { keys, setPalette: () => undefined }));
    const first = r.all('a.run')[0];
    await r.focus(first);
    await r.press('j');
    expect(rowInFocus()).toBe(keyed('RUNTWO'));
    await r.press('ArrowDown');
    expect(rowInFocus()).toBe(keyed('RUNTHREE'));
    await r.press('k');
    expect(rowInFocus()).toBe(keyed('RUNTWO'));
    expect(keys).not.toHaveBeenCalled();
    expect(r.all('.krow')).toEqual([]);
    expect(r.all('a.run').every((a) => a.getAttribute('tabindex') === null)).toBe(true);
  });

  it('gives `[` and `]` their order when Runs never showed the run, attempts left out', () => {
    expect(recentRunIds([...RUNS, { ...run('ATTEMPT', 9), attemptKind: 'repeat', parentRunId: 'RUNONE' }])).toEqual(['RUNONE', 'RUNTWO', 'RUNTHREE']);
  });

  it('leaves the keys to the page with the focus elsewhere', async () => {
    const keys = vi.fn(() => true);
    r = await render(createElement(Side, { keys, setPalette: () => undefined }));
    await r.press('j');
    expect(keys).toHaveBeenCalledOnce();
  });

  it('lets go to the heading on Esc, before it goes up', async () => {
    addressBar('#/run/RUNONE');
    r = await render(createElement(Side, { keys: () => false, setPalette: () => undefined }));
    await r.focus(r.all('a.run')[1]);
    await r.press('Escape');
    expect(r.focused().tagName).toBe('H1');
    expect(location.hash).toBe('#/run/RUNONE');
  });
});

describe('the way back’s rules', () => {
  const from: TrailStop = { sig: 'runs', hash: '#/runs', row: '#/run/A', link: null };
  const to = (hash: string) => parseRoute(hash);

  it('counts a call, a view, a step, a filter and a pick as the same page, a Settings tab as another', () => {
    expect(pageSig(to('#/run/ABC/3/turns'))).toBe(pageSig(to('#/run/ABC')));
    expect(pageSig(to('#/fixes/fx1/blame'))).toBe(pageSig(to('#/fixes/fx1')));
    expect(pageSig(to('#/fixes'))).not.toBe(pageSig(to('#/fixes/fx1')));
    expect(pageSig(to('#/settings/tools'))).not.toBe(pageSig(to('#/settings/record')));
    expect(pageSig(to('#/runs?q=a'))).toBe(pageSig(to('#/runs')));
    expect(pageSig(to('#/compare/a/b'))).toBe(pageSig(to('#/compare')));
    expect(samePage('run:ABC', 'run:ABCDEF')).toBe(true);
    expect(samePage('run:ABC', 'run:ABD')).toBe(false);
  });

  it('counts Verdicts at either address as one page, and a revision’s page, a session’s tab and Compare each as another', () => {
    expect(pageSig(to('#/changes'))).toBe(pageSig(to('#/changes/verdicts')));
    expect(pageSig(to('#/changes/verdicts/d2e8a1f'))).not.toBe(pageSig(to('#/changes')));
    expect(pageSig(to('#/changes/verdicts/d2e8a1f'))).not.toBe(pageSig(to('#/changes/verdicts/c91d0f4')));
    expect(pageSig(to('#/changes/decisions'))).not.toBe(pageSig(to('#/changes')));
    expect(pageSig(to('#/compare'))).not.toBe(pageSig(to('#/changes')));
    // A revision's page is left the way you came, as a run's is; the tabs' lists and a session's tab aren't.
    expect(isDetail(to('#/changes/verdicts/d2e8a1f'))).toBe(true);
    expect(isDetail(to('#/changes'))).toBe(false);
    expect(isDetail(to('#/changes/decisions/dc-01M5000000000000000000000A'))).toBe(false);
  });

  it('empties on a page that is no detail page, adds nothing by Esc or along a list, and cuts back to a page it passed', () => {
    const trail = [from, { ...from, sig: 'run:A', hash: '#/run/A' }];
    expect(isDetail(to('#/runs'))).toBe(false);
    expect(isDetail(to('#/fixes'))).toBe(false);
    expect(isDetail(to('#/fixes/fx1'))).toBe(true);
    expect(trailAfter(trail, { to: to('#/runs'), how: null, above: false, from })).toEqual([]);
    expect(trailAfter(trail, { to: to('#/run/B'), how: 'up', above: false, from })).toBe(trail);
    expect(trailAfter(trail, { to: to('#/run/B'), how: 'side', above: false, from })).toBe(trail);
    expect(trailAfter(trail, { to: to('#/run/A'), how: null, above: false, from })).toEqual([from]);
    expect(trailAfter(trail, { to: to('#/run/B'), how: null, above: true, from })).toBe(trail);
    expect(trailAfter(trail, { to: to('#/run/B'), how: null, above: false, from })).toHaveLength(3);
  });

  it('lands on the row you left if it leads there, else the first that does, else the one you left', () => {
    const keys = ['#/run/A', '#/run/B', 'x'];
    expect(backRowKey(keys, 'run:B', '#/run/B')).toBe('#/run/B');
    expect(backRowKey(keys, 'run:B', 'x')).toBe('#/run/B');
    expect(backRowKey(keys, 'run:Q', 'x')).toBe('x');
    expect(backRowKey(keys, 'run:Q', null)).toBeNull();
  });
});

describe('Tabs', () => {
  function Three({ onKey }: { onKey?: () => void }) {
    const [v, setV] = useState<'a' | 'b' | 'c'>('b');
    return createElement('div', { onKeyDown: onKey }, createElement(Tabs<'a' | 'b' | 'c'>, { label: 'Things', idPrefix: 't', panelId: 'p', value: v, onChange: setV, items: [{ key: 'a', label: 'A', count: 3 }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }] }));
  }
  const selected = () => r!.all('[role="tab"]').filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.getAttribute('id'));

  it('has one Tab stop, and reads a count apart from its name', async () => {
    r = await render(createElement(Three));
    expect(r.all('[role="tab"]').map((t) => t.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
    expect(r.one('#t-a').getAttribute('aria-label')).toBe('A 3');
    expect(r.one('#t-a').getAttribute('aria-controls')).toBe('p');
  });

  it('moves with the arrows round the ends, Home and End, keeping the focus and the keys from the page', async () => {
    const onKey = vi.fn();
    r = await render(createElement(Three, { onKey }));
    await r.focus(r.one('#t-b'));
    await r.press('ArrowRight');
    expect(selected()).toEqual(['t-c']);
    expect(r.focused().getAttribute('id')).toBe('t-c');
    await r.press('ArrowRight');
    expect(selected()).toEqual(['t-a']);
    await r.press('ArrowLeft');
    expect(selected()).toEqual(['t-c']);
    await r.press('Home');
    expect(r.focused().getAttribute('id')).toBe('t-a');
    await r.press('End');
    expect(r.focused().getAttribute('id')).toBe('t-c');
    expect(onKey).not.toHaveBeenCalled();
    const held = await r.press('ArrowLeft', { metaKey: true });
    expect(held.defaultPrevented).toBe(false);
    expect(selected()).toEqual(['t-c']);
  });

  it('never pulls the focus back later for Home on the first tab or End on the last', async () => {
    let set!: (v: 'a' | 'b' | 'c') => void;
    function Beside() {
      const [v, setV] = useState<'a' | 'b' | 'c'>('a');
      set = setV;
      return createElement('div', {}, createElement(Tabs<'a' | 'b' | 'c'>, { label: 'Things', idPrefix: 't', value: v, onChange: setV, items: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }] }), createElement('button', { type: 'button', id: 'away' }, 'Away'));
    }
    r = await render(createElement(Beside));
    await r.focus(r.one('#t-a'));
    await r.press('Home');
    await r.focus(r.one('#away'));
    await act(async () => set('c'));
    await act(async () => set('a'));
    expect(r.focused().getAttribute('id')).toBe('away');
    await act(async () => set('c'));
    await r.focus(r.one('#t-c'));
    await r.press('End');
    await r.focus(r.one('#away'));
    await act(async () => set('a'));
    await act(async () => set('c'));
    expect(r.focused().getAttribute('id')).toBe('away');
  });

  it('forgets a tab reached that another took the place of', async () => {
    let set!: (v: 'a' | 'b' | 'c') => void;
    function Redirects() {
      const [v, setV] = useState<'a' | 'b' | 'c'>('b');
      set = setV;
      return createElement('div', {}, createElement(Tabs<'a' | 'b' | 'c'>, { label: 'Things', idPrefix: 't', value: v, onChange: (to) => setV(to === 'c' ? 'a' : to), items: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }] }), createElement('button', { type: 'button', id: 'away' }, 'Away'));
    }
    r = await render(createElement(Redirects));
    await r.focus(r.one('#t-b'));
    await r.press('End');
    expect(selected()).toEqual(['t-a']);
    await r.focus(r.one('#away'));
    await act(async () => set('c'));
    expect(r.focused().getAttribute('id')).toBe('away');
  });
});

describe('the runs a list notes for `[` and `]`', () => {
  afterEach(() => {
    shownRuns.current = null;
  });
  const deferred = <T,>() => {
    let answer!: (v: T) => void;
    let fail!: (e: Error) => void;
    const promise = new Promise<T>((yes, no) => {
      answer = yes;
      fail = no;
    });
    return { promise, answer, fail };
  };

  it('reads a page once for two presses, lists it once, and ends where the pages end', async () => {
    const page = deferred<{ ids: string[]; next: string | null }>();
    const read = vi.fn(() => page.promise);
    const grew = vi.fn();
    noteShownRuns(['A'], 'p2', read, grew);
    const { more } = shownRuns.current!;
    const both = Promise.all([more!(), more!()]);
    expect(read).toHaveBeenCalledOnce();
    page.answer({ ids: ['B', 'C'], next: null });
    const [one, two] = await both;
    expect(one).toEqual(['A', 'B', 'C']);
    expect(two).toEqual(['A', 'B', 'C']);
    expect(shownRuns.current).toEqual({ ids: ['A', 'B', 'C'], more: null });
    expect(grew).toHaveBeenCalledExactlyOnceWith(3);
    // A press that held the old note reads nothing more.
    expect(await more!()).toEqual(['A', 'B', 'C']);
    expect(read).toHaveBeenCalledOnce();
  });

  it('reads on page by page, and asks again after a page that failed', async () => {
    const read = vi.fn<(cursor: string) => Promise<{ ids: string[]; next: string | null }>>().mockRejectedValueOnce(new Error('no')).mockResolvedValueOnce({ ids: ['B'], next: 'p3' }).mockResolvedValueOnce({ ids: ['C'], next: null });
    noteShownRuns(['A'], 'p2', read);
    await expect(shownRuns.current!.more!()).rejects.toThrow('no');
    expect(shownRuns.current!.ids).toEqual(['A']);
    await shownRuns.current!.more!();
    await shownRuns.current!.more!();
    expect(read.mock.calls.map((c) => c[0])).toEqual(['p2', 'p2', 'p3']);
    expect(shownRuns.current).toEqual({ ids: ['A', 'B', 'C'], more: null });
  });

  it('leaves a list noted since alone when an older one’s page comes', async () => {
    const page = deferred<{ ids: string[]; next: string | null }>();
    const grew = vi.fn();
    noteShownRuns(['A'], 'p2', () => page.promise, grew);
    const reading = shownRuns.current!.more!();
    noteShownRuns(['X', 'Y'], null, () => Promise.reject(new Error('no read')));
    page.answer({ ids: ['B'], next: null });
    await reading;
    expect(shownRuns.current).toEqual({ ids: ['X', 'Y'], more: null });
    expect(grew).not.toHaveBeenCalled();
  });
});
