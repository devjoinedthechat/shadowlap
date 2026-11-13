import { expect, test } from '@playwright/test';
import { demoId, expectAccessible, glued, openPage } from './dashboard.js';
import { allClear, migrated, MIGRATED } from './routes.js';

/**
 * A page, a run's view, a Changes tab or the check builder whose code didn't come from the dashboard
 * server, in a real browser. The browser keeps a script's failure for as long as the page is open and
 * never asks for it again, so the page says so under its title, in the view, or in a small dialog in
 * the builder's place, with Retry, which loads the page again: once the server sends the script, the
 * page draws. A menu or a dialog that opens on a press says so in the error toast instead, the focus
 * left on its button. The script is refused here as a dashboard that stopped refuses it.
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
  // `golden` is a defined term there, its definition hidden after it in the line.
  await expect(page.locator('main#view .ph p')).toHaveText(glued(/^Every golden.+ CI runs, and how it did at each revision\.$/));
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

test('a check builder whose code didn’t come says so in a small dialog in its place, which closes back to Add check…', async ({ page }) => {
  const builder = /\/assets\/chunks\/Builder-\w+\.js$/;
  await page.route(builder, (route) => route.abort());
  await openPage(page, `/run/${demoId('refundBug')}`, 'run');
  await page.locator('main#view tr[data-wi]:has(td.name[title="issue_refund"])').first().click();
  const link = page.locator('[data-act="ckmenu"]');
  await link.click();
  await page.locator('.pop.ckm[role="menu"] [role="menuitem"]', { hasText: 'Never call issue_refund' }).click();
  const dialog = page.locator('[role="dialog"][aria-modal="true"]');
  await expect(dialog).toHaveAccessibleName('Add check');
  const line = dialog.locator('.loaderr');
  await expect(line.locator('.st.err')).toHaveText('couldn’t load');
  await expect(line).toContainText('This check builder’s code didn’t come from the dashboard server.');
  await expect(line.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expectAccessible(page);
  // Close takes it away, the focus back on what opened it, and the run's page is whole.
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(link).toBeFocused();
  await expect(page.locator('main#view .rhead .rnm')).toBeVisible();
  await page.unroute(builder);
});

test('a menu or a dialog whose code didn’t come says so in the error toast, nothing in its place and the focus on its button, until Retry loads it again', async ({ page }) => {
  const parts = /\/assets\/chunks\/(ShareMenu|StepDialogs)-\w+\.js$/;
  await page.route(parts, (route) => route.abort());
  await openPage(page, `/run/${demoId('digest')}`, 'run');
  const toast = page.locator('.toasts .toast.err');
  // Share's menu.
  const share = page.locator('#shareBtn');
  await share.click();
  await expect(toast).toContainText('This menu’s code didn’t come from the dashboard server. Retry loads the page again.');
  await expect(toast.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(share).toBeFocused();
  await expect(share).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
  await expectAccessible(page);
  // A step's dialog, and its words.
  await toast.getByRole('button', { name: 'Dismiss' }).click();
  await expect(toast).toHaveCount(0);
  const pack = page.locator('.rhead .actions button', { hasText: 'Pack as golden' });
  await pack.click();
  await expect(toast).toContainText('This dialog’s code didn’t come from the dashboard server. Retry loads the page again.');
  await expect(pack).toBeFocused();
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  // The server sends them: Retry loads the page again, and Share's menu opens.
  await page.unroute(parts);
  await toast.getByRole('button', { name: 'Retry' }).click();
  await page.locator('main#view .rhead .rnm').waitFor();
  await page.locator('#shareBtn').click();
  await expect(page.locator('.pop[role="menu"]')).toBeVisible();
  await expect(toast).toHaveCount(0);
});

test('Preview pull request comment, whose code didn’t come, says so in the error toast, closed again so the next press says it again, until Retry loads it again', async ({ page }) => {
  const part = /\/assets\/chunks\/PrCommentDialog-\w+\.js$/;
  await page.route(part, (route) => route.abort());
  await openPage(page, '/settings/ci', 'main#view .prpanel');
  const toast = page.locator('.toasts .toast.err');
  const preview = page.locator('main#view .prpanel button', { hasText: 'Preview pull request comment' });
  // Its button holds no open dialog once the toast comes: a second press asks for the script again, and says so again.
  for (const time of [1, 2]) {
    await preview.click();
    await expect(toast, `press ${time}`).toContainText('This dialog’s code didn’t come from the dashboard server. Retry loads the page again.');
    await expect(toast.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(preview).toBeFocused();
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    if (time === 1) {
      await toast.getByRole('button', { name: 'Dismiss' }).click();
      await expect(toast).toHaveCount(0);
    }
  }
  await expectAccessible(page);
  // The server sends it: Retry loads the page again, and the preview opens.
  await page.unroute(part);
  await toast.getByRole('button', { name: 'Retry' }).click();
  await page.locator('main#view .prpanel').waitFor();
  await preview.click();
  await expect(page.locator('[role="dialog"]', { hasText: 'Preview pull request comment' })).toBeVisible();
  await expect(toast).toHaveCount(0);
});

test('Apply config change?, whose code didn’t come, says so in the error toast and opens no dialog, closed again so the next press says it again, until Retry loads it again', async ({ page }) => {
  const part = /\/assets\/chunks\/ApplyConfigDialog-\w+\.js$/;
  await page.route(part, (route) => route.abort());
  // A migration all clear, whose one next step is Apply config change: the demo's isn't.
  await allClear(page);
  await openPage(page, (await migrated(page)).report, MIGRATED);
  const toast = page.locator('.toasts .toast.err');
  const apply = page.locator(`${MIGRATED} .actions button`, { hasText: 'Apply config change' });
  for (const time of [1, 2]) {
    await apply.click();
    await expect(toast, `press ${time}`).toContainText('This dialog’s code didn’t come from the dashboard server. Retry loads the page again.');
    await expect(toast.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(apply).toBeFocused();
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    if (time === 1) {
      await toast.getByRole('button', { name: 'Dismiss' }).click();
      await expect(toast).toHaveCount(0);
    }
  }
  await expectAccessible(page);
  // The server sends it: Retry loads the page again, and the dialog opens.
  await page.unroute(part);
  await toast.getByRole('button', { name: 'Retry' }).click();
  await page.locator(MIGRATED).waitFor();
  await apply.click();
  await expect(page.locator('[role="dialog"]', { hasText: 'Apply config change?' })).toBeVisible();
  await expect(toast).toHaveCount(0);
});
