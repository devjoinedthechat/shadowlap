import { createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HoverCardLayer, hideTip, markTipTargets, tipCard, tipClauses, tipCmd } from '../ui/components/HoverCard.js';
import { useMenu } from '../ui/components/Popover.js';
import { placeTip } from '../ui/place.js';
import { menuOf, noMedia, shell } from './ui-overlays-page.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';

/**
 * Hover cards: when one shows for a pointer, the keyboard and a finger, what points at it, what it
 * never covers, what it says, and what takes the focus for its card. The real browser checks the same
 * on the pages (browser/overlays.spec.ts).
 */

let r: Rendered | null = null;
afterEach(async () => {
  hideTip();
  await r?.unmount();
  r = null;
  vi.useRealTimers();
  noMedia();
});

beforeAll(() => {
  Object.assign(globalThis, { innerWidth: 1440, innerHeight: 900 });
});

describe('a hover card', () => {
  const card = () => r!.one('#tip');
  const fact = (over: Record<string, unknown> = {}) => createElement('span', { id: 'fact', 'data-tip': tipCard('Spent', [{ label: 'live', value: '$1.20' }], 'What ran live'), tabIndex: 0, ...over }, 'Spent');

  const page = (...parts: ReactNode[]) => shell({}, createElement(HoverCardLayer, { key: 'cards' }), ...parts);

  it('waits 400 ms for a pointer, and the next shows at once while one was showing', async () => {
    r = await render(page(createElement('div', { key: 'facts' }, fact(), createElement('span', { id: 'next', 'data-tip': tipCard('Saved', []) }, 'Saved'))));
    expect(card().hasAttribute('hidden')).toBe(true);
    await r.fire(r.one('#fact'), 'pointerover', { pointerType: 'mouse', clientX: 10 });
    await r.wait(300);
    expect(card().hasAttribute('hidden')).toBe(true);
    await r.wait(150);
    expect(card().hasAttribute('hidden')).toBe(false);
    expect(card().textContent).toContain('Spent');
    expect(r.one('#fact').getAttribute('aria-describedby')).toBe('tip');
    await r.fire(r.one('#next'), 'pointerover', { pointerType: 'mouse', clientX: 10 });
    await r.wait(0);
    expect(card().textContent).toContain('Saved');
    expect(r.one('#fact').hasAttribute('aria-describedby')).toBe(false);
    expect(r.one('#next').getAttribute('aria-describedby')).toBe('tip');
  });

  it('never shows for a pointer that moved off before its wait', async () => {
    r = await render(page(createElement('div', { key: 'facts', id: 'around' }, fact())));
    await r.fire(r.one('#fact'), 'pointerover', { pointerType: 'mouse', clientX: 10 });
    await r.fire(r.one('#around'), 'pointerover', { pointerType: 'mouse', clientX: 10 });
    await r.wait(450);
    expect(card().hasAttribute('hidden')).toBe(true);
  });

  it('shows at once for the keyboard’s focus, and goes with it, beside what already describes its element', async () => {
    r = await render(page(fact({ key: 'fact', 'aria-describedby': 'def' })));
    await r.focus(r.one('#fact'));
    expect(card().hasAttribute('hidden')).toBe(false);
    expect(r.one('#fact').getAttribute('aria-describedby')).toBe('def tip');
    await r.fire(r.one('#fact'), 'focusout');
    expect(card().hasAttribute('hidden')).toBe(true);
    expect(r.one('#fact').getAttribute('aria-describedby')).toBe('def');
  });

  it('points the control with the focus at the card of the line it sits in', async () => {
    r = await render(page(createElement('span', { key: 'line', id: 'line', 'data-tip': tipCard('A line', []) }, createElement('a', { href: '#/run/1/18', id: 'link' }, '#18'))));
    await r.focus(r.one('#link'));
    expect(card().hasAttribute('hidden')).toBe(false);
    expect(r.one('#link').getAttribute('aria-describedby')).toBe('tip');
    expect(r.one('#line').hasAttribute('aria-describedby')).toBe(false);
    await r.fire(r.one('#link'), 'focusout');
    expect(r.one('#link').hasAttribute('aria-describedby')).toBe(false);
  });

  it('toggles on a tap on a fact, and no tap on a link or a button shows one', async () => {
    r = await render(page(createElement('div', { key: 'facts' }, fact(), createElement('button', { type: 'button', id: 'act', 'data-tip': tipCard('Replay', []) }, 'Replay'))));
    const tap = async (el: FakeElement) => {
      await r!.fire(el, 'pointerdown', { pointerType: 'touch' });
      await r!.fire(el, 'click');
    };
    await tap(r.one('#fact'));
    expect(card().textContent).toContain('Spent');
    await tap(r.one('#fact'));
    expect(card().hasAttribute('hidden')).toBe(true);
    await tap(r.one('#act'));
    expect(card().hasAttribute('hidden')).toBe(true);
    // A finger's pointerover shows nothing by itself.
    await r.fire(r.one('#fact'), 'pointerover', { pointerType: 'touch', clientX: 1 });
    await r.wait(450);
    expect(card().hasAttribute('hidden')).toBe(true);
  });

  it('goes on a click, which acts, and comes back on the next move', async () => {
    r = await render(page(fact({ key: 'fact' })));
    await r.focus(r.one('#fact'));
    await r.fire(r.one('#fact'), 'pointerdown', { pointerType: 'mouse' });
    await r.fire(r.one('#fact'), 'click');
    expect(card().hasAttribute('hidden')).toBe(true);
  });

  it('never shows over the menu its button opened: while a menu is open only its rows have cards', async () => {
    function WithMenu() {
      const menu = useMenu();
      return createElement(
        'div',
        null,
        createElement('button', { type: 'button', id: 'share', 'data-tip': tipCard('Share', []), onClick: (e: { currentTarget: HTMLElement }) => menu.toggle(e.currentTarget) }, 'Share'),
        menu.anchor ? menuOf({ anchor: menu.anchor, onClose: menu.close, label: 'Share' }, createElement('button', { type: 'button', id: 'row', role: 'menuitem', 'data-tip': tipCard('HTML report', [], 'These views in one file') }, createElement('b', null, 'HTML report'))) : null,
      );
    }
    r = await render(page(createElement(WithMenu, { key: 'menu' })));
    await r.click(r.one('#share'));
    await r.fire(r.one('#share'), 'pointerover', { pointerType: 'mouse', clientX: 1 });
    await r.wait(450);
    expect(card().hasAttribute('hidden')).toBe(true);
    await r.fire(r.one('#row'), 'pointerover', { pointerType: 'mouse', clientX: 1 });
    await r.wait(450);
    expect(card().textContent.replace(/\u00a0/g, ' ')).toContain('These views in one file');
    // Esc hides it in the press that closes the menu.
    await r.press('Escape');
    expect(card().hasAttribute('hidden')).toBe(true);
    expect(r.all('[role="menu"]')).toEqual([]);
  });

  it('hides on the page’s Esc first, and only the next one goes on', async () => {
    const setSideOpen = vi.fn();
    r = await render(shell({ sideOpen: false, setSideOpen }, createElement(HoverCardLayer, { key: 'cards' }), fact({ key: 'fact' })));
    await r.focus(r.one('#fact'));
    expect(card().hasAttribute('hidden')).toBe(false);
    await r.press('Escape');
    expect(card().hasAttribute('hidden')).toBe(true);
  });

  it('draws a command up to its first arguments, a row too long stacked, and a line a sentence', async () => {
    r = await render(page(createElement('span', { key: 'long', id: 'long', tabIndex: 0, 'data-tip': tipCard('Run repair', [{ label: 'the check it fails', value: 'called 0 times; tools called: lookup_order' }], 'First line\nSecond line', '$ shadowlap repair --fixes label:pushy-customer --keeps label:good --budget 12.50 --attempts 5') }, 'Run repair')));
    await r.focus(r.one('#long'));
    expect(r.all('#tip .ts')).toHaveLength(2);
    expect(r.one('#tip div').className).toBe('stk');
    expect(r.one('#tip code').textContent).toBe('$ shadowlap repair --fixes label:pushy-customer …');
  });

  it('keeps a definition’s clauses whole on a term’s card, and lets one with a longer clause flow', async () => {
    expect(tipClauses('The tally’s bound on the pass rate, at the confidence in brackets, exact under the gate that stopped it')).toEqual(['The tally’s bound on the pass rate,', 'at the confidence in brackets,', 'exact under the gate that stopped it']);
    expect(tipClauses('A recorded run kept as a test: CI replays it on every commit (live from its fork for a fork golden) and judges it')).toEqual(['A recorded run kept as a test:', 'CI replays it on every commit', '(live from its fork for a fork golden)', 'and judges it']);
    expect(tipClauses('One short line')).toBeNull();
    expect(tipClauses(`${'a long clause '.repeat(6)}, and an end`)).toBeNull();
    r = await render(page(createElement('span', { key: 'term', id: 'term', className: 'term on', tabIndex: 0, 'data-tip': JSON.stringify({ t: 'golden', s: 'A recorded run kept as a test: CI replays it on every commit' }) }, 'golden')));
    await r.focus(r.one('#term'));
    expect(card().className).toContain('gl');
    expect(r.all('#tip .tcl').map((c) => c.textContent.trim())).toEqual(['A recorded run kept as a test:', 'CI replays it on every commit']);
  });

  it('shortens only a long command, and quotes what has no $ whole', () => {
    expect(tipCmd('$ shadowlap test goldens/*')).toBe('$ shadowlap test goldens/*');
    const long = `{"tools":{"send_email":${'1'.repeat(80)}}}`;
    expect(tipCmd(long)).toBe(long);
    expect(tipCmd(`$ shadowlap verify --fixes 01M5GRX4VY --expect '{"tools":{"send_email":{"<=":1}}}' --set temperature=1`)).toBe('$ shadowlap verify --fixes 01M5GRX4VY --expect …');
  });

  it('goes under its element at its left edge, over it where there is no room, a wide row’s near the pointer, a menu row’s beside the menu', () => {
    const view = { width: 1440, height: 900 };
    const card2 = { width: 300, height: 100 };
    const el = { left: 200, right: 280, top: 300, bottom: 320 };
    expect(placeTip(el, card2, view)).toEqual({ left: 200, top: 328 });
    expect(placeTip({ ...el, top: 800, bottom: 820 }, card2, view)).toEqual({ left: 200, top: 692 });
    // Near the pointer on a wide row.
    expect(placeTip({ ...el, right: 800 }, card2, view, { x: 500 })).toEqual({ left: 476, top: 328 });
    expect(placeTip(el, card2, view, { x: 500 })).toEqual({ left: 200, top: 328 });
    // Beside a menu, on the side with room, level with its row.
    expect(placeTip(el, card2, view, { menu: { left: 100, right: 440 } })).toEqual({ left: 448, top: 300 });
    expect(placeTip(el, card2, view, { menu: { left: 1000, right: 1340 } })).toEqual({ left: 692, top: 300 });
    // Never over a dialog's footer: it goes over its element.
    expect(placeTip({ ...el, top: 400, bottom: 420 }, card2, view, { foot: 500 })).toEqual({ left: 200, top: 292 });
    // Kept 8px inside the window.
    expect(placeTip({ left: 1400, right: 1420, top: 2, bottom: 12 }, card2, view).left).toBe(1132);
  });
});

