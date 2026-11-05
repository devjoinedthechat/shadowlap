import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { begin, cancel, deleting, flush, lessPending, pendingHidden, sendNow, useStillCounted, withoutPending, type PendingRun } from '../ui/pending-delete.js';
import { lessChips } from '../ui/runspage/rows.js';
import type { ChipCounts } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Runs a delete waits to take are off every list at once, and their counts less them, until the
 * delete is undone or lands; once it lands, a count read before still takes them, and one read
 * after holds the delete already. A delete goes once, however many ways it is sent.
 */

const run = (runId: string, chips: string[] = ['recording'], attempts = 0): PendingRun => ({ runId, chips, attempts, startedAt: 0 });

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

describe('a delete waiting out its toast', () => {
  it('takes its runs off the lists, gives them back on Undo, and is sent once', async () => {
    let sent = 0;
    const b = begin([run('PD-A'), run('PD-B')], () => (sent++, Promise.resolve(['PD-A', 'PD-B'])));
    expect(deleting()).toBe(true);
    expect(withoutPending([{ runId: 'PD-A' }, { runId: 'PD-C' }], pendingHidden())).toEqual([{ runId: 'PD-C' }]);
    expect(cancel(b)).toBe(true);
    expect(pendingHidden().has('PD-A')).toBe(false);
    expect(sendNow(b)).toBeNull();
    expect(sent).toBe(0);
    const c = begin([run('PD-C')], () => (sent++, Promise.resolve(['PD-C'])));
    await Promise.all([sendNow(c), flush(), flush(true)]);
    expect(sent).toBe(1);
    expect(cancel(c)).toBe(false);
    expect(pendingHidden().has('PD-C')).toBe(true);
    expect(deleting()).toBe(false);
  });

  it('takes a delete from a count read before it landed, and not from one read after', async () => {
    let shown: number[] = [];
    function Counts({ source }: { source: object }) {
      shown = [...shown, useStillCounted(source).length];
      return null;
    }
    const before = { runs: 10 };
    const b = begin([run('PD-D'), run('PD-E')], () => Promise.resolve(['PD-D']));
    r = await render(createElement(Counts, { source: before }));
    expect(shown.at(-1)).toBe(2);
    void sendNow(b);
    // Landed: only the run it deleted, and only from the count read before.
    await r.until('the delete to land', () => shown.at(-1) === 1);
    await r.unmount();
    r = await render(createElement(Counts, { source: { runs: 9 } }));
    expect(shown.at(-1)).toBe(0);
  });

  it('takes the runs from a page’s chip counts and the store’s, none below nothing', () => {
    const counts: ChipCounts = { all: 5, recording: 3, fork: 1, clean: 0, test: 0, capture: 1, failed: 2, local: 0 };
    expect(lessChips(counts, [run('a', ['recording', 'failed']), run('b', ['fork', 'local'])])).toEqual({ all: 3, recording: 2, fork: 0, clean: 0, test: 0, capture: 1, failed: 1, local: 0 });
    expect(lessChips(null, [run('a')])).toBeNull();
    expect(lessChips(counts, [])).toBe(counts);
    expect(lessPending(10, [run('a', [], 4), run('b', [], 2)])).toBe(8);
    expect(lessPending(10, [run('a', [], 4), run('b', [], 2)], 'attempts')).toBe(4);
    expect(lessPending(1, [run('a'), run('b')])).toBe(0);
    expect(lessPending(null, [run('a')])).toBeNull();
  });
});
