/**
 * Days as the viewer lives them: calendar days in their own time zone, an IANA name the browser
 * reports, whatever zone the server runs in. The calendar, "today" and the Overview's week all
 * count by these. A day that daylight saving shortens or lengthens is still one day.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    if (formatters.size > 200) formatters.clear();
    formatters.set(tz, f);
  }
  return f;
}

/** Whether `tz` names a time zone this runtime knows ("Europe/Berlin", "UTC"). */
export function isTimeZone(tz: unknown): boolean {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

interface Ymd {
  y: number;
  m: number;
  d: number;
}

/** The wall-clock date and time at an instant, in `tz`. */
function wall(ms: number, tz: string): Ymd & { h: number; mi: number; s: number } {
  const out = { y: 0, m: 0, d: 0, h: 0, mi: 0, s: 0 };
  for (const p of formatter(tz).formatToParts(new Date(ms))) {
    if (p.type === 'year') out.y = Number(p.value);
    else if (p.type === 'month') out.m = Number(p.value);
    else if (p.type === 'day') out.d = Number(p.value);
    else if (p.type === 'hour') out.h = Number(p.value);
    else if (p.type === 'minute') out.mi = Number(p.value);
    else if (p.type === 'second') out.s = Number(p.value);
  }
  return out;
}

/** How far `tz` is ahead of UTC at an instant, in milliseconds. */
function offset(ms: number, tz: string): number {
  const w = wall(ms, tz);
  const second = Math.floor(ms / 1000) * 1000;
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - second;
}

/**
 * The instant the local day `ymd` starts in `tz`. The offset is read again at the first estimate:
 * between midnight UTC and local midnight the zone may have changed its offset (daylight saving),
 * and where a change skips midnight itself this lands on the first instant the day has.
 */
function startOf(ymd: Ymd, tz: string): number {
  const guess = Date.UTC(ymd.y, ymd.m - 1, ymd.d);
  return guess - offset(guess - offset(guess, tz), tz);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** One local calendar day: its key, the instant it starts, the instant the next one starts, and its weekday. */
export interface LocalDay {
  /** `YYYY-MM-DD` in the viewer's zone. */
  key: string;
  start: number;
  end: number;
  /** 0 for Monday … 6 for Sunday: a calendar column is a week. */
  weekday: number;
}

function dayOf(ymd: Ymd, tz: string): LocalDay {
  const next = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d + 1));
  return {
    key: `${ymd.y}-${pad(ymd.m)}-${pad(ymd.d)}`,
    start: startOf(ymd, tz),
    end: startOf({ y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate() }, tz),
    weekday: (new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d)).getUTCDay() + 6) % 7,
  };
}

/** The local day an instant falls on. */
export function localDay(ms: number, tz: string): LocalDay {
  return dayOf(wall(ms, tz), tz);
}

/** The local day `n` days after `day` (before it for a negative `n`). */
export function addDays(day: LocalDay, n: number, tz: string): LocalDay {
  const [y, m, d] = day.key.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return dayOf({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }, tz);
}

/** Every local day from `first` to `last`, both included. */
export function daysFrom(first: LocalDay, last: LocalDay, tz: string): LocalDay[] {
  const out: LocalDay[] = [];
  for (let day = first; day.start <= last.start && out.length < 3700; day = addDays(day, 1, tz)) out.push(day);
  return out;
}

/** The index of the day an instant falls on in `days` (oldest first, contiguous), or -1 outside them. */
export function dayIndex(days: readonly LocalDay[], ms: number): number {
  let lo = 0;
  let hi = days.length - 1;
  if (hi < 0 || ms < days[0]!.start || ms >= days[hi]!.end) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (days[mid]!.start <= ms) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
