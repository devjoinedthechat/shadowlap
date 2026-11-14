import { describe, expect, it } from 'vitest';
import { walkthroughSvg } from '../../../scripts/walkthrough-svg.mjs';

/**
 * scripts/walkthrough-svg.mjs draws the README's dashboard walkthrough from pictures readme-shots.mjs
 * takes of the real dashboard: each page in turn, a pointer that presses what leads to the next, and
 * the first page again. Drawn here from stand-in pictures, as the drawing never reads them.
 */
const page = (image: string, hold: number, at: { press?: { x: number; y: number }; rest?: { x: number; y: number } }) => ({ image, hold, ...at });
const draw = (o: Partial<Parameters<typeof walkthroughSvg>[0]> = {}): string =>
  walkthroughSvg({
    width: 1280,
    height: 800,
    radius: 16,
    start: { x: 980, y: 560 },
    still: 1,
    title: 'Runs › Failed & a "fix"',
    desc: 'From <a> failed run to its fix',
    pages: [page('QUFB', 4, { press: { x: 540, y: 455 } }), page('QkJC', 6, { press: { x: 1160, y: 95 } }), page('Q0ND', 7, { rest: { x: 780, y: 640 } })],
    ...o,
  });

/** The percentages of the keyframes named `k`, in the order written. */
function stops(svg: string, k: string): number[] {
  const body = new RegExp(`@keyframes ${k}\\{(.*?)\\}(?=\\.|\\n|@media)`, 's').exec(svg)?.[1] ?? '';
  return [...body.matchAll(/([\d.]+)%\{/g)].map((m) => Number(m[1]));
}

describe('scripts/walkthrough-svg.mjs', () => {
  it('shows each page in turn over the first, with a ring at each press and a pointer that never goes back in time', () => {
    const svg = draw();
    expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 1280 800" role="img" aria-labelledby="title desc">/);
    expect(svg).toContain('<title id="title">Runs › Failed &amp; a &quot;fix&quot;</title>');
    expect(svg).toContain('<desc id="desc">From &lt;a&gt; failed run to its fix</desc>');
    expect(svg.match(/href="data:image\/webp;base64,/g)).toHaveLength(3);
    // The first page stays under the rest; the later two come in, each with its own animation.
    expect(svg).toMatch(/<g class="f"><image[^>]*QUFB/);
    expect(svg.match(/<g class="f k\d+[^"]*"><image/g)).toHaveLength(2);
    // A ring at each press, where the pointer presses, and none on the last page, where it rests.
    expect([...svg.matchAll(/<circle class="r k\d+" cx="([\d.]+)" cy="([\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])])).toEqual([
      [540, 455],
      [1160, 95],
    ]);
    const moves = /<g class="p k\d+"><g class="(k\d+)">/.exec(svg)?.[1] ?? '';
    const at = stops(svg, moves);
    expect(at[0]).toBe(0);
    expect(at.at(-1)).toBe(100);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('holds the still page where motion is unwanted, with no pointer', () => {
    const svg = draw();
    expect(svg).toContain('@media (prefers-reduced-motion:reduce){.f{animation:none!important;opacity:0!important}.f.still{opacity:1!important}.p,.r{display:none}}');
    expect(svg).toMatch(/<g class="f k\d+ still"><image[^>]*QkJC/);
  });

  it('asks every page but the last to press, and the last to rest', () => {
    expect(() => draw({ pages: [page('QUFB', 4, { press: { x: 1, y: 1 } }), page('QkJC', 6, { press: { x: 2, y: 2 } })] })).toThrow(/the last rests/);
    expect(() => draw({ pages: [page('QUFB', 4, {}), page('QkJC', 6, { rest: { x: 2, y: 2 } })] })).toThrow(/each page but the last presses/);
    expect(() => draw({ pages: [page('QUFB', 4, { rest: { x: 2, y: 2 } })] })).toThrow(/two pages or more/);
  });
});
