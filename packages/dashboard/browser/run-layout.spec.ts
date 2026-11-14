import { expect, test, type Page } from '@playwright/test';
import { demoId, openPage, patched, seriousViolations, sideways, startJob } from './dashboard.js';

/**
 * A run's strip and views as the design lays them out (ui/css/run.css, ui/run/fit-work.ts): the strip
 * on one row from 1281px, by kind on a recording, in ranges with notches where its calls don't fit;
 * a finding's diff in the inspector's place; the calls and the inspector side by side from 1160px,
 * the inspector under a fitted list from 1001px, the page scrolling under its strip; on a phone the
 * cells at the window's top and no sideways scroll; and the calls in reach under a docked job.
 */

/** Where a part of the page is drawn. */
const rect = (page: Page, selector: string) =>
  page.evaluate((s) => {
    const r = document.querySelector(s)!.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
  }, selector);

/** Where the first call row sits with the list at its top: the list's top under its head. */
const firstRow = (page: Page) =>
  page.evaluate(() => document.querySelector('#vbody')!.getBoundingClientRect().top + document.querySelector('#vbody table.calls thead')!.getBoundingClientRect().height);

/** The call rows drawn whole inside the calls list's box. */
const rowsInView = (page: Page) =>
  page.evaluate(() => {
    const box = document.querySelector('#vbody')!.getBoundingClientRect();
    return [...document.querySelectorAll('#vbody table.calls tbody tr[data-wi]')].filter((tr) => {
      const r = tr.getBoundingClientRect();
      return r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
    }).length;
  });

/** The strip's cells as drawn: their sizes, how many, and how many notches. */
const cells = (page: Page) =>
  page.evaluate(() => {
    const bs = [...document.querySelectorAll<HTMLElement>('.strip .cells button')].map((b) => b.getBoundingClientRect());
    return { n: bs.length, minW: Math.min(...bs.map((r) => r.width)), minH: Math.min(...bs.map((r) => r.height)), notches: document.querySelectorAll('.strip .cells button .tk').length, binned: !!document.querySelector('.strip .cells.binned') };
  });

