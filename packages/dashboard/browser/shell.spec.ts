import { expect, test, type Page } from '@playwright/test';
import { dash, demoId, expectAccessible, openPage, patched } from './dashboard.js';

// The shell: the sidebar, the top bar, the status bar and the palette, as every page shows them.

test('a fresh dashboard’s palette finds the actions and the tests of pages not opened yet', async ({ page }) => {
  // The Overview alone: no page that adds to the palette has loaded its code.
  await openPage(page, '/', 'overview');
  await page.keyboard.press('Meta+k');
  const palette = page.locator('.palette');
  await expect(palette).toBeVisible();
  const field = palette.locator('input');
  // An action of Runs' and one of Settings'.
  await field.fill('Import capture');
  await expect(palette.locator('.palit', { hasText: 'Import capture…' })).toBeVisible();
  await field.fill('Calibrate');
  await expect(palette.locator('.palit .pl', { hasText: /^Calibrate$/ })).toBeVisible();
  // A golden, under Tests.
  await field.fill('refund-in-limit');
  await expect(palette.locator('.palg', { hasText: /^Tests$/ })).toBeVisible();
});

/** The status bar's parts that show, by the key their class names. */
const shownParts = (page: Page) =>
  page.locator('footer.status > span:not(.sep):not(.sp)').evaluateAll((els) => els.filter((el) => getComputedStyle(el).display !== 'none').map((el) => [...el.classList].find((c) => c.startsWith('st-')) ?? el.getAttribute('class') ?? ''));

/**
 * The status bar fits its width with whole parts: what gave way is the first of the version, where
 * it runs and the store, in that order, and the runs stay. How many go depends on the store's path,
 * which is the demo's folder.
 */
async function expectGivenWay(page: Page): Promise<string[]> {
  const bar = page.locator('footer.status');
  expect(await bar.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  const shown = await shownParts(page);
  expect(shown).toContain('st-runs');
  const order = ['st-ver', 'st-where', 'st-store'];
  const gone = order.filter((k) => !shown.includes(k));
  expect(order.slice(0, gone.length)).toEqual(gone);
  expect(await bar.locator('> span:not(.sep):not(.sp)').evaluateAll((els) => els.filter((el) => getComputedStyle(el).display !== 'none').every((el) => el.scrollWidth <= el.clientWidth + 1))).toBe(true);
  return gone;
}

test('on a laptop the sidebar holds the project, the pages, Recent runs and Settings, the top bar search and Help, and the status bar its parts', async ({ page }) => {
  await openPage(page, '/', 'overview');
  // The pages: the loop, a hairline, then the tools; Settings at the sidebar's foot.
  const pages = page.getByRole('navigation', { name: 'Sections' });
  await expect(pages.getByRole('link')).toHaveText([/^Overview/, /^Runs\s*\d/, /^Changes/, /^Fixes/, /^Tests/, /^Training/]);
  expect(await pages.locator('hr').evaluate((hr) => [hr.previousElementSibling?.textContent, hr.nextElementSibling?.textContent])).toEqual([expect.stringMatching(/^Tests/), expect.stringMatching(/^Training/)]);
  await expect(page.getByRole('navigation', { name: 'Project settings' }).getByRole('link')).toHaveText(['Settings']);
  // Recent runs: two lines a run, 52px tall, and eight of them whole at 1440×900, the search being in the top bar.
  const rows = await page.locator('#side .runs a.run').evaluateAll((els) => {
    const box = document.querySelector('#side .runs')!.getBoundingClientRect();
    const whole = els.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5;
    });
    return { heights: [...new Set(whole.map((el) => Math.round(el.getBoundingClientRect().height)))], whole: whole.length };
  });
  expect(rows).toEqual({ heights: [52], whole: 8 });
  // Search sits in the top bar, 248px wide, saying its key; the sidebar's top is the project alone.
  const search = page.locator('.top .search.sbtn');
  expect((await search.boundingBox())!.width).toBe(248);
  await expect(search.locator('.st')).toBeVisible();
  await expect(search).toHaveAttribute('aria-keyshortcuts', 'Meta+K Control+K');
  await expect(page.locator('#side .search')).toHaveCount(0);
  // Help: the shortcuts, the docs and the command line.
  await page.getByRole('button', { name: 'Help' }).click();
  await expect(page.getByRole('menuitem')).toHaveText([/^Keyboard shortcuts/, /^Docs/, /^Command line/]);
  await expectAccessible(page);
  await page.keyboard.press('Escape');
  // The status bar: the store's path and the address as code, and no connection part while the server answers.
  await expectGivenWay(page);
  await expect(page.locator('footer.status span.st-store')).toBeVisible();
  await expect(page.locator('footer.status .st-store code')).toHaveCount(1);
  // Where it runs: its address, or the team store it syncs with, as the demo's project has one, by its name.
  await expect(page.locator('footer.status span.st-where')).toHaveText(new RegExp(`^(${new URL(dash().origin).host.replace(/\./g, '\\.')} · local only|store \\S+ · (synced .+|setting up|not synced yet))$`));
  await expect(page.locator('footer.status .st-where code')).toHaveCount(1);
  await expect(page.locator('footer.status span.st-sync')).toHaveCount(0);
});

