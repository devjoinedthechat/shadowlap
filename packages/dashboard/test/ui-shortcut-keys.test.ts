import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keyboard } from '../ui/shell/Keyboard.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';

/**
 * The single-key shortcuts (? for the shortcuts, / for the palette, g then a letter, u for a toast's
 * Undo) keep out of what is typed in a field, and only that: a checkbox, which Runs ticks a run with,
 * takes no key a shortcut uses, so ? opens the shortcuts with the focus on it. Rendered with the
 * shell's own key handler.
 */

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

describe('a single-key shortcut', () => {
  it('works from a ticked run, and is typed into a field', async () => {
    const setHelp = vi.fn();
    const state = { conn: 'ok', exported: false, meta: null, palette: false, setPalette: () => undefined, help: false, setHelp, sideOpen: false, setSideOpen: () => undefined, closeTopLayer: () => false, blockingLayer: () => false, runKeys: { current: null } } as unknown as AppState;
    r = await render(
      createElement(AppContext.Provider, { value: state }, createElement(Keyboard), createElement('input', { type: 'checkbox', 'aria-label': 'Select run' }), createElement('input', { type: 'search' }), createElement('input', { type: 'radio' }), createElement('textarea')),
    );
    const [tick, search, radio] = r.all('input');
    for (const field of [search, radio, r.one('textarea')]) {
      const typed = await r.press('?', {}, field);
      expect(typed.defaultPrevented).toBe(false);
    }
    expect(setHelp).not.toHaveBeenCalled();
    const e = await r.press('?', {}, tick);
    expect(e.defaultPrevented).toBe(true);
    expect(setHelp).toHaveBeenCalledWith(true);
  });
});
