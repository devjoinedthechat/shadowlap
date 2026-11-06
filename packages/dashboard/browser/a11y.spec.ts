import { expect, test, type Page } from '@playwright/test';
import { parseRoute, routeHref } from '../ui/route.js';
import { runsLinkQuery } from '../ui/runspage/query.js';
import { contrast, demoId, focusedLabel, openPage, serverLinks, seriousViolations, tabUntil } from './dashboard.js';

/**
 * The dashboard in Chromium over the demo store, as a person with a keyboard or a screen reader
 * meets it: no serious or critical axe violation on the pages a user lands on most, text that
 * reaches AA contrast, a skip link first, a focus order that follows the page, focus rings drawn
 * whole in scrolling panes, the palette as a combobox, and every overlay keeping and returning the
 * focus. And every link the server writes opens a page the dashboard has.
 */

const PAGES: Array<{ name: string; path: () => string; drawn: string }> = [
  { name: 'the Overview', path: () => '/', drawn: 'main#view .ovg' },
  { name: 'Runs', path: () => '/runs', drawn: 'main#view table.runst tbody tr' },
  { name: 'a run', path: () => `/run/${demoId('refundBug')}`, drawn: 'run' },
  { name: 'a fork', path: () => `/run/${demoId('override')}`, drawn: 'run' },
  { name: 'a fix', path: () => `/fixes/${demoId('refundFix')}`, drawn: 'fix' },
];

for (const p of PAGES) {
  test(`${p.name} has no serious or critical axe violation`, async ({ page }) => {
    await openPage(page, p.path(), p.drawn);
    expect(await seriousViolations(page)).toEqual([]);
  });
}

test('a fork’s page says what it did differently, and has no serious or critical axe violation with it', async ({ page }) => {
  await openPage(page, `/run/${demoId('override')}`, 'run');
  await page.waitForSelector('.fdiff h2');
  expect(await page.textContent('.fdiff h2')).toBe('What the fork did differently');
  expect(await seriousViolations(page)).toEqual([]);
});

