import { num } from '../format.js';
import { dayText, personName } from '../overview/model.js';
import type { RunChip } from '../runs.js';
import type { DayCount } from '../types.js';
import { authorColour } from './authors.js';

/**
 * The twelve weeks' logic over Runs, as the slim row of days (a bar a day, a bar a week on a phone)
 * and as the calendar's grid (a column per week): a day or a bar picked by a click, several by a
 * drag or Shift-click, moved between by the arrow keys. The days are the viewer's own (the server
 * works them out in their time zone); a range picked is kept by its days' keys, so a new day
 * starting, or the data coming again, keeps it. No DOM here: the tests import it.
 */

export const CAL_WEEKS = 12;
/** Cells drawn: twelve weeks of seven days; those after today are blank. */
export const CAL_CELLS = CAL_WEEKS * 7;

/** What the chip picked counts, in the calendar's words. */
export const CAL_NOUN: Readonly<Record<RunChip, string>> = { all: 'runs', recording: 'recordings', fork: 'forks', clean: 'clean replays', test: 'tests', capture: 'captures', failed: 'failed runs', local: 'local runs' };

/** One of them: `recording`, `failed run`. */
export const oneOf = (noun: string): string => noun.replace(/s$/, '');

/** `1 failed run`, `14 runs`. */
export const counted = (n: number, noun: string): string => `${num(n)} ${n === 1 ? oneOf(noun) : noun}`;

/** The server's kinds, in the hover card's words: a recording from a pack is a recording. */
const KIND_NOUN: Readonly<Record<string, string>> = { recording: 'recordings', pack: 'recordings', fork: 'forks', clean: 'clean replays', replay: 'replays', test: 'tests', capture: 'captures' };

/** Days picked, by their keys: the first and the last, in order. */
export interface PickedDays {
  from: string;
  to: string;
}

/**
 * The days picked as indices into `days`, kept to the days shown: a range running past them keeps
 * the days inside, and one wholly outside them is none (null, as when no day is picked).
 */
export function pickedRange(days: readonly Pick<DayCount, 'day'>[], picked: PickedDays | null): [number, number] | null {
  const first = days[0]?.day;
  const last = days[days.length - 1]?.day;
  if (!picked || first === undefined || last === undefined) return null;
  // Days' keys (YYYY-MM-DD) sort as the days do.
  const lo = picked.from < picked.to ? picked.from : picked.to;
  const hi = picked.from < picked.to ? picked.to : picked.from;
  if (hi < first || lo > last) return null;
  let a = 0;
  while (days[a]!.day < lo) a++;
  let b = days.length - 1;
  while (days[b]!.day > hi) b--;
  return a <= b ? [a, b] : null;
}

/** The keys of a range of day indices. */
export function pickedOf(days: readonly Pick<DayCount, 'day'>[], range: readonly [number, number] | null): PickedDays | null {
  if (!range) return null;
  const a = days[Math.min(range[0], range[1])];
  const b = days[Math.max(range[0], range[1])];
  return a && b ? { from: a.day, to: b.day } : null;
}

/** The instants the table filters by for a range: the first day's start, and the start of the day after the last. */
export function rangeTimes(days: readonly Pick<DayCount, 'start' | 'end'>[], range: readonly [number, number] | null): { from: number; to: number } | null {
  if (!range) return null;
  const a = days[range[0]];
  const b = days[range[1]];
  return a && b ? { from: a.start, to: b.end } : null;
}

/**
 * A drag over the days: where it started (`a`, and `a2` the last day of the bar it started on, a
 * week's on a phone's row), where it is (`b`, `b2`), whether it moved, and whether it started on
 * the one day or bar already picked.
 */
export interface Drag {
  a: number;
  b: number;
  a2?: number;
  b2?: number;
  moved: boolean;
  again: boolean;
}