test.describe('at 1440×900', () => {
  test('a recording’s strip is one row by kind, the batch in ranges of 6px or more with a notch at each rarer error', async ({ page }) => {
    await openPage(page, `/run/${demoId('ticket')}`, 'run');
    const [c, k, f] = [await rect(page, '.strip .cells'), await rect(page, '.strip .legend'), await rect(page, '.strip .filter-in')];
    const mid = (r: { top: number; height: number }) => r.top + r.height / 2;
    expect(Math.abs(mid(c) - mid(k))).toBeLessThan(12);
    expect(Math.abs(mid(c) - mid(f))).toBeLessThan(12);
    await expect(page.locator('.strip .cells button.k-model').first()).toBeVisible();
    await expect(page.locator('#olegend')).toContainText('every call live');
    // The design's first call row sat at 312px on its sample runs: these are this page's (the report has them).
    console.log(`first call row at 1440×900: ticket ${Math.round(await firstRow(page))}px`);
    await openPage(page, `/run/${demoId('batch')}`, 'run');
    const b = await cells(page);
    expect(b.binned).toBe(true);
    expect(b.minW).toBeGreaterThanOrEqual(5.9);
    expect(b.notches).toBeGreaterThan(0);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('the strip is one Tab stop whose arrows select at once, the address and the focus following, a range at a time where grouped', async ({ page }) => {
    const callIn = () => page.evaluate(() => Number(/\/run\/[^/]+\/(\d+)/.exec(location.hash)?.[1] ?? 0));
    const focusedOption = () => page.evaluate(() => [...document.querySelectorAll('.strip .cells [role="option"]')].indexOf(document.activeElement!));
    const stop = page.locator('.strip .cells [role="option"][tabindex="0"]');
    await openPage(page, `/run/${demoId('ticket')}`, 'run');
    await expect(stop).toHaveCount(1);
    await stop.focus();
    await page.keyboard.press('Home');
    await expect.poll(callIn).toBe(1);
    await page.keyboard.press('ArrowRight');
    await expect.poll(callIn).toBe(2);
    await expect.poll(focusedOption).toBe(1);
    await expect(page.locator('.strip .cells [role="option"]').nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowLeft');
    await expect.poll(callIn).toBe(1);
    await page.keyboard.press('End');
    await expect.poll(callIn).toBe(30);
    await expect.poll(focusedOption).toBe(29);
    await expect(stop).toHaveCount(1);
    // The batch's ranges: Home and → select a range's most notable call, a range at a time.
    await openPage(page, `/run/${demoId('batch')}`, 'run');
    await stop.focus();
    await page.keyboard.press('Home');
    await expect.poll(focusedOption).toBe(0);
    const first = await callIn();
    await page.keyboard.press('ArrowRight');
    await expect.poll(focusedOption).toBe(1);
    await expect(page.locator('.strip .cells [role="option"]').nth(1)).toHaveAttribute('aria-selected', 'true');
    const [, from, to] = /^Calls #([\d,]+) to #([\d,]+)/.exec((await page.evaluate(() => document.activeElement!.getAttribute('aria-label')))!)!;
    const n = await callIn();
    expect(n).toBeGreaterThan(first);
    expect(n).toBeGreaterThanOrEqual(Number(from!.replace(/,/g, '')));
    expect(n).toBeLessThanOrEqual(Number(to!.replace(/,/g, '')));
  });

  test('Show diff opens in the inspector’s place, the first call row unmoved, until Hide, a pick or Esc gives the inspector back', async ({ page }) => {
    await openPage(page, `/run/${demoId('override')}`, 'run');
    const toggle = page.locator('#view [data-act="diff"]');
    const before = await firstRow(page);
    console.log(`first call row at 1440×900: override ${Math.round(before)}px`);
    await toggle.click();
    const panel = page.locator('#insp.fpanel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.fhead .ct')).toHaveText(/^Diff at #\d+$/);
    await expect(panel.locator('.diffpanel')).toBeVisible();
    await expect(toggle).toHaveText('Hide diff');
    expect(Math.abs((await firstRow(page)) - before)).toBeLessThan(1);
    expect(await seriousViolations(page)).toEqual([]);
    // Hide in its head: the inspector back, the focus on the finding's toggle.
    await panel.locator('.fhead button').click();
    await expect(page.locator('#insp.fpanel')).toHaveCount(0);
    await expect(page.locator('#insp #ibody[role="tabpanel"]')).toBeVisible();
    await expect(toggle).toBeFocused();
    // A click on the selected call's row gives it back too.
    await toggle.click();
    await expect(panel).toBeVisible();
    await page.locator('#vbody tr[aria-selected="true"]').click();
    await expect(page.locator('#insp.fpanel')).toHaveCount(0);
    // A key from 1 to 4 picks an inspector's tab, and so gives it back.
    await toggle.click();
    await expect(panel).toBeVisible();
    await page.locator('main#view').focus();
    await page.keyboard.press('2');
    await expect(page.locator('#insp.fpanel')).toHaveCount(0);
    await expect(page.locator('#itab-response')).toHaveAttribute('aria-selected', 'true');
    // Esc from inside it.
    await toggle.click();
    await panel.locator('.fhead button').focus();
    await page.keyboard.press('Escape');
    await expect(page.locator('#insp.fpanel')).toHaveCount(0);
    await expect(toggle).toBeFocused();
  });
});

test('at 1180×800 the calls and the inspector sit side by side, the inspector 360px at least, eight rows or more in view', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 800 });
  await openPage(page, `/run/${demoId('ticket')}`, 'run');
  const [views, insp] = [await rect(page, '.work > .views'), await rect(page, '#insp')];
  expect(Math.abs(views.top - insp.top)).toBeLessThan(2);
  expect(insp.width).toBeGreaterThanOrEqual(360);
  expect(await rowsInView(page)).toBeGreaterThanOrEqual(8);
  // The view tabs keep inside the calls' column; the key and the field go under the cells.
  const tabs = await page.evaluate(() => {
    const t = document.querySelector<HTMLElement>('.views > .tabs')!;
    return { over: t.scrollWidth - t.clientWidth, last: [...t.querySelectorAll('button')].at(-1)!.getBoundingClientRect().right };
  });
  expect(tabs.over).toBeLessThanOrEqual(0);
  expect(tabs.last).toBeLessThanOrEqual(views.right);
  expect((await rect(page, '.strip .legend')).top).toBeGreaterThanOrEqual((await rect(page, '.strip .cells')).bottom);
  expect(await sideways(page)).toBeLessThanOrEqual(0);
  expect(await seriousViolations(page)).toEqual([]);
});

