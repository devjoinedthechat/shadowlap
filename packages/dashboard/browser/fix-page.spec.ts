import { expect, test } from '@playwright/test';
import { demoId, openPage } from './dashboard.js';

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