/** The days a drag spans: from the first day of the earlier bar to the last day of the later one. */
const dragSpan = (d: Drag): [number, number] => [Math.min(d.a, d.b), Math.max(d.a2 ?? d.a, d.b2 ?? d.b)];

/** A pointer down on a day, or on a bar holding the days to `to`: Shift extends what is picked from its far end; a click on the one day (or bar) picked will clear it. */
export function dragStart(day: number, current: readonly [number, number] | null, shift: boolean, to = day): Drag {
  if (shift && current) return { a: day < current[0] ? current[1] : current[0], b: day, b2: to, moved: true, again: false };
  return { a: day, a2: to, b: day, b2: to, moved: false, again: !!current && current[0] === day && current[1] === to };
}

/** The pointer moved over a day, or a bar holding the days to `to`. */
export function dragOver(drag: Drag, day: number, to = day): Drag {
  return day === drag.b ? drag : { ...drag, b: day, b2: to, moved: true };
}

/** The pointer let go: the range picked, or none when the one day (or bar) picked was clicked again. */
export function dragEnd(drag: Drag): [number, number] | null {
  if (drag.again && !drag.moved) return null;
  return dragSpan(drag);
}

/** The range shown while dragging, else the one picked. */
export function shownRange(drag: Drag | null, picked: readonly [number, number] | null): [number, number] | null {
  if (drag) return dragSpan(drag);
  return picked ? [picked[0], picked[1]] : null;
}

/** The days each arrow key moves in the calendar's grid: a column is a week. */
export const GRID_STEPS: Readonly<Record<string, number>> = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 };

/** In the slim row of days, left and right move a bar (a day, or a week on a phone); up and down are the page's. */
export const rowSteps = (step: number): Readonly<Record<string, number>> => ({ ArrowLeft: -step, ArrowRight: step });

/** The day an arrow key moves to (`steps`, the grid's unless given). Null for another key or past the ends. */
export function moveDay(day: number, key: string, count: number, steps: Readonly<Record<string, number>> = GRID_STEPS): number | null {
  const step = steps[key];
  if (step === undefined) return null;
  const next = day + step;
  return next >= 0 && next < count ? next : null;
}

/** Enter (or Space) on a day, or on a bar holding the days to `to`: picks it, or with Shift extends what is picked to it; on the one day (or bar) picked, clears it. */
export function keyPick(day: number, current: readonly [number, number] | null, shift: boolean, to = day): [number, number] | null {
  if (shift && current) return [Math.min(current[0], day), Math.max(current[1], to)];
  if (current && current[0] === day && current[1] === to) return null;
  return [day, to];
}

/**
 * The month names over the weeks: over the week a month's first day falls in, and over the first
 * week too when it is not crowded by the next label (a name is wider than a week's column).
 */
export function monthLabels(days: readonly Pick<DayCount, 'day'>[]): Array<{ col: number; label: string }> {
  const out: Array<{ col: number; label: string }> = [];
  for (let w = 0; w * 7 < days.length; w++) {
    for (let k = 0; k < 7; k++) {
      const d = days[w * 7 + k];
      if (!d) break;
      if (Number(d.day.slice(8, 10)) === 1) {
        out.push({ col: w + 1, label: dayText(d.day).split(' ')[0]! });
        break;
      }
    }
  }
  const first = days[0];
  if (first && (!out.length || out[0]!.col >= 3)) out.unshift({ col: 1, label: dayText(first.day).split(' ')[0]! });
  return out;
}

/** "on Thu, Oct 1", or "from Sep 22 to Sep 29". */
export function spanText(days: readonly Pick<DayCount, 'day'>[], range: readonly [number, number]): string {
  const a = days[range[0]];
  const b = days[range[1]];
  if (!a || !b) return '';
  return range[0] === range[1] ? `on ${dayText(a.day, true)}` : `from ${dayText(a.day)} to ${dayText(b.day)}`;
}