test('at 1050×800 the inspector sits under a list fitted to show its head, the page scrolling under its strip, a row picked bringing it into view', async ({ page }) => {
  await page.setViewportSize({ width: 1050, height: 800 });
  await openPage(page, `/run/${demoId('ticket')}`, 'run');
  const list = await rect(page, '#vbody');
  expect(list.height).toBeGreaterThanOrEqual(239);
  expect(list.height).toBeLessThanOrEqual(401);
  expect((await rect(page, '#insp')).top).toBeGreaterThanOrEqual((await rect(page, '.work > .views')).bottom - 1);
  // The inspector's head shows as the page opens.
  expect((await rect(page, '#insp .ihead')).top).toBeLessThan(800);
  expect(await page.locator('.rv').evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  // A row picked brings the inspector into view under the strip: its top within 60% of the window, or,
  // a short call's inspector, the page scrolled to its end with the inspector whole above it.
  await page.locator('#vbody table.calls tbody tr[data-wi]').nth(2).click();
  const inView = () =>
    page.evaluate(() => {
      const rv = document.querySelector('.rv')!;
      const insp = document.querySelector('#insp')!.getBoundingClientRect();
      const end = rv.scrollTop > 0 && rv.scrollTop + rv.clientHeight >= rv.scrollHeight - 1 && insp.bottom <= rv.getBoundingClientRect().bottom + 1;
      return insp.top >= document.querySelector('.strip')!.getBoundingClientRect().bottom - 1 && (insp.top < innerHeight * 0.6 || end);
    });
  await expect.poll(inView).toBe(true);
  // A model call's taller inspector comes up under the strip.
  await page.locator('#vbody table.calls tbody tr[data-wi]').first().click();
  await expect.poll(async () => (await rect(page, '#insp')).top).toBeLessThan(800 * 0.6);
  // Scrolled, the strip stays at the top of the run page.
  await page.locator('.rv').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect.poll(async () => Math.abs((await rect(page, '.strip')).top - (await rect(page, '.rv')).top)).toBeLessThan(1);
  expect(await sideways(page)).toBeLessThanOrEqual(0);
  expect(await seriousViolations(page)).toEqual([]);
});

test('at 1050×800 a long run’s list scrolled away from its call stays where it was left while the rest of its pages come', async ({ page }) => {
  await page.setViewportSize({ width: 1050, height: 800 });
  await openPage(page, `/run/${demoId('batch')}`, 'run');
  await page.locator('#vbody').evaluate((el) => el.scrollTo(0, 0));
  await expect(page.locator('main#view .toolbar')).toHaveCount(0, { timeout: 30_000 });
  expect(await page.locator('#vbody').evaluate((el) => el.scrollTop)).toBeLessThan(3);
});

test.describe('on a 390px phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the cells are 24px at least to a finger, the key and the field under them, and they stay at the window’s top', async ({ page }) => {
    await openPage(page, `/run/${demoId('batch')}`, 'run');
    const b = await cells(page);
    expect(b.n).toBe(14);
    expect(b.minW).toBeGreaterThanOrEqual(23.9);
    expect(b.minH).toBeGreaterThanOrEqual(23.9);
    expect((await rect(page, '.strip .legend')).top).toBeGreaterThanOrEqual((await rect(page, '.strip .cells')).bottom);
    expect((await rect(page, '.strip .filter-in')).top).toBeGreaterThanOrEqual((await rect(page, '.strip .legend')).bottom);
    await page.evaluate(() => window.scrollBy(0, 900));
    await expect.poll(async () => Math.round((await rect(page, '.strip .cells')).top)).toBeLessThanOrEqual(0);
    for (const name of ['batch', 'ticket', 'override']) {
      await openPage(page, `/run/${demoId(name)}`, 'run');
      expect(await sideways(page), name).toBeLessThanOrEqual(0);
    }
    expect(await seriousViolations(page)).toEqual([]);
  });
});

test('the key’s rows are balanced again as the window narrows or widens, as a page opened at that width balances them', async ({ page }) => {
  // Up to 1000px the strip around the key draws no box of its own: the run page's width is its room.
  const key = () => page.evaluate(() => document.querySelector<HTMLElement>('#olegend')!.style.maxWidth);
  for (const name of ['override', 'ticket']) {
    const opened = new Map<number, string>();
    for (const width of [360, 900]) {
      await page.setViewportSize({ width, height: 800 });
      // A page loaded anew at that width: an address that differs only in its hash would stay in the page.
      await page.goto('about:blank');
      await openPage(page, `/run/${demoId(name)}`, 'run');
      opened.set(width, await key());
    }
    expect(opened.get(360), `${name}: its rows wrap at 360px and are balanced`).toMatch(/^\d+px$/);
    expect(opened.get(900), `${name}: fewer rows at 900px`).not.toBe(opened.get(360));
    for (const width of [360, 900]) {
      await page.setViewportSize({ width, height: 800 });
      await expect.poll(key, `${name} at ${width}px`).toBe(opened.get(width));
    }
  }
});

