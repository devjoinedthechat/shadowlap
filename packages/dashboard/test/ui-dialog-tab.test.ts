import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '../ui/components/Dialog.js';
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
    closeTopLayer: () => false,
    blockingLayer: () => true,
    runKeys: { current: null },
    registerLayer: () => () => undefined,
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

  it('stays on the shortcuts’ Close, the panel’s only control, and Esc closes the panel', async () => {
    const closeTopLayer = vi.fn(() => true);
    r = await render(createElement(AppContext.Provider, { value: app({ help: true, closeTopLayer }) }, createElement(Keyboard), ...page(), createElement(Shortcuts, { key: 'help', onRun: false })));
    for (let i = 0; i < 3; i++) {
      await r.press('Tab');
      expect(focus(r)).toBe('button Close');
    }
    await r.press('Tab', { shiftKey: true });
    expect(focus(r)).toBe('button Close');
    await r.press('Escape');
    expect(closeTopLayer).toHaveBeenCalledTimes(1);
  });

  it('leaves Tab to the browser on a page with no dialog open', async () => {
    r = await render(createElement(AppContext.Provider, { value: app({ blockingLayer: () => false }) }, createElement(Keyboard), ...page()));
    r.byText('nav a', 'Runs').focus();
    await r.press('Tab');
    expect(focus(r)).toBe('button Call 1');
    await r.press('Tab');
    expect(focus(r)).toBe('button Call 2');
  });
});
