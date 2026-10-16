import { cents, durLong, num, plural } from '../format.js';
import { ORIGIN_CODE, type Origin7 } from '../origins.js';
import type { GlyphKind } from '../runs.js';
import type { ActivityIcon, NeedsLookRow, OverviewSummary, TestsTile } from '../types.js';

/**
 * What the Overview says, worked out from the server's summary: the outcome strip's lines, the
 * origins in the mock's order, the chart's scale, and the words for a run's kind. No DOM here: the
 * tests import it.
 */

/** The order the Overview lists origins in: what replaying saved first, then what ran, then what was changed. */
export const SHOW_ORIGINS: readonly Origin7[] = ['rep', 'live', 'block', 'stub', 'over', 'inject', 'fail'];

/** The server's origin counts (one letter per origin) as the views' origins. */
export function originCounts(counts: Readonly<Record<string, number>>): Record<Origin7, number> {
  const out: Record<Origin7, number> = { rep: 0, live: 0, over: 0, inject: 0, fail: 0, block: 0, stub: 0 };
  for (const [code, n] of Object.entries(counts)) {
    const o = ORIGIN_CODE[code];
    if (o) out[o] += n;
  }
  return out;
}

/** A share as the mock writes it: `38%`, and `<1%` for anything above nothing that rounds to it. */
export function share(part: number, whole: number): string {
  if (!whole || !part) return '0%';
  const p = (part / whole) * 100;
  return p < 1 ? '<1%' : `${Math.round(p)}%`;
}

/** Each origin present, in the Overview's order, with its count and share. */
export function originRows(counts: Record<Origin7, number>): Array<{ origin: Origin7; count: number; share: string }> {
  const total = SHOW_ORIGINS.reduce((t, o) => t + counts[o], 0);
  return SHOW_ORIGINS.filter((o) => counts[o] > 0).map((o) => ({ origin: o, count: counts[o], share: share(counts[o], total) }));
}

/** The line under Failures reproduced. */
export function reproducedNote(o: OverviewSummary['outcomes']['reproduced']): string {
  return `replayed exactly · ${o.open ? `${num(o.open)} still open` : 'none open'}`;
}

/** The line under Fixes verified. */
export function verifiedNote(o: OverviewSummary['outcomes']['fixesVerified']): string {
  return o.rejected ? `${num(o.rejected)} rejected before ${o.rejected === 1 ? 'it' : 'they'} shipped` : 'none rejected';
}

/** When the tests last ran, in a few characters: 10:02 today, else Sep 30. */
export function lastRunText(at: number, now: number): string {
  const d = new Date(at);
  const t = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Tests passing: its value and its line, or a dash with no goldens yet. */
export function testsKpi(t: TestsTile | null, now: number): { value: string; note: string; failing: boolean } {
  if (!t || !t.goldens) return { value: '—', note: 'no goldens yet', failing: false };
  const caught = t.regressions ? `${plural(t.regressions, 'regression')} caught` : 'no regressions';
  return { value: `${num(t.passing)} / ${num(t.goldens)}`, note: `${caught} · ${t.lastRunAt ? `last run ${lastRunText(t.lastRunAt, now)}` : 'not run yet'}`, failing: t.regressions > 0 };
}

/** The line under Spent live: the receipt, what replaying saved. */
export function spentNote(o: OverviewSummary['outcomes']['spent']): string {
  return `${cents(o.notRespent)} not re-spent · ${durLong(o.notWaitedMs)} not waited`;
}

/** A round top for the daily chart's axis, at or above the largest value, and its five ticks. */
export function chartScale(values: readonly number[]): { max: number; ticks: number[] } {
  const top = Math.max(0, ...values);
  if (top <= 0) return { max: 0.04, ticks: [0, 0.01, 0.02, 0.03, 0.04] };
  // A step of 1, 2, 2.5 or 5 times a power of ten, four steps reaching the top.
  const raw = top / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw - 1e-12)!;
  // Without float noise: three steps of 0.2 are 0.6, not 0.6000000000000001.
  const at = (k: number) => Number((step * k).toPrecision(12));
  return { max: at(4), ticks: [0, at(1), at(2), at(3), at(4)] };
}

