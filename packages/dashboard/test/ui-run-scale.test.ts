import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppContext, type AppState } from '../ui/state.js';
import { describe, expect, it } from 'vitest';
import type { CallRow, RunDetail } from '../ui/types.js';
import { CallsTable } from '../ui/run/CallsView.js';
import { contextBars, ContextView, MAX_BARS } from '../ui/run/ContextView.js';
import { RunLoading } from '../ui/run/parts.js';
import { TimelineView } from '../ui/run/TimelineView.js';
import { turnLines, TurnsView } from '../ui/run/TurnsView.js';
import { FIRST_ROWS, rowAt, rowOffsets, scrollFor, windowRange } from '../ui/run/windowed.js';

/**
 * A long run's page draws the rows in view, not every call: at 50,000 calls the page held 727,722
 * elements, opened after 9 s with a 3.3 s task, took 0.3 s for each j and 1.3 to 4.9 s for each
 * view switch, and showed an empty box while it loaded.
 */

/** A run of model calls each followed by the tool call it asked for. */
function calls(n: number): CallRow[] {
  return Array.from({ length: n }, (_, i) => {
    const callNo = i + 1;
    const api = callNo % 2 === 1;
    return {
      callNo,
      kind: api ? 'api' : 'tool',
      name: api ? 'POST /v1/messages' : 'read_file',
      origin: 'live',
      effect: api ? null : 'read',
      outcome: 'ok',
      status: api ? 200 : null,
      latencyMs: 900,
      model: api ? 'claude-opus-5' : null,
      stopReason: api ? 'tool_use' : null,
      usage: api ? { input: 800, output: 40, cacheRead: 4000 + callNo, cacheWrite: 0 } : null,
      cost: null,
      bytes: null,
      detail: api ? '' : `{"path":"notes/${callNo}.md"}`,
      attempts: 0,
      replayedFrom: null,
      error: null,
      startedAt: 1_760_000_000_000 + callNo * 1000,
      endedAt: 1_760_000_000_000 + callNo * 1000 + 900,
      ttftMs: null,
      scope: null,
      resultShort: api ? null : `note ${callNo}`,
      conversation: 1,
      conversationStart: callNo === 1,
      requestedBy: api ? null : callNo - 1,
      toolUseId: null,
      cacheMiss: null,
      recordedMs: null,
      asks: api ? ['read_file'] : null,
    } as unknown as CallRow;
  });
}

const LONG = calls(50_000);
const noop = () => undefined;
const count = (html: string, re: RegExp) => html.match(re)?.length ?? 0;

describe('a long list drawn a window at a time', () => {
  it('places rows by their heights and finds the rows in view', () => {
    const at = rowOffsets(5, (i) => (i === 2 ? 50 : 30));
    expect([...at]).toEqual([0, 30, 60, 110, 140, 170]);
    expect(rowAt(at, 0)).toBe(0);
    expect(rowAt(at, 59)).toBe(1);
    expect(rowAt(at, 60)).toBe(2);
    expect(rowAt(at, 500)).toBe(5);
    expect(windowRange(at, 60, 40, 0)).toEqual({ start: 2, end: 3 });
    expect(windowRange(at, 60, 40, 30)).toEqual({ start: 1, end: 4 });
    // 50,000 rows of 33 px, a view of 528 px at row 25,000, a screenful either side.
    const long = rowOffsets(50_000, () => 33);
    const w = windowRange(long, 25_000 * 33, 528, 600);
    expect(w.start).toBeGreaterThan(24_970);
    expect(w.end - w.start).toBeLessThan(60);
  });

  it('scrolls by as little as it takes, under a sticky header, or centres the row', () => {
    expect(scrollFor(1000, 33, 0, 500, 34, false)).toBe(533);
    expect(scrollFor(1000, 33, 980, 500, 34, false)).toBe(966);
    expect(scrollFor(1000, 33, 800, 500, 34, false)).toBeNull();
    expect(scrollFor(1000, 33, 0, 500, 34, true)).toBe(766.5);
  });

  it('draws a screenful of a 50,000-call run’s Calls, with the rest as spacers', () => {
    const html = renderToStaticMarkup(createElement(AppContext.Provider, { value: { actionsOff: null, conn: 'ok', toast: noop } as unknown as AppState }, createElement(CallsTable, { calls: LONG, asked: null, selected: 1, scoped: false, forkAt: null, lostAt: null, ancestors: [], live: false, canFork: true, onSelect: noop, onFork: noop })));
    expect(count(html, /<tr data-wi=/g)).toBe(FIRST_ROWS);
    expect(count(html, /class="wspace"/g)).toBe(1);
    expect(html).toContain('aria-rowcount="50001"');
  });

  it('draws a screenful of its Turns and its Timeline too', () => {
    expect(turnLines(LONG, false)).toHaveLength(25_000);
    const turns = renderToStaticMarkup(createElement(TurnsView, { calls: LONG, selected: 1, scoped: false, onSelect: noop }));
    expect(count(turns, /class="turn( sel)?"/g)).toBe(FIRST_ROWS);
    const timeline = renderToStaticMarkup(createElement(TimelineView, { calls: LONG, selected: 1, scoped: false, onSelect: noop }));
    expect(count(timeline, /class="tl-row( sel)?"/g)).toBe(FIRST_ROWS);
  });

  it('draws the Context chart as at most 360 bars, each range at its largest context and its misses', () => {
    const ms = LONG.filter((c) => c.kind === 'api');
    const bars = contextBars(ms, new Map([[25_001, 4096]]));
    expect(bars.length).toBeLessThanOrEqual(MAX_BARS);
    expect(bars[0].first).toBe(1);
    expect(bars.at(-1)!.last).toBe(49_999);
    expect(bars.reduce((s, b) => s + b.size, 0)).toBe(25_000);
    // The largest context in a range is its last call's here: each reads a little more from the cache.
    expect(bars[0].call.callNo).toBe(bars[0].last);
    const missed = bars.filter((b) => b.miss);
    expect(missed).toHaveLength(1);
    expect(missed[0].miss).toEqual({ tokens: 4096, callNo: 25_001 });
    // A short run keeps a bar per call.
    expect(contextBars(ms.slice(0, 30), new Map())).toHaveLength(30);
    const run = { run: { divergence: null }, cache: { misses: [] } } as unknown as RunDetail;
    const html = renderToStaticMarkup(createElement(ContextView, { run, calls: LONG, selected: 1, onSelect: noop }));
    expect(count(html, /class="cbar( sel)?"/g)).toBeLessThanOrEqual(MAX_BARS);
  });

  it('says the run page is loading while it does', () => {
    const html = renderToStaticMarkup(createElement(RunLoading));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Loading the run…');
  });
});
