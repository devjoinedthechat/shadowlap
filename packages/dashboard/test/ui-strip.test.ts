import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { cutClean } from '../ui/format.js';
import type { Origin7 } from '../ui/origins.js';
import { dimRanges, markRanges, stripCapacity, stripRanges, stripStep, stripTabStop, type StripKey } from '../ui/strip.js';
import type { CallRow } from '../ui/types.js';
import { keyCounts, keyItems, pendingMatches, shownFilter } from '../ui/run/call-filter.js';
import { callKind, KIND_RANK, kindLabel, kindValue, ownKind, parseKinds, type Kind } from '../ui/run/kinds.js';
import { RunStrip, type RunStripCall } from '../ui/run/RunStrip.js';

/**
 * The run page's strip: by kind on a recording, by origin elsewhere; ranges by the room it has, each
 * in the colour of most of its calls with a notch for the rarer one; one Tab stop, a listbox whose
 * arrows select; and the key that is the call filter.
 */

const row = (n: number, o: Partial<CallRow> = {}): CallRow => ({ callNo: n, kind: 'tool', name: 'lookup_order', origin: 'live', effect: 'read', outcome: 'ok', status: null, latencyMs: 120, usage: null, error: null, model: null, ...o }) as unknown as CallRow;
const own = (c: CallRow, origin: Origin7 = 'live'): RunStripCall => ({ n: c.callNo, origin, kind: callKind(c), call: c });
const recording = (n: number, at: (i: number) => Partial<CallRow> = () => ({})): RunStripCall[] => Array.from({ length: n }, (_, i) => own(row(i + 1, at(i + 1))));
const strip = (calls: RunStripCall[], o: Partial<Parameters<typeof RunStrip>[0]> = {}) => renderToStaticMarkup(createElement(RunStrip, { calls, byKind: true, selected: null, forkAt: null, lostAt: null, inScope: null, pick: null, live: false, onSelect: () => undefined, ...o }));
const stops = (html: string) => [...html.matchAll(/<button[^>]*tabindex="(-?\d)"/g)].map((m) => m[1]);
const labels = (html: string) => [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
const BY_KIND: StripKey<RunStripCall> = { of: (c) => c.kind ?? 'none', rank: KIND_RANK };

describe('a call’s kind', () => {
  it('is a model call, a read, a write or an error, and a fenced call is named by what it would have done', () => {
    expect(callKind(row(1, { kind: 'api' }))).toBe('k-model');
    expect(callKind(row(2))).toBe('k-read');
    expect(callKind(row(3, { effect: 'write' }))).toBe('k-write');
    expect(callKind(row(4, { effect: 'write', outcome: 'error', error: 'refund failed' }))).toBe('k-err');
    expect(callKind(row(5, { kind: 'api', outcome: 'error', status: 529 }))).toBe('k-err');
    // Blocked by the fence: a write, never an error.
    const blocked = row(6, { effect: 'write', origin: 'blocked', outcome: 'error', error: 'blocked by Shadowlap' });
    expect(callKind(blocked)).toBe('k-write');
    expect(ownKind(blocked)).toBe('write');
    expect(kindLabel(row(7, { input: true }))).toBe('read · input');
    expect(kindLabel(row(8, { kind: 'clock', effect: null }))).toBe('read · clock');
    expect(kindLabel(row(9, { kind: 'random', effect: null }))).toBe('read · random value');
    expect(kindLabel(row(10, { effect: 'pure' }))).toBe('read · pure');
    expect(kindLabel(row(11, { effect: null }))).toBe('read');
  });

  it('says an HTTP error’s status, an error cut after a whole word, a model call’s tokens, else its time', () => {
    expect(kindValue(row(1, { kind: 'api', outcome: 'error', status: 529 }))).toBe('HTTP 529');
    expect(kindValue(row(2, { outcome: 'error', error: 'the refund service answered with an unexpected  status for order 1182' }))).toBe('the refund service answered with an…');
    expect(cutClean('Order not found. Try again', 40)).toBe('Order not found');
    expect(kindValue(row(3, { kind: 'api', usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0 } }))).toBe('1.2k → 300');
    expect(kindValue(row(4, { latencyMs: 42 }))).toBe('42 ms');
  });

  it('reads a run’s kinds string, and refuses anything else', () => {
    expect(parseKinds('mrwe')).toEqual(['k-model', 'k-read', 'k-write', 'k-err']);
    expect(parseKinds('mx')).toBeNull();
    expect(parseKinds(undefined)).toBeNull();
  });
});

