import { act, createElement, useState, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Dialog } from '../ui/components/Dialog.js';
import { JobDrawer } from '../ui/components/Drawer.js';
import { HoverCardLayer, hideTip, tipCard } from '../ui/components/HoverCard.js';
import { MenuItem, useMenu } from '../ui/components/Popover.js';
import { menuSheetRect } from '../ui/overlays/menu-store.js';
import { modalOpen, onOverlayChange, overlayOpen } from '../ui/overlays/modal-store.js';
import { navigate, useRoute } from '../ui/router.js';
import { ImportDialog } from '../ui/runspage/ImportDialog.js';
import type { AppState, WatchedJob } from '../ui/state.js';
import type { JobView } from '../ui/types.js';
import { media, menuOf, noMedia, shell, words } from './ui-overlays-page.js';
import { render, type Rendered } from './ui-render.js';

/**
 * What goes on around an open overlay, rendered with the shell's own key handler and its three slots:
 * the address moving on under it, Esc going through what is open in its one order, what stays at the
 * window's foot reading a phone's sheet and hearing a menu or a modal open and close, and an edit no
 * field holds. Overlays themselves are test/ui-overlays.test.ts's.
 */

const g = globalThis as Record<string, unknown>;

let r: Rendered | null = null;
afterEach(async () => {
  hideTip();
  await r?.unmount();
  r = null;
  delete g.location;
  delete g.history;
  noMedia();
});

beforeAll(() => {
  Object.assign(globalThis, { innerWidth: 1440, innerHeight: 900 });
});

/** The address bar as a browser has it: set, it says so in a task of its own (`moved` here, as a test waits for that task); a replace says nothing. */
function addressBar(start: string) {
  const bar = {
    pathname: '/',
    search: '',
    hash: start,
  };
  Object.assign(g, { location: bar, history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => (bar.hash = url.slice(url.indexOf('#'))) } });
  return {
    bar,
    async moved(to: string): Promise<void> {
      bar.hash = to;
      await act(async () => void window.dispatchEvent(new Event('hashchange')));
    },
  };
}

/** A button that opens a menu, and one that opens a dialog with a field, beside a page that follows the route. */
function Page({ extra }: { extra?: ReactNode }) {
  useRoute();
  const menu = useMenu();
  const [asking, setAsking] = useState(false);
  const [name, setName] = useState('first');
  return createElement(
    'div',
    null,
    createElement('button', { type: 'button', id: 'more', 'aria-haspopup': 'menu', onClick: (e: { currentTarget: HTMLElement }) => menu.toggle(e.currentTarget) }, 'More'),
    createElement('button', { type: 'button', id: 'ask', onClick: () => setAsking(true) }, 'Ask'),
    createElement('main', { id: 'view', tabIndex: -1 }, extra),
    menu.anchor ? menuOf({ anchor: menu.anchor, onClose: menu.close, label: 'More' }, createElement(MenuItem, { label: 'Pack', onPick: menu.close })) : null,
    asking ? createElement(Dialog, { title: 'Rename', ok: 'Rename', onOk: () => setAsking(false), onClose: () => setAsking(false) }, createElement('input', { type: 'text', id: 'name', value: name, onChange: (e: { target: { value: string } }) => setName(e.target.value) })) : null,
  );
}