test('a fork’s writes and a kept run’s baseline wrap: a phone shows the fork, and a laptop the fix’s runs, with nothing running past them', async ({ page }) => {
  // A phone: the fork's page is no wider than the phone, its writes' arguments wrapped.
  await page.setViewportSize({ width: 390, height: 900 });
  await openPage(page, `/run/${demoId('override')}`, 'run');
  await page.waitForSelector('.fdiff .fdw code');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  // A laptop: the table of the runs a fix was verified on doesn't scroll sideways for a good run's baseline.
  await page.setViewportSize({ width: 1280, height: 800 });
  await openPage(page, `/fixes/${demoId('refundFix')}/verify`, 'fix');
  const table = page.locator('main#view section.panel.tscroll', { has: page.locator('.fxbase') }).first();
  await table.waitFor();
  expect(await table.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
});

test('the fix’s steps group their attempts by what each did, with no serious or critical axe violation', async ({ page }) => {
  await openPage(page, `/fixes/${demoId('refundFix')}/verify`, 'fix');
  await page.waitForSelector('main#view table.t tbody tr');
  expect(await seriousViolations(page)).toEqual([]);
  await openPage(page, `/fixes/${demoId('refundFix')}/blame`, 'fix');
  await page.waitForSelector('main#view table.probes tbody tr');
  expect(await seriousViolations(page)).toEqual([]);
});

/** Text tokens, and the surfaces text is drawn on, as the browser computed them on the page. */
const TEXT = ['--ink', '--dim', '--faint', '--err', '--warn', '--accent', '--o-rep', '--o-over', '--o-stub', '--o-block', '--k-write', '--c-write', '--del', '--add'];
const SURFACES = ['--bg', '--bg2', '--panel', '--raise', '--hover', '--sel', '--code', '--pop'];

test('every text colour reaches 4.5:1 on the page and on every panel, and a field’s edge 3:1, as the browser draws them', async ({ page }) => {
  await openPage(page, '/', 'main#view .ovg');
  // Each token as the browser draws it: set as an element's colour and read back, a mix worked out.
  const tokens = await page.evaluate((names) => {
    const probe = document.body.appendChild(document.createElement('i'));
    const out = Object.fromEntries(
      names.map((n) => {
        probe.style.color = `var(${n})`;
        return [n, getComputedStyle(probe).color];
      }),
    );
    probe.remove();
    return out;
  }, [...TEXT, ...SURFACES, '--field']);
  const low: string[] = [];
  for (const t of TEXT) for (const s of SURFACES) if (contrast(tokens[t]!, tokens[s]!) < 4.5) low.push(`${t} on ${s}: ${contrast(tokens[t]!, tokens[s]!).toFixed(2)}`);
  for (const s of ['--bg', '--pop', '--bg2', '--panel']) if (contrast(tokens['--field']!, tokens[s]!) < 3) low.push(`--field on ${s}: ${contrast(tokens['--field']!, tokens[s]!).toFixed(2)}`);
  expect(low).toEqual([]);
  // And faint text where it is drawn, on what is under it.
  const pairs = await page.evaluate(() => {
    const faint = getComputedStyle(document.documentElement).getPropertyValue('--faint').trim();
    const rgb = (hex: string) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
    const out: Array<[string, string]> = [];
    for (const el of document.querySelectorAll<HTMLElement>('main#view *, aside#side *')) {
      const s = getComputedStyle(el);
      if (s.color !== rgb(faint) || !el.textContent?.trim() || !el.getClientRects().length) continue;
      let bg = 'rgba(0, 0, 0, 0)';
      for (let n: HTMLElement | null = el; n && /rgba\(0, 0, 0, 0\)|transparent/.test(bg); n = n.parentElement) bg = getComputedStyle(n).backgroundColor;
      out.push([s.color, bg]);
    }
    return out;
  });
  expect(pairs.length).toBeGreaterThan(20);
  for (const [fg, bg] of pairs) if (!/rgba\(.*, 0\)$/.test(bg)) expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
});

/** Which part of the page the focus is in. */
const region = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return 'body';
    if (el.classList.contains('skip')) return 'skip';
    if (el.closest('header.top, .top')) return 'top';
    if (el.closest('aside#side')) return 'side';
    if (el.closest('main#view')) return 'main';
    return 'other';
  });

test('Skip to content is the first stop for Tab, shows when it has the focus, and takes it to the page’s heading', async ({ page }) => {
  await openPage(page, `/run/${demoId('override')}`, 'run');
  await page.keyboard.press('Tab');
  expect(await focusedLabel(page)).toContain('Skip to content');
  const box = (await page.locator('a.skip').boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.height).toBeGreaterThan(10);
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => document.activeElement?.matches('main#view h1'))).toBe(true);
  // The run's own actions are a few presses away, not the 53rd stop they were.
  const presses = await tabUntil(page, () => document.activeElement?.textContent?.trim() === 'Replay', 15);
  expect(presses).toBeLessThanOrEqual(10);
});

test('Tab goes through the top bar, then the sidebar, then the page, never back', async ({ page }) => {
  await openPage(page, `/run/${demoId('override')}`, 'run');
  const order = ['skip', 'top', 'side', 'main'];
  const seen: string[] = [];
  for (let i = 0; i < 90; i++) {
    await page.keyboard.press('Tab');
    const at = await region(page);
    if (seen.at(-1) !== at) seen.push(at);
    if (at === 'main') break;
  }
  expect(seen.filter((x) => order.includes(x))).toEqual(order);
});

