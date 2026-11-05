import { expect, test, type Page } from '@playwright/test';
import { demoId, expectAccessible, openPage } from './dashboard.js';

/**
 * A run's next step in a real browser, on the demo's runs: the header's one lime button, whatever the
 * run, with the step's hover and the same step first in This run; pressed from the palette, it does
 * what its button does.
 */

const lime = (page: Page) => page.locator('main#view .btn.lime');
const thisRun = (page: Page) => page.locator('.palit').first();

/** The palette, opened over the page. */
async function palette(page: Page): Promise<void> {
  await page.keyboard.press('Meta+k');
  await page.waitForSelector('.palette');
}

test('each kind of run has one lime button, its next step, first in This run', async ({ page }) => {
  const leads: Array<[string, string]> = [
    [demoId('digest'), 'Pack as golden…'],
    [demoId('digestFailed'), 'Run blame'],
    [demoId('refundBug'), 'Open fix'],
    [demoId('override'), 'Compare with parent'],
    [demoId('clean'), 'Replay recording'],
    [demoId('ticket'), 'Replay'],
    [demoId('har'), 'Replay with your command…'],
  ];
  for (const [id, label] of leads) {
    await openPage(page, `/run/${id}`, 'run');
    await expect(lime(page), id).toHaveCount(1);
    await expect(lime(page), id).toHaveText(label);
    await palette(page);
    await expect(thisRun(page).locator('.pl'), id).toHaveText(label);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.palette', { state: 'detached' });
  }
});

test('pressed from the palette, a step does what its button does: it asks, or opens where it goes', async ({ page }) => {
  await openPage(page, `/run/${demoId('digest')}`, 'run');
  await palette(page);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.dialog');
  await expect(page.locator('.dialog h3')).toHaveText(`Pack ${demoId('digest').slice(0, 10)} as golden?`);
  await expectAccessible(page);
  await page.keyboard.press('Escape');
  await openPage(page, `/run/${demoId('refundBug')}`, 'run');
  await palette(page);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => location.hash.startsWith('#/fixes/'));
});

test('a step’s hover says what it does and runs, and what it bills where it does', async ({ page }) => {
  await openPage(page, `/run/${demoId('digestFailed')}`, 'run');
  const tip = JSON.parse((await lime(page).getAttribute('data-tip'))!) as { t: string; rows: string[][]; cmd: string };
  expect(tip.t).toBe('Run blame');
  expect(tip.rows.map((r) => r[0])).toEqual(['Costs']);
  expect(tip.rows[0]![1]).toMatch(/^At most ≈\$/);
  expect(tip.cmd).toBe(`$ shadowlap blame ${demoId('digestFailed').slice(0, 10)}`);
  await lime(page).hover();
  await expect(page.locator('.tip')).toContainText('At most');
  await expect(page.locator('.tip')).toContainText(`shadowlap blame ${demoId('digestFailed').slice(0, 10)}`);
});

test('a step’s card goes as its dialog opens with the pointer on the button, and a move under the dialog brings none back', async ({ page }) => {
  await openPage(page, `/run/${demoId('digest')}`, 'run');
  await lime(page).hover();
  const tip = page.locator('#tip');
  await expect(tip).toBeVisible();
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForSelector('.dialog');
  await expect(tip).toBeHidden();
  const at = (await lime(page).boundingBox())!;
  await page.mouse.move(at.x + 2, at.y + 2);
  // Longer than a pointer waits for a card.
  await page.waitForTimeout(500);
  await expect(tip).toBeHidden();
});

test('while a job holds the working tree, a step goes plain and says why, in the palette too, and a press starts nothing', async ({ page }) => {
  const posts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST') posts.push(r.url());
  });
  await page.route('**/api/jobs', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { jobs: [{ id: 'held', kind: 'repair', title: 'Run repair', done: false, startedAt: Date.now(), worktree: { folder: null, use: 'writes', doing: 'a repair is running' }, project: null }] } }) : route.continue()));
  const WAITS = 'A repair is running: blame once it is done.';
  await openPage(page, `/run/${demoId('digestFailed')}`, 'run');
  await expect(lime(page)).toHaveCount(0);
  const step = page.locator('.rhead [data-next]');
  await expect(step).toBeDisabled();
  await expect(step).toHaveAttribute('title', WAITS);
  await palette(page);
  await expect(thisRun(page)).toHaveClass(/waits/);
  await expect(thisRun(page)).toContainText(WAITS);
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast').filter({ hasText: WAITS })).toBeVisible();
  await expect(page.locator('.palette')).toBeVisible();
  expect(posts).toEqual([]);
});
