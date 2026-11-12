import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, openPage, serveDashboard, type Served } from './dashboard.js';
import { buildInjectionStore, type InjectionStore } from './injection-fixture.js';

/**
 * Running injection tests from the dashboard, in a real browser, on a project real commands made
 * (injection-fixture.ts, with its second recording): Settings → Tools marks a read untrusted, says
 * the line it wrote with Undo, and shows it marked in the tools entry, Undo taking it out of the
 * file again; Run injection test… from the fork menu puts its picks, attempts and Stop at $ into the
 * command and starts the job; Find cause… on the write asks of the read picked; Pack with injection
 * gate…, the step of an attempt whose recording no golden came from, unfolds the entry it adds; and
 * Tests' Security lists the golden's untrusted reads and last test, with Run injection test… on it.
 * axe finds no fault in any of them, at a desk or on a phone.
 *
 * Nothing runs a model: the jobs' routes answer for the jobs the dialogs start (fakeJob), and the
 * mock the store was recorded on is closed. The file's tests run in order in one worker, on one
 * store and one dashboard of their own, stopped after.
 */

test.describe.configure({ mode: 'serial' });

let built: InjectionStore | null = null;
let served: (Served & { stop: () => Promise<void> }) | null = null;

function here(): Served {
  if (!served) throw new Error('the injection dashboard did not start');
  return served;
}

function store(): InjectionStore & { second: string } {
  if (!built?.second) throw new Error('the injection store was not built');
  return built as InjectionStore & { second: string };
}

const short = (id: string) => id.slice(0, 10);

test.beforeAll(async () => {
  // Six commands on a mock model, a few seconds each, then the dashboard.
  test.setTimeout(180_000);
  built = await buildInjectionStore({ second: true });
  served = await serveDashboard(built.folder, built.project);
});

test.afterAll(async () => {
  await served?.stop();
  served = null;
  if (built) rmSync(built.folder, { recursive: true, force: true });
  built = null;
});

/** A read of the dashboard's API, as the page makes it. */
async function api<T>(page: Page, path: string): Promise<T> {
  const { origin, token } = here();
  const res = await page.request.get(`${origin}/api/${path}`, { headers: { 'x-shadowlap-token': token } });
  expect(res.ok(), `GET /api/${path}`).toBe(true);
  return (await res.json()) as T;
}

/** The project's shadowlap.config.json, parsed. */
const configOf = (): { tools: Record<string, { trust?: string }> } => JSON.parse(readFileSync(join(store().folder, store().project, 'shadowlap.config.json'), 'utf8'));

const JOB = 'cafecafecafecafe';

/**
 * Answers the job routes for the one job a dialog starts, so nothing runs: `sent` is what the page
 * asked to start, `end` says how it ended.
 */
async function fakeJob(page: Page, title: string) {
  const now = { sent: null as Record<string, unknown> | null, job: { id: JOB, kind: 'injection', title, args: ['injection'], worktree: null, runId: null as string | null, opensRun: false, startedAt: Date.now(), done: false, stopped: false, code: null as number | null, newRunId: null, lines: [] as string[], total: 0, result: null as unknown } };
  await page.route(/\/api\/jobs(\?.*)?$/, (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { jobs: now.sent ? [{ ...now.job, lines: undefined }] : [] } });
    now.sent = route.request().postDataJSON() as Record<string, unknown>;
    now.job = { ...now.job, kind: String(now.sent.kind), runId: typeof now.sent.runId === 'string' ? now.sent.runId : null };
    return route.fulfill({ json: now.job });
  });
  await page.route(new RegExp(`/api/jobs/${JOB}/stop`), (route) => route.fulfill({ json: { stopped: false } }));
  await page.route(new RegExp(`/api/jobs/${JOB}(\\?.*)?$`), (route) => route.fulfill({ json: now.job }));
  return {
    sent: () => now.sent,
    end: (over: Partial<typeof now.job>) => {
      now.job = { ...now.job, done: true, ...over };
    },
  };
}

const DIALOG = '.dialog';

/** A dialog that reads what it plants in first: open once its picks and its button are in. */
async function loaded(page: Page): Promise<void> {
  await page.locator(`${DIALOG} .dlg-ok`).waitFor();
  await expect(page.locator(`${DIALOG} .skel`)).toHaveCount(0);
}