describe('the address moving on to another page', () => {
  it('closes a menu, and the page takes the focus', async () => {
    const { moved } = addressBar('#/runs');
    r = await render(shell({}, createElement(Page, { key: 'page' })));
    await r.click(r.one('#more'));
    expect(r.all('[role="menu"]')).toHaveLength(1);
    await moved('#/settings/redaction');
    expect(r.all('[role="menu"]')).toEqual([]);
    expect(overlayOpen()).toBe(false);
    expect(r.one('#more').getAttribute('aria-expanded')).toBe('false');
    expect(r.focused()).toBe(r.one('#view'));
  });

  it('closes a dialog without asking about what was changed, gives the app back, and the page takes the focus', async () => {
    const { moved } = addressBar('#/runs');
    r = await render(shell({}, createElement(Page, { key: 'page' })));
    await r.click(r.one('#ask'));
    await r.type(r.one('#name'), 'second');
    expect(r.one('#app').hasAttribute('inert')).toBe(true);
    await moved('#/settings/redaction');
    expect(r.all('.dialog')).toEqual([]);
    expect(r.all('.dlgask')).toEqual([]);
    expect(modalOpen()).toBe(false);
    expect(r.one('#app').hasAttribute('inert')).toBe(false);
    expect(r.focused()).toBe(r.one('#view'));
  });

  it('leaves what is open as a call or a view is picked: a replace is the same page', async () => {
    addressBar('#/run/01M5GRX4VY');
    r = await render(shell({}, createElement(Page, { key: 'page' })));
    await r.click(r.one('#more'));
    await act(async () => navigate('#/run/01M5GRX4VY/7', true));
    expect(r.all('[role="menu"]')).toHaveLength(1);
    await r.press('Escape');
    await r.click(r.one('#ask'));
    await act(async () => navigate('#/run/01M5GRX4VY/8', true));
    expect(r.all('.dialog')).toHaveLength(1);
  });

  it('leaves what opened since the address was written: a dialog the palette asks for along with its page', async () => {
    const { bar, moved } = addressBar('#/runs?q=refund');
    r = await render(shell({}, createElement(Page, { key: 'page' })));
    bar.hash = '#/runs';
    await r.click(r.one('#ask'));
    await moved('#/runs');
    expect(r.all('.dialog')).toHaveLength(1);
    // Asked on the page it left, it goes.
    await moved('#/tests');
    expect(r.all('.dialog')).toEqual([]);
  });
});

describe('Esc', () => {
  const job = { id: 'a1b2c3d4e5f60718', kind: 'test', title: 'Running tests', args: ['test', 'goldens/*'], runId: null, opensRun: false, startedAt: 1_000, done: false, stopped: false, code: null, newRunId: null, lines: [], total: 0 } as unknown as JobView;

  /** The shell with a job's drawer open, the phone's sidebar open, a fact with a card, a menu's and a dialog's buttons. */
  function Everything({ side }: { side: (open: boolean) => void }) {
    const [sideOpen, setSide] = useState(true);
    const [jobs, setJobs] = useState<WatchedJob[]>([{ job, lines: [], open: true }]);
    const over = {
      sideOpen,
      setSideOpen: (open: boolean) => {
        side(open);
        setSide(open);
      },
      jobs,
      closeJob: () => setJobs([]),
      hasKind: () => false,
      guard: (fn: () => void) => fn(),
      runs: [],
      actionsOff: null,
      client: {},
    } as unknown as Partial<AppState>;
    return shell(over, createElement(Page, { key: 'page', extra: createElement('span', { id: 'fact', tabIndex: 0, 'data-tip': tipCard('Spent', []) }, 'Spent') }), createElement(JobDrawer, { key: 'drawer' }), createElement(HoverCardLayer, { key: 'cards' }));
  }

  it('closes a menu, then a dialog, over the job’s drawer, then the drawer, then the phone’s sidebar, then hides a hover card, one a press', async () => {
    addressBar('#/runs');
    const side = vi.fn();
    r = await render(createElement(Everything, { side }));
    await r.focus(r.one('#fact'));
    const card = () => r!.one('#tip');
    expect(card().hasAttribute('hidden')).toBe(false);
    // A menu.
    await r.click(r.one('#more'));
    expect(r.all('[role="menu"]')).toHaveLength(1);
    await r.press('Escape');
    expect(r.all('[role="menu"]')).toEqual([]);
    expect(r.all('.drawer')).toHaveLength(1);
    expect(side).not.toHaveBeenCalled();
    expect(words(r.focused())).toBe('button More');
    // A dialog.
    await r.click(r.one('#ask'));
    await r.press('Escape');
    expect(r.all('.dialog')).toEqual([]);
    expect(r.all('.drawer')).toHaveLength(1);
    expect(side).not.toHaveBeenCalled();
    // The fact's card, shown again for what comes last.
    await r.focus(r.one('#fact'));
    expect(card().hasAttribute('hidden')).toBe(false);
    // The drawer.
    await r.press('Escape');
    expect(r.all('.drawer')).toEqual([]);
    expect(side).not.toHaveBeenCalled();
    expect(card().hasAttribute('hidden')).toBe(false);
    // The sidebar.
    await r.press('Escape');
    expect(side).toHaveBeenCalledExactlyOnceWith(false);
    expect(card().hasAttribute('hidden')).toBe(false);
    // The card.
    expect((await r.press('Escape')).defaultPrevented).toBe(true);
    expect(card().hasAttribute('hidden')).toBe(true);
    // Nothing left.
    expect((await r.press('Escape')).defaultPrevented).toBe(false);
  });
});

