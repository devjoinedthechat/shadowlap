import { consentAsked } from './actions.js';
import { PAUSED } from './connection.js';
import { ACTIONS } from './labels.js';

/**
 * The command palette's matching: which items a query shows, in which order. No DOM here: the
 * tests import it. The palette itself is `shell/Palette.tsx`.
 */

export type PaletteGroup = 'This run' | 'Go to' | 'Settings' | 'Actions' | 'Runs' | 'Fixes' | 'Tests' | 'Projects' | 'In recorded data';

export const GROUP_ORDER: readonly PaletteGroup[] = ['This run', 'Go to', 'Settings', 'Actions', 'Runs', 'Fixes', 'Tests', 'Projects', 'In recorded data'];

export interface PaletteEntry {
  group: PaletteGroup;
  label: string;
  hint: string;
  /** A shorter hint, where the whole one doesn't fit the row (`Compare with parent`'s `against <parent>`). */
  short?: string;
  /** It starts a job, or opens what starts one: paused while the server can't be reached. */
  job?: boolean;
  /** Words it matches that don't show: a run's kind, command and labels, besides its id and about line. */
  match?: string;
  /** Found only once something is typed, never listed on the open palette. */
  typed?: boolean;
  /** Its own key, one word per key: the row's key column, while single-key shortcuts are on. */
  key?: string | undefined;
  /** Why it can't start now, a job holding what it needs: its hint says so, dimmed, and so does picking it. */
  wait?: string;
}

/** Run blame for the newest failures nobody has blamed, as their pages lead with it, at most this many. */
export const BLAME_ENTRIES = 3;

/**
 * Run blame for the newest failures nobody has blamed but the run open: those whose next step it is,
 * as a list's rows say it. Found once something is typed, by what they did too (`failed`, their about
 * line).
 */
export function blameEntries<R extends { runId: string; startedAt: number; next?: { key: string; command?: string } | null; about?: { text: string } | null }>(runs: readonly R[], open: string | null): Array<{ run: R; entry: PaletteEntry }> {
  return runs
    .filter((r) => r.next?.key === 'blame' && r.runId !== open)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, BLAME_ENTRIES)
    .map((run) => ({ run, entry: { group: 'Actions', label: ACTIONS.runBlame.label, hint: run.next?.command ?? '', job: true, typed: true, match: `failed ${run.about?.text ?? ''}` } }));
}

/**
 * A blame the palette started that first asks something (the check, or a yes to someone else's
 * command), which the run's own page asks; a capture's first asks for your command, so it goes there
 * before anything is started.
 */
export function blameAsksOnItsPage(err: unknown): boolean {
  return (err as { status?: unknown } | null)?.status === 422 || consentAsked(err) !== null;
}

/** What picking an entry says instead of running it: paused while the server can't be reached, or why it waits. */
export function pickRefusal(x: Pick<PaletteEntry, 'job' | 'wait'>, offline: boolean): string | null {
  return offline && x.job ? PAUSED : (x.wait ?? null);
}

/**
 * What the palette's field says it searches, as the dashboard stands: an exported copy holds runs
 * and pages; without the server (offline) the same, since recorded data is searched there and jobs
 * are paused; a read-only dashboard runs no actions; otherwise everything.
 */
export function palettePlaceholder(o: { exported: boolean; actions: boolean; offline: boolean }): string {
  if (o.exported || o.offline) return 'Search runs and pages';
  return o.actions ? 'Search runs, pages, actions and what runs recorded' : 'Search runs, pages and what runs recorded';
}

/**
 * The Actions group in the design's order, whichever page added each: what a failing golden or the
 * training data asks for first, then what runs the agent, and Keyboard shortcuts last. An action not
 * named here goes before Keyboard shortcuts, in the order it was added.
 */
export const ACTION_ORDER: readonly string[] = [ACTIONS.updateGoldens.label, ACTIONS.exportPairs.label, ACTIONS.scoreModel.label, ACTIONS.runTests.label, ACTIONS.importCapture.label, ACTIONS.calibrate.label];

/** Where an action sits in its group: its place in ACTION_ORDER, then unnamed actions, then Keyboard shortcuts. */
export function actionRank(label: string): number {
  if (label === ACTIONS.keyboardShortcuts.label) return ACTION_ORDER.length + 1;
  const i = ACTION_ORDER.indexOf(label);
  return i < 0 ? ACTION_ORDER.length : i;
}

/** A hint that is a command, which a typed word never matches but on a run's or a page's row. */
const COMMAND_HINT = /^(\$ )?(shadowlap|git) /;

/** With nothing typed: This run, Go to, Actions, this many of the newest runs, and Projects. */
export const EMPTY_RUNS = 5;
/** Typed items shown at most, before what runs recorded. */
export const MAX_ITEMS = 34;

