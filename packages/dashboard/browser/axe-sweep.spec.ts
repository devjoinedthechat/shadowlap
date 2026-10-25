import { expect, test, type Page } from '@playwright/test';
import { dash, openPage, seriousViolations } from './dashboard.js';

/**
 * axe-core's WCAG 2.2 A and AA rules over everything the whole demo shows: every page, every run with
 * each view, its inspector's tabs, its menus and dialogs, Fixes and each fix's steps, Tests and its
 * dialogs, Settings' tabs, the palette, the shortcuts and a toast with Undo. Any serious or critical
 * violation fails, named with the state it was found in.
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

const at = (page: Page, path: string, drawn = 'main#view') => async () => {
  await openPage(page, path, drawn);
  await page.waitForTimeout(250);
};
const run = (page: Page, id: string, view = '') => at(page, `/run/${id}${view ? `/${view}` : ''}`, 'run');
const click = (page: Page, selector: string, text?: string) => async () => {
  await page.locator(selector, text ? { hasText: text } : {}).first().click();
  await page.waitForTimeout(250);
};
const press = (page: Page, key: string) => async () => {
  await page.keyboard.press(key);
  await page.waitForTimeout(250);
};

test.describe.configure({ timeout: 300_000 });

test('every page and Settings tab has no serious or critical axe violation', async ({ page }) => {
  const pages = ['/', '/runs', '/runs?types=capture', '/runs?types=test', '/runs?types=failed', '/runs?q=label%3Agood', '/fixes', '/tests', '/training', '/training/tasks', '/compare', '/new'];
  const settings = ['matching', 'redaction', 'alerts', 'agents', 'tools', 'project', 'store'];
  expect(await sweep(page, [...pages.map((p): [string, () => Promise<void>] => [p, at(page, p)]), ...settings.map((t): [string, () => Promise<void>] => [`Settings → ${t}`, at(page, `/settings/${t}`)])])).toEqual([]);
});

test('every run of the demo, and every view of a few, has no serious or critical axe violation', async ({ page }) => {
  const all = runs().map(([name, id]): [string, () => Promise<void>] => [`run ${name}`, run(page, id)]);
  const views = ['ticket', 'override', 'batchFork', 'eval'].flatMap((name) => {
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
    for (const tab of ['Response', 'Request', 'Details', 'Conversation']) states.push([`run ${name} · inspector ${tab}`, click(page, '.insp [role="tablist"] button', tab)]);
    states.push([`run ${name} · Share`, click(page, '.rhead .actions button', 'Share')], [`run ${name} · Share closed`, press(page, 'Escape')]);
    states.push([`run ${name} · the fork menu`, click(page, '#forkBtn')], [`run ${name} · the fork menu closed`, press(page, 'Escape')]);
    states.push([`run ${name} · Delete`, click(page, '.rhead .actions button', 'Delete')], [`run ${name} · Delete closed`, press(page, 'Escape')]);
  }
  // Edit and fork's dialog, from the inspector of the tool call the run failed at, which it opens on.
  states.push(['run failTool', run(page, dash().runs.failTool as string)], ['run failTool · Edit and fork', click(page, '.insp button', 'Edit and fork')], ['run failTool · Edit and fork closed', press(page, 'Escape')]);
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
    await page.waitForTimeout(250);
  }], ['Tests · Update goldens… closed', press(page, 'Escape')]);
  states.push(['Runs', at(page, '/runs', 'main#view table.runst tbody tr')], ['Runs · Import a capture', click(page, 'main#view button', 'Import a capture')], ['Runs · import closed', press(page, 'Escape')]);
  states.push(['Runs · a run ticked', click(page, 'main#view table.runst tbody tr input[type="checkbox"]')]);
  states.push(['the palette', press(page, 'Meta+k')], ['the palette with results', async () => {
    await page.keyboard.type('refund');
    await page.waitForTimeout(800);
  }], ['the palette closed', press(page, 'Escape')]);
  states.push(['the shortcuts', press(page, '?')], ['the shortcuts closed', press(page, 'Escape')]);
  // A toast with Undo: the good/bad key pressed, then put back with u.
  states.push(['a run', run(page, dash().runs.ticket as string)], ['a toast with Undo', click(page, '.rhead .runkey button', 'good')]);
  const found = await sweep(page, states);
  await page.keyboard.press('u');
  expect(found).toEqual([]);
});
