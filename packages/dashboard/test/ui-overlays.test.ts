import { createElement, useState, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Dialog, Modal } from '../ui/components/Dialog.js';
import { MenuItem, useMenu } from '../ui/components/Popover.js';
import { controlKey, findControl, firstFocus } from '../ui/overlays/focus-back.js';
import { typeAhead } from '../ui/overlays/menu-store.js';
import { holdBehind, modalOpen, overlayOpen } from '../ui/overlays/modal-store.js';
import { InSlot } from '../ui/overlays/slots.js';
import { AppContext, type AppState } from '../ui/state.js';
import { app, media, menuOf, noMedia, shell, words } from './ui-overlays-page.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Every overlay on one set of rules, rendered with the shell's own key handler and its three slots, as
 * a person presses the keys: where each goes, what it takes from the page, where the focus goes as it
 * opens and closes, the keys it keeps from the page and the ask before it discards an edit. The real
 * browser checks the same on the pages, and that a phone gets its sheets (browser/overlays.spec.ts).
 * Pickers are test/ui-picker.test.ts's, hover cards test/ui-hover-cards.test.ts's, and where a menu
 * goes test/ui-run-page.test.ts's.
 */

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  vi.useRealTimers();
  noMedia();
});

beforeAll(() => {
  // No layout here: a menu is placed against a window of this size.
  Object.assign(globalThis, { innerWidth: 1440, innerHeight: 900 });
});

/** A menu of three items opened from a button, and a project's row with a second button. */
function ShareOpener({ picked }: { picked?: (what: string) => void }) {
  const menu = useMenu();
  const pick = (what: string) => () => {
    picked?.(what);
    menu.close();
  };
  return createElement(
    'div',
    null,
    createElement('button', { type: 'button', id: 'share', 'aria-haspopup': 'menu', 'aria-expanded': menu.open, onClick: (e: { currentTarget: HTMLElement }) => menu.toggle(e.currentTarget) }, 'Share'),
    menu.anchor
      ? menuOf(
          { anchor: menu.anchor, onClose: menu.close, label: 'Share' },
          createElement(MenuItem, { label: 'HTML report', note: 'export html', onPick: pick('html') }),
          createElement(MenuItem, { label: 'Pack…', note: 'pack', onPick: pick('pack'), disabled: false }),
          createElement('button', { type: 'button', role: 'menuitem', disabled: true }, createElement('b', null, 'HAR off')),
          createElement('div', { className: 'prow' }, createElement('button', { type: 'button', role: 'menuitemradio', 'aria-checked': true }, createElement('b', null, 'support-agent')), createElement('button', { type: 'button', className: 'px', 'aria-label': 'Remove support-agent' }, '×')),
          createElement(MenuItem, { label: 'Report', onPick: pick('report') }),
        )
      : null,
    createElement('button', { type: 'button', id: 'after' }, 'Delete'),
  );
}

async function openShare(over: Partial<AppState> = {}, picked?: (what: string) => void): Promise<Rendered> {
  r = await render(shell(over, createElement(ShareOpener, { key: 'menu', ...(picked ? { picked } : {}) })));
  await r.click(r.one('#share'));
  return r;
}

