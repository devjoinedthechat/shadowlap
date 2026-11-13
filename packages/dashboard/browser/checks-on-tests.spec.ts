import { expect, test, type Locator, type Page } from '@playwright/test';
import type { CheckView, GoldenRow, TestsView } from '../ui/types.js';
import { dash, demoId, expectAccessible, openPage } from './dashboard.js';

/**
 * A golden's checks on Tests, and a run's judge verdicts, in a real browser, wide and on a phone:
 * Edit and Remove at the end of each check, Add check… after the last, shown on the row's hover or
 * focus, each target 24px from the next; below 840px of room the line of Edit checks… and Add check…
 * in their place; Remove's dialog with the lines that leave the file, its write and its toast's Undo
 * answered by page.route, so the demo's file, which every test shares, is never written; a golden
 * whose checks changed since and one whose recording fails a check added since, which the demo has
 * neither of; and a run's judge verdicts among its findings, which the demo has no judge for. axe
 * holds each at no serious or critical violation of WCAG 2.2 AA.
 */

// A route may still be reading the server's answer as a test ends; the page's close takes it away, and that is no failure.
test.afterEach(({ page }) => page.unrouteAll({ behavior: 'ignoreErrors' }));

const GOLDEN = 'goldens/refund-in-limit';
const NAME = 'refund-in-limit';
const DIALOG = '[role="dialog"][aria-modal="true"]';
const WRITE = /\/api\/checks\/tests$/;
const UNDO = /\/api\/checks\/tests\/undo$/;
const GONE = 'refund_amount at most 200';
/** ` · ` as the page draws it, its spaces no-break. */
const DOT = '[\\s\\u00a0]·[\\s\\u00a0]';

type Step = NonNullable<TestsView['steps']>[string];

/** Tests as the demo's server answers it. */
async function realTests(page: Page): Promise<TestsView> {
  const { origin, token } = dash();
  return (await (await page.request.get(`${origin}/api/tests`, { headers: { 'x-shadowlap-token': token } })).json()) as TestsView;
}

/** The demo golden this file works on, with its checks as the CLI labels them. */
function golden(view: TestsView): GoldenRow {
  const row = view.rows.find((r) => r.path === GOLDEN);
  if (!row || row.checks.length < 2) throw new Error(`the demo store has no ${GOLDEN} with two checks`);
  return row;
}

/** The golden's buttons of a kind that show at this width: the Checks column's, or the copy under its name. */
function shown(page: Page, act: 'edit' | 'remove' | 'add', label?: string): Locator {
  return page.locator(`main#view [data-ck="${act}"][data-g="${GOLDEN}"]${label === undefined ? '' : `[data-label="${label}"]`}`).filter({ visible: true });
}

/** How opaque the icons around `l` are. */
const opacity = (l: Locator) => l.evaluate((el) => getComputedStyle(el.closest('.cka')!).opacity);

/** A button's hover card: its title and its line. */
async function card(l: Locator): Promise<{ t?: string; s?: string }> {
  return JSON.parse((await l.getAttribute('data-tip')) ?? '{}') as { t?: string; s?: string };
}

test('at 1440px each of a golden’s checks ends in Edit and Remove on its row’s hover or focus, the last in Add check… too, each target 24px from the next, with no serious axe violation', async ({ page }) => {
  await openPage(page, '/tests', 'main#view table.gt');
  const last = golden(await realTests(page)).checks.at(-1)!;
  const icons = [shown(page, 'edit', last), shown(page, 'remove', last), shown(page, 'add')];
  for (const l of icons) await expect(l).toHaveCount(1);
  // Out of sight until the row is hovered, and never the touch line where a pointer hovers and the column has room.
  await expect.poll(() => opacity(icons[0]!)).toBe('0');
  await expect(page.locator('main#view .ckt button').filter({ visible: true })).toHaveCount(0);
  await icons[0]!.locator('xpath=ancestor::tr[1]').hover();
  await expect.poll(() => opacity(icons[0]!)).toBe('1');
  await expect(icons[0]!).toHaveAttribute('aria-label', `Edit ${last}`);
  await expect(icons[1]!).toHaveAttribute('aria-label', `Remove ${last}`);
  await expect(icons[2]!).toHaveAttribute('aria-label', `Add check to ${NAME}`);
  // WCAG 2.5.8: 22px icons 2px apart, so a 24px circle on each centre touches no other.
  const boxes = await Promise.all(icons.map(async (l) => (await l.boundingBox())!));
  for (const b of boxes) expect([Math.round(b.width), Math.round(b.height)]).toEqual([22, 22]);
  for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.x + boxes[i]!.width / 2 - (boxes[i - 1]!.x + boxes[i - 1]!.width / 2)).toBeGreaterThanOrEqual(24);
  await expectAccessible(page);
  // The keyboard shows them too, with no pointer over the row.
  await page.mouse.move(0, 0);
  await expect.poll(() => opacity(icons[0]!)).toBe('0');
  await icons[0]!.focus();
  await expect.poll(() => opacity(icons[0]!)).toBe('1');
});

