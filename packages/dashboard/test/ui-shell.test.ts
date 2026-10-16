import { describe, expect, it } from 'vitest';
import { MAX_DATASET_RUNS } from '../src/run-exports.js';
import { BULK_MAX } from '../src/runs-list.js';
import { dialogFocus } from '../ui/focus.js';
import { stripScroll } from '../ui/place.js';
import { BULK_BATCH, DATASET_MAX, datasetOff, inBatches, joinDeleted, joinLabelled } from '../ui/runspage/bulk.js';
import { TRACE_COPY } from '../ui/runspage/imports.js';
import { copyCompares, copyLine } from '../ui/runs.js';

describe('a tab strip on a narrow screen', () => {
  // A strip 358px wide, scrolled to its start; tabs from the start of its content.
  const strip = { scrollLeft: 0, width: 358 };

  it('scrolls a tab that is off its right edge into view, a little clear of the edge', () => {
    expect(stripScroll(strip, { left: 468, width: 59 })).toBe(468 + 59 + 16 - 358);
  });

  it('scrolls back to a tab off its left edge, and to the start of a tab wider than the strip', () => {
    expect(stripScroll({ scrollLeft: 300, width: 358 }, { left: 120, width: 80 })).toBe(104);
    expect(stripScroll({ scrollLeft: 300, width: 358 }, { left: 8, width: 80 })).toBe(0);
    expect(stripScroll(strip, { left: 400, width: 500 })).toBe(384);
  });

  it('leaves a strip alone when its tab shows already', () => {
    expect(stripScroll(strip, { left: 0, width: 84 })).toBeNull();
    expect(stripScroll({ scrollLeft: 200, width: 358 }, { left: 300, width: 80 })).toBeNull();
  });
});

describe('an exported copy’s project block', () => {
  it('counts the runs it holds in words', () => {
    expect(copyLine(['01M51X7D66'])).toBe('1 run · nothing runs from here');
    expect(copyLine(['01M51X7D66', '01M51X7H8Q'])).toBe('2 runs · nothing runs from here');
    expect(copyLine(undefined)).toBe('0 runs · nothing runs from here');
  });

  it('has Compare only when it holds two runs or more', () => {
    expect(copyCompares(['01M51X7D66'])).toBe(false);
    expect(copyCompares(undefined)).toBe(false);
    expect(copyCompares(['01M51X7EDD', '01M51X7H8Q'])).toBe(true);
  });
});

describe('the bulk bar', () => {
  it('offers Dataset up to what one dataset takes, and says why not past it', () => {
    expect(DATASET_MAX).toBe(MAX_DATASET_RUNS);
    expect(datasetOff(500)).toBeNull();
    expect(datasetOff(612)).toBe('At most 500 runs go into one dataset: 612 are picked');
  });

  it('sends a thousand ids at a time to the bulk routes, and joins what they answer', async () => {
    expect(BULK_BATCH).toBe(BULK_MAX);
    const ids = Array.from({ length: 2500 }, (_, i) => `run${i}`);
    const sent: number[] = [];
    const parts = await inBatches(ids, async (part) => {
      sent.push(part.length);
      return { done: part.slice(0, 1).map((runId) => ({ runId, labels: ['good'] })), skipped: [{ runId: part.at(-1)!, reason: 'no such run' }] };
    });
    expect(sent).toEqual([1000, 1000, 500]);
    const labelled = joinLabelled(parts);
    expect(labelled.done.map((d) => d.runId)).toEqual(['run0', 'run1000', 'run2000']);
    expect(labelled.skipped.map((s) => s.runId)).toEqual(['run999', 'run1999', 'run2499']);
    expect(joinDeleted([
      { done: ['a'], attempts: ['a1'], skipped: [], blobs: 2, bytes: 10 },
      { done: ['b'], attempts: [], skipped: [{ runId: 'c', reason: 'still recording' }], blobs: 1, bytes: 5 },
    ])).toEqual({ done: ['a', 'b'], attempts: ['a1'], skipped: [{ runId: 'c', reason: 'still recording' }], blobs: 3, bytes: 15 });
  });
});

describe('dialogs', () => {
  it('start on the field, else on the action, but on Cancel when the action is red', () => {
    expect(dialogFocus('lime')).toMatch(/textarea, input.*select, \.dlg-ok$/);
    expect(dialogFocus(undefined)).toMatch(/\.dlg-ok$/);
    expect(dialogFocus('danger')).toMatch(/textarea, input.*select, \.dlg-cancel$/);
  });
});

describe('importing a trace', () => {
  it('names the format of a trace id instead of offering a made-up one', () => {
    expect(TRACE_COPY.langfuse.id).toBe('a UUID or 32 hex characters, from the trace’s page');
    expect(TRACE_COPY.langsmith.id).toBe('a UUID, from the trace’s page in LangSmith');
    for (const t of Object.values(TRACE_COPY)) expect(t.id).not.toMatch(/[0-9a-f]{8}/);
  });
});
