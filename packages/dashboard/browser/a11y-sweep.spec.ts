import { rmSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { JUDGE_ASKED_IN_NONE } from '@shadowlap/engine';
import { dash, demoId, openPage, patched, RESET_RETRY, seriousViolations, serveDashboard, sideways, startJob, type Served } from './dashboard.js';
import { buildInjectionStore, type InjectionStore } from './injection-fixture.js';
import { JUDGE, routeJudgesFixture, UNASKED } from './judges-fixture.js';
import { DIALOG, injectionRoutes, migrated, MIGRATED, previewed, ROUTES, show, type RouteState } from './routes.js';
import { openReport } from './tests-fixture.js';

/**
 * Every route of browser/routes.ts, swept: axe's WCAG 2.2 A and AA rules and no sideways scroll on a
 * phone, 390 and 320 px wide, with no label under 11px at 390; in a forced-colours theme each mark
 * keeping its colour inside an edge, the selection keeping a mark of its own, and axe passing; and
 * the heading outline of each page, the signed-out and expired cards' included: one h1, first, and
 * each heading at most a level under the one before, in reading order, a dialog's its own with its
 * title first. A route the table exempts from the check at 320 names why there. An injection test's
 * pages, which the demo can't draw, are swept the same way on a store of their own.
 */

// A route may still be reading the server's answer as a test ends; the page's close takes it away, and that is no failure.
test.afterEach(({ page }) => page.unrouteAll({ behavior: 'ignoreErrors' }));

/** Each problem a check finds, under the route state it was found in. */
async function over(page: Page, check: (r: RouteState) => Promise<string[]>, routes: readonly RouteState[] = ROUTES): Promise<string[]> {
  const found: string[] = [];
  for (const r of routes) {
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

/**
 * Visually hidden text (`.sr`, and the copies of its style) where it is read: none of it makes the
 * page wider or taller than it is without it, each sits on its own row, within a row's padding of
 * the box that holds it, never sent to the top of a list or the corner of the page, and each stays
 * on one line, as no rule that wraps its row's words reaches it.
 */
function hiddenText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const hidden = [...document.querySelectorAll<HTMLElement>('body *')].filter((el) => {
      const s = getComputedStyle(el);
      return s.position === 'absolute' && s.getPropertyValue('clip') === 'rect(0px, 0px, 0px, 0px)' && el.getClientRects().length > 0;
    });
    const size = () => `${document.documentElement.scrollWidth}×${document.documentElement.scrollHeight}`;
    const drawn = size();
    const was = hidden.map((el) => el.style.display);
    for (const el of hidden) el.style.display = 'none';
    const without = size();
    hidden.forEach((el, i) => (el.style.display = was[i]!));
    if (drawn !== without) out.push(`hidden text stretches the page from ${without} to ${drawn}`);
    const name = (el: Element) => `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join('.')}`;
    for (const el of hidden) {
      let up = el.parentElement;
      while (up && getComputedStyle(up).display === 'contents') up = up.parentElement;
      if (!up) continue;
      const [a, b] = [el.getBoundingClientRect(), up.getBoundingClientRect()];
      if (a.top < b.top - 24 || a.top > b.bottom + 24) out.push(`${name(el)} “${(el.textContent ?? '').trim().slice(0, 30)}” sits ${Math.round(a.top - b.top)}px from the top of its ${name(up)}`);
      const ws = getComputedStyle(el).whiteSpace;
      if (ws !== 'nowrap' && ws !== 'pre' && /\s/.test((el.textContent ?? '').trim())) out.push(`${name(el)} “${(el.textContent ?? '').trim().slice(0, 30)}” wraps (white-space ${ws})`);
    }
    return out;
  });
}

/** On a 390px phone: axe's rules, no sideways scroll, no label under the floor, and hidden text where it is read. */
const onPhone = (page: Page) => async (): Promise<string[]> => [...(await seriousViolations(page)), ...(await reach(page)), ...(await underFloor(page)), ...(await hiddenText(page))];
/** At 320px: axe's rules, and no sideways scroll unless the table says why. */
const atNarrowest = (page: Page) => async (r: RouteState): Promise<string[]> => [...(await seriousViolations(page)), ...(r.narrow ? [] : await reach(page))];

test('every route on a 390px phone has no serious or critical axe violation, scrolls nothing sideways, draws no label under 11px, and keeps its hidden text where it is read', async ({ page }) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 390, height: 844 });
  // The demo's longest run first, its 278 calls: the page keeps its height with its hidden text and without.
  await openPage(page, `/run/${demoId('batchFork')}`, 'run');
  expect(await hiddenText(page)).toEqual([]);
  expect(await over(page, onPhone(page))).toEqual([]);
});

test('every route at 320px has no serious or critical axe violation and scrolls nothing sideways, unless the table says why', async ({ page }) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 320, height: 640 });
  expect(await over(page, atNarrowest(page))).toEqual([]);
});

/** A heading in the accessibility tree: its level and name. */
interface Heading {
  level: number;
  name: string;
}