describe('ranges by the room the strip has', () => {
  it('fits a call a cell while each keeps 6px (24px to a finger) with 3px between, else groups to what fits 1px apart', () => {
    expect(stripCapacity(100, 600, false, false)).toBe(85);
    expect(stripCapacity(100, 358, true, false)).toBe(14);
    expect(stripCapacity(60, 600, false, false)).toBeNull();
    expect(stripCapacity(5000, 10, false, false)).toBe(4);
    expect(stripCapacity(100, 600, false, true)).toBe(84);
  });

  it('draws calls that don’t fit 3px apart but need no ranges a call each, 1px apart, named as their calls', () => {
    const html = strip(recording(80));
    expect(html).toContain('class="cells binned"');
    expect(stops(html)).toHaveLength(80);
    expect(labels(html)).toContain('#80 lookup_order · read · live');
    expect(html).not.toContain('class="tk');
  });

  it('draws a range in the colour of most of its calls and notches its rarer notable call', () => {
    // 1,200 calls of a recording: model calls and reads, 13 errors among them.
    const calls = recording(1200, (n) => (n % 90 === 45 ? { kind: 'api', outcome: 'error', status: 529 } : n % 2 ? { kind: 'api' } : {}));
    const ranges = stripRanges(calls, stripCapacity(1200, 600, false, false), BY_KIND);
    expect(ranges.length).toBeLessThanOrEqual(85);
    expect(ranges.every((r) => r.cls === 'k-model' || r.cls === 'k-read')).toBe(true);
    expect(ranges.filter((r) => r.tick === 'k-err')).toHaveLength(13);
    const at = ranges.find((r) => r.tick)!;
    expect(at.tickAt).toBeGreaterThanOrEqual(0);
    expect(at.tickAt).toBeLessThanOrEqual(1);
    // A fork's blocked writes notch its live ranges, by origin.
    const fork: RunStripCall[] = Array.from({ length: 400 }, (_, i) => own(row(i + 1, i === 200 ? { effect: 'write', origin: 'blocked' } : {}), i === 200 ? 'block' : 'live'));
    const byOrigin = stripRanges(fork, 85);
    expect(byOrigin.find((r) => r.first <= 201 && r.last >= 201)).toMatchObject({ cls: 'live', tick: 'block', origin: 'block', notable: 201 });
  });

  it('draws at most its room at 100,000 calls, one Tab stop, and marks a selection without grouping again', () => {
    const calls = recording(100_000);
    const html = strip(calls, { selected: 50_000 });
    const tabs = stops(html);
    expect(tabs.length).toBeLessThanOrEqual(85);
    expect(tabs.filter((t) => t === '0')).toHaveLength(1);
    const ranges = stripRanges(calls, 85, BY_KIND);
    const dims = dimRanges(ranges, null);
    const a = markRanges(ranges, dims, { selected: 1, forkAt: null, lostAt: null });
    const b = markRanges(ranges, dims, { selected: 99_999, forkAt: null, lostAt: null });
    expect(a.findIndex((c) => c.selected)).toBe(0);
    expect(b.findIndex((c) => c.selected)).toBe(ranges.length - 1);
    expect(b.at(-1)!.target).toBe(99_999);
  });
});

describe('each cell’s name and card', () => {
  it('names a call by its kind and origin, the fork point and the lost call, and a call not read yet', () => {
    const calls = [own(row(1, { kind: 'api', name: 'messages' })), own(row(2, { name: 'issue_refund', effect: 'write' })), own(row(3, { name: 'send_email', effect: 'write', origin: 'blocked', outcome: 'error' }), 'block'), { n: 4, origin: 'live' as const, kind: 'k-read' as Kind, call: null }];
    const names = labels(strip(calls, { byKind: false, forkAt: 1, lostAt: 2 }));
    expect(names).toEqual(['Calls, by origin', '#1 messages · model call · live · fork point', '#2 issue_refund · write · live · lost here', '#3 send_email · write · blocked', '#4 · read · live · not read yet']);
  });

  it('names a range by its kinds or origins and counts them, past 999 with a separator', () => {
    const byKind = labels(strip(recording(2100, (n) => (n === 1300 ? { effect: 'write' } : n % 2 ? { kind: 'api' } : {}))));
    expect(byKind[0]).toBe('Calls, by kind');
    expect(byKind).toContain('Calls #1,276 to #1,300: 12 model calls, 12 reads, 1 write');
    const fork: RunStripCall[] = Array.from({ length: 400 }, (_, i) => own(row(i + 1), i < 300 ? 'rep' : 'live'));
    expect(labels(strip(fork, { byKind: false }))).toContain('Calls #1 to #5: 5 replayed');
  });
});