export function words(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * The items a query shows. Every typed word must appear in the label, the hint or what it matches unseen. Groups keep their
 * order; within a group, a label that starts with the first word comes first, then one that
 * contains it, then the rest. Actions keep the design's order (`ACTION_ORDER`) among equals; runs
 * come in the order given (newest first). An action is found by its label and its words, never by
 * the command in its hint, so an id finds its run alone (a run's hint and a page's are searched);
 * and one word of three letters or digits or more that is part of a listed run's id puts Runs
 * first, as an id does in an issue tracker.
 */
export function matchPalette<T extends PaletteEntry>(items: readonly T[], query: string, limit = MAX_ITEMS): T[] {
  const w = words(query);
  const order = (g: PaletteGroup) => GROUP_ORDER.indexOf(g);
  const action = (x: PaletteEntry) => (x.group === 'Actions' ? actionRank(x.label) : 0);
  if (!w.length) {
    let runs = 0;
    return items
      .filter((x) => !x.typed && x.group !== 'Fixes' && x.group !== 'Tests' && x.group !== 'In recorded data' && (x.group !== 'Runs' || runs++ < EMPTY_RUNS))
      .map((x, i) => ({ x, i }))
      .sort((a, b) => order(a.x.group) - order(b.x.group) || action(a.x) - action(b.x) || a.i - b.i)
      .map((m) => m.x);
  }
  const first = w[0]!;
  const byId = w.length === 1 && /^[0-9a-z]{3,}$/.test(first) && items.some((x) => x.group === 'Runs' && x.label.toLowerCase().includes(first));
  const rank = (g: PaletteGroup) => (byId && g === 'Runs' ? -1 : order(g));
  return items
    .map((x, i) => {
      const label = x.label.toLowerCase();
      const hint = x.group === 'Runs' || x.group === 'Go to' || !COMMAND_HINT.test(x.hint) ? x.hint.toLowerCase() : '';
      const hay = `${label} ${hint}${x.match ? ` ${x.match.toLowerCase()}` : ''}`;
      if (!w.every((word) => hay.includes(word))) return null;
      return { x, i, score: label.startsWith(first) ? 0 : label.includes(first) ? 1 : 2 };
    })
    .filter((m): m is { x: T; i: number; score: number } => m !== null)
    .sort((a, b) => rank(a.x.group) - rank(b.x.group) || a.score - b.score || action(a.x) - action(b.x) || a.i - b.i)
    .slice(0, limit)
    .map((m) => m.x);
}

/** While the server's index is behind, the palette asks again this often, so matches arrive as it catches up. */
export const INDEXING_RETRY_MS = 1000;

/**
 * A query that can be a run's id, typed in full or its start: 4 to 26 characters of Crockford's
 * base32, as run ids are written, in capitals. Null for anything else.
 */
export function runIdPrefix(q: string): string | null {
  const t = q.trim().toUpperCase();
  return /^[0-9A-HJKMNP-TV-Z]{4,26}$/.test(t) ? t : null;
}

/**
 * The runs the palette asks the server for by id: the run list holds only the newest runs (500), so
 * an older run typed by its id is looked up, unless a listed run already starts with it. The rows
 * the server found are kept only when their id starts with what was typed (its filter also matches
 * commands and labels), at most `max`.
 */
export function runsToAskFor(q: string, listed: readonly { runId: string }[] | null): string | null {
  const prefix = runIdPrefix(q);
  if (!prefix || (listed ?? []).some((r) => r.runId.startsWith(prefix))) return null;
  return prefix;
}
export function runsById<R extends { runId: string }>(prefix: string, found: readonly R[], max = 5): R[] {
  return found.filter((r) => r.runId.startsWith(prefix)).slice(0, max);
}

/**
 * What the palette says under recorded data while the server is still indexing it (a store whose
 * index is being built, a recording's newest calls): matches from those runs may follow. `said`: the
 * words its live region says, with "some runs" for the count, which moves as the index catches up:
 * they are said once, not each time it is asked again.
 */
export function indexingNote(indexing: { runs: number; of: number } | null | undefined, o: { said?: boolean } = {}): string | null {
  if (!indexing || indexing.runs < 1) return null;
  const runs = o.said ? 'some runs' : indexing.runs === 1 ? '1 run' : `${indexing.runs.toLocaleString('en-US')} of ${indexing.of.toLocaleString('en-US')} runs`;
  return `Still reading what ${runs} recorded: more matches may follow.`;
}

/**
 * Hits from what runs recorded: at most `max`, and at most `perRun` from any one run. Hits from runs
 * of their own (recordings, forks, tests) come first. An attempt (`--repeat`, a blame probe, a verify
 * attempt: `attemptOf` names its run) replays its run's text, so its hit is left out when that run
 * has one of its own, and the attempts of one run share that run's `perRun`: a blame's probes don't
 * fill the list with one snippet.
 */
export function limitRecorded<H extends { runId: string; attemptOf?: string | null }>(hits: readonly H[], max = 6, perRun = 2): H[] {
  const own = hits.filter((h) => !h.attemptOf);
  const attempts = hits.filter((h) => h.attemptOf);
  const hasOwn = new Set(own.map((h) => h.runId));
  const seen = new Map<string, number>();
  const out: H[] = [];
  for (const h of [...own, ...attempts]) {
    if (out.length >= max) break;
    if (h.attemptOf && hasOwn.has(h.attemptOf)) continue;
    const key = h.attemptOf ?? h.runId;
    const n = seen.get(key) ?? 0;
    if (n >= perRun) continue;
    seen.set(key, n + 1);
    out.push(h);
  }
  return out;
}

/** The label split around the first typed word, for marking it; null when it does not contain it. */
export function highlight(label: string, query: string): [string, string, string] | null {
  const first = words(query)[0];
  if (!first) return null;
  const at = label.toLowerCase().indexOf(first);
  if (at < 0) return null;
  return [label.slice(0, at), label.slice(at, at + first.length), label.slice(at + first.length)];
}

/** A search snippet's text, with the server's match markers (\u0001 … \u0002) taken out and the matches returned. */
export function snippetParts(snippet: string): Array<{ text: string; match: boolean }> {
  const out: Array<{ text: string; match: boolean }> = [];
  const flat = snippet.replace(/\s+/g, ' ');
  const re = /\u0001([^\u0002]*)\u0002/g;
  let last = 0;
  for (let m = re.exec(flat); m; m = re.exec(flat)) {
    if (m.index > last) out.push({ text: flat.slice(last, m.index), match: false });
    out.push({ text: m[1] ?? '', match: true });
    last = m.index + m[0].length;
  }
  if (last < flat.length) out.push({ text: flat.slice(last), match: false });
  return out;
}