/** The headings of what `ariaSnapshot` reads, in reading order: what is hidden from a screen reader, or inert, is left out. */
async function headings(page: Page, root = 'body'): Promise<Heading[]> {
  const tree = await page.locator(root).first().ariaSnapshot();
  // YAML quotes a line holding a quote or a colon whole, its own quotes doubled.
  return [...tree.matchAll(/- ('?)heading(?: "((?:[^"\\]|\\.)*)")? \[level=(\d)\]/g)].map((m) => ({ level: Number(m[3]), name: m[1] ? (m[2] ?? '').replaceAll("''", "'") : (m[2] ?? '') }));
}

/**
 * What breaks the outline: not one h1, the h1 not first, or a heading more than a level under the one
 * before. A dialog's outline is its own, the page behind it inert: its title first, at whatever level
 * the dialog draws it, and no h1.
 */
function outlineBreaks(hs: Heading[], o: { title?: string } = {}): string[] {
  const out: string[] = [];
  const ones = hs.filter((h) => h.level === 1);
  if (o.title !== undefined) {
    if (ones.length) out.push(`${ones.length} h1s in a dialog`);
    if (hs[0]?.name !== o.title) out.push(`its first heading is ${hs[0] ? `h${hs[0].level} “${hs[0].name}”` : 'none'}, not its title “${o.title}”`);
  } else {
    if (ones.length !== 1) out.push(`${ones.length} h1s${ones.length ? ` (${ones.map((h) => `“${h.name}”`).join(', ')})` : ''}`);
    if (hs[0] && hs[0].level !== 1) out.push(`its first heading is h${hs[0].level} “${hs[0].name}”`);
  }
  hs.forEach((h, i) => {
    const before = hs[i - 1];
    if (before && h.level > before.level + 1) out.push(`h${before.level} “${before.name}” then h${h.level} “${h.name}”`);
  });
  return out;
}

/** The page's outline, or the dialog's on top of it, by its title. */
async function outline(page: Page): Promise<string[]> {
  const dialog = page.locator(DIALOG).first();
  if (!(await dialog.count())) return outlineBreaks(await headings(page));
  // Its words as a screen reader hears them, whitespace normalised as the snapshot's are: the copy glues words with no-break spaces.
  const title = await dialog.evaluate((d) => (document.getElementById(d.getAttribute('aria-labelledby') ?? '')?.textContent ?? d.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim());
  return outlineBreaks(await headings(page, DIALOG), { title });
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

/** A command's `$` that a screen reader would read: each is drawn for the eye only, the command read without it. */
function prompts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const walk = document.createTreeWalker(document.getElementById('root')!, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const up = n.parentElement!;
      if (!/^\s*\$(\s|$)/.test(n.nodeValue ?? '') || n.previousSibling || up.closest('[aria-hidden="true"], .sr')) continue;
      if (up.textContent.trim() === '$' || /^(code|pre)$/i.test(up.tagName)) out.push(`a $ read aloud in ${up.tagName.toLowerCase()}.${String(up.className).trim().split(/\s+/).join('.')} “${up.textContent.trim().slice(0, 30)}”`);
    }
    return out;
  });
}

/**
 * At 1440px: the heading outline, a command's `$` and hidden text, then in a forced-colours theme the
 * marks, the selection and axe's rules. `marks` counts the marks it noted.
 */
const atDesk = (page: Page, marks: { seen: number }) => async (): Promise<string[]> => {
  // Hidden text at a desktop's width too, where Runs' rows draw their keys and their statuses' words.
  const found = [...(await outline(page)), ...(await prompts(page)), ...(await hiddenText(page))];
  marks.seen += await noteMarks(page);
  await page.emulateMedia({ forcedColors: 'active' });
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  // Not axe's contrast here: it reads -webkit-text-fill-color, which Chrome leaves at the stylesheet's colour where it paints the system's.
  found.push(...(await forcedMarks(page)), ...(await forcedSelection(page)), ...(await seriousViolations(page)).filter((v) => !v.startsWith('color-contrast ')));
  await page.emulateMedia({ forcedColors: 'none' });
  return found;
};

test('every route at 1440px keeps its heading outline, a command’s $ for the eye only, its hidden text where it is read and, in a forced-colours theme, its marks, its selection and axe’s rules', async ({ page }) => {
  test.setTimeout(600_000);
  const marks = { seen: 0 };
  expect(await over(page, atDesk(page, marks))).toEqual([]);
  // The strip's cells, the chart's bars, the legends' and the lists' dots: the routes hold hundreds.
  expect(marks.seen).toBeGreaterThan(100);
});

/**
 * An injection test's pages (routes.ts' injectionRoutes) at 390, 320 and 1440 px, swept as every
 * route is, on a store real commands made for them (injection-fixture.ts, with its second recording
 * for Pack with injection gate…) and a dashboard of their own: one store for the three, its tests in
 * order in one worker, the dashboard stopped after.
 */
test.describe('an injection test’s pages', () => {
  test.describe.configure({ mode: 'serial' });
  let built: InjectionStore | null = null;
  let served: (Served & { stop: () => Promise<void> }) | null = null;
  const routes = () => {
    if (!built || !served) throw new Error('the injection store was not built');
    return injectionRoutes(served, built.runId, built.second);
  };
  test.beforeAll(async () => {
    // Six commands on a mock model, a few seconds each, then the dashboard.
    test.setTimeout(180_000);
    built = await buildInjectionStore({ second: true });
    served = await serveDashboard(built.folder, built.project);
  });
  test.afterAll(async () => {
    await served?.stop();
    served = null;
    if (built) rmSync(built.folder, { recursive: true, force: true });
    built = null;
  });

  test('on a 390px phone have no serious or critical axe violation, scroll nothing sideways, draw no label under 11px and keep their hidden text where it is read', async ({ page }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await over(page, onPhone(page), routes())).toEqual([]);
  });

  test('at 320px have no serious or critical axe violation and scroll nothing sideways', async ({ page }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 320, height: 640 });
    expect(await over(page, atNarrowest(page), routes())).toEqual([]);
  });

  test('at 1440px keep their heading outline, a command’s $ for the eye only and their hidden text and, in a forced-colours theme, their marks, their selection and axe’s rules', async ({ page }) => {
    test.setTimeout(600_000);
    const marks = { seen: 0 };
    expect(await over(page, atDesk(page, marks), routes())).toEqual([]);
    // The results' cells and the attempts' strip.
    expect(marks.seen).toBeGreaterThan(10);
  });

  test('say an untrusted read’s tag apart from its call’s name and effect, in Calls and in Turns', async ({ page }) => {
    const [at, runId] = [served!, built!.runId];
    await openPage(page, `/run/${runId}`, 'run', at);
    // The five fetch_page reads, each tagged.
    expect((await names(page, 'main#view table.calls tbody', 'cell')).filter((c) => c.startsWith('tool fetch_page read untrusted '))).toHaveLength(5);
    await openPage(page, `/run/${runId}/turns`, 'run', at);
    expect((await names(page, 'main#view .vbody', 'button')).filter((n) => /^↳ #\d+ fetch_page read untrusted live$/.test(n))).toHaveLength(5);
  });

  test('say each untrusted read on Tests’ Security apart, its cell wrapping between them on a phone, and a tool apart from its effect on Settings → Tools', async ({ page }) => {
    const at = served!;
    await page.setViewportSize({ width: 390, height: 844 });
    await openPage(page, '/tests', 'main#view table.sect tbody tr', at);
    // The golden's five reads, a space apart: never “fetch_page#8”.
    expect((await names(page, 'main#view table.sect tbody', 'cell')).filter((c) => c.startsWith('#'))).toEqual([expect.stringMatching(/^#\d+ fetch_page( #\d+ fetch_page){4}$/)]);
    // Each read kept whole and the line broken between them, so the table's box scrolls nothing sideways.
    expect(await page.locator('main#view .tscroll:has(table.sect)').evaluate((box) => box.scrollWidth - box.clientWidth)).toBeLessThanOrEqual(0);
    await openPage(page, '/settings/tools', 'main#view table.trusttab tbody tr', at);
    expect((await names(page, 'main#view table.trusttab tbody', 'cell')).filter((c) => /^\w+ (read|pure|write)$/.test(c))).toEqual(['fetch_page read', 'search_web read', 'read_file pure', 'send_email write']);
  });

  test.describe('on a touch screen', () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

    test('Find cause…, the trust marks, the tools entry’s and Run injection test…’s buttons take the tap at their edges, and never a neighbour’s', async ({ page }) => {
      const states: Array<[string, Target[]]> = [
        [
          'Settings → Tools’ Trust column',
          [
            { name: 'Mark trusted or untrusted', sel: 'main#view .trusttab .trustbtn', reach: [4, 0, 4, 0] },
            { name: 'Run injection test… on a read’s row', sel: 'main#view .trusttab .btn.tooltest', size: [0, 24] },
            { name: 'the tools entry’s Show and Copy entry', sel: 'main#view .wftog button.linkbtn', reach: [4, 0, 4, 0] },
          ],
        ],
        ['Find cause… on a write after an untrusted read', [{ name: 'Find cause…', sel: 'main#view .ihead .iask', size: [0, 32], reach: [6, 2, 6, 2] }]],
        ['Tests with Security', [{ name: 'Run injection test… on a golden', sel: 'main#view table.sect .btn', size: [0, 24] }]],
      ];
      const found: string[] = [];
      for (const [name, targets] of states) {
        await show(page, routes().find((r) => r.name === name)!)();
        for (const t of targets) found.push(...(await taps(page, t)).map((p) => `${name}: ${p}`));
      }
      expect(found).toEqual([]);
    });
  });
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

test('the offline bar is said once, by one live region that was on the page before it, and never its countdown', async ({ page }) => {
  await openPage(page, `/run/${dash().runs.ticket as string}`, 'run');
  const said = page.getByRole('status').filter({ hasText: /Offline/ });
  // The bar's own region, there and empty while the server answers, marked to be known again.
  const region = page.locator('#conn > .sr[role="status"]');
  await expect(region).toHaveCount(1);
  await expect(region).toHaveText('');
  await region.evaluate((el) => el.setAttribute('data-before', ''));
  // The server stops answering: the bar comes once the page's next look fails.
  await page.route('**/api/**', (route) => route.abort());
  await page.waitForSelector('.connbar', { state: 'visible', timeout: 30_000 });
  await expect(said).toHaveCount(1);
  await expect(said).toHaveAttribute('data-before', '');
  await expect(said).toHaveText(/^Offline · actions paused · Can’t reach the dashboard server · showing what loaded/);
  expect(await page.locator('[role="status"]').evaluateAll((all) => all.filter((s) => /Retrying in/.test(s.textContent ?? '')).length)).toBe(0);
  expect(await page.locator('.connbar').ariaSnapshot()).not.toMatch(/Offline · actions paused/);
  await page.unroute('**/api/**');
});

/**
 * The names a screen reader hears for each `role` under `root`, from the accessibility tree, in order.
 * The snapshot is YAML: a line holding a quote or a colon is quoted whole, its own quotes doubled.
 */
async function names(page: Page, root: string, role: string): Promise<string[]> {
  const tree = await page.locator(root).first().ariaSnapshot();
  return [...tree.matchAll(new RegExp(`- ('?)${role} "((?:[^"\\\\]|\\\\.)*)"`, 'g'))].map((m) => JSON.parse(`"${m[1] ? m[2]!.replaceAll("''", "'") : m[2]!}"`) as string);
}

/** Each run row's whole about line and the status a screen reader hears after it, as the page draws them. */
function aboutRows(page: Page, rows: string): Promise<Array<{ id: string; about: string | null; cut: boolean; status: string | null }>> {
  return page.locator(rows).evaluateAll((all) =>
    all.map((a) => {
      const about = a.querySelector<HTMLElement>('.rab[data-about]');
      const st = a.querySelector<HTMLElement>('[data-gives]');
      const heard = st && st.dataset.give !== '2' ? (st).innerText.replace(/^\s*·/, '').replace(/\s+/g, ' ').trim() : '';
      return { id: a.querySelector('code')?.textContent?.trim() ?? '', about: about?.dataset.about ?? null, cut: !!about && (about.dataset.gone !== undefined || !!about.querySelector('[aria-hidden="true"]')), status: heard || null };
    }),
  );
}

/** Each row's link names its run by its whole about line, the status after it heard apart by its `·`. */
function wholeLines(rows: Awaited<ReturnType<typeof aboutRows>>, said: string[]): string[] {
  const out: string[] = [];
  rows.forEach((r, i) => {
    const name = said[i] ?? '';
    if (!name.includes(r.id)) out.push(`row ${i} is named “${name}”, not by its run ${r.id}`);
    else if (r.about && !name.includes(r.status ? `${r.about} · ${r.status}` : r.about)) out.push(`${r.id} is named “${name}”`);
    if (/·\s*·/.test(name)) out.push(`${r.id} says two dots: “${name}”`);
  });
  return out;
}

test('on a 390px phone each run’s link says its whole about line, however short the line drawn, then its status heard apart', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPage(page, '/', 'overview');
  await page.locator('button.menu-toggle').click();
  await expect(page.locator('aside#side.open')).toBeVisible();
  const side = await aboutRows(page, 'aside#side .runs a.run');
  expect(wholeLines(side, await names(page, 'aside#side .runs', 'link'))).toEqual([]);
  // The sidebar's drawer is narrow: some line was drawn shorter, or gave up its place.
  expect(side.some((r) => r.cut)).toBe(true);
  // A run's header: its line drawn shorter, the whole of it heard.
  await openPage(page, `/run/${demoId('ticket')}`, 'run');
  const about = page.locator('.rhead [data-about]').first();
  await expect(about.locator('[aria-hidden="true"]')).toHaveCount(1);
  expect(await about.locator('xpath=..').ariaSnapshot()).toContain((await about.getAttribute('data-about'))!);
});

test('a screen reader hears apart the parts the margins draw apart, and each settings control by its row', async ({ page }) => {
  await openPage(page, '/', 'overview');
  // The facts named once by what they sum up.
  expect(await names(page, 'main#view', 'region')).toContain('Overview in figures');
  // Runs: the calendar's busiest day and failed count, each with what it counts; a chip's word and its count.
  await openPage(page, '/runs', 'main#view table.runst tbody tr');
  await page.locator('main#view button.linkbtn[aria-expanded="false"]', { hasText: 'Calendar' }).click();
  await page.waitForSelector('main#view .calkv');
  const told = await page.locator('.calkv dd > span:not(.calwho):has(> small)').evaluateAll((all) =>
    all.map((s) => {
      const lead = [...s.childNodes].filter((n) => !(n instanceof Element && n.matches('small, .srsp'))).map((n) => n.textContent).join('');
      // whitespace normalised as the snapshot's is: the copy glues a count to its noun with a no-break space
      return `${lead.trim()} ${s.querySelector('small')!.textContent.trim()}`.replace(/\s+/g, ' ');
    }),
  );
  expect(told.length).toBeGreaterThan(0);
  const cal = await page.locator('.calkv').ariaSnapshot();
  for (const t of told) expect(cal).toContain(t);
  const chips = await page.locator('main#view .chips button:has(b)').evaluateAll((all) => all.map((b) => `${[...b.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim()} ${b.querySelector('b')!.textContent}`));
  expect(chips.length).toBeGreaterThan(0);
  expect(await names(page, 'main#view', 'button')).toEqual(expect.arrayContaining(chips));
  // Who made a run: a name and "(you)", a real space between.
  expect(await names(page, 'main#view table.runst', 'img')).toEqual(expect.arrayContaining([expect.stringMatching(/^\S+ \(you\)$/)]));
  // A run's calls: the kind, the name, the effect and the detail as words, and "fork 17". (No run of the demo's has agents: test/ui-run-state.test.ts reads their chips.)
  await openPage(page, `/run/${demoId('override')}`, 'run');
  const cells = await names(page, 'main#view table.calls tbody', 'cell');
  const parts = await page.locator('main#view table.calls td.name:has(> .eff)').evaluateAll((all) =>
    all.map((td) => `${td.querySelector(':scope > small')!.textContent} ${[...td.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim()} ${td.querySelector(':scope > .eff')!.textContent}`),
  );
  expect(parts.length).toBeGreaterThan(0);
  for (const p of parts) expect(cells.some((c) => c.startsWith(p))).toBe(true);
  expect(cells.filter((c) => /^fork \d+$/.test(c))).toHaveLength(1);
  // A view's tab and its count.
  expect(await names(page, 'main#view', 'tab')).toEqual(expect.arrayContaining([expect.stringMatching(/^Calls [\d,]+$/)]));
  // The strip's key: each origin's word and its count.
  expect(await names(page, '#olegend', 'button')).toEqual(expect.arrayContaining([expect.stringMatching(/^\S+ [\d,]+$/)]));
  expect((await names(page, '#olegend', 'button')).filter((n) => !/^\S.* [\d,]+$/.test(n))).toEqual([]);
  expect(cells.filter((c) => /^(tool|model|human|clk|rnd)\S/.test(c) || /\S→/.test(c))).toEqual([]);
  // A fix: what failed and what it must do, one dot between them heard, in the list and on its page; blame's verdict and its mark.
  for (const [path, drawn] of [['/fixes', 'main#view .pslist .fm'], [`/fixes/${demoId('refundFix')}`, 'fix']] as const) {
    await openPage(page, path, drawn);
    const tree = await page.locator('main#view').ariaSnapshot();
    expect(tree, path).toMatch(/Failed: [^\n]* · Must: /);
    expect(tree, path).not.toMatch(/·\s*·/);
  }
  await openPage(page, `/fixes/${demoId('refundFix')}/blame`, 'fix');
  expect(await names(page, 'main#view table', 'cell')).toEqual(expect.arrayContaining([expect.stringMatching(/^\S+ blamed$/)]));
  // Tests: a golden's error-path presets heard apart from its checks, then their picture by its counts, then the counts.
  await openPage(page, '/tests', 'main#view table.gt .gpstrip:visible');
  const strips = (await names(page, 'main#view table.gt tbody', 'cell')).filter((c) => c.includes('error-path presets'));
  expect(strips.length).toBeGreaterThan(0);
  for (const c of strips) expect(c).toMatch(/ error-path presets \d+ presets?: \d+ \w+(, \d+ \w+)* \d+ \w+( · \d+ \w+)*$/);
  // Training's tabs: the word and its count.
  await openPage(page, '/training', 'main#view .stabs a');
  expect(await names(page, 'main#view .stabs', 'link')).toEqual([expect.stringMatching(/^Pairs [\d,]+$/), expect.stringMatching(/^Tasks [\d,]+$/)]);
  // Settings: a control named by its row's label and described by its line. Fix on failure is off in the demo's workflow,
  // so its panel is folded and its controls are out of reach until Show settings opens it.
  await openPage(page, '/settings/ci', 'main#view .settab > :not(.skel)');
  await expect(page.locator('#cifixBudget')).toBeHidden();
  await page.locator('#fix-on-failure').getByRole('button', { name: 'Show settings' }).click();
  // A list's button says its name and how many rows it holds, and whether it is open.
  const needs = page.locator('#alerts .cimain .cifold > button');
  await expect(needs).toHaveAccessibleName(/^it needs \d+$/i);
  await expect(needs).toHaveAttribute('aria-expanded', 'false');
  for (const id of ['alertSecret', 'cifixBudget', 'cifixRepairer']) {
    const control = page.locator(`#${id}`);
    await expect(control).toHaveCount(1);
    await expect(control).toHaveAccessibleName((await page.locator(`#${id}-name`).textContent())!.trim());
    await expect(control).toHaveAccessibleDescription((await page.locator(`#${id}-help`).textContent())!.trim());
  }
  // The pull request comment's switch for the decisions, named and described by its row the same way, and what an
  // inconclusive golden does, in Your workflow.
  for (const row of ['cidecisions', 'inconclusive']) {
    const control = page.locator(`[aria-labelledby="${row}-name"]`);
    await expect(control).toHaveCount(1);
    await expect(control).toHaveAccessibleName((await page.locator(`#${row}-name`).textContent())!.trim());
    await expect(control).toHaveAccessibleDescription((await page.locator(`#${row}-help`).textContent())!.trim());
  }
});

test('a screen reader hears a judge no attempt of its fork golden asked by its mark’s word, its label and why, each apart, in its row on Tests and in its report', async ({ page }) => {
  await routeJudgesFixture(page);
  await openPage(page, '/tests', `main#view button.grptog[aria-controls="grp-${UNASKED}"]`);
  const heard = `not applicable ${JUDGE} ${JUDGE_ASKED_IN_NONE}`;
  expect((await names(page, 'main#view table.gt tbody', 'cell')).filter((c) => c.includes(heard))).toHaveLength(1);
  // Its report's checks part: the mark's word, then the label and why.
  await openReport(page, UNASKED);
  const lines = (await page.locator(`main#view section[id="report-${UNASKED}"]`).ariaSnapshot()).split('\n').map((l) => l.trim());
  const mark = '- img "not applicable": –';
  expect(lines).toContain(mark);
  expect(lines[lines.indexOf(mark) + 1]).toBe(`- text: ${JSON.stringify(`${JUDGE} ${JUDGE_ASKED_IN_NONE}`)}`);
});

test('Tests at 430 and 768px, a golden’s checks under its name, has no serious axe violation: where its error-path presets wrap, their link and their counts’ link stay 24px apart', async ({ page }) => {
  for (const width of [430, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await openPage(page, '/tests', 'main#view table.gt .gin .gpstrip a.gpn');
    expect(await seriousViolations(page)).toEqual([]);
  }
});

test('in a forced-colours theme the fork’s cell in the strip keeps its mark, a 2px band in the text colour round it', async ({ page }) => {
  await openPage(page, `/run/${demoId('override')}`, 'run');
  await page.emulateMedia({ forcedColors: 'active' });
  const [shadow, want] = await page.locator('.cells button.mark').first().evaluate((b) => {
    const probe = (c: string) => {
      const p = document.createElement('i');
      p.style.color = c;
      document.body.append(p);
      const v = getComputedStyle(p).color;
      p.remove();
      return v;
    };
    const [text, ground] = [probe('CanvasText'), probe('Canvas')];
    return [getComputedStyle(b).boxShadow, `${text} 0px 0px 0px 1px inset, ${ground} 0px 0px 0px 2px, ${text} 0px 0px 0px 4px`];
  });
  expect(shadow).toBe(want);
});

/** The chart's labels a reader sees that touch the one before: each drawn label's text box, left to right. */
function labelsTouch(page: Page): Promise<string[]> {
  return page.locator('main#view .clabels').first().evaluate((row) => {
    const out: string[] = [];
    let last: { t: string; right: number } | null = null;
    for (const span of row.querySelectorAll<HTMLElement>(':scope > span')) {
      if (!span.textContent || getComputedStyle(span).visibility === 'hidden') continue;
      const range = document.createRange();
      range.selectNodeContents(span);
      const box = range.getBoundingClientRect();
      if (last && box.left < last.right + 2) out.push(`${last.t} and ${span.textContent} touch`);
      last = { t: span.textContent, right: box.right };
    }
    return out;
  });
}

test('below 400px a chart of eleven or more calls labels every other one, never two touching, the open call’s label always shown', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const sizes: number[] = [];
  for (const name of ['override', 'batch', 'batchFork']) {
    await openPage(page, `/run/${demoId(name)}/context`, 'run');
    // Counted once the chart is drawn, its view's script in, and every call read: a long run's come a page at a time, a
    // bar more with each, the note that counts them shown until the last.
    const bars = page.locator('main#view .cbars .cbar');
    await expect(bars.first()).toBeAttached();
    await expect(page.locator('main#view .views > .toolbar')).toHaveCount(0);
    const n = await bars.count();
    sizes.push(n);
    expect(await labelsTouch(page), `${n} calls`).toEqual([]);
    // The second label drawn says the step: a call off it opened, then one on it.
    const step = await page.locator('main#view .clabels > span').evaluateAll((all) => all.findIndex((s, i) => i > 0 && !!s.textContent));
    for (const at of [Math.max(1, Math.floor(step / 2)), step + 1, step]) {
      // A bar is a pixel or two wide on a phone, under its neighbours' cards: a click on it, not a pointer's.
      await bars.nth(at).evaluate((b) => (b as HTMLElement).click());
      const open = page.locator('main#view .clabels > span.sel');
      await expect(open).toHaveCount(1);
      expect(await open.evaluate((s) => !!s.textContent && getComputedStyle(s).visibility !== 'hidden'), `${n} calls, #${at} open`).toBe(true);
      expect(await labelsTouch(page), `${n} calls, #${at} open`).toEqual([]);
    }
  }
  // A chart labelled every other call by the rule, and one thinned already past 22 calls.
  expect(sizes.some((n) => n >= 11 && n <= 22) && sizes.some((n) => n > 22)).toBe(true);
});

test('below 400px a chart labelled every third call, with a call off that step open, shows every other label it draws after the open one', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // The demo has no chart of 45 to 66 calls, labelled every third: the long batch's first 50 model calls make one.
  const id = demoId('batchFork');
  await page.route(new RegExp(`/api/runs/${id}(\\?.*)?$`), (route) =>
    patched<{ calls: Array<{ kind: string; usage?: unknown; outcome?: string }> }>(route, (d) => {
      let seen = 0;
      const calls = d.calls.slice(0, d.calls.findIndex((c) => c.kind === 'api' && !!c.usage && c.outcome !== 'error' && ++seen === 50) + 1);
      return { ...d, calls, callsTotal: calls.length, callsNext: null };
    }),
  );
  await openPage(page, `/run/${id}/context`, 'run');
  const bars = page.locator('main#view .cbars .cbar');
  await expect(bars).toHaveCount(50);
  // The eighth bar, off the step of three: its neighbours on the step draw no label.
  await bars.nth(7).evaluate((b) => (b as HTMLElement).click());
  await expect(page.locator('main#view .clabels > span.sel')).toHaveText(/^#\d/);
  const after = await page.locator('main#view .clabels > span').evaluateAll((all) => {
    const at = all.findIndex((s) => s.classList.contains('sel'));
    const drawn = all.slice(at + 1).filter((s) => !!s.textContent && !s.classList.contains('near'));
    return { drawn: drawn.length, shown: drawn.filter((s) => getComputedStyle(s).visibility !== 'hidden').length, open: getComputedStyle(all[at]!).visibility };
  });
  expect(after.open).toBe('visible');
  expect(after.drawn).toBeGreaterThan(6);
  expect(after.shown).toBeGreaterThanOrEqual(Math.floor(after.drawn / 2));
  expect(await labelsTouch(page)).toEqual([]);
});

/** The Tab stops in document order: what Tab and Shift+Tab move between. */
function tabStops(page: Page): Promise<number> {
  return page.evaluate(() => {
    const stops = [...document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')].filter(
      (el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[inert]'),
    );
    (window as unknown as { __stops: HTMLElement[] }).__stops = stops;
    return stops.length;
  });
}

test('a call the browser brings into view above the calls list stops clear of the list’s head, which without the scroll padding it would sit under', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 640 });
  await openPage(page, `/run/${demoId('batch')}`, 'run');
  // The list draws only the rows near its view, and moves its own keys' rows clear of the head
  // already (window-hook.ts): this is what the browser scrolls itself, for a screen reader's cursor,
  // find in page or a focus it doesn't place. A row's fold caret is laid under the head, then shown.
  const under = (padding: string) =>
    page.evaluate((padding) => {
      const body = document.querySelector<HTMLElement>('main#view .vbody')!;
      body.style.scrollPaddingTop = padding;
      const el = [...body.querySelectorAll<HTMLElement>('tbody .tcaret')].find((e) => e.checkVisibility({ visibilityProperty: true }))!;
      body.scrollTop = 0;
      const head = body.querySelector('thead')!.getBoundingClientRect();
      body.scrollTop = el.getBoundingClientRect().top - head.top - 4;
      const placed = head.bottom - el.getBoundingClientRect().top;
      el.scrollIntoView({ block: 'nearest' });
      return [placed, head.bottom - el.getBoundingClientRect().top];
    }, padding);
  const [placed, kept] = await under('');
  expect(placed).toBeGreaterThan(0.5);
  expect(kept).toBeLessThanOrEqual(0.5);
  expect((await under('0px'))[1]).toBeGreaterThan(0.5);
});

test('on a 390px phone with a job’s drawer docked, Tab to a control below the fold stops it clear of the drawer, its $ drawn for the eye only', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await startJob(page);
  await page.waitForSelector('body.docked section.drawer');
  expect(await page.locator('section.drawer pre .p').first().evaluate((l) => l.querySelector('[aria-hidden="true"]')?.textContent)).toBe('$');
  await page.evaluate(() => {
    location.hash = '#/runs';
  });
  await page.locator('main#view table.runst tbody tr').first().waitFor();
  await tabStops(page);
  const under = async (padding: string) => {
    const placed = await page.evaluate((padding) => {
      document.documentElement.style.scrollPaddingBottom = padding;
      const drawer = document.querySelector('section.drawer')!.getBoundingClientRect();
      const stops = (window as unknown as { __stops: HTMLElement[] }).__stops;
      const at = stops.findIndex((el, i) => i > 0 && el.closest('main#view') && el.getBoundingClientRect().top + scrollY > drawer.top + 200 && !el.closest('.vbody'));
      if (at < 0) return false;
      // Just inside the window, under the drawer's top.
      scrollTo(0, stops[at]!.getBoundingClientRect().top + scrollY - drawer.top - 8);
      stops[at - 1]!.focus({ preventScroll: true });
      (window as unknown as { __want: HTMLElement }).__want = stops[at]!;
      return true;
    }, padding);
    expect(placed, 'a Tab stop below the fold').toBe(true);
    await page.keyboard.press('Tab');
    return page.evaluate(() => {
      const want = (window as unknown as { __want: HTMLElement }).__want;
      return document.activeElement === want ? want.getBoundingClientRect().bottom - document.querySelector('section.drawer')!.getBoundingClientRect().top : NaN;
    });
  };
  expect(await under('')).toBeLessThanOrEqual(0.5);
  expect(await under('0px')).toBeGreaterThan(0.5);
});

/** A hit area a touch screen claims: its box and how far it reaches past it, at least `size` across. */
interface Target {
  name: string;
  sel: string;
  size?: [number, number];
  /** How far the hit area reaches past the box (its ::before or ::after): top, right, bottom, left. */
  reach?: [number, number, number, number];
  /** Spaced rather than grown: a `size` square round its middle may hold a gap, never another control. */
  spaced?: boolean;
}

/** Taps just inside each edge of each target's hit area: each lands on the target, or for a spaced one never on another control; and the area is as big as it claims. */
function taps(page: Page, t: Target): Promise<string[]> {
  return page.evaluate((t) => {
    const out: string[] = [];
    const control = (n: Element | null) => n?.closest('a[href], button, input, select, textarea, summary, label, [role="button"], [tabindex]:not([tabindex="-1"])') ?? null;
    const name = (el: Element) => `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join('.')} “${(el.textContent ?? '').trim().slice(0, 20)}”`;
    const els = [...document.querySelectorAll<HTMLElement>(t.sel)].filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden').slice(0, 10);
    if (!els.length) return [`${t.name}: none drawn`];
    for (const el of els) {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const b = el.getBoundingClientRect();
      const [cx, cy] = [b.left + b.width / 2, b.top + b.height / 2];
      const [top, right, bottom, left] = t.reach ?? [0, 0, 0, 0];
      const [w, h] = t.size ?? [0, 0];
      const area = t.spaced ? { l: cx - w / 2, r: cx + w / 2, t: cy - h / 2, b: cy + h / 2 } : { l: b.left - left, r: b.right + right, t: b.top - top, b: b.bottom + bottom };
      if (area.r - area.l < w - 0.5 || area.b - area.t < h - 0.5) out.push(`${t.name} ${name(el)}: ${Math.round(area.r - area.l)}×${Math.round(area.b - area.t)}, under ${w}×${h}`);
      const edges: Array<[number, number, string]> = [
        [area.l + 1, cy, 'left'],
        [area.r - 1, cy, 'right'],
        [cx, area.t + 1, 'top'],
        [cx, area.b - 1, 'bottom'],
      ];
      for (const [x, y, edge] of edges) {
        const hit = document.elementFromPoint(x, y);
        const ok = !!hit && (el.contains(hit) || (!!t.spaced && (!control(hit) || control(hit) === control(el))));
        if (!ok) out.push(`${t.name} ${name(el)}: a tap at its ${edge} edge lands on ${hit ? name(hit) : 'nothing'}`);
      }
    }
    return out;
  }, t);
}

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test('each hit area a page claims takes the tap at its edges, and never a neighbour’s', async ({ page }) => {
    // A label of the demo's own, routed onto a run, so its × is drawn.
    const good = demoId('good');
    await page.route(new RegExp(`/api/runs/${good}(\\?.*)?$`), async (route) => {
      const res = await route.fetch(RESET_RETRY);
      const json = (await res.json()) as { run: { meta?: { labels?: string[] } } };
      json.run.meta = { ...json.run.meta, labels: [...(json.run.meta?.labels ?? []), 'refunds'] };
      await route.fulfill({ response: res, json });
    });
    const pages: Array<[string, string, Target[]]> = [
      [
        '/runs',
        'main#view table.runst tbody tr',
        [
          { name: 'a run’s checkbox cell', sel: 'main#view table.runst td.selcell .selhit', size: [44, 44] },
          { name: 'a calendar day', sel: 'main#view .calgrid button.cd', size: [24, 24], spaced: true },
          { name: 'a link-style button', sel: 'main#view button.linkbtn[aria-expanded]', reach: [4, 0, 4, 0] },
        ],
      ],
      [
        '/',
        // Its facts, drawn with its summary: its header comes first, while the summary is still being read.
        'main#view a.metric',
        [
          { name: 'a fact that is a link', sel: 'main#view a.metric', reach: [4, 0, 4, 0] },
          { name: 'a link-style button', sel: 'main#view .ovuse > header button.linkbtn', reach: [4, 0, 4, 0] },
          { name: 'Dismiss’s ×', sel: 'main#view .arow .adis', size: [24, 24], reach: [1, 1, 1, 1] },
        ],
      ],
      // A finding's buttons, wrapped under each other below 400px.
      [`/run/${demoId('override')}`, 'run', [{ name: 'a finding’s button', sel: 'main#view .findings :is(.banner .linkbtn, .fmore)', size: [0, 24], reach: [4, 0, 4, 0] }]],
      [(await previewed(page)).preview, 'main#view .dmx button.dc', [{ name: 'a decision cell', sel: 'main#view .dmx .dmc:not(.dense) .dc:is(:first-child, :last-child)', size: [24, 24], reach: [4, 3, 4, 3] }]],
      // A migration's compact matrix takes Preview's cells, and its pull request body's Show a link-style button's reach.
      [
        (await migrated(page)).report,
        MIGRATED,
        [
          { name: 'a decision cell in a migration’s matrix', sel: 'main#view .dmx.compact .dmc:not(.dense) .dc:is(:first-child, :last-child)', size: [24, 24], reach: [4, 3, 4, 3] },
          { name: 'a link-style button', sel: 'main#view .mgpr button.linkbtn[aria-expanded]', reach: [4, 0, 4, 0] },
        ],
      ],
      [
        `/run/${good}`,
        'run',
        [
          { name: 'a strip cell', sel: 'main#view .cells button', size: [0, 24] },
          { name: 'a label’s ×', sel: 'main#view .labelbar .chip button', size: [24, 24], reach: [7, 12, 6, 5] },
          { name: 'the inspector’s Add check', sel: 'main#view .ihead .ckins', size: [0, 32], reach: [4, 2, 4, 2] },
        ],
      ],
      [`/run/${demoId('batch')}`, 'run', [{ name: 'a group’s caret', sel: 'main#view table.calls .tcaret', reach: [3, 5, 3, 5] }]],
      [`/fixes/${demoId('refundFix')}/blame`, 'fix', [{ name: 'a blamed call’s column', sel: 'main#view .callrow .cn' }]],
      [`/fixes/${demoId('refundFix')}/verify`, 'fix', [{ name: 'the attempts’ caret', sel: 'main#view .xbtn', size: [32, 32], reach: [5, 5, 5, 5] }]],
      ['/settings/project', 'main#view .settab > :not(.skel)', [{ name: 'a spending choice', sel: 'main#view .setrow.spend .seg button', reach: [6, 0, 6, 0] }]],
      // The late pages: a golden's checks' line on a touch screen, and a fix's check. Wrapped, the two sit 10px apart as laid
      // out, so Add check… takes the 4px under Edit checks…, which keeps 25px (the design's own sum).
      [
        '/tests',
        'main#view table.gt',
        [
          { name: 'Edit checks…', sel: 'main#view .ckt .linkbtn[data-ck="edit"]', size: [0, 24], reach: [4, 0, 0, 0] },
          { name: 'Add check…', sel: 'main#view .ckt .linkbtn[data-ck="add"]', size: [0, 24], reach: [4, 0, 4, 0] },
        ],
      ],
      [`/fixes/${demoId('emailFix')}`, 'fix', [{ name: 'a fix’s Edit check…', sel: 'main#view .ph p.chk .fmx .linkbtn', reach: [4, 0, 4, 0] }]],
      // Not covered's rows (port/presets-coverage): the count's toggle 32px tall on a touch screen and a caret's 5px past it, the row's pack beside it.
      [
        '/tests?at=notcovered',
        'main#view #notcovered ul.covl > li',
        [
          { name: 'Not covered’s toggle', sel: 'main#view #notcovered .xbtn.cvn', size: [0, 42], reach: [5, 5, 5, 5] },
          { name: 'a Not covered row’s pack', sel: 'main#view #notcovered .cvacts .btn', size: [0, 24] },
        ],
      ],
    ];
    const found: string[] = [];
    for (const [path, drawn, targets] of pages) {
      await openPage(page, path, drawn);
      if (path === '/runs') await page.locator('main#view button.linkbtn[aria-expanded="false"]', { hasText: 'Calendar' }).click();
      for (const t of targets) found.push(...(await taps(page, t)).map((p) => `${path}: ${p}`));
    }
    // States of the route table: the builder's Suggested, and a failed gate's report with its attempts folded past 24 (routed, so last).
    const states: Array<[string, Target[]]> = [
      ['the check builder', [{ name: 'Suggested’s Use rule', sel: `${DIALOG} .cb-sug .linkbtn`, reach: [4, 0, 4, 0] }]],
      ['Tests with a gated golden’s evidence and three reports open', [{ name: 'a gate’s caret', sel: 'main#view section[id="report-email-gate"] .ibx .xbtn', size: [32, 32], reach: [5, 5, 5, 5] }]],
    ];
    for (const [name, targets] of states) {
      await show(page, ROUTES.find((r) => r.name === name)!)();
      for (const t of targets) found.push(...(await taps(page, t)).map((p) => `${name}: ${p}`));
    }
    expect(found).toEqual([]);
  });

  test('a tap at the edge of a run’s checkbox cell picks the run and never opens it', async ({ page }) => {
    await openPage(page, '/runs', 'main#view table.runst tbody tr');
    const cell = page.locator('main#view table.runst td.selcell .selhit').first();
    const b = (await cell.boundingBox())!;
    await page.touchscreen.tap(b.x + b.width - 2, b.y + 2);
    await expect(page.locator('main#view table.runst tbody tr').first().locator('td.selcell input')).toBeChecked();
    expect(new URL(page.url()).hash).toMatch(/^#\/runs/);
  });
});