test('Tab goes from the crumbs to Search or jump to and Help, before the sidebar', async ({ page }) => {
  await openPage(page, `/run/${demoId('override')}`, 'run');
  await page.locator('body').focus();
  const seen: string[] = [];
  for (let n = 0; n < 30 && !seen.some((s) => s.startsWith('#side')); n++) {
    await page.keyboard.press('Tab');
    seen.push(await page.evaluate(() => (document.activeElement?.closest('#side') ? '#side ' : '') + (document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? '').trim()));
  }
  const at = (s: string) => seen.findIndex((x) => x.startsWith(s));
  expect(at('Search or jump to'), seen.join(' | ')).toBeGreaterThan(-1);
  expect(at('Search or jump to')).toBeLessThan(at('Help'));
  expect(at('Help')).toBeLessThan(seen.findIndex((x) => x.startsWith('#side')));
});

test('the parent’s crumb says p on its card, and p opens it', async ({ page }) => {
  const fork = demoId('override');
  await openPage(page, `/run/${fork}`, 'run');
  const parent = page.locator('.crumbs a[data-tip]');
  await expect(parent).toHaveCount(1);
  await parent.focus();
  const tip = page.locator('#tip');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('Open parent run');
  await expect(tip.locator('.kbd')).toHaveText('p');
  const to = await parent.getAttribute('href');
  await page.locator('main#view h1').first().focus();
  await page.keyboard.press('p');
  // The parent's page, at the call it opens on.
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(new RegExp(`^${to!}(/\\d+)?$`));
});

test('Recent runs draws a run made from an attempt it leaves out under the run that attempt came from, as the server nests it', async ({ page }) => {
  // The demo's override fork, as the server lists a run made from one of its recording's attempts:
  // its parent, the attempt, is left out, and the row comes a level in under the recording.
  const fork = demoId('override');
  await page.route(/\/api\/runs(\?.*)?$/, (route) => patched<{ runs: Array<{ runId: string; parentRunId: string | null }> }>(route, (d) => ({ ...d, runs: d.runs.map((r) => (r.runId === fork ? { ...r, parentRunId: '01M5GRZZZZZZZZZZZZZZZZZZZZ' } : r)) })));
  await openPage(page, '/', 'overview');
  const row = page.locator(`#side #runs a.run[data-rowkey="#/run/${fork}"]`);
  await expect(row).toHaveAttribute('style', /--d:\s*1\b/);
});

