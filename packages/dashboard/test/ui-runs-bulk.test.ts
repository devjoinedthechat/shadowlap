import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '../ui/api.js';
import { BulkBar, type PickedRun } from '../ui/runspage/BulkBar.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { DeleteResult, JobView } from '../ui/types.js';
import { sheet } from './css-sheet.js';
import { render, type Rendered } from './ui-render.js';

/**
 * The Runs page's bulk bar does what it shows. Delete names the attempts bundled under the runs
 * picked, which go with them, shows the `shadowlap rm` that deletes the same, and counts them once
 * done. Pack asks for a folder first, as the run page's Pack does, then packs every run in one job,
 * into a folder each inside the one its dialog names. Dataset says how many redaction rules its copy
 * applies and shows the command its job runs. On a phone the bar wraps onto lines, so no action
 * scrolls out of view, and a job's drawer opens above it.
 */

const A = '01M5H2DJ1WDXDJVF85FRE4DWH5';
const B = '01M5H2DJR44BY5EG2RQD7M4TXP';
const RUNS: PickedRun[] = [
  { runId: A, status: 'failed', startedAt: 1, attempts: 28 },
  { runId: B, status: 'completed', startedAt: 2, attempts: 16 },
];

const job = (kind: string): JobView => ({ id: 'j1', kind, title: 'Packing 2 runs', args: ['pack', A, './.shadowlap/exports/01m5h2dj1w'], runId: null, startedAt: 0, endedAt: null, done: false, code: null, newRunId: null, runs: [], lines: [], total: 0 }) as unknown as JobView;

function setup() {
  const toast = vi.fn();
  const watched: Array<Promise<JobView>> = [];
  const client = {
    deleteRuns: vi.fn((ids: string[]): Promise<DeleteResult> => Promise.resolve({ done: ids, attempts: Array.from({ length: 44 }, (_, i) => `ATTEMPT${i}`), skipped: [], blobs: 3, bytes: 1000 })),
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
    watchJob: (p: Promise<JobView>) => watched.push(p),
  } as unknown as AppState;
  const clear = vi.fn();
  const onDone = vi.fn();
  return { client, toast, watched, clear, onDone, element: createElement(AppContext.Provider, { value: app }, createElement(BulkBar, { runs: RUNS, store: false, clear, onDone })) };
}

const text = (r: Rendered, selector: string) => r.one(selector).textContent.replace(/\s+/g, ' ').trim();

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

describe('the bulk bar’s Delete', () => {
  it('names the attempts that go with the runs, shows the rm that deletes the same, and counts them once done', async () => {
    const s = setup();
    r = await render(s.element);
    await r.click(r.byText('.bulkbar button', 'Delete'));
    expect(text(r, '.dialog h3')).toBe('Delete 2 runs and the 44 attempts bundled under them?');
    expect(text(r, '.dialog header p')).toBe('Removes the runs, the attempts bundled under them and the recorded data nothing else uses. Their forks keep their own data but lose the link.');
    expect(text(r, '.dialog .cmdline')).toBe('$shadowlap rm 01M5H2DJ1W 01M5H2DJR4');
    await r.click(r.byText('.dialog button', 'Delete 2 runs'));
    await r.until('the delete to answer', () => s.toast.mock.calls.length > 0);
    expect(s.client.deleteRuns).toHaveBeenCalledWith([A, B]);
    expect(s.toast).toHaveBeenCalledWith('Deleted 2 runs and 44 attempts');
    expect(s.clear).toHaveBeenCalled();
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

describe('the bulk bar’s Dataset', () => {
  it('says how many redaction rules apply and shows the command its job runs, with the file it writes', async () => {
    const s = setup();
    r = await render(s.element);
    await r.click(r.byText('.bulkbar button', 'Dataset'));
    await r.until('the rules to load', () => text(r!, '.dialog header p').includes('redaction rules'));
    expect(s.client.offers).toHaveBeenCalledWith(A);
    expect(text(r, '.dialog header p')).toContain('The 3 redaction rules apply to the conversations and answers it keeps.');
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
  it('wraps onto lines rather than scroll an action out of view, and a job’s drawer opens above them', () => {
    for (const width of [390, 668, 720]) {
      expect(valueAt(width, '.bulkbar', 'flex-wrap'), `${width}`).toBe('wrap');
      expect(valueAt(width, '.bulkbar', 'overflow'), `${width}`).toBe('visible');
      expect(valueAt(width, '.bulkbar .sep', 'display'), `${width}`).toBe('none');
      expect(valueAt(width, '.bulkbar b', 'flex-basis'), `${width}`).toBe('100%');
      expect(valueAt(width, 'body:has(.bulkbar) .drawer', 'bottom'), `${width}`).toBe('156px');
    }
    // Wider, the bar keeps to one line, with the drawer just above it.
    expect(valueAt(721, '.bulkbar', 'flex-wrap')).toBeUndefined();
    expect(valueAt(721, 'body:has(.bulkbar) .drawer', 'bottom')).toBe('100px');
  });
});
