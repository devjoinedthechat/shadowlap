import { expect, test } from '@playwright/test';
import { glued, openPage, seriousViolations } from './dashboard.js';

/**
 * Runs as the design draws it, in a real browser: the twelve weeks a slim row of days that a drag
 * picks from, Calendar opening the grid in its place and Hide calendar bringing the row back with
 * the focus on its button; on a phone a bar a week; and days in a link that run past the twelve
 * weeks kept to the days inside, the address saying so. No serious axe violation in either, with
 * days picked, or with the bulk bar up.
 */

const hash = (page: import('@playwright/test').Page) => page.evaluate(() => location.hash);

test('the months under the row start at its first bar, and the first gives way only where the next runs into it', async ({ page }) => {
  const spans = 'main#view section.cal.hist .hmon span';
  const boxes = () => page.locator(`${spans}:visible`).evaluateAll((els) => els.map((e) => [e.getBoundingClientRect().left, e.getBoundingClientRect().right] as const));
  for (const width of [1440, 1001, 800]) {
    await page.setViewportSize({ width, height: 900 });
    await openPage(page, '/runs', 'main#view section.cal.hist .hbars button');
    const shown = await boxes();
    for (let i = 1; i < shown.length; i++) expect(shown[i]![0]).toBeGreaterThanOrEqual(shown[i - 1]![1]);
    const bar = (await page.locator('main#view section.cal.hist .hbars').boundingBox())!;
    expect(shown[0]![0] - bar.x).toBeLessThan(32);
  }
  // Moved under the first, the next name crowds it, and the row drops the first as its width changes.
  await page.locator(spans).nth(1).evaluate((e) => ((e as HTMLElement).style.left = '0.5%'));
  await page.setViewportSize({ width: 801, height: 900 });
  await expect(page.locator(spans).first()).toBeHidden();
});

