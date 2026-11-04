import { createElement, type ComponentType, type JSX } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { onShow } from '../ui/components/OnShow.js';
import { render, type Rendered } from './ui-render.js';

/**
 * A part of a page in a script of its own (`onShow`): what waits in its place shows until the script
 * comes, then the part. Once the script is in, the part draws at once wherever it shows next, and
 * ahead of its first showing when preloaded, with nothing waiting in its place for a single frame.
 * A script that fails to come leaves what `failed` gives wherever the part shows, never the page
 * blank, and is never asked for again: a browser keeps a script's failure for as long as the page is
 * open, so only loading the page again brings it.
 */

type Props = { n: number };

function Part({ n }: Props): JSX.Element {
  return createElement('p', { className: 'part' }, `part ${n}`);
}

/** What waits in a part's place, and how many times it was drawn. */
function waiting() {
  const w = {
    drawn: 0,
    element: createElement(function Waiting() {
      w.drawn++;
      return createElement('p', { className: 'waiting' }, 'waiting');
    }),
  };
  return w;
}

const FAILED = createElement('p', { className: 'failed' }, 'couldn’t load');

/** A part's script that comes, or fails, when the test says; how often it was asked for. */
function script() {
  let settle: { give: () => void; refuse: () => void } = { give: () => undefined, refuse: () => undefined };
  const s = {
    asked: 0,
    load: () => {
      s.asked++;
      return new Promise<ComponentType<Props>>((give, refuse) => {
        settle = { give: () => give(Part), refuse: () => refuse(new TypeError('Failed to fetch dynamically imported module')) };
      });
    },
    give: () => settle.give(),
    refuse: () => settle.refuse(),
  };
  return s;
}

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

const texts = (sel: string) => r!.all(sel).map((el) => el.textContent);

describe('a part of a page in a script of its own', () => {
  it('waits in its place until its script comes, asked for once wherever it shows, then draws', async () => {
    const s = script();
    const w = waiting();
    const Shown = onShow(s.load, { waiting: w.element, failed: FAILED });
    expect(Shown.script).toBe('idle');
    r = await render(createElement('div', null, createElement(Shown, { n: 1 }), createElement(Shown, { n: 2 })));
    expect(texts('.waiting')).toEqual(['waiting', 'waiting']);
    expect(s.asked).toBe(1);
    expect(Shown.script).toBe('loading');
    s.give();
    await r.until('the parts', () => r!.all('.part').length === 2);
    expect(texts('.part')).toEqual(['part 1', 'part 2']);
    expect(r.all('.waiting')).toHaveLength(0);
    expect(r.all('.failed')).toHaveLength(0);
    expect(s.asked).toBe(1);
    expect(Shown.script).toBe('loaded');
  });

  it('draws at once wherever it shows once its script is in, and ahead of its first showing when preloaded, nothing waiting in its place for a frame', async () => {
    const s = script();
    const w = waiting();
    const Shown = onShow(s.load, { waiting: w.element });
    Shown.preload();
    Shown.preload();
    expect(s.asked).toBe(1);
    s.give();
    await Promise.resolve();
    expect(Shown.script).toBe('loaded');
    r = await render(createElement(Shown, { n: 3 }));
    expect(texts('.part')).toEqual(['part 3']);
    // Not one frame of what waits: the part is its first.
    expect(w.drawn).toBe(0);
    await r.unmount();
    r = await render(createElement(Shown, { n: 4 }));
    expect(texts('.part')).toEqual(['part 4']);
    expect(w.drawn).toBe(0);
    expect(s.asked).toBe(1);
  });

  it('gives what failed says wherever it shows once its script fails to come, from the first frame after, and never asks for it again', async () => {
    const s = script();
    const w = waiting();
    const Shown = onShow(s.load, { waiting: w.element, failed: FAILED });
    r = await render(createElement('div', null, createElement(Shown, { n: 5 }), createElement(Shown, { n: 6 })));
    expect(texts('.waiting')).toEqual(['waiting', 'waiting']);
    s.refuse();
    await r.until('what failed says', () => r!.all('.failed').length === 2);
    expect(r.all('.waiting')).toHaveLength(0);
    expect(r.all('.part')).toHaveLength(0);
    expect(Shown.script).toBe('failed');
    // Shown again, and preloaded: the browser would refuse it again without asking, so it isn't asked.
    await r.unmount();
    const drawn = w.drawn;
    Shown.preload();
    r = await render(createElement(Shown, { n: 7 }));
    await r.wait(20);
    expect(texts('.failed')).toEqual(['couldn’t load']);
    expect(w.drawn).toBe(drawn);
    expect(s.asked).toBe(1);
    expect(Shown.script).toBe('failed');
  });

  it('leaves nothing in its place, waiting or failed, when given nothing to show', async () => {
    const s = script();
    const Shown = onShow(s.load);
    r = await render(createElement('div', { className: 'holds' }, createElement(Shown, { n: 8 })));
    expect(r.one('.holds').childNodes).toHaveLength(0);
    s.refuse();
    await r.wait(20);
    expect(Shown.script).toBe('failed');
    expect(r.one('.holds').childNodes).toHaveLength(0);
  });
});
