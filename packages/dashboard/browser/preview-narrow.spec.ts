import { expect, test } from '@playwright/test';
import { openPage, sideways } from './dashboard.js';
import { asksFirst, DIALOG, MENU, MIGRATED, migrated, PREVIEW, previewed } from './routes.js';

/**
 * What a new preview and a migration keep to, in their dialogs: a preview on every golden asks the
 * goldens picked, with Stop at $ and Then verify; a migration has Stop at $. Each command follows
 * the fields, and on a phone nothing scrolls sideways. Nothing is started: the dialogs are closed.
 */

for (const width of [1280, 390]) {
  test(`a new preview asks only the goldens picked, held to its Stop at $, then verifying, its command saying so, at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await asksFirst(page);
    await openPage(page, (await previewed(page)).preview, PREVIEW);
    await page.locator('main#view button', { hasText: 'New preview' }).first().click();
    await page.locator(`${MENU} [role="menuitem"]`, { hasText: 'Preview model switch' }).click();
    const dialog = page.locator(DIALOG);
    const command = dialog.locator('.cmdline');
    const chips = dialog.locator('.togchips button');
    await expect(chips.first()).toBeVisible();
    const all = await chips.count();
    expect(all).toBeGreaterThan(1);
    const left = (await chips.first().textContent())!;
    await chips.first().click();
    await expect(dialog.locator('.nsec .n')).toHaveText(`${all - 1} of ${all}`);
    await expect(command).not.toContainText(`goldens/${left} `);
    await dialog.getByRole('spinbutton', { name: 'Stop at $' }).fill('0.5');
    await dialog.getByRole('switch', { name: 'Then verify what it can’t clear' }).click();
    await expect(command).toContainText('--then-verify --budget 0.50');
    expect(await sideways(page)).toBe(0);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });
}

test('Migrate to holds the migration to its Stop at $, its command saying so', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPage(page, (await migrated(page)).report, MIGRATED);
  await page.locator('main#view .chbar button', { hasText: 'Migrate to' }).click();
  await page.locator(`${MENU}.fkm [role="menuitemradio"]`).first().click();
  const dialog = page.locator(DIALOG);
  await dialog.getByRole('spinbutton', { name: 'Stop at $' }).fill('3');
  await expect(dialog.locator('.cmdline')).toContainText('--budget 3.00');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});
