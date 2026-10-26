import { expect, test, type Page } from '@playwright/test';
import { dash, openPage } from './dashboard.js';

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
  await expect(page.locator('main#view .toolbar[role="status"]')).toHaveCount(0, { timeout: 60_000 });
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
