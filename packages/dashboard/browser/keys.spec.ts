import { expect, test, type Page, type Route } from '@playwright/test';
import { dash, demoId, openPage, seriousViolations } from './dashboard.js';

/**
 * The keyboard in Chromium over the demo store: the lists' keys on Runs, Esc going back the way you
 * came, the tabs pattern on a run, the shortcuts sheet with its switch, and a heading that takes the
 * focus with no ring.
 */

const RUNS = 'main#view table.runst tbody tr';
const openRuns = (page: Page) => openPage(page, '/runs', RUNS);
const hash = (page: Page) => page.evaluate(() => location.hash);
const inFocus = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('data-rowkey') ?? document.activeElement?.tagName ?? '');

test('j and k walk Runs, the row in focus drawn and in view, x picks it, and Esc clears then lets go', async ({ page }) => {
  await openRuns(page);
  await page.keyboard.press('j');
  const first = page.locator(`${RUNS}.krow`);
  await expect(first).toHaveCount(1);
  const key = await first.getAttribute('data-rowkey');
  expect(await inFocus(page)).toBe(key);
  await page.keyboard.press('j');
  await page.keyboard.press('ArrowUp');
  expect(await inFocus(page)).toBe(key);
  await page.keyboard.press('x');
  await expect(page.locator('.bulkbar')).toBeVisible();
  await expect(page.locator(`${RUNS}.picked`)).toHaveCount(1);
  expect(await seriousViolations(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.locator('.bulkbar')).toHaveCount(0);
  await expect(page.locator(`${RUNS}.krow`)).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator(`${RUNS}.krow`)).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.matches('main#view h1'))).toBe(true);
  // The focus says no ring round the heading, which is no control.
  expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)).toBe('none');
});

test('Enter opens the row, the run’s heading takes the focus, and Esc comes back to the row', async ({ page }) => {
  await openRuns(page);
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  const key = await page.locator(`${RUNS}.krow`).getAttribute('data-rowkey');
  await page.keyboard.press('Enter');
  await page.locator('h1.rnm').waitFor();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('H1');
  await page.keyboard.press('Escape');
  await page.locator(RUNS).first().waitFor();
  await expect.poll(() => inFocus(page)).toBe(key);
  await expect(page.locator(`${RUNS}.krow`)).toHaveAttribute('data-rowkey', key!);
});

test('Esc on a run opened cold goes up to its parent, or to Runs', async ({ page }) => {
  await openPage(page, `/run/${demoId('override')}`, 'run');
  const parent = await page.locator('nav.crumbs a[href^="#/run/"]').last().getAttribute('href');
  await page.keyboard.press('Escape');
  await expect.poll(() => hash(page)).toContain(parent!);
  await page.locator('h1.rnm').waitFor();
  await page.keyboard.press('Escape');
  await expect.poll(() => hash(page)).toContain('#/runs');
});