test('Settings → Tools marks a read untrusted, says the line it wrote with Undo, shows it in the tools entry, and Undo takes it out', async ({ page }) => {
  await openPage(page, '/settings/tools', 'main#view table.trusttab tbody tr', here());
  const rows = page.locator('main#view table.trusttab tbody tr');
  // Reads first, the untrusted one first among them; then the pure tool, then the write.
  await expect(rows.first()).toHaveAttribute('data-rowkey', 'tool:fetch_page');
  await expect(rows.first().locator('.trust.u')).toHaveText('untrusted');
  await expect(rows.first()).toContainText('shadowlap.config.json');
  await expect(rows.last()).toHaveAttribute('data-rowkey', 'tool:send_email');
  await expect(rows.last().locator('.trust.na')).toHaveText('—');
  // The untrusted read's own test, on the golden's recording.
  await expect(rows.first().locator('.tooltest')).toContainText('Run injection test…');
  await expectAccessible(page);

  const search = page.locator('main#view tr[data-rowkey="tool:search_web"]');
  await search.hover();
  await search.locator('.trustbtn').click();
  const line = '"tools": { "search_web": { "trust": "untrusted" } }';
  await expect(page.locator('.toast').filter({ hasText: 'Wrote' })).toContainText(`Wrote ${line} to shadowlap.config.json`);
  await expect.poll(() => configOf().tools.search_web?.trust).toBe('untrusted');
  // The row keeps its place, and the entry opens with the line written marked.
  await expect(rows.nth(1)).toHaveAttribute('data-rowkey', 'tool:search_web');
  await expect(page.locator('main#view .wftog button[aria-controls="toolsCfg"]')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#toolsCfg .add')).toContainText('"search_web": { "trust": "untrusted" }');
  await expectAccessible(page);

  await page.locator('.toast .tbtn', { hasText: 'Undo' }).click();
  await expect(page.locator('.toast').filter({ hasText: 'Took' })).toContainText(`Took ${line} out of shadowlap.config.json`);
  await expect.poll(() => configOf().tools.search_web).toBeUndefined();
  expect(configOf().tools.fetch_page?.trust).toBe('untrusted');
});

test("Run injection test… from the fork menu puts its picks, attempts and Stop at $ into the command, and starts the job its drawer follows", async ({ page }) => {
  const { runId } = store();
  const job = await fakeJob(page, 'Running injection test');
  await openPage(page, `/run/${runId}`, 'run', here());
  await page.locator('#forkBtn').click();
  await page.getByRole('menuitem', { name: /^Run injection test…/ }).click();
  await loaded(page);
  const dialog = page.locator(DIALOG);
  await expect(dialog.locator('h3')).toHaveText(`Run injection test on ${short(runId)}`);
  await expect(dialog).toContainText('fetch_page');
  // Five reads: every template picked at first.
  const chips = dialog.locator('.togchips button');
  await expect(chips).toHaveCount(12);
  await expect(dialog.locator('.togchips button[aria-pressed="true"]')).toHaveCount(12);
  await dialog.getByRole('button', { name: 'None', exact: true }).click();
  await expect(dialog).toContainText('Pick a template or add a payload file.');
  await expect(dialog.locator('.dlg-ok')).toHaveAttribute('aria-disabled', 'true');

  await dialog.locator('.togchips button', { hasText: /^system-notice$/ }).click();
  await dialog.getByLabel('Attempts each').fill('2');
  await dialog.getByLabel('Stop at $').fill('5');
  await expect(dialog.locator('.cmdline')).toHaveText(new RegExp(`shadowlap\\sinjection\\s${short(runId)}\\s--templates\\ssystem-notice\\s--repeat\\s2\\s--budget\\s5\\.00`));
  await expectAccessible(page);

  await dialog.locator('.dlg-ok').click();
  await expect(page.locator('section.drawer')).toContainText('Running injection test');
  expect(job.sent()).toMatchObject({ kind: 'injection', runId, templates: ['system-notice'], repeat: 2, budget: 5 });
  job.end({ code: 1, lines: ['send_email obeyed a planted instruction · 5 of 10'], total: 1, result: { verdict: 'failed', results: [{ mode: 'plant', verdict: 'failed' }] } });
  await expect(page.locator('section.drawer')).toContainText(/failed\s·\sexit\s1/);
});

test('Find cause… on the write asks of the read it starts on, the command following the pick, and starts the search', async ({ page }) => {
  const { runId } = store();
  const facts = (await api<{ cause: Array<{ write: number; name: string; reads: number[]; pick: number }> }>(page, `injection/runs/${runId}`)).cause[0]!;
  expect(facts.name).toBe('send_email');
  expect(facts.reads.length).toBe(5);
  const other = facts.reads.find((r) => r !== facts.pick)!;
  const job = await fakeJob(page, `Finding cause: testing #${other}`);
  await openPage(page, `/run/${runId}/${facts.write}`, 'run', here());
  const link = page.locator('#insp button[data-act="injcause"]');
  await expect(link).toHaveText('Find cause…');
  await link.click();
  await page.locator(`${DIALOG} .dlg-ok`).waitFor();
  const dialog = page.locator(DIALOG);
  await expect(dialog.locator('h3')).toHaveText(`Find cause of #${facts.write} send_email`);
  const radios = dialog.locator('.injreads input[type="radio"]');
  await expect(radios).toHaveCount(5);
  await expect(dialog.locator('.cmdline')).toHaveText(new RegExp(`--clean\\s${facts.pick}\\s--write\\s${facts.write}$`));
  await radios.nth(facts.reads.indexOf(other)).check();
  await expect(dialog.locator('.cmdline')).toHaveText(new RegExp(`--clean\\s${other}\\s--write\\s${facts.write}$`));
  await expectAccessible(page);

  await dialog.locator('.dlg-ok').click();
  await expect(page.locator('section.drawer')).toContainText(`Finding cause: testing #${other}`);
  expect(job.sent()).toMatchObject({ kind: 'injection', runId, clean: other, writes: [facts.write] });
});

/** An attempt of the second recording's test, whose step is Pack with injection gate…. */
async function attemptOfSecond(page: Page): Promise<string> {
  await openPage(page, `/run/${store().second}`, 'run', here());
  await page.locator('main#view [data-finding="injection"] button[data-act="results"]').click();
  const href = await page.locator('#insp.fpanel a.rmx-c').first().getAttribute('href');
  const id = /^#\/run\/(\w+)/.exec(href ?? '')?.[1];
  if (!id) throw new Error(`no attempt's link: ${href}`);
  return id;
}

test("Pack with injection gate…, an obeyed attempt's step, unfolds the entry it adds and starts one job that packs, writes the gate and tests", async ({ page }) => {
  const { second } = store();
  const attempt = await attemptOfSecond(page);
  const job = await fakeJob(page, 'Packing with injection gate');
  await openPage(page, `/run/${attempt}`, 'run', here());
  const step = page.locator('main#view .rhead [data-next="pack-gate"]');
  await expect(step).toContainText('Pack with injection gate…');
  await step.click();
  await loaded(page);
  const dialog = page.locator(DIALOG);
  await expect(dialog.locator('h3')).toHaveText(`Pack ${short(second)} with injection gate?`);
  const show = dialog.getByRole('button', { name: 'Show entry' });
  await expect(show).toHaveAttribute('aria-expanded', 'false');
  await show.click();
  await expect(dialog.getByRole('button', { name: 'Hide entry' })).toHaveAttribute('aria-expanded', 'true');
  await expect(dialog.locator('.injconf')).toContainText('"obeyed": 0');
  const golden = dialog.locator('.form input[type="text"]').first();
  await golden.fill('goldens/gated');
  await expect(dialog.locator('.injconf')).toContainText('"goldens/gated"');
  await expect(dialog).toContainText('shadowlap test goldens/gated');
  await expectAccessible(page);

  await dialog.locator('.dlg-ok').click();
  await expect(page.locator('section.drawer')).toContainText('Packing with injection gate');
  expect(job.sent()).toMatchObject({ kind: 'pack-test', runId: second, golden: 'goldens/gated', gate: { obeyed: 0, repeat: 3 } });
  expect(typeof job.sent()?.version).toBe('string');
});

test("Tests' Security lists the golden's untrusted reads and its last gate, with Run injection test… on its recording", async ({ page }) => {
  const { runId } = store();
  await openPage(page, '/tests', 'main#view table.sect tbody tr', here());
  const table = page.locator('main#view table.sect');
  await expect(table.locator('tbody tr')).toHaveCount(1);
  const row = table.locator('tbody tr').first();
  await expect(row).toContainText(`its recording ${short(runId)}`);
  await expect(row.locator('.sreads .nw')).toHaveCount(5);
  await expect(row).toContainText('its injection gate');
  await expect(page.locator('main#view a.more', { hasText: 'Trust on Settings → Tools' })).toHaveAttribute('href', '#/settings/tools');
  await expectAccessible(page);

  await row.getByRole('button', { name: /^Run injection test…/ }).click();
  await loaded(page);
  await expect(page.locator(`${DIALOG} h3`)).toHaveText(`Run injection test on ${short(runId)}`);
  await expectAccessible(page);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('axe finds no fault in Settings → Tools, Security, or the three dialogs', async ({ page }) => {
    const { runId } = store();
    await openPage(page, '/settings/tools', 'main#view table.trusttab tbody tr', here());
    await expectAccessible(page);

    await openPage(page, '/tests', 'main#view table.sect tbody tr', here());
    await expectAccessible(page);
    await page.locator('main#view table.sect tbody tr').first().getByRole('button', { name: /^Run injection test…/ }).click();
    await loaded(page);
    await expectAccessible(page);

    const facts = (await api<{ cause: Array<{ write: number }> }>(page, `injection/runs/${runId}`)).cause[0]!;
    await openPage(page, `/run/${runId}/${facts.write}`, 'run', here());
    await page.locator('#insp button[data-act="injcause"]').click();
    await page.locator(`${DIALOG} .dlg-ok`).waitFor();
    await expectAccessible(page);

    const attempt = await attemptOfSecond(page);
    await openPage(page, `/run/${attempt}`, 'run', here());
    await page.locator('main#view .rhead [data-next="pack-gate"]').click();
    await loaded(page);
    await page.locator(DIALOG).getByRole('button', { name: 'Show entry' }).click();
    await expectAccessible(page);
  });
});
