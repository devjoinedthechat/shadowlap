import { expect, test, type Page } from '@playwright/test';
import { dash, demoId, openPage, seriousViolations, startJob } from './dashboard.js';

/**
 * The job's drawer docked across the content's foot, its chip and pill, and toasts over all of it, in
 * Chromium over the demo store, at 1440 and on a phone at 390. Jobs here are scripted at the job
 * routes, so nothing runs: `end` says how the job the page follows ended.
 */

const box = async (page: Page, selector: string) => (await page.locator(selector).boundingBox())!;

/** j along Runs with a drawer docked: each row it brings into view stops above the drawer, and once one is picked, above the bulk bar over it. */
async function rowsClearOfTheDock(page: Page, width: number) {
  const clear = (over: string) => page.evaluate((s): [number, number] => [document.querySelector('.krow')!.getBoundingClientRect().bottom, document.querySelector(s)!.getBoundingClientRect().top], over);
  await startJob(page);
  await page.evaluate(() => {
    location.hash = '#/runs';
  });
  await page.locator('main#view table.runst tbody tr').first().waitFor();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('j');
    const [rowBottom, top] = await clear('section.drawer');
    expect(rowBottom, `row ${i + 1} at ${width}`).toBeLessThanOrEqual(top + 1);
  }
  await page.keyboard.press('x');
  await page.locator('.bulkbar').waitFor();
  for (let i = 12; i < 24; i++) {
    await page.keyboard.press('j');
    const [rowBottom, top] = await clear('.bulkbar');
    expect(rowBottom, `row ${i + 1} at ${width}, under the bar`).toBeLessThanOrEqual(top + 1);
  }
}

const CLEAN = '✓ Replay clean: 30/30 calls replayed';

/** A page in a connection state's preview, which stops no server. */
async function openState(page: Page, state: 'offline' | 'expired', path: string, drawn: string) {
  const { origin, token } = dash();
  await page.goto(`${origin}/?state=${state}#token=${token}&open=${path}`);
  await page.waitForSelector(drawn, { state: 'visible' });
}