test('⌘K on a row offers its actions, ⌫ everything, and closing hands the focus back', async ({ page }) => {
  await openRuns(page);
  await page.keyboard.press('j');
  const key = await page.locator(`${RUNS}.krow`).getAttribute('data-rowkey');
  await page.keyboard.press('ControlOrMeta+k');
  await page.locator('.palette').waitFor();
  await expect(page.locator('.palit .pl').first()).toHaveText('Open run');
  await expect(page.locator('.palfoot')).toContainText('everything');
  expect(await seriousViolations(page)).toEqual([]);
  await page.keyboard.press('Backspace');
  await expect(page.locator('.palit .pl', { hasText: /^Runs$/ })).toBeVisible();
  await expect(page.locator('.palit .palk kbd').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.palette')).toHaveCount(0);
  await expect.poll(() => inFocus(page)).toBe(key);
});

test('a run’s views and the inspector are tabs with one Tab stop, the arrows moving and v going through them all', async ({ page }) => {
  await openPage(page, `/run/${demoId('refundBug')}`, 'run');
  const views = page.locator('[role="tablist"][aria-label="Views"] [role="tab"]');
  await expect(views.locator('xpath=self::*[@tabindex="0"]')).toHaveCount(1);
  await page.locator('[role="tablist"][aria-label="Views"] [aria-selected="true"]').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#vtab-turns')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#vtab-turns')).toBeFocused();
  await expect(page.locator('#vbody')).toHaveAttribute('aria-labelledby', 'vtab-turns');
  await page.keyboard.press('End');
  await expect(page.locator('#vtab-decisions')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#vtab-calls')).toBeFocused();
  await expect(page.locator('#vtab-turns')).toHaveAttribute('aria-keyshortcuts', 'v');
  const tabs = page.locator('[role="tablist"][aria-label="The selected call"] [role="tab"]');
  await expect(tabs).toHaveCount(4);
  await expect(tabs.nth(2)).toHaveAttribute('aria-keyshortcuts', '3');
  await expect(page.locator('#ibody')).toHaveAttribute('role', 'tabpanel');
  // From the provenance view v reaches Decisions, and from Decisions comes round to Calls.
  await page.locator('#vtab-provenance').click();
  await page.keyboard.press('v');
  await expect(page.locator('#vtab-decisions')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('v');
  await expect(page.locator('#vtab-calls')).toHaveAttribute('aria-selected', 'true');
  expect(await seriousViolations(page)).toEqual([]);
});

test('j moves the selected call and takes the focus, and Esc in the filter goes back to it with the words kept', async ({ page }) => {
  await openPage(page, `/run/${demoId('refundBug')}`, 'run');
  await page.keyboard.press('j');
  await expect.poll(() => page.evaluate(() => document.activeElement?.matches('.vbody tr[aria-selected="true"]'))).toBe(true);
  await page.keyboard.press('/');
  const filter = page.locator('.filter-in input');
  await expect(filter).toBeFocused();
  await page.keyboard.type('a');
  await page.keyboard.press('Escape');
  await expect(filter).toHaveValue('a');
  await expect.poll(() => page.evaluate(() => document.activeElement?.matches('.vbody tr[aria-selected="true"]'))).toBe(true);
});

test('the sheet’s lines each keep to one line, its switch is remembered, and off, nothing advertises a single key', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPage(page, `/run/${demoId('refundBug')}`, 'run');
  await page.keyboard.press('?');
  await page.locator('.help').waitFor();
  const lines = await page.locator('.help dd').evaluateAll((all) => all.map((dd) => [dd.textContent, dd.getBoundingClientRect().height]));
  for (const [text, height] of lines) expect(Number(height), String(text)).toBeLessThan(40);
  expect(await seriousViolations(page)).toEqual([]);
  await page.locator('.help [role="switch"]').click();
  await expect(page.locator('html.nosk')).toHaveCount(1);
  expect(await page.locator('.help dt.sk').first().evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  await page.locator('.help footer button').click();
  await expect(page.locator('#forkBtn')).not.toHaveAttribute('aria-keyshortcuts');
  // A single key does nothing now, Esc and the arrows still work.
  await page.keyboard.press('?');
  await expect(page.locator('.help')).toHaveCount(0);
  await page.reload();
  await page.locator('h1.rnm').waitFor();
  await expect(page.locator('html.nosk')).toHaveCount(1);
  await expect(page.locator('#forkBtn')).not.toHaveAttribute('aria-keyshortcuts');
});

test('Tab starts at the skip link, then the top bar, and a new page starts Tab from its heading', async ({ page }) => {
  await openRuns(page);
  await page.keyboard.press('Tab');
  await expect(page.locator('a.skip')).toBeFocused();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('header.top'))).toBe(true);
  await page.locator('aside#side .navlist a', { hasText: 'Fixes' }).click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.matches('main#view h1'))).toBe(true);
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('main#view'))).toBe(true);
});

