import { expect, test, type Page } from '@playwright/test';
import { receiptDuration } from '../ui/format.js';
import { dash, demoId, openPage, patched, RESET_RETRY } from './dashboard.js';

/**
 * A long run opens on the call its address names, and keeps it in view while the rest of its pages
 * come: the rows above it change height as they are read (a call not read yet is one line, a batch
 * item's head and its calls more), and each change moved the call off the view until the reader
 * scrolled. A batch run of 1,200 calls opened on #600 showed #522 to #533 once its pages were read.
 */

/** The calls in the views pane's view, by number, and whether the selected one is among them. */
function inView(page: Page): Promise<{ selected: string | null; shown: string[]; inView: boolean }> {
  return page.evaluate(() => {
    const pane = document.querySelector('main#view .vbody')!;
    const box = pane.getBoundingClientRect();
    const rows = [...pane.querySelectorAll<HTMLElement>('table.calls tbody tr[data-wi]')];
    const seen = (r: HTMLElement) => {
      const b = r.getBoundingClientRect();
      return b.bottom > box.top && b.top < box.bottom;
    };
    const sel = rows.find((r) => r.getAttribute('aria-selected') === 'true') ?? null;
    return { selected: sel?.querySelector('td')?.textContent ?? null, shown: rows.filter(seen).map((r) => r.querySelector('td')?.textContent ?? ''), inView: !!sel && seen(sel) };
  });
}

/** Until every page of the run is read: the line that says how many are read is gone. */
async function everyPageRead(page: Page): Promise<void> {
  await expect(page.locator('main#view .toolbar')).toHaveCount(0, { timeout: 60_000 });
}

test.describe.configure({ timeout: 120_000 });

for (const [name, at] of [['batch', 600], ['batch', 1100], ['batchFork', null]] as const) {
  test(`${name} opens on ${at === null ? 'where it forked' : `#${at}`} and keeps that call in view while its pages come`, async ({ page }) => {
    const id = dash().runs[name] as string;
    await openPage(page, `/run/${id}${at === null ? '' : `/${at}`}`, 'main#view table.calls tbody tr[data-wi]');
    await everyPageRead(page);
    // Laid out once more after the last page: what the reader sees.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const where = await inView(page);
    if (at !== null) expect(where.selected).toBe(String(at));
    expect(where, `the view shows ${where.shown[0]} to ${where.shown.at(-1)}`).toMatchObject({ inView: true });
  });
}

test('a replay that ended early opens where it stopped, and its finding names the recording’s call it never made, which opens there', async ({ page }) => {
  // The demo's clean replay, as the server sends a replay that stopped after its first ten calls: its
  // divergence at the recording's first call it never made, which an older server named the fork too.
  const id = demoId('clean');
  const recording = demoId('ticket');
  await page.route(new RegExp(`/api/runs/${id}(\\?.*)?$`), (route) =>
    patched<{ run: object; state: object; calls: Array<{ callNo: number }> }>(route, (d) => {
      const calls = d.calls.slice(0, 10);
      const at = calls.length + 1;
      const divergence = { type: 'ended_early', callNo: at, kind: 'api', name: 'POST /v1/messages', replayedBefore: calls.length, recorded: d.calls.length, counterpart: { runId: recording, callNo: at } };
      return { ...d, run: { ...d.run, divergence }, state: { ...d.state, kind: 'fork' }, calls, callsTotal: calls.length, callsNext: null, forkAt: at };
    }),
  );
  await openPage(page, `/run/${id}`, 'main#view table.calls tbody tr[data-wi]');
  // Where it stopped: its last call, shown in the inspector, never "No calls in this run".
  await expect(page.locator('main#view table.calls tbody tr[aria-selected="true"] td').first()).toHaveText('10');
  await expect(page).toHaveURL(new RegExp(`/run/${id}/10`));
  await expect(page.locator('main#view').getByText('No calls in this run.')).toHaveCount(0);
  // Ended early, as Runs and the sidebar say it, at the recording's call, which its number opens on the recording's page.
  await expect(page.locator('main#view .rhead .ek .ebk')).toHaveText('ended early @11');
  const finding = page.locator('main#view .findings .banner.fork');
  await expect(finding.locator('.bk')).toHaveText('ended early at');
  await expect(finding.locator('a.bn')).toHaveAttribute('href', `#/run/${recording}/11`);
  await expect(page.locator('main#view table.calls .fk')).toHaveCount(0);
});

test('a long fork’s header says the time not waited of the whole run once every page is read, never its first calls’ as the run’s', async ({ page, request }) => {
  const id = dash().runs.batchFork as string;
  const { origin, token } = dash();
  // Every replayed call's recorded duration, as each page of its calls says it with every fact.
  let sum = 0;
  for (let from: number | null = 1; from !== null; ) {
    const res = await request.get(`${origin}/api/runs/${id}/calls?from=${from}&limit=500&whole=1`, { headers: { 'x-shadowlap-token': token }, ...RESET_RETRY });
    const p = (await res.json()) as { calls: Array<{ origin: string; recordedMs?: number | null }>; callsNext: number | null };
    for (const c of p.calls) if (c.origin === 'replayed' && typeof c.recordedMs === 'number') sum += c.recordedMs;
    from = p.callsNext;
  }
  expect(sum).toBeGreaterThan(0);
  await openPage(page, `/run/${id}`, 'main#view table.calls tbody tr[data-wi]');
  await everyPageRead(page);
  const waited = page.locator('main#view .rhead .metrics .metric', { hasText: 'not waited' });
  await expect(waited.locator('b')).toHaveText(receiptDuration(sum));
});
