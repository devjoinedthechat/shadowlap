import { describe, expect, it } from 'vitest';
import { lineCells, tuiSvg } from '../../../scripts/tui-svg.mjs';

/**
 * scripts/tui-svg.mjs draws the README's terminal UI recording from the screens `shadowlap ui`
 * writes, which readme-shots.mjs takes: each screen in turn, then the first again. Drawn here from
 * stand-in screens, as the drawing reads only their text and their escape codes.
 */
const fg = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;
const bg = (r: number, g: number, b: number) => `\x1b[48;2;${r};${g};${b}m`;
const RED = fg(255, 107, 94);
const FAINT = fg(142, 140, 121);
const SEL = bg(29, 30, 27);
const BOLD = '\x1b[1m';
const PLAIN = '\x1b[22m';
const INK = '\x1b[39m';
const GROUND = '\x1b[49m';

/** Three screens of a terminal 20 columns by 3 rows: the first row the same in all, the second the cursor's, the third a box's top. */
const HEAD = ` ${BOLD}runs${PLAIN} ${FAINT}· 2${INK}`;
const screens = [
  [HEAD, `${SEL}${BOLD}> a <b>${PLAIN} ${RED}lost${INK}${GROUND}`, `${FAINT}╭──╮${INK}`],
  [HEAD, `  a <b> ${RED}lost${INK}`, `${FAINT}╭──╮${INK}`],
  [HEAD, `  a <b> ${RED}lost${INK}`, `${FAINT}│${INK}ok${FAINT}│${INK}`],
].map((lines) => lines.join('\n'));
const draw = (o: Partial<Parameters<typeof tuiSvg>[0]> = {}): string =>
  tuiSvg({
    columns: 20,
    rows: 3,
    still: 1,
    title: 'The UI & its "runs"',
    desc: 'From <runs> to a run',
    scenes: [
      { screen: screens[0], hold: 1 },
      { screen: screens[1], hold: 1 },
      { screen: screens[2], hold: 2 },
    ],
    ...o,
  });

