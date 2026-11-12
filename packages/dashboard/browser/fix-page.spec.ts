import { expect, test } from '@playwright/test';
import { GLOSSARY } from '../ui/glossary.js';
import { demoId, expectAccessible, openPage } from './dashboard.js';

/**
 * A fix's header in a browser, as the design's fitFixHead() fits it: wider than 1280px its buttons sit
 * beside the title while they leave it 520px, else under it; at 1280px and below always under it.
 * Under it, the lime one comes first. Nothing scrolls sideways.
 */

interface Box {
  top: number;
  left: number;
  lime: boolean;
}

for (const width of [1440, 1280, 390])
  test(`a fix’s header sets its buttons beside the title where they leave it 520px, else under it with the lime one first, at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const fix of ['emailFix', 'refundFix']) {
      await openPage(page, `/fixes/${demoId(fix)}`, 'fix');
      const head = page.locator('main#view .ph.fxh');
      await head.locator('.actions .btn').first().waitFor();
      const seen = await head.evaluate((h) => {
        const title = h.firstElementChild!.getBoundingClientRect();
        const buttons = [...h.querySelectorAll('.actions .btn')].map((b): Box => ({ top: Math.round(b.getBoundingClientRect().top), left: b.getBoundingClientRect().left, lime: b.classList.contains('lime') }));
        return { stack: h.classList.contains('stack'), width: title.width, bottom: title.bottom, right: title.right, buttons };
      });
      if (width > 1280 && !seen.stack) {
        expect(seen.width, fix).toBeGreaterThanOrEqual(520);
        expect(seen.buttons.every((b) => b.left >= seen.right), fix).toBe(true);
      } else {
        expect(seen.buttons.every((b) => b.top >= seen.bottom), fix).toBe(true);
        const lime = seen.buttons.find((b) => b.lime);
        const first = seen.buttons.filter((b) => b.top === Math.min(...seen.buttons.map((x) => x.top)));
        if (lime) expect(Math.min(...first.map((b) => b.left)), fix).toBe(lime.left);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), fix).toBe(0);
    }
  });

for (const width of [1440, 390])
  test(`the Blame step's key shows only its words, a term's definition kept for its hover card, at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    let defined = 0;
    for (const fix of ['emailFix', 'refundFix']) {
      await openPage(page, `/fixes/${demoId(fix)}/blame`, 'fix');
      const key = page.locator('main#view .legend.fxleg');
      await key.waitFor();
      defined += await key.locator('.term[aria-describedby]').count();
      const shown = await key.evaluate((el) => (el as HTMLElement).innerText);
      expect(shown, fix).toMatch(/model call/);
      for (const words of Object.values(GLOSSARY)) expect(shown, fix).not.toContain(words);
    }
    // the demo's keys define a term, so the check above reads a definition the page holds
    expect(defined).toBeGreaterThan(0);
  });

for (const [width, height] of [
  [1440, 900],
  [390, 844],
] as const)
  test(`Edit check… ends an open fix's check and opens the builder on it, its runs judged, Save check asking for the fix-check job, at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const fixId = demoId('emailFix');
    // The job's POST is answered here, so nothing changes the demo every test shares.
    let asked: { kind: string; fixId: string; expect: unknown } | null = null;
    await page.route(/\/api\/jobs$/, (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      asked = route.request().postDataJSON() as typeof asked;
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'This fix moved on since the page read it.' }) });
    });
    await openPage(page, `/fixes/${fixId}`, 'fix');
    const link = page.locator('main#view .ph p.chk .fmx button');
    await expect(link).toHaveText('Edit check…');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await link.click();
    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog.locator('header h3')).toHaveText('Edit check');
    await expect(dialog.locator('.cb-fixr .cb-row').first()).toBeVisible();
    await expect(dialog.locator('.cb-k .k').first()).toHaveText('The check of this fix');
    await expectAccessible(page);
    await dialog.locator('.cb-kinds button', { hasText: /^Never$/ }).click();
    // Save check waits for the change's own answer from the fix's runs, then asks for the job.
    const save = dialog.locator('.dlg-ok');
    await expect(save).not.toHaveAttribute('aria-disabled', 'true');
    await expect(dialog.locator('.cb-fixr .cb-row').first()).toBeVisible();
    await save.click();
    await expect(dialog.locator('.dwarn')).toHaveText('This fix moved on since the page read it.');
    // The page names the fix by its whole id, the demo by its short one.
    const sent = asked as { kind: string; fixId: string; expect: unknown } | null;
    expect(sent && [sent.kind, sent.fixId.startsWith(fixId), sent.expect]).toEqual(['fix-check', true, { tools: { send_email: 0 } }]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  });

test('a verified fix offers a check added to the golden that guards it, beside the fix’s runs', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPage(page, `/fixes/${demoId('refundFix')}`, 'fix');
  const link = page.locator('main#view .ph p.chk .fmx button');
  await expect(link).toHaveText(/^Add check( to \S+)?…$/);
  await link.click();
  const dialog = page.locator('[role="dialog"][aria-modal="true"]');
  await expect(dialog.locator('header h3')).toHaveText(/^Add check/);
  await expect(dialog.locator('.cb-kinds')).toBeVisible();
  await expectAccessible(page);
});

