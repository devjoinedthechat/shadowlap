import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorColour } from '../ui/runspage/authors.js';
import { barHeights, barOf, barSpans, barTop, dragEnd, dragOver, dragStart, firstGivesWay, keyPick, monthMarks, moveDay, rowSteps } from '../ui/runspage/calendar-model.js';
import { fitMonths, TwelveWeeks } from '../ui/runspage/DaysRow.js';
import type { RunChip } from '../ui/runs.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { DayCount, RunsByDay } from '../ui/types.js';
import { styleRules } from './css-sheet.js';
import { render, type Rendered } from './ui-render.js';

/**
 * The twelve weeks over Runs as the design draws them by default: one slim row of days, a bar each
 * (a week each on a phone or a touch screen), heights on a square-root scale with the failures red
 * at their foot, the months under them, one sentence with Clear, Find breaking commit and Calendar,
 * which opens the grid until Hide calendar. The keys move a bar at a time and pick as the grid's do.
 */

const day = (key: string, i: number, over: Partial<DayCount> = {}): DayCount => ({ day: key, start: i * 1000, end: (i + 1) * 1000, weekday: i % 7, runs: 0, failed: 0, all: 0, level: 0, byKind: {}, byAuthor: {}, ...over });

/** Twelve weeks from Monday Jul 27 2026 to Thursday Oct 15 2026: 81 days; runs on the last two weeks' days. */
const DAYS: DayCount[] = Array.from({ length: 81 }, (_, i) => {
  const key = new Date(Date.UTC(2026, 6, 27 + i)).toISOString().slice(0, 10);
  if (i === 80) return day(key, i, { runs: 5, failed: 1, all: 5, byKind: { recording: 4, fork: 1 }, byAuthor: { 'maya@x': 3, ci: 2 } });
  if (i === 74) return day(key, i, { runs: 7, failed: 2, all: 7, byKind: { recording: 7 }, byAuthor: { 'maya@x': 7 } });
  return day(key, i);
});
const DATA: RunsByDay = { tz: 'UTC', weeks: 12, today: '2026-10-15', from: 0, to: 81_000, days: DAYS, thresholds: [5, 5, 7], totals: { runs: 12, failed: 3, all: 12, busiest: { day: '2026-10-09', runs: 7 } } };

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  vi.unstubAllGlobals();
});

/** A phone or a touch screen, as `matchMedia` answers. */
function touchScreen() {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('pointer: coarse'), addEventListener: () => undefined, removeEventListener: () => undefined }));
}

async function weeks(o: { chip?: RunChip; range?: [number, number] | null; data?: RunsByDay | null; error?: boolean; onPick?: (range: [number, number] | null) => void; onFindCommit?: ((range: [number, number]) => void) | null; byPerson?: boolean; actionsOff?: string | null; toast?: AppState['toast'] } = {}) {
  const load = { data: o.data === undefined ? DATA : o.data, error: o.error ? new Error('no') : null, loading: false, reload: () => undefined };
  const app = { actionsOff: o.actionsOff ?? null, conn: 'ok', exported: false, toast: o.toast ?? (() => undefined) } as unknown as AppState;
  const days = createElement(TwelveWeeks, { load, chip: o.chip ?? 'all', range: o.range ?? null, onPick: o.onPick ?? (() => undefined), byPerson: o.byPerson ?? false, onFindCommit: o.onFindCommit === undefined ? () => undefined : o.onFindCommit });
  r = await render(createElement(AppContext.Provider, { value: app }, days));
  return r;
}