describe('the three slots', () => {
  function Parts({ open }: { open: { menu?: boolean; modal?: boolean; dock?: boolean } }) {
    const anchor = open.menu ? document.querySelector<HTMLElement>('#opener') : null;
    return createElement(
      'div',
      null,
      createElement('button', { type: 'button', id: 'opener' }, 'Open'),
      open.dock ? createElement(InSlot, { name: 'dock', children: createElement('div', { className: 'drawer' }, 'A job') }) : null,
      anchor ? menuOf({ anchor, onClose: () => undefined, label: 'A menu' }, createElement(MenuItem, { label: 'One', onPick: () => undefined })) : null,
      open.modal ? createElement(Dialog, { title: 'A dialog', onClose: () => undefined }) : null,
    );
  }

  it('draw a menu, a modal and a job’s drawer each in a place of its own, beside the app', async () => {
    let set: (o: { menu?: boolean; modal?: boolean; dock?: boolean }) => void = () => undefined;
    function Host() {
      const [open, setOpen] = useState<{ menu?: boolean; modal?: boolean; dock?: boolean }>({});
      set = setOpen;
      return createElement(Parts, { open });
    }
    r = await render(shell({}, createElement(Host, { key: 'host' })));
    await r.wait(0);
    expect(r.one('#app').contains(r.one('#menu'))).toBe(false);
    await act(() => set({ dock: true }));
    expect(r.one('#dock').contains(r.one('.drawer'))).toBe(true);
    // A menu while a job runs leaves the job's drawer as it is.
    await act(() => set({ dock: true, menu: true }));
    expect(r.one('#menu').contains(r.one('[role="menu"]'))).toBe(true);
    expect(r.one('#dock').contains(r.one('.drawer'))).toBe(true);
    // So does a modal.
    await act(() => set({ dock: true, modal: true }));
    expect(r.one('#layer').contains(r.one('.dialog'))).toBe(true);
    expect(r.one('#dock').contains(r.one('.drawer'))).toBe(true);
  });

  async function act(f: () => void): Promise<void> {
    f();
    await r!.wait(0);
  }

  it('fall back to where a part is drawn when no shell drew them', async () => {
    r = await render(createElement(AppContext.Provider, { value: app() }, createElement('main', { id: 'view' }, createElement(Dialog, { title: 'A dialog', onClose: () => undefined }))));
    expect(r.one('main').contains(r.one('.dialog'))).toBe(true);
  });
});

