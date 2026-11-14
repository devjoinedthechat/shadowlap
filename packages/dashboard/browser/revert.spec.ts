import { expect, test } from '@playwright/test';
import { FOUND, GOLDEN, NAME, REV, routeCrash, routeCrashFix, routeTests } from './crash-fixture.js';
import { openPage, seriousViolations } from './dashboard.js';
import { openReport } from './tests-fixture.js';

/**
 * Revert, once Find breaking commit named a crash's first bad commit, on the invented data of
 * crash-fixture.ts: on a crash's run page the commit's finding leads, Show change opens the change in
 * the inspector's place, and Revert leads the header with Open in editor and Run blame plain; on
 * Tests the change sits under the commit in the crash's report and Revert leads the verdict; on the
 * crash's fix its Blame step shows the commit, its change, the exception the agent died of and where
 * to look, and Revert leads its head with Open in editor beside it and no Find breaking commit. Each
 * has no serious axe violation at 1440 and 390 with the change open, nor has Revert's dialog, whose
 * code box of the change undone keeps to its width, with every file it undoes named and a change
 * bisect kept only the start of said so. A revert's drawer reads Reverting, then Reverted
 * where git reverted, its status not saying
 * reverted again, or Tried reverting where git refused.
 */

// A route may still be reading the server's answer as a test ends; the page's close takes it away, and that is no failure.
test.afterEach(({ page }) => page.unrouteAll({ behavior: 'ignoreErrors' }));

const DIALOG = '[role="dialog"][aria-modal="true"]';

