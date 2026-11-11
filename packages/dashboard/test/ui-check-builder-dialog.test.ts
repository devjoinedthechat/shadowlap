import { createElement, useState, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Dialog } from '../ui/components/Dialog.js';
import { noMedia, shell, words } from './ui-overlays-page.js';
import { render, type Rendered } from './ui-render.js';

/**
 * What the check builder asks of `Dialog` (ui/components/Dialog.tsx), which every other dialog
 * leaves as it was: a scrim that never closes it, the way on off with why on its card and in a
 * toast, its card's line while it can run, and the focus starting on a named control.
 */

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  noMedia();
});
beforeAll(() => {
  Object.assign(globalThis, { innerWidth: 1440, innerHeight: 900 });
});

function Opens({ dialog }: { dialog: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return createElement('div', null, createElement('button', { type: 'button', id: 'open', onClick: () => setOpen(true) }, 'Open'), open ? dialog(() => setOpen(false)) : null);
}

async function openDialog(dialog: (close: () => void) => ReactNode, toast = vi.fn()): Promise<Rendered> {
  r = await render(shell({ toast }, createElement(Opens, { key: 'opens', dialog })));
  await r.click(r.one('#open'));
  return r;
}

const kinds = createElement('div', { role: 'group', 'aria-label': 'What it checks', key: 'kinds' }, createElement('button', { type: 'button', 'aria-pressed': false }, 'Never'), createElement('button', { type: 'button', 'aria-pressed': true, id: 'must' }, 'Must call'));

describe('the check builder’s dialog', () => {
  it('never closes on a press on the scrim, edited or not, while Esc still closes it', async () => {
    const closed = vi.fn();
    await openDialog(() => createElement(Dialog, { title: 'Add check', ok: 'Save check', scrim: 'ignore', onOk: closed, onClose: closed }, kinds));
    await r!.click(r!.one('.scrim'));
    expect(closed).not.toHaveBeenCalled();
    expect(r!.all('[role="dialog"]')).toHaveLength(1);
    await r!.press('Escape');
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('asks before Esc closes it once something changed, as every dialog does', async () => {
    await openDialog((close) => createElement(Dialog, { title: 'Add check', ok: 'Save check', scrim: 'ignore', dirty: true, onOk: close, onClose: close }));
    await r!.click(r!.one('.scrim'));
    expect(r!.all('.dlgask')).toEqual([]);
    await r!.press('Escape');
    expect(r!.one('.dlgask').textContent).toBe('Discard what you changed?');
    expect(words(r!.focused())).toBe('button Keep editing');
  });

  it('reads its way on off with why on its card, said in a toast when pressed, and never runs it', async () => {
    const toast = vi.fn();
    const saved = vi.fn();
    await openDialog((close) => createElement(Dialog, { title: 'Add check', ok: 'Save check', okWhy: 'Nothing changed yet', onOk: saved, onClose: close }), toast);
    const ok = r!.one('.dlg-ok');
    expect(ok.getAttribute('aria-disabled')).toBe('true');
    expect(ok.className).not.toContain('lime');
    expect(ok.getAttribute('data-tip')).toContain('Nothing changed yet');
    await r!.click(ok);
    expect(saved).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('Nothing changed yet', 'notice', undefined);
  });

  it('gives its way on a card with its line while it can run', async () => {
    await openDialog((close) => createElement(Dialog, { title: 'Add check', ok: 'Save check', okSub: 'Only if shadowlap.config.json is as this page read it', onOk: close, onClose: close }));
    const ok = r!.one('.dlg-ok');
    expect(ok.getAttribute('aria-disabled')).toBeNull();
    expect(ok.getAttribute('data-tip')).toContain('Only if shadowlap.config.json is as this page read it');
  });

  it('starts the focus on the control it names, ahead of the first field', async () => {
    await openDialog((close) => createElement(Dialog, { title: 'Add check', ok: 'Save check', startFocus: '[aria-pressed="true"]', onOk: close, onClose: close }, createElement('input', { type: 'text', key: 'f', defaultValue: 'x' }), kinds));
    expect(words(r!.focused())).toBe('button Must call');
  });
});
