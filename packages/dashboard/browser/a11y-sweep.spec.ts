import { expect, test, type Page } from '@playwright/test';
import { dash, seriousViolations, sideways } from './dashboard.js';
import { ROUTES, show, type RouteState } from './routes.js';

/**
 * Every route of browser/routes.ts, swept: axe's WCAG 2.2 A and AA rules and no sideways scroll on a
 * phone, 390 and 320 px wide, with no label under 11px at 390; in a forced-colours theme each mark
 * keeping its colour inside an edge, the selection keeping a mark of its own, and axe passing; and
 * the heading outline of each page, the signed-out and expired cards' included: one h1, first, and
 * each heading at most a level under the one before, in reading order. A route the table exempts
 * from the check at 320 names why there.
 */

test.describe.configure({ timeout: 600_000 });

/** Each problem a check finds, under the route state it was found in. */
async function over(page: Page, check: (r: RouteState) => Promise<string[]>): Promise<string[]> {
  const found: string[] = [];
  for (const r of ROUTES) {
    await show(page, r)();
    for (const p of await check(r)) found.push(`${r.name}: ${p}`);
  }
  return found;
}

/** What scrolls the page sideways, by how far. */
async function reach(page: Page): Promise<string[]> {
  const past = await sideways(page);
  return past > 0 ? [`the page scrolls ${past}px sideways`] : [];
}

/**
 * Text drawn under 11px, an avatar's initials and hidden text aside; and anything the phone's label
 * floor (one `:is(#root, body) :is(…)` rule under 640px) draws smaller than without it.
 */
function underFloor(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const name = (el: Element) => `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join('.')}`;
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      const s = getComputedStyle(el);
      if (el.closest('.av, .sr') || s.visibility === 'hidden' || !el.getClientRects().length) continue;
      const text = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
      if (text && parseFloat(s.fontSize) < 11) out.push(`${name(el)} “${el.textContent?.trim().slice(0, 30)}” at ${s.fontSize}`);
    }
    const floor: CSSStyleRule[] = [];
    for (const sheet of document.styleSheets)
      for (const r of sheet.cssRules)
        if (r instanceof CSSMediaRule && r.conditionText.includes('max-width: 640px'))
          for (const x of r.cssRules) if (x instanceof CSSStyleRule && x.selectorText.startsWith(':is(#root, body)') && x.style.fontSize) floor.push(x);
    if (!floor.length) out.push('no label floor in the stylesheet');
    const raised = [...document.querySelectorAll<HTMLElement>('body *')].map((el) => ({ el, px: parseFloat(getComputedStyle(el).fontSize) }));
    const kept = floor.map((r) => ({ r, size: r.style.fontSize }));
    for (const r of floor) r.style.removeProperty('font-size');
    for (const { el, px } of raised) {
      const was = parseFloat(getComputedStyle(el).fontSize);
      if (px + 0.01 < was) out.push(`${name(el)} lowered from ${was}px to ${px}px`);
    }
    for (const { r, size } of kept) r.style.setProperty('font-size', size);
    return out;
  });
}

test('every route on a 390px phone has no serious or critical axe violation, scrolls nothing sideways, and draws no label under 11px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await over(page, async () => [...(await seriousViolations(page)), ...(await reach(page)), ...(await underFloor(page))])).toEqual([]);
});

test('every route at 320px has no serious or critical axe violation and scrolls nothing sideways, unless the table says why', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  expect(await over(page, async (r) => [...(await seriousViolations(page)), ...(r.narrow ? [] : await reach(page))])).toEqual([]);
});

/** A heading in the accessibility tree: its level and name. */
interface Heading {
  level: number;
  name: string;
}

/** The headings of what `ariaSnapshot` reads, in reading order: what is hidden from a screen reader, or inert, is left out. */
async function headings(page: Page, root = 'body'): Promise<Heading[]> {
  const tree = await page.locator(root).first().ariaSnapshot();
  return [...tree.matchAll(/- heading(?: "((?:[^"\\]|\\.)*)")? \[level=(\d)\]/g)].map((m) => ({ level: Number(m[2]), name: m[1] ?? '' }));
}