/** A tick on the chart's axis: `$0.20`, `$1.50`, `$12`. */
export function tickText(v: number): string {
  if (v >= 10) return `$${Math.round(v)}`;
  return `$${v.toFixed(2)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** A day the server names by its `YYYY-MM-DD` in the viewer's zone: `Sep 25`, or with its weekday `Thu, Sep 25`. */
export function dayText(key: string, weekday = false): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return key;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const short = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return weekday ? `${WEEKDAYS[d.getUTCDay()]}, ${short}` : short;
}

/** The icon a run of this kind shows where only its kind is known (a cache miss, a grid row). */
export function kindGlyph(kind: string, o: { failed?: boolean; live?: boolean } = {}): { kind: GlyphKind; label: string } {
  if (o.live) return { kind: 'live', label: 'Recording now' };
  switch (kind) {
    case 'fork':
      return { kind: 'fork', label: 'Fork' };
    case 'clean':
      return { kind: 'clean', label: 'Clean replay' };
    case 'capture':
      return { kind: 'cap', label: 'Imported capture' };
    case 'test':
      return o.failed ? { kind: 'fail', label: 'Test failed' } : { kind: 'test', label: 'Test replay' };
    case 'replay':
      return o.failed ? { kind: 'fail', label: 'Replay failed' } : { kind: 'clean', label: 'Replay' };
    default:
      return o.failed ? { kind: 'fail', label: 'Recording, failed' } : { kind: 'rec', label: 'Recording' };
  }
}

/** An activity entry's icon among the dashboard's glyphs; a kind it does not know shows as a recording. */
export function activityGlyph(kind: ActivityIcon | string): GlyphKind {
  const known: readonly string[] = ['live', 'rec', 'fail', 'clean', 'fork', 'cap', 'test', 'blame', 'fixok', 'fixbad', 'project', 'setting', 'train'];
  return known.includes(kind) ? (kind as GlyphKind) : 'rec';
}

/**
 * An activity entry's words and the code after them: an id as the CLI prints it (a run's first 10
 * characters, a fix's or a verdict's prefix and 10 more, `fx-01K5CQ2E8M`), a file or a rule as it
 * is. Said once: words that end on the id (a verdict on a fix with no title) leave it to the code,
 * and words that name it already need no code.
 */
export function activityLine(text: string, ref: string | null | undefined): { text: string; code: string | null } {
  if (!ref) return { text, code: null };
  const code = /^[0-9A-Z]{26}$/.test(ref) ? ref.slice(0, 10) : /^(fx|vf)-[0-9A-Z]{26}$/.test(ref) ? ref.slice(0, 13) : ref;
  for (const id of new Set([ref, code])) {
    if (text.endsWith(` · ${id}`)) return { text: text.slice(0, -(id.length + 3)), code };
    if (text.includes(id)) return { text, code: null };
  }
  return { text, code };
}

/** Needs a look shows three, then "Show N more" opens the rest. */
export const NEEDS_LOOK_SHOWN = 3;

/** The lines Needs a look shows, and what its button says: the lines it would open, every one of them sent. */
export function needsLookShown(items: readonly NeedsLookRow[], open: boolean): { rows: readonly NeedsLookRow[]; more: string | null } {
  if (items.length <= NEEDS_LOOK_SHOWN) return { rows: items, more: null };
  return open ? { rows: items, more: 'Show fewer' } : { rows: items.slice(0, NEEDS_LOOK_SHOWN), more: `Show ${num(items.length - NEEDS_LOOK_SHOWN)} more` };
}

/** Who did something, in the activity feed and the By column: an email by its name part, CI as `ci`. */
export function personName(author: string | null | undefined): string {
  if (!author) return 'unknown';
  const at = author.indexOf('@');
  return at > 0 ? author.slice(0, at) : author;
}