test('on a phone, the drawer takes the focus to its first item, and a click beside it closes it', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await openRuns(page);
  const menu = page.locator('button.menu-toggle');
  await menu.click();
  await expect(page.locator('aside#side.open')).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('aside#side'))).toBe(true);
  // On a row of the table: the click closes the drawer and opens nothing.
  await page.mouse.click(700, 500);
  await expect(page.locator('aside#side.open')).toHaveCount(0);
  await expect(menu).toBeFocused();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/runs');
  // A link in it closes it, and its page takes the focus.
  await menu.click();
  await page.locator('aside#side .navlist a', { hasText: 'Fixes' }).click();
  await expect(page.locator('aside#side.open')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.activeElement?.matches('main#view h1'))).toBe(true);
});

test('Esc on a row’s link, with no row in focus, leaves the focus where Tab had it', async ({ page }) => {
  await openRuns(page);
  const link = page.locator(`${RUNS} a.rowa`).first();
  await link.focus();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(link).toBeFocused();
});

test('in forced colours the row in focus keeps an outline, the ground and the bar being gone', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await openRuns(page);
  await page.keyboard.press('j');
  const row = page.locator(`${RUNS}.krow`);
  await expect(row).toHaveCount(1);
  expect(await row.evaluate((el) => `${getComputedStyle(el).outlineStyle} ${getComputedStyle(el).outlineWidth}`)).toBe('solid 2px');
});

test('a row j brings into view stops above the selection bar, on a desktop and on a phone', async ({ page }) => {
  for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    await openRuns(page);
    await page.keyboard.press('j');
    await page.keyboard.press('x');
    const bar = page.locator('.bulkbar');
    await bar.waitFor();
    for (let i = 0; i < 24; i++) {
      await page.keyboard.press('j');
      const [rowBottom, barTop] = await page.evaluate(() => [document.querySelector('.krow')!.getBoundingClientRect().bottom, document.querySelector('.bulkbar')!.getBoundingClientRect().top]);
      expect(rowBottom, `row ${i + 2} at ${size.width}`).toBeLessThanOrEqual(barTop + 1);
    }
  }
});

test('a control’s hover card says its key, and Provenance’s card its name over what it holds', async ({ page }) => {
  await openPage(page, `/run/${demoId('override')}`, 'run');
  await page.locator('#forkBtn').hover();
  await expect(page.locator('.tip .kbd')).toHaveText('f');
  // Provenance's card is a name and a sentence; the tab v shows next says v. v shows its view through the
  // address, after the key: each v is read once its view shows, or one still on its way takes the views past Forks.
  const shown = page.locator('[id^="vtab-"][aria-selected="true"]');
  for (let at = await shown.getAttribute('id'); at !== 'vtab-forks'; at = await shown.getAttribute('id')) {
    await page.keyboard.press('v');
    await expect(page.locator(`#${at}`)).toHaveAttribute('aria-selected', 'false');
  }
  const card = JSON.parse((await page.locator('#vtab-provenance').getAttribute('data-tip'))!) as { t: string; s?: string };
  expect(card.t).toBe('Provenance');
  expect(card.s).toMatch(/^The run’s record/);
  await page.locator('#vtab-provenance').hover();
  await expect(page.locator('.tip b')).toHaveText('Provenancev');
  await expect(page.locator('.tip .kbd')).toHaveText('v');
});

test('c on a fork opens Compare against the run it forked from, the verdict first', async ({ page }) => {
  const fork = demoId('override');
  await openPage(page, `/run/${fork}`, 'run');
  await page.keyboard.press('c');
  await expect.poll(() => hash(page)).toBe(`#/compare/${demoId('ticket')}/${fork}`);
  await expect(page.locator('main#view .verdict.cmpv')).toBeVisible();
  await expect(page.locator('main#view .paths2 button.cprow').first()).toBeVisible();
});

test('n’s call on a fork’s banner says its key, and n selects it', async ({ page }) => {
  await openPage(page, `/run/${demoId('override')}`, 'run');
  const mark = page.locator('#view [data-shortcut="jump"]');
  await expect(mark).toHaveAttribute('aria-keyshortcuts', 'n');
  expect(JSON.parse((await mark.getAttribute('data-tip'))!)).toMatchObject({ t: 'Jump to fork' });
  const n = (await mark.textContent())!.replace('#', '');
  await page.keyboard.press('n');
  await expect(page.locator('.vbody tr[aria-selected="true"]')).toHaveAttribute('data-call', n);
});

