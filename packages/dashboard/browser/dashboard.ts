import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page } from '@playwright/test';
import type { BrowserState } from './global-setup.js';

/** What the browser tests share: the dashboard global-setup.ts started, and how to read a page. */

let cached: BrowserState | null = null;

/** The dashboard's address, its token and the demo's ids. */
export function dash(): BrowserState {
  if (cached) return cached;
  const file = process.env.SHADOWLAP_BROWSER_STATE;
  if (!file) throw new Error('no dashboard: run the browser tests with npm run test:browser');
  cached = JSON.parse(readFileSync(file, 'utf8')) as BrowserState;
  return cached;
}

/** A demo run or fix by the name runs.json gives it. */
export function demoId(name: string): string {
  const v = dash().runs[name];
  const id = Array.isArray(v) ? v[0] : v;
  if (!id) throw new Error(`the demo store has no ${name}`);
  return id;
}

/** The selector that says a page has drawn what it shows. */
const DRAWN: Record<string, string> = {
  overview: 'main#view .ov, main#view .ph',
  runs: 'main#view table.rt tbody tr, main#view .runstable tbody tr, main#view table tbody tr',
  run: 'main#view .rhead .rnm',
  fix: 'main#view .stepper',
};

/** Opens a page of the dashboard with the session token, as its printed link does, and waits for it to draw. */
export async function openPage(page: Page, path: string, drawn: string): Promise<void> {
  const { origin, token } = dash();
  await page.goto(`${origin}/#token=${token}&open=${path}`);
  await page.waitForSelector(DRAWN[drawn] ?? drawn, { state: 'visible' });
  // Fonts settle the layout that the fitted lines (about lines, hints) are measured against.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForTimeout(150);
}

const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

export interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: Array<{ target: string[]; failureSummary?: string }>;
}

/**
 * axe-core's WCAG 2.2 A and AA rules over the page as it stands. The page runs under a strict CSP
 * that refuses an injected script, so axe is evaluated through the browser's own protocol.
 */
export async function axe(page: Page): Promise<AxeViolation[]> {
  await page.evaluate(axeSource);
  return page.evaluate(async () => {
    const w = window as unknown as { axe: { run: (ctx: Document, opts: unknown) => Promise<{ violations: AxeViolation[] }> } };
    const r = await w.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => ({ target: n.target, ...(n.failureSummary ? { failureSummary: n.failureSummary } : {}) })) }));
  });
}

/** The serious and critical violations, each with where it is: what the tests hold at zero. */
export async function seriousViolations(page: Page): Promise<string[]> {
  // What fades in, a toast, is judged once it has: halfway in, its words sit on a ground it never shows.
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
  const found = await axe(page);
  return found.filter((v) => v.impact === 'serious' || v.impact === 'critical').flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')}${n.failureSummary ? ` · ${n.failureSummary.replace(/\s+/g, ' ').slice(0, 220)}` : ''}`));
}

/**
 * WCAG's contrast ratio between two colours the browser computed: `rgb(…)`, `rgba(…)`, `#rrggbb`, or
 * `color(srgb r g b)`, as Chrome gives a `color-mix()` in sRGB (the grounds and lines are mixes).
 */
export function contrast(a: string, b: string): number {
  const rgb = (c: string): [number, number, number] => {
    const hex = /^#([0-9a-f]{6})$/i.exec(c.trim());
    if (hex) {
      const n = parseInt(hex[1]!, 16);
      return [n >> 16, (n >> 8) & 255, n & 255];
    }
    const srgb = /^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)/.exec(c.trim());
    if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255];
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(c);
    if (!m) throw new Error(`not a colour: ${c}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const lum = (c: string) => {
    const [r, g, b2] = rgb(c).map((x) => {
      const v = x / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The element that has the focus, as a short description: its tag, id, classes and text. */
export function focusedLabel(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return 'body';
    const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls} “${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}”`;
  });
}

/** Presses Tab until `match` holds for the focused element, at most `max` times; the presses it took. */
export async function tabUntil(page: Page, match: () => boolean, max = 80): Promise<number> {
  for (let n = 1; n <= max; n++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(match)) return n;
  }
  throw new Error(`no match after ${max} presses of Tab; the focus is on ${await focusedLabel(page)}`);
}

/** Asserts no serious or critical axe violation, naming each one found. */
export async function expectAccessible(page: Page): Promise<void> {
  expect(await seriousViolations(page)).toEqual([]);
}