test('a focus ring in a pane that scrolls is drawn inside the control, so the pane cuts none of it off', async ({ page }) => {
  await openPage(page, `/run/${demoId('override')}`, 'run');
  await page.waitForSelector('aside#side .runs a.run');
  // The sidebar's runs, and a run's calls: rows flush with their scrolling pane's edges.
  for (const sel of ['aside#side .runs a.run', 'main#view .vbody button, main#view .vbody a']) {
    await page.focus(sel);
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const ring = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const s = getComputedStyle(el);
      const pane = (() => {
        for (let n = el.parentElement; n; n = n.parentElement) if (/(auto|scroll)/.test(getComputedStyle(n).overflowY + getComputedStyle(n).overflowX)) return n;
        return null;
      })();
      const r = el.getBoundingClientRect();
      const out = parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset);
      const p = pane!.getBoundingClientRect();
      return { style: s.outlineStyle, offset: s.outlineOffset, inside: r.left - out >= p.left - 0.5 && r.right + out <= p.right + 0.5 && r.top - out >= p.top - 0.5 };
    });
    expect(ring, sel).toEqual({ style: 'solid', offset: '-2px', inside: true });
  }
});

test('Search or jump to is a combobox, and hands the focus back when Esc closes it', async ({ page }) => {
  await openPage(page, '/runs', 'main#view table.runst tbody tr');
  await page.focus('header.top button.sbtn');
  await page.keyboard.press('Enter');
  const field = page.locator('.palin input');
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute('role', 'combobox');
  const active = async () => page.evaluate(() => {
    const id = document.querySelector('.palin input')!.getAttribute('aria-activedescendant');
    const el = id ? document.getElementById(id) : null;
    return el ? { id, role: el.getAttribute('role'), selected: el.getAttribute('aria-selected'), text: el.textContent } : null;
  });
  const first = (await active())!;
  expect(first).toMatchObject({ role: 'option', selected: 'true' });
  await page.keyboard.press('ArrowDown');
  const second = (await active())!;
  expect(second.id).not.toBe(first.id);
  await expect(field).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.palette')).toHaveCount(0);
  expect(await focusedLabel(page)).toContain('Search or jump to');
});

test('a menu closes on Esc to its button; a dialog keeps Tab in it and hands the focus back', async ({ page }) => {
  await openPage(page, `/run/${demoId('override')}`, 'run');
  const share = page.locator('.rhead .actions button', { hasText: 'Share' });
  await share.click();
  await expect(page.locator('.pop[role="menu"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.pop[role="menu"]')).toHaveCount(0);
  await expect(share).toBeFocused();
  const del = page.locator('.rhead .actions button', { hasText: 'Delete' });
  await del.click();
  const dialog = page.locator('[role="dialog"][aria-modal="true"]');
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(del).toBeFocused();
});

test('on a phone, a menu’s sheet closes on Esc to its button, a dialog’s sheet keeps Tab in it and hands the focus back', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPage(page, `/run/${demoId('override')}`, 'run');
  const share = page.locator('.rhead .actions button', { hasText: 'Share' });
  await share.click();
  const sheet = page.locator('.pop.sheet[role="menu"]');
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(share).toBeFocused();
  const del = page.locator('.rhead .actions button', { hasText: 'Delete' });
  await del.click();
  const dialog = page.locator('[role="dialog"][aria-modal="true"]');
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(del).toBeFocused();
});

test('on a phone, the sidebar hands the focus back to the menu button when Esc closes it', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await openPage(page, '/runs', 'main#view table.runst tbody tr');
  const menu = page.locator('button.menu-toggle');
  await menu.click();
  await expect(page.locator('aside#side.open')).toBeVisible();
  await page.focus('aside#side .navlist a');
  await page.keyboard.press('Escape');
  await expect(page.locator('aside#side.open')).toHaveCount(0);
  await expect(menu).toBeFocused();
});

test('every link the server writes opens a page the dashboard has', async ({ request }) => {
  const links = await serverLinks(request);
  expect(links.size).toBeGreaterThan(20);
  for (const link of links) {
    const route = parseRoute(link);
    expect(route.page, link).not.toBe('notfound');
    // A link to Runs with a filter opens that filter, and every link reads back as it was written.
    if (link.includes('?')) expect(runsLinkQuery(link), link).not.toBeNull();
    expect(routeHref(route), link).toBe(link);
  }
});

