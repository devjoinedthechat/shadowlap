import { createElement, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client, RunsQuery } from '../ui/api.js';
import { RunsPage } from '../ui/pages/Runs.js';
import { warmingLine, withFirstPage } from '../ui/runspage/rows.js';
import { WHOLE_UP_TO, type TableRun } from '../ui/runspage/RunsTable.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Runs reads its table a page at a time. When the runs move it reads its first page again, and only
 * that: the rows after it stay as they were read, from where the new first page ends, rather than
 * every page shown being read again on every change. Past 200 rows, it draws those in view and a
 * screenful either side.
 */

const T = Date.UTC(2026, 9, 22, 7, 48);
const row = (n: number): TableRun =>
  ({
    runId: `01M5H2${String(n).padStart(20, '0')}`,
    parentRunId: null,
    depth: 0,
    mode: 'record',
    status: 'completed',
    label: 'recording',
    divergence: null,
    command: 'node agent.mjs',
    codeVersion: null,
    startedAt: T - n * 60_000,
    endedAt: T - n * 60_000 + 1000,
    calls: 4,
    spent: 0,
    saved: 0,
    captured: 0,
    imported: false,
    covers: null,
    source: null,
    labels: [],
    about: { text: `run ${n}`, from: 'user' },
    kind: 'recording',
    outcome: { kind: 'none' },
    failed: false,
    origins: 'llll',
  }) as unknown as TableRun;

describe('the rows after the first page is read again', () => {
  const had = Array.from({ length: 150 }, (_, i) => row(i));
  it('keeps the rows after it as they were, from where it ends', () => {
    // Two new runs on top: the first page ends two rows earlier in what was read before.
    const first = [row(-2), row(-1), ...had.slice(0, 48)];
    const { rows, kept } = withFirstPage(had, first);
    expect(rows.map((r) => r.runId)).toEqual([row(-2), row(-1), ...had].map((r) => r.runId));
    expect(kept).toBe(102);
    // A run deleted elsewhere is gone from the first page, and from what is kept.
    const without = withFirstPage(had, [...had.slice(0, 10), ...had.slice(11, 51)]);
    expect(without.rows).toHaveLength(149);
    expect(without.rows.some((r) => r.runId === had[10].runId)).toBe(false);
    // Nothing left: no rows.
    expect(withFirstPage(had, [])).toEqual({ rows: [], kept: 0 });
  });

  it('says why the table may still change while its filter or sort is worked out', () => {
    expect(warmingLine({ done: 120, total: 9000 }, { filtered: true, bySpent: false })).toMatch(/^The about lines of 120 of 9,000 runs are known so far/);
    expect(warmingLine({ done: 120, total: 9000 }, { filtered: false, bySpent: true })).toMatch(/^What 120 of 9,000 runs spent is added up so far/);
    expect(warmingLine(null, { filtered: true, bySpent: false })).toBeNull();
  });
});

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  vi.unstubAllGlobals();
});

describe('the Runs page', () => {
  it('reads only its first page again when runs move, and draws a window of the rows it holds', async () => {
    const location = { hash: '#/runs', search: '', pathname: '/' };
    vi.stubGlobal('location', location);
    // The words typed go in the address once they settle, in place of the step they were typed in.
    vi.stubGlobal('history', { state: null, replaceState: (_s: unknown, _t: string, url: string) => void (location.hash = url.slice(url.indexOf('#'))) });
    const all = Array.from({ length: 300 }, (_, i) => row(i));
    const asked: Array<{ cursor: string | null; limit: number }> = [];
    const filters: string[] = [];
    const client = {
      exported: false,
      runsPage: (q: RunsQuery) => {
        // A filter's rows take their time.
        if (q.q) {
          filters.push(q.q);
          return new Promise(() => undefined);
        }
        asked.push({ cursor: q.cursor ?? null, limit: q.limit ?? 50 });
        const from = q.cursor ? Number(q.cursor) : 0;
        const limit = q.limit ?? 50;
        return Promise.resolve({ runs: all.slice(from, from + limit), total: all.length, next: from + limit < all.length ? String(from + limit) : null, chipCounts: { all: all.length, recording: all.length, fork: 0, clean: 0, test: 0, capture: 0, failed: 0, local: 0 } });
      },
      runsByDay: () => new Promise(() => undefined),
      teamStore: () => Promise.resolve(null),
      knownRuns: (ids: string[]) => Promise.resolve(ids),
    } as unknown as Client;
    const app = (tick: number) => ({ client, exported: false, meta: null, tick, runsTick: tick, feeds: {}, actionsOff: null, hasKind: () => false, guard: (fn: () => void) => fn(), watchJob: () => undefined, toast: () => undefined, refresh: () => undefined }) as unknown as AppState;
    // The shell's tick, moved as runs move.
    let move: (tick: number) => void = () => undefined;
    function Host() {
      const [tick, setTick] = useState(0);
      move = setTick;
      return createElement(AppContext.Provider, { value: app(tick) }, createElement(RunsPage));
    }
    r = await render(createElement(Host));
    await r.until('the first page', () => r!.all('table.runst tbody tr[data-wi]').length > 0);
    expect(asked).toEqual([{ cursor: null, limit: 50 }]);
    // Show more: the page after the last each time, nothing read again.
    const more = async (to: number) => {
      await r!.click(r!.one('button.attn-more'));
      await r!.until(`${to} rows`, () => r!.one('button.attn-more').textContent.includes(`Showing ${to} of 300`));
    };
    for (const to of [100, 150, 200]) await more(to);
    expect(asked.map((a) => a.cursor)).toEqual([null, '50', '100', '150']);
    expect(asked.every((a) => a.limit === 50)).toBe(true);
    // Up to 200 rows, every one drawn.
    expect(WHOLE_UP_TO).toBe(200);
    expect(r.all('table.runst tbody tr[data-wi]')).toHaveLength(200);
    expect(r.all('table.runst tbody tr.wspace')).toHaveLength(0);
    // Past that, those drawn are a window of them, the rest stood for by a spacer.
    await more(250);
    expect(r.all('table.runst tbody tr[data-wi]').length).toBeLessThanOrEqual(60);
    expect(r.all('table.runst tbody tr.wspace')).toHaveLength(1);
    expect(r.one('table.runst').getAttribute('aria-rowcount')).toBe('251');

    // Runs moved: the first page alone is read again, and the 250 rows stay.
    asked.length = 0;
    move(1);
    await r.until('the first page again', () => asked.length > 0);
    await r.wait(50);
    expect(asked).toEqual([{ cursor: null, limit: 50 }]);
    expect(r.one('table.runst').getAttribute('aria-rowcount')).toBe('251');
    expect(r.one('button.attn-more').textContent).toContain('Showing 250 of 300');

    // Another filter: the rows held stay in view until its own come.
    await r.type(r.one('input[type="search"]'), 'slow');
    await r.until('the filter asked for', () => filters.includes('slow'));
    await r.wait(50);
    expect(r.one('table.runst').getAttribute('aria-rowcount')).toBe('251');
    expect(r.all('section.panel .empty')).toHaveLength(0);
  });
});
