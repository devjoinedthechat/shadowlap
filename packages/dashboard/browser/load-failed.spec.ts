import { expect, test } from '@playwright/test';
import { demoId, expectAccessible, openPage } from './dashboard.js';

/**
 * A page, or a run's view, whose code didn't come from the dashboard server, in a real browser. The
 * browser keeps a script's failure for as long as the page is open and never asks for it again, so
 * the page says so under its title, or in the view, with Retry, which loads the page again: once
 * the server sends the script, the page draws. The script is refused here as a dashboard that
 * stopped refuses it.
 */

test('a page whose code didn’t come says so under its title, asks for it no more, and draws once Retry loads it again', async ({ page }) => {
  const tests = /\/assets\/chunks\/Tests-\w+\.js$/;
  let asked = 0;
  page.on('request', (r) => {
    if (tests.test(r.url())) asked++;
  });
  await page.route(tests, (route) => route.abort());
  await openPage(page, '/tests', 'main#view .loaderr');
  const line = page.locator('main#view .loaderr');
  await expect(page.locator('main#view .ph h1')).toHaveText('Tests');
  await expect(line).toHaveAttribute('role', 'alert');
  await expect(line.locator('.st.err')).toHaveText('couldn’t load');
  await expect(line).toContainText('This page’s code didn’t come from the dashboard server.');
  await expectAccessible(page);
  // Away and back: the line again, and the script not asked for a second time.
  expect(asked).toBe(1);
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: /^Runs/ }).click();
  await page.locator('main#view table.runst tbody tr').first().waitFor();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: /^Tests/ }).click();
  await expect(line).toBeVisible();
  expect(asked).toBe(1);
  // The server sends it: Retry loads the page again, and Tests draws.
  await page.unroute(tests);
  await line.getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('main#view .ph h1')).toHaveText('Tests');
  await expect(page.locator('main#view .ph p')).toHaveText('Every golden CI runs, and how it did at each revision.');
  await expect(page.locator('main#view .loaderr')).toHaveCount(0);
  expect(asked).toBe(2);
});

test('a run’s view whose code didn’t come says so in the view, with the run’s page and its other views whole', async ({ page }) => {
  const timeline = /\/assets\/chunks\/TimelineView-\w+\.js$/;
  await page.route(timeline, (route) => route.abort());
  await openPage(page, `/run/${demoId('ticket')}`, 'run');
  const views = page.getByRole('tablist', { name: 'Views' });
  await views.getByRole('tab', { name: 'Timeline' }).click();
  const line = page.locator('main#view .vbody .loaderr');
  await expect(line.locator('.st.err')).toHaveText('couldn’t load');
  await expect(line).toContainText('This view’s code didn’t come from the dashboard server.');
  await expect(line.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expectAccessible(page);
  // The rest of the page is as it was, and the other views draw from their own scripts.
  await expect(page.locator('main#view .rhead .rnm')).toBeVisible();
  await views.getByRole('tab', { name: 'Turns' }).click();
  await expect(page.locator('main#view .vbody .turnlist')).toBeVisible();
  await page.unroute(timeline);
});

test('a Changes tab whose code didn’t come says so under Changes’ head, with the head and its tabs whole', async ({ page }) => {
  const verdicts = /\/assets\/chunks\/Verdicts-\w+\.js$/;
  await page.route(verdicts, (route) => route.abort());
  await openPage(page, '/changes', 'main#view .loaderr');
  const line = page.locator('main#view .loaderr');
  await expect(line.locator('.st.err')).toHaveText('couldn’t load');
  await expect(line).toContainText('This tab’s code didn’t come from the dashboard server.');
  await expect(line.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expectAccessible(page);
  // The head stands over it, and Compare's tab draws from a script of its own.
  await expect(page.locator('main#view .ph h1')).toHaveText('Changes');
  const tabs = page.getByRole('navigation', { name: 'Changes' });
  await expect(tabs.getByRole('link', { name: 'Verdicts' })).toHaveAttribute('aria-current', 'page');
  await tabs.getByRole('link', { name: 'Compare' }).click();
  await expect(page.locator('main#view .pickers')).toHaveCount(1);
  await expect(tabs.getByRole('link', { name: 'Compare' })).toHaveAttribute('aria-current', 'page');
  await page.unroute(verdicts);
});
