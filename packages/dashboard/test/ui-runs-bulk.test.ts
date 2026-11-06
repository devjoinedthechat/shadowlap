import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '../ui/api.js';
import { flush, pendingHidden } from '../ui/pending-delete.js';
import { BulkBar, type PickedRun } from '../ui/runspage/BulkBar.js';
import { labelSuggestions } from '../ui/runspage/bulk.js';
import { KEEPALIVE_BYTES, sendDelete } from '../ui/runspage/delete-runs.js';
import { switchProject } from '../ui/shell/ProjectBlock.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { ToastAction } from '../ui/toast.js';
import type { DeleteResult, JobView } from '../ui/types.js';
import { sheet } from './css-sheet.js';
import { addressBar } from './ui-route-helpers.js';
import { render, type Rendered } from './ui-render.js';

/**
 * The Runs page's bulk bar does what it shows, in the design's words. Delete names the attempts
 * bundled under the runs picked, which go with them, shows the `shadowlap rm` that deletes the same,
 * and waits out its toast, with Undo: the runs leave the lists at once, and go from the store only
 * when the toast goes, however it goes, or as the page goes. Pack asks for a folder first, as the run
 * page's Pack does, then packs every run in one job, into a folder each inside the one its dialog
 * names; it and Export dataset… wait while every run picked is still recording. Export dataset… says
 * how many redaction rules its copy applies and shows the command its job runs. On a phone the bar
 * wraps onto lines, so no action scrolls out of view, and a job's drawer opens above it.
 */

const A = '01M5H2DJ1WDXDJVF85FRE4DWH5';
const B = '01M5H2DJR44BY5EG2RQD7M4TXP';
const RUNS: PickedRun[] = [
  { runId: A, status: 'failed', startedAt: 1, attempts: 28 },
  { runId: B, status: 'completed', startedAt: 2, attempts: 16 },
];

const job = (kind: string): JobView => ({ id: 'j1', kind, title: 'Packing 2 runs', args: ['pack', A, './.shadowlap/exports/01m5h2dj1w'], runId: null, startedAt: 0, endedAt: null, done: false, code: null, newRunId: null, runs: [], lines: [], total: 0 }) as unknown as JobView;

const deleted = (ids: string[], skipped: DeleteResult['skipped'] = []): DeleteResult => ({ done: ids.filter((id) => !skipped.some((s) => s.runId === id)), attempts: Array.from({ length: 44 }, (_, i) => `ATTEMPT${i}`), skipped, blobs: 3, bytes: 1000 });

function setup(inMemory: Array<{ labels?: string[] }> = [], runs: PickedRun[] = RUNS, deleteRuns = (ids: string[]): Promise<DeleteResult> => Promise.resolve(deleted(ids))) {
  const toast = vi.fn<(text: string, kind?: string, action?: ToastAction) => void>();
  const refresh = vi.fn();
  const watched: Array<Promise<JobView>> = [];
  const client = {
    deleteRuns: vi.fn(deleteRuns),
    startJob: vi.fn((kind: string) => Promise.resolve(job(kind))),
    offers: vi.fn(() => Promise.resolve({ copies: { total: 3, pathless: 1, formats: [{ id: 'dataset', applies: 'messages', rules: 3 }] } })),
  };
  const app = {
    client: client as unknown as Client,
    exported: false,
    meta: null,
    actionsOff: null,
    hasKind: () => true,
    guard: (fn: () => void) => fn(),
    toast,
    refresh,
    watchJob: (p: Promise<JobView>) => watched.push(p),
    runs: inMemory,
  } as unknown as AppState;
  const clear = vi.fn();
  const onDone = vi.fn();
  return { client, toast, refresh, watched, clear, onDone, element: createElement(AppContext.Provider, { value: app }, createElement(BulkBar, { runs, store: false, clear, onDone })) };
}

/** Runs picked of their own, so a delete one test leaves landed hides nothing another reads. */
const picked = (tag: string, n = 2): PickedRun[] => Array.from({ length: n }, (_, i) => ({ runId: `01M5H2DJ${tag}${String(i).padStart(16, '0')}`, status: 'completed', startedAt: i, attempts: i ? 16 : 28, chips: ['recording'] }));

