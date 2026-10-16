import { num } from '../format.js';
import { dayText, personName } from '../overview/model.js';
import type { RunChip } from '../runs.js';
import type { DayCount } from '../types.js';

/**
 * The Runs calendar's logic: twelve weeks, a column per week, a day picked by a click, several by a
 * drag or Shift-click, moved between by the arrow keys. The days are the viewer's own (the server
 * works them out in their time zone); a range picked is kept by its days' keys, so a new day
 * starting, or the data coming again, keeps it. No DOM here: the tests import it.
 */

export const CAL_WEEKS = 12;
/** Cells drawn: twelve weeks of seven days; those after today are blank. */
export const CAL_CELLS = CAL_WEEKS * 7;

/** What the chip picked counts, in the calendar's words. */
export const CAL_NOUN: Readonly<Record<RunChip, string>> = { all: 'runs', recording: 'recordings', fork: 'forks', clean: 'clean replays', test: 'tests', capture: 'captures', failed: 'failed runs' };

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

/** The days picked as indices into `days`, or null when none are (or they are no longer shown). */
export function pickedRange(days: readonly Pick<DayCount, 'day'>[], picked: PickedDays | null): [number, number] | null {
  if (!picked) return null;
  const a = days.findIndex((d) => d.day === picked.from);
  const b = days.findIndex((d) => d.day === picked.to);
  if (a < 0 || b < 0) return null;
  return [Math.min(a, b), Math.max(a, b)];
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

/** A drag over the calendar: where it started, where it is, whether it moved, and whether it started on the one day already picked. */
export interface Drag {
  a: number;
  b: number;
  moved: boolean;
  again: boolean;
}

/** A pointer down on a day: Shift extends what is picked from its far end; a click on the one day picked will clear it. */
export function dragStart(day: number, current: readonly [number, number] | null, shift: boolean): Drag {
  if (shift && current) return { a: day < current[0] ? current[1] : current[0], b: day, moved: true, again: false };
  return { a: day, b: day, moved: false, again: !!current && current[0] === day && current[1] === day };
}

/** The pointer moved over a day. */
export function dragOver(drag: Drag, day: number): Drag {
  return day === drag.b ? drag : { ...drag, b: day, moved: true };
}

/** The pointer let go: the range picked, or none when the one day picked was clicked again. */
export function dragEnd(drag: Drag): [number, number] | null {
  if (drag.again && !drag.moved) return null;
  return [Math.min(drag.a, drag.b), Math.max(drag.a, drag.b)];
}

/** The range shown while dragging, else the one picked. */
export function shownRange(drag: Drag | null, picked: readonly [number, number] | null): [number, number] | null {
  if (drag) return [Math.min(drag.a, drag.b), Math.max(drag.a, drag.b)];
  return picked ? [picked[0], picked[1]] : null;
}

/** The day an arrow key moves to: a column is a week, so left and right move seven days. Null for another key or past the ends. */
export function moveDay(day: number, key: string, count: number): number | null {
  const step = ({ ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 } as Record<string, number>)[key];
  if (step === undefined) return null;
  const next = day + step;
  return next >= 0 && next < count ? next : null;
}

/** Enter (or Space) on a day: picks it, or with Shift extends what is picked to it; on the one day picked, clears it. */
export function keyPick(day: number, current: readonly [number, number] | null, shift: boolean): [number, number] | null {
  if (shift && current) return [Math.min(current[0], day), Math.max(current[1], day)];
  if (current && current[0] === day && current[1] === day) return null;
  return [day, day];
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

/**
 * A day's hover card: its title (`Tue, Sep 29 (today) · 3 failed runs`), and its runs by kind, or
 * with a team store by who made them; failures add a row unless they are what is counted.
 */
export function dayTip(d: DayCount, o: { today: boolean; noun: string; byPerson: boolean; failedChip: boolean }): { title: string; rows: Array<{ label: string; value: string; color: string }> } {
  const title = `${dayText(d.day, true)}${o.today ? ' (today)' : ''} · ${d.runs ? counted(d.runs, o.noun) : `no ${o.noun}`}`;
  const rows: Array<{ label: string; value: string; color: string }> = [];
  if (o.byPerson) {
    for (const [who, n] of Object.entries(d.byAuthor).sort((a, b) => b[1] - a[1])) rows.push({ label: who ? personName(who) : 'unknown', value: num(n), color: who === 'ci' ? 'var(--faint)' : 'var(--lime)' });
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