test('on a phone one line of Edit checks… and Add check… stands in the icons’ place, inside the page, Edit checks… opening the builder at the golden’s first check and Esc handing the focus back, with no serious axe violation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPage(page, '/tests', 'main#view table.gt');
  const first = golden(await realTests(page)).checks[0]!;
  const line = page.locator('main#view .ckt').filter({ has: page.locator(`[data-g="${GOLDEN}"]`) }).filter({ visible: true });
  await expect(line.locator('button')).toHaveText(['Edit checks…', 'Add check…']);
  await expect(page.locator(`main#view .cka [data-g="${GOLDEN}"]`).filter({ visible: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  await expectAccessible(page);
  const edit = line.getByRole('button', { name: 'Edit checks…' });
  await expect(edit).toHaveAttribute('data-label', first);
  await edit.click();
  const dialog = page.locator(DIALOG);
  await expect(dialog.locator('header h3')).toHaveText(`Edit check of ${NAME}`);
  await expect(dialog.locator('.cb-kinds')).toBeVisible();
  await expectAccessible(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(edit).toBeFocused();
});

test('Remove asks first in a dialog of its own with the lines that leave the file, wide and as a phone’s sheet, writes against the version read, and its toast’s Undo puts the entry back, both answered by page.route', async ({ page }) => {
  await openPage(page, '/tests', 'main#view table.gt');
  const [check, ...others] = golden(await realTests(page)).checks;
  const remove = shown(page, 'remove', check);
  await remove.locator('xpath=ancestor::tr[1]').hover();
  await remove.click();
  const dialog = page.locator(DIALOG);
  await expect(dialog.locator('header h3')).toHaveText(`Remove check from ${NAME}?`);
  await expect(dialog.locator('header p')).toContainText(`Removes ${check} from ${NAME}’s entry in shadowlap.config.json; its other checks stay.`);
  await expect(dialog.locator('.cb-ver')).toHaveText(/^version [0-9a-f]{8} · saved only if unchanged$/);
  await expect(dialog.locator('.cb-file')).toContainText('"issue_refund": 1');
  // It asks with the focus on Cancel, as a removal should.
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expectAccessible(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.locator('.cb-file')).toBeVisible();
  await expectAccessible(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  const sent: Array<{ golden?: string; version?: string; entry?: unknown }> = [];
  await page.route(WRITE, (route) => {
    sent.push(route.request().postDataJSON() as (typeof sent)[number]);
    return route.fulfill({ json: { key: GOLDEN, version: 'b'.repeat(64), added: [], removed: [check], changed: true, was: 'w-browser' } });
  });
  await dialog.getByRole('button', { name: 'Remove check' }).click();
  await expect(dialog).toHaveCount(0);
  // The golden's entry without the check, against the version the dialog read: its other checks kept.
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ golden: GOLDEN, version: expect.stringMatching(/^[0-9a-f]{64}$/) });
  const entry = JSON.stringify(sent[0]!.entry);
  expect(entry).not.toContain('issue_refund');
  expect(entry).toContain('send_email');
  expect(others.length).toBeGreaterThan(0);
  const toast = page.locator('.toast');
  await expect(toast).toContainText(`Check removed · ${NAME}`);
  await expectAccessible(page);

  const undone: unknown[] = [];
  await page.route(UNDO, (route) => {
    undone.push(route.request().postDataJSON());
    return route.fulfill({ json: { key: GOLDEN, version: 'c'.repeat(64), added: [check], removed: [], changed: true } });
  });
  await toast.locator('button', { hasText: 'Undo' }).click();
  await expect(page.locator('.toast')).toContainText(`Back in shadowlap.config.json · ${GOLDEN}`);
  expect(undone).toEqual([{ was: 'w-browser' }]);
  await page.unroute(WRITE);
  await page.unroute(UNDO);
});

/** Tests with the verdict's first failure led by `step` (the demo's golden that leads, its own checks), and that golden's row as `row` makes it. */
async function routeStep(page: Page, step: (golden: GoldenRow) => Step, row: (r: GoldenRow) => GoldenRow = (r) => r): Promise<GoldenRow> {
  const real = await realTests(page);
  const path = real.verdict?.first?.golden;
  const lead = real.rows.find((r) => r.path === path && r.checks.length > 0);
  if (!lead) throw new Error('the demo’s Tests leads with no failing golden that has checks');
  const view: TestsView = { ...real, rows: real.rows.map((r) => (r === lead ? row(r) : r)), steps: { ...real.steps, [lead.path]: step(lead) } };
  await page.route((url) => url.pathname === '/api/tests', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: view }) : route.continue()));
  return lead;
}