/** The toast the bar raised last: its words, its kind and its Undo. */
const lastToast = (s: ReturnType<typeof setup>) => s.toast.mock.calls.at(-1)!;

/** Confirms a Delete of the runs `s` picked, and hands back the toast it raised. */
async function confirmDelete(s: ReturnType<typeof setup>, runs: number) {
  r = await render(s.element);
  await r.click(r.byText('.bulkbar button', `Delete ${runs} runs`));
  await r.click(r.byText('.dialog button', `Delete ${runs} runs`));
  const [said, kind, undo] = lastToast(s);
  return { said, kind, undo: undo! };
}

const text = (r: Rendered, selector: string) => r.one(selector).textContent.replace(/\s+/g, ' ').trim();

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  vi.unstubAllGlobals();
});

describe('the bulk bar’s Delete', () => {
  it('names the attempts that go with the runs, shows the rm that deletes the same, and deletes once its toast goes', async () => {
    const s = setup();
    r = await render(s.element);
    await r.click(r.byText('.bulkbar button', 'Delete 2 runs'));
    expect(text(r, '.dialog h3')).toBe('Delete 2 runs?');
    expect(text(r, '.dialog header p')).toContain('Deletes the runs, their 44 attempts and the recorded data nothing else uses.');
    expect(text(r, '.dialog .dfacts')).toBe('Forks, replayskeep their own datathey lose the link to them');
    expect(text(r, '.dialog .cmdline')).toBe('$shadowlap rm 01M5H2DJ1W 01M5H2DJR4');
    await r.click(r.byText('.dialog button', 'Delete 2 runs'));
    // Gone from the lists at once, the toast saying so with Undo: nothing is deleted yet.
    expect(s.clear).toHaveBeenCalled();
    expect([A, B].every((id) => pendingHidden().has(id))).toBe(true);
    const [said, kind, undo] = lastToast(s);
    expect([said, kind, undo?.label, undo?.undo]).toEqual(['Deleted 2 runs and 44 attempts', 'notice', 'Undo', true]);
    expect(s.client.deleteRuns).not.toHaveBeenCalled();
    // Its time out, or a newer toast, sends it, once.
    undo!.onGone!(false);
    undo!.onGone!(false);
    await r.until('the delete to answer', () => s.refresh.mock.calls.length > 0);
    expect(s.client.deleteRuns).toHaveBeenCalledTimes(1);
    expect(s.client.deleteRuns).toHaveBeenCalledWith([A, B]);
    // It did what the toast said: no second toast, and the runs stay off the lists until they are read again.
    expect(s.toast).toHaveBeenCalledTimes(1);
    expect(pendingHidden().has(A)).toBe(true);
  });

  it('takes the runs back on Undo, the toast gone first as a press takes it, and deletes nothing', async () => {
    const runs = picked('UNDO');
    const s = setup([], runs);
    const { undo } = await confirmDelete(s, 2);
    expect(runs.every((x) => pendingHidden().has(x.runId))).toBe(true);
    undo.onGone!(true);
    undo.run();
    await r!.until('a tick', () => true);
    await Promise.resolve();
    expect(s.client.deleteRuns).not.toHaveBeenCalled();
    expect(lastToast(s)[0]).toBe('Restored 2 runs');
    expect(runs.some((x) => pendingHidden().has(x.runId))).toBe(false);
    // Undo again does nothing more.
    undo.run();
    expect(s.toast.mock.calls.filter((c) => c[0] === 'Restored 2 runs')).toHaveLength(1);
  });

  it('deletes when the toast is closed with its ×', async () => {
    const runs = picked('XOUT');
    const s = setup([], runs);
    const { undo } = await confirmDelete(s, 2);
    undo.onGone!(true);
    await r!.until('the delete to answer', () => s.refresh.mock.calls.length > 0);
    expect(s.client.deleteRuns).toHaveBeenCalledWith(runs.map((x) => x.runId));
  });

  it('says what it left alone in a second toast, the run left alone back on the lists', async () => {
    const runs = picked('PART');
    const [kept, gone] = [runs[1].runId, runs[0].runId];
    const s = setup([], runs, (ids) => Promise.resolve(deleted(ids, [{ runId: kept, reason: 'a replay of it is still running' }])));
    const { undo } = await confirmDelete(s, 2);
    undo.onGone!(false);
    await r!.until('the delete to answer', () => s.refresh.mock.calls.length > 0);
    expect(lastToast(s)[0]).toBe(`Deleted 1 of 2 runs and 44 attempts · ${kept.slice(0, 10)} was left alone: a replay of it is still running`);
    expect([pendingHidden().has(gone), pendingHidden().has(kept)]).toEqual([true, false]);
  });

  it('says why a delete failed, and brings its runs back', async () => {
    const runs = picked('FAIL');
    const s = setup([], runs, () => Promise.reject(new Error('the store is locked by another process')));
    const { undo } = await confirmDelete(s, 2);
    undo.onGone!(false);
    await r!.until('the delete to fail', () => s.refresh.mock.calls.length > 0);
    expect(lastToast(s).slice(0, 2)).toEqual(['The store is locked by another process', 'error']);
    expect(runs.some((x) => pendingHidden().has(x.runId))).toBe(false);
  });

  it('sends what waits as the page goes, with keepalive, its toast gone with it, so a page brought back deletes nothing twice', async () => {
    const runs = picked('HIDE');
    const s = setup([], runs);
    const { said, undo } = await confirmDelete(s, 2);
    for (const fn of (window as unknown as { heard: (t: string) => Array<(e: unknown) => void> }).heard('pagehide')) fn({ type: 'pagehide', persisted: true });
    expect(s.client.deleteRuns).toHaveBeenCalledTimes(1);
    expect(s.client.deleteRuns).toHaveBeenCalledWith(runs.map((x) => x.runId), { keepalive: true });
    // The toast with Undo is replaced by one without: on a page brought back, nothing waits to undo.
    expect(lastToast(s)).toEqual([said]);
    await r!.until('the delete to answer', () => s.refresh.mock.calls.length > 0);
    // The toast that waited, gone later, sends nothing; its Undo takes nothing back.
    undo.onGone!(false);
    undo.run();
    await Promise.resolve();
    expect(s.client.deleteRuns).toHaveBeenCalledTimes(1);
    expect(s.toast.mock.calls.some((c) => c[0].startsWith('Restored'))).toBe(false);
  });

  it('sends what waits before the project changes, its toast replaced by one without Undo, which takes nothing back', async () => {
    const runs = picked('SWAP');
    const s = setup([], runs);
    const { said, undo } = await confirmDelete(s, 2);
    addressBar('#/runs');
    const select = vi.fn(() => Promise.resolve());
    const app = { meta: { project: { id: 'here' } }, client: { projects: { select } }, reload: () => Promise.resolve(), toast: s.toast };
    await switchProject(app as unknown as AppState, 'there', '#/runs');
    expect(s.client.deleteRuns).toHaveBeenCalledTimes(1);
    expect(s.client.deleteRuns).toHaveBeenCalledWith(runs.map((x) => x.runId));
    expect(select).toHaveBeenCalledWith('there');
    // The delete is on its way, so the toast says the same with nothing to undo.
    expect(lastToast(s)).toEqual([said]);
    // The toast that waited, gone later, sends nothing; its Undo, or ⌘Z, takes nothing back.
    undo.onGone!(false);
    undo.run();
    await Promise.resolve();
    expect(s.client.deleteRuns).toHaveBeenCalledTimes(1);
    expect(s.toast.mock.calls.some((c) => c[0].startsWith('Restored'))).toBe(false);
  });

  it('raises no second toast for a delete its toast sent as it went', async () => {
    const runs = picked('GONE');
    const s = setup([], runs);
    const { undo } = await confirmDelete(s, 2);
    undo.onGone!(false);
    await r!.until('the delete to answer', () => s.refresh.mock.calls.length > 0);
    await flush();
    expect(s.toast).toHaveBeenCalledTimes(1);
    expect(s.client.deleteRuns).toHaveBeenCalledTimes(1);
  });

  it('keeps a page’s last requests within the browser’s keepalive room, and fails cleanly past it', async () => {
    const ids = Array.from({ length: 2500 }, (_, i) => `01M5H2DJKA${String(i).padStart(16, '0')}`);
    const asked: Array<{ n: number; keepalive: boolean }> = [];
    const client = {
      deleteRuns: (part: readonly string[], o?: { keepalive?: boolean }) => {
        asked.push({ n: part.length, keepalive: !!o?.keepalive });
        return o?.keepalive ? Promise.resolve(deleted([...part])) : Promise.reject(new TypeError('Failed to fetch'));
      },
    };
    expect(JSON.stringify({ ids: ids.slice(0, 1000) }).length * 2).toBeLessThanOrEqual(KEEPALIVE_BYTES);
    const { out, failed } = await sendDelete(client, ids, true);
    expect(asked).toEqual([
      { n: 1000, keepalive: true },
      { n: 1000, keepalive: true },
      { n: 500, keepalive: false },
    ]);
    // What came is kept; what failed fails alone, as an answer, never thrown.
    expect(out.done).toHaveLength(2000);
    expect(failed).toBeInstanceOf(TypeError);
  });
});

