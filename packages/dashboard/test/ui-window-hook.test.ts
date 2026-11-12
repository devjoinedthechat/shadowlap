import { act, createElement, useMemo, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { useWindow, type Windowed } from '../ui/run/window-hook.js';
import { render, type FakeElement } from './ui-render.js';

/**
 * The row a long list is asked to show stays in view as the rows above it change, until the reader
 * scrolls; also when the reader's scroll comes in the frame a page of rows is drawn, before its
 * event, which the list must not take for a move of its own. The fake page has no layout, so the box
 * and the list are given the geometry a browser gives them: a box 300px tall over a list as tall as
 * its rows, the list's top moving up as the box scrolls.
 */

const ROW = 30;

interface Api {
  show?: Windowed['show'];
  more?: () => void;
}

function List({ api }: { api: Api }) {
  const [n, setN] = useState(100);
  const rows = useMemo(() => Array.from({ length: n }, (_, i) => i), [n]);
  const w = useWindow(rows, { keyOf: (r) => r, shapeOf: () => 'row', estimate: () => ROW, box: (l) => (l.parentNode?.parentNode ?? null) as HTMLElement | null });
  api.show = w.show;
  api.more = () => setN((x) => x + 100);
  const drawn = rows.slice(w.start, w.end).map((r) => createElement('tr', { key: r, 'data-wi': r }, createElement('td', null, String(r))));
  return createElement('div', { className: 'box' }, createElement('table', null, createElement('tbody', { ref: w.listRef }, ...drawn)));
}

/** The box 300px tall over a list `tall` px tall, the list's top where a browser puts it: up by what the box has scrolled. */
function laidOut(box: FakeElement, body: FakeElement, tall: { px: number }): void {
  Object.defineProperty(box, 'clientHeight', { value: 300 });
  Object.defineProperty(box, 'scrollHeight', { get: () => tall.px });
  body.getBoundingClientRect = () => ({ left: 0, top: -box.scrollTop, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: -box.scrollTop });
}

/** Where a row shows centred: its top, less half the box, plus half its own height. */
const centred = (i: number) => i * ROW - 150 + ROW / 2;

async function list(): Promise<{ api: Api; box: FakeElement; tall: { px: number }; done: () => Promise<void> }> {
  const api: Api = {};
  const r = await render(createElement(List, { api }));
  const box = r.one('.box');
  const tall = { px: 100 * ROW };
  laidOut(box, r.one('tbody'), tall);
  return { api, box, tall, done: () => r.unmount() };
}

describe('a long list’s row asked for', () => {
  it('is kept in view as pages of rows come, and let go of once the reader scrolls, before the scroll’s event too', async () => {
    const { api, box, done } = await list();
    api.show!(50, { centre: true });
    expect(box.scrollTop).toBe(centred(50));
    // A page comes with the reader still: the row stays where it was put.
    await act(async () => api.more!());
    expect(box.scrollTop).toBe(centred(50));
    // The reader scrolls to the top, and a page is drawn before the scroll's event comes: the reader's place holds.
    box.scrollTop = 0;
    await act(async () => api.more!());
    expect(box.scrollTop).toBe(0);
    // Let go of for good: the next page leaves it there too.
    await act(async () => api.more!());
    expect(box.scrollTop).toBe(0);
    // A row asked for anew is placed from where the reader left the list.
    api.show!(80, { centre: true });
    expect(box.scrollTop).toBe(centred(80));
    await done();
  });

  it('is kept while the list grows shorter under it and the box is held at its end, which is no scroll of the reader’s', async () => {
    const { api, box, tall, done } = await list();
    api.show!(50, { centre: true });
    // The list folds to 900px as its pages are read: the browser holds the box at its end, 600.
    tall.px = 900;
    box.scrollTop = 600;
    await act(async () => api.more!());
    expect(box.scrollTop).toBe(centred(50));
    await done();
  });
});