/** What breaks the outline: not one h1, the h1 not first, or a heading more than a level under the one before. */
function outlineBreaks(hs: Heading[]): string[] {
  const out: string[] = [];
  const ones = hs.filter((h) => h.level === 1);
  if (ones.length !== 1) out.push(`${ones.length} h1s${ones.length ? ` (${ones.map((h) => `“${h.name}”`).join(', ')})` : ''}`);
  if (hs[0] && hs[0].level !== 1) out.push(`its first heading is h${hs[0].level} “${hs[0].name}”`);
  hs.forEach((h, i) => {
    const before = hs[i - 1];
    if (before && h.level > before.level + 1) out.push(`h${before.level} “${before.name}” then h${h.level} “${h.name}”`);
  });
  return out;
}

/** Marks a forced-colours theme lets go without an edge of their own, each with what says the same in words. */
const WORDED: Record<string, string> = {
  '.status .jobchip i': 'the chip’s label carries the job’s state (“Forked · exit 0”)',
  '.toast.err i': 'the toast says what failed in words',
  '.tag.live::before': 'the tag says live in words',
  '.alertcard .adot': 'the card says its state in words',
};

/**
 * Notes each mark on the page in its own colours: an element, or its ::before or ::after, with no
 * text of its own, a coloured ground, and 16px or less across one way. Kept on the window for
 * `forcedMarks` to read once the theme is forced.
 */
function noteMarks(page: Page): Promise<number> {
  return page.evaluate(() => {
    const coloured = (c: string) => {
      const srgb = /color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)/.exec(c);
      const rgb = /rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)/.exec(c);
      const m = srgb ?? rgb;
      if (!m || Number(m[4] ?? 1) < 0.2) return false;
      const v = [m[1], m[2], m[3]].map((x) => Number(x) * (srgb ? 255 : 1));
      return Math.max(...v) - Math.min(...v) > 40;
    };
    const marks: Array<{ el: Element; pseudo: '' | '::before' | '::after' }> = [];
    for (const el of document.querySelectorAll('#root *')) {
      if (el.closest('.sr, [aria-hidden="true"] .sr')) continue;
      const box = el.getBoundingClientRect();
      for (const pseudo of ['', '::before', '::after'] as const) {
        const s = getComputedStyle(el, pseudo || null);
        if (s.display === 'none' || s.visibility === 'hidden' || !coloured(s.backgroundColor)) continue;
        if (pseudo && (s.content === 'none' || s.content !== '""')) continue;
        if (!pseudo && (!box.width || !box.height || [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()))) continue;
        const [w, h] = pseudo ? [parseFloat(s.width), parseFloat(s.height)] : [box.width, box.height];
        if (Number.isNaN(w) || Number.isNaN(h) || !w || !h || Math.min(w, h) > 16) continue;
        marks.push({ el, pseudo });
      }
    }
    (window as unknown as { __marks: typeof marks }).__marks = marks;
    return marks.length;
  });
}

/** The marks `noteMarks` found that a forced-colours theme draws without their colour or without an edge, unless WORDED says why. */
function forcedMarks(page: Page): Promise<string[]> {
  return page.evaluate((worded) => {
    const marks = (window as unknown as { __marks: Array<{ el: Element; pseudo: '' | '::before' | '::after' }> }).__marks;
    const edged = (s: CSSStyleDeclaration) => s.boxShadow !== 'none' || s.outlineStyle !== 'none' || (s.borderTopStyle !== 'none' && parseFloat(s.borderTopWidth) > 0);
    const out = new Set<string>();
    for (const { el, pseudo } of marks) {
      if (!el.isConnected) continue;
      const s = getComputedStyle(el, pseudo || null);
      let edge = edged(s);
      // A thin mark's halo may be its holder's: the run of holders kept in their own colours.
      for (let up = el.parentElement; !edge && up && getComputedStyle(up).forcedColorAdjust === 'none'; up = up.parentElement) edge = edged(getComputedStyle(up));
      if (s.forcedColorAdjust === 'none' && edge) continue;
      if (
        Object.keys(worded).some((sel) => {
          const [own, after] = sel.split('::');
          return pseudo === (after ? `::${after}` : '') && el.matches(own!);
        })
      )
        continue;
      out.add(`${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join('.')}${pseudo} under ${el.parentElement?.className ?? ''}: ${s.forcedColorAdjust === 'none' ? 'no edge' : 'its colour lost'}`);
    }
    return [...out];
  }, WORDED);
}

