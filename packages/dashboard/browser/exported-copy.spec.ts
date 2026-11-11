import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { dash, demoId, expectAccessible } from './dashboard.js';

/**
 * An exported copy as Share → HTML report gives it, opened from a file as whoever it is sent to opens
 * it: one script, built from an entry of its own (ui/main-copy.tsx) with only the pages a copy shows,
 * under a Content-Security-Policy that runs that script alone and loads nothing. In the dashboard a
 * run's views but Calls each wait for a script of their own (ui/components/OnShow.tsx); in a copy
 * they are in its one script. So the copy opens on the run that was shared and draws its every view,
 * lists its runs, compares them and opens its runs for any other page, asking nothing of a network,
 * with nothing refused and nothing thrown.
 */

test.describe.configure({ mode: 'serial' });

let folder = '';
let file = '';
let fork = '';
let parent = '';

test.beforeAll(async () => {
  const { origin, token } = dash();
  fork = demoId('override');
  parent = demoId('ticket');
  // The fork with the run it forked from, as the dashboard downloads the fork's copy.
  const res = await fetch(`${origin}/api/runs/${fork}/export`, { headers: { 'x-shadowlap-token': token } });
  expect(res.status).toBe(200);
  folder = mkdtempSync(join(tmpdir(), 'shadowlap-browser-copy-'));
  const path = join(folder, `shadowlap-${fork.slice(0, 10).toLowerCase()}.html`);
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  file = pathToFileURL(path).href;
});

test.afterAll(() => {
  if (folder) rmSync(folder, { recursive: true, force: true });
});

/** What the copy asks for beyond its own file, what the console says went wrong, and what it throws, as they come. */
function watch(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (r.url().split('#')[0] !== file && !r.url().startsWith('data:')) seen.push(`asked for ${r.url()}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error') seen.push(`said ${m.text()}`);
  });
  page.on('pageerror', (e) => seen.push(`threw ${e.message}`));
  return seen;
}

/** Opens the copy as a file, on the page it opens by itself. */
async function open(page: Page): Promise<string[]> {
  const seen = watch(page);
  await page.goto(file);
  await expect(page.locator('main#view .rhead .rnm')).toHaveAttribute('data-run', fork);
  return seen;
}

const hash = (page: Page) => page.evaluate(() => location.hash);

/** What each of a run's views but Calls draws once its code has run. */
const VIEWS = [
  ['Turns', '.turnlist'],
  ['Context', '.ctx'],
  ['Timeline', '.tl'],
  ['Forks', '.fnode'],
  ['Provenance', '.prov'],
  // A copy keeps no previews, and says so.
  ['Decisions', '.dview.dvnone'],
] as const;

test('an exported copy opens on the run that was shared and draws each of its views from its one script, with no serious or critical axe violation', async ({ page }) => {
  const seen = await open(page);
  // The fork, at the call where it forked, as a fork's page opens.
  expect(await hash(page)).toMatch(new RegExp(`^#/run/${fork}/\\d+$`));
  await expect(page.locator('main#view table.calls tbody tr[data-wi]').first()).toBeVisible();
  const views = page.getByRole('tablist', { name: 'Views' });
  for (const [view, drawn] of VIEWS) {
    await views.getByRole('tab', { name: view }).click();
    await expect(page.locator(`main#view .vbody ${drawn}`).first(), `${view} draws`).toBeVisible();
  }
  await expectAccessible(page);
  expect(seen).toEqual([]);
});

test('an exported copy lists its runs, compares them, and opens its runs for any other page', async ({ page }) => {
  const seen = await open(page);
  const sections = page.getByRole('navigation', { name: 'Sections' });
  const rows = page.locator('main#view table.runst tbody tr');
  await sections.getByRole('link', { name: /^Runs/ }).click();
  await expect(rows).toHaveCount(2);
  for (const id of [fork, parent]) await expect(rows.filter({ hasText: id.slice(0, 10) })).toHaveCount(1);
  await sections.getByRole('link', { name: 'Compare' }).click();
  await expect(page.locator('main#view .pickers')).toHaveCount(1);
  await expect(page.locator('main#view .prefix')).toBeVisible();
  // The fork against its parent, the verdict first; a row opens both calls from what the copy holds,
  // its call in the address, and its × closes it.
  await expect(page.locator('main#view .verdict.cmpv')).toBeVisible();
  const row = page.locator('main#view .paths2 button.cprow').first();
  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('main#view #cmpd a.more').first()).toBeVisible();
  expect(await hash(page)).toMatch(new RegExp(`^#/compare/${parent}/${fork}/\\d+$`));
  await page.locator('main#view #cmpd .cmpx').click();
  await expect(page.locator('main#view #cmpd')).toHaveCount(0);
  expect(await hash(page)).toBe(`#/compare/${parent}/${fork}`);
  // A page a copy doesn't hold, from a link or the address bar, opens its runs; the Overview's
  // address, the run that was shared.
  for (const other of ['#/fixes', '#/changes', '#/changes/verdicts/d2e8a1f', '#/tests', '#/training', '#/settings/redaction']) {
    await page.evaluate((to) => void (location.hash = to), other);
    await expect.poll(() => hash(page), other).toBe('#/runs');
    await expect(rows).toHaveCount(2);
  }
  await page.evaluate(() => void (location.hash = '#/'));
  await expect.poll(() => hash(page)).toMatch(new RegExp(`^#/run/${fork}/\\d+$`));
  expect(seen).toEqual([]);
});

test('an exported copy names itself in the sidebar and the status bar, and says which runs it doesn’t hold', async ({ page }) => {
  const seen = await open(page);
  const block = page.locator('#side .expblock');
  await expect(block.locator('b')).toHaveText('Exported copy');
  await expect(block.locator('span')).toHaveText(/^2 runs( · .+)?$/);
  await expect(block.locator('small')).toHaveText(/^read-only · /);
  await expect(page.locator('#side .skt')).toHaveText('In this copy');
  // Nothing a copy can't do: no Settings, no search, no live chip, no link to every run.
  await expect(page.locator('#side .side-foot, .top .search, .top .livechip, #side .side-k a')).toHaveCount(0);
  const status = page.locator('footer.status');
  await expect(status.locator('span.st-runs')).toHaveText('2 runs in this copy');
  await expect(status.locator('span.st-sync')).toHaveText(/^exported( .+)? · read-only$/);
  await expect(page.locator('.top .brand')).toHaveAttribute('aria-label', 'Shadowlap exported copy, the run it opens on');
  // A run it doesn't hold: a page that says so, the crumbs naming only the section.
  await page.evaluate(() => void (location.hash = '#/run/ZZZZZZZZZZZZ'));
  await expect(page.locator('main#view h1')).toHaveText('Nothing here');
  await expect(page.locator('main#view')).toContainText('No run ZZZZZZZZZZZZ in this copy.');
  await expect(page.locator('main#view a', { hasText: 'Open Runs' })).toHaveAttribute('href', '#/runs');
  await expect(page.locator('.top .crumbs')).not.toContainText('ZZZZ');
  await expectAccessible(page);
  expect(seen).toEqual([]);
});