test('Recent runs folds at its caret, and the browser keeps it folded', async ({ page }) => {
  await openPage(page, '/', 'overview');
  const caret = page.locator('#side .skt');
  await expect(caret).toHaveAttribute('aria-expanded', 'true');
  await caret.click();
  await expect(caret).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#side #runs')).toBeHidden();
  await page.reload();
  await page.waitForSelector('main#view .ov, main#view .ph', { state: 'visible' });
  await expect(page.locator('#side .skt')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#side #runs')).toBeHidden();
  await page.locator('#side .skt').click();
  await expect(page.locator('#side #runs')).toBeVisible();
});

test.describe('at 1000px', () => {
  test.use({ viewport: { width: 1000, height: 800 } });

  test('Search or jump to is its icon alone, and the sidebar a drawer', async ({ page }) => {
    await openPage(page, '/', 'overview');
    const search = page.locator('.top .search.sbtn');
    expect((await search.boundingBox())!.width).toBe(32);
    await expect(search.locator('.st')).toBeHidden();
    await expect(page.locator('.top .menu-toggle')).toBeVisible();
    await expect(page.locator('#side')).toBeHidden();
    await expectAccessible(page);
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the open sidebar takes the focus and puts the page and the status bar out of reach; Esc, a click beside it, ⌘K or a link closes it; the crumbs are left out, and no word in the status bar is cut', async ({ page }) => {
    await openPage(page, `/run/${demoId('override')}`, 'run');
    await expect(page.locator('.top .crumbs')).toBeHidden();
    await expectGivenWay(page);
    const toggle = page.locator('.top .menu-toggle');
    const side = page.locator('#side');
    /** Opens the drawer from Menu: its first item, the project switcher, has the focus. */
    const open = async () => {
      await toggle.click();
      await expect(side).toBeVisible();
      await expect(side.locator('.proj')).toBeFocused();
    };
    await open();
    await expect(page.locator('main#view')).toHaveAttribute('inert', '');
    await expect(page.locator('footer.status')).toHaveAttribute('inert', '');
    await expectAccessible(page);
    await page.keyboard.press('Escape');
    await expect(side).toBeHidden();
    await expect(page.locator('main#view')).not.toHaveAttribute('inert', '');
    await expect(page.locator('footer.status')).not.toHaveAttribute('inert', '');
    await expect(toggle).toBeFocused();
    // A click beside it closes it, the focus back on Menu.
    await open();
    await page.mouse.click(360, 500);
    await expect(side).toBeHidden();
    await expect(toggle).toBeFocused();
    // ⌘K from a run in it closes it; once the palette closes, the focus goes to Menu, the run being out of sight.
    await open();
    await side.locator('a.run').first().focus();
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.locator('.palette')).toBeVisible();
    await expect(side).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.locator('.palette')).toBeHidden();
    await expect(toggle).toBeFocused();
    // A link in it closes it as it goes.
    await open();
    await side.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: /^Runs/ }).click();
    await expect(side).toBeHidden();
    await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#\/runs/);
  });
});

test.describe('at 320px', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test('the status bar’s parts give way whole, in order, and the palette’s field says Search or jump to', async ({ page }) => {
    await openPage(page, '/', 'overview');
    expect(await expectGivenWay(page)).toEqual(['st-ver', 'st-where', 'st-store']);
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.locator('.palin input')).toHaveAttribute('placeholder', 'Search or jump to');
    await expectAccessible(page);
  });
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test('Help leaves out Keyboard shortcuts, its focus starting on Docs, and the palette’s field says Search or jump to', async ({ page }) => {
    await openPage(page, '/', 'overview');
    await page.getByRole('button', { name: 'Help' }).tap();
    await expect(page.getByRole('menuitem')).toHaveText([/^Docs/, /^Command line/]);
    await expect(page.getByRole('menuitem', { name: /^Docs/ })).toBeFocused();
    await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.locator('.palin input')).toHaveAttribute('placeholder', 'Search or jump to');
  });
});

test('offline, the status bar says so, and the palette says it once under its field, a job’s row kept with its hint and paused', async ({ page }) => {
  await openPage(page, '/', 'overview');
  await page.route('**/api/**', (route) => route.abort());
  await page.waitForSelector('.connbar', { state: 'visible', timeout: 30_000 });
  await expect(page.locator('footer.status .st-sync')).toHaveText('offline');
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator('.paloff')).toHaveText('Offline: actions paused until the dashboard server is back.');
  await expect(page.locator('.palin input')).toHaveAttribute('aria-describedby', 'palOff');
  const tests = page.locator('.palit', { hasText: 'Run tests' });
  await expect(tests.locator('.paltag')).toHaveText('paused');
  await expect(tests.locator('.ph2')).toContainText('shadowlap test');
  await page.unroute('**/api/**');
});