test.describe('at 1440', () => {
  test('docks across the content, a hairline above it, and the content makes room', async ({ page }) => {
    await startJob(page);
    const d = await box(page, 'section.drawer');
    const main = await box(page, 'main#view');
    expect(Math.round(d.x)).toBe(Math.round(main.x));
    expect(Math.round(d.x + d.width)).toBe(1440);
    expect(Math.round(d.height)).toBe(264);
    expect(Math.round(d.y + d.height)).toBe(900 - 28);
    await expect(page.locator('main#view')).toHaveCSS('padding-bottom', '264px');
    await expect(page.locator('#jtitle')).toHaveText('Replaying');
    await expect(page.locator('section.drawer .st2').last()).toHaveText('running');
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('hides a running job behind the status bar’s chip, which opens it again', async ({ page }) => {
    await startJob(page);
    await page.locator('#jx').click();
    await expect(page.locator('section.drawer')).toBeHidden();
    await expect(page.locator('main#view')).toHaveCSS('padding-bottom', '0px');
    const chip = page.locator('.status .jobchip');
    await expect(chip).toHaveText('Replaying · running');
    await expect(chip).toBeFocused();
    expect((await chip.boundingBox())!.y).toBeGreaterThan(872);
    expect(await seriousViolations(page)).toEqual([]);
    await chip.click();
    await expect(page.locator('section.drawer')).toBeVisible();
    await expect(page.locator('#jx')).toBeFocused();
    await expect(chip).toHaveCount(0);
    // Esc hides it again, and goes on to nothing while it is hidden.
    await page.keyboard.press('Escape');
    await expect(page.locator('section.drawer')).toBeHidden();
    await expect(chip).toBeFocused();
  });

  test('ends in the past tense, then folds to its header line, its room following it', async ({ page }) => {
    const { end } = await startJob(page);
    await page.locator('main#view').focus();
    end([CLEAN]);
    await expect(page.locator('#jtitle')).toHaveText('Replayed');
    await expect(page.locator('section.drawer .st2').last()).toHaveText('reproduced · exit 0');
    await expect(page.locator('section.drawer.folded')).toBeVisible({ timeout: 4000 });
    const d = await box(page, 'section.drawer');
    expect(d.height).toBeLessThan(60);
    await expect(page.locator('#jout')).toBeHidden();
    const room = await page.locator('main#view').evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
    expect(Math.abs(room - d.height)).toBeLessThan(1);
    // The log is a button away.
    await page.locator('#jlog').click();
    await expect(page.locator('#jout')).toBeVisible();
    await expect(page.locator('#jlog')).toHaveAttribute('aria-label', 'Hide log');
    expect(Math.round((await box(page, 'section.drawer')).height)).toBe(264);
    // Close: gone, and the content has its room back.
    await page.locator('#jx').click();
    await expect(page.locator('section.drawer')).toHaveCount(0);
    await expect(page.locator('main#view')).toHaveCSS('padding-bottom', '0px');
  });

  test('stays across pages while it runs, and goes with the page once it has ended', async ({ page }) => {
    const { end } = await startJob(page);
    await page.evaluate(() => (location.hash = '#/runs'));
    await page.locator('main#view table.runst').waitFor();
    await expect(page.locator('section.drawer')).toBeVisible();
    end([CLEAN]);
    await expect(page.locator('#jtitle')).toHaveText('Replayed');
    await page.evaluate(() => (location.hash = '#/tests'));
    await expect(page.locator('section.drawer')).toHaveCount(0);
  });

  test('raises a toast with its way on when a hidden job ends, centred on the content', async ({ page }) => {
    const { end, run } = await startJob(page);
    await page.locator('#jx').click();
    end([CLEAN], { newRunId: run });
    const toast = page.locator('.toast');
    await expect(toast).toContainText('Replayed · reproduced · exit 0');
    await expect(page.locator('.status .jobchip')).toHaveText('Replayed · reproduced · exit 0');
    const t = (await toast.boundingBox())!;
    const main = await box(page, 'main#view');
    expect(Math.abs(t.x + t.width / 2 - (main.x + main.width / 2))).toBeLessThan(2);
    expect(Math.round(900 - (t.y + t.height))).toBe(28 + 14);
    // The chip shows it again, and that toast goes: the drawer says the same.
    await page.locator('.status .jobchip').click();
    await expect(page.locator('section.drawer')).toBeVisible();
    await expect(toast).toHaveCount(0);
    await expect(page.locator('#jtitle')).toHaveText('Replayed');
  });

  test('offers Show when a hidden job has no way on', async ({ page }) => {
    const { end } = await startJob(page);
    await page.locator('#jx').click();
    end([CLEAN]);
    await page.locator('.toast .tbtn', { hasText: 'Show' }).click();
    await expect(page.locator('section.drawer')).toBeVisible();
    await expect(page.locator('#jx')).toBeFocused();
  });

  test('places a toast over the drawer, and again when the drawer goes', async ({ page }) => {
    await startJob(page);
    await page.locator('section.drawer .btn', { hasText: 'Stop' }).click();
    const toast = page.locator('.toast');
    await expect(toast).toContainText('Replaying had ended already');
    const d = await box(page, 'section.drawer');
    const t = (await toast.boundingBox())!;
    expect(Math.round(d.y - (t.y + t.height))).toBe(14);
    await page.locator('#jx').click();
    await expect(page.locator('section.drawer')).toBeHidden();
    await expect.poll(async () => Math.round(900 - ((await toast.boundingBox())!.y + (await toast.boundingBox())!.height))).toBe(28 + 14);
  });

  test('undoes a mark with ⌘Z, or u while single keys are on', async ({ page }) => {
    await openPage(page, `/run/${demoId('eval')}`, 'run');
    const good = page.locator('.rhead .runkey button', { hasText: 'good' });
    await good.click();
    await expect(good).toHaveAttribute('aria-pressed', 'true');
    const undo = page.locator('.toast .tbtn', { hasText: 'Undo' });
    await expect(undo).toBeVisible();
    await expect(undo).toHaveAttribute('aria-keyshortcuts', 'Meta+Z Control+Z u');
    await page.keyboard.press('ControlOrMeta+z');
    await expect(good).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.toast')).toContainText('put back as it was');
    await good.click();
    await expect(good).toHaveAttribute('aria-pressed', 'true');
    await expect(undo).toBeVisible();
    await page.keyboard.press('u');
    await expect(good).toHaveAttribute('aria-pressed', 'false');
  });

  test('places a toast over the bulk bar that rides over a docked drawer', async ({ page }) => {
    await startJob(page);
    await page.evaluate(() => {
      location.hash = '#/runs';
    });
    await page.locator('input[type="checkbox"][aria-label^="Select "]:not([aria-label^="Select every"])').first().check();
    await page.locator('.bulkbar').waitFor();
    await page.locator('section.drawer .btn', { hasText: 'Stop' }).click();
    const toast = page.locator('.toast');
    await expect(toast).toContainText('Replaying had ended already');
    const bar = await box(page, '.bulkbar');
    const d = await box(page, 'section.drawer');
    expect(bar.y + bar.height).toBeLessThan(d.y);
    const t = (await toast.boundingBox())!;
    expect(Math.round(bar.y - (t.y + t.height))).toBe(14);
  });

  test('stops a row j brings into view above a docked drawer, and above the bulk bar over it', async ({ page }) => {
    await rowsClearOfTheDock(page, 1440);
  });

  test('keeps a long notice within the content it is centred on', async ({ page }) => {
    await startJob(page, `Replaying ${'with a title that goes on and on '.repeat(6).trim()}`);
    await page.locator('section.drawer .btn', { hasText: 'Stop' }).click();
    const toast = page.locator('.toast');
    await expect(toast).toContainText('had ended already');
    const main = await box(page, 'main#view');
    const t = (await toast.boundingBox())!;
    expect(t.x).toBeGreaterThanOrEqual(main.x + 15);
    expect(t.x + t.width).toBeLessThanOrEqual(main.x + main.width - 15);
  });

  test('shows the log’s end when a job that ended hidden is shown again', async ({ page }) => {
    const { end } = await startJob(page);
    await page.locator('#jx').click();
    await expect(page.locator('section.drawer')).toBeHidden();
    end(Array.from({ length: 400 }, (_, i) => `line ${i}`));
    const chip = page.locator('.status .jobchip');
    await expect(chip).toHaveClass(/ok/);
    await chip.click();
    await expect(page.locator('section.drawer')).toBeVisible();
    await expect.poll(() => page.locator('#jout').evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight))).toBeLessThanOrEqual(1);
  });

  test('downloads the HTML report from Share on a read-only dashboard, every other copy waiting', async ({ page }) => {
    await page.route(/\/api\/meta(\?.*)?$/, async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), readOnly: true } });
    });
    await openPage(page, `/run/${demoId('ticket')}`, 'run');
    const share = page.locator('.rhead .actions button', { hasText: 'Share' });
    await expect(share).not.toHaveAttribute('aria-disabled', 'true');
    await share.click();
    await expect(page.getByRole('menuitem', { name: /^Pack/ })).toHaveAttribute('aria-disabled', 'true');
    const html = page.getByRole('menuitem', { name: /^HTML report/ });
    await expect(html).not.toHaveAttribute('aria-disabled', 'true');
    const download = page.waitForEvent('download');
    await html.click();
    expect((await download).suggestedFilename()).toMatch(/\.html$/);
  });
});

