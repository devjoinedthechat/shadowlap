import { OPEN_ISSUES } from '../../src/issue-keys.js';
import { plural, shortId } from '../format.js';
import { href } from '../route.js';
import { TODAY } from '../runs.js';
import type { Issue, IssueRun, IssuesPage } from '../types.js';

/*
 * Runs › Failed as issues, as the page draws them (IssuesTable.tsx): an issue's link, its icon, the
 * line under its title, its count's name, the issues a read asks for with their runs, and the issues
 * as shown: with the runs asked for those opened since and the runs Show more brought, less those a
 * delete waits to take. The server groups them (src/issues.ts). No DOM here: the tests import it.
 */

/** Where an issue's title goes: its fix, Tests for a golden's, else its newest run. */
export function issueHref(i: Pick<Issue, 'fix' | 'golden' | 'newest'>): string {
  if (i.fix) return href.fixes(i.fix.fixId);
  if (i.golden) return href.tests();
  return href.run(i.newest.runId);
}

/** An issue's icon: an imported capture's where every run under it is one, else a failed run's. */
export const issueGlyph = (i: Pick<Issue, 'production' | 'count'>): { kind: 'cap' | 'fail'; label: string } => (i.count > 0 && i.production === i.count ? { kind: 'cap', label: 'Imported capture' } : { kind: 'fail', label: 'Failed' });

/** A part of the line under an issue's title, by how it is drawn: what failed after `Failed: `, a golden's detail (its code set as code), words, or its newest run by its id. `text` is the part as it reads, for its length. */
export type LinePart =
  | { kind: 'failed'; text: string; failed: string }
  | { kind: 'detail'; text: string; code: string | null; words: string | null }
  | { kind: 'words'; text: string }
  | { kind: 'newest'; text: string; runId: string; about: string | null };

/** `judged from the recording`, kept on one line where its line wraps. */
const FROM_RECORDING = 'judged from the recording'.replace(/ /g, '\u00a0');

/** The line's first part, by what the issue is: what failed, a golden's detail, or how the run was judged; none for a failure no fix holds that a blame came to nothing on. */
function firstPart(i: Pick<Issue, 'kind' | 'failed' | 'detail' | 'blame' | 'newest'>): LinePart | null {
  switch (i.kind) {
    case 'fix':
    case 'planted':
      return { kind: 'failed', text: `Failed: ${i.failed}`, failed: i.failed };
    case 'test':
      return i.detail ? { kind: 'detail', text: [i.detail.code, i.detail.text].filter(Boolean).join(' '), code: i.detail.code, words: i.detail.text } : null;
    case 'capture':
      return { kind: 'words', text: 'judged when it was imported' };
    case 'today':
      // By today's checks only where those came after the run was recorded.
      return { kind: 'words', text: i.newest.today ? `${TODAY}, ${FROM_RECORDING}` : FROM_RECORDING };
    case 'failure':
      return i.blame ? { kind: 'words', text: i.blame } : null;
  }
}

/**
 * The line under the title, part by part: what failed or how it was judged, where it was planted,
 * where blame found it lost, how many came from production, then its newest run.
 */
export function lineParts(i: Pick<Issue, 'kind' | 'failed' | 'detail' | 'blame' | 'planted' | 'lost' | 'production' | 'newest'>): LinePart[] {
  const first = firstPart(i);
  const words = [i.planted, i.lost, i.kind === 'fix' && i.production ? `${i.production.toLocaleString('en-US')} from production` : null].filter((t): t is string => !!t);
  const id = shortId(i.newest.runId);
  return [...(first ? [first] : []), ...words.map((text) => ({ kind: 'words' as const, text })), { kind: 'newest', text: `newest ${id}`, runId: i.newest.runId, about: i.newest.about?.text ?? null }];
}

/** The count's name, as the button shows or hides its runs. */
export const countName = (n: number, open: boolean): string => `${open ? 'Hide' : 'Show'} its ${plural(n, 'run')}`;