describe('the bulk bar’s words', () => {
  it('says the design’s words, Delete counting every run picked', async () => {
    r = await render(setup().element);
    expect(r.all('.bulkbar button').map((b) => b.textContent.trim())).toEqual(['Add label…', 'Pack', 'Export dataset…', 'Compare', 'Delete 2 runs', 'Clear selection']);
    await r.unmount();
    r = await render(setup([], RUNS.slice(0, 1)).element);
    expect(r.byText('.bulkbar button', 'Delete 1 run').getAttribute('aria-disabled')).toBeNull();
  });

  it('holds Pack and Export dataset… while every run picked is still recording, saying why', async () => {
    const live: PickedRun[] = [{ runId: A, status: 'running', startedAt: 1 }];
    const s = setup([], live);
    r = await render(s.element);
    for (const [label, title] of [
      ['Pack', 'Pack'],
      ['Export dataset…', 'Export dataset'],
    ] as const) {
      const b = r.byText('.bulkbar button', label);
      expect(b.getAttribute('aria-disabled')).toBe('true');
      expect(b.getAttribute('data-why')).toBe('Still recording: try when it ends');
      expect(JSON.parse(b.getAttribute('data-tip')!)).toEqual({ t: title, s: 'Waits until the recording ends: a copy now would be cut off', rows: [] });
      await r.click(b);
      expect(lastToast(s)[0]).toBe('Still recording: try when it ends');
    }
    expect(r.all('.dialog')).toHaveLength(0);
    await r.unmount();
    r = await render(setup([], [live[0], { ...live[0], runId: B }]).element);
    expect(r.byText('.bulkbar button', 'Pack').getAttribute('data-why')).toBe('Still recording: try when they end');
  });
});