/** The stops of the keyframes named `k`: each percentage with the opacity it sets. */
function stops(svg: string, k: string): Array<[number, number]> {
  const body = new RegExp(`@keyframes ${k}\\{(.*?)\\}(?=\\.|\\n|@media)`, 's').exec(svg)?.[1] ?? '';
  return [...body.matchAll(/([\d.]+)%\{opacity:(\d)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}
/** The groups drawn, a row's or a screen's box lines, each with its classes and what it holds. */
const groups = (svg: string) => [...svg.matchAll(/<g class="(s[^"]*)">(.*?)<\/g>/g)].map((m) => ({ classes: m[1].split(' '), row: m[2] }));

describe('scripts/tui-svg.mjs', () => {
  it('reads a line as cells with the colour, ground and weight its codes gave it, the style carried on, and stops at a code it has no rule for', () => {
    const style = { fg: null, bg: null, bold: false };
    expect(lineCells(`a${RED}${BOLD}b${SEL}c${INK}${PLAIN}${GROUND}d`, style)).toEqual([
      { ch: 'a', fg: null, bg: null, bold: false },
      { ch: 'b', fg: '#ff6b5e', bg: null, bold: true },
      { ch: 'c', fg: '#ff6b5e', bg: '#1d1e1b', bold: true },
      { ch: 'd', fg: null, bg: null, bold: false },
    ]);
    // What a line leaves is how the next starts, as a terminal carries it; a reset clears it all.
    expect(lineCells(`${RED}x`, style)).toEqual([{ ch: 'x', fg: '#ff6b5e', bg: null, bold: false }]);
    expect(lineCells('y\x1b[0mz', style).map((c) => c.fg)).toEqual(['#ff6b5e', null]);
    expect(() => lineCells('\x1b[4munderlined', style)).toThrow(/a style code the picture has no rule for: 4/);
    expect(() => lineCells('\x1b[38;5;196mred', style)).toThrow(/no rule for: 38;5;196/);
    expect(() => lineCells('\x1b[2Kcleared', style)).toThrow(/an escape the picture has no rule for/);
  });

  it('draws a terminal of its columns and rows in the README terminal’s frame, its title and description escaped', () => {
    const svg = draw();
    // 26 px each side of 20 columns of 7.8 px; 22 px over and under 3 rows of 20 px.
    expect(svg).toMatch(/^<svg [^>]*width="208" height="104" viewBox="0 0 208 104" role="img" aria-labelledby="title desc">/);
    expect(svg).toContain('<title id="title">The UI &amp; its &quot;runs&quot;</title>');
    expect(svg).toContain('<desc id="desc">From &lt;runs&gt; to a run</desc>');
    expect(svg).toContain('<rect width="208" height="104" rx="12" fill="#0e0f0b"/>');
  });

  it('draws a row once for all the scenes that show it as it is, and a screen’s box lines likewise, each showing through its own scenes', () => {
    const svg = draw();
    const drawn = groups(svg);
    // The head, the cursor's row twice (selected, then not), the word in the box, then the box's top and its sides: six for twelve.
    expect(drawn).toHaveLength(6);
    const [head, selected, unselected, word, top, sides] = drawn;
    // Shown through every scene: on from the start, with no stop between.
    expect(stops(svg, head.classes.at(-1)!)).toEqual([[0, 1], [100, 1]]);
    // The scenes hold 1 s, 1 s and 2 s of 4: the second comes at 25%, the third at 50%.
    expect(stops(svg, selected.classes.at(-1)!)).toEqual([[0, 1], [25, 0], [100, 0]]);
    expect(stops(svg, unselected.classes.at(-1)!)).toEqual([[0, 0], [25, 1], [100, 1]]);
    expect(stops(svg, top.classes.at(-1)!)).toEqual([[0, 1], [50, 0], [100, 0]]);
    expect(stops(svg, sides.classes.at(-1)!)).toEqual([[0, 0], [50, 1], [100, 1]]);
    // What shows through the same scenes shares its animation: the word and the sides around it.
    expect(word.classes.at(-1)).toBe(sides.classes.at(-1));
    // Each scene's change is a step, never a fade: a terminal draws a screen at once.
    expect(svg.match(/animation-timing-function:step-end/g)!.length).toBeGreaterThan(5);
    expect(svg).not.toMatch(/animation-timing-function:(?!step-end)/);
  });

  it('draws each word at its exact column in its colour and weight, a ground under its cells, and box lines as lines', () => {
    const svg = draw();
    const [head, selected, , word, top, sides] = groups(svg);
    // Column 1 is 26 + 7.8 px in; bold is 700; the dot, no ASCII, is a tspan of its own, and spaces are none.
    expect(head.row).toBe('<text y="36.5"><tspan x="33.8" font-weight="700">runs</tspan><tspan x="72.8" fill="#8e8c79">·</tspan><tspan x="88.4" fill="#8e8c79">2</tspan></text>');
    // The selected row's ground runs under its twelve cells, and what the code escapes is escaped.
    expect(selected.row).toContain('<rect x="26.0" y="42" width="93.6" height="20" fill="#1d1e1b"/>');
    expect(selected.row).toContain('<tspan x="57.2" font-weight="700">&lt;b&gt;</tspan>');
    expect(selected.row).toContain('<tspan x="88.4" fill="#ff6b5e">lost</tspan>');
    // A box's top, no text: one path in the box's colour, one line across from corner to corner, each corner's way down, and a curve at each that starts a pixel inside both.
    expect(top.row).toBe('<path class="x" stroke="#8e8c79" d="M33.4 72.0H49.8M29.9 75.5V82.0M53.3 75.5V82.0M29.9 76.5V75.5Q29.9 72.0 33.4 72.0H34.4M53.3 76.5V75.5Q53.3 72.0 49.8 72.0H48.8"/>');
    // Its sides run the row's height down the middle of their columns; the word between them is the row's text.
    expect(sides.row).toBe('<path class="x" stroke="#8e8c79" d="M29.9 62.0V82.0M53.3 62.0V82.0"/>');
    expect(word.row).toBe('<text y="76.5"><tspan x="33.8">ok</tspan></text>');
    // A pane's side is one stroke through every row it passes, corner to corner, so no seam shows between rows.
    const pane = draw({ scenes: [{ screen: '╭─╮\n│ │\n╰─╯', hold: 1 }], still: 0 });
    expect(groups(pane).map((g) => g.row)).toEqual([expect.stringMatching(/^<path class="x" stroke="#eeede6" d="M33\.4 32\.0H42\.0M33\.4 72\.0H42\.0M29\.9 35\.5V68\.5M45\.5 35\.5V68\.5(M[\d. ]+V[\d.]+Q[\d. ]+H[\d.]+){4}"\/>$/)]);
  });

  it('holds the still scene where motion is unwanted, and draws it alone when asked for no motion', () => {
    const svg = draw();
    expect(svg).toContain('.s{opacity:0}.s.still{opacity:1}');
    expect(svg).toContain('@media (prefers-reduced-motion:reduce){.s{animation:none!important}}');
    // The second scene's are the still ones: the head, the unselected row and the box's top.
    expect(groups(svg).map((g) => g.classes.includes('still'))).toEqual([true, false, true, false, true, false]);
    const still = draw({ animated: false });
    expect(still).not.toContain('@keyframes');
    expect(still).not.toContain('animation');
    expect(groups(still).map((g) => g.classes)).toEqual([['s', 'still'], ['s', 'still'], ['s', 'still']]);
    expect(groups(still).map((g) => g.row)).toEqual(groups(svg).filter((g) => g.classes.includes('still')).map((g) => g.row));
  });

  it('refuses a screen its terminal couldn’t hold, a still scene that isn’t there, and a recording of none', () => {
    expect(() => draw({ rows: 2 })).toThrow(/a screen of 3 lines in a terminal of 2/);
    expect(() => draw({ columns: 8 })).toThrow(/a line of \d+ columns in a terminal of 8/);
    expect(() => draw({ still: 3 })).toThrow(/no scene 3 to hold still/);
    expect(() => draw({ scenes: [] })).toThrow(/a recording has a scene or more/);
  });
});
