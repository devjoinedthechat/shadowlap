import { expect, test, type Locator, type Page } from '@playwright/test';
import { demoId, expectAccessible, openPage } from './dashboard.js';

/**
 * The check builder in a real browser, wide and as a phone's sheet: Add check… first in a tool
 * call's row menu and on the inspector's summary line, never in the head's Fork menu or a model
 * call's; the check menu at the call; each kind built; a refusal in parseExpect's words, Save off
 * with it; the scrim ignored; Esc closing a builder as it opened and asking once a rule changed;
 * Suggested above The change, a rule taken with Use rule and a failed read with Retry; and Save's
 * 409, 400 and success answered by page.route, so nothing is written to the demo every test shares.
 */

const DIALOG = '[role="dialog"][aria-modal="true"]';
const MENU = '.pop[role="menu"]';
const TOOL = 'main#view tr[data-wi]:has(td.name[title="issue_refund"])';
const WRITE = /\/api\/checks\/tests$/;
const SIZES = [
  [1440, 900],
  [390, 844],
] as const;

/** The refund-bug recording's page with #6 issue_refund picked, as the inspector shows it at either width. */
async function atTheCall(page: Page): Promise<Locator> {
  await openPage(page, `/run/${demoId('refundBug')}`, 'run');
  await page.locator(TOOL).first().click();
  const link = page.locator('[data-act="ckmenu"]');
  await expect(link).toBeVisible();
  return link;
}

/** The builder opened from the inspector's Add check… with the check menu's `pick`, once its golden's checks are in. */
async function openBuilder(page: Page, link: Locator, pick: string): Promise<Locator> {
  await link.click();
  await page.locator(`${MENU}.ckm [role="menuitem"]`, { hasText: pick }).click();
  const dialog = page.locator(DIALOG);
  await expect(dialog.locator('.cb-kinds')).toBeVisible();
  return dialog;
}

/** The rule being built, as its row in the golden's checks reads it. */
const building = (dialog: Locator) => dialog.locator('.cb-units li.on .cb-ul');

const SUGGEST = /\/api\/checks\/suggestions$/;
/** Suggestions as the engine answers them, each labelled as checkLabels labels it, so the builder's own labels leave a used one out. */
const SUGGESTIONS = [
  { shape: 'value', expect: { calls: [{ tool: 'issue_refund', args: { amount: { '<=': '@get_policy.result.limit' } } }] }, label: 'every issue_refund call: amount <= get_policy.result.limit' },
  { shape: 'when', expect: { when: [{ if: { tool: 'lookup_order', result: { amount: { '>': 100 } } }, then: { tools: { issue_refund: 0 } } }] }, label: 'when lookup_order has result.amount > 100: issue_refund called 0 times' },
  { shape: 'order', expect: { calls: [{ tool: 'send_email', after: 'issue_refund' }] }, label: 'every send_email call: after issue_refund' },
] as const;
const labelsOf = (from: number) => SUGGESTIONS.slice(from).map((s) => s.label);
/** The section, by its head: its buttons are named within it, as a golden's checks have an Add rule of their own. */
const suggested = (dialog: Locator) => dialog.locator('section.cb-sec', { has: dialog.page().locator('.k', { hasText: /^Suggested$/ }) });