describe('the bulk bar’s Pack', () => {
  it('asks first, then packs every run in one job, into a folder each inside the folder its dialog names', async () => {
    const s = setup();
    r = await render(s.element);
    await r.click(r.byText('.bulkbar button', 'Pack'));
    // Nothing is written before the dialog is answered.
    expect(s.client.startJob).not.toHaveBeenCalled();
    expect(text(r, '.dialog h3')).toBe('Pack 2 runs');
    expect(text(r, '.dialog .cmdline')).toBe('$shadowlap pack 01M5H2DJ1W .shadowlap/exports/01m5h2dj1w … and 1 more, one per run');
    await r.click(r.byText('.dialog button', 'Pack 2 runs'));
    expect(s.client.startJob).toHaveBeenCalledTimes(1);
    expect(s.client.startJob).toHaveBeenCalledWith('pack', { runIds: [A, B], dir: '.shadowlap/exports' });
    expect(s.watched).toHaveLength(1);
    expect(r.all('.dialog')).toHaveLength(0);
  });
});

describe('the bulk bar’s Label', () => {
  it('offers the labels runs carry as you type, most used first, ties in alphabetical order', async () => {
    expect(labelSuggestions([{ labels: ['refund', 'good'] }, { labels: ['good'] }, { labels: ['bad', 'refund'] }, { labels: [] }, {}])).toEqual(['good', 'refund', 'bad']);
    expect(labelSuggestions(null)).toEqual([]);
    const s = setup([{ labels: ['refund-bug'] }, { labels: ['good', 'refund-bug'] }]);
    r = await render(s.element);
    await r.click(r.byText('.bulkbar button', 'Add label…'));
    const field = r.one('.dialog input[type="text"]');
    const list = r.all('datalist').find((d) => d.getAttribute('id') === field.getAttribute('list'));
    expect(list?.children.map((o) => o.value)).toEqual(['refund-bug', 'good']);
  });

  it('offers none where no run carries a label', async () => {
    r = await render(setup().element);
    await r.click(r.byText('.bulkbar button', 'Add label…'));
    expect(r.one('.dialog input[type="text"]').getAttribute('list')).toBeNull();
    expect(r.all('datalist')).toHaveLength(0);
  });
});