export interface CalSummary {
  /** What the chips and the filter field match on the days (with Failed picked, the failures). */
  runs: number;
  /** Failures among the runs of the chips' kinds, out of how many: always the Failed chip's number. */
  failed: number;
  all: number;
  busiest: { index: number; runs: number } | null;
  /** Who ran most, most first. */
  people: Array<{ author: string; runs: number }>;
}

/** The side summary: for the days picked, or for all twelve weeks. It follows a drag as it goes. */
export function calSummary(days: readonly DayCount[], range: readonly [number, number] | null): CalSummary {
  const lo = range ? range[0] : 0;
  const hi = range ? range[1] : days.length - 1;
  const out: CalSummary = { runs: 0, failed: 0, all: 0, busiest: null, people: [] };
  const people = new Map<string, number>();
  for (let i = lo; i <= hi; i++) {
    const d = days[i];
    if (!d) continue;
    out.runs += d.runs;
    out.failed += d.failed;
    out.all += d.all;
    if (d.runs && (!out.busiest || d.runs > out.busiest.runs)) out.busiest = { index: i, runs: d.runs };
    for (const [who, n] of Object.entries(d.byAuthor)) people.set(who, (people.get(who) ?? 0) + n);
  }
  out.people = [...people].map(([author, runs]) => ({ author, runs })).sort((a, b) => b.runs - a.runs || (a.author < b.author ? -1 : 1));
  return out;
}

/** Failures out of the runs they were counted from: `of 189 runs · 17%`. */
export function failedOf(failed: number, all: number, noun: string): string {
  if (!all) return '';
  const p = (failed / all) * 100;
  return `of ${counted(all, noun)}${failed ? ` · ${p < 1 ? '<1' : Math.round(p)}%` : ''}`;
}

/** What a day, or a span of them, counts: its runs, failures, kinds and people. */
type DaySum = Pick<DayCount, 'day' | 'runs' | 'failed' | 'byKind' | 'byAuthor'>;

/** A hover card: its title, and its rows' words, figures and colours. */
export interface DaysTip {
  title: string;
  rows: Array<{ label: string; value: string; color: string }>;
}

/**
 * A day's hover card: its title (`Tue, Sep 29 (today) · 3 failed runs`), and its runs by kind, or
 * with a team store by who made them, each in their avatar's tint (CI faint, never lime); failures
 * add a row unless they are what is counted.
 */
export function dayTip(d: DaySum, o: { today: boolean; noun: string; byPerson: boolean; failedChip: boolean }, label = `${dayText(d.day, true)}${o.today ? ' (today)' : ''}`): DaysTip {
  const title = `${label} · ${d.runs ? counted(d.runs, o.noun) : `no ${o.noun}`}`;
  const rows: Array<{ label: string; value: string; color: string }> = [];
  if (o.byPerson) {
    for (const [who, n] of Object.entries(d.byAuthor).sort((a, b) => b[1] - a[1])) rows.push({ label: who ? personName(who) : 'unknown', value: num(n), color: authorColour(who || null) });
  } else {
    const byNoun = new Map<string, number>();
    for (const [kind, n] of Object.entries(d.byKind)) {
      const noun = KIND_NOUN[kind] ?? 'runs';
      byNoun.set(noun, (byNoun.get(noun) ?? 0) + (n ?? 0));
    }
    for (const [noun, n] of [...byNoun].sort((a, b) => b[1] - a[1])) rows.push({ label: noun, value: num(n), color: 'var(--line2)' });
  }
  if (d.failed && !o.failedChip) rows.push({ label: 'failed', value: num(d.failed), color: 'var(--err)' });
  return { title, rows };
}

/** The days each bar of the slim row holds, oldest first: a day each, or a week each (`step` 7) on a phone, the last ending today. */
export function barSpans(days: readonly unknown[], step: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < days.length; i += step) out.push([i, Math.min(i + step, days.length) - 1]);
  return out;
}