test('at 320×700 nothing scrolls sideways, the inspector’s tabs fitting or scrolling in their own row', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  for (const name of ['ticket', 'override', 'batch']) {
    await openPage(page, `/run/${demoId(name)}`, 'run');
    expect(await sideways(page), name).toBeLessThanOrEqual(0);
    const tabs = await rect(page, '#insp .tabs');
    expect(tabs.right, name).toBeLessThanOrEqual(320);
  }
  expect(await seriousViolations(page)).toEqual([]);
});

for (const [width, height] of [
  [1280, 720],
  [1440, 700],
] as const) {
  test(`at ${width}×${height} under a job’s log the run page scrolls to four rows of calls above the drawer`, async ({ page }) => {
    const { end } = await startJob(page);
    await page.setViewportSize({ width, height });
    const rv = page.locator('.rv');
    await expect.poll(() => rv.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await rv.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    // The list at its top, the rows whole between its sticky head and the drawer: centred on the
    // selected call, the list would cut a row at each end.
    await page.locator('#vbody').evaluate((el) => el.scrollTo(0, 0));
    const shown = await page.evaluate(() => {
      const top = document.querySelector('section.drawer')!.getBoundingClientRect().top;
      const box = document.querySelector('#vbody')!.getBoundingClientRect();
      const head = document.querySelector('#vbody table.calls thead')!.getBoundingClientRect().bottom;
      return [...document.querySelectorAll('#vbody table.calls tbody tr[data-wi]')].filter((tr) => {
        const r = tr.getBoundingClientRect();
        return r.top >= head - 1 && r.bottom <= Math.min(top, box.bottom) + 1;
      }).length;
    });
    expect(shown).toBeGreaterThanOrEqual(4);
    if (width === 1440) {
      expect((await rect(page, '.work')).height).toBeGreaterThanOrEqual(239);
      // Its log folded away as it ends, the views keep their 420px.
      end(['✓ Replay clean: 30/30 calls replayed']);
      await expect(page.locator('section.drawer.folded')).toBeVisible({ timeout: 4000 });
      await expect.poll(async () => (await rect(page, '.work')).height).toBeGreaterThanOrEqual(419);
    }
    expect(await sideways(page)).toBeLessThanOrEqual(0);
  });
}

test('in a forced-colours theme the notch is drawn in the text colour and the key’s pick is underlined', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await openPage(page, `/run/${demoId('batch')}`, 'run');
  expect(await page.locator('.strip .cells button .tk').first().evaluate((el) => getComputedStyle(el).forcedColorAdjust)).toBe('none');
  const chip = page.locator('#olegend button').nth(1);
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  expect(await chip.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe('underline');
  // Not axe's contrast here: it reads -webkit-text-fill-color, which Chrome leaves at the colour the
  // stylesheet gives where it paints the system's, so the lime button's dark words would read as dark
  // on the forced black. Its contrast is checked in the page's own colours above.
  expect((await seriousViolations(page)).filter((v) => !v.startsWith('color-contrast '))).toEqual([]);
});

test('a replayed call that ended in an error is drawn failed in Calls, as Runs’ strip codes it', async ({ page }) => {
  // The demo's clean replay, its fifth call a recorded error served again, as a replay serves one (the sidecar's serveReplayedTool).
  const id = demoId('clean');
  await page.route(new RegExp(`/api/runs/${id}(\\?.*)?$`), (route) =>
    patched<{ calls: Array<{ callNo: number; origin: string; outcome: string | null; error: string | null }> }>(route, (d) => ({ ...d, calls: d.calls.map((c) => (c.callNo === 5 ? { ...c, outcome: 'error', error: 'TimeoutError: the order service timed out' } : c)) })),
  );
  await openPage(page, `/run/${id}/5`, 'main#view table.calls tbody tr[data-wi]');
  const row = page.locator('main#view table.calls tbody tr[aria-selected="true"]');
  await expect(row.locator('td').first()).toHaveText('5');
  await expect(row.locator('.orgw')).toHaveText('failed');
});