test('Esc closes a run’s diff first, its toggle taking the focus from inside it, and the next goes up', async ({ page }) => {
  await openPage(page, `/run/${demoId('override')}`, 'run');
  const at = await hash(page);
  const toggle = page.locator('#view [data-act="diff"]');
  await toggle.click();
  await page.locator('.diffpanel').evaluate((el: HTMLElement) => {
    el.tabIndex = -1;
    el.focus();
  });
  await page.keyboard.press('Escape');
  await expect(page.locator('.diffpanel')).toHaveCount(0);
  await expect(toggle).toBeFocused();
  expect(await hash(page)).toBe(at);
  // With the focus elsewhere it stays there.
  await toggle.click();
  const tab = page.locator('#vtab-calls');
  await tab.focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('.diffpanel')).toHaveCount(0);
  await expect(tab).toBeFocused();
  await page.keyboard.press('Escape');
  await expect.poll(() => hash(page)).not.toBe(at);
});

test('Esc closes a run’s diff first while its script is on its way and once it failed to come, the run staying open', async ({ page }) => {
  // The diff is a script of its own, asked for the first time it opens: held back, then failed.
  const held: Route[] = [];
  await page.route(/\/assets\/chunks\/RequestDiff-\w+\.js$/, (route) => void held.push(route));
  await openPage(page, `/run/${demoId('override')}`, 'run');
  const at = await hash(page);
  const toggle = page.locator('#view [data-act="diff"]');
  const panel = page.locator('#insp.fpanel');
  await toggle.click();
  await expect(panel).toBeVisible();
  await expect.poll(() => held.length).toBe(1);
  await expect(panel.locator('.diffpanel')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(toggle).toBeFocused();
  expect(await hash(page)).toBe(at);
  await held[0]!.abort();
  await toggle.click();
  await expect(panel).toContainText('This diff’s code didn’t come from the dashboard server.');
  // From inside it, on its Retry: the toggle takes the focus.
  await panel.getByRole('button', { name: 'Retry' }).focus();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(toggle).toBeFocused();
  expect(await hash(page)).toBe(at);
});

test('This run’s keys in the palette come back with the switch, with no other call selected', async ({ page }) => {
  await openPage(page, `/run/${demoId('override')}`, 'run');
  const replayRow = page.locator('.palit', { has: page.locator('.pl', { hasText: /^Replay$/ }) });
  await page.keyboard.press('?');
  await page.locator('.help [role="switch"]').click();
  await page.locator('.help footer button').click();
  await page.reload();
  await page.locator('h1.rnm').waitFor();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(replayRow).toHaveCount(1);
  await expect(replayRow.locator('.palk')).toHaveCount(0);
  // The sheet, from the palette: single keys back on.
  await page.locator('.palin input').fill('Keyboard shortcuts');
  await page.keyboard.press('Enter');
  await page.locator('.help [role="switch"]').click();
  await page.locator('.help footer button').click();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(replayRow.locator('.palk kbd')).toHaveText('r');
});

test('⌘K on a run in the sidebar offers its actions, with nothing to select there', async ({ page }) => {
  await openRuns(page);
  const run = page.locator('aside#side a.run').first();
  await run.focus();
  await page.keyboard.press('ControlOrMeta+k');
  await page.locator('.palette').waitFor();
  const labels = await page.locator('.palit .pl').allTextContents();
  expect(labels[0]).toBe('Open run');
  expect(labels).toContain('Copy ID');
  expect(labels).not.toContain('Select run');
  await expect(page.locator('.palin input')).toHaveAttribute('placeholder', /^Actions for \w+$/);
  await page.keyboard.press('Escape');
  await expect(run).toBeFocused();
});

test('⌘K on a failed run’s row offers its next step after Open run, with no key, and picking Run blame starts it where you are', async ({ page }) => {
  const run = demoId('digestFailed');
  const job = { id: 'rowjob', kind: 'blame', title: 'Blaming', args: ['blame', run], worktree: { use: 'reads', doing: 'a blame is running your agent from your working tree', folder: '/x' }, runId: run, opensRun: false, startedAt: Date.now(), endedAt: Date.now(), done: true, stopped: false, code: 3, newRunId: null, runs: [], links: [], files: [], total: 0, lines: [], project: { id: 'support-agent', name: 'support-agent' } };
  const asked: unknown[] = [];
  await page.route('**/api/jobs', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    asked.push(route.request().postDataJSON());
    return route.fulfill({ status: 202, json: job });
  });
  await page.route('**/api/jobs/rowjob*', (route) => route.fulfill({ json: job }));
  await openPage(page, `/runs?q=${run}`, RUNS);
  await page.keyboard.press('j');
  await expect(page.locator(`${RUNS}.krow`)).toHaveAttribute('data-rowkey', `#/run/${run}`);
  await page.keyboard.press('ControlOrMeta+k');
  await page.locator('.palette').waitFor();
  expect((await page.locator('.palit .pl').allTextContents()).slice(0, 2)).toEqual(['Open run', 'Run blame']);
  const step = page.locator('.palit', { has: page.locator('.pl', { hasText: /^Run blame$/ }) });
  // b presses it on the run's page only, so the row's step shows no key.
  await expect(step.locator('.palk kbd')).toHaveCount(0);
  const at = await hash(page);
  await step.click();
  await expect.poll(() => asked).toEqual([expect.objectContaining({ kind: 'blame', runId: run })]);
  expect(await hash(page)).toBe(at);
});