test('Runs keeps its filters in the address, Back goes back through them, and it has no serious axe violation', async ({ page }) => {
  await openPage(page, '/runs?types=recording&sort=calls', 'main#view table.runst tbody tr');
  const pressed = () => page.locator('main#view .tbar .chips button[aria-pressed="true"]');
  await expect(pressed()).toHaveCount(1);
  expect(await pressed().evaluate((b) => b.childNodes[0]?.textContent)).toBe('Recordings');
  await expect(page.locator('main#view th[aria-sort="descending"]')).toContainText('Calls');
  expect(await seriousViolations(page)).toEqual([]);
  // A chip is a step of its own: Back is the view before it.
  await page.locator('main#view .tbar .chips button', { hasText: /^All/ }).click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/runs?sort=calls');
  await page.goBack();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/runs?types=recording&sort=calls');
  expect(await pressed().evaluate((b) => b.childNodes[0]?.textContent)).toBe('Recordings');
  // The filter checks no spelling, and says how many runs its words match; Esc leaves it with its words kept, the
  // search field's own clear never taking them.
  const field = page.locator('main#view #runsQuery');
  await expect(field).toHaveAttribute('spellcheck', 'false');
  await expect(field).toHaveAttribute('placeholder', 'Filter: words, label:, status:, type: or tool:');
  await field.fill('type:recording');
  await expect(page.locator('main#view .rqw .qn[role="status"]')).toHaveText(/^\d[\d,]* runs? match(es)?$/);
  await page.keyboard.press('Escape');
  await expect(field).not.toBeFocused();
  await expect(field).toHaveValue('type:recording');
});

test('the good/bad key labels a run in one press, says so with Undo, and has no serious axe violation', async ({ page }) => {
  await openPage(page, `/run/${demoId('ticket')}`, 'run');
  const good = page.locator('.rhead .runkey button', { hasText: 'good' });
  await expect(good).toHaveAttribute('aria-pressed', 'false');
  await good.click();
  await expect(good).toHaveAttribute('aria-pressed', 'true');
  const undo = page.locator('.toast button', { hasText: 'Undo' });
  await expect(undo).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
  await undo.click();
  await expect(good).toHaveAttribute('aria-pressed', 'false');
  // On Runs, each row has the key, its buttons named for a screen reader.
  await openPage(page, '/runs', 'main#view table.runst tbody tr');
  const key = page.locator('main#view table.runst tbody tr').first().locator('td.keycell .runkey');
  await expect(key.locator('button')).toHaveCount(2);
  expect(await seriousViolations(page)).toEqual([]);
});

test('a run’s calls sit under the call they belong to, each fold mark announced, with no serious axe violation', async ({ page }) => {
  await openPage(page, `/run/${demoId('eval')}`, 'run');
  await page.waitForSelector('main#view table.calls.grouped button.tw');
  const fold = page.locator('main#view table.calls button.tw').first();
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
  const rows = await page.locator('main#view table.calls tbody tr[data-wi]').count();
  await fold.click();
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  expect(await page.locator('main#view table.calls tbody tr[data-wi]').count()).toBeLessThan(rows);
  expect(await seriousViolations(page)).toEqual([]);
  await page.locator('main#view .toolbar button', { hasText: 'Unfold all' }).click();
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
});

test('what a run did that Shadowlap did not record shows under its banner, with no serious axe violation', async ({ page }) => {
  // The eval's agent hands the policy check to a function it never wrapped: the model called it, and nothing recorded it.
  await openPage(page, `/run/${demoId('eval')}`, 'run');
  await page.waitForSelector('main#view .rnotes .rnote');
  await expect(page.locator('main#view .rnotes .rntools code').first()).toHaveText('check_policy');
  expect(await seriousViolations(page)).toEqual([]);
});

