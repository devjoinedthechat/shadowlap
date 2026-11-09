import { plural, shortId } from '../format.js';
import { href } from '../route.js';
import { TODAY } from '../runs.js';
import type { Issue, IssueRun, IssuesPage } from '../types.js';

/*
 * Runs › Failed as issues, as the page draws them (IssuesTable.tsx): an issue's link, its icon, the
 * line under its title, its count's name, and the issues as shown: with the runs Show more brought,
 * less those a delete waits to take. The server groups them (src/issues.ts). No DOM here: the tests import it.
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
function firstPart(i: Pick<Issue, 'kind' | 'failed' | 'detail' | 'blame' | 'runs'>): LinePart | null {
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
      return { kind: 'words', text: i.runs[0]?.judged?.today ? `${TODAY}, ${FROM_RECORDING}` : FROM_RECORDING };
    case 'failure':
      return i.blame ? { kind: 'words', text: i.blame } : null;
  }
}

/**
 * The line under the title, part by part: what failed or how it was judged, where it was planted,
 * where blame found it lost, how many came from production, then its newest run.
 */
export function lineParts(i: Pick<Issue, 'kind' | 'failed' | 'detail' | 'blame' | 'runs' | 'planted' | 'lost' | 'production' | 'newest'>): LinePart[] {
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

/** An issue's runs past those its read carried, which Show more brought, and where the next ask starts. */
export interface MoreRuns {
  runs: readonly IssueRun[];
  more: string | null;
}

/**
 * The issues as the page shows them: each with the runs Show more brought after its own (`more`,
 * none twice), less the runs a delete waits to take (or took, until the issues are read again), its
 * count less those, and an issue with none left gone, as the table leaves them.
 */
export function issuesShown(page: IssuesPage, hidden: ReadonlySet<string>, more: ReadonlyMap<string, MoreRuns>): IssuesPage {
  if (!hidden.size && !more.size) return page;
  let gone = 0;
  const issues = page.issues.flatMap((i) => {
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
    const newest = runs[0] ? { runId: runs[0].runId, about: runs[0].about } : i.newest;
    return [{ ...i, runs, more: next, count, newest, last: runs[0]?.startedAt ?? i.last }];
  });
  return { ...page, issues, total: Math.max(0, page.total - gone) };
}
