import { act, createElement, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tabs } from '../ui/components/bits.js';
import { backRowKey, isDetail, pageSig, samePage, trailAfter, type TrailStop } from '../ui/focus.js';
import { headingRef } from '../ui/focus-manager.js';
import { useListKeys } from '../ui/list-keys.js';
import { parseRoute } from '../ui/route.js';
import { useRoute } from '../ui/router.js';
import { Keyboard } from '../ui/shell/Keyboard.js';
import { Palette } from '../ui/shell/Palette.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';

/**
 * One list hook for every list a page holds, and the way back Esc takes to it: rows registered as
 * data, drawn `.krow`, walked with j and k, opened, picked, and offered to ⌘K; a page's move handing
 * the focus to its heading or to the row Esc came back for.
 */

function app(over: Partial<AppState> = {}): AppState {
  const base = {
    client: { search: async () => ({ hits: [] }), runsPage: async () => ({ runs: [], total: 0, next: null, chipCounts: {} }) },
    conn: 'ok',
    exported: false,
    meta: null,
    runs: [],
    runCommands: [],
    actionsOff: null,
    hasKind: () => false,
    jobs: [],
    guard: (fn: () => void) => fn(),
    watchJob: () => undefined,
    toast: () => undefined,
    palette: false,
    setPalette: () => undefined,
    help: false,
    setHelp: () => undefined,
    sideOpen: false,
    setSideOpen: () => undefined,
    runKeys: { current: null },
  };
  return { ...base, ...over } as unknown as AppState;
}

/** An address bar as a browser's: a link followed sets it, and the router hears it. */
function addressBar(start: string) {
  let hash = start;
  const location = {
    pathname: '/',
    search: '',
    get hash() {
      return hash;
    },
    set hash(to: string) {
      hash = to;
      window.dispatchEvent(new Event('hashchange'));
    },
  };
  vi.stubGlobal('location', location);
  vi.stubGlobal('history', { state: null, replaceState: (_s: unknown, _t: string, url: string) => void (hash = url.slice(url.indexOf('#'))) });
  return location;
}

interface Item {
  id: string;
}
const ITEMS: Item[] = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
const keyOf = (x: Item) => `#/run/${x.id}`;

/** A list as a page draws one: its rows, the one in focus `.krow`, a checkbox in each where it picks. */
function List({ rows = ITEMS, picks, drawn, show, actions }: { rows?: Item[]; picks?: (x: Item) => void; drawn?: number; show?: (i: number) => void; actions?: (x: Item) => { name: string; items: () => Array<{ label: string; hint: string; run: () => void }> } | null }) {
  const root = useRef<HTMLUListElement>(null);
  const at = useListKeys({ rows, keyOf, root, open: (x) => (location.hash = keyOf(x)), pick: picks ?? null, actions: actions ?? null, show: show ?? null });
  return createElement(
    'ul',
    { ref: root },
    rows.slice(0, drawn ?? rows.length).map((x) => createElement('li', { key: x.id, 'data-rowkey': keyOf(x), className: at === keyOf(x) ? 'krow' : undefined }, createElement('input', { type: 'checkbox', 'aria-label': x.id }), x.id)),
  );
}

let r: Rendered | null = null;
beforeEach(() => {
  addressBar('#/runs');
});
afterEach(async () => {
  await r?.unmount();
  r = null;
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
    await act(async () => set([ITEMS[0]!, ITEMS[2]!]));
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

  it('take no key from a field, and stop while a dialog is open', async () => {
    r = await render(page([createElement('input', { key: 'f', type: 'search', id: 'runsQuery' }), createElement(List, { key: 'l' })]));
    await r.press('j', {}, r.one('#runsQuery'));
    expect(krows()).toEqual([]);
    // / goes to the page's own filter, Esc in it leaves it for the row in focus.
    await r.press('j');
    await r.press('/');
    expect(r.focused().getAttribute('id')).toBe('runsQuery');
    const esc = await r.press('Escape');
    expect(esc.defaultPrevented).toBe(true);
    expect(rowInFocus()).toBe('#/run/A');
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

  function Opener() {
    const [open, setOpen] = useState(false);
    return createElement(AppContext.Provider, { value: app({ palette: open, setPalette: setOpen }) }, createElement('main', { id: 'view' }, createElement('button', { type: 'button', id: 'other' }, 'Other'), createElement(List, { actions })), createElement(Keyboard), createElement(Palette, { route: { page: 'runs' } }));
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

  it('leaves the focus where you moved it while the page comes', async () => {
    r = await render(createElement(Routed));
    await moved('#/run/A');
    await r.focus(r.one('#other'));
    await moved('#/run/B');
    expect(r.focused().textContent).toBe('B');
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
});
