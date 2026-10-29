import { expect, test, type Page, type Request } from '@playwright/test';
import { dash, openPage, seriousViolations } from './dashboard.js';

/**
 * axe-core's WCAG 2.2 A and AA rules over everything the whole demo shows: every page, every run with
 * each view, its inspector's tabs, its menus and dialogs, Fixes and each fix's steps, Tests and its
 * dialogs, Settings' tabs, the team store's setup, the palette, the shortcuts on every kind of page,
 * a toast with Undo and the bar that says the dashboard can't be reached; and again on a phone, 390 px
 * wide. Any serious or critical violation fails, named with the state it was found in.
 */

/** The demo's runs by name, each by its id: every run the demo names. */
function runs(): Array<[string, string]> {
  return Object.entries(dash().runs).flatMap(([name, v]) => (typeof v === 'string' && /^01[0-9A-Z]{24}$/.test(v) ? [[name, v] as [string, string]] : []));
}

/** The demo's fixes, by id. */
const fixes = () => Object.values(dash().runs).filter((v): v is string => typeof v === 'string' && v.startsWith('fx-'));

/** Each violation found, under the state it was found in. */
async function sweep(page: Page, states: Array<[string, () => Promise<void>]>): Promise<string[]> {
  const found: string[] = [];
  for (const [name, show] of states) {
    await show();
    for (const v of await seriousViolations(page)) found.push(`${name}: ${v}`);
  }
  return found;
}

/** The page's requests to the dashboard's API still out: what a view shows comes with them. */
const inFlight = new WeakMap<Page, Set<Request>>();
function apiRequests(page: Page): Set<Request> {
  let open = inFlight.get(page);
  if (!open) {
    const out = new Set<Request>();
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.startsWith('/api/')) out.add(r);
    });
    page.on('requestfinished', (r) => out.delete(r));
    page.on('requestfailed', (r) => out.delete(r));
    inFlight.set(page, out);
    open = out;
  }
  return open;
}

/**
 * A state swept once it has settled, never after a time that a loaded machine can outrun: what it
 * shows is up (`shows`), or what it closed is gone (`hides`); none of the page's requests to the API
 * is still out, as what a view shows comes with them; and two frames have been drawn since, so axe
 * reads what the step changed.
 */