test('the palette says “this row” where a row’s name doesn’t fit its field, measured again as the window changes', async ({ page }) => {
  await openRuns(page);
  await page.keyboard.press('j');
  await page.keyboard.press('ControlOrMeta+k');
  const field = page.locator('.palin input');
  await expect(field).toHaveAttribute('placeholder', /^Actions for \w{10}$/);
  await page.setViewportSize({ width: 220, height: 700 });
  await expect(field).toHaveAttribute('placeholder', 'Actions for this row');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(field).toHaveAttribute('placeholder', /^Actions for \w{10}$/);
});

test('the sheet’s switch stays in view at the foot of its lines', async ({ page }) => {
  await openPage(page, `/run/${demoId('override')}`, 'run');
  await page.keyboard.press('?');
  const body = page.locator('.help .hbody');
  await body.waitFor();
  for (const top of [0, 100_000]) {
    await body.evaluate((el, y) => el.scrollTo(0, y), top);
    const [sw, pane] = await page.evaluate(() => [document.querySelector('.help [role="switch"]')!.getBoundingClientRect().bottom, document.querySelector('.help .hbody')!.getBoundingClientRect().bottom]);
    expect(sw).toBeLessThanOrEqual(pane);
  }
});

test('a row of a section drawn as a Row shows where you are as a table’s does, the pointer over it too', async ({ page }) => {
  await openRuns(page);
  const shadow = await page.evaluate(() => {
    const host = document.createElement('section');
    host.className = 'panel sec';
    host.innerHTML = '<div class="srow krow" id="kr">A row</div><div class="srow" id="plain">Another</div>';
    document.querySelector('main#view .page-in')!.prepend(host);
    return getComputedStyle(document.getElementById('kr')!).boxShadow;
  });
  // The ground on both sides and the bar at the outer edge, as many shadows as a table's row draws.
  expect(shadow.split(/\),\s*|\)\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(3);
  await page.locator('#kr').hover();
  expect(await page.locator('#kr').evaluate((el) => getComputedStyle(el).boxShadow)).toBe(shadow);
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test('the palette shows no keys', async ({ page }) => {
    await openRuns(page);
    await page.keyboard.press('ControlOrMeta+k');
    await page.locator('.palin input').fill('Add project');
    await expect(page.locator('.palit.on .kbd')).toHaveCount(1);
    const shown = await page.locator('.palin .kbd, .palit .kbd, .palit .palk, .palfoot').evaluateAll((els) => els.map((el) => getComputedStyle(el).display));
    expect(shown.length).toBeGreaterThan(1);
    expect(new Set(shown)).toEqual(new Set(['none']));
  });
});