describe('the slim row of days', () => {
  it('holds a bar a day, or a week a bar, the last ending today', () => {
    expect(barSpans(DAYS, 1)).toHaveLength(81);
    const weeks = barSpans(DAYS, 7);
    expect(weeks).toHaveLength(12);
    expect(weeks[0]).toEqual([0, 6]);
    expect(weeks[11]).toEqual([77, 80]);
  });

  it('draws a bar’s runs on a square-root scale of the largest, its failures at its foot', () => {
    expect(barHeights(4, 1, 16)).toEqual({ hn: 37.5, hf: 12.5 });
    expect(barHeights(16, 16, 16)).toEqual({ hn: 0, hf: 100 });
    expect(barHeights(0, 0, 16)).toEqual({ hn: 0, hf: 0 });
    expect(barTop(DAYS, barSpans(DAYS, 1))).toBe(7);
    expect(barTop(DAYS, barSpans(DAYS, 7))).toBe(7);
    expect(barTop([], [])).toBe(1);
  });

  it('names the first bar by the month its first day is in, and each other bar that holds a month’s first day, as the design does', () => {
    const at = (bars: number, i: number) => (i / bars) * 100;
    expect(monthMarks(DAYS, barSpans(DAYS, 1))).toEqual([
      { at: 0, label: 'Jul' },
      { at: at(81, 5), label: 'Aug' },
      { at: at(81, 36), label: 'Sep' },
      { at: at(81, 66), label: 'Oct' },
    ]);
    // A week holding Aug 1 that starts in July is July's, as the design's first bar is.
    expect(monthMarks(DAYS, barSpans(DAYS, 7))).toEqual([
      { at: 0, label: 'Jul' },
      { at: at(12, 5), label: 'Sep' },
      { at: at(12, 9), label: 'Oct' },
    ]);
    const fromAug1 = Array.from({ length: 84 }, (_, i) => day(new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10), i));
    expect(monthMarks(fromAug1, barSpans(fromAug1, 1)).map((m) => m.label)).toEqual(['Aug', 'Sep', 'Oct']);
  });

  it('drops the first bar’s month only where the next name runs into it as the row is laid out', () => {
    expect(firstGivesWay({ right: 30, width: 20 }, { left: 31 })).toBe(true);
    expect(firstGivesWay({ right: 30, width: 20 }, { left: 40 })).toBe(false);
    expect(firstGivesWay({ right: 0, width: 0 }, { left: 0 })).toBe(false);
    const span = (left: number, width: number) => ({ hidden: true, getBoundingClientRect: () => ({ left, right: left + width, width }) });
    const crowded = [span(0, 20), span(18, 20)];
    fitMonths({ children: crowded } as never);
    expect(crowded.map((m) => m.hidden)).toEqual([true, true]);
    const roomy = [span(0, 20), span(50, 20)];
    fitMonths({ children: roomy } as never);
    expect(roomy[0].hidden).toBe(false);
    const alone = [span(0, 20)];
    fitMonths({ children: alone } as never);
    expect(alone[0].hidden).toBe(false);
  });

  it('names a bar by its day or its week, its runs and its failures, and gives it the grid’s hover card', () => {
    const o = { today: 80, noun: 'runs', byPerson: false, failedChip: false, top: 7 };
    const last = barOf(DAYS, [80, 80], o);
    expect(last.label).toBe('Thu, Oct 15 (today): 5 runs, 1 failed');
    expect(last.tip.title).toBe('Thu, Oct 15 (today) · 5 runs');
    expect(last.tip.rows).toEqual([
      { label: 'recordings', value: '4', color: 'var(--line2)' },
      { label: 'forks', value: '1', color: 'var(--line2)' },
      { label: 'failed', value: '1', color: 'var(--err)' },
    ]);
    expect(barOf(DAYS, [0, 0], o).label).toBe('Mon, Jul 27: 0 runs');
    expect(barOf(DAYS, [0, 0], o).tip.title).toBe('Mon, Jul 27 · no runs');
    const week = barOf(DAYS, [70, 76], { ...o, top: 12 });
    expect(week.label).toBe('Oct 5 to Oct 11: 7 runs, 2 failed');
    expect(week.tip.title).toBe('Oct 5 to Oct 11 · 7 runs');
    // Under Failed a bar counts the failures, all red, and says no failures beside them.
    const failed = barOf(DAYS.map((d) => ({ ...d, runs: d.failed })), [80, 80], { ...o, noun: 'failed runs', failedChip: true, top: 2 });
    expect(failed.label).toBe('Thu, Oct 15 (today): 1 failed run');
    expect(failed.heights.hn).toBe(0);
    expect(failed.heights.hf).toBeGreaterThan(0);
    // With a store, by person in their avatar's tint: CI and the unknown faint, nobody lime.
    expect(barOf(DAYS, [80, 80], { ...o, byPerson: true }).tip.rows.slice(0, 2)).toEqual([
      { label: 'maya', value: '3', color: 'var(--av1)' },
      { label: 'ci', value: '2', color: 'var(--faint)' },
    ]);
    expect([authorColour(null), authorColour('ci'), authorColour('')]).toEqual(['var(--faint)', 'var(--faint)', 'var(--faint)']);
  });

  it('moves a bar at a time with ← and →, leaves ↑ and ↓ to the page, and picks a week’s seven days', () => {
    expect(moveDay(70, 'ArrowRight', 81, rowSteps(7))).toBe(77);
    expect(moveDay(77, 'ArrowRight', 81, rowSteps(7))).toBeNull();
    expect(moveDay(7, 'ArrowLeft', 81, rowSteps(7))).toBe(0);
    expect(moveDay(10, 'ArrowLeft', 81, rowSteps(1))).toBe(9);
    expect(moveDay(10, 'ArrowUp', 81, rowSteps(1))).toBeNull();
    // A week's bar picks from its first day to its last; a drag spans the bars it crossed, either way.
    expect(dragEnd(dragStart(7, null, false, 13))).toEqual([7, 13]);
    expect(dragEnd(dragOver(dragStart(14, null, false, 20), 0, 6))).toEqual([0, 20]);
    expect(dragEnd(dragOver(dragStart(0, null, false, 6), 14, 20))).toEqual([0, 20]);
    expect(dragEnd(dragStart(7, [7, 13], false, 13))).toBeNull();
    expect(dragEnd(dragStart(21, [7, 13], true, 27))).toEqual([7, 27]);
    expect(keyPick(7, [7, 13], false, 13)).toBeNull();
    expect(keyPick(21, [7, 13], true, 27)).toEqual([7, 27]);
    expect(keyPick(21, null, false, 27)).toEqual([21, 27]);
  });
});