test('on a phone, what a run did that Shadowlap did not record wraps inside the page, its hint a sentence', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPage(page, `/run/${demoId('eval')}`, 'run');
  await page.waitForSelector('main#view .rnotes .rnhint');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  const past = await page.evaluate(() => [...document.querySelectorAll('main#view .rnotes *')].filter((el) => el.getClientRects().length && el.getBoundingClientRect().right > document.documentElement.clientWidth + 1).map((el) => el.className));
  expect(past).toEqual([]);
  // No line of the hint starts with its own punctuation: ". Or declare…" follows the code before it.
  const lineStart = await page.evaluate(() => {
    const hint = document.querySelector('main#view .rnhint')!;
    const walker = document.createTreeWalker(hint, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent?.startsWith('. Or')) continue;
      const r = document.createRange();
      r.setStart(n, 0);
      r.setEnd(n, 1);
      return r.getBoundingClientRect().left - hint.getBoundingClientRect().left;
    }
    return null;
  });
  expect(lineStart).not.toBeNull();
  expect(lineStart!).toBeGreaterThan(2);
});

test('the Request tab’s fold marks are 24 px tall at least, as WCAG 2.5.8 asks of a target', async ({ page }) => {
  await openPage(page, `/run/${demoId('override')}`, 'run');
  await page.locator('.insp [role="tablist"] button', { hasText: 'Request' }).click();
  await page.waitForSelector('.ibody details > summary');
  const heights = await page.locator('.ibody details > summary').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  expect(heights.length).toBeGreaterThan(0);
  for (const h of heights) expect(h).toBeGreaterThanOrEqual(24);
});

test('on a phone no label is under 11px, an avatar’s initials aside, and the floor that raises them lowers nothing', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const small: string[] = [];
  const pages: Array<[string, string]> = [
    ['/', 'main#view .ovg'],
    ['/runs', 'main#view table.runst tbody tr'],
    [`/run/${demoId('override')}`, 'run'],
    [`/fixes/${demoId('refundFix')}/blame`, 'fix'],
    ['/tests', 'main#view table.gt'],
  ];
  for (const [path, drawn] of pages) {
    await openPage(page, path, drawn);
    const found = await page.evaluate((where) => {
      const out: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>('body *')) {
        const s = getComputedStyle(el);
        if (el.closest('.av, .sr') || s.visibility === 'hidden' || !el.getClientRects().length) continue;
        const text = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
        if (text && parseFloat(s.fontSize) < 11) out.push(`${where}: ${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join('.')} “${el.textContent?.trim().slice(0, 30)}” at ${s.fontSize}`);
      }
      // The floor only raises: with its sizes taken out, no element is drawn larger than with them.
      const floor: CSSStyleRule[] = [];
      for (const sheet of document.styleSheets)
        for (const r of sheet.cssRules)
          if (r instanceof CSSMediaRule && r.conditionText.includes('max-width: 640px'))
            for (const x of r.cssRules) if (x instanceof CSSStyleRule && x.selectorText.startsWith(':is(#root, body)') && x.style.fontSize) floor.push(x);
      if (!floor.length) out.push(`${where}: no label floor in the stylesheet`);
      const raised = [...document.querySelectorAll<HTMLElement>('body *')].map((el) => ({ el, px: parseFloat(getComputedStyle(el).fontSize) }));
      const kept = floor.map((r) => ({ r, size: r.style.fontSize }));
      for (const r of floor) r.style.removeProperty('font-size');
      for (const { el, px } of raised) {
        const was = parseFloat(getComputedStyle(el).fontSize);
        if (px + 0.01 < was) out.push(`${where}: ${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join('.')} lowered from ${was}px to ${px}px`);
      }
      for (const { r, size } of kept) r.style.setProperty('font-size', size);
      return out;
    }, path);
    small.push(...found);
  }
  expect(small).toEqual([]);
});
