import { readFileSync } from 'node:fs';
import { createElement, useState, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '../ui/api.js';
import { Dialog } from '../ui/components/Dialog.js';
import { MenuItem, Popover, useMenu } from '../ui/components/Popover.js';
import type { Route } from '../ui/route.js';
import { ExpiredCard } from '../ui/shell/Connection.js';
import { Keyboard } from '../ui/shell/Keyboard.js';
import { Palette } from '../ui/shell/Palette.js';
import { SkipLink } from '../ui/shell/SkipLink.js';
import { setSingleKeys } from '../ui/shortcuts.js';
import { AppContext, type AppState } from '../ui/state.js';
import { sheet } from './css-sheet.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';

/**
 * Where the keyboard's focus goes: a skip link past the top bar and the sidebar, focus rings drawn
 * whole inside scrolling panes, the palette as ARIA's combobox that hands the focus back when it
 * closes, and every overlay keeping or returning the focus. Rendered with the shell's own key
 * handler, as a person presses the keys; the real browser checks the same on the pages
 * (browser/a11y.spec.ts).
 */

function app(over: Partial<AppState> = {}): AppState {
  const base = {
    client: { search: async () => ({ hits: [] }), runsPage: async () => ({ runs: [], total: 0, next: null, chipCounts: {} }) } as unknown as Client,
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

const OVERVIEW: Route = { page: 'overview' };

/** Where the focus is, as a person sees it: the control's words, or its label, or its id. */
function focus(r: Rendered): string {
  const f = r.focused();
  return `${f.tagName.toLowerCase()} ${f.textContent.trim() || f.getAttribute('aria-label') || f.getAttribute('id') || f.className}`.trim();
}

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

beforeAll(() => {
  // No layout here: a menu is placed against a window of this size.
  Object.assign(globalThis, { innerWidth: 1440, innerHeight: 900 });
});

// ---- focus rings in scrolling panes

const css = sheet().replace(/\/\*[\s\S]*?\*\//g, '');

describe('a focus ring in a pane that scrolls', () => {
  /** The panes the stylesheet scrolls, and the panes it draws rings inside. */
  const scrolling = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => /overflow(?:-[xy])?\s*:\s*(?:auto|scroll)/.test(m[2])).flatMap((m) => m[1].split(',').map((x) => x.trim()));
  const inset = /:is\(([^)]*)\)\s*:focus-visible\s*\{\s*outline-offset:\s*-2px;?\s*\}/.exec(css)?.[1]?.split(',').map((x) => x.trim()) ?? [];
  /** Panes that keep a padding clear of every ring, so a ring drawn outside a control shows whole. */
  const PADDED: Record<string, string> = { '.page': 'every page pads its content', body: 'the page itself, on a phone' };

  it('is drawn inside the control in every pane the stylesheet scrolls', () => {
    expect(scrolling.length).toBeGreaterThan(15);
    const covered = (sel: string) => inset.includes(sel) || inset.some((x) => /^\.[\w-]+$/.test(x) && (sel.split(/\s+/).at(-1)!.split(/(?=[.:[])/).includes(x) || sel.startsWith(`${x}.`)));
    expect(scrolling.filter((sel) => !PADDED[sel] && !covered(sel))).toEqual([]);
  });
});

// ---- the skip link

describe('Skip to content', () => {
  it('is the first stop for Tab, and takes the focus past the top bar and the sidebar to the page', async () => {
    r = await render(
      createElement(
        'div',
        null,
        createElement(SkipLink),
        createElement('header', null, createElement('a', { href: '#/' }, 'Shadowlap'), createElement('button', { type: 'button' }, 'Keyboard shortcuts')),
        createElement('nav', null, createElement('a', { href: '#/runs' }, 'Runs')),
        createElement('main', { id: 'view', tabIndex: -1 }, createElement('div', { className: 'page', tabIndex: -1 }, createElement('button', { type: 'button' }, 'Replay'))),
      ),
    );
    await r.press('Tab');
    expect(focus(r)).toBe('a Skip to content');
    const skip = r.focused();
    expect(skip.getAttribute('href')).toBe('#view');
    await r.click(skip);
    expect(r.focused().className).toBe('page');
    await r.press('Tab');
    expect(focus(r)).toBe('button Replay');
  });

  it('takes it to the page’s heading where it has one, as a target Tab never stops at', async () => {
    r = await render(createElement('div', {}, createElement(SkipLink), createElement('main', { id: 'view', tabIndex: -1 }, createElement('h1', {}, 'Runs'), createElement('button', { type: 'button' }, 'Replay'))));
    await r.click(r.one('a.skip'));
    expect(r.focused().tagName).toBe('H1');
    expect(r.focused().getAttribute('tabindex')).toBe('-1');
    await r.press('Tab');
    expect(focus(r)).toBe('button Replay');
  });

  it('never scrolls for a move: the manager focuses quietly, but for a row or a link asked for', () => {
    const source = readFileSync(new URL('../ui/focus-manager.ts', import.meta.url), 'utf8');
    expect(source.match(/\.focus\(/g)).toEqual(['.focus(']);
    expect(source).toContain('el.focus({ preventScroll: true })');
  });

  it('keeps no ring round a heading that took the focus as -1', () => {
    const css = readFileSync(new URL('../ui/css/base.css', import.meta.url), 'utf8');
    expect(css).toContain('#view h1[tabindex="-1"]:focus { outline: none; }');
  });
});

// ---- the palette

/** The palette as the shell opens it, from a button, with the shell's key handler. */
function PaletteOpener({ base }: { base: AppState }) {
  const [open, setOpen] = useState(false);
  return createElement(
    AppContext.Provider,
    { value: { ...base, palette: open, setPalette: setOpen } },
    createElement('button', { type: 'button', id: 'opener', onClick: () => setOpen(true) }, 'Search or jump to'),
    createElement(Keyboard),
    createElement(Palette, { route: OVERVIEW }),
  );
}

describe('Search or jump to', () => {
  it('shows a row’s own key while single keys are on, else ↵ on the row Enter opens', async () => {
    r = await render(createElement(PaletteOpener, { base: app() }));
    await r.click(r.one('#opener'));
    await r.until('the palette', () => r!.all('.palit').length > 0);
    const keys = (label: string) => r!.all('.palit').find((el) => el.querySelector('.pl')!.textContent === label)!.querySelectorAll('.palk kbd').map((k) => k.textContent);
    expect(keys('Runs')).toEqual(['g', 'r']);
    expect(keys('Keyboard shortcuts')).toEqual(['?']);
    expect(keys('Add project…')).toEqual([]);
    expect(r.one('.palit.on .palk kbd').textContent).toBeTruthy();
    await r.unmount();
    setSingleKeys(false);
    r = await render(createElement(PaletteOpener, { base: app() }));
    await r.click(r.one('#opener'));
    await r.until('the palette', () => r!.all('.palit').length > 0);
    expect(r.all('.palk')).toEqual([]);
    expect(r.one('.palit.on .kbd').textContent).toContain('↵');
    setSingleKeys(true);
  });

  it('is a combobox: the field keeps the focus and names the active option, which ↓ and ↑ move', async () => {
    r = await render(createElement(PaletteOpener, { base: app() }));
    await r.click(r.one('#opener'));
    const field = r.one('.palin input');
    expect(r.focused()).toBe(field);
    expect(field.getAttribute('role')).toBe('combobox');
    expect(field.getAttribute('aria-autocomplete')).toBe('list');
    expect(field.getAttribute('aria-expanded')).toBe('true');
    expect(field.getAttribute('aria-controls')).toBe('palList');
    const active = () => r!.one(`#${field.getAttribute('aria-activedescendant')}`);
    expect(active().getAttribute('role')).toBe('option');
    expect(active().getAttribute('aria-selected')).toBe('true');
    expect(active().className).toContain('on');
    const first = active().getAttribute('id');
    await r.press('ArrowDown');
    expect(r.focused()).toBe(field);
    expect(active().getAttribute('id')).not.toBe(first);
    expect(r.all('[role="option"][aria-selected="true"]')).toEqual([active()]);
    await r.press('ArrowUp');
    expect(active().getAttribute('id')).toBe(first);
    // Each group of options is a group of the listbox, its heading for the eye alone.
    const listbox = r.one('#palList');
    expect(listbox.getAttribute('role')).toBe('listbox');
    for (const option of r.all('[role="option"]')) expect((option.parentNode as FakeElement).getAttribute('role')).toBe('group');
    expect(r.all('.palg').every((h) => h.getAttribute('aria-hidden') === 'true')).toBe(true);
    // No option is a stop for Tab: the field stays its one stop.
    await r.press('Tab');
    expect(r.focused()).toBe(field);
  });

  it('hands the focus back to what had it when Esc closes it', async () => {
    r = await render(createElement(PaletteOpener, { base: app() }));
    await r.click(r.one('#opener'));
    expect(r.focused()).toBe(r.one('.palin input'));
    await r.press('Escape');
    expect(r.all('.palette')).toEqual([]);
    expect(focus(r)).toBe('button Search or jump to');
  });

  it('says when nothing matches without an empty listbox', async () => {
    r = await render(createElement(PaletteOpener, { base: app() }));
    await r.click(r.one('#opener'));
    const field = r.one('.palin input');
    await r.type(field, 'zzzz nothing like it');
    expect(r.all('[role="listbox"]')).toEqual([]);
    expect(field.getAttribute('aria-expanded')).toBe('false');
    expect(field.hasAttribute('aria-activedescendant')).toBe(false);
    expect(r.one('.pallist [role="status"]').textContent).toContain('Nothing matches');
  });
});

// ---- menus, dialogs and the card a refused link shows

function MenuOpener() {
  const menu = useMenu();
  return createElement(
    'div',
    null,
    createElement('button', { type: 'button', id: 'share', onClick: (e: { currentTarget: HTMLElement }) => menu.toggle(e.currentTarget) }, 'Share'),
    menu.open && menu.anchor
      ? createElement(Popover, { anchor: menu.anchor, onClose: menu.close, label: 'Share', children: [createElement(MenuItem, { key: 'html', label: 'HTML file', onPick: menu.close }), createElement(MenuItem, { key: 'har', label: 'HAR', onPick: menu.close })] })
      : null,
    createElement('button', { type: 'button', id: 'after' }, 'Delete'),
  );
}

describe('a menu', () => {
  it('closes on Tab and hands the focus to its button, so Tab goes on from there', async () => {
    r = await render(createElement(AppContext.Provider, { value: app() }, createElement(Keyboard), createElement(MenuOpener)));
    await r.click(r.one('#share'));
    await r.until('the menu to take the focus', () => focus(r!) === 'button HTML file');
    await r.press('Tab');
    expect(r.all('[role="menu"]')).toEqual([]);
    expect(focus(r)).toBe('button Delete');
  });

  it('hands the focus back to its button when Esc closes it', async () => {
    r = await render(createElement(AppContext.Provider, { value: app() }, createElement(Keyboard), createElement(MenuOpener)));
    await r.click(r.one('#share'));
    await r.until('the menu to take the focus', () => focus(r!) === 'button HTML file');
    await r.press('Escape');
    expect(r.all('[role="menu"]')).toEqual([]);
    expect(focus(r)).toBe('button Share');
  });
});

/** A dialog opened from an item of a menu, which is gone by the time the dialog closes. */
function DialogFromMenu({ children }: { children?: ReactNode }) {
  const [asked, setAsked] = useState<'no' | 'open' | 'closed'>('no');
  return createElement(
    'div',
    null,
    createElement('main', { id: 'view', tabIndex: -1 }, children, asked === 'no' ? createElement('button', { type: 'button', role: 'menuitem', onClick: () => setAsked('open') }, 'Delete…') : null),
    asked === 'open' ? createElement(Dialog, { title: 'Delete run', ok: 'Delete run', tone: 'danger', onOk: () => setAsked('closed'), onClose: () => setAsked('closed') }) : null,
  );
}

describe('a dialog', () => {
  it('hands the focus to the page when what opened it is gone', async () => {
    r = await render(createElement(AppContext.Provider, { value: app() }, createElement(Keyboard), createElement(DialogFromMenu)));
    await r.click(r.byText('button', 'Delete…'));
    expect(focus(r)).toBe('button Cancel');
    await r.press('Escape');
    expect(r.all('[role="dialog"]')).toEqual([]);
    expect(r.focused().getAttribute('id')).toBe('view');
  });
});

describe('the card a refused link shows', () => {
  it('puts the focus on its way out and takes the page behind it out of reach', async () => {
    r = await render(
      createElement(
        AppContext.Provider,
        { value: app({ conn: 'expired' }) },
        createElement('div', { className: 'app', id: 'app' }, createElement('a', { href: '#/runs' }, 'Runs'), createElement('button', { type: 'button' }, 'Replay')),
        createElement(ExpiredCard),
      ),
    );
    expect(r.one('[role="alertdialog"]').getAttribute('aria-modal')).toBe('true');
    expect(focus(r)).toBe('button Paste the new link');
    expect(r.one('#app').hasAttribute('inert')).toBe(true);
    for (let i = 0; i < 4; i++) {
      await r.press('Tab');
      expect(r.one('#app').contains(r.focused())).toBe(false);
    }
  });
});