for (const [width, height] of [
  [1440, 900],
  [390, 844],
] as const) {
  test(`at ${width}px a golden whose checks changed since says so under its last result, the checks gone on hover, and Tests leads with the header’s Run tests, lime, saying why, with no serious axe violation`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const sub = 'Its checks changed since its last test: the session judges them as they are now';
    await routeStep(
      page,
      (g) => ({ key: 'run-tests', label: 'Run tests', golden: g.path, gone: [GONE], sub }),
      (r) => ({ ...r, changed: [{ label: GONE, status: 'failed' }] }),
    );
    await openPage(page, '/tests', 'main#view table.gt');
    const stale = page.locator('main#view table.gt .ckst').filter({ visible: true });
    await expect(stale).toHaveCount(1);
    await expect(stale).toHaveText(new RegExp(`^checks changed since${DOT}not tested yet$`));
    expect(await card(stale)).toMatchObject({ s: `Its last test judged ${GONE}, no longer in shadowlap.config.json: Run tests judges its checks as they are now` });
    // No step in the verdict: the header's own Run tests leads.
    await expect(page.locator('main#view .tv .actions button')).toHaveCount(0);
    const run = page.locator('main#view button', { hasText: /^Run tests$/ }).filter({ visible: true }).first();
    await expect(run).toHaveClass(/\blime\b/);
    expect(await card(run)).toMatchObject({ t: 'Run tests', s: sub });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await expectAccessible(page);
  });

  test(`at ${width}px a golden whose recording fails a check added since leads with a lime Edit check… in the verdict, which opens the builder at that check, with no serious axe violation`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const lead = await routeStep(page, (g) => ({ key: 'edit-check', label: 'Edit check…', golden: g.path, check: g.checks.at(-1)!, sub: `It fails ${g.name}’s own recording: edit the check, or update the golden if the agent should now do this` }));
    await openPage(page, '/tests', 'main#view table.gt');
    const step = page.locator('main#view .tv .actions button');
    await expect(step).toHaveText('Edit check…');
    await expect(step).toHaveClass(/\blime\b/);
    await expect(step).toHaveAttribute('data-step', 'edit-check');
    await expect(page.locator('main#view button', { hasText: /^Run tests$/ }).filter({ visible: true }).first()).not.toHaveClass(/\blime\b/);
    await expectAccessible(page);
    await step.click();
    const dialog = page.locator(DIALOG);
    await expect(dialog.locator('header h3')).toHaveText(`Edit check of ${lead.name}`);
    await expect(dialog.locator('.cb-kinds')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(step).toBeFocused();
  });
}

/** A judge check on the demo's good run, its verdict asked live and its call the run's `callNo`. */
function judged(callNo: number, verdict: 'yes' | 'no'): CheckView {
  const label = 'judge "explains-refund" answers yes';
  const judge = { name: 'explains-refund', model: 'claude-haiku-4-5', of: 'answer' as const, verdict, source: 'live' as const, cost: 0.0004, redactions: 0, cut: 0, callNo };
  return verdict === 'yes'
    ? { label, ok: true, status: 'passed', reason: 'The reply says the refund was issued', source: 'live', judge }
    : { label, ok: false, status: 'failed', detail: 'the judge answered no', reason: 'It never says when the money arrives', source: 'live', judge };
}

const JUDGE = 'shadowlap:judge';
type Row = { callNo: number; kind: string };
/** The number of a run's last model call, which the routed page makes its judge's. */
const lastModel = (calls: readonly Row[]): number => Math.max(...calls.filter((c) => c.kind === 'api').map((c) => c.callNo));

/**
 * The good run's page with the checks `checks.now` gives as its own, which the demo never judged it
 * by (set it again before the page is read again), and its last model call made the judge's, as a
 * judge's call is recorded: in Shadowlap's own scope, its row naming its check and verdict. The
 * judge's call's number, and how many calls the run has.
 */
async function routeChecks(page: Page, checks: { now: (last: number) => CheckView[] }): Promise<{ id: string; last: number; calls: number }> {
  const id = demoId('good');
  await page.route(
    (url) => url.pathname === `/api/runs/${id}`,
    async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { calls: Row[] };
      const last = lastModel(body.calls);
      const calls = body.calls.map((c) => (c.callNo === last ? { ...c, scope: JUDGE, agent: JUDGE, reserved: true, judge: { check: 'explains-refund', verdict: 'yes' } } : c));
      return route.fulfill({ response: res, json: { ...body, calls, checks: checks.now(last) } });
    },
  );
  const { origin, token } = dash();
  const run = (await (await page.request.get(`${origin}/api/runs/${id}`, { headers: { 'x-shadowlap-token': token } })).json()) as { calls: Row[] };
  return { id, last: lastModel(run.calls), calls: run.calls.length };
}

