import { expect, test, type Page } from '@playwright/test';
import { ARTICLES, SMALL } from '../ui/typeset.js';
import { sideways } from './dashboard.js';
import { ROUTES, show, type RouteState } from './routes.js';

/**
 * Line breaks on every route of browser/routes.ts at 320, 360, 390 and 430 px, each route loaded
 * fresh at each width and read from the lines the browser drew, as the mock's detector reads them:
 * no word, id or nowrap piece broken inside or past its box (a command's pieces and its `$` among
 * them), no lead or heading line ending on a small word, no control wrapping, a number kept with its
 * unit and a dot or an arrow with the word before it, no last word alone in text of a fixed width
 * (a menu's note, a toast, a dialog's rows and steps), and at 360 and 430 nothing scrolling sideways
 * (port/a11y-sweep checks 390 and 320). Only `.sr` and `[hidden]` are passed over of what a screen
 * reader skips, never aria-hidden text; of the rest, what the copy rules leave as written: `pre`-like
 * text (JSON, a prompt, a patch, a log), fields, and the fitted lines (`[data-about]`, `[data-fit]`).
 * The breaks the rules allow are allowed: a long name's or a long path's pieces (`ts-w.ts-long`,
 * `code.ts-cb`) where the line can't hold it whole, a command's argument (`.carg`) likewise, and
 * free words (`ts-w.ts-free`), so `s3://…` breaking after a slash at 360 to 430 is no flag.
 */

test.describe.configure({ timeout: 300_000 });

const WIDTHS = [320, 360, 390, 430];
/** port/a11y-sweep checks sideways scroll at 390 and 320. */
const SIDEWAYS = new Set([360, 430]);

interface Rules {
  small: string[];
  articles: string[];
}

/** A word as drawn: its text, where its first box sits, on how many lines its boxes sit, and whether it may break or is code. */
interface Word {
  w: string;
  top: number;
  bottom: number;
  lines: number;
  free: boolean;
  code: boolean;
}

