import { expect, test, type Page } from '@playwright/test';
import { heldAsk, type HeldAsk } from '../ui/held.js';
import { parseRoute } from '../ui/route.js';
import { dash, demoId, openPage, serveDashboard, serverLinks, seriousViolations, type Served } from './dashboard.js';

/**
 * A link into another project, from a second dashboard: one started in the demo's triage-bot, a
 * project on its list with no runs, where every run, fix and preview of support-agent's is another
 * project's. The links the shared dashboard writes are each found in support-agent from there; a
 * run's, a fix's and a preview's open the page that says so, In support-agent, with Switch to
 * support-agent, at a laptop's width and a phone's; and Switch opens the run there, at the same
 * address, its heading taking the focus. On a phone, triage-bot's own pages: its setup on the
 * Overview, and Runs, Fixes, Tests and Training's tabs each their own empty state with Set up
 * triage-bot.
 *
 * The suite runs its tests in parallel, and a `beforeAll` runs in each worker that takes one of a
 * file's tests: this file's run in order in one worker, so it starts one dashboard, and the test
 * that switches it goes last. Only this file starts it, and it stops it after; the dashboard every
 * other file reads, global setup's, is never switched.
 */

test.describe.configure({ mode: 'serial' });

let second: (Served & { stop: () => Promise<void> }) | null = null;
/** The demo's newest preview, as support-agent's dashboard lists it. */
let shownPreview: string | null = null;

function preview(): string {
  if (!shownPreview) throw new Error('the demo store has no preview');
  return shownPreview;
}

function triage(): Served {
  if (!second) throw new Error('the second dashboard did not start');
  return second;
}

test.beforeAll(async () => {
  second = await serveDashboard(dash().demo, 'triage-bot');
  const { origin, token } = dash();
  const listed = (await (await fetch(`${origin}/api/decisions?kind=decisions`, { headers: { 'x-shadowlap-token': token } })).json()) as { sessions: Array<{ sessionId: string }> };
  shownPreview = listed.sessions[0]?.sessionId ?? null;
});

test.afterAll(async () => {
  await second?.stop();
  second = null;
});

/** What the In page's one action is. */
const SWITCH = 'main#view .ph .actions .btn.lime';

const ITEMS: Array<{ name: string; what: HeldAsk['what']; path: () => string; id: () => string; crumb: string }> = [
  { name: 'a run', what: 'run', path: () => `/run/${demoId('refundBug')}`, id: () => demoId('refundBug'), crumb: 'Runs' },
  { name: 'a fix', what: 'fix', path: () => `/fixes/${demoId('refundFix')}`, id: () => demoId('refundFix'), crumb: 'Fixes' },
  { name: 'a preview', what: 'preview', path: () => `/changes/decisions/${preview()}`, id: preview, crumb: 'Changes/Preview' },
];

/** An element's words as the page has them (the eyebrow is drawn in capitals), its spaces as one. */
const words = (page: Page, selector: string) => page.locator(selector).evaluate((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim());

test('every run, fix, pair and preview a link the server writes names is found in support-agent from another project', async ({ request }) => {
  const asks = new Map<string, HeldAsk>();
  for (const link of await serverLinks(request)) {
    const ask = heldAsk(parseRoute(link));
    if (ask) asks.set(`${ask.what}:${ask.ids.join('/')}`, ask);
  }
  expect([...asks.values()].some((a) => a.what === 'fix')).toBe(true);
  expect([...asks.values()].some((a) => a.what === 'preview')).toBe(true);
  expect(asks.size).toBeGreaterThan(5);
  const { origin, token } = triage();
  for (const [key, ask] of asks) {
    const query = new URLSearchParams([['what', ask.what], ...ask.ids.map((id): [string, string] => ['id', id])]);
    const res = await request.get(`${origin}/api/projects/holding?${query}`, { headers: { 'x-shadowlap-token': token } });
    expect(res.status(), key).toBe(200);
    const view = (await res.json()) as { current: { name: string }; held: { project: { name: string }; id: string } | null };
    expect(view.current.name, key).toBe('triage-bot');
    expect(view.held?.project.name, key).toBe('support-agent');
    expect(ask.ids, key).toContain(view.held?.id);
  }
});

for (const item of ITEMS) {
  for (const width of [1440, 390]) {
    test(`${item.name} support-agent holds opens In support-agent in triage-bot at ${width}px, with Switch to support-agent and no serious axe violation`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openPage(page, item.path(), SWITCH, triage());
      expect(await words(page, 'main#view .ph .eyebrow')).toBe('triage-bot · in another project');
      expect(await words(page, 'main#view .ph h1')).toBe('In support-agent');
      expect(await words(page, 'main#view .ph .phl p')).toBe(`The ${item.what} ${item.id()} is in support-agent’s store, not triage-bot’s.`);
      await expect(page.locator(SWITCH)).toHaveText('Switch to support-agent');
      await expect(page).toHaveTitle('In support-agent — shadowlap');
      // The crumbs name the section only, Changes with its tab as on any preview's page: the page can't show what it opened for.
      if (width > 640) expect(await words(page, '.top .crumbs')).toBe(item.crumb);
      // A phone: the action under the title, from its left, and nothing wider than the phone.
      if (width < 640) {
        const [h1, button] = await Promise.all([page.locator('main#view .ph h1').boundingBox(), page.locator(SWITCH).boundingBox()]);
        expect(button!.y).toBeGreaterThanOrEqual(h1!.y + h1!.height);
        expect(Math.abs(button!.x - h1!.x)).toBeLessThanOrEqual(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      }
      expect(await seriousViolations(page)).toEqual([]);
    });
  }
}

test('triage-bot, with no runs, shows its setup on the Overview alone at 390px, Runs, Fixes, Tests and Training each its own empty state with Set up triage-bot, and no serious axe violation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await openPage(page, '/', 'main#view section#setup ol.setup', triage());
  expect(await seriousViolations(page)).toEqual([]);
  for (const path of ['/runs', '/fixes', '/tests', '/training', '/training/tasks']) {
    const step = page.locator('main#view .stepempty a.btn.lime');
    await openPage(page, path, 'main#view .stepempty a.btn.lime', triage());
    await expect(step, path).toHaveText('Set up triage-bot');
    await expect(step, path).toHaveAttribute('href', '#/');
    await expect(page.locator('main#view ol.setup'), path).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), path).toBe(0);
    expect(await seriousViolations(page), path).toEqual([]);
  }
});

test('Switch to support-agent switches triage-bot’s dashboard and opens the run there at the same call, its heading taking the focus', async ({ page }) => {
  // A call of the run's other than the one its page opens on.
  await openPage(page, `${ITEMS[0]!.path()}/2`, SWITCH, triage());
  const address = await page.evaluate(() => location.hash);
  expect(address).toBe(`#/run/${demoId('refundBug')}/2`);
  await page.locator(SWITCH).click();
  await page.waitForSelector('main#view .rhead .rnm', { state: 'visible' });
  expect(await page.evaluate(() => location.hash)).toBe(address);
  await expect(page.locator('aside#side .proj .pn b')).toHaveText('support-agent');
  await expect(page.locator('main#view h1')).toBeFocused();
  await expect(page.locator(SWITCH)).toHaveCount(0);
});
