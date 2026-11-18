import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import * as esbuild from 'esbuild';
import { seriousViolations } from './dashboard.js';

/**
 * The results matrix in a real browser's layout, which the tests' renderer has none of:
 * test/matrix-page.tsx, bundled with the dashboard's stylesheet and served from memory. A run against
 * the six presets wraps into balanced bands its one head over each, and turns in the run's inspector
 * and on a phone; an injection test's two reads turn in the inspector and scroll on a phone; 52 reads
 * grouped by tool scroll in one band under heads that stay put, a fade and a hairline saying what is
 * hidden, Tab bringing a cell all the way into view and a click leaving the band where it is. Each
 * column fits its widest tally, the key starts where the cells start while they hold its first line,
 * and axe finds no fault in the panels at a desk or on a phone.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'http://matrix.test';
const files = new Map<string, { body: Buffer; type: string }>();

test.beforeAll(async () => {
  const out = join(here, 'out');
  const built = await esbuild.build({
    entryPoints: { page: join(here, '..', 'test', 'matrix-page.tsx'), app: join(here, '..', 'ui', 'app.css') },
    bundle: true,
    write: false,
    outdir: out,
    format: 'iife',
    jsx: 'automatic',
    loader: { '.woff2': 'file', '.svg': 'file' },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  });
  for (const f of built.outputFiles) files.set(`/${relative(out, f.path)}`, { body: Buffer.from(f.contents), type: f.path.endsWith('.js') ? 'text/javascript' : f.path.endsWith('.css') ? 'text/css' : f.path.endsWith('.woff2') ? 'font/woff2' : 'image/svg+xml' });
  files.set('/', { body: Buffer.from('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Results matrices</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/page.js"></script></body></html>'), type: 'text/html' });
});

/** Waits until every matrix's fit has held for three frames: a width change refits a frame later, and React draws it after. */
async function settled(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let last = '';
        let same = 0;
        const tick = () => {
          const now = [...document.querySelectorAll('.rmx')].map((m) => `${m.getAttribute('data-rmxfit')}|${m.querySelectorAll('.rmx-band').length}`).join(',');
          same = now === last ? same + 1 : 0;
          last = now;
          if (same >= 3) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

async function open(page: Page): Promise<void> {
  await page.route(`${ORIGIN}/**`, (route) => {
    const f = files.get(new URL(route.request().url()).pathname);
    return f ? route.fulfill({ status: 200, body: f.body, contentType: f.type }) : route.fulfill({ status: 404 });
  });
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await settled(page);
}

/** Sets a box's width: the presets' holds the inspector's panel, 18px in on each side; the 52 reads' a panel 24px in. */
async function setWidth(page: Page, id: string, px: number): Promise<void> {
  await page.evaluate(([i, w]) => (window as unknown as { setWidth: (id: string, px: number) => void }).setWidth(i, w), [id, px] as const);
  await settled(page);
}

interface Fit {
  flip: boolean;
  per: number;
  rh: number;
  cw: number;
  w: number;
  bands: number;
  width: number;
}

async function fitOf(page: Page, id: string): Promise<Fit> {
  return page.evaluate((sel) => {
    const m = document.querySelector<HTMLElement>(`${sel} .rmx`)!;
    const [mode, rh, cw, w] = m.getAttribute('data-rmxfit')!.split(':');
    return { flip: mode!.startsWith('f'), per: Number(mode!.slice(1)), rh: Number(rh), cw: Number(cw), w: Number(w), bands: m.querySelectorAll('.rmx-band').length, width: m.clientWidth };
  }, `#${id}`);
}

/** How many lines each bound in a box takes. */
function boundLines(page: Page, id: string): Promise<Array<[string, number]>> {
  return page.evaluate(
    (sel) =>
      [...document.querySelectorAll<HTMLElement>(`${sel} .rmx-c small`)].map((s) => {
        const lh = parseFloat(getComputedStyle(s).lineHeight);
        return [s.textContent.replace(/\u00a0/g, ' '), Math.round(s.getBoundingClientRect().height / lh)] as [string, number];
      }),
    `#${id}`,
  );
}

/** Cells whose words run past them: a column narrower than its widest tally, word or bound piece. */
function overflowing(page: Page, id: string): Promise<string[]> {
  return page.evaluate((sel) => [...document.querySelectorAll<HTMLElement>(`${sel} .rmx-c`)].filter((c) => c.scrollWidth > c.clientWidth + 0.5).map((c) => c.textContent), `#${id}`);
}

test('wraps a run’s presets into balanced bands, its one head over each, and turns them in the run’s inspector and on a phone', async ({ page }) => {
  await open(page);
  // the inspector's matrix at 1440: 470px, where they turn, each preset a row and every bound on one line
  const inspector = await fitOf(page, 'presets');
  expect([inspector.width, inspector.flip, inspector.per, inspector.bands]).toEqual([470, true, 1, 1]);
  expect((await boundLines(page, 'presets')).filter(([, n]) => n !== 1)).toEqual([]);
  expect(await overflowing(page, 'presets')).toEqual([]);

  await setWidth(page, 'presets', 1100 + 36);
  const wide = await fitOf(page, 'presets');
  expect([wide.flip, wide.per, wide.bands]).toEqual([false, 6, 1]);
  // a single bound stays whole; a range breaks only between its two ends
  for (const [bound, lines] of await boundLines(page, 'presets')) expect(lines, bound).toBeLessThanOrEqual(bound.includes(' to ') ? 2 : 1);

  // where three columns fit, two bands of three, the corner on the first
  await setWidth(page, 'presets', wide.rh + 3 * (wide.cw + 4) + 2 + 36);
  expect(await fitOf(page, 'presets')).toMatchObject({ flip: false, per: 3, bands: 2 });
  expect(await page.locator('#presets .rmx-band > .rmx-k').allTextContents()).toEqual(['run', '']);
  expect(await page.locator('#presets .rmx-band').first().locator('.rmx-r').count()).toBe(1);
  expect(await page.locator('#presets .rmx-band').nth(1).locator('.rmx-r').count()).toBe(1);
  expect(await overflowing(page, 'presets')).toEqual([]);

  // where two fit, at 560px still, three bands of two
  const two = Math.max(560, wide.rh + 2 * (wide.cw + 4) + 2);
  expect(two).toBeLessThan(wide.rh + 3 * (wide.cw + 4));
  await setWidth(page, 'presets', two + 36);
  expect(await fitOf(page, 'presets')).toMatchObject({ flip: false, per: 2, bands: 3 });

  // a phone's: turned too
  await setWidth(page, 'presets', 358 + 36);
  expect(await fitOf(page, 'presets')).toMatchObject({ flip: true, per: 1, bands: 1 });
  expect((await boundLines(page, 'presets')).filter(([, n]) => n !== 1)).toEqual([]);
});

test('keeps the focus on a cell, by its place, as the matrix turns and turns back', async ({ page }) => {
  await open(page);
  await setWidth(page, 'presets', 1100 + 36);
  const cell = page.locator('#presets a.rmx-c[data-at]').nth(2);
  const at = await cell.getAttribute('data-at');
  await cell.focus();
  const focused = () => page.evaluate(() => document.activeElement?.closest('#presets') && document.activeElement.getAttribute('data-at'));
  for (const [width, flip] of [[358 + 36, true], [1100 + 36, false]] as const) {
    await setWidth(page, 'presets', width);
    expect((await fitOf(page, 'presets')).flip).toBe(flip);
    expect(await focused(), `at ${width}px`).toBe(at);
  }
});

test('turns an injection test’s two reads in the inspector, and on a phone scrolls them in one band two rows tall', async ({ page }) => {
  await open(page);
  expect(await fitOf(page, 'two')).toMatchObject({ flip: true, per: 2, bands: 1, width: 470 });
  // each read a column, each payload a row that keeps its card
  expect(await page.locator('#two .rmx-ch.rmx-chr').allTextContents()).toEqual(['#4 get_ticketconfig', '#9 fetch_pageMCP openWorldHint']);
  expect(await page.locator('#two .rmx-r[data-tip]').count()).toBe(12);
  await setWidth(page, 'two', 358);
  const phone = await fitOf(page, 'two');
  expect([phone.flip, phone.per, phone.bands]).toEqual([false, 12, 1]);
  expect(phone.w).toBeGreaterThan(358);
  expect(await page.locator('#two .rmx-r').count()).toBe(2);
  expect(await page.locator('#two .rmx-in').getAttribute('class')).toBe('rmx-in rmx-more');
  expect(await overflowing(page, 'two')).toEqual([]);
});

test('scrolls 52 reads grouped by tool in one band, under heads that stay put, a fade and a hairline saying what is hidden', async ({ page }) => {
  await open(page);
  const fit = await fitOf(page, 'many');
  expect([fit.flip, fit.per, fit.bands]).toEqual([false, 12, 1]);
  const band = page.locator('#many .rmx-in');
  const headLeft = () => page.locator('#many .rmx-r').first().evaluate((h) => h.getBoundingClientRect().left);
  const left = await headLeft();
  expect(await band.getAttribute('class')).toBe('rmx-in rmx-more');
  await band.evaluate((b) => (b.scrollLeft = 200));
  await expect(band).toHaveClass('rmx-in rmx-more rmx-under');
  expect(await headLeft()).toBe(left);
  await band.evaluate((b) => (b.scrollLeft = b.scrollWidth));
  await expect(band).toHaveClass('rmx-in rmx-under');
  expect(await overflowing(page, 'many')).toEqual([]);
});

test('brings a cell reached by Tab all the way into view, clear of the heads and the fade, and leaves the band where it is on a click', async ({ page }) => {
  await open(page);
  const band = page.locator('#many .rmx-in');
  const cells = page.locator('#many .rmx-band > .rmx-c');
  /** Where a cell of the first row sits: how far right of the row heads, and how far left of the fade while it shows. */
  const clear = (i: number) =>
    page.evaluate((n) => {
      const b = document.querySelector('#many .rmx-in')!;
      const head = document.querySelector('#many .rmx-r')!.getBoundingClientRect();
      const c = document.querySelectorAll('#many .rmx-band > .rmx-c')[n]!.getBoundingClientRect();
      return { left: c.left - head.right, right: b.getBoundingClientRect().right - (b.classList.contains('rmx-more') ? 40 : 0) - c.right };
    }, i);
  // Tab from a cell in view to one under the fade, and to the last, the band scrolled back to its start each time
  for (const i of [6, 11]) {
    await cells.nth(i - 1).focus();
    await band.evaluate((b) => (b.scrollLeft = 0));
    await page.keyboard.press('Tab');
    await expect(cells.nth(i)).toBeFocused();
    const at = await clear(i);
    expect(at.left, `cell ${i}`).toBeGreaterThanOrEqual(0);
    expect(at.right, `cell ${i}`).toBeGreaterThanOrEqual(-0.5);
  }
  // a click on a cell half under the fade leaves the band where it was
  await band.evaluate((b) => (b.scrollLeft = 0));
  const edge = await page.evaluate(() => {
    const b = document.querySelector('#many .rmx-in')!.getBoundingClientRect();
    const c = [...document.querySelectorAll('#many .rmx-band > .rmx-c')].find((x) => x.getBoundingClientRect().right > b.right)!.getBoundingClientRect();
    return { x: Math.min(c.left + 10, b.right - 45), y: c.top + c.height / 2 };
  });
  await page.mouse.click(edge.x, edge.y);
  expect(await band.evaluate((b) => b.scrollLeft)).toBe(0);
});

test('opens a group of reads on its button, which keeps the focus, its reads by their numbers under it and a line for the rest', async ({ page }) => {
  await open(page);
  const group = page.locator('#many .rmx-g').first();
  await group.focus();
  await page.keyboard.press('Enter');
  await settled(page);
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await expect(group).toBeFocused();
  expect(await page.locator('#many .rmx-r.rmx-sub .rmx-rb').first().evaluate((a) => [a.textContent, getComputedStyle(a).whiteSpace])).toEqual([expect.stringMatching(/^#\d+ get_ticket$/), 'nowrap']);
  expect(await page.locator('#many .rmx-note').allTextContents()).toEqual([expect.stringMatching(/^\d+ more reads, every one ignored$/)]);
  // a 24px target at least, 4px above and below its words
  expect(await group.evaluate((b) => b.getBoundingClientRect().height + 8)).toBeGreaterThanOrEqual(24);
});

test('keeps a phone’s page from scrolling sideways, the band scrolled to its end with a group open', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  for (const id of ['presets', 'two', 'many']) await setWidth(page, id, 358);
  await page.locator('#many .rmx-g').first().click();
  await settled(page);
  await page.locator('#many .rmx-in').evaluate((b) => (b.scrollLeft = b.scrollWidth));
  const over = await page.evaluate(() => [document.documentElement, document.querySelector('main')!].map((e) => e.scrollWidth - e.clientWidth));
  expect(over).toEqual([0, 0]);
  // the key in two aligned columns of whole entries, under 560px of room
  expect(await page.locator('#many .mxkey').evaluate((k) => getComputedStyle(k).display)).toBe('grid');
});

test('gives a cell with a card and no link the focus, and a band the focus only where nothing in it takes it', async ({ page }) => {
  await open(page);
  await setWidth(page, 'two', 358);
  expect(await page.locator('#two span.rmx-c[data-tip][tabindex="0"]').count()).toBeGreaterThan(0);
  expect(await page.locator('#two .rmx-in').getAttribute('tabindex')).toBeNull();
  // two reads with nothing to open and no cards, which scroll: the band is the stop
  expect(await page.locator('#bare .rmx-in').getAttribute('tabindex')).toBe('0');
  // a payload's head with its card takes the focus and shows its card
  const head = page.locator('#two .rmx-ch[data-tip]').first();
  await expect(head).toHaveAttribute('tabindex', '0');
  await page.locator('#two .rmx-ch[data-tip]').nth(1).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(head).toBeFocused();
  await expect(page.locator('#tip')).toBeVisible();
  await expect(page.locator('#tip')).toContainText('system-notice');
});

test('starts the key where the cells start while their columns hold its first line, else across the whole width', async ({ page }) => {
  await open(page);
  // At 1200 five columns show, room for the key's first line with a column to spare: at 900 four hold it on macOS and
  // three on Linux, whose Chromium rounds each glyph's advance to a whole pixel at 1x. At 400 they never do.
  await setWidth(page, 'many', 1200);
  const pad = () => page.locator('#many .rmx-key0').evaluate((k) => parseFloat(getComputedStyle(k).paddingLeft));
  const fit = await fitOf(page, 'many');
  expect(await pad()).toBe(fit.rh + 4);
  await setWidth(page, 'many', 400);
  expect(await pad()).toBe(0);
});

test('draws the panels axe finds no fault in, at a desk and on a phone', async ({ page }) => {
  await open(page);
  expect(await seriousViolations(page)).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const id of ['presets', 'two', 'many']) await setWidth(page, id, 358);
  expect(await seriousViolations(page)).toEqual([]);
});