describe('the twelve weeks over Runs', () => {
  it('draws the row of days by default: a bar a day, pressed when picked, the last day the one Tab reaches', async () => {
    const t = await weeks();
    expect(t.one('section.cal.hist').getAttribute('aria-label')).toBe('Runs per day, last 12 weeks');
    expect(t.one('.hbars').getAttribute('aria-label')).toBe('Days, oldest first: click a day or drag across several to filter the table');
    const bars = t.all('.hbars button.cd.hb');
    expect(bars).toHaveLength(81);
    expect(bars.filter((b) => b.getAttribute('tabindex') === '0').map((b) => b.getAttribute('data-day'))).toEqual(['80']);
    expect(bars[80].getAttribute('aria-label')).toBe('Thu, Oct 15 (today): 5 runs, 1 failed');
    expect(bars[80].getAttribute('aria-pressed')).toBe('false');
    expect(bars[80].getAttribute('data-to')).toBeNull();
    // The busiest bar is the full height; a bar with none of its runs failed has no red, a day with no runs nothing.
    expect(bars[74].querySelectorAll('i').map((i) => [i.className, (i.props.style as { height: string }).height])).toEqual([
      ['hn', '71.4%'],
      ['hf', '28.6%'],
    ]);
    expect(bars[0].querySelectorAll('i')).toHaveLength(0);
    expect(t.all('.hmon span').map((s) => s.textContent)).toEqual(['Jul', 'Aug', 'Sep', 'Oct']);
    expect((t.all('.hmon span')[3].props.style as { left: string }).left).toBe(`min(${((66 / 81) * 100).toFixed(2)}%, calc(100% - 2em))`);
  });

  it('says in one sentence what it counts, the failures beside, each count kept to its word', async () => {
    let t = await weeks();
    expect(t.one('.hsum').textContent).toBe('12 runs in 12 weeks, on this machine, 3 failed.');
    expect(t.all('.hsum .nw').map((n) => n.textContent)).toEqual(['12 runs', '3 failed']);
    expect(t.all('.hact button').map((b) => b.textContent)).toEqual(['Calendar']);
    await t.unmount();
    t = r = await weeks({ byPerson: true, range: [80, 80] });
    expect(t.one('.hsum').textContent).toBe('5 runs on Thu, Oct 15, 1 failed.');
    expect(t.all('.hbars button[aria-pressed="true"]').map((b) => b.getAttribute('data-day'))).toEqual(['80']);
    expect(t.all('.hact button').map((b) => b.textContent)).toEqual(['Clear', 'Calendar']);
    await t.unmount();
    t = r = await weeks({ chip: 'failed', data: { ...DATA, days: DAYS.map((d) => ({ ...d, runs: d.failed })) } });
    expect(t.one('section.cal.hist').getAttribute('aria-label')).toBe('Failed runs per day, last 12 weeks');
    expect(t.one('.hsum').textContent).toBe('3 failed runs in 12 weeks, on this machine.');
  });

  it('offers Find breaking commit for failed days picked under Failed, its card saying where it starts', async () => {
    const asked: Array<[number, number]> = [];
    const t = await weeks({ chip: 'failed', range: [74, 80], data: { ...DATA, days: DAYS.map((d) => ({ ...d, runs: d.failed })) }, onFindCommit: (x) => asked.push(x) });
    const find = t.byText('.hact button', 'Find breaking commit…');
    expect(JSON.parse(find.getAttribute('data-tip')!)).toEqual({ t: 'Find breaking commit', s: 'From the first failure from Oct 9 to Oct 15, between a commit where it worked and its own', rows: [] });
    await t.click(find);
    expect(asked).toEqual([[74, 80]]);
  });

  it('holds Find breaking commit on a dashboard that changes nothing, in the row and the grid, its card saying why', async () => {
    const asked: Array<[number, number]> = [];
    const toast = vi.fn();
    const t = await weeks({ chip: 'failed', range: [74, 80], data: { ...DATA, days: DAYS.map((d) => ({ ...d, runs: d.failed })) }, onFindCommit: (x) => asked.push(x), actionsOff: 'This dashboard is read-only', toast });
    const held = (find: ReturnType<Rendered['one']>) => {
      expect(find.getAttribute('aria-disabled')).toBe('true');
      expect(find.getAttribute('data-why')).toBe('This dashboard is read-only');
      expect(JSON.parse(find.getAttribute('data-tip')!)).toEqual({ t: 'Find breaking commit', s: 'This dashboard is read-only', rows: [] });
    };
    held(t.byText('.hact button', 'Find breaking commit…'));
    await t.click(t.byText('.hact button', 'Find breaking commit…'));
    expect(toast).toHaveBeenCalledWith('This dashboard is read-only', 'notice', undefined);
    await t.click(t.byText('.hact button', 'Calendar'));
    held(t.byText('.calside button', 'Find breaking commit…'));
    await t.click(t.byText('.calside button', 'Find breaking commit…'));
    expect(asked).toEqual([]);
    await t.click(t.byText('.calside > button', 'Hide calendar'));
  });

  it('opens the grid on Calendar and comes back on Hide calendar, the button that takes its place in focus', async () => {
    const t = await weeks();
    const open = t.byText('.hact button', 'Calendar');
    expect(open.getAttribute('aria-expanded')).toBe('false');
    await t.click(open);
    expect(t.all('section.cal.hist')).toHaveLength(0);
    expect(t.one('section.cal .calgrid').getAttribute('aria-label')).toBe('Days, a column per week');
    const hide = t.byText('.calside > button', 'Hide calendar');
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    expect(t.focused()).toBe(hide);
    await t.click(hide);
    expect(t.all('section.cal.hist')).toHaveLength(1);
    expect(t.focused()).toBe(t.byText('.hact button', 'Calendar'));
  });

  it('keeps the grid picked when Runs opens again, while the dashboard is open', async () => {
    let t = await weeks();
    await t.click(t.byText('.hact button', 'Calendar'));
    await t.unmount();
    t = r = await weeks();
    expect(t.all('section.cal.hist')).toHaveLength(0);
    // Not in focus on opening: only a press of the toggle moves it.
    expect(t.focused().tagName).not.toBe('BUTTON');
    await t.click(t.byText('.calside > button', 'Hide calendar'));
    expect(t.all('section.cal.hist')).toHaveLength(1);
  });

  it('moves along the bars with ← and →, picks with Enter, extends with Shift+Enter and clears with Esc', async () => {
    const picked: Array<[number, number] | null> = [];
    let t = await weeks({ onPick: (x) => picked.push(x) });
    const bars = t.all('.hbars button.cd.hb');
    await t.focus(bars[80]);
    await t.press('ArrowLeft');
    expect(t.focused()).toBe(bars[79]);
    const up = await t.press('ArrowUp');
    expect(up.defaultPrevented).toBe(false);
    await t.press('Enter');
    expect(picked).toEqual([[79, 79]]);
    await t.unmount();
    t = r = await weeks({ onPick: (x) => picked.push(x), range: [74, 74] });
    await t.focus(t.all('.hbars button.cd.hb')[80]);
    await t.press('Enter', { shiftKey: true });
    await t.press('Escape');
    expect(picked.slice(1)).toEqual([[74, 80], null]);
  });

  it('on a touch screen draws a bar a week, which picks its seven days', async () => {
    touchScreen();
    const picked: Array<[number, number] | null> = [];
    const t = await weeks({ onPick: (x) => picked.push(x) });
    expect(t.one('section.cal.hist').getAttribute('aria-label')).toBe('Runs per week, last 12 weeks');
    expect(t.one('.hbars').getAttribute('aria-label')).toBe('Weeks, oldest first: tap a week or drag across several to filter the table');
    const bars = t.all('.hbars button.cd.hb');
    expect(bars).toHaveLength(12);
    expect([bars[11].getAttribute('data-day'), bars[11].getAttribute('data-to'), bars[11].getAttribute('tabindex')]).toEqual(['77', '80', '0']);
    expect(bars[11].getAttribute('aria-label')).toBe('Oct 12 to Oct 15: 5 runs, 1 failed');
    await t.focus(bars[11]);
    await t.press('ArrowLeft');
    expect(t.focused()).toBe(bars[10]);
    await t.press(' ');
    expect(picked).toEqual([[70, 76]]);
  });

  it('keeps its space while it loads, and leaves it to the table if it can’t be read', async () => {
    let t = await weeks({ data: null });
    const wait = t.one('section.cal.hist.wait');
    expect(wait.getAttribute('aria-hidden')).toBe('true');
    expect(t.one('.hsum').textContent).toBe(' ');
    await t.unmount();
    t = r = await weeks({ data: null, error: true });
    expect(t.all('section.cal')).toHaveLength(0);
    const hidden = styleRules().find((x) => x.selectors.includes('.cal.wait'));
    expect(new Map(hidden?.decls).get('visibility')).toBe('hidden');
  });

  it('gives a day of the grid and a bar of the row the taps across half the gap beside them', () => {
    const rules = styleRules();
    const decl = (s: string, p: string, cond?: RegExp) => new Map(rules.find((x) => x.selectors.includes(s) && (cond ? x.conditions.some((c) => cond.test(c)) : !x.conditions.length))?.decls).get(p);
    expect(decl('.cal button.cd::after', 'inset')).toBe('calc(var(--cg) / -2)');
    expect(decl('.cal button.cd.hb::after', 'inset')).toBe('0 -1px');
    expect(decl('.cal', '--cg', /pointer:\s*coarse/)).toBe('8px');
    expect(decl('.cal', '--cg', /max-width:\s*359px/)).toBe('5px');
  });
});