describe('what stays at the window’s foot', () => {
  it('reads the rect of a menu on a phone, its sheet, and none of a menu on a wider screen or of a menu that has closed', async () => {
    addressBar('#/runs');
    media({ phone: true });
    r = await render(shell({}, createElement(Page, { key: 'page' })));
    expect(menuSheetRect()).toBeNull();
    await r.click(r.one('#more'));
    expect(r.one('[role="menu"]').className).toContain('sheet');
    expect(menuSheetRect()).toEqual(r.one('[role="menu"]').getBoundingClientRect());
    await r.press('Escape');
    expect(menuSheetRect()).toBeNull();
    noMedia();
    await r.unmount();
    r = await render(shell({}, createElement(Page, { key: 'page' })));
    await r.click(r.one('#more'));
    expect(r.one('[role="menu"]').className).not.toContain('sheet');
    expect(menuSheetRect()).toBeNull();
  });

  it('hears a menu and a modal open and close, what it reads standing by then, until it stops', async () => {
    addressBar('#/runs');
    r = await render(shell({}, createElement(Page, { key: 'page' })));
    const heard: Array<[boolean, boolean]> = [];
    const stop = onOverlayChange(() => heard.push([overlayOpen(), modalOpen()]));
    await r.click(r.one('#more'));
    expect(heard.at(-1)).toEqual([true, false]);
    const opened = heard.length;
    await r.press('Escape');
    expect(heard.length).toBeGreaterThan(opened);
    expect(heard.at(-1)).toEqual([false, false]);
    await r.click(r.one('#ask'));
    expect(heard.at(-1)).toEqual([true, true]);
    await r.press('Escape');
    expect(heard.at(-1)).toEqual([false, false]);
    stop();
    const before = heard.length;
    await r.click(r.one('#more'));
    await r.click(r.one('#ask'));
    expect(heard.length).toBe(before);
  });
});

describe('Import capture', () => {
  const opener = (close: () => void) => createElement(ImportDialog, { onClose: close });
  const client = { importSources: async () => ({ uploadLimit: 1_000_000, traces: {} }) };

  function Opened() {
    const [open, setOpen] = useState(true);
    return open ? opener(() => setOpen(false)) : createElement('p', { id: 'closed' }, 'Closed');
  }

  const open = async () => {
    r = await render(shell({ client, toast: () => undefined, watchJob: () => undefined, meta: null } as unknown as Partial<AppState>, createElement(Opened, { key: 'import' })));
    await r.wait(0);
  };

  it('closes at once with nothing picked', async () => {
    await open();
    await r!.press('Escape');
    expect(r!.all('#closed')).toHaveLength(1);
  });

  it('asks before Esc loses a file dropped on it, which fires no field’s change', async () => {
    await open();
    await r!.fire(r!.one('.drop'), 'drop', { dataTransfer: { files: [new File(['{"log":{"entries":[]}}'], 'capture.har')] } } as never);
    await r!.until('the file', () => r!.all('.capfile').length > 0);
    await r!.press('Escape');
    expect(r!.all('#closed')).toEqual([]);
    expect(r!.one('.dlgask').textContent).toBe('Discard what you changed?');
    // Cancel never asks.
    await r!.press('Escape');
    await r!.click(r!.one('.dlg-cancel'));
    expect(r!.all('#closed')).toHaveLength(1);
  });

  it('asks before Esc loses the sample picked', async () => {
    await open();
    await r!.click(r!.one('.impsamples .linkbtn'));
    expect(r!.all('.capfile')).toHaveLength(1);
    await r!.press('Escape');
    expect(r!.all('.dlgask')).toHaveLength(1);
  });
});