describe('a menu', () => {
  it('takes the focus on its first item, and the arrows go round its ends past what is disabled', async () => {
    await openShare();
    expect(words(r!.focused())).toBe('button HTML reportexport html');
    await r!.press('ArrowDown');
    expect(words(r!.focused())).toBe('button Pack…pack');
    await r!.press('ArrowDown');
    expect(words(r!.focused())).toBe('button support-agent');
    await r!.press('ArrowDown');
    expect(words(r!.focused())).toBe('button Report');
    await r!.press('ArrowDown');
    expect(words(r!.focused())).toBe('button HTML reportexport html');
    await r!.press('ArrowUp');
    expect(words(r!.focused())).toBe('button Report');
  });

  it('jumps with Home, End, PageUp and PageDown', async () => {
    await openShare();
    await r!.press('End');
    expect(words(r!.focused())).toBe('button Report');
    await r!.press('Home');
    expect(words(r!.focused())).toBe('button HTML reportexport html');
    await r!.press('PageDown');
    expect(words(r!.focused())).toBe('button Report');
    await r!.press('PageUp');
    expect(words(r!.focused())).toBe('button HTML reportexport html');
  });

  it('finds the next item a typed letter starts, a word typed quickly, and starts again after 700 ms', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await openShare();
    await r!.press('p');
    expect(words(r!.focused())).toBe('button Pack…pack');
    vi.advanceTimersByTime(800);
    await r!.press('r');
    expect(words(r!.focused())).toBe('button Report');
    await r!.press('e');
    expect(words(r!.focused())).toBe('button Report');
    vi.advanceTimersByTime(800);
    await r!.press('s');
    expect(words(r!.focused())).toBe('button support-agent');
    // A letter no item starts moves nothing.
    vi.advanceTimersByTime(800);
    await r!.press('z');
    expect(words(r!.focused())).toBe('button support-agent');
  });

  it('counts a typed letter from the item after the focus, and a word from the focus', () => {
    const labels = ['pack', 'preview', 'report', 'push'];
    expect(typeAhead(labels, 'p', 0)).toBe(1);
    expect(typeAhead(labels, 'p', 1)).toBe(3);
    expect(typeAhead(labels, 'p', 3)).toBe(0);
    expect(typeAhead(labels, 'pu', 1)).toBe(3);
    expect(typeAhead(labels, 'pre', 1)).toBe(1);
    expect(typeAhead(labels, 'z', 0)).toBeNull();
    expect(typeAhead(labels, 'p', -1)).toBe(0);
  });

  it('reaches a row’s second button with →, and comes back with ←', async () => {
    await openShare();
    await r!.press('End');
    await r!.press('ArrowUp');
    expect(words(r!.focused())).toBe('button support-agent');
    await r!.press('ArrowRight');
    expect(words(r!.focused())).toBe('button ×');
    await r!.press('ArrowLeft');
    expect(words(r!.focused())).toBe('button support-agent');
    // The arrows go on from the row, its second button included.
    await r!.press('ArrowRight');
    await r!.press('ArrowDown');
    expect(words(r!.focused())).toBe('button Report');
  });

  it('closes on Tab with the focus on its button, so Tab goes on from there, and on Esc', async () => {
    await openShare();
    await r!.press('Tab');
    expect(r!.all('[role="menu"]')).toEqual([]);
    expect(words(r!.focused())).toBe('button Delete');
    await r!.click(r!.one('#share'));
    await r!.press('Escape');
    expect(r!.all('[role="menu"]')).toEqual([]);
    expect(words(r!.focused())).toBe('button Share');
  });

  it('is one Tab stop: every row takes the focus from the arrows alone', async () => {
    await openShare();
    for (const b of r!.all('[role="menu"] button')) expect(b.getAttribute('tabindex')).toBe('-1');
  });

  it('opens from its button on ↓ on its first item, and on ↑ on its last', async () => {
    r = await render(shell({}, createElement(ShareOpener, { key: 'menu' })));
    r.one('#share').focus();
    await r.press('ArrowDown');
    expect(words(r.focused())).toBe('button HTML reportexport html');
    await r.press('Escape');
    await r.press('ArrowUp');
    expect(words(r.focused())).toBe('button Report');
  });

  it('hands the focus back after a pick, and says it is open on its button', async () => {
    const picked = vi.fn();
    await openShare({}, picked);
    expect(r!.one('#share').getAttribute('aria-expanded')).toBe('true');
    await r!.click(r!.focused());
    expect(picked).toHaveBeenCalledExactlyOnceWith('html');
    expect(r!.all('[role="menu"]')).toEqual([]);
    expect(r!.one('#share').getAttribute('aria-expanded')).toBe('false');
    expect(words(r!.focused())).toBe('button Share');
  });

  it('closes on a click outside: the focus stays on a control the click landed on, and comes back when it landed on nothing', async () => {
    await openShare();
    await r!.click(r!.one('#after'));
    expect(r!.all('[role="menu"]')).toEqual([]);
    expect(words(r!.focused())).toBe('button Delete');
    await r!.click(r!.one('#share'));
    // A press on blank space takes the focus to the page's body.
    r!.focused().blur();
    await r!.click(r!.one('#app'));
    expect(r!.all('[role="menu"]')).toEqual([]);
    expect(words(r!.focused())).toBe('button Share');
  });

  it('toggles from its button, even with a control that stops its click', async () => {
    await openShare();
    await r!.click(r!.one('#share'));
    expect(r!.all('[role="menu"]')).toEqual([]);
  });

  it('keeps every key from the page while it is open, ⌘K going on to the palette', async () => {
    const pageKeys = vi.fn(() => true);
    const setPalette = vi.fn();
    const setHelp = vi.fn();
    await openShare({ runKeys: { current: pageKeys }, setPalette, setHelp });
    await r!.press('?');
    await r!.press('j');
    await r!.press('/');
    expect(pageKeys).not.toHaveBeenCalled();
    expect(setHelp).not.toHaveBeenCalled();
    expect(setPalette).not.toHaveBeenCalled();
    await r!.press('k', { metaKey: true });
    expect(setPalette).toHaveBeenCalledExactlyOnceWith(true);
    expect(r!.all('[role="menu"]')).toEqual([]);
    // Back on its button, for the palette to give the focus back to.
    expect(words(r!.focused())).toBe('button Share');
  });

  it('closes the one open when another opens', async () => {
    function Two() {
      const a = useMenu();
      const b = useMenu();
      return createElement(
        'div',
        null,
        createElement('button', { type: 'button', id: 'a', onClick: (e: { currentTarget: HTMLElement }) => a.openAt(e.currentTarget) }, 'A'),
        createElement('button', { type: 'button', id: 'b', onClick: (e: { currentTarget: HTMLElement }) => b.openAt(e.currentTarget) }, 'B'),
        a.anchor ? menuOf({ anchor: a.anchor, onClose: a.close, label: 'Menu A' }, createElement(MenuItem, { label: 'From A', onPick: a.close })) : null,
        b.anchor ? menuOf({ anchor: b.anchor, onClose: b.close, label: 'Menu B' }, createElement(MenuItem, { label: 'From B', onPick: b.close })) : null,
      );
    }
    r = await render(shell({}, createElement(Two, { key: 'two' })));
    await r.click(r.one('#a'));
    expect(r.one('[role="menu"]').getAttribute('aria-label')).toBe('Menu A');
    r.one('#b').focus();
    await r.fire(r.one('#b'), 'click');
    expect(r.one('[role="menu"]').getAttribute('aria-label')).toBe('Menu B');
    expect(words(r.focused())).toBe('button From B');
  });

  it('is a sheet on a phone, over a scrim that takes the tap that closes it, so the tap never reaches the page', async () => {
    media({ phone: true });
    const page = vi.fn();
    r = await render(shell({}, createElement('main', { key: 'page', onClick: page }, createElement(ShareOpener))));
    await r.click(r.one('#share'));
    expect(page).toHaveBeenCalledTimes(1);
    page.mockClear();
    const sheet = r.one('[role="menu"]');
    expect(sheet.className).toContain('sheet');
    expect(sheet.parentNode).toBe(r.one('#menu'));
    await r.click(r.one('.msheet'));
    expect(r.all('[role="menu"]')).toEqual([]);
    expect(r.all('.msheet')).toEqual([]);
    expect(page).not.toHaveBeenCalled();
    expect(words(r.focused())).toBe('button Share');
  });
});