test('the twelve weeks are a row of days a drag picks from, and Calendar opens the grid until Hide calendar', async ({ page }) => {
  await openPage(page, '/runs', 'main#view table.runst tbody tr');
  const row = page.locator('main#view section.cal.hist');
  await expect(row).toHaveAttribute('aria-label', 'Runs per day, last 12 weeks');
  const bars = row.locator('.hbars button.cd.hb');
  const n = await bars.count();
  expect(n).toBeGreaterThan(77);
  // The row keeps to its 32px, the table close under the chips.
  expect((await row.locator('.hbars').boundingBox())?.height).toBe(32);
  expect(await seriousViolations(page)).toEqual([]);
  // A drag across three days picks them: the address says which, and the sentence says how many.
  const a = (await bars.nth(n - 3).boundingBox())!;
  const b = (await bars.nth(n - 1).boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => hash(page)).toMatch(/^#\/runs\?from=\d{4}-\d\d-\d\d&to=\d{4}-\d\d-\d\d$/);
  await expect(row.locator('.hbars button[aria-pressed="true"]')).toHaveCount(3);
  await expect(row.locator('.hsum')).toHaveText(glued(/^\d[\d,]* (run|runs) from \w{3} \d+ to \w{3} \d+(, \d[\d,]* failed)?\.$/));
  await expect(row.locator('.hact button', { hasText: 'Clear' })).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
  // Calendar shows the grid in the row's place, its own button in focus; Hide calendar brings the row back.
  await row.locator('.hact button', { hasText: 'Calendar' }).click();
  const grid = page.locator('main#view section.cal:not(.hist)');
  await expect(grid.locator('.calgrid')).toHaveAttribute('aria-label', 'Days, a column per week');
  await expect(grid.locator('.calside > button')).toBeFocused();
  await expect(grid.locator('.calgrid button[aria-pressed="true"]')).toHaveCount(3);
  expect(await seriousViolations(page)).toEqual([]);
  await page.keyboard.press('Enter');
  await expect(row.locator('.hact button', { hasText: 'Calendar' })).toBeFocused();
  await expect(row.locator('.hact button', { hasText: 'Calendar' })).toHaveAttribute('aria-expanded', 'false');
});

test('days in a link that run past the twelve weeks keep to the days inside, and days wholly outside them are let go', async ({ page }) => {
  await openPage(page, '/runs?from=2020-01-01&to=2099-01-01', 'main#view section.cal.hist .hbars button');
  const bars = page.locator('main#view section.cal.hist .hbars button.cd.hb');
  await expect.poll(() => hash(page)).not.toContain('2020-01-01');
  expect(await hash(page)).not.toContain('2099-01-01');
  expect(await bars.count()).toBeGreaterThan(77);
  await expect(page.locator('main#view section.cal.hist .hbars button.cd.hb[aria-pressed="false"]')).toHaveCount(0);
  await page.evaluate(() => (location.hash = '#/runs?from=2020-01-01&to=2020-02-01'));
  await expect.poll(() => hash(page)).toBe('#/runs');
  await expect(page.locator('main#view section.cal.hist .hbars button[aria-pressed="true"]')).toHaveCount(0);
});

test('x picks a row and the bar comes; Delete takes the run off the table and the nav at once, and Undo puts it back', async ({ page }) => {
  await openPage(page, '/runs', 'main#view table.runst tbody tr');
  const nav = page.locator('nav.navlist a[href="#/runs"]');
  const before = await nav.textContent();
  const row = page.locator('main#view table.runst tbody tr:not(.wspace)').first();
  const link = (await row.locator('a.rowa').getAttribute('href'))!;
  await row.locator('a.rowa').focus();
  await page.keyboard.press('x');
  const bar = page.locator('.bulkbar');
  await expect(bar.locator('b')).toHaveText('1 selected');
  expect(await bar.locator('button').allTextContents()).toEqual(expect.arrayContaining(['Add label…', 'Export dataset…', 'Compare', 'Delete 1 run', 'Clear selection']));
  expect(await seriousViolations(page)).toEqual([]);
  await bar.locator('button', { hasText: 'Delete 1 run' }).click();
  await page.locator('.dialog button', { hasText: /^Delete run$/ }).click();
  await expect(page.locator(`main#view table.runst a.rowa[href="${link}"]`)).toHaveCount(0);
  await expect(nav).not.toHaveText(before!);
  const toast = page.locator('.toast');
  await expect(toast).toContainText('Deleted');
  await toast.locator('button', { hasText: 'Undo' }).click();
  await expect(page.locator(`main#view table.runst a.rowa[href="${link}"]`)).toHaveCount(1);
  await expect(nav).toHaveText(before!);
  await expect(page.locator('.toast')).toContainText('Restored');
});

test('with Push and Preview change both on the bar every action stays in view: on one line from 921 px, and wrapped under the count below, at 721 px too', async ({ page }) => {
  // A team store as this machine would know one, so the bar offers Push too.
  const url = 's3://northwind-agent-runs/support-agent';
  const store = { url, key: url, configured: url, provider: 's3', providerName: 'Amazon S3', bucket: 'northwind-agent-runs', prefix: 'support-agent', account: null, region: null, name: 'northwind-agent-runs/support-agent', pushedAt: null, pulledAt: null, syncedAt: null, inStore: 0, onlyLocal: 0, localRuns: [], localAttempts: 0, queued: 0, check: null };
  await page.route('**/api/store', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { store, you: 'maya@example.com' } }) : route.continue()));
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPage(page, '/runs', 'main#view table.runst tbody tr');
  const row = page.locator('main#view table.runst tbody tr:not(.wspace)').first();
  await row.locator('a.rowa').focus();
  await page.keyboard.press('x');
  const bar = page.locator('.bulkbar');
  await expect(bar.locator('button', { hasText: /^Push/ })).toBeVisible();
  await expect(bar.locator('button', { hasText: 'Preview change' })).toBeVisible();
  // Every action whole inside the bar, with nothing to scroll to: one line wide, wrapped under the count when narrower.
  const reach = () => bar.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const inView = [...el.querySelectorAll('button')].every((b) => {
      const r = b.getBoundingClientRect();
      return r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.right <= innerWidth;
    });
    return { wrap: getComputedStyle(el).flexWrap, fits: el.scrollWidth <= el.clientWidth, inView };
  });
  expect(await reach()).toEqual({ wrap: 'nowrap', fits: true, inView: true });
  await page.setViewportSize({ width: 921, height: 900 });
  await expect.poll(reach).toEqual({ wrap: 'nowrap', fits: true, inView: true });
  await page.setViewportSize({ width: 721, height: 900 });
  await expect.poll(reach).toEqual({ wrap: 'wrap', fits: true, inView: true });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the twelve weeks are a bar a week, which picks its seven days, with no serious axe violation', async ({ page }) => {
    await openPage(page, '/runs', 'main#view section.cal.hist .hbars button');
    const row = page.locator('main#view section.cal.hist');
    await expect(row).toHaveAttribute('aria-label', 'Runs per week, last 12 weeks');
    const bars = row.locator('.hbars button.cd.hb');
    await expect(bars).toHaveCount(12);
    const box = (await bars.nth(10).boundingBox())!;
    expect(box.width).toBeGreaterThan(20);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect(await seriousViolations(page)).toEqual([]);
    await bars.nth(10).click();
    await expect.poll(() => hash(page)).toMatch(/from=\d{4}-\d\d-\d\d&to=\d{4}-\d\d-\d\d/);
    const [, from, to] = /from=([\d-]+)&to=([\d-]+)/.exec(await hash(page))!;
    expect((Date.parse(to!) - Date.parse(from!)) / 86_400_000).toBe(6);
  });
});