describe('one Tab stop, a listbox whose arrows select', () => {
  it('is a horizontal listbox with one stop on the selected call', () => {
    const html = strip(recording(30), { selected: 7 });
    expect(html).toContain('role="listbox"');
    expect(html).toContain('aria-orientation="horizontal"');
    expect(stops(html).indexOf('0')).toBe(6);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(stripTabStop([{ selected: false }, { selected: false }])).toBe(0);
  });

  it('selects the next call, or the next range’s call where grouped, and the ends with Home and End', () => {
    const cells = markRanges(stripRanges(recording(30), null), [], { selected: 7, forkAt: null, lostAt: null });
    expect(stripStep(cells, 7, 'ArrowRight', false)).toBe(8);
    expect(stripStep(cells, 7, 'ArrowLeft', false)).toBe(6);
    expect(stripStep(cells, 7, 'Home', false)).toBe(1);
    expect(stripStep(cells, 7, 'End', false)).toBe(30);
    expect(stripStep(cells, 30, 'ArrowRight', false)).toBeNull();
    expect(stripStep(cells, 7, 'ArrowDown', false)).toBeNull();
    const ranges = stripRanges(recording(400, (n) => (n === 8 ? { effect: 'write' } : {})), 85, BY_KIND);
    const grouped = markRanges(ranges, [], { selected: 3, forkAt: null, lostAt: null });
    // From the first range to the second, on its most notable call, its write.
    expect(stripStep(grouped, 3, 'ArrowRight', true)).toBe(8);
    expect(stripStep(grouped, 3, 'ArrowLeft', true)).toBeNull();
  });
});

describe('the key, which is the call filter', () => {
  it('counts each kind on a recording and each origin elsewhere, all first, only what the run has', () => {
    const calls = [row(1, { kind: 'api' }), row(2), row(3), row(4, { effect: 'write' })];
    expect(keyItems(keyCounts(calls, null, true), true).map((i) => `${i.word} ${i.count}`)).toEqual(['all 4', 'model call 1', 'reads 2', 'write 1']);
    const fork = [row(1, { origin: 'replayed' }), row(2, { origin: 'replayed' }), row(3), row(4, { origin: 'stubbed', effect: 'write' })];
    expect(keyItems(keyCounts(fork, null, false), false).map((i) => `${i.word} ${i.count}`)).toEqual(['all 4', 'replayed 2', 'live 1', 'stubbed 1']);
  });

  it('counts a long run from its strings in one pass, and keeps a pick only where the run has such calls', () => {
    const codes = parseKinds('m'.repeat(60_000) + 'r'.repeat(39_999) + 'w')!;
    const counts = keyCounts([], codes, true);
    expect(counts).toEqual({ total: 100_000, counts: { 'k-model': 60_000, 'k-read': 39_999, 'k-write': 1 } });
    expect(shownFilter('k-write', counts.counts, true)).toBe('k-write');
    expect(shownFilter('k-err', counts.counts, true)).toBe('all');
    expect(shownFilter('block', counts.counts, true)).toBe('all');
    expect(pendingMatches({ callNo: 9, pending: true, origin: 'live', kindKey: 'k-write' }, 'k-write', '')).toBe(true);
    expect(pendingMatches({ callNo: 9, pending: true, origin: 'live', kindKey: 'k-write' }, 'k-write', 'refund')).toBe(false);
  });

  it('dims the cells a pick leaves out, as the scope does', () => {
    const ranges = stripRanges(recording(6, (n) => (n === 2 ? { effect: 'write' } : {})), null, BY_KIND);
    expect(dimRanges(ranges, null, 'k-write')).toEqual([true, false, true, true, true, true]);
    expect(dimRanges(ranges, (n) => n > 4)).toEqual([true, true, true, true, false, false]);
  });
});