/** A button that opens a dialog of the given props, as a page's does. */
function Opens({ dialog, onClosed }: { dialog: (close: () => void) => ReactNode; onClosed?: () => void }) {
  const [open, setOpen] = useState(false);
  const close = () => {
    setOpen(false);
    onClosed?.();
  };
  return createElement('div', null, createElement('button', { type: 'button', id: 'open', onClick: () => setOpen(true) }, 'Open'), open ? dialog(close) : null);
}

const field = (over: Record<string, unknown> = {}) => createElement('input', { type: 'text', id: 'name', onChange: () => undefined, ...over });

async function openDialog(dialog: (close: () => void) => ReactNode, over: Partial<AppState> = {}): Promise<Rendered> {
  r = await render(shell(over, createElement(Opens, { key: 'opens', dialog })));
  await r.click(r.one('#open'));
  return r;
}

describe('a modal', () => {
  it('puts the app behind out of reach, the dock and the connection bar too, and gives it back as it closes', async () => {
    await openDialog((close) => createElement(Dialog, { title: 'Delete run', ok: 'Delete run', tone: 'danger', onOk: close, onClose: close }));
    expect(modalOpen()).toBe(true);
    expect(overlayOpen()).toBe(true);
    for (const sel of ['#app', '#conn', '#dock', 'a.skip']) expect(r!.one(sel).hasAttribute('inert'), sel).toBe(true);
    expect(r!.one('#layer').hasAttribute('inert')).toBe(false);
    await r!.press('Escape');
    expect(modalOpen()).toBe(false);
    for (const sel of ['#app', '#conn', '#dock', 'a.skip']) expect(r!.one(sel).hasAttribute('inert'), sel).toBe(false);
    expect(words(r!.focused())).toBe('button Open');
  });

  it('counts its reasons: an ended session’s card keeps the app out of reach after a modal closes', async () => {
    await openDialog((close) => createElement(Dialog, { title: 'Delete run', ok: 'Delete run', onOk: close, onClose: close }));
    const release = holdBehind(true);
    await r!.press('Escape');
    expect(r!.one('#app').hasAttribute('inert')).toBe(true);
    expect(r!.one('#layer').hasAttribute('inert')).toBe(true);
    release();
    release();
    expect(r!.one('#app').hasAttribute('inert')).toBe(false);
    expect(r!.one('#layer').hasAttribute('inert')).toBe(false);
  });

  it('closes a menu as it opens, and hands the focus back to the menu’s button', async () => {
    function FromMenu() {
      const menu = useMenu();
      const [asking, setAsking] = useState(false);
      return createElement(
        'div',
        null,
        createElement('button', { type: 'button', id: 'more', onClick: (e: { currentTarget: HTMLElement }) => menu.toggle(e.currentTarget) }, 'More'),
        menu.anchor
          ? menuOf(
              { anchor: menu.anchor, onClose: menu.close, label: 'More' },
              createElement(MenuItem, {
                label: 'Delete…',
                onPick: () => {
                  menu.close();
                  setAsking(true);
                },
              }),
            )
          : null,
        asking ? createElement(Dialog, { title: 'Delete run', ok: 'Delete run', tone: 'danger', onOk: () => setAsking(false), onClose: () => setAsking(false) }) : null,
      );
    }
    r = await render(shell({}, createElement(FromMenu, { key: 'menu' })));
    await r.click(r.one('#more'));
    await r.click(r.focused());
    expect(r.all('[role="menu"]')).toEqual([]);
    expect(words(r.focused())).toBe('button Cancel');
    await r.press('Escape');
    expect(words(r.focused())).toBe('button More');
  });

  it('keeps its keys from the page, and ⌘K opens nothing over it', async () => {
    const pageKeys = vi.fn(() => true);
    const setPalette = vi.fn();
    await openDialog((close) => createElement(Dialog, { title: 'Delete run', ok: 'Delete run', onOk: close, onClose: close }), { runKeys: { current: pageKeys }, setPalette });
    await r!.press('j');
    await r!.press('k', { metaKey: true });
    expect(pageKeys).not.toHaveBeenCalled();
    expect(setPalette).not.toHaveBeenCalled();
  });

  it('closes on a press only when it starts and ends on the scrim', async () => {
    const closed = vi.fn();
    await openDialog(() => createElement(Dialog, { title: 'Delete run', ok: 'Delete run', onOk: closed, onClose: closed }));
    const scrim = r!.one('.scrim');
    // A selection dragged out of the dialog: it starts inside, and the click lands on what holds both.
    await r!.fire(r!.one('.dialog header'), 'mousedown');
    await r!.fire(scrim, 'mouseup');
    await r!.fire(scrim, 'click');
    expect(closed).not.toHaveBeenCalled();
    // One dragged into the dialog from the scrim.
    await r!.fire(scrim, 'mousedown');
    await r!.fire(r!.one('.dialog header'), 'mouseup');
    await r!.fire(scrim, 'click');
    expect(closed).not.toHaveBeenCalled();
    // A press on the scrim.
    await r!.click(scrim);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('gives a press in it to no row it was asked from', async () => {
    const row = vi.fn();
    r = await render(shell({}, createElement('table', { key: 'row' }, createElement('tbody', null, createElement('tr', { onClick: row }, createElement('td', null, createElement(Dialog, { title: 'Delete run', onClose: () => undefined }))))) ));
    await r.click(r.one('.dialog header'));
    expect(row).not.toHaveBeenCalled();
  });

  it('goes round its own controls with Tab, and a Modal with none keeps the focus on itself', async () => {
    await openDialog((close) => createElement(Dialog, { title: 'Rename', ok: 'Rename', onOk: close, onClose: close }, field()));
    expect(words(r!.focused())).toBe('input name');
    await r!.press('Tab');
    expect(words(r!.focused())).toBe('button Cancel');
    await r!.press('Tab');
    expect(words(r!.focused())).toBe('button Rename');
    await r!.press('Tab');
    expect(words(r!.focused())).toBe('input name');
    await r!.press('Tab', { shiftKey: true });
    expect(words(r!.focused())).toBe('button Rename');
  });

  it('lets a Modal say what Esc does', async () => {
    const asked = vi.fn();
    await openDialog(() => createElement(Modal, { requestClose: asked, children: createElement('div', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'A sheet' }, 'Words') }));
    await r!.press('Escape');
    expect(asked).toHaveBeenCalledTimes(1);
  });
});

describe('a modal’s first focus', () => {
  it('starts on Cancel in one that deletes, whatever it holds', async () => {
    await openDialog((close) => createElement(Dialog, { title: 'Delete run', ok: 'Delete run', tone: 'danger', onOk: close, onClose: close }, field()));
    expect(words(r!.focused())).toBe('button Cancel');
  });

  it('starts on the first field, else on the way on', async () => {
    await openDialog((close) => createElement(Dialog, { title: 'Rename', ok: 'Rename', onOk: close, onClose: close }, field(), field({ id: 'other' })));
    expect(words(r!.focused())).toBe('input name');
    await r!.unmount();
    await openDialog((close) => createElement(Dialog, { title: 'Replay', ok: 'Replay', onOk: close, onClose: close }));
    expect(words(r!.focused())).toBe('button Replay');
  });

  it('skips a field on a touch screen, whose keyboard would open over the dialog', async () => {
    media({ touch: true });
    await openDialog((close) => createElement(Dialog, { title: 'Rename', ok: 'Rename', onOk: close, onClose: close }, field()));
    expect(words(r!.focused())).toBe('button Rename');
  });

  it('starts on Cancel where the way on waits, on Close where it only shows something, on a drop zone where it asks for a file, on itself with nothing', async () => {
    await openDialog((close) => createElement(Dialog, { title: 'Replace', ok: 'Replace', okDisabled: true, onOk: close, onClose: close }, createElement('a', { href: '#/docs' }, 'In the docs')));
    expect(words(r!.focused())).toBe('button Cancel');
    await r!.unmount();
    await openDialog((close) => createElement(Dialog, { title: 'Show patch', onClose: close }, createElement('a', { href: '#/docs' }, 'In the docs')));
    expect(words(r!.focused())).toBe('button Close');
    await r!.unmount();
    await openDialog((close) => createElement(Dialog, { title: 'Import capture', ok: 'Import capture', okDisabled: true, onOk: close, onClose: close }, createElement('button', { type: 'button' }, 'Langfuse'), createElement('label', { className: 'drop', tabIndex: 0 }, 'Drop a file')));
    expect(r!.focused().className).toBe('drop');
    const lone = { querySelector: () => null, querySelectorAll: () => [] } as unknown as HTMLElement;
    expect(firstFocus(lone, '.dlg-ok')).toBe(lone);
    await r!.unmount();
    // A press on the scrim that goes on to ask leaves the focus where it was.
    await openDialog((close) => createElement(Dialog, { title: 'Rename', ok: 'Rename', onOk: close, onClose: close }, field()));
    const pressed = await r!.fire(r!.one('.scrim'), 'mousedown');
    expect(pressed.defaultPrevented).toBe(true);
    expect(words(r!.focused())).toBe('input name');
  });

  it('never starts on a field a choice hides', async () => {
    await openDialog((close) => createElement(Dialog, { title: 'Rename', ok: 'Rename', onOk: close, onClose: close }, createElement('div', { hidden: true }, field({ disabled: true }))));
    expect(words(r!.focused())).toBe('button Rename');
  });
});

describe('a modal with edits', () => {
  /** A dialog whose field holds what was typed, and one that arrives as it loads. */
  function Edit({ close, later }: { close: () => void; later?: string }) {
    const [name, setName] = useState('first');
    const [loaded, setLoaded] = useState('');
    return createElement(
      Dialog,
      { title: 'Rename', ok: 'Rename', onOk: close, onClose: close },
      field({ value: name, onChange: (e: { target: { value: string } }) => setName(e.target.value) }),
      later ? field({ id: 'later', value: loaded, onChange: () => undefined }) : null,
      later ? createElement('i', { ref: (el: unknown) => void (el && !loaded && setTimeout(() => setLoaded(later), 0)) }) : null,
    );
  }

  it('closes at once with nothing changed', async () => {
    await openDialog((close) => createElement(Edit, { close }));
    await r!.press('Escape');
    expect(r!.all('.dialog')).toEqual([]);
    expect(words(r!.focused())).toBe('button Open');
  });

  it('asks before Esc discards an edit, in its footer, with Keep editing focused and Discard, and a second Esc keeps editing', async () => {
    await openDialog((close) => createElement(Edit, { close }));
    await r!.type(r!.one('#name'), 'second');
    await r!.press('Escape');
    expect(r!.one('.dialog footer .dlgask').textContent).toBe('Discard what you changed?');
    expect(words(r!.focused())).toBe('button Keep editing');
    expect(r!.focused().getAttribute('aria-describedby')).toBe(r!.one('.dlgask').getAttribute('id'));
    expect(r!.all('.dialog footer button:not([hidden])').map((b) => b.textContent)).toEqual(['Keep editing', 'Discard']);
    expect(r!.one('.dlg-discard').className).toContain('danger');
    await r!.press('Escape');
    expect(r!.all('.dlgask')).toEqual([]);
    expect(words(r!.focused())).toBe('input name');
    expect(r!.one('#name').value).toBe('second');
    expect(r!.all('.dialog footer button:not([hidden])').map((b) => b.textContent)).toEqual(['Cancel', 'Rename']);
    await r!.press('Escape');
    await r!.click(r!.one('.dlg-discard'));
    expect(r!.all('.dialog')).toEqual([]);
    expect(words(r!.focused())).toBe('button Open');
  });

  it('asks before the scrim discards an edit, and a press in it goes back to editing', async () => {
    await openDialog((close) => createElement(Edit, { close }));
    await r!.type(r!.one('#name'), 'second');
    await r!.click(r!.one('.scrim'));
    expect(r!.all('.dlgask')).toHaveLength(1);
    await r!.click(r!.one('.dialog header'));
    expect(r!.all('.dlgask')).toEqual([]);
    expect(r!.all('.dialog')).toHaveLength(1);
  });

  it('never asks of Cancel, and not when the edit was taken back', async () => {
    await openDialog((close) => createElement(Edit, { close }));
    await r!.type(r!.one('#name'), 'second');
    await r!.type(r!.one('#name'), 'first');
    await r!.press('Escape');
    expect(r!.all('.dialog')).toEqual([]);
    await r!.click(r!.one('#open'));
    await r!.type(r!.one('#name'), 'second');
    await r!.click(r!.one('.dlg-cancel'));
    expect(r!.all('.dialog')).toEqual([]);
  });

  it('takes a value that arrives as it loads for no edit', async () => {
    await openDialog((close) => createElement(Edit, { close, later: 'loaded' }));
    await r!.wait(5);
    expect(r!.one('#later').value).toBe('loaded');
    await r!.press('Escape');
    expect(r!.all('.dialog')).toEqual([]);
  });

  it('counts a pressed segment or a switch as an edit', async () => {
    function Seg({ close }: { close: () => void }) {
      const [on, setOn] = useState(false);
      return createElement(Dialog, { title: 'Export', ok: 'Export', onOk: close, onClose: close }, createElement('button', { type: 'button', id: 'seg', 'aria-pressed': on, onClick: () => setOn(!on) }, 'File'));
    }
    await openDialog((close) => createElement(Seg, { close }));
    await r!.click(r!.one('#seg'));
    await r!.press('Escape');
    expect(r!.all('.dlgask')).toHaveLength(1);
  });
});

describe('what opened an overlay', () => {
  /** A page that draws its button anew each time, as a list reloaded under the dialog does. */
  function Redrawn({ attrs }: { attrs: Record<string, string> }) {
    const [round, setRound] = useState(0);
    const [open, setOpen] = useState(false);
    return createElement(
      'div',
      null,
      createElement('button', { key: `other-${round}`, type: 'button', 'data-row': 'other' }, 'Remove'),
      createElement('button', { key: `mine-${round}`, type: 'button', id: attrs.id, 'data-row': attrs.row, onClick: () => setOpen(true) }, 'Remove'),
      open
        ? createElement(Dialog, {
            title: 'Remove it',
            onClose: () => {
              setOpen(false);
              setRound((n) => n + 1);
            },
          })
        : null,
    );
  }

  it('is found by its id once the page has drawn it anew', async () => {
    r = await render(shell({}, createElement(Redrawn, { key: 'page', attrs: { id: 'mine', row: 'mine' } })));
    const before = r.one('#mine');
    await r.click(before);
    await r.press('Escape');
    expect(r.one('#mine')).not.toBe(before);
    expect(r.focused()).toBe(r.one('#mine'));
  });

  it('is found by its data keys, words and place among its likes where it has no id', async () => {
    r = await render(shell({}, createElement(Redrawn, { key: 'page', attrs: { row: 'mine' } })));
    const before = r.one('[data-row="mine"]');
    await r.click(before);
    await r.press('Escape');
    expect(r.one('[data-row="mine"]')).not.toBe(before);
    expect(r.focused()).toBe(r.one('[data-row="mine"]'));
  });

  it('goes by which of its likes it was, what describes it staying out of its key', async () => {
    r = await render(
      createElement(
        'div',
        null,
        createElement('button', { type: 'button', 'data-tip': 'one' }, 'Remove'),
        createElement('button', { type: 'button', 'data-tip': 'two' }, 'Remove'),
        createElement('a', { href: '#/runs', 'aria-label': 'Runs' }, 'All'),
      ),
    );
    const [first, second] = r.all('button');
    const key = controlKey(second as unknown as HTMLElement)!;
    expect(key).toMatchObject({ tag: 'button', id: null, attrs: [], text: 'Remove', nth: 1 });
    expect(findControl(key)).toBe(second);
    expect(findControl({ ...key, nth: 5 })).toBe(first);
    expect(controlKey(r.one('a') as unknown as HTMLElement)).toMatchObject({ tag: 'a', attrs: expect.arrayContaining([['href', '#/runs'], ['aria-label', 'Runs']]) as unknown, text: 'All', nth: 0 });
    expect(findControl({ tag: 'button', id: 'gone', attrs: [], text: 'Nothing like it', nth: 0 })).toBeNull();
    expect(controlKey(null)).toBeNull();
  });

  it('hands the focus to the sidebar’s button where the closed sidebar hides it, and to the page with nothing left', async () => {
    function InSide() {
      const [open, setOpen] = useState(false);
      return createElement(
        'div',
        null,
        createElement('button', { type: 'button', className: 'menu-toggle', 'aria-label': 'Menu' }),
        createElement('aside', { id: 'side' }, createElement('button', { type: 'button', id: 'search', onClick: () => setOpen(true) }, 'Search')),
        createElement('main', { id: 'view', tabIndex: -1 }),
        open ? createElement(Dialog, { title: 'Search', onClose: () => setOpen(false) }) : null,
      );
    }
    r = await render(shell({}, createElement(InSide, { key: 'side' })));
    await r.click(r.one('#search'));
    const search = r.one('#search');
    search.attributes.set('tabindex', '-1');
    Object.assign(search, { getClientRects: () => [] });
    await r.press('Escape');
    expect(words(r.focused())).toBe('button Menu');
  });
});
