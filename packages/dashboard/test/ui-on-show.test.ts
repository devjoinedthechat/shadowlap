import { createElement, type ComponentType, type JSX } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { onShow } from '../ui/components/OnShow.js';
import { render, type Rendered } from './ui-render.js';

/**
 * A part of a page in a script of its own (`onShow`): what waits in its place shows until the script
 * comes, then the part; once the script is in, the part draws at once wherever it shows next, and
 * ahead of its first showing when preloaded. A load that failed leaves what waits in its place, never
 * the page blank, and the script is asked for again the next time the part shows.
 */

type Props = { n: number };

function Part({ n }: Props): JSX.Element {
  return createElement('p', { className: 'part' }, `part ${n}`);
}

const WAITING = createElement('p', { className: 'waiting' }, 'waiting');

/** A part's script that comes, or fails, when the test says; how often it was asked for. */
function script() {
  let settle: { give: () => void; refuse: () => void } = { give: () => undefined, refuse: () => undefined };
  const s = {
    asked: 0,
    load: () => {
      s.asked++;
      return new Promise<ComponentType<Props>>((give, refuse) => {
        settle = { give: () => give(Part), refuse: () => refuse(new Error('the server answered 503')) };
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
    const Shown = onShow(s.load, WAITING);
    r = await render(createElement('div', null, createElement(Shown, { n: 1 }), createElement(Shown, { n: 2 })));
    expect(texts('.waiting')).toEqual(['waiting', 'waiting']);
    expect(s.asked).toBe(1);
    s.give();
    await r.until('the parts', () => r!.all('.part').length === 2);
    expect(texts('.part')).toEqual(['part 1', 'part 2']);
    expect(r.all('.waiting')).toHaveLength(0);
    expect(s.asked).toBe(1);
  });

  it('draws at once wherever it shows once its script is in, and ahead of its first showing when preloaded', async () => {
    const s = script();
    const Shown = onShow(s.load, WAITING);
    Shown.preload();
    Shown.preload();
    expect(s.asked).toBe(1);
    s.give();
    await Promise.resolve();
    r = await render(createElement(Shown, { n: 3 }));
    // Its first frame is the part: nothing waited in its place.
    expect(texts('.part')).toEqual(['part 3']);
    expect(r.all('.waiting')).toHaveLength(0);
    await r.unmount();
    r = await render(createElement(Shown, { n: 4 }));
    expect(texts('.part')).toEqual(['part 4']);
    expect(s.asked).toBe(1);
  });

  it('leaves what waits in its place when its script fails to come, and asks again the next time it shows', async () => {
    const s = script();
    const Shown = onShow(s.load, WAITING);
    r = await render(createElement(Shown, { n: 5 }));
    s.refuse();
    await r.wait(20);
    expect(texts('.waiting')).toEqual(['waiting']);
    expect(s.asked).toBe(1);
    await r.unmount();
    r = await render(createElement(Shown, { n: 6 }));
    expect(s.asked).toBe(2);
    s.give();
    await r.until('the part', () => r!.all('.part').length === 1);
    expect(texts('.part')).toEqual(['part 6']);
  });
});