/**
 * A bar's two heights, in % of the row: its runs `c` on a square-root scale of the largest bar's
 * (`top`), so a quiet day still shows, split into the runs that didn't fail and the failures `f`
 * at its foot. CSS gives each part 2px at least.
 */
export function barHeights(c: number, f: number, top: number): { hn: number; hf: number } {
  if (c <= 0 || top <= 0) return { hn: 0, hf: 0 };
  const h = Math.sqrt(c / top) * 100;
  return { hn: (h * (c - f)) / c, hf: (h * f) / c };
}

/**
 * The month names under the row: at each bar that holds a month's first day, and at the first bar
 * unless the next name is within two weeks of it (as the grid's, `monthLabels`). `at` is where the
 * bar starts, in % of the row.
 */
export function monthMarks(days: readonly Pick<DayCount, 'day'>[], spans: ReadonlyArray<readonly [number, number]>): Array<{ at: number; label: string }> {
  const out: Array<{ at: number; label: string; day: number }> = [];
  const name = (i: number) => dayText(days[i]!.day).split(' ')[0]!;
  spans.forEach(([a, b], i) => {
    for (let j = a; j <= b; j++) {
      if (Number(days[j]?.day.slice(8, 10)) === 1) {
        out.push({ at: (i / spans.length) * 100, label: name(j), day: j });
        break;
      }
    }
  });
  if (days.length && (!out.length || out[0]!.day >= 14)) out.unshift({ at: 0, label: name(0), day: 0 });
  return out.map(({ at, label }) => ({ at, label }));
}

/** What a span of days adds up to: its runs, failures, kinds and people. */
function spanSum(days: readonly DayCount[], [a, b]: readonly [number, number]): DaySum {
  const out: DaySum = { day: days[a]?.day ?? '', runs: 0, failed: 0, byKind: {}, byAuthor: {} };
  for (let i = a; i <= b; i++) {
    const d = days[i];
    if (!d) continue;
    out.runs += d.runs;
    out.failed += d.failed;
    for (const [k, n] of Object.entries(d.byKind) as Array<[keyof DayCount['byKind'], number]>) out.byKind[k] = (out.byKind[k] ?? 0) + n;
    for (const [who, n] of Object.entries(d.byAuthor)) out.byAuthor[who] = (out.byAuthor[who] ?? 0) + n;
  }
  return out;
}

/**
 * A bar of the slim row: its name (`Thu, Sep 24 (today): 5 runs, 1 failed`, a week's `Sep 21 to
 * Sep 27: 31 runs`; under Failed no failures beside), its hover card (as a day's in the grid), and
 * its two heights out of the largest bar's runs (`top`).
 */
export function barOf(days: readonly DayCount[], span: readonly [number, number], o: { today: number; noun: string; byPerson: boolean; failedChip: boolean; top: number }): { label: string; tip: DaysTip; heights: { hn: number; hf: number } } {
  const s = spanSum(days, span);
  const first = days[span[0]]!.day;
  const name = span[1] > span[0] ? `${dayText(first)} to ${dayText(days[span[1]]!.day)}` : `${dayText(first, true)}${span[0] === o.today ? ' (today)' : ''}`;
  const f = o.failedChip ? s.runs : Math.min(s.failed, s.runs);
  return {
    label: `${name}: ${counted(s.runs, o.noun)}${f && !o.failedChip ? `, ${num(f)} failed` : ''}`,
    tip: dayTip(s, { today: false, noun: o.noun, byPerson: o.byPerson, failedChip: o.failedChip }, name),
    heights: barHeights(s.runs, f, o.top),
  };
}

/** The largest bar's runs, for the bars' scale: 1 when none ran. */
export function barTop(days: readonly Pick<DayCount, 'runs'>[], spans: ReadonlyArray<readonly [number, number]>): number {
  let top = 1;
  for (const [a, b] of spans) {
    let c = 0;
    for (let i = a; i <= b; i++) c += days[i]?.runs ?? 0;
    top = Math.max(top, c);
  }
  return top;
}