/** Every flag on the page as drawn: `kind · where · its lines`. Its parts are inside it, as `page.evaluate` sends it alone. */
function measure(rules: Rules): string[] {
  const SMALL = new Set(rules.small);
  const ARTICLE = new Set(rules.articles);
  const UNIT = /^(ms|s|min|minutes?|hours?|days?|weeks?|calls?|runs?|attempts?|tokens?|%|KB|MB|GB|B|requests?|steps?|goldens?|checks?|fixes?|tests?|turns?|forks?|cents?|seconds?|items?|tools?|times|probes?|commits?|files?|candidates?|rules?|x|×)[,.;:)]?$/i;
  const SKIP = '.sr, [hidden], pre, svg, script, style, textarea, input, select, [data-about], [data-fit]';
  const FREE = 'ts-w.ts-long:not(.whole), code.ts-cb:not(.whole), .carg:not(.whole), ts-w.ts-free';
  const NOWRAP = 'code.rnm, ts-w:not(.ts-long):not(.ts-free), ts-w.ts-long.whole, .nw, code.ts-code, .carg.whole, .cf, .cmdp';
  const LEAD = 'main#view .ph h1, main#view .ph p, [role="dialog"] header h3, [role="dialog"] header p, .stepempty h2, .stepempty p, .sec h2';
  const FIXED = '.pnote, .palnote, .toast, .dfacts, .ondisk.steps';
  const INLINE = new Set(['inline', 'contents']);
  const out: string[] = [];
  // A2's rule, read from the stylesheet: the selectors of the nowrap rule that names `.btn` and `.ibtn`.
  const controls = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]).find((r): r is CSSStyleRule => r instanceof CSSStyleRule && r.style.whiteSpace === 'nowrap' && /(^|,\s*)\.btn\s*,\s*\.ibtn\b/.test(r.selectorText))?.selectorText;
  if (!controls) out.push('no rule keeping controls on one line in the stylesheet');
  const shown = (el: Element) => getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length > 0;
  const name = (el: Element) => {
    const id = el.closest('[id]');
    const cls = String(el.className).trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.');
    return `${id ? `#${id.id} ` : ''}${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`;
  };
  const tops = (rects: Iterable<DOMRect>) => new Set([...rects].filter((r) => r.width > 0.5).map((r) => Math.round(r.top))).size;
  const boxOf = (el: Node) => {
    let b = el.parentElement;
    while (b && INLINE.has(getComputedStyle(b).display)) b = b.parentElement;
    return b;
  };
  // Text nodes by their nearest box that isn't inline: the block whose lines they sit on.
  const blocks = () => {
    const owner = new Map<Element, Text[]>();
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const b = n.textContent?.trim() && !n.parentElement?.closest(SKIP) ? boxOf(n) : null;
      if (b && shown(b) && !/^pre/.test(getComputedStyle(b).whiteSpace)) owner.set(b, [...(owner.get(b) ?? []), n as Text]);
    }
    return owner;
  };
  const range = document.createRange();
  const wordsOf = (nodes: Text[]) =>
    nodes.flatMap((t) => {
      const free = !!t.parentElement?.closest(FREE);
      const code = !!t.parentElement?.closest('code, kbd, samp');
      return [...(t.textContent ?? '').matchAll(/\S+/g)].flatMap((m): Word[] => {
        range.setStart(t, m.index);
        range.setEnd(t, m.index + m[0].length);
        const rects = [...range.getClientRects()].filter((r) => r.width > 0.5);
        const first = rects[0];
        return first ? [{ w: m[0], top: first.top, bottom: first.bottom, lines: tops(rects), free, code }] : [];
      });
    });
  // A new line where a word starts below the middle of the word before it.
  const linesOf = (words: Word[]) => {
    const lines: Word[][] = [];
    let prev: Word | undefined;
    for (const w of words) {
      if (!prev || w.top > (prev.top + prev.bottom) / 2) lines.push([]);
      lines[lines.length - 1]?.push(w);
      prev = w;
    }
    return lines;
  };
  // What ends a line and starts the next: a small word in a lead or heading, a number left by its unit, a dot or an arrow starting a line.
  const breaks = (lines: Word[][], lead: boolean, flag: (kind: string) => void) => {
    for (let i = 0; i < lines.length - 1; i++) {
      const end = lines[i]?.at(-1);
      const next = lines[i + 1]?.[0];
      if (!end || !next) continue;
      const bare = end.w.toLowerCase();
      if (lead && !end.code && SMALL.has(bare) && (ARTICLE.has(bare) || lines.length > 2)) flag(`small “${end.w}”`);
      if ((/^[$€£]?\d[\d,.]*[kKmM]?$|^≈$|^~$/.test(end.w) && UNIT.test(next.w)) || /^[≈~$€£]$/.test(end.w) || /^([·→↳|=<>≥≤]|>=|<=|!=)$/.test(next.w)) flag(`glue “${end.w} ${next.w}”`);
    }
  };
  for (const [el, nodes] of blocks()) {
    const words = wordsOf(nodes);
    const lines = linesOf(words);
    const flag = (kind: string) => out.push(`${kind} · ${name(el)} · ${lines.map((l) => l.map((w) => w.w).join(' ')).join(' / ')}`);
    for (const w of words) if (w.lines > 1 && !w.free) flag(`split “${w.w}”`);
    if (lines.length < 2) continue;
    if (controls && el.matches(controls)) flag('wrapped');
    breaks(lines, el.matches(LEAD), flag);
    const last = lines.at(-1);
    if (el.closest(FIXED) && last?.length === 1 && !/^[\d$≈~]/.test(last[0]?.w ?? '')) flag('alone');
  }
  // A piece kept whole that broke anyway, or that runs past its box's right edge.
  for (const el of document.querySelectorAll(NOWRAP)) {
    if (el.closest(SKIP) || !shown(el)) continue;
    const right = Math.max(...[...el.getClientRects()].map((r) => r.right));
    const box = boxOf(el);
    if (tops(el.getClientRects()) > 1) out.push(`broken · ${name(el)} · ${el.textContent}`);
    else if (box && right > box.getBoundingClientRect().right + 1) out.push(`past its box · ${name(el)} · ${el.textContent}`);
  }
  return [...new Set(out)];
}

/** Each flag at a width over the routes given, each route loaded fresh, under its name. */
async function over(page: Page, width: number, routes: readonly RouteState[]): Promise<string[]> {
  await page.setViewportSize({ width, height: 800 });
  let crashed = false;
  page.on('crash', () => (crashed = true));
  const found: string[] = [];
  const rules: Rules = { small: [...SMALL], articles: [...ARTICLES] };
  for (const r of routes) {
    try {
      await show(page, r)();
      // Copy measures again once the fonts have loaded and after its ResizeObserver: two frames after that.
      await page.evaluate(() => document.fonts.ready.then(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))));
    } catch (err) {
      found.push(`${width} · ${r.name} · didn’t load${crashed ? ': the page crashed' : ''}: ${String(err).split('\n')[0]}`);
      continue;
    }
    for (const f of await page.evaluate(measure, rules)) found.push(`${width} · ${r.name} · ${f}`);
    if (SIDEWAYS.has(width)) {
      const past = await sideways(page);
      if (past > 0) found.push(`${width} · ${r.name} · the page scrolls ${past}px sideways`);
    }
  }
  return found;
}

// Two halves at each width, so the suite's workers share the sweep and each test stays short; the
// routes the table answers by fixture come last, in the second half, as they stay routed for the page's life.
const HALF = Math.ceil(ROUTES.length / 2);
for (const width of WIDTHS)
  for (const [part, routes] of [
    ['first', ROUTES.slice(0, HALF)],
    ['second', ROUTES.slice(HALF)],
  ] as const)
    test(`the ${part} half of the routes at ${width}px breaks lines only where the rules allow`, async ({ page }) => {
      expect(await over(page, width, routes)).toEqual([]);
    });
