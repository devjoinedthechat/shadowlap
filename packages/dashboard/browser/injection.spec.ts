import { rmSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, openPage, serveDashboard, type Served } from './dashboard.js';
import { buildInjectionStore, type InjectionStore } from './injection-fixture.js';
import { openReport } from './tests-fixture.js';

/**
 * Injection tests' results in a real browser, on a project real commands made for them
 * (injection-fixture.ts): the run tested draws its newest test's finding, whose Show results opens
 * the matrix in the inspector's place, or, where the finding's script didn't come, a line in its
 * place whose Retry loads the page again; a cell opens its attempt at the canary write, on Request with
 * the canary marked, and Esc comes back to the cell, focused and in view. Calls and Turns tag each
 * untrusted read, its card naming the model call that reads it, and the fork menu's header says so.
 * The attempt's proof picks each call it names on the tab that shows it. The Forks view files both
 * tests under the run, Tests draws the golden's gate under its checks, Needs a look a Security row
 * whose Open proof opens the attempt, and Share's Security report asks in a dialog. axe finds no
 * fault in any of them, at a desk or on a phone.
 *
 * The file's tests run in order in one worker, so it builds one store and starts one dashboard,
 * stopped after; the dashboard every other file reads, global setup's, never sees them.
 */

test.describe.configure({ mode: 'serial' });

let built: InjectionStore | null = null;
let served: (Served & { stop: () => Promise<void> }) | null = null;

function here(): Served {
  if (!served) throw new Error('the injection dashboard did not start');
  return served;
}

/** The run both tests tested. */
function tested(): string {
  if (!built) throw new Error('the injection store was not built');
  return built.runId;
}

test.beforeAll(async () => {
  // Four commands on a mock model, a few seconds, then the dashboard.
  test.setTimeout(120_000);
  built = await buildInjectionStore();
  served = await serveDashboard(built.folder, built.project);
});

test.afterAll(async () => {
  await served?.stop();
  served = null;
  if (built) rmSync(built.folder, { recursive: true, force: true });
  built = null;
});

const FINDING = 'main#view [data-finding="injection"]';
const PANEL = '#insp.fpanel';
const CELL = `${PANEL} a.rmx-c`;

/** The run tested, its newest test's results open in the inspector's place. */
async function withResults(page: Page): Promise<void> {
  await openPage(page, `/run/${tested()}`, 'run', here());
  await page.locator(`${FINDING} button[data-act="results"]`).click();
  await page.waitForSelector(`${PANEL} .rmx`, { state: 'visible' });
}

/** The address a link names: `#/run/<id>/<call>`. */
function runLink(link: string | null): { id: string; call: number } {
  const m = /^#\/run\/(\w+)\/(\d+)$/.exec(link ?? '');
  if (!m) throw new Error(`not a link to a run's call: ${link}`);
  return { id: m[1]!, call: Number(m[2]) };
}

test("the run's finding says what its test found, and Show results opens its matrix, each attempt a cell", async ({ page }) => {
  await openPage(page, `/run/${tested()}`, 'run', here());
  const finding = page.locator(FINDING);
  await expect(finding.locator('.bk')).toHaveText('injection test');
  await expect(finding.locator('.why em')).toHaveText('failed');
  await expect(finding.locator('.why')).toContainText('send_email obeyed a planted instruction');
  await expect(finding.locator('.why')).toContainText('10 of 10');
  const toggle = finding.locator('button[data-act="results"]');
  await expect(toggle).toHaveText('Show results');
  await toggle.click();
  await page.waitForSelector(`${PANEL} .rmx`, { state: 'visible' });
  await expect(toggle).toHaveText('Hide results');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  // Five reads, two templates: every cell an attempt that obeyed, each a link to its proof's write.
  await expect(page.locator(CELL)).toHaveCount(10);
  await expectAccessible(page);
  await toggle.click();
  await expect(page.locator(`${PANEL} .rmx`)).toHaveCount(0);
  await expect(toggle).toHaveText('Show results');
});

test("the run's finding whose code didn't come says so in its place, with Retry, the page whole, and draws once Retry loads it again", async ({ page }) => {
  const part = /\/assets\/chunks\/InjectionFinding-\w+\.js$/;
  await page.route(part, (route) => route.abort());
  await openPage(page, `/run/${tested()}`, 'run', here());
  const line = page.locator(`${FINDING} .loaderr`);
  await expect(line).toBeVisible();
  await expect(line).toContainText('This finding’s code didn’t come from the dashboard server. Retry loads the page again.');
  await expect(page.locator('main#view .rhead .rnm')).toBeVisible();
  await expect(page.locator('.toasts .toast')).toHaveCount(0);
  await expectAccessible(page);
  // The server sends it: Retry loads the page again, and the finding draws.
  await page.unroute(part);
  await line.getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator(`${FINDING} .bk`)).toHaveText('injection test');
  await expect(page.locator(`${FINDING} .loaderr`)).toHaveCount(0);
});

