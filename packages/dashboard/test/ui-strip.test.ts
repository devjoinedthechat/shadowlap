import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Strip, type StripCall } from '../ui/components/Strip.js';
import { moveCell, stripCells, stripTabStop } from '../ui/strip.js';

/**
 * The origin strip as one stop for Tab: every cell was a button in the tab order, so 358 presses
 * stood between a 19,999-call run's header and its views. Now the selected call's cell takes Tab,
 * and the arrow keys move between cells, as on the Runs calendar.
 */

const calls = (n: number): StripCall[] => Array.from({ length: n }, (_, i) => ({ n: i + 1, origin: 'live', name: 'lookup_order', detail: 'read' }));
const stops = (html: string) => [...html.matchAll(/<button[^>]*tabindex="(-?\d)"/g)].map((m) => m[1]);

describe('the origin strip and the keyboard', () => {
  it('is one stop for Tab, on the selected call’s cell', () => {
    const html = renderToStaticMarkup(createElement(Strip, { calls: calls(30), selected: 7, forkAt: null, lostAt: null, onSelect: () => undefined }));
    const tabs = stops(html);
    expect(tabs).toHaveLength(30);
    expect(tabs.filter((t) => t === '0')).toHaveLength(1);
    expect(tabs.indexOf('0')).toBe(6);
    // A long run's binned strip too: 358 cells, one stop.
    const long = stops(renderToStaticMarkup(createElement(Strip, { calls: calls(19_999), selected: null, forkAt: null, lostAt: null, onSelect: () => undefined })));
    expect(long.length).toBeGreaterThan(300);
    expect(long.filter((t) => t === '0')).toEqual(['0']);
    expect(long[0]).toBe('0');
  });

  it('takes Tab where the arrows left it while the focus stays in the strip, else on the selected cell', () => {
    const cells = stripCells(
      calls(5).map((c) => ({ n: c.n, origin: c.origin })),
      { selected: 3, forkAt: null, lostAt: null },
    );
    expect(stripTabStop(cells, null)).toBe(2);
    expect(stripTabStop(cells, 4)).toBe(4);
    expect(stripTabStop(cells, 9)).toBe(2);
    expect(stripTabStop([{ selected: false }, { selected: false }], null)).toBe(0);
  });

  it('moves with ← and →, and to the ends with Home and End', () => {
    expect(moveCell(3, 'ArrowRight', 10)).toBe(4);
    expect(moveCell(3, 'ArrowLeft', 10)).toBe(2);
    expect(moveCell(3, 'Home', 10)).toBe(0);
    expect(moveCell(3, 'End', 10)).toBe(9);
    expect(moveCell(0, 'ArrowLeft', 10)).toBeNull();
    expect(moveCell(9, 'ArrowRight', 10)).toBeNull();
    expect(moveCell(3, 'ArrowDown', 10)).toBeNull();
  });
});