test('Add check… comes first in a tool call’s row menu and on the inspector’s line, never in the head’s Fork menu or a model call’s', async ({ page }) => {
  await openPage(page, `/run/${demoId('refundBug')}`, 'run');
  // The head's Fork menu forks the run: no check is made from it.
  await page.locator('#forkBtn').click();
  await expect(page.locator(MENU)).toBeVisible();
  await expect(page.locator(`${MENU} [role="menuitem"]`, { hasText: 'Add check' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  // A model call's row menu forks it, with no Add check….
  const model = page.locator('main#view tr[data-wi]:has(td.name[title^="POST "])').first();
  await model.click();
  await model.locator('button[aria-label^="Fork at #"]').click();
  await expect(page.locator(MENU)).toBeVisible();
  await expect(page.locator(`${MENU} [role="menuitem"]`, { hasText: 'Add check' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  // A tool call's row menu leads with it, and it opens the check menu at the call.
  const tool = page.locator(TOOL).first();
  await tool.click();
  await tool.locator('button[aria-label^="Fork at #"]').click();
  const first = page.locator(`${MENU} [role="menuitem"]`).first();
  await expect(first).toHaveText('Add check…');
  await first.click();
  const menu = page.locator(`${MENU}.ckm`);
  await expect(menu.locator('.pk').first()).toHaveText('Add check · #6 issue_refund');
  await expect(menu.locator('[role="menuitem"] b')).toHaveText(['Never call issue_refund', 'Never with these arguments', 'Must call with order_id = …', 'Only after…', 'Amount at most…', 'When… then…', 'Ask a judge…']);
  await expect(menu.locator('[role="menuitem"] small').first()).toHaveText('tools');
  await expectAccessible(page);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  // The inspector's Add check…, on its summary line before Edit and fork…, opens the same menu at itself.
  const link = page.locator('[data-act="ckmenu"]');
  await expect(link).toHaveText('Add check…');
  await link.click();
  await expect(menu.locator('[role="menuitem"]')).toHaveCount(7);
});

for (const [width, height] of SIZES) {
  test(`at ${width}px the builder starts on the kind picked, builds each kind, ignores its scrim, and asks before Esc drops a change`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const link = await atTheCall(page);
    let dialog = await openBuilder(page, link, 'Never call issue_refund');
    await expect(dialog).toHaveAccessibleName('Add check');
    const pressed = dialog.locator('.cb-kinds [aria-pressed="true"]');
    await expect(pressed).toHaveText('Never');
    await expect(pressed).toBeFocused();
    // The golden already counts issue_refund 0 times: nothing to write, Save off and saying why.
    await expect(building(dialog)).toHaveText('issue_refund called 0 times');
    const save = dialog.getByRole('button', { name: 'Save check' });
    await expect(save).toHaveAttribute('data-why', 'Nothing changed yet');
    await expect(dialog.locator('.cb-sec').last()).toContainText('Nothing to write yet: shadowlap.config.json, version');
    await expectAccessible(page);
    // A press on the scrim never closes it; Esc closes it unchanged, the focus back on Add check….
    await page.mouse.click(5, 5);
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(link).toBeFocused();

    // The change marks only what goes and comes: the file's `tests` and the entries around stay unmarked.
    dialog = await openBuilder(page, link, 'Must call with order_id = …');
    const lines = dialog.locator('.cb-file pre.codebox > span');
    await expect(lines.first()).toContainText('"tests": {');
    await expect(lines.first()).not.toHaveClass(/add|del/);
    await expect(lines.filter({ hasText: '"order_id"' }).first()).toHaveClass('add');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    dialog = await openBuilder(page, link, 'Amount at most…');
    await expect(pressed).toHaveText('Every call');
    const way = dialog.locator('.dlg-ways button, footer button').filter({ hasText: /^Save/ });
    // Each kind builds its sentence from the call, and the golden's checks read it as main labels it.
    const kinds: Array<[string, string]> = [
      ['Must call', 'issue_refund with {"order_id":"A-1042"} called at least 1 time'],
      ['When… then', 'when lookup_order has result.amount > 100: issue_refund called 0 times'],
    ];
    for (const [kind, label] of kinds) {
      await dialog.locator('.cb-kinds button', { hasText: kind }).click();
      await expect(pressed).toHaveText(kind);
      await expect(building(dialog)).toHaveText(label);
      await expect(way).not.toHaveAttribute('aria-disabled', 'true');
      await expectAccessible(page);
    }
    // A judge with no question yet: its row says what it lacks, and there is nothing to write.
    await dialog.locator('.cb-kinds button', { hasText: 'Ask a judge' }).click();
    await expect(building(dialog)).toHaveText('Ask it a question it answers yes or no');
    await expect(dialog.getByRole('textbox', { name: 'The question it answers yes or no' })).toBeVisible();
    await expect(dialog.locator('.dcost')).toContainText('Billed by your provider');
    await expect(way).toHaveAttribute('data-why', 'Nothing changed yet');
    await expectAccessible(page);
    // JSON takes what has no form, refused in parseExpect's words on its rule, Save off with them.
    await dialog.locator('.cb-kinds button', { hasText: 'JSON' }).click();
    const json = dialog.getByRole('textbox', { name: 'The expect object' });
    await json.fill('{"tools": {"issue_refund": "often"}}');
    const refusal = 'expect.tools["issue_refund"] must be a count such as 0, ">= 1", "<= 12" or "2-4"';
    await expect(dialog.locator('.cb-units li.bad .cb-ul')).toHaveText(refusal);
    await expect(way).toHaveAttribute('data-why', refusal);
    await expectAccessible(page);
    // A changed rule: Esc asks first, and a second Esc keeps editing.
    await json.fill('{"cost": "<= 0.05"}');
    await page.keyboard.press('Escape');
    await expect(dialog.locator('.dlgask')).toHaveText('Discard what you changed?');
    await expect(dialog.locator('.dlg-keep')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog.locator('.dlgask')).toHaveCount(0);
    await expect(json).toHaveValue('{"cost": "<= 0.05"}');
    await page.keyboard.press('Escape');
    await dialog.locator('.dlg-discard').click();
    await expect(dialog).toHaveCount(0);
    await expect(link).toBeFocused();
  });

  test(`at ${width}px Save writes against the version read: a 409 reads the file again and saves again, a 400 says the server’s words, and a save closes it with a toast`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const link = await atTheCall(page);
    const dialog = await openBuilder(page, link, 'Never call issue_refund');
    await dialog.locator('.cb-kinds button', { hasText: 'JSON' }).click();
    await dialog.getByRole('textbox', { name: 'The expect object' }).fill('{"cost": "<= 0.05"}');
    const save = dialog.locator('.dlg-ways button, footer button').filter({ hasText: /^Save/ });
    await expect(save).toHaveText('Save check');
    await expect(save).not.toHaveAttribute('aria-disabled', 'true');
    const sent: unknown[] = [];
    // Changed on disk since it was read: the file is read again, its change shown against it, and Save says Save again.
    await page.route(WRITE, (route) => {
      sent.push(route.request().postDataJSON());
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'shadowlap.config.json changed on disk since this page read it: "prices" added. It shows your change against the file as it is now; nothing was changed.' }) });
    });
    await save.click();
    await expect(dialog.locator('.cb-warn')).toContainText('"prices" added');
    await expect(save).toHaveText('Save again');
    // Sent with the version read and the prints of what it read, for the server to name what changed.
    // The golden is the demo's own, named by the run it was packed from: read from what was sent.
    const golden = (sent[0] as { golden?: unknown }).golden;
    expect(golden).toMatch(/^goldens\//);
    const path = String(golden);
    expect(sent[0]).toMatchObject({ golden: path, version: expect.stringMatching(/^[0-9a-f]{8,}$/), read: { tests: { [path]: expect.any(String) } }, entry: { expect: { cost: '<= 0.05' } } });
    await expectAccessible(page);
    // Refused by the server: its words in the dialog's amber line, the rule kept.
    await page.unroute(WRITE);
    await page.route(WRITE, (route) => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'tests["goldens/refund-in-limit"].expect.tools.send_email must be a count, such as 1 or "<= 2"' }) }));
    await save.click();
    await expect(dialog.locator('.dwarn')).toContainText('goldens/refund-in-limit');
    await expect(dialog).toBeVisible();
    // Save stays off on the server's words until something changes.
    await expect(save).toHaveAttribute('aria-disabled', 'true');
    await expect(save).toHaveAttribute('data-why', /goldens\/refund-in-limit/);
    await expectAccessible(page);
    // Written: it closes, says where, and the focus is back on Add check….
    await page.unroute(WRITE);
    await page.route(WRITE, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ key: path, version: '0123abcd', added: ['cost at most 0.05'], removed: [], changed: [] }) }));
    await dialog.getByRole('textbox', { name: 'The expect object' }).fill('{"cost": "<= 0.04"}');
    await expect(save).not.toHaveAttribute('aria-disabled', 'true');
    await save.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.toast')).toContainText(`Saved to shadowlap.config.json · ${path}`);
    await expect(link).toBeFocused();
    await page.unroute(WRITE);
  });

  test(`at ${width}px Suggested shows rules that fail the recording and none of its good runs above The change: Use rule takes one in place of the rule built, its row goes with the focus on the next, and a failed read says so with Retry`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const run = demoId('refundBug');
    const asked: Array<{ have?: string[] }> = [];
    let failing = false;
    await page.route(SUGGEST, (route) => {
      asked.push(route.request().postDataJSON() as { have?: string[] });
      if (failing) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'the read beside the server stopped' }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runId: run, goods: ['01K5CQ1AAAAAAAAAAAAAAAAAAA', '01K5CQ2BBBBBBBBBBBBBBBBBBB'], suggestions: SUGGESTIONS }) });
    });
    const link = await atTheCall(page);
    const dialog = await openBuilder(page, link, 'Never call issue_refund');
    const section = suggested(dialog);
    const rules = section.locator('li.cb-sug code');
    await expect(rules).toHaveText(labelsOf(0));
    await expect(section.locator('.cb-sub')).toHaveText(`each fails ${run.slice(0, 10)} and none of your 2 good runs`);
    // Asked from the call, with the labels the builder holds: the golden's checks and the rule being built.
    expect(asked[0]).toEqual({ run, at: 6, have: expect.arrayContaining(['issue_refund called 0 times', 'escalate called 1 time']) });
    // Between the recordings judged and The change, which stays the builder's last section.
    await expect(dialog.locator('.cb-sec').last()).toContainText('shadowlap.config.json');
    await expectAccessible(page);
    // Use rule puts the first in place of the rule being built, nothing saved: its row goes, the focus on the rule in its place.
    await section.locator('li.cb-sug').first().getByRole('button', { name: 'Use rule' }).click();
    await expect(building(dialog)).toHaveText(SUGGESTIONS[0].label);
    await expect(rules).toHaveText(labelsOf(1));
    await expect(section.locator('li.cb-sug').first().getByRole('button', { name: 'Use rule' })).toBeFocused();
    // Asked again with it among the labels the builder holds.
    await expect.poll(() => asked.at(-1)?.have).toContain(SUGGESTIONS[0].label);
    await expectAccessible(page);
    // A failed read, the first included, says so in the section with Retry, which reads it again.
    await page.keyboard.press('Escape');
    await dialog.locator('.dlg-discard').click();
    await expect(dialog).toHaveCount(0);
    failing = true;
    // Opened again, the same dialog: its locators find it.
    await openBuilder(page, link, 'Never call issue_refund');
    await expect(section.locator('.loaderr')).toContainText('the read beside the server stopped');
    await expect(rules).toHaveCount(0);
    await expectAccessible(page);
    failing = false;
    await section.getByRole('button', { name: 'Retry' }).click();
    await expect(rules).toHaveText(labelsOf(0));
    await expect(section.locator('.loaderr')).toHaveCount(0);
    await page.unroute(SUGGEST);
  });
}