test('Enter makes the words a step that Back undoes with them; the nav’s Runs opens the last view where its list was left, and all every run', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 560 });
  await openPage(page, '/runs?types=recording', 'main#view table.runst tbody tr');
  const field = page.locator('main#view #runsQuery');
  await field.fill('ticket');
  await expect.poll(() => hash(page)).toBe('#/runs?q=ticket&types=recording');
  await field.press('Enter');
  await page.goBack();
  await expect.poll(() => hash(page)).toBe('#/runs?types=recording');
  await expect(field).toHaveValue('');
  await page.goForward();
  await expect(field).toHaveValue('ticket');
  // Every run, scrolled down, then a run opened from it.
  await page.locator('main#view .tbar .chips button', { hasText: /^All/ }).click();
  await expect.poll(() => hash(page)).toBe('#/runs?q=ticket');
  await field.fill('');
  await expect.poll(() => hash(page)).toBe('#/runs');
  await page.locator('main#view .tbar .chips button', { hasText: /^Recordings/ }).click();
  await expect.poll(() => hash(page)).toBe('#/runs?types=recording');
  const pane = page.locator('main#view .page');
  const y = await pane.evaluate((el) => {
    el.scrollTop = 240;
    return el.scrollTop;
  });
  expect(y).toBeGreaterThan(100);
  await page.locator('main#view table.runst tbody tr a.rowa').nth(4).click();
  await expect.poll(() => hash(page)).toMatch(/^#\/run\//);
  // The nav's Runs: the view it showed, where it was.
  const nav = page.locator('nav.navlist[aria-label="Sections"] a', { hasText: 'Runs' });
  await expect(nav).toHaveAttribute('href', '#/runs?types=recording');
  await nav.click();
  await expect.poll(() => hash(page)).toBe('#/runs?types=recording');
  await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBe(y);
  // The sidebar's all: every run.
  await page.locator('.side-k a', { hasText: 'all' }).click();
  await expect.poll(() => hash(page)).toBe('#/runs');
  await expect(page.locator('main#view .tbar .chips button[aria-pressed="true"]')).toHaveText(/^All/);
});

test('a view a chip commits stays where the reader scrolls as its rows come, not where the page was as it was committed', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 560 });
  await openPage(page, '/runs?types=recording', 'main#view table.runst tbody tr');
  const rows = page.locator('main#view table.runst tbody tr');
  const pane = page.locator('main#view .page');
  // Every run's rows held until the reader has scrolled.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(/\/api\/runs\/page\?(?!.*types=)/, async (route) => {
    await held;
    await route.continue();
  });
  await page.locator('main#view .tbar .chips button', { hasText: /^All/ }).click();
  await expect.poll(() => hash(page)).toBe('#/runs');
  const before = await rows.count();
  const y = await pane.evaluate((el) => {
    el.scrollTop = 200;
    return el.scrollTop;
  });
  expect(y).toBe(200);
  release();
  await expect.poll(() => rows.count()).toBeGreaterThan(before);
  // A place given back comes as the rows land and again a tick later.
  await page.waitForTimeout(300);
  expect(await pane.evaluate((el) => el.scrollTop)).toBe(y);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('Back and Forward take each view of Runs to where it was left, after a scroll on the view they leave', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 560 });
  await openPage(page, '/runs', 'main#view table.runst tbody tr');
  const rows = page.locator('main#view table.runst tbody tr');
  const pane = page.locator('main#view .page');
  const scrolledTo = (to: number) =>
    pane.evaluate((el, y) => {
      el.scrollTop = y;
      return el.scrollTop;
    }, to);
  const every = await rows.count();
  expect(await scrolledTo(300)).toBe(300);
  // Pressed where it is, the chips not scrolled into view first, so every run is left at 300.
  await page.locator('main#view .tbar .chips button', { hasText: /^Recordings/ }).dispatchEvent('click');
  await expect.poll(() => hash(page)).toBe('#/runs?types=recording');
  await expect.poll(() => rows.count()).toBeLessThan(every);
  await page.waitForTimeout(300);
  expect(await scrolledTo(100)).toBe(100);
  await page.goBack();
  await expect.poll(() => hash(page)).toBe('#/runs');
  await expect.poll(() => rows.count()).toBe(every);
  await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBe(300);
  await page.goForward();
  await expect.poll(() => hash(page)).toBe('#/runs?types=recording');
  await expect.poll(() => rows.count()).toBeLessThan(every);
  await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBe(100);
});

test('a golden’s issue on Runs › Failed opens Tests with its report open, as Needs a look’s golden does', async ({ page }) => {
  await openPage(page, '/runs?types=failed', 'main#view table.issues tbody tr');
  const golden = page.locator('main#view table.issues tr.iss .it a', { has: page.locator('code.gn') }).first();
  const name = (await golden.locator('code.gn').textContent())!;
  await expect(golden).toHaveAttribute('href', `#/tests?report=${encodeURIComponent(name)}`);
  await golden.click();
  await expect(page).toHaveURL(/#\/tests/);
});