/** Opens the bar's other findings where it has more than one. */
async function openFindings(page: Page): Promise<void> {
  const more = page.locator('main#view .findings .fmore');
  if (!(await more.count())) return;
  if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
}

test('a run’s judge verdicts are findings of their own, each its call, the check, its reason and where it came from, whose #n opens the judge’s call under the judge’s chip, and a judge’s line in the checks finding carries the same, wide and on a phone, with no serious axe violation', async ({ page }) => {
  const why = (reason: string) => new RegExp(`^${reason}${DOT}judged live${DOT}<\\$0\\.001$`);
  const refund: CheckView = { label: 'issue_refund called 1 time', ok: true, status: 'passed' };
  const checks = { now: (n: number): CheckView[] => [refund, judged(n, 'yes'), { ...judged(n, 'no'), label: 'judge "names-the-date" answers yes' }] };
  const { id, last, calls } = await routeChecks(page, checks);
  await openPage(page, `/run/${id}`, 'run');
  // The judge's call out of All: the agents' bar for it alone, Agent first, the judge's chip after a hairline.
  const bar = page.locator('main#view .scopebar');
  await expect(bar.locator('.chips > *')).toHaveCount(3);
  await expect(bar.locator('.chips > .jsep')).toHaveAttribute('aria-hidden', 'true');
  await expect(bar.locator('.chips button')).toHaveText([`Agent ${calls - 1}`, 'judge 1']);
  await expect(bar.locator('.chips button').last()).toHaveAttribute('title', 'shadowlap:judge: the judge’s calls, kept apart from the agent’s');
  await expect(bar.locator('.shint')).toHaveText('A judge’s calls are the check’s: no count, budget or cost of the agent’s includes them');
  await expect(page.locator(`main#view .vbody tr[data-call="${last}"]`)).toHaveCount(0);
  await openFindings(page);
  const verdicts = page.locator('main#view .findings section.jv');
  await expect(verdicts).toHaveCount(2);
  await expect(verdicts.locator('.bk')).toHaveText(['verdict', 'verdict']);
  await expect(verdicts.locator('.jvw b')).toHaveText(['✓', '✗']);
  await expect(verdicts.nth(1).locator('.jvw')).toContainText('judge "names-the-date" answers yes: the judge answered no');
  await expect(verdicts.locator('.why').first()).toHaveText(why('The reply says the refund was issued'));
  // The call first, as the design draws it: verdict, #n, the check, then why (and the bar's own link after).
  expect((await verdicts.first().evaluate((s) => [...s.children].map((c) => c.classList[0]))).slice(0, 4)).toEqual(['bk', 'bn', 'jvw', 'why']);
  const call = verdicts.first().locator('button.bn');
  await expect(call).toHaveText(`#${last}`);
  expect(await card(call)).toMatchObject({ t: 'Open the judge’s call' });
  await call.click();
  await expect(page.locator(`main#view tr[data-call="${last}"]`).first()).toHaveAttribute('aria-selected', 'true');
  // Under the judge's chip, picked with its call: Calls lists the judge's call alone, which no fork starts at, and the head's Fork says why.
  await expect(bar.locator('.chips button').last()).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('main#view .vbody tr[data-call]')).toHaveCount(1);
  await expect(page.locator(`main#view tr[data-call="${last}"]`).first()).toContainText('judge "explains-refund" · yes');
  await expect(page.locator(`main#view tr[data-call="${last}"] .rowact button`)).toHaveCount(0);
  const fork = page.locator('#forkBtn');
  await expect(fork).toHaveText('Fork');
  await expect(fork).toHaveAttribute('aria-disabled', 'true');
  await expect(fork).toHaveAttribute('data-why', 'A judge’s call can’t be forked');
  await expectAccessible(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openFindings(page);
  await expect(verdicts.first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  await expectAccessible(page);

  // Every check passed: one finding lists them, the judge's line with its call and where its verdict came from.
  checks.now = (n) => [refund, judged(n, 'yes')];
  await page.setViewportSize({ width: 1440, height: 900 });
  // A page loaded anew, as the same address only moves its hash.
  await page.goto('about:blank');
  await openPage(page, `/run/${id}`, 'run');
  await openFindings(page);
  await expect(page.locator('main#view .findings section.jv')).toHaveCount(0);
  const line = page.locator('main#view .findings .banner.ck .st.jvc');
  await expect(line).toHaveCount(1);
  await expect(line.locator('button.bn')).toHaveText(`#${last}`);
  await expect(line.locator('.why')).toHaveText(why('The reply says the refund was issued'));
  await expectAccessible(page);
});
