import { expect, test } from '@playwright/test';
import { openPage } from './dashboard.js';

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
  await expect(palette.locator('.palit', { hasText: 'Calibrate' })).toBeVisible();
  // A golden, under Tests.
  await field.fill('refund-in-limit');
  await expect(palette.locator('.palg', { hasText: /^Tests$/ })).toBeVisible();
});