describe('the bulk bar’s Dataset', () => {
  it('says how many redaction rules apply and shows the command its job runs, with the file it writes', async () => {
    const s = setup();
    r = await render(s.element);
    await r.click(r.byText('.bulkbar button', 'Export dataset…'));
    await r.until('the rules to load', () => r!.all('.dialog .dfacts div').length === 2);
    expect(s.client.offers).toHaveBeenCalledWith(A);
    expect(r.all('.dialog .dfacts div')[1].textContent).toBe('Redactsby 3 rulesthe store never changes');
    const cmd = text(r, '.dialog .cmdline');
    expect(cmd).toMatch(/^\$shadowlap export dataset 01M5H2DJ1W 01M5H2DJR4 --calls final --format jsonl --out \.shadowlap\/exports\/dataset-2-runs-\d{8}-\d{6}\.jsonl$/);
    // Titled and confirmed as a run's Share names it, for the runs it copies.
    expect(text(r, '.dialog header h3')).toBe('Export eval dataset of 2 runs');
    await r.click(r.byText('.dialog button', 'Export dataset'));
    // The file the command names is the file the job writes.
    const file = cmd.split('.shadowlap/exports/')[1];
    expect(s.client.startJob).toHaveBeenCalledWith('export-dataset', { runIds: [A, B], format: 'jsonl', calls: 'final', out: file });
  });
});

const css = sheet().replace(/\/\*[\s\S]*?\*\//g, '');

/** The value a window `width` px wide gives `property` of `selector`: its rules at the top level and in each `@media (max-width: …)` that takes the width in, the last one winning. */
function valueAt(width: number, selector: string, property: string): string | undefined {
  let value: string | undefined;
  const walk = (text: string, on: boolean) => {
    for (let i = 0; i < text.length; ) {
      const open = text.indexOf('{', i);
      if (open < 0) return;
      const head = text.slice(i, open).trim();
      let end = open + 1;
      for (let depth = 1; depth && end < text.length; end++) depth += text[end] === '{' ? 1 : text[end] === '}' ? -1 : 0;
      const body = text.slice(open + 1, end - 1);
      const max = /^@media \(max-width: (\d+)px\)$/.exec(head);
      if (max) walk(body, on && width <= Number(max[1]));
      else if (on && head.split(',').map((s) => s.trim()).includes(selector)) {
        for (const d of body.split(';')) if (d.split(':')[0]?.trim() === property) value = d.slice(d.indexOf(':') + 1).trim();
      }
      i = end;
    }
  };
  walk(css, true);
  return value;
}

describe('the bulk bar on a phone', () => {
  it('wraps onto lines rather than scroll an action out of view, and rides over a job’s docked drawer', () => {
    for (const width of [390, 668, 720]) {
      expect(valueAt(width, '.bulkbar', 'flex-wrap'), `${width}`).toBe('wrap');
      expect(valueAt(width, '.bulkbar', 'overflow'), `${width}`).toBe('visible');
      expect(valueAt(width, '.bulkbar .sep', 'display'), `${width}`).toBe('none');
      expect(valueAt(width, '.bulkbar b', 'flex-basis'), `${width}`).toBe('100%');
      expect(valueAt(width, 'body.docked .bulkbar', 'bottom'), `${width}`).toBe('calc(12px + var(--dock-h))');
    }
    // Wider, the bar keeps to one line, over the drawer and the status bar.
    expect(valueAt(721, '.bulkbar', 'flex-wrap')).toBeUndefined();
    expect(valueAt(1440, 'body.docked .bulkbar', 'bottom')).toBe('calc(44px + var(--dock-h))');
  });
});