/** The selection in a forced-colours theme: each kept by a mark in a system colour, an underline or an outline. */
function forcedSelection(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const probe = (c: string) => {
      const p = document.createElement('i');
      p.style.color = c;
      document.body.append(p);
      const v = getComputedStyle(p).color;
      p.remove();
      return v;
    };
    const [text, highlight] = [probe('CanvasText'), probe('Highlight')];
    const out: string[] = [];
    const seen = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const name = (el: Element) => `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join('.')} “${el.textContent?.trim().slice(0, 24)}”`;
    for (const el of document.querySelectorAll('#root [role="tab"][aria-selected="true"], #root .stabs a[aria-current="page"]')) {
      const s = getComputedStyle(el, '::after');
      if (seen(el) && !(s.content !== 'none' && (s.backgroundColor === text || s.borderBottomColor === text))) out.push(`${name(el)}: the tab shown has no bar in the text colour`);
    }
    for (const el of document.querySelectorAll('#root :is(.seg, .chips, .legend.lfilter) [aria-pressed="true"]'))
      if (seen(el) && !getComputedStyle(el).textDecorationLine.includes('underline')) out.push(`${name(el)}: the choice pressed isn’t underlined`);
    for (const el of document.querySelectorAll('#root .navlist a[aria-current="page"], #root .run[aria-current="true"]'))
      if (seen(el) && getComputedStyle(el, '::before').backgroundColor !== highlight) out.push(`${name(el)}: the current one has no bar in the highlight colour`);
    for (const el of document.querySelectorAll('#root :is(table.calls tr[aria-selected="true"], table.calls tr.held, .turn.sel, .dvstep.sel)')) {
      const s = getComputedStyle(el);
      if (seen(el) && !(s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2)) out.push(`${name(el)}: the open row has no outline`);
    }
    return out;
  });
}

test('every route at 1440px keeps its heading outline and, in a forced-colours theme, its marks, its selection and axe’s rules', async ({ page }) => {
  let marks = 0;
  expect(
    await over(page, async () => {
      const found = outlineBreaks(await headings(page));
      marks += await noteMarks(page);
      await page.emulateMedia({ forcedColors: 'active' });
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      // Not axe's contrast here: it reads -webkit-text-fill-color, which Chrome leaves at the stylesheet's colour where it paints the system's.
      found.push(...(await forcedMarks(page)), ...(await forcedSelection(page)), ...(await seriousViolations(page)).filter((v) => !v.startsWith('color-contrast ')));
      await page.emulateMedia({ forcedColors: 'none' });
      return found;
    }),
  ).toEqual([]);
  // The strip's cells, the chart's bars, the legends' and the lists' dots: the routes hold hundreds.
  console.log(`marks: ${marks}`);
  expect(marks).toBeGreaterThan(100);
});

test('the cards that stand for a page, signed out and with a refused link, each have one h1, their title', async ({ page }) => {
  const { origin, token } = dash();
  await page.goto(`${origin}/`);
  await page.waitForSelector('.connblock.gate h1', { state: 'visible' });
  expect(await headings(page)).toEqual([{ level: 1, name: 'Open the dashboard from its link' }]);
  await page.goto(`${origin}/?state=expired#token=${token}&open=/tests`);
  await page.waitForSelector('.connblock h1', { state: 'visible' });
  // The card's title is its h1, and the page behind it is inert: ariaSnapshot still reads an inert page, so its h1 is found inert.
  expect(await headings(page, '.connblock')).toEqual([{ level: 1, name: 'This link’s session token isn’t this dashboard’s' }]);
  expect(await page.locator('main#view').evaluate((el) => !!el.closest('[inert]'))).toBe(true);
});
