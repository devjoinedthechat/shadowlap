import { expect, test } from '@playwright/test';
import { GLOSSARY } from '../ui/glossary.js';
import { demoId, expectAccessible, glued, openPage } from './dashboard.js';

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
  // Its title set as a dialog's title is, its last two words glued: a RegExp's spaces aren't normalised as a string's are.
  await expect(dialog.locator('header h3')).toHaveText(glued(/^Add check/));
  await expect(dialog.locator('.cb-kinds')).toBeVisible();
  await expectAccessible(page);
});


/**
 * The fix's page as the server answers it, with `patch` applied: what the demo doesn't hold, so nothing
 * changes the demo every test shares. By the demo's short id, and the whole one a dialog reads it again by.
 */
async function fixAnswered(page: import('@playwright/test').Page, fixId: string, patch: (fix: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  await page.route(new RegExp(`/api/fixes/${fixId}[0-9A-Z]*(\\?.*)?$`), async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const answer = await route.fetch();
    // A read the page has already (304) keeps what it was given, patched.
    if (answer.status() !== 200) return route.fulfill({ response: answer });
    return route.fulfill({ response: answer, json: patch((await answer.json()) as Record<string, unknown>) });
  });
}

test('Run repair’s ask hands the accepted change over to a branch, and opens it as a pull request once one is named', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixId = demoId('emailFix');
  // Claude Code found, wherever the browser tests run: the ask's fields show.
  await fixAnswered(page, fixId, (fix) => ({ ...fix, repairer: { ...(fix.repairer as object), problem: null } }));
  let asked: Record<string, unknown> | null = null;
  await page.route(/\/api\/jobs$/, (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    asked = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'This fix moved on since the page read it.' }) });
  });
  await openPage(page, `/fixes/${fixId}`, 'fix');
  await page.locator('.ph .actions button', { hasText: 'Run repair' }).first().click();
  const dialog = page.locator('[role="dialog"][aria-modal="true"]');
  const pr = dialog.locator('.fxhand [role="switch"]');
  await expect(pr).toBeDisabled();
  await dialog.locator('.fxhand input').fill('fix/email-once');
  await pr.click();
  await expect(pr).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.locator('.dfacts')).toContainText('committed to fix/email-once and opened as a pull request with gh');
  await expect(dialog.locator('.cmdline')).toContainText('--branch fix/email-once --pr');
  await expectAccessible(page);
  await dialog.locator('.dlg-ok').click();
  // The page names the fix by its whole id, the demo by its short one.
  await expect.poll(() => asked).toMatchObject({ kind: 'repair', fixId: expect.stringMatching(new RegExp(`^${fixId}`)), branch: 'fix/email-once', pr: true });
});

test('a fix’s header links the pull request it merged with, and says what it spent on a card, as its other facts do', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixId = demoId('refundFix');
  const url = 'https://github.com/example/support-agent/pull/7';
  await fixAnswered(page, fixId, (fix) => ({ ...fix, rung: 'merged', pr: { number: 7, url, state: 'merged' } }));
  await openPage(page, `/fixes/${fixId}`, 'fix');
  const link = page.locator('main#view .ph p.pmeta .st a');
  await expect(link).toHaveText('PR #7');
  await expect(link).toHaveAttribute('href', url);
  await expect(link).toHaveAttribute('target', '_blank');
  const spent = page.locator('main#view .ph p.pmeta span[data-tip]', { hasText: /spent$/ });
  await expect(spent).toHaveText(/^(≈\$[\d.]+|<\$0\.0001|\$0) spent$/);
  expect(JSON.parse((await spent.getAttribute('data-tip'))!)).toMatchObject({ t: expect.stringMatching(/ spent on this fix$/) });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  await expectAccessible(page);
});