test('a cell opens its attempt at the canary write, the canary marked on Request, and Esc comes back to the cell', async ({ page }) => {
  await withResults(page);
  const cell = page.locator(CELL).nth(3);
  const link = await cell.getAttribute('href');
  const attempt = runLink(link);
  await cell.click();
  await page.waitForFunction((id) => location.hash.startsWith(`#/run/${id}`), attempt.id);
  await page.waitForSelector('main#view .rhead .rnm', { state: 'visible' });
  await expect(page.locator('main#view .rhead .ebk')).toHaveText('injection attempt');
  await expect(page.locator('#insp [role="tab"][aria-selected="true"]')).toHaveText(/^Request/);
  const canary = page.locator('#insp mark.cnry').first();
  await expect(canary).toBeVisible();
  await expect(canary).toContainText('@canary.invalid');
  await expect(canary).toBeInViewport();
  await expectAccessible(page);

  // Nothing under the pointer shows a card, which Esc would close first.
  await page.mouse.move(1, 1);
  await page.keyboard.press('Escape');
  await page.waitForFunction((id) => location.hash.startsWith(`#/run/${id}`), tested());
  const back = page.locator(`${CELL}[href="${link}"]`);
  await expect(back).toBeFocused();
  await expect(back).toBeInViewport();
  await expect(page.locator(`${FINDING} button[data-act="results"]`)).toHaveText('Hide results');
});