describe('what takes the focus for its card', () => {
  it('is what stands on its own; in a row or a chart a mark with no words is an image named by its card', async () => {
    r = await render(
      createElement(
        'div',
        { id: 'root' },
        createElement('span', { id: 'alone', 'data-tip': tipCard('Spent', []) }, 'Spent'),
        createElement('button', { type: 'button', id: 'act', 'data-tip': tipCard('Replay', []) }, 'Replay'),
        createElement('a', { href: '#/', id: 'link', 'data-tip': tipCard('Open', []) }, createElement('span', { id: 'inlink', 'data-tip': tipCard('Inside', []) }, 'Inside')),
        createElement('table', null, createElement('tbody', null, createElement('tr', null, createElement('td', null, createElement('span', { id: 'inrow', 'data-tip': tipCard('Failed', []) }, 'failed'), createElement('i', { id: 'cell', 'data-tip': tipCard('rev a7b3', [{ label: 'failed', value: 'exit 1' }], 'at 12:30') }))))),
        createElement('div', { className: 'groups' }, createElement('div', { id: 'day', 'data-tip': tipCard('Oct 3', [{ label: 'spent', value: '$1' }]) })),
        createElement('div', { role: 'img', 'aria-label': 'Attempts' }, createElement('i', { id: 'attempt', 'data-tip': tipCard('attempt 1', []) })),
        createElement('div', { 'aria-hidden': 'true' }, createElement('i', { id: 'hidden', 'data-tip': tipCard('Key', []) })),
        createElement('span', { id: 'stop', tabIndex: -1, 'data-tip': tipCard('Own', []) }, 'Own'),
        createElement('span', { id: 'holds', 'data-tip': tipCard('A line', []) }, 'failed at ', createElement('a', { href: '#/run/1/18' }, '#18')),
      ),
    );
    markTipTargets(r.one('#root') as unknown as ParentNode);
    expect(r.one('#alone').getAttribute('tabindex')).toBe('0');
    expect(r.one('#act').hasAttribute('tabindex')).toBe(false);
    expect(r.one('#inlink').hasAttribute('tabindex')).toBe(false);
    expect(r.one('#inrow').hasAttribute('tabindex')).toBe(false);
    expect(r.one('#inrow').hasAttribute('role')).toBe(false);
    expect([r.one('#cell').getAttribute('role'), r.one('#cell').getAttribute('aria-label')]).toEqual(['img', 'rev a7b3, at 12:30, failed exit 1']);
    expect(r.one('#cell').hasAttribute('tabindex')).toBe(false);
    expect(r.one('#day').getAttribute('role')).toBe('img');
    expect(r.one('#attempt').hasAttribute('role')).toBe(false);
    expect(r.one('#hidden').hasAttribute('tabindex')).toBe(false);
    expect(r.one('#stop').getAttribute('tabindex')).toBe('-1');
    // A control in it is the stop.
    expect(r.one('#holds').hasAttribute('tabindex')).toBe(false);
  });
});
