import { href } from './route.js';

/** What a not-found page says is missing: a route with nothing at it, a run, an id several runs share, a fix, a setup with nothing to do. */
export type NotFoundKind = 'page' | 'run' | 'runs' | 'fix' | 'setup';

/**
 * What a not-found page says, and its way back: a run or a fix a link names that isn't here points
 * back to the list that holds its kind; a route with nothing at it, and a setup with nothing to do,
 * to the Overview. `code` is the part set as code: the address no page is at. `runs` is where Runs
 * opens, with the filter it had.
 */
export function notFoundWords(kind: NotFoundKind, id: string, runs = href.runs()): { text: string; code: string | null; back: readonly [string, string] } {
  if (kind === 'run') return { text: `No run ${id}.`, code: null, back: [runs, 'Open Runs'] };
  if (kind === 'runs') return { text: `${id} matches several runs; use more of the id.`, code: null, back: [runs, 'Open Runs'] };
  if (kind === 'fix') return { text: `No fix ${id}.`, code: null, back: [href.fixes(), 'Open Fixes'] };
  const overview = [href.overview(), 'Back to Overview'] as const;
  if (kind === 'setup') return { text: 'Nothing to set up here.', code: null, back: overview };
  return { text: `No page at ${id}.`, code: id, back: overview };
}