/** What Failed says with no issue to show: words that match none, days with none, or none at all. */
export function issuesEmpty(o: { q: string; days: boolean }): string {
  if (o.q.trim()) return 'No failed runs match.';
  if (o.days) return 'No failed runs on the days picked.';
  return 'No run has failed.';
}

/** The most characters the keys of the issues a read asks for with their runs take in its address, as `encodeURIComponent` writes them. */
const OPEN_CHARS = 4000;

/**
 * The issues a read of them asks for with their runs, from those shown open in the order they were
 * opened: the last opened first, as many as the server answers and the address holds. The read
 * carries every other issue's count alone, and the page asks for the runs of one opened past these.
 */
export function openAsked(opened: Iterable<string>): string[] {
  const keys: string[] = [];
  let chars = 0;
  for (const key of [...opened].reverse()) {
    const n = encodeURIComponent(key).length;
    if (chars + n > OPEN_CHARS) continue;
    keys.push(key);
    chars += n;
    if (keys.length === OPEN_ISSUES) break;
  }
  return keys;
}

/** An issue's runs past those its read carried, which Show more brought, and where the next ask starts. */
export interface MoreRuns {
  runs: readonly IssueRun[];
  more: string | null;
}

/** An open issue's newest runs, asked for where its read carried its count alone: on their way (`runs` null), come, or why they couldn't be read (`error`). */
export interface AskedRuns {
  runs: readonly IssueRun[] | null;
  more: string | null;
  error: string | null;
}

/** The issues with the newest runs that came for those their read carried the count of alone; an issue whose runs are on their way, or couldn't be read, still has none. */
export function withAsked(page: IssuesPage, asked: ReadonlyMap<string, AskedRuns>): IssuesPage {
  if (!asked.size) return page;
  const issues = page.issues.map((i) => {
    const a = i.runs ? null : asked.get(i.key);
    return a?.runs ? { ...i, runs: [...a.runs], more: a.more } : i;
  });
  return { ...page, issues };
}

/** An issue's newest run, as its title and its line read it, from a run under it. */
const newestOf = (r: IssueRun): Issue['newest'] => ({ runId: r.runId, about: r.about, ...(r.judged?.today ? { today: true as const } : {}) });

/**
 * The issues as the page shows them: each with the runs Show more brought after its own (`more`,
 * none twice), less the runs a delete waits to take (or took, until the issues are read again), its
 * count less those, and an issue with none left gone, as the table leaves them. Of a closed issue's
 * runs only its newest is known: one run's issue goes with it, and a bigger one keeps the count its
 * read gave until the issues are read again.
 */
export function issuesShown(page: IssuesPage, hidden: ReadonlySet<string>, more: ReadonlyMap<string, MoreRuns>): IssuesPage {
  if (!hidden.size && !more.size) return page;
  let gone = 0;
  const issues = page.issues.flatMap((i) => {
    if (!i.runs) {
      const only = i.count === 1 && hidden.has(i.newest.runId);
      gone += only ? 1 : 0;
      return only ? [] : [i];
    }
    const extra = more.get(i.key);
    const seen = new Set(i.runs.map((r) => r.runId));
    const all = extra ? [...i.runs, ...extra.runs.filter((r) => !seen.has(r.runId))] : i.runs;
    const runs = hidden.size ? all.filter((r) => !hidden.has(r.runId)) : all;
    const less = all.length - runs.length;
    const next = extra ? extra.more : i.more;
    if (!less) return [extra ? { ...i, runs, more: next } : i];
    gone += less;
    const count = Math.max(0, i.count - less);
    if (!count) return [];
    const newest = runs[0] ? newestOf(runs[0]) : i.newest;
    return [{ ...i, runs, more: next, count, newest, last: runs[0]?.startedAt ?? i.last }];
  });
  return { ...page, issues, total: Math.max(0, page.total - gone) };
}