for (const [width, height] of [
  [1440, 900],
  [390, 844],
] as const) {
  test(`at ${width}×${height} a named crash's run page leads with its commit and Revert, its change open in the inspector's place passing axe`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const run = await routeCrash(page);
    await openPage(page, `/run/${run}`, 'run');
    const finding = page.locator('#view section', { has: page.locator('.bk', { hasText: 'first bad commit' }) }).first();
    await expect(finding.locator('code').first()).toHaveText(REV);
    await expect(finding.locator('.why .lead')).toHaveText(FOUND.subject);
    const lead = page.locator('.rhead .btn.lime[data-next="revert"]');
    await expect(lead).toHaveText('Revert');
    const toggle = page.locator('#view [data-act="change"]');
    await toggle.click();
    const panel = page.locator('#insp.fpanel[data-kind="change"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.fhead .ct')).toHaveText('The change at the first bad commit');
    await expect(panel.locator('.bisectdiff')).toContainText('agent/refund.py');
    await expect(toggle).toHaveText('Hide change');
    expect(await seriousViolations(page)).toEqual([]);
    if (width === 1440) {
      // Run blame plain before Revert, lime and the last button but the menu; Open in editor before Run blame unless folded.
      const names = (await page.locator('.rhead .actions button:visible').allTextContents()).map((n) => n.trim());
      const at = (name: string) => names.findIndex((n) => n.startsWith(name));
      console.log(`a named crash's header at 1440: ${names.join(' | ')}`);
      expect(at('Run blame')).toBeGreaterThanOrEqual(0);
      expect(at('Run blame')).toBeLessThan(at('Revert'));
      if (at('Open in editor') >= 0) expect(at('Open in editor')).toBeLessThan(at('Run blame'));
      expect(names.slice(at('Revert') + 1).every((n) => n === '…' || n === '')).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(page.locator('#insp.fpanel')).toHaveCount(0);
    await expect(toggle).toBeFocused();
  });

  test(`at ${width}×${height} a named crash's fix shows the commit and its change on its Blame step and leads with Revert, passing axe`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const fix = await routeCrashFix(page);
    await openPage(page, `/fixes/${fix}/blame`, 'fix');
    const line = page.locator('#view .bisect.fxbis');
    await expect(line.locator('code')).toHaveText(REV);
    await expect(line.locator('b')).toHaveText(FOUND.subject);
    await expect(page.locator('#view .bisect.fxbis + .codewrap.bisectdiff')).toContainText('agent/refund.py');
    await expect(page.locator('#view .fxnote')).toHaveText(`The agent stopped part way from ${REV} on, so the code broke the run, not an answer of the model’s. Revert the commit or fix the code, then run the tests.`);
    // Under As recorded, the exception the agent died of where its code raised it, its traceback folded until found.
    const error = page.locator('#view .rperrw');
    await expect(error.locator('p.rperr')).toContainText("TypeError: limit() missing 1 required positional argument: 'order' in agent/refund.py, line 12, in refund");
    await expect(error.locator('pre.report.tail')).toHaveAttribute('hidden', 'until-found');
    const lead = page.locator('.ph .actions .btn.lime[data-next="revert"]');
    await expect(lead).toHaveText('Revert');
    await expect(lead).toHaveAttribute('data-at', String(FOUND.at));
    expect(await seriousViolations(page)).toEqual([]);
    if (width === 1440) {
      // Four, Revert lime and last with Open in editor before it; Find breaking commit stays on the run's page.
      const names = (await page.locator('.ph .actions button:visible').allTextContents()).map((n) => n.trim());
      console.log(`a named crash's fix head at 1440: ${names.join(' | ')}`);
      expect(names).toEqual(['Run repair', 'Run blame with stronger model…', 'Open in editor', 'Revert']);
      // They leave the title its 520px, so the head doesn't stack: the title and its buttons share a line.
      await expect(page.locator('.ph.fxh')).not.toHaveClass(/\bstack\b/);
      const title = await page.locator('.ph.fxh > :first-child').evaluate((h) => h.getBoundingClientRect().width);
      expect(title).toBeGreaterThanOrEqual(520);
    }
  });

  test(`at ${width}×${height} Revert's dialog shows the change it undoes in a code box that keeps to its width, passing axe`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const run = await routeCrash(page);
    await openPage(page, `/run/${run}`, 'run');
    await page.locator('.rhead .btn.lime[data-next="revert"]').click();
    const dialog = page.locator(DIALOG);
    await expect(dialog).toContainText(`Revert ${REV}?`);
    const box = dialog.locator('pre.codebox.fxpatch');
    await expect(box.locator('.add')).toHaveText('+     limit = policy.limit(order)');
    await expect(box.locator('.del')).toHaveText('−     limit = policy.limit()');
    // An added line's ground reaches the box's edges without widening it: nothing to scroll sideways.
    expect(await box.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    expect(await seriousViolations(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test(`at ${width}×${height} Revert's dialog names every file it undoes, whose change it shows, and that bisect kept only its start, passing axe`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const files = ['agent/refund.py', 'agent/policy.py', 'docs/refunds.md'];
    const run = await routeCrash(page, { ...FOUND, change: { ...FOUND.change!, files, cut: true } });
    await openPage(page, `/run/${run}`, 'run');
    await page.locator('.rhead .btn.lime[data-next="revert"]').click();
    const dialog = page.locator(DIALOG);
    const row = dialog.locator('.dfacts > div', { has: page.locator('dt', { hasText: /^Files$/ }) });
    await expect(row.locator('dd')).toContainText('agent/refund.py, agent/policy.py and docs/refunds.md');
    await expect(row.locator('dd')).toContainText('the change below is agent/refund.py’s');
    await expect(dialog.locator('.fieldnote')).toHaveText(`Its first lines only: git diff ${REV}^1 ${REV} -- agent/refund.py shows the whole change.`);
    expect(await seriousViolations(page)).toEqual([]);
  });

  test(`at ${width}×${height} Tests shows the commit's change under its card and leads with Revert, passing axe`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await routeTests(page);
    await openPage(page, '/tests', 'main#view table.gt');
    // The crash's report, folded under its row: open, the change sits under its first bad commit.
    await openReport(page, NAME);
    await expect(page.locator('#view .bisectdiff', { hasText: 'agent/refund.py' })).toBeVisible();
    await expect(page.locator('#view .btn.lime', { hasText: /^Revert$/ }).first()).toBeVisible();
    await expect(page.locator('#view')).toContainText('The agent stopped part way at the commit above: revert it or fix the code, then run the tests.');
    expect(await seriousViolations(page)).toEqual([]);
  });
}

test('a revert’s drawer reads Reverting, then Reverted once git reverted and the test ran, or Tried reverting where git refused', async ({ page }) => {
  const run = await routeCrash(page);
  const job = (git: 'done' | 'untouched', code: number | null, lines: string[]) => ({
    id: 'revertjob',
    kind: 'revert',
    title: `Reverting ${REV}`,
    args: ['test', GOLDEN],
    worktree: { folder: null, use: 'writes', doing: 'a commit is being reverted in your working tree' },
    runId: run,
    opensRun: false,
    startedAt: Date.now() - 1000,
    endedAt: code === null ? null : Date.now(),
    done: code !== null,
    stopped: false,
    code,
    git: code === null ? undefined : git,
    newRunId: null,
    runs: [],
    links: [],
    files: [],
    total: lines.length,
    lines,
    project: { id: 'support-agent', name: 'support-agent' },
  });
  const ends = [
    { git: 'done' as const, code: 1, lines: [`$ git revert --no-commit ${REV}`, `reverted ${REV} in your working tree · not committed`, `$ shadowlap test ${GOLDEN}`, '✗ 1 of 1 failed'], title: `Reverted ${REV}`, status: 'test failed · exit 1' },
    { git: 'untouched' as const, code: 128, lines: [`$ git revert --no-commit ${REV}`, 'error: Your local changes to the following files would be overwritten by merge:', '\tagent/refund.py'], title: `Tried reverting ${REV}`, status: 'not reverted · exit 128' },
  ];
  for (const end of ends) {
    let polls = 0;
    await page.unroute(/\/api\/jobs(\?.*)?$/);
    await page.unroute(/\/api\/jobs\/revertjob(\?.*)?$/);
    await page.route(/\/api\/jobs(\?.*)?$/, (route) => (route.request().method() === 'POST' ? route.fulfill({ status: 202, json: job(end.git, null, []) }) : route.fulfill({ json: { jobs: [] } })));
    await page.route(/\/api\/jobs\/revertjob(\?.*)?$/, (route) => route.fulfill({ json: ++polls >= 2 ? job(end.git, end.code, end.lines) : job(end.git, null, end.lines.slice(0, 1)) }));
    await openPage(page, `/run/${run}`, 'run');
    await page.locator('.rhead .btn.lime[data-next="revert"]').click();
    const dialog = page.locator(DIALOG);
    await expect(dialog).toContainText(`Revert ${REV}?`);
    await dialog.getByRole('button', { name: 'Revert', exact: true }).click();
    await expect(page.locator('#jtitle')).toHaveText(end.title);
    await expect(page.locator('section.drawer .st2').last()).toHaveText(end.status);
  }
});
