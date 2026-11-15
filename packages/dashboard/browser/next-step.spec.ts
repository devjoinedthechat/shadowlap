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
  const tip = JSON.parse((await lime(page).getAttribute('data-tip'))!) as { t: string; rows: string[][]; cmd: string; est?: { usd: number | null; ceiling: boolean } };
  expect(tip.t).toBe('Run blame');
  expect(tip.rows).toEqual([]);
  expect(tip.est).toMatchObject({ ceiling: true, usd: expect.any(Number) });
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

test('a run’s buttons wrap rather than reach its id, in the narrowest window that sets them beside it', async ({ page }) => {
  await page.setViewportSize({ width: 1010, height: 800 });
  await openPage(page, `/run/${demoId('clean')}`, 'run');
  const [id, buttons] = [await page.locator('.rhead h1').boundingBox(), await page.locator('.rhead .actions').boundingBox()];
  // Beside the id they end short of it; where they no longer fit beside it, the header stacks them under it, as the design does.
  expect(id!.x + id!.width <= buttons!.x || buttons!.y >= id!.y + id!.height).toBe(true);
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
  // It waits as every action does (ActionButton): its place and its focus kept, why on its card and in a toast on a press.
  await expect(step).toHaveAttribute('aria-disabled', 'true');
  await expect(step).toHaveAttribute('data-why', WAITS);
  await palette(page);
  await expect(thisRun(page)).toHaveClass(/waits/);
  await expect(thisRun(page)).toContainText(WAITS);
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast').filter({ hasText: WAITS })).toBeVisible();
  await expect(page.locator('.palette')).toBeVisible();
  expect(posts).toEqual([]);
});

test('Run blame asks above Spending with blame’s settings beside its check, and starts with what they say', async ({ page }) => {
  // Every billed press asks: the step's dialog shows, holding its settings.
  await page.route('**/api/user/spending', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { askAbove: 0, set: true, problems: [] } }) : route.abort()));
  // The job's POST is answered here, so nothing changes the demo every test shares.
  let asked: Record<string, unknown> | null = null;
  await page.route(/\/api\/jobs$/, (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    asked = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'A blame of this run is running in another tab.' }) });
  });
  const run = demoId('digestFailed');
  await openPage(page, `/run/${run}`, 'run');
  await lime(page).click();
  const dialog = page.locator('[role="dialog"][aria-modal="true"]');
  await expect(dialog.locator('header h3')).toContainText('Run blame on');
  await dialog.locator('input[type="text"]').first().fill('temperature=1');
  await dialog.locator('input[type="number"]').fill('2');
  await expect(dialog.locator('.cmdline')).toContainText(`shadowlap blame ${run.slice(0, 10)} --set temperature=1 --budget 2.00`);
  await expectAccessible(page);
  await dialog.locator('.dlg-ok').click();
  await expect.poll(() => asked).toMatchObject({ kind: 'blame', runId: run, set: ['temperature=1'], budget: 2 });
});
