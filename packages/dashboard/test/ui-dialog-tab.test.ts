import { createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Dialog } from '../ui/components/Dialog.js';
import { MenuItem, Popover, useMenu } from '../ui/components/Popover.js';
import { Keyboard } from '../ui/shell/Keyboard.js';
import { Shortcuts } from '../ui/shell/Shortcuts.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';

/**
 * A modal dialog keeps Tab inside it. The dialogs and the shortcuts say aria-modal, but Tab went on
 * to the page behind them: from Delete run to the strip's cells, where Enter opened another call
 * while the dialog stayed open, and from the shortcuts' Close to the page and the sidebar's links.
 * Rendered with the shell's own key handler, over a page with a link and two cells, as the page has
 * them: without the handler's trap, Tab goes on to them as a browser's does.
 */

function app(over: Partial<AppState> = {}): AppState {
  const base = {
    conn: 'ok',
    exported: false,
    meta: null,
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

/** The page behind the dialog: the sidebar's link, and two of a run's strip cells. */
const page = () => [
  createElement('nav', { key: 'nav' }, createElement('a', { href: '#/runs' }, 'Runs')),
  createElement('main', { key: 'main' }, createElement('button', { type: 'button' }, 'Call 1'), createElement('button', { type: 'button' }, 'Call 2')),
];

/** Where the focus is, as a person sees it: the control's words, or its label. */
function focus(r: Rendered): string {
  const f = r.focused();
  return `${f.tagName.toLowerCase()} ${f.textContent.trim() || f.getAttribute('aria-label') || f.className}`;
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

describe('Tab in a modal dialog', () => {
  it('goes round Delete run’s two buttons, and brings a focus left on the page behind back in', async () => {
    r = await render(
      createElement(AppContext.Provider, { value: app() }, createElement(Keyboard), ...page(), createElement(Dialog, { key: 'dialog', title: 'Delete run', ok: 'Delete run', tone: 'danger', onOk: () => undefined, onClose: () => undefined })),
    );
    // A red action that can't be undone starts on Cancel.
    expect(focus(r)).toBe('button Cancel');
    await r.press('Tab');
    expect(focus(r)).toBe('button Delete run');
    // From the last control to the first, not on to the page.
    await r.press('Tab');
    expect(focus(r)).toBe('button Cancel');
    await r.press('Tab', { shiftKey: true });
    expect(focus(r)).toBe('button Delete run');
    await r.press('Tab', { shiftKey: true });
    expect(focus(r)).toBe('button Cancel');
    await r.press('Tab', { shiftKey: true });
    expect(focus(r)).toBe('button Delete run');
    r.byText('main button', 'Call 2').focus();
    await r.press('Tab');
    expect(focus(r)).toBe('button Cancel');
  });

  it('goes round the shortcuts’ switch and Close, the panel’s only controls, and Esc closes the panel', async () => {
    const setHelp = vi.fn();
    r = await render(createElement(AppContext.Provider, { value: app({ help: true, setHelp }) }, createElement(Keyboard), ...page(), createElement(Shortcuts, { key: 'help', onRun: false })));
    for (let i = 0; i < 2; i++) {
      await r.press('Tab');
      expect(focus(r)).toBe('button Single-key shortcuts');
      await r.press('Tab');
      expect(focus(r)).toBe('button Close');
    }
    await r.press('Tab', { shiftKey: true });
    expect(focus(r)).toBe('button Single-key shortcuts');
    await r.press('Escape');
    expect(setHelp).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('goes round what shows while it asks before discarding an edit', async () => {
    r = await render(
      createElement(AppContext.Provider, { value: app() }, createElement(Keyboard), ...page(), createElement(Dialog, { key: 'dialog', title: 'Rename', ok: 'Rename', onOk: () => undefined, onClose: () => undefined, children: createElement('input', { type: 'text', onChange: () => undefined }) })),
    );
    await r.type(r.one('input'), 'edited');
    await r.press('Escape');
    expect(focus(r)).toBe('button Keep editing');
    await r.press('Tab');
    expect(focus(r)).toBe('button Discard');
    // Round past Cancel and the action, which wait in the footer while it asks.
    await r.press('Tab');
    expect(r.focused().tagName).toBe('INPUT');
    await r.press('Tab', { shiftKey: true });
    expect(focus(r)).toBe('button Discard');
  });

  it('closes a menu in it on Tab, staying in the dialog', async () => {
    function WithMenu() {
      const menu = useMenu();
      return createElement(
        Dialog,
        { title: 'Pack', ok: 'Pack run', onOk: () => undefined, onClose: () => undefined },
        createElement('button', { type: 'button', id: 'more', onClick: (e: { currentTarget: HTMLElement }) => menu.toggle(e.currentTarget) }, 'More'),
        menu.anchor ? createElement(Popover, { anchor: menu.anchor, onClose: menu.close, label: 'More', children: createElement(MenuItem, { label: 'One', onPick: menu.close }) }) : null,
      );
    }
    r = await render(createElement(AppContext.Provider, { value: app() }, createElement(Keyboard), ...page(), createElement(WithMenu, { key: 'dialog' })));
    await r.click(r.one('#more'));
    expect(r.focused().textContent).toBe('One');
    // Esc closes the menu first, and the dialog stays.
    await r.press('Escape');
    expect(focus(r)).toBe('button More');
    expect(r.all('[role="dialog"]')).toHaveLength(1);
    await r.click(r.one('#more'));
    await r.press('Tab');
    expect(r.all('[role="menu"]')).toEqual([]);
    expect(focus(r)).toBe('button Cancel');
  });

  it('leaves Tab to the browser on a page with no dialog open', async () => {
    r = await render(createElement(AppContext.Provider, { value: app() }, createElement(Keyboard), ...page()));
    r.byText('nav a', 'Runs').focus();
    await r.press('Tab');
    expect(focus(r)).toBe('button Call 1');
    await r.press('Tab');
    expect(focus(r)).toBe('button Call 2');
  });
});
