import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import * as esbuild from 'esbuild';
import { seriousViolations } from './dashboard.js';

/**
 * The shared parts that measure what they set (Copy, Code, Command, Term, the attempts strip), in a
 * real browser's layout, which the tests' renderer has none of: test/primitives-page.tsx, bundled
 * with the dashboard's stylesheet and served from memory. Copy's settings at two widths, code whole
 * in a block and in an inline parent, a term after a closed fold, a command's prompt left out of a
 * selection, no command past its box on a phone, and the strip of attempts past six under axe.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'http://primitives.test';
const files = new Map<string, { body: Buffer; type: string }>();

test.beforeAll(async () => {
  const out = join(here, 'out');
  const built = await esbuild.build({
    entryPoints: { page: join(here, '..', 'test', 'primitives-page.tsx'), app: join(here, '..', 'ui', 'app.css') },
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
  files.set('/', { body: Buffer.from('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shared parts</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/page.js"></script></body></html>'), type: 'text/html' });
});

/** Opens the page at a width of its box, its fonts loaded and its parts measured. */
async function open(page: Page, width: number): Promise<void> {
  await page.route(`${ORIGIN}/**`, (route) => {
    const f = files.get(new URL(route.request().url()).pathname);
    return f ? route.fulfill({ status: 200, body: f.body, contentType: f.type }) : route.fulfill({ status: 404 });
  });
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await setWidth(page, width);
}

async function setWidth(page: Page, width: number): Promise<void> {
  await page.evaluate((w) => (window as unknown as { setWidth: (n: number) => void }).setWidth(w), width);
  // a frame for the width to lay out, and one for what was measured to draw
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** A block's sentences' classes, and how many lines its text takes: the lines its text's boxes sit on, a few pixels apart at most within one. */
function copyAt(page: Page, id: string): Promise<{ block: string; sentences: string[]; lines: number }> {
  return page.evaluate((sel) => {
    const b = document.querySelector(`${sel} > *`)!;
    const tops: number[] = [];
    const walk = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width > 0.5 && !tops.some((t) => Math.abs(t - r.top) < 6)) tops.push(r.top);
    }
    return { block: b.className, sentences: [...b.querySelectorAll(':scope > ts-s')].map((s) => s.className), lines: tops.length };
  }, `#${id}`);
}

test('sets copy by its width: sentences whole where they fit a line, each balanced on lines of its own on a phone, a sentence of two lines broken after its clause', async ({ page }) => {
  await open(page, 682);
  expect(await copyAt(page, 'store')).toEqual({ block: 'ts-bal', sentences: ['snt', 'snt'], lines: 2 });
  expect(await copyAt(page, 'blame')).toEqual({ block: 'ts-bal', sentences: ['snt', 'snt'], lines: 2 });
  // copy set in a line is measured by the block it sits in
  expect(await copyAt(page, 'span')).toMatchObject({ sentences: ['snt', 'snt'] });
  await setWidth(page, 360);
  expect(await copyAt(page, 'store')).toEqual({ block: 'ts-pretty', sentences: ['snt ts-bal', 'snt ts-bal'], lines: 4 });
  expect(await copyAt(page, 'span')).toMatchObject({ sentences: ['snt ts-bal', 'snt ts-bal'] });
});

test('keeps long code whole where its line holds it, in a block and in a line of its own, and breaks it only after a slash where none does', async ({ page }) => {
  await open(page, 900);
  const classes = () => page.evaluate(() => ['#code-block code', '#code-inline code'].map((s) => document.querySelector(s)!.className));
  expect(await classes()).toEqual(['ts-cb whole', 'ts-cb whole']);
  await setWidth(page, 300);
  expect(await classes()).toEqual(['ts-cb', 'ts-cb']);
});

test('keeps a long name whole on a line that holds it, and breaks a host after a dot only in a block none does', async ({ page }) => {
  await open(page, 900);
  const at = (sel: string) =>
    page.evaluate((s) => {
      const el = document.querySelector(s)!;
      const range = document.createRange();
      range.selectNodeContents(el);
      return { tops: new Set([...range.getClientRects()].filter((r) => r.width > 0.5).map((r) => Math.round(r.top))).size, over: el.closest('div')!.scrollWidth - el.closest('div')!.clientWidth };
    }, sel);
  expect(await at('#name ts-w.ts-long')).toEqual({ tops: 1, over: 0 });
  expect(await at('#host ts-w.ts-long')).toEqual({ tops: 2, over: 0 });
});

test('defines a term where it first shows: never in a closed fold, there once the fold opens', async ({ page }) => {
  await open(page, 900);
  const defined = () => page.evaluate(() => [...document.querySelectorAll('#terms .term.on')].map((t) => t.closest('[data-row]')!.getAttribute('data-row')));
  expect(await defined()).toEqual(['shown']);
  await page.evaluate(() => (window as unknown as { setFold: (o: boolean) => void }).setFold(true));
  await expect.poll(defined).toEqual(['fold']);
  await page.evaluate(() => (window as unknown as { setFold: (o: boolean) => void }).setFold(false));
  await expect.poll(defined).toEqual(['shown']);
});

test('leaves a command’s prompt out of what a selection copies', async ({ page }) => {
  await open(page, 900);
  const selected = await page.evaluate(() =>
    ['#s3 .cmdline', '#empty .cli code', '#steps .cli code'].map((s) => {
      const sel = getSelection()!;
      sel.removeAllRanges();
      const r = document.createRange();
      r.selectNodeContents(document.querySelector(s)!);
      sel.addRange(r);
      return sel.toString();
    }),
  );
  expect(selected).toEqual(['shadowlap store push --to s3://northwind-agent-runs/support-agent/runs .', 'shadowlap run -- node agent.mjs', 'shadowlap run -- node agent.mjs']);
});

test('breaks a command only between its arguments, a long one whole where its line holds it, and never past its box on a phone', async ({ page }) => {
  await open(page, 682);
  expect(await page.evaluate(() => document.querySelector('#inject .carg')!.className)).toBe('carg whole');
  for (const width of [430, 390, 360, 320]) {
    await setWidth(page, width);
    const over = await page.evaluate(() => [...document.querySelectorAll('.cmdline')].map((c) => c.scrollWidth - c.clientWidth));
    expect(over.every((x) => x <= 0), `a command runs past its box at ${width}: ${over.join(', ')}`).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  }
});

test('draws more than six attempts as a strip axe finds no fault in, at a desk and on a phone', async ({ page }) => {
  await open(page, 900);
  expect(await page.locator('#attempts .astrip .ac').count()).toBe(12);
  expect(await seriousViolations(page)).toEqual([]);
  await page.setViewportSize({ width: 390, height: 900 });
  await setWidth(page, 342);
  expect(await seriousViolations(page)).toEqual([]);
});