test('a job’s end hands the focus to what took its control’s place, however long the page takes to draw it', async ({ page }) => {
  const run = demoId('digestFailed');
  const fix = { role: 'failing', fix: { fixId: 'fx-0000000000000000000000000A', href: '#/fixes/fx-0000000000000000000000000A', title: 'The agent exited with code 1', status: 'open', label: 'digest', check: 'the agent exits 0' }, blame: null, probe: null, verify: null };
  // What the server leads with once the blame opened that fix.
  const opens = { key: 'fix', label: 'Open fix', fixId: fix.fix.fixId, status: 'open', check: fix.fix.check, href: fix.fix.href, title: `“${fix.fix.title}”` };
  const job = (done: boolean) => ({ id: 'stubjob', kind: 'blame', title: 'Blaming', args: ['blame', run], worktree: { use: 'reads', doing: 'a blame is running your agent from your working tree', folder: '/x' }, runId: run, opensRun: false, startedAt: Date.now() - 1000, endedAt: done ? Date.now() : null, done, stopped: false, code: done ? 3 : null, newRunId: null, runs: [], links: [], files: [], total: 0, lines: [], project: { id: 'support-agent', name: 'support-agent' } });
  let polls = 0;
  let ended = false;
  await page.route('**/api/jobs', (route) => (route.request().method() === 'POST' ? route.fulfill({ status: 202, json: job(false) }) : route.continue()));
  await page.route('**/api/jobs/stubjob*', (route) => {
    ended = ++polls >= 3;
    return route.fulfill({ json: job(ended) });
  });
  // The run read after the job's end comes late, as a busy read pool's does.
  await page.route(new RegExp(`/api/runs/${run}(\\?.*)?$`), async (route) => {
    const body = (await (await route.fetch()).json()) as Record<string, unknown>;
    if (ended) await new Promise((done) => setTimeout(done, 600));
    await route.fulfill({ json: { ...body, ...(ended ? { fix, next: opens } : { fix: { role: 'unblamed', fix: null, blame: null, probe: null, verify: null } }) } });
  });
  await openPage(page, `/run/${run}`, 'run');
  const lead = page.locator('.rhead .actions .btn.lime', { hasText: 'Run blame' });
  await lead.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.rhead .actions .btn.lime', { hasText: 'Open fix' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.textContent?.trim())).toBe('Open fix');
});

test('a menu opened while the page left still owes its focus keeps it: Esc up from a fork opened cold, then f', async ({ page }) => {
  await openPage(page, `/run/${demoId('override')}`, 'run');
  await page.keyboard.press('Escape');
  await expect.poll(() => hash(page)).not.toContain(demoId('override'));
  await page.locator('h1.rnm').waitFor();
  await page.keyboard.press('f');
  const items = page.locator('#menu [role^="menuitem"]');
  await expect(items.first()).toBeFocused();
  await page.waitForTimeout(500);
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
});

test('Esc closes a preview’s opened cell before anything else, the focus back on its cell where it was in the cell', async ({ page, request }) => {
  const { origin, token } = dash();
  const { sessions } = (await (await request.get(`${origin}/api/decisions`, { headers: { 'x-shadowlap-token': token } })).json()) as { sessions: Array<{ kind: string; sessionId: string }> };
  const s = sessions.find((x) => x.kind === 'decisions');
  expect(s, 'the demo’s preview').toBeTruthy();
  await openPage(page, `/changes/decisions/${s!.sessionId}`, 'main#view .dmx button.dc');
  const cell = page.locator('main#view .dmx button.dc').first();
  await cell.click();
  await expect(page.locator('#dcell')).toBeVisible();
  await page.locator('#dcell .dch a').first().focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#dcell')).toHaveCount(0);
  expect(await page.evaluate(() => location.hash)).toBe(`#/changes/decisions/${s!.sessionId}`);
  await expect(cell).toBeFocused();
});
