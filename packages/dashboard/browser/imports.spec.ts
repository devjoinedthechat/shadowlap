import { expect, test } from '@playwright/test';
import { openPage, seriousViolations, sideways } from './dashboard.js';
import { DIALOG } from './routes.js';

/**
 * Import capture in bulk, in a real browser over the demo store: the traces that started in a window,
 * and several OpenTelemetry files at once. Uploads and the job are answered here, so nothing reaches
 * the demo's project, which every test shares, and no import runs.
 */

// A route may still be reading the server's answer as a test ends; the page's close takes it away, and that is no failure.
test.afterEach(({ page }) => page.unrouteAll({ behavior: 'ignoreErrors' }));

/** Answers the import's uploads and its job here, keeping what the page sent. */
async function answered(page: import('@playwright/test').Page): Promise<{ uploads: string[]; jobs: unknown[] }> {
  const sent = { uploads: [] as string[], jobs: [] as unknown[] };
  await page.route((url) => url.pathname === '/api/uploads', (route) => {
    const name = decodeURIComponent(route.request().headers()['x-filename'] ?? '');
    sent.uploads.push(name);
    return route.fulfill({ status: 201, json: { uploadId: `01K0UPLOAD${String(sent.uploads.length).padStart(16, '0')}`, name, bytes: 20 } });
  });
  await page.route((url) => url.pathname === '/api/jobs', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    sent.jobs.push(route.request().postDataJSON());
    return route.fulfill({ status: 202, json: { id: 'feedfacefeedfac3', kind: 'import', title: 'Importing', args: [], worktree: null, runId: null, opensRun: true, startedAt: Date.now(), done: true, stopped: false, code: 0, newRunId: null, lines: [], total: 0 } });
  });
  return sent;
}

test('Import capture reads the traces that started in a window, its fields checked as typed, and fits a phone', async ({ page }) => {
  const sent = await answered(page);
  // The stores as this machine reaches them, Langfuse's keys set (examples: nothing is fetched).
  await page.route((url) => url.pathname === '/api/imports', async (route) => {
    const body = (await (await route.fetch()).json()) as { traces: { langfuse: { keys: boolean } } };
    body.traces.langfuse.keys = true;
    return route.fulfill({ json: body });
  });
  await openPage(page, '/runs', 'main#view table.runst tbody tr');
  await page.locator('main#view button', { hasText: 'Import capture…' }).click();
  const dialog = page.locator(DIALOG);
  await dialog.locator('.impsrc button', { hasText: 'Langfuse' }).click();
  await dialog.locator('.impmode button', { hasText: 'Traces in a window' }).click();
  await dialog.getByLabel('Since').fill('last week');
  await expect(dialog.locator('.fieldnote.err')).toContainText('--since: a date (2026-09-30)');
  await expect(dialog.locator('.dlg-ok')).toBeDisabled();
  await dialog.getByLabel('Since').fill('7d');
  await dialog.getByLabel('At most').fill('50');
  await expect(dialog.locator('.cmdline')).toContainText('shadowlap import langfuse --since 7d --limit 50');
  expect(await seriousViolations(page)).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await sideways(page)).toBe(0);
  await dialog.locator('.dlg-ok').click();
  await expect.poll(() => sent.jobs).toEqual([{ kind: 'import', format: 'langfuse', window: { since: '7d', limit: '50' } }]);
});

test('Import capture takes several OpenTelemetry files at once, uploads each, and imports them as one', async ({ page }) => {
  const sent = await answered(page);
  await openPage(page, '/runs', 'main#view table.runst tbody tr');
  await page.locator('main#view button', { hasText: 'Import capture…' }).click();
  const dialog = page.locator(DIALOG);
  await dialog.locator('input[type="file"]').setInputFiles([
    { name: 'traces.json', mimeType: 'application/json', buffer: Buffer.from('{"resourceSpans":[]}') },
    { name: 'logs.json', mimeType: 'application/json', buffer: Buffer.from('{"resourceLogs":[]}') },
  ]);
  await expect(dialog.locator('.capfile code')).toHaveText(['traces.json', 'logs.json']);
  await expect(dialog.locator('.cmdline')).toContainText('shadowlap import otel traces.json logs.json');
  expect(await seriousViolations(page)).toEqual([]);
  await dialog.locator('.dlg-ok').click();
  await expect.poll(() => sent.jobs).toEqual([{ kind: 'import', format: 'otel', uploadIds: ['01K0UPLOAD0000000000000001', '01K0UPLOAD0000000000000002'] }]);
  expect(sent.uploads).toEqual(['traces.json', 'logs.json']);
});
