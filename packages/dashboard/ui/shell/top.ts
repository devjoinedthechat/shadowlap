import { clock, plural, shortId } from '../format.js';

/**
 * What the top bar says: the parent in a run's crumbs, the help menu's key, and the chip of a run
 * recording. No DOM here: the tests import it.
 */

/**
 * What the parent's crumb spreads to say its key, p, as the keys' table has it (`shortcut('parent')`,
 * which test/ui-list-keys.test.ts holds this to): said here so the table stays out of the first look. p
 * is a single key, so none while they're off. The run page's keys open the parent; the crumb only says so.
 */
export function parentCrumbKey(singleKeys: boolean): { 'aria-keyshortcuts'?: string } {
  return singleKeys ? { 'aria-keyshortcuts': 'p' } : {};
}

/**
 * The key the help menu's Keyboard shortcuts row shows at its right, ?, as the keys' table has it
 * (`keyColumn('help')`, which test/ui-list-keys.test.ts holds this to): said here so the table stays
 * out of the first look. ? is a single key, so none while they're off.
 */
export function helpRowKey(singleKeys: boolean): string | null {
  return singleKeys ? '?' : null;
}

/**
 * The parent a run's crumbs name (Runs / parent / run): the run list's, when it lists the run; else
 * the one in the run's own detail, once its page has loaded it (an attempt, or a run older than the
 * newest 500). An exported copy links only to runs it holds.
 */
export function crumbParent(o: { listed: { parentRunId: string | null } | null; loaded: string | null | undefined; exported: boolean; holds: (runId: string) => boolean }): string | null {
  const parent = o.listed ? o.listed.parentRunId : (o.loaded ?? null);
  return parent && (!o.exported || o.holds(parent)) ? parent : null;
}

/** How many ancestors a run's crumbs name at most: a family deeper than this starts at its eighth. */
const LINEAGE_MAX = 8;

/**
 * A run's lineage as its crumbs carry it (decision 10: named once, by id): the run it came from back
 * to its recording, oldest first, each with what it was about for the crumb's hover. Each step reads
 * the run list, or the detail of a run its page loaded (an attempt, a run older than the newest 500),
 * and stops where neither names a parent; an exported copy links only to runs it holds.
 */
export function crumbLineage(runId: string, o: { listed: (runId: string) => { parentRunId: string | null; about?: { text: string } | null } | null; loaded: (runId: string) => string | null | undefined; exported: boolean; holds: (runId: string) => boolean }): Array<{ runId: string; about: string | null }> {
  const out: Array<{ runId: string; about: string | null }> = [];
  const seen = new Set<string>([runId]);
  for (let id = runId; out.length < LINEAGE_MAX; ) {
    const parent = crumbParent({ listed: o.listed(id), loaded: o.loaded(id), exported: o.exported, holds: o.holds });
    if (!parent || seen.has(parent)) break;
    seen.add(parent);
    out.unshift({ runId: parent, about: o.listed(parent)?.about?.text ?? null });
    id = parent;
  }
  return out;
}

/** A run recording, as the chip reads it. */
export interface Recording {
  runId: string;
  calls: number;
}

/** The chip's words, where it leads, and its card: the run by id, and its about line or, offline, when it was last heard of. */
export interface LiveChip {
  runId: string;
  words: string;
  title: string;
  line: string | null;
}

/**
 * The chip of a run recording, as the design draws it: `recording · 9 calls`, its card naming the run
 * and what it is about. Not on that run's own page, which says it records (`open`, the id the page
 * was opened by): the next recording takes the chip there. While offline it stays, its card saying
 * when it was last heard of; not while the link has expired, when its card covers all.
 */
export function liveChip(o: { recording: readonly Recording[]; open: string | null; conn: 'ok' | 'offline' | 'expired'; loadedAt: number | null; aboutOf?: (runId: string) => string | null }): LiveChip | null {
  if (o.conn === 'expired') return null;
  const { open } = o;
  const r = o.recording.find((x) => open === null || !(x.runId === open || (open.length >= 10 && x.runId.startsWith(open))));
  if (!r) return null;
  const offline = o.conn === 'offline' ? `Recording when last heard of${o.loadedAt ? `, at ${clock(o.loadedAt)}` : ''}: live updates are paused` : null;
  return { runId: r.runId, words: `recording · ${plural(r.calls, 'call')}`, title: `Recording ${shortId(r.runId)}`, line: offline ?? o.aboutOf?.(r.runId) ?? null };
}
