import { expect, test, type Page } from '@playwright/test';
import { openPage } from './dashboard.js';
import { openReport } from './tests-fixture.js';

/**
 * A golden's report on Tests over the demo store as it is: its Failed runs → opens the golden's
 * issue on Runs under Failed, its runs shown, as Fixes' failing-runs links open a fix's
 * (fixes-list.spec.ts). The demo's one divergence, refund-in-limit, leads with its normalizer, not a
 * fix, so its report links to its failed replays.
 */

const hash = (page: Page) => page.evaluate(() => location.hash);

test('a golden’s Failed runs → opens its issue on Runs under Failed, with Enter as with a click', async ({ page }) => {
  const name = 'refund-in-limit';
  await openPage(page, '/tests', 'main#view table.gt');
  await openReport(page, name);
  const link = page.locator(`main#view section[id="report-${name}"] span.glinks > a`, { hasText: 'Failed runs →' });
  await expect(link).toHaveAttribute('href', /^#\/runs\?.*types=failed/);
  await link.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => hash(page)).toMatch(/^#\/runs\?.*types=failed/);
  await page.locator('main#view table tbody tr').first().waitFor();
  // The golden's issue is open, its runs shown; the address says only the words and Failed.
  const issue = page.locator(`main#view table.issues tr[data-rowkey="test:goldens/${name}"] button.isn`);
  await expect(issue).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('main#view table.issues .isruns .isr').first()).toBeVisible();
});