test.describe('at 1050', () => {
  test.use({ viewport: { width: 1050, height: 800 } });

  test('lets a long chip give way in the status bar, which keeps its version', async ({ page }) => {
    await startJob(page, 'Adding normalizer and updating golden');
    await page.locator('#jx').click();
    await expect(page.locator('.status .jobchip')).toBeVisible();
    expect(await page.locator('.status').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('stops a row j brings into view above a docked drawer, and above the bulk bar over it', async ({ page }) => {
    await rowsClearOfTheDock(page, 390);
  });

  test('places a toast over the bulk bar that rides over a docked drawer', async ({ page }) => {
    await startJob(page);
    await page.evaluate(() => {
      location.hash = '#/runs';
    });
    await page.locator('input[type="checkbox"][aria-label^="Select "]:not([aria-label^="Select every"])').first().check();
    await page.locator('.bulkbar').waitFor();
    await page.locator('section.drawer .btn', { hasText: 'Stop' }).click();
    const toast = page.locator('.toast');
    await expect(toast).toContainText('Replaying had ended already');
    const bar = await box(page, '.bulkbar');
    const t = (await toast.boundingBox())!;
    expect(Math.round(bar.y - (t.y + t.height))).toBe(14);
  });

  test('docks at the window’s foot and hides into a pill the bar keeps room for', async ({ page }) => {
    const { end } = await startJob(page);
    const d = await box(page, 'section.drawer');
    expect(d.x).toBe(0);
    expect(d.width).toBe(390);
    expect(Math.round(d.height)).toBe(300);
    expect(Math.round(d.y + d.height)).toBe(844);
    await page.locator('#jx').click();
    await expect(page.locator('section.drawer')).toBeHidden();
    const pill = page.locator('.status .jobchip');
    await expect(pill).toHaveText('Replaying · running');
    const p = (await pill.boundingBox())!;
    expect(Math.round(p.x + p.width)).toBe(390 - 12);
    expect(Math.round(p.y + p.height)).toBe(844 - 12);
    await expect(pill).toHaveCSS('height', '36px');
    expect(parseFloat(await page.locator('.status').evaluate((el) => getComputedStyle(el).paddingBottom))).toBeGreaterThanOrEqual(56);
    expect(await seriousViolations(page)).toEqual([]);
    // Its end's toast says how it ended, over the foot, the pill stepping aside meanwhile.
    end([CLEAN]);
    const toast = page.locator('.toast');
    await expect(toast).toContainText('Replayed · reproduced · exit 0');
    await expect(pill).toBeHidden();
    const t = (await toast.boundingBox())!;
    expect(Math.abs(t.x + t.width / 2 - 195)).toBeLessThan(2);
    expect(t.x).toBeGreaterThanOrEqual(16);
    expect(t.x + t.width).toBeLessThanOrEqual(390 - 16 + 1);
    await page.locator('.toast .tbtn', { hasText: 'Show' }).click();
    await expect(page.locator('section.drawer')).toBeVisible();
  });
});

test.describe('when the server can’t be reached', () => {
  test('sits under the top bar in the app’s grid, covering nothing, with its command and its countdown', async ({ page }) => {
    await openState(page, 'offline', '/tests', '.connbar');
    const bar = page.locator('.connbar');
    const b = (await bar.boundingBox())!;
    const main = await box(page, 'main#view');
    expect(Math.round(b.y)).toBe(52);
    expect(Math.round(b.x)).toBe(Math.round(main.x));
    expect(Math.round(b.y + b.height)).toBeLessThanOrEqual(Math.round(main.y));
    await expect(bar).toHaveCSS('position', 'static');
    await expect(bar.locator('.ct')).toContainText('Can’t reach the dashboard server');
    await expect(bar.locator('.ct')).toContainText('actions paused');
    await expect(bar.locator('.cc code')).toHaveText('shadowlap dashboard');
    await expect(bar.locator('.cr')).toContainText(/Retrying in \d+s|Reconnecting…/);
    await expect(bar.getByRole('button', { name: 'Retry now' })).toBeVisible();
    await expect(bar.locator('.cs')).toBeHidden();
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('dims what needs the server, and says why on a press', async ({ page }) => {
    await openState(page, 'offline', `/run/${demoId('ticket')}`, '.rhead .actions button');
    const replay = page.locator('.rhead .actions button', { hasText: /^Replay$/ });
    await expect(replay).toHaveAttribute('aria-disabled', 'true');
    await expect(replay).toHaveAttribute('data-why', 'Paused until the dashboard server is back');
    await expect(replay).not.toHaveClass(/lime/);
    await expect(replay).toHaveCSS('opacity', '0.5');
    // From the keyboard: it keeps the focus while it waits.
    await replay.focus();
    await page.keyboard.press('Enter');
    await expect(replay).toBeFocused();
    await expect(page.locator('.toast')).toContainText('Paused until the dashboard server is back');
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('is one line, with why behind a button', async ({ page }) => {
      await openState(page, 'offline', '/tests', '.connbar');
      const bar = page.locator('.connbar');
      await expect(bar.locator('.cs')).toHaveText('Offline · actions paused');
      await expect(bar.locator('.ct')).toBeHidden();
      await expect(bar.locator('.cc')).toBeHidden();
      expect((await bar.boundingBox())!.height).toBeLessThan(60);
      const why = bar.getByRole('button', { name: 'Why' });
      await expect(why).toHaveAttribute('aria-expanded', 'false');
      await why.click();
      await expect(why).toHaveAttribute('aria-expanded', 'true');
      await expect(why).toBeFocused();
      await expect(bar.locator('.cw')).toContainText('Can’t reach the dashboard server, so this shows what loaded');
      await expect(bar.locator('.cc code')).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
    });
  });
});

test('says a link the dashboard refuses in two sentences and one command box, its toast over the card', async ({ page }) => {
  await openState(page, 'expired', '/tests', '.connblock');
  const card = page.locator('.connblock');
  await expect(card).toHaveAttribute('aria-describedby', 'connD');
  await expect(card.locator('h1')).toHaveText('This link’s session token isn’t this dashboard’s');
  await expect(card.locator('#connD')).toHaveText('It was restarted, or the link is from another one. Open the link it printed when it started, or start it again:');
  await expect(card.locator('.cmdline')).toHaveCount(1);
  await expect(card.locator('.btn.lime')).toHaveText('Paste the new link');
  await expect(card.locator('.btn.lime')).toBeFocused();
  await expect(card.locator('.cbdoc a')).toHaveAttribute('href', /docs\/dashboard\.md#security-and-consent$/);
  expect(await seriousViolations(page)).toEqual([]);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await card.locator('.cmdline button').click();
  const toast = page.locator('.toast');
  await expect(toast).toContainText('Copied the command');
  await expect(toast).toHaveCSS('z-index', '61');
});
