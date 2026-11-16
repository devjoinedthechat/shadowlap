import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { packRun, Store, storeApiRequest } from '@shadowlap/engine';
import { openPage, seriousViolations, sideways } from './dashboard.js';
import { DIALOG } from './routes.js';

/**
 * Import capture in bulk, in a real browser over the demo store: the traces that started in a window,
 * several OpenTelemetry files at once, and a pack's folder. Uploads and the job are answered here, so
 * nothing reaches the demo's project, which every test shares, and no import runs.
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

/** A recording and a replay of it, packed together into `<tmp>/support-refund` as `shadowlap pack --lineage` writes them. */
function packFolder(): { dir: string; runIds: string[] } {
  const store = Store.open(':memory:');
  try {
    const call = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: 'f'.repeat(64), occurrence: 1 };
    const command = { argv: ['node', 'agent.js'], cwd: '/work' };
    const recording = store.createRun({ mode: 'record', command }).runId;
    const request = storeApiRequest(store, { model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'Refund order A-1103' }] });
    const response = store.putBlob(Buffer.from('event: message_start\ndata: {}\n\n'));
    store.appendCallStart({ runId: recording, callNo: 1, ...call, origin: 'live', effect: null, requestRef: request, meta: {}, at: 1 });
    store.appendCallEnd(call, { runId: recording, callNo: 1, attempt: 0, responseRef: response, outcome: 'ok', meta: { status: 200 }, at: 2 });
    store.endRun(recording, 'completed');
    const replay = store.createRun({ mode: 'replay', parentRunId: recording, command }).runId;
    store.appendCallStart({ runId: replay, callNo: 1, ...call, origin: 'replayed', effect: null, requestRef: request, meta: {}, at: 3 });
    store.appendCallEnd(call, { runId: replay, callNo: 1, attempt: 0, responseRef: response, outcome: 'ok', meta: { status: 200, replayedFrom: 1 }, at: 4 });
    store.endRun(replay, 'completed');
    const dir = join(mkdtempSync(join(tmpdir(), 'sl-browser-pack-')), 'support-refund');
    return { dir, runIds: packRun(store, replay, dir, { lineage: true }).runs };
  } finally {
    store.close();
  }
}

test('Import capture takes a pack’s folder, says what it holds, fits a phone, sends it up as one archive, and its drawer links the runs it brought in', async ({ page }) => {
  const { dir, runIds } = packFolder();
  const uploadId = '01K0UPLOAD0000000000000001';
  const job = { id: 'feedfacefeedpac1', kind: 'import', title: 'Importing pack', args: ['unpack', `.shadowlap/uploads/${uploadId}/support-refund`], worktree: null, runId: null, opensRun: true, startedAt: Date.now(), stopped: false, runs: [], links: [], files: [] };
  const ended = { ...job, done: true, code: 0, newRunId: runIds[1], runs: runIds, links: runIds.map((id) => ({ label: `Open ${id.slice(0, 10)}`, href: `#/run/${id}` })), result: { imported: runIds, skipped: [], mismatched: [] }, lines: runIds.map((id) => `imported ${id}  command: node agent.js`), total: 2 };
  const sent = { uploads: [] as Array<{ name: string; body: Buffer }>, jobs: [] as unknown[] };
  await page.route((url) => url.pathname === '/api/uploads', (route) => {
    const name = decodeURIComponent(route.request().headers()['x-filename'] ?? '');
    const body = route.request().postDataBuffer() ?? Buffer.alloc(0);
    sent.uploads.push({ name, body });
    return route.fulfill({ status: 201, json: { uploadId, name, bytes: body.length } });
  });
  await page.route((url) => url.pathname === '/api/jobs', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    sent.jobs.push(route.request().postDataJSON());
    return route.fulfill({ status: 202, json: { ...job, done: false, code: null, newRunId: null, lines: [], total: 0 } });
  });
  await page.route((url) => url.pathname === `/api/jobs/${job.id}`, (route) => route.fulfill({ json: ended }));
  try {
    await openPage(page, '/runs', 'main#view table.runst tbody tr');
    await page.locator('main#view button', { hasText: 'Import capture…' }).click();
    const dialog = page.locator(DIALOG);
    await dialog.locator('.impsrc button', { hasText: 'Pack' }).click();
    await expect(dialog.locator('.cmdline')).toContainText('shadowlap unpack <folder>');
    // The folder picker takes the folder whole, each file by its path in it.
    await dialog.locator('input[type="file"]').setInputFiles(dir);
    await expect(dialog.locator('.capfile code')).toHaveText('support-refund');
    await expect(dialog.locator('.dfacts dt')).toHaveText(['Holds', 'Run', 'On replay']);
    await expect(dialog.locator('.dfacts dd').first()).toContainText('2 runs, 2 calls');
    await expect(dialog.locator('.dfacts dd').nth(1)).toContainText(runIds[1]!.slice(0, 10));
    await expect(dialog.locator('.cmdline')).toContainText('shadowlap unpack support-refund');
    expect(await seriousViolations(page)).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await sideways(page)).toBe(0);
    await dialog.locator('.dlg-ok').click();
    await expect.poll(() => sent.jobs).toEqual([{ kind: 'import', format: 'pack', uploadId }]);
    // One upload, an ordinary tar of what unpack reads: no .gitattributes.
    expect(sent.uploads.map((u) => u.name)).toEqual(['support-refund.tar']);
    const tar = join(dir, '..', 'sent.tar');
    writeFileSync(tar, sent.uploads[0]!.body);
    const names = execFileSync('tar', ['-tf', tar], { encoding: 'utf8' }).trim().split('\n');
    expect(names.slice(0, 3)).toEqual(['run.json', 'calls.jsonl', 'blobs/']);
    expect(names.slice(3).every((n) => /^blobs\/[0-9a-f]{64}$/.test(n))).toBe(true);
    const drawer = page.locator('section.drawer');
    await expect(drawer).toContainText('Imported pack');
    await expect(drawer).toContainText('2 runs · exit 0');
    for (const id of runIds) await expect(drawer.locator(`a[href="#/run/${id}"]`).first()).toBeVisible();
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
});
