import { expect, test, type Page } from '@playwright/test';
import { demoId, openPage, seriousViolations } from './dashboard.js';

/**
 * A run's header as the design fits it (ui/run/fit-head.ts): from 1280px the buttons sit beside the id,
 * the next step last before …, the secondary ones folding into … one at a time where they would wrap;
 * under 1280px, or where folding is not enough, they go under it all, the next step first. The id's
 * card holds the command, the revision, the time and the failure.
 */

/** The header's buttons as drawn: where each sits, which is the next step and which is …, and what folded. */
async function headLayout(page: Page) {
  return page.evaluate(() => {
    const h = document.querySelector<HTMLElement>('main#view .rhead')!;
    const a = h.querySelector<HTMLElement>(':scope > .actions')!;
    const t = h.querySelector<HTMLElement>(':scope > .rtitle')!;
    const words = (b: HTMLElement) => (b.textContent ?? '').replace(/\s+/g, ' ').trim();
    const drawn = [...a.querySelectorAll<HTMLElement>('button, a.btn')].filter((b) => b.getBoundingClientRect().width > 0);
    return {
      stack: h.classList.contains('stack'),
      besideTitle: Math.abs(a.offsetTop - t.offsetTop) <= 2,
      folded: [...a.querySelectorAll<HTMLElement>('[data-folded]')].map((b) => ({ words: words(b), drawn: b.getBoundingClientRect().width > 0 })),
      limeFolded: a.querySelector('.lime')?.hasAttribute('data-folded') ?? null,
      moreCard: a.querySelector('#moreBtn')?.getAttribute('data-tip') ?? '',
      buttons: drawn.map((b) => {
        const r = b.getBoundingClientRect();
        return { left: r.left, right: r.right, top: Math.round(r.top), lime: b.classList.contains('lime'), more: b.id === 'moreBtn' };
      }),
      over: h.scrollWidth - h.clientWidth,
      width: document.documentElement.clientWidth,
    };
  });
}

test('a run’s buttons sit beside its id from 1280px, the next step last before … and the secondary ones folding into it where they would wrap; under 1280px they go under it all, the next step first', async ({ page }) => {
  test.setTimeout(120_000);
  let folds = 0;
  let menuSeen = false;
  for (const width of [1440, 1280, 1180, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of ['digestFailed', 'clean', 'har']) {
      await openPage(page, `/run/${demoId(name)}`, 'run');
      const l = await headLayout(page);
      const at = `${name} at ${width}px`;
      // Nothing in the header reaches past it or the window, and the next step never folds.
      expect(l.over, at).toBeLessThanOrEqual(0);
      for (const b of l.buttons) expect(b.right, at).toBeLessThanOrEqual(l.width);
      expect(l.limeFolded, at).toBe(false);
      const order = [...l.buttons].sort((x, y) => x.top - y.top || x.left - y.left);
      if (width < 1280 || l.stack) {
        expect(l.stack, at).toBe(true);
        expect(l.folded, at).toEqual([]);
        expect(order[0]!.lime, at).toBe(true);
        continue;
      }
      expect(l.besideTitle, at).toBe(true);
      expect(order.at(-1)!.more, at).toBe(true);
      expect(order.at(-2)!.lime, at).toBe(true);
      for (const f of l.folded) {
        expect(f.drawn, at).toBe(false);
        expect(l.moreCard, at).toContain(f.words);
      }
      folds += l.folded.length;
      if (!l.folded.length || menuSeen) continue;
      // … lists what folded into it, by its words, then Delete run.
      await page.locator('#moreBtn').click();
      const items = await page.locator('.pop[role="menu"] [role="menuitem"]').allTextContents();
      expect(items.slice(0, l.folded.length).map((s) => s.replace(/\s+/g, ' ').trim()), at).toEqual(l.folded.map((f) => expect.stringContaining(f.words)));
      expect(items.at(-1), at).toContain('Delete run');
      await page.keyboard.press('Escape');
      menuSeen = true;
    }
  }
  // Some button folded at some width, so the fold itself was seen.
  expect(folds).toBeGreaterThan(0);
  expect(menuSeen).toBe(true);
});

test('the id’s card holds the run’s command, its time and its failure, under the id: on hover, on Tab but not where the page put the focus, and gone with Esc', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPage(page, `/run/${demoId('digestFailed')}`, 'run');
  const id = page.locator('main#view .rhead h1.rnm');
  const card = page.locator('main#view .rhead .meta');
  const away = () => page.mouse.move(700, 880);
  await away();
  await expect(card).toBeHidden();
  await id.hover();
  await expect(card).toBeVisible();
  await expect(card.locator('code.cmd, span.src')).toHaveCount(1);
  await expect(card.locator('.mwhen')).toBeVisible();
  await expect(card.locator('.mfail')).toBeVisible();
  const [i, c] = [(await id.boundingBox())!, (await card.boundingBox())!];
  expect(c.y).toBeGreaterThanOrEqual(i.y + i.height);
  // Esc hides it until the pointer leaves the id.
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  await away();
  await id.hover();
  await expect(card).toBeVisible();
  await away();
  await expect(card).toBeHidden();
  // The page's own focus on the id shows nothing; Tab bringing the focus there does, and Esc goes no further.
  await id.focus();
  await expect(card).toBeHidden();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(id).toBeFocused();
  await expect(card).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  await expect(id).toBeFocused();
});

test.describe('with a finger', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the id’s card is a line under the id, with nothing to hover', async ({ page }) => {
    await openPage(page, `/run/${demoId('digestFailed')}`, 'run');
    const id = page.locator('main#view .rhead h1.rnm');
    const card = page.locator('main#view .rhead .meta');
    await expect(card).toBeVisible();
    expect(await card.evaluate((el) => getComputedStyle(el).position)).toBe('static');
    const [i, c] = [(await id.boundingBox())!, (await card.boundingBox())!];
    expect(c.y).toBeGreaterThanOrEqual(i.y + i.height);
    expect(c.x + c.width).toBeLessThanOrEqual(390);
  });
});

test('a run’s id sits where a list page’s title does at 1440px, under the eyebrow as the title is', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPage(page, '/runs', 'runs');
  const title = (await page.locator('main#view h1').first().boundingBox())!;
  await openPage(page, `/run/${demoId('digestFailed')}`, 'run');
  const id = (await page.locator('main#view .rhead h1.rnm').boundingBox())!;
  expect(Math.abs(id.x - title.x), `x ${id.x} against ${title.x}`).toBeLessThanOrEqual(1);
  expect(Math.abs(id.y - title.y), `y ${id.y} against ${title.y}`).toBeLessThanOrEqual(1);
});

test('a fork’s header with its findings open, then with … open, has no serious or critical axe violation 390 and 320px wide', async ({ page }) => {
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await openPage(page, `/run/${demoId('override')}`, 'run');
    // The bar stays open for the session once opened, so it is opened only where it is shut.
    const more = page.locator('main#view .findings .fmore');
    if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(await seriousViolations(page), `${width}px, findings open`).toEqual([]);
    await page.click('main#view #moreBtn');
    await page.waitForSelector('.pop[role="menu"]', { state: 'visible' });
    expect(await seriousViolations(page), `${width}px, … open`).toEqual([]);
    await page.keyboard.press('Escape');
  }
});