async function settled(page: Page, o: { shows?: string; hides?: string } = {}): Promise<void> {
  const open = apiRequests(page);
  if (o.shows) await page.waitForSelector(o.shows, { state: 'visible' });
  if (o.hides) await page.waitForSelector(o.hides, { state: 'detached' });
  // Polled from here, where the requests are seen: a request still out after a minute fails the sweep, naming it.
  await expect.poll(() => [...open].map((r) => new URL(r.url()).pathname), { message: "the page's requests to the API to come back", timeout: 60_000, intervals: [25] }).toEqual([]);
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

/** A dialog on top, the palette's and the shortcuts' included, and a menu open. */
const DIALOG = '[role="dialog"][aria-modal="true"]';
const MENU = '.pop[role="menu"]';

const at = (page: Page, path: string, drawn = 'main#view') => async () => {
  apiRequests(page);
  await openPage(page, path, drawn);
  await settled(page);
};
const run = (page: Page, id: string, view = '') => at(page, `/run/${id}${view ? `/${view}` : ''}`, 'run');
const click = (page: Page, selector: string, text?: string, o: { shows?: string } = {}) => async () => {
  apiRequests(page);
  await page.locator(selector, text ? { hasText: text } : {}).first().click();
  await settled(page, o);
};
const press = (page: Page, key: string, o: { shows?: string; hides?: string } = {}) => async () => {
  apiRequests(page);
  await page.keyboard.press(key);
  await settled(page, o);
};
/** Escape, and the dialog or menu it closes gone. */
const escape = (page: Page, closes: string = DIALOG) => press(page, 'Escape', { hides: closes });

test.describe.configure({ timeout: 300_000 });

test('every page and Settings tab has no serious or critical axe violation', async ({ page }) => {
  const pages = ['/', '/runs', '/runs?types=capture', '/runs?types=test', '/runs?types=failed', '/runs?q=label%3Agood', '/fixes', '/tests', '/training', '/training/tasks', '/compare', '/new'];
  const settings = ['matching', 'redaction', 'alerts', 'agents', 'tools', 'project', 'store'];
  expect(await sweep(page, [...pages.map((p): [string, () => Promise<void>] => [p, at(page, p)]), ...settings.map((t): [string, () => Promise<void>] => [`Settings → ${t}`, at(page, `/settings/${t}`)])])).toEqual([]);
});

test('every run of the demo, and every view of a few, has no serious or critical axe violation', async ({ page }) => {
  const all = runs().map(([name, id]): [string, () => Promise<void>] => [`run ${name}`, run(page, id)]);
  // A capture's Turns (litellm's, whose model called no tool, hold nothing that takes the focus) and a chat's too.
  const views = ['ticket', 'override', 'batchFork', 'eval', 'litellm', 'chat'].flatMap((name) => {
    const id = dash().runs[name] as string;
    return ['turns', 'context', 'timeline', 'forks', 'provenance'].map((v): [string, () => Promise<void>] => [`run ${name} · ${v}`, run(page, id, v)]);
  });
  expect(await sweep(page, [...all, ...views])).toEqual([]);
});

test('a run’s inspector tabs, menus and dialogs have no serious or critical axe violation', async ({ page }) => {
  const states: Array<[string, () => Promise<void>]> = [];
  for (const name of ['ticket', 'override', 'failTool', 'chat']) {
    const id = dash().runs[name] as string;
    states.push([`run ${name}`, run(page, id)]);
    for (const tab of ['Response', 'Request', 'Details', 'Conversation']) states.push([`run ${name} · inspector ${tab}`, click(page, '.insp [role="tablist"] button', tab, { shows: `.insp [role="tab"][aria-selected="true"]:has-text("${tab}")` })]);
    states.push([`run ${name} · Share`, click(page, '.rhead .actions button', 'Share', { shows: MENU })], [`run ${name} · Share closed`, escape(page, MENU)]);
    states.push([`run ${name} · the fork menu`, click(page, '#forkBtn', undefined, { shows: MENU })], [`run ${name} · the fork menu closed`, escape(page, MENU)]);
    states.push([`run ${name} · Delete`, click(page, '.rhead .actions button', 'Delete', { shows: DIALOG })], [`run ${name} · Delete closed`, escape(page)]);
  }
  // Edit and fork's dialog, from the inspector of the tool call the run failed at, which it opens on.
  states.push(['run failTool', run(page, dash().runs.failTool as string)], ['run failTool · Edit and fork', click(page, '.insp button', 'Edit and fork', { shows: DIALOG })], ['run failTool · Edit and fork closed', escape(page)]);
  expect(await sweep(page, states)).toEqual([]);
});

test('Fixes and each fix’s steps, Tests’ dialogs, the palette, the shortcuts and a toast have no serious or critical axe violation', async ({ page }) => {
  const states: Array<[string, () => Promise<void>]> = [];
  for (const fx of fixes()) for (const step of ['', '/blame', '/repair', '/verify']) states.push([`fix ${fx}${step}`, at(page, `/fixes/${fx}${step}`, 'fix')]);
  states.push(['Tests', at(page, '/tests')]);
  // Update goldens…'s dialog, when a golden diverged (Run tests starts its job at once: no dialog to sweep).
  states.push(['Tests · Update goldens…', async () => {
    const update = page.locator('main#view button', { hasText: 'Update goldens' });
    if (!(await update.count())) return;
    await update.first().click();
    await settled(page, { shows: DIALOG });
  }], ['Tests · Update goldens… closed', press(page, 'Escape')]);
  states.push(['Runs', at(page, '/runs', 'main#view table.runst tbody tr')], ['Runs · Import a capture', click(page, 'main#view button', 'Import a capture', { shows: DIALOG })], ['Runs · import closed', escape(page)]);
  states.push(['Runs · a run ticked', click(page, 'main#view table.runst tbody tr input[type="checkbox"]')]);
  // The palette's hits in what was recorded come from the server: swept once they have come.
  states.push(['the palette', press(page, 'Meta+k', { shows: '.palette' })], ['the palette with results', async () => {
    await page.keyboard.type('refund');
    await page.locator('#palList', { hasText: 'In recorded data' }).waitFor();
    await settled(page);
  }], ['the palette closed', escape(page, '.palette')]);
  // From the run ticked above, its checkbox focused again once the palette closed.
  states.push(['the shortcuts', press(page, '?', { shows: '.help' })], ['the shortcuts closed', escape(page, '.help')]);
  // The shortcuts on pages of each kind: the keys that don't apply there are listed apart.
  for (const [where, path, drawn] of [['the Overview', '/', 'overview'], ['Runs', '/runs', 'runs'], ['Fixes', '/fixes', 'main#view'], ['Settings', '/settings/alerts', 'main#view']] as const) {
    states.push([where, at(page, path, drawn)], [`the shortcuts on ${where}`, click(page, '#helpBtn', undefined, { shows: '.help' })], [`the shortcuts on ${where} closed`, escape(page, '.help')]);
  }
  // A toast with Undo: the good/bad key pressed, then put back with u.
  states.push(['a run', run(page, dash().runs.ticket as string)], ['a toast with Undo', click(page, '.rhead .runkey button', 'good', { shows: '.toast button:has-text("Undo")' })]);
  const found = await sweep(page, states);
  await page.keyboard.press('u');
  expect(found).toEqual([]);
});

test('the bar that says the dashboard can’t be reached has no serious or critical axe violation', async ({ page }) => {
  await openPage(page, `/run/${dash().runs.ticket as string}`, 'run');
  // The server stops answering: the bar comes once the page's next look fails.
  await page.route('**/api/**', (route) => route.abort());
  await page.waitForSelector('.connbar', { state: 'visible', timeout: 30_000 });
  expect((await seriousViolations(page)).map((v) => `the connection bar: ${v}`)).toEqual([]);
  await page.unroute('**/api/**');
});

test('on a phone, every page, Settings tab, fix step and dialog has no serious or critical axe violation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const states: Array<[string, () => Promise<void>]> = [];
  for (const p of ['/', '/runs', '/runs?types=failed', '/fixes', '/tests', '/training', '/compare', '/new', '/setup/store']) states.push([`${p} on a phone`, at(page, p)]);
  for (const t of ['matching', 'redaction', 'alerts', 'agents', 'tools', 'project', 'store']) states.push([`Settings → ${t} on a phone`, at(page, `/settings/${t}`)]);
  for (const fx of fixes()) for (const step of ['', '/blame', '/repair', '/verify']) states.push([`fix ${fx}${step} on a phone`, at(page, `/fixes/${fx}${step}`, 'fix')]);
  for (const name of ['ticket', 'litellm', 'batchFork']) {
    const id = dash().runs[name] as string;
    for (const v of ['', 'turns', 'timeline']) states.push([`run ${name}${v ? ` · ${v}` : ''} on a phone`, run(page, id, v)]);
  }
  states.push(['Runs on a phone', at(page, '/runs', 'main#view table.runst tbody tr')], ['Runs · Import a capture on a phone', click(page, 'main#view button', 'Import a capture', { shows: DIALOG })], ['Runs · import closed on a phone', escape(page)]);
  expect(await sweep(page, states)).toEqual([]);
});
