import { plural } from '../format.js';
import { href } from '../route.js';
import { TODAY } from '../runs.js';
import type { Issue, IssuesPage } from '../types.js';

/*
 * Runs › Failed as issues, as the page draws them (IssuesTable.tsx): an issue's link, its icon, the
 * line under its title, its count's name, and what is left of the issues while a delete waits to
 * take some of their runs. The server groups them (src/issues.ts). No DOM here: the tests import it.
 */

/** Where an issue's title goes: its fix, Tests for a golden's, else its newest run. */
export function issueHref(i: Pick<Issue, 'fix' | 'golden' | 'newest'>): string {
  if (i.fix) return href.fixes(i.fix.fixId);
  if (i.golden) return href.tests();
  return href.run(i.newest.runId);
}

/** An issue's icon: an imported capture's where every run under it is one, else a failed run's. */
export const issueGlyph = (i: Pick<Issue, 'production' | 'count'>): { kind: 'cap' | 'fail'; label: string } => (i.count > 0 && i.production === i.count ? { kind: 'cap', label: 'Imported capture' } : { kind: 'fail', label: 'Failed' });

/** What its first part says, under the title: what failed (`Failed: …`, kept whole), a golden's detail, or how the run was judged. */
export type FirstPart = { failed: string } | { text: string } | null;

/** The line's first part, by what the issue is. */
export function firstPart(i: Pick<Issue, 'kind' | 'failed' | 'detail' | 'blame' | 'runs'>): FirstPart {
  switch (i.kind) {
    case 'fix':
    case 'planted':
      return { failed: i.failed };
    case 'test':
      return i.detail ? { text: i.detail } : null;
    case 'capture':
      return { text: 'judged when it was imported' };
    case 'today':
      // By today's checks only where those came after the run was recorded.
      return { text: i.runs[0]?.judged?.today ? `${TODAY}, judged from the recording` : 'judged from the recording' };
    case 'failure':
      return i.blame ? { text: i.blame } : null;
  }
}

/** The line's parts after the first, each kept whole: where it was planted, where blame found it lost, how many came from production. The newest run ends it. */
export function laterParts(i: Pick<Issue, 'kind' | 'planted' | 'lost' | 'production' | 'blame'>): string[] {
  const parts: string[] = [];
  // A capture's line says how its import judged it, then that nobody has blamed it yet.
  if (i.kind === 'capture' && i.blame) parts.push(i.blame);
  if (i.planted) parts.push(i.planted);
  if (i.lost) parts.push(i.lost);
  if (i.kind === 'fix' && i.production) parts.push(`${i.production.toLocaleString('en-US')} from production`);
  return parts;
}

/** The count's name, as the button shows or hides its runs. */
export const countName = (n: number, open: boolean): string => `${open ? 'Hide' : 'Show'} its ${plural(n, 'run')}`;

/** What Failed says with no issue to show: words that match none, days with none, or none at all. */
export function issuesEmpty(o: { q: string; days: boolean }): string {
  if (o.q.trim()) return 'No failed runs match.';
  if (o.days) return 'No failed runs on the days picked.';
  return 'No run has failed.';
}

/**
 * The issues less the runs a delete waits to take (or took, until the issues are read again): each
 * issue's runs and count less those, and an issue with none left gone, as the table leaves them.
 */
export function issuesLess(page: IssuesPage, hidden: ReadonlySet<string>): IssuesPage {
  if (!hidden.size) return page;
  let gone = 0;
  const issues = page.issues.flatMap((i) => {
    const runs = i.runs.filter((r) => !hidden.has(r.runId));
    const less = i.runs.length - runs.length;
    if (!less) return [i];
    gone += less;
    const count = Math.max(0, i.count - less);
    if (!count) return [];
    const newest = runs[0] ? { runId: runs[0].runId, about: runs[0].about } : i.newest;
    return [{ ...i, runs, count, newest, last: runs[0]?.startedAt ?? i.last }];
  });
  return { ...page, issues, total: Math.max(0, page.total - gone) };
}