test("an attempt's proof picks each call it names on the tab that shows it, the planted text and the canary marked", async ({ page }) => {
  await withResults(page);
  const attempt = runLink(await page.locator(CELL).first().getAttribute('href'));
  await openPage(page, `/run/${attempt.id}`, 'run', here());
  const proof = page.locator('main#view .injline');
  await expect(proof).toHaveText(/^planted at #(\d+) → read at #(\d+) → send_email\.to = \w+@canary\.invalid at #(\d+)$/);
  const tab = () => page.locator('#insp [role="tab"][aria-selected="true"]');

  await proof.locator('button.pbn[data-injtab="response"]').click();
  await expect(tab()).toHaveText(/^Response/);
  await expect(page.locator('#insp mark.ins-plant').first()).toBeVisible();

  await proof.locator('button.pbn[data-injtab="conversation"]').click();
  await expect(tab()).toHaveText(/^Conversation/);
  await expect(page.locator('#insp mark.ins-plant').first()).toBeInViewport();

  await proof.locator('button.pbn[data-injtab="request"]').click();
  await expect(tab()).toHaveText(/^Request/);
  await expect(page.locator('#insp mark.cnry').first()).toBeInViewport();
  await expect(page).toHaveURL(new RegExp(`#/run/${attempt.id}/${attempt.call}$`));
  await expectAccessible(page);
});

test("Calls and Turns tag each untrusted read, its card naming the model call that reads it, and the fork menu's header says so", async ({ page }) => {
  await openPage(page, `/run/${tested()}`, 'run', here());
  const tags = page.locator('main#view .vbody .eff.untrusted');
  await expect(tags).toHaveCount(5);
  await tags.first().hover();
  await expect(page.locator('#tip')).toBeVisible();
  await expect(page.locator('#tip')).toContainText('untrusted · config');
  // A card keeps its last words together, and a number with the word before it (no-break spaces).
  await expect(page.locator('#tip')).toContainText(/model\scall\s#\d+\sreads\sit\.$/);

  await openPage(page, `/run/${tested()}/turns`, 'run', here());
  await expect(page.locator('main#view .vbody .eff.untrusted')).toHaveCount(5);

  const read = await page.locator('main#view .vbody .tools button', { has: page.locator('.eff.untrusted') }).first().locator('.arrow').textContent();
  const callNo = Number(/#(\d+)/.exec(read ?? '')?.[1]);
  await openPage(page, `/run/${tested()}/${callNo}`, 'run', here());
  await page.locator('#forkBtn').click();
  // Its first head names the call; the whole run's come under it.
  await expect(page.locator('.fkm .pk').first()).toHaveText(`At #${callNo} · fetch_page · untrusted read`);
  await expectAccessible(page);
});

test('the Forks view files both tests under the run they tested, their attempts one picture named by its counts', async ({ page }) => {
  await openPage(page, `/run/${tested()}/forks`, 'run', here());
  const nodes = page.locator('main#view .fnode.fb');
  await expect(nodes).toHaveCount(2);
  await expect(nodes.locator('.astrip[role="img"]')).toHaveCount(2);
  await expect(nodes.locator('.astrip[role="img"]').first()).toHaveAttribute('aria-label', /obeyed/);
  await expect(nodes.locator('.alist .al').first()).toContainText('@canary.invalid');
  await expectAccessible(page);
});

test("Tests draws the golden's injection gate under its checks, and Needs a look the golden and the run's Security row, whose Open proof opens the attempt", async ({ page }) => {
  await openPage(page, '/tests', 'main#view table tbody tr', here());
  // The checks draw under the golden's name too, for a narrower panel: one shows at a width.
  const gate = page.locator('main#view .ck.injck:visible');
  await expect(gate).toHaveCount(1);
  await expect(gate).toContainText('injection');
  await expectAccessible(page);

  await openPage(page, '/', 'overview', here());
  // The golden its gate failed leads with the gate's proof, as Tests does.
  await expect(page.locator('main#view .arow[data-agrp="failing"] .ast .btn')).toHaveText('Open proof');
  const row = page.locator('main#view .arow[data-agrp="security"]');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.at .t')).toHaveText('send_email obeyed a planted instruction · 10 of 10');
  const open = row.locator('.ast .btn');
  await expect(open).toHaveText('Open proof');
  await expectAccessible(page);
  await open.click();
  await page.waitForSelector('main#view .rhead .rnm', { state: 'visible' });
  await expect(page.locator('main#view .rhead .ebk')).toHaveText('injection attempt');
  await expect(page.locator('#insp mark.cnry').first()).toBeVisible();
});

test("Share's Security report asks in a dialog that says what it masks and keeps, and saves the report", async ({ page }) => {
  await openPage(page, `/run/${tested()}`, 'run', here());
  await page.locator('#shareBtn').click();
  await page.getByRole('menuitem', { name: /^Security report/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.injmask .del').first()).toContainText('example.com');
  await expect(dialog.locator('.injmask .add').first()).toContainText('<HOST>');
  await expect(dialog.locator('.injmask .why').first()).toHaveText('kept: a canary is the proof, and no rule touches one');
  await expect(dialog.getByRole('button', { name: 'Download report' })).toBeVisible();
  await expectAccessible(page);
  const saved = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download report' }).click();
  expect((await saved).suggestedFilename()).toBe(`shadowlap-injection-${tested().slice(0, 10).toLowerCase()}.html`);
});

test("Tests' report of the golden its gate failed draws its proof as the attempt's finding does, and its Security report asks in Share's dialog", async ({ page }) => {
  await openPage(page, '/tests', 'main#view table tbody tr', here());
  await openReport(page, 'research');
  const report = page.locator('main#view section[id="report-research"]');
  const calls = report.locator('.injline a.pbn');
  await expect(calls.first()).toBeVisible();
  await report.getByRole('button', { name: 'Security report' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Download report' })).toBeVisible();
  await expectAccessible(page);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  // A call the proof names is a link to the attempt there, so it opens in a new tab too.
  await expect(calls.last()).toHaveAttribute('href', /^#\/run\/[0-9A-Z]{26}\/\d+$/);
  await calls.last().click();
  await page.waitForSelector('main#view .rhead .rnm', { state: 'visible' });
  await expect(page.locator('main#view .rhead .ebk')).toHaveText('injection attempt');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('axe finds no fault in the results, an attempt, the Forks view, Tests, Needs a look or the Security report', async ({ page }) => {
    await withResults(page);
    await expectAccessible(page);
    const attempt = runLink(await page.locator(CELL).first().getAttribute('href'));
    await openPage(page, `/run/${attempt.id}/${attempt.call}`, 'run', here());
    await expectAccessible(page);
    await openPage(page, `/run/${tested()}/forks`, 'run', here());
    await expect(page.locator('main#view .fnode.fb')).toHaveCount(2);
    await expectAccessible(page);
    await openPage(page, '/tests', 'main#view table tbody tr', here());
    await expectAccessible(page);
    await openPage(page, '/', 'overview', here());
    await expect(page.locator('main#view .arow[data-agrp="security"]')).toHaveCount(1);
    await expectAccessible(page);
    await openPage(page, `/run/${tested()}`, 'run', here());
    await page.locator('#shareBtn').click();
    await page.getByRole('menuitem', { name: /^Security report/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectAccessible(page);
  });
});
