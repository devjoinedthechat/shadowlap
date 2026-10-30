import { lostWords } from '../../../engine/src/run-verdicts.js';
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

/**
 * How a blame on Today's line came out, in the words Needs a look and the fix use: where the run
 * was lost (at a call, or around or between two), that no model call rescued it (or, when its first
 * probe couldn't tell, that it is not settled), or that it stopped early; while it still probes, that
 * nothing is placed yet.
 */
export function blameWords(b: Pick<OverviewSummary['today']['blame']['runs'][number], 'outcome' | 'lostAt'> & { unsettled?: boolean; range?: unknown }): string {
  if (b.outcome === 'blamed' && b.lostAt) return lostWords(b.lostAt, b.range);
  if (b.outcome === 'unrescuable') return b.unsettled ? 'not settled from the first model call' : 'not rescued from any model call';
  if (b.outcome === 'stopped') return 'blame stopped early';
  return 'not placed yet';
}

/** How Today's newest failed test replay came out, in the words Runs uses: where it diverged, was lost or what failed. */
export function outcomeWords(o: { kind: string; callNo?: number; range?: unknown }): string {
  if (o.kind === 'diverged' && o.callNo) return `diverged at #${o.callNo}`;
  if (o.kind === 'lost' && o.callNo) return lostWords(o.callNo, o.range);
  if (o.kind === 'check-failed') return 'check failed';
  if (o.kind === 'inconclusive') return 'inconclusive';
  return 'failed';
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

/**
 * The goldens that didn't pass, each by its newest result as Tests shows it, in its words: "1 failed
 * · 1 not run yet", inconclusive ones apart. Empty when every golden passed.
 */
export function goldensNotPassing(t: Pick<TestsTile, 'regressions' | 'inconclusive'> & { untested?: number }): string[] {
  return [t.regressions ? `${num(t.regressions)} failed` : null, t.inconclusive ? `${num(t.inconclusive)} inconclusive` : null, t.untested ? `${num(t.untested)} not run yet` : null].filter((x): x is string => x !== null);
}

/** Parts of a line joined by dots, each kept whole, so a line that wraps breaks only after a dot: "1 failed ·" / "last run 10:02". */
export function dotLine(parts: readonly string[]): string {
  return parts.map((p) => p.replace(/ /g, '\u00a0')).join('\u00a0· ');
}

/**
 * Tests passing: its value, its line and its tone, with every golden on disk accounted for as Tests
 * counts them ("5 / 7 · 1 failed · 1 not run yet"), or a dash with no goldens yet. Red when a golden
 * failed; amber when the only goldens not passing are inconclusive.
 */
export function testsKpi(t: TestsTile | null, now: number): { value: string; note: string; tone: '' | 'err' | 'warn' } {
  if (!t || !t.goldens) return { value: '—', note: 'no goldens yet', tone: '' };
  const not = goldensNotPassing(t);
  const how = not.length ? not : [t.goldens === 1 ? 'passed' : 'all passed'];
  return { value: `${num(t.passing)} / ${num(t.goldens)}`, note: dotLine([...how, ...(t.lastRunAt ? [`last run ${lastRunText(t.lastRunAt, now)}`] : [])]), tone: t.regressions ? 'err' : t.inconclusive ? 'warn' : '' };
}

/**
 * Today's Tests line: each golden by its newest result, as Tests passing counts them ("1 failed · 1
 * not run yet", or "all passed"), how many goldens there are on the right, and the test replays that
 * ran today on hover, with how many failed and the newest failure.
 */
export function todayTestsLine(t: TestsTile | null, replays: { count: number; failed: number; inconclusive?: number }, failure: string | null): { text: string; icon: 'fail' | 'warn' | 'test'; count: string; title: string } {
  const unsure = replays.inconclusive ?? 0;
  const title = replays.count ? `${plural(replays.count, 'test replay')} today${replays.failed ? ` · ${num(replays.failed)} failed${failure ? `, the newest ${failure}` : ''}` : ''}${unsure ? ` · ${num(unsure)} inconclusive` : ''}` : 'No test replays today';
  if (!t || !t.goldens) return { text: 'no goldens yet', icon: 'test', count: plural(0, 'golden'), title };
  const not = goldensNotPassing(t);
  return { text: not.length ? dotLine(not) : t.goldens === 1 ? 'passed' : 'all passed', icon: t.regressions ? 'fail' : t.inconclusive ? 'warn' : 'test', count: plural(t.goldens, 'golden'), title };
}

/**
 * Today's Blame line, on the right: the blames that ran today, counted as the lines beside it count
 * replays and forks; on hover, the model calls they probed and their attempts.
 */
export function todayBlameCount(b: Pick<OverviewSummary['today']['blame'], 'blames' | 'probes' | 'attempts'>): { count: string; title: string } {
  return { count: `${num(b.blames)} today`, title: `${plural(b.probes, 'probe')} · ${plural(b.attempts, 'attempt')}` };
}

/** The word before a Needs a look line's arrow: where it leads, or Open on a dashboard that runs nothing (read-only). */
export function needsLookAction(row: Pick<NeedsLookRow, 'action'>, actionsOff: string | null): string {
  return actionsOff ? 'Open' : row.action;
}

/**
 * What tells a Needs a look line from the others, as React keys it: its kind, the fix and the run it
 * leads to, and its title. One fix can hold several goldens' failures (blame joins one regression's
 * failing runs into one fix), so a failing golden's line is its golden's, not its fix's.
 */
export function needsLookKey(row: Pick<NeedsLookRow, 'kind' | 'fixId' | 'runId' | 'title'>): string {
  return [row.kind, row.fixId ?? '', row.runId ?? '', row.title].join(':');
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
  const short = `${MONTHS[d.getUTCMonth()]!} ${d.getUTCDate()}`;
  return weekday ? `${WEEKDAYS[d.getUTCDay()]!}, ${short}` : short;
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
export function activityGlyph(kind: ActivityIcon | (string & {})): GlyphKind {
  const known: readonly string[] = ['live', 'rec', 'fail', 'warn', 'clean', 'fork', 'cap', 'test', 'blame', 'fixok', 'fixbad', 'project', 'setting', 'train'];
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
