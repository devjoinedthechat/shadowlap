import { createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RunPicker } from '../ui/compare/RunPicker.js';
import { matchPicks, pickMove, Picker, type PickerItem } from '../ui/components/Picker.js';
import { useMenu } from '../ui/components/Popover.js';
import { menuWidthAt } from '../ui/place.js';
import { media, noMedia, shell, words } from './ui-overlays-page.js';
import { render, type Rendered } from './ui-render.js';

/**
 * A picker: a combobox with a filter over its list, rendered with the shell's own key handler and its
 * slots. Compare's run pickers and the redaction preview's are this. The real browser checks it on
 * those pages, a phone's sheet included (browser/overlays.spec.ts).
 */

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  vi.useRealTimers();
  noMedia();
});

beforeAll(() => {
  Object.assign(globalThis, { innerWidth: 1440, innerHeight: 900 });
});

describe('a picker', () => {
  const items: PickerItem[] = [
    { id: 'a', text: 'a01 refund flow', current: false, node: 'a01' },
    { id: 'b', text: 'b02 refund over limit', current: true, node: 'b02' },
    { id: 'c', text: 'c03 pushy customer', current: false, node: 'c03' },
  ];

  function Opener({ onPick }: { onPick: (id: string) => void }) {
    const menu = useMenu();
    return createElement(
      'div',
      null,
      createElement('button', { type: 'button', id: 'pick', 'aria-haspopup': 'listbox', onClick: (e: { currentTarget: HTMLElement }) => menu.toggle(e.currentTarget) }, 'Pick'),
      menu.anchor
        ? createElement(Picker, {
            anchor: menu.anchor,
            label: 'Run A',
            placeholder: 'Filter by id, about line or label',
            items,
            onClose: menu.close,
            onPick: (id: string) => {
              menu.close();
              onPick(id);
            },
          })
        : null,
    );
  }

  it('is a combobox whose field keeps the focus and names the option the arrows light, starting on the one picked', async () => {
    r = await render(shell({}, createElement(Opener, { key: 'picker', onPick: () => undefined })));
    await r.click(r.one('#pick'));
    const input = r.one('input.pfilter');
    expect(r.focused()).toBe(input);
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(r.one('#menu').contains(input)).toBe(true);
    const list = r.one(`[id="${input.getAttribute('aria-controls')}"]`);
    expect(list.getAttribute('role')).toBe('listbox');
    const active = () => r!.one(`[id="${input.getAttribute('aria-activedescendant')}"]`);
    expect(active().textContent).toBe('b02');
    expect(active().getAttribute('aria-selected')).toBe('true');
    await r.press('ArrowDown');
    expect(r.focused()).toBe(input);
    expect(active().textContent).toBe('c03');
    expect(active().className).toContain('on');
    expect(list.getAttribute('aria-activedescendant')).toBe(active().getAttribute('id'));
    // The ring is the keyboard's.
    expect(list.className).toContain('kb');
    // Round the ends, and only the one picked is checked.
    await r.press('ArrowDown');
    expect(active().textContent).toBe('a01');
    expect(r.all('[aria-selected="true"]').map((o) => o.textContent)).toEqual(['b02']);
    await r.press('End');
    expect(active().textContent).toBe('c03');
    await r.press('Home');
    expect(active().textContent).toBe('a01');
    await r.press('PageDown');
    expect(active().textContent).toBe('c03');
    await r.press('PageUp');
    expect(active().textContent).toBe('a01');
  });

  it('moves its lit row by a class alone, from a key or the pointer: no row is drawn again, however long the list', async () => {
    r = await render(shell({}, createElement(Opener, { key: 'picker', onPick: () => undefined })));
    await r.click(r.one('#pick'));
    const input = r.one('input.pfilter');
    const rows = r.all('[role="option"]');
    const drawn = rows.map((o) => o.props);
    const lit = () => r!.all('.opt.on').map((o) => o.textContent);
    expect(lit()).toEqual(['b02']);
    await r.press('ArrowDown');
    expect(lit()).toEqual(['c03']);
    expect(r.one(`[id="${input.getAttribute('aria-activedescendant')}"]`).textContent).toBe('c03');
    await r.fire(rows[0], 'mousemove');
    expect(lit()).toEqual(['a01']);
    expect(r.one('.pklist').className).not.toContain('kb');
    for (const [i, o] of r.all('[role="option"]').entries()) expect(o.props, o.textContent).toBe(drawn[i]);
    // Narrowed, it is drawn anew, the lit row its first.
    await r.type(input, 'pushy');
    expect(lit()).toEqual(['c03']);
  });

  it('moves a page without going round, and the keys a field keeps are left to it', () => {
    expect(pickMove('PageDown', 2, 30)).toBe(10);
    expect(pickMove('PageDown', 28, 30)).toBe(29);
    expect(pickMove('PageUp', 3, 30)).toBe(0);
    expect(pickMove('ArrowUp', 0, 30)).toBe(29);
    expect(pickMove('ArrowDown', 29, 30)).toBe(0);
    expect(pickMove('ArrowDown', 0, 0)).toBeNull();
    expect(pickMove('a', 0, 3)).toBeNull();
  });

  it('filters by every word typed, and says "Nothing matches." with no empty list', async () => {
    expect(matchPicks(items, 'REFUND limit').map((x) => x.id)).toEqual(['b']);
    expect(matchPicks(items, ' ').map((x) => x.id)).toEqual(['a', 'b', 'c']);
    r = await render(shell({}, createElement(Opener, { key: 'picker', onPick: () => undefined })));
    await r.click(r.one('#pick'));
    const input = r.one('input.pfilter');
    await r.type(input, 'refund');
    expect(r.all('[role="option"]').map((o) => o.textContent)).toEqual(['a01', 'b02']);
    expect(r.one(`[id="${input.getAttribute('aria-activedescendant')}"]`).textContent).toBe('a01');
    await r.type(input, 'zzz');
    expect(r.all('[role="listbox"]')).toEqual([]);
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    expect(input.hasAttribute('aria-controls')).toBe(false);
    expect(r.one('.pnone').textContent).toBe('Nothing matches.');
    expect(r.one('.pop [role="status"]').textContent).toBe('Nothing matches.');
    // Enter with nothing lit picks nothing.
    await r.press('Enter');
    expect(r.all('.pop')).toHaveLength(1);
  });

  it('says "Nothing matches." from a live region there since it opened, the line drawn for the eye only', async () => {
    r = await render(shell({}, createElement(Opener, { key: 'picker', onPick: () => undefined })));
    await r.click(r.one('#pick'));
    // Open, with its rows: the region is there, empty.
    const region = r.one('.pop.picker .said > [role="status"]');
    expect(region.textContent).toBe('');
    await r.type(r.one('input.pfilter'), 'zzz');
    expect(r.one('.pop.picker .said > [role="status"]')).toBe(region);
    expect(region.textContent).toBe('Nothing matches.');
    const drawn = r.one('.pnone');
    expect([drawn.textContent, drawn.getAttribute('aria-hidden'), drawn.hasAttribute('role')]).toEqual(['Nothing matches.', 'true', false]);
    // A word that finds rows again takes the words away.
    await r.type(r.one('input.pfilter'), 'refund');
    expect([r.one('.pop.picker .said > [role="status"]') === region, region.textContent]).toEqual([true, '']);
  });

  it('picks with Enter or a click, and hands the focus back to its button; Esc and Tab close it', async () => {
    const picked = vi.fn();
    r = await render(shell({}, createElement(Opener, { key: 'picker', onPick: picked })));
    await r.click(r.one('#pick'));
    await r.press('ArrowUp');
    await r.press('Enter');
    expect(picked).toHaveBeenCalledExactlyOnceWith('a');
    expect(r.all('.pop')).toEqual([]);
    expect(words(r.focused())).toBe('button Pick');
    await r.click(r.one('#pick'));
    await r.click(r.all('[role="option"]')[2]);
    expect(picked).toHaveBeenLastCalledWith('c');
    expect(words(r.focused())).toBe('button Pick');
    await r.click(r.one('#pick'));
    await r.press('Escape');
    expect(r.all('.pop')).toEqual([]);
    expect(words(r.focused())).toBe('button Pick');
  });

  it('keeps the page’s keys off a typed word, the field taking each letter', async () => {
    const pageKeys = vi.fn(() => true);
    r = await render(shell({ runKeys: { current: pageKeys } }, createElement(Opener, { key: 'picker', onPick: () => undefined })));
    await r.click(r.one('#pick'));
    const e = await r.press('j');
    expect(pageKeys).not.toHaveBeenCalled();
    // Left to the field: its default isn't prevented.
    expect(e.defaultPrevented).toBe(false);
  });

  it('opens on its filter from a key, a touch screen included, and on its list from a tap, so the phone’s keyboard stays closed', async () => {
    media({ phone: true, touch: true });
    vi.useFakeTimers({ toFake: ['Date'] });
    // No key pressed just now, in another test.
    vi.advanceTimersByTime(1000);
    r = await render(shell({}, createElement(Opener, { key: 'picker', onPick: () => undefined })));
    await r.click(r.one('#pick'));
    expect(r.one('.pop').className).toContain('sheet');
    expect(r.focused()).toBe(r.one('.pklist'));
    await r.press('Escape');
    r.one('#pick').focus();
    await r.press('Enter');
    await r.fire(r.one('#pick'), 'click');
    expect(r.focused()).toBe(r.one('input.pfilter'));
  });

  it('is what a run picker opens, finding a run by its id, its about line or a label', async () => {
    const runs = [
      { runId: '01M5GRX4VYT0S34ZZX4WBXJKD1', about: { text: 'Ticket T-8812', from: 'user' as const }, labels: ['refund-flow'] },
      { runId: '01M5GRX8K4T0S34ZZX4WBXJKD1', about: null, labels: [] },
    ] as never[];
    const picked = vi.fn();
    r = await render(shell({}, createElement(RunPicker, { key: 'run', label: 'Run A', value: '01M5GRX4VYT0S34ZZX4WBXJKD1', runs, onPick: picked })));
    const button = r.one('.rpick');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await r.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(r.one('.pop').className).toContain('curmark');
    expect(r.all('[role="option"] code').map((c) => c.textContent)).toEqual(['01M5GRX4VY', '01M5GRX8K4']);
    await r.type(r.one('input.pfilter'), 'refund-flow');
    expect(r.all('[role="option"] code').map((c) => c.textContent)).toEqual(['01M5GRX4VY']);
    await r.type(r.one('input.pfilter'), 'X8K4');
    await r.press('Enter');
    expect(picked).toHaveBeenCalledExactlyOnceWith('01M5GRX8K4T0S34ZZX4WBXJKD1');
    await r.click(button);
    await r.press('Enter');
    // The one already picked picks nothing new.
    expect(picked).toHaveBeenCalledTimes(1);
    expect(r.focused()).toBe(button);
  });

  it('takes its button’s width, within the window’s margins and at least the narrower menu’s', () => {
    expect(menuWidthAt(320, 1440)).toBe(320);
    expect(menuWidthAt(120, 1440)).toBe(280);
    expect(menuWidthAt(600, 390)).toBe(366);
  });
});
