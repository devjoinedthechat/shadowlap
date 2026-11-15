import type { VerdictTone } from '../../src/verdict.js';
import type { Tone } from '../components/Status.js';
import { personName } from '../person.js';
import { href } from '../route.js';
import type { SessionVerdict, VerdictPullRequest, VerdictRow, VerdictsKind } from '../types.js';

/**
 * What Changes › Verdicts decides without the DOM: each row's colour, kind line and link, the chips
 * and their empty lines, how far Show more reads. A row says what the API gives (the engine's words,
 * the command's verdict); nothing here re-words it. The tests import it.
 */

/** The rows a list reads at first, and Show more adds. */
export const VERDICTS_STEP = 50;
/** The most rows the server gives a list, its window (`VERDICTS_WINDOW`, which the page can't import: test/ui-changes.test.ts holds the two equal). */
export const VERDICTS_MAX = 200;

/** The chips, by the API's kinds: a migration is a preview verified and priced, so it counts with them. */
export const VERDICT_CHIPS: ReadonlyArray<{ key: VerdictsKind; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'sessions', label: 'Test sessions' },
  { key: 'previews', label: 'Previews' },
  { key: 'verifies', label: 'Verifies' },
];

/** What a chip with no rows says, in parts with a space between: a command it names is code. */
export function chipEmpty(kind: Exclude<VerdictsKind, 'all'>): readonly LinePart[] {
  if (kind === 'sessions') return [{ words: 'No test session yet. Each one CI runs on a pull request lands here.' }];
  if (kind === 'verifies') return [{ words: 'No verify yet. A fix’s Verify step proves its change on the failing runs and the good ones.' }];
  return [{ words: 'No preview yet. Preview a change on the Preview tab, before it ships.' }];
}

/** A row's colour, as the API gives it (`ok` held, `no` didn't, `y` open, none for nothing to verify): never read off its word. */
export function rowTone(tone: VerdictTone | null): Tone {
  return tone === 'ok' ? 'ok' : tone === 'no' ? 'err' : tone === 'y' ? 'warn' : 'mu';
}

/**
 * Where a row leads: a revision's page, a fix's Verify step at that verify, a preview's on Preview, a
 * migration's on Migrate.
 */
export function verdictHref(row: VerdictRow): string | null {
  if (row.kind === 'session') return href.changes(row.key);
  if (row.kind === 'verify') return href.fixes(row.fixId, 'verify', row.verifyId);
  return href.changeSession(row.kind === 'preview' ? 'decisions' : 'migrate', row.sessionId);
}

/** A session titled by its revision, git having no subject for it: the title is drawn as code, and its kind line leaves the revision out. */
export const titledByRevision = (row: VerdictRow): boolean => row.kind === 'session' && row.subject === null && row.revision !== null;

/** A part of a line, kept whole: words, then a revision or a command in the code face (`on d2e8a1f`), or either alone; the words a link to `href`, a page apart from the dashboard, where one is given. */
export interface LinePart {
  words?: string;
  code?: string;
  href?: string;
}

/** Who made a change, only where the API names them (a team store): their name, an address's part before the @. */
const who = (by: string | null): LinePart[] => (by ? [{ words: personName(by) }] : []);

/** A session's pull request and where it stands: `PR #142 open`, `PR #142` alone until gh said; null for none, and for one CI gave no number. */
export function prWords(pr: VerdictPullRequest | null): string | null {
  if (pr?.number === null || pr?.number === undefined) return null;
  return pr.state ? `PR #${pr.number} ${pr.state}` : `PR #${pr.number}`;
}

/** A session's pull request in a line, kept whole, a link to its page where CI named one that is a web page. */
const pullRequest = (row: SessionVerdict): LinePart[] => {
  const words = prWords(row.pullRequest);
  const url = row.pullRequest?.url;
  return words ? [{ words, ...(url && /^https?:\/\/\S+$/.test(url) ? { href: url } : {}) }] : [];
};

/**
 * What the flag of a session whose pull request merged though it didn't pass says on its card:
 * `PR #127 merged with 6 of 7 goldens passed at b7e40c2: the change shipped with this verdict`.
 */
export function flagLine(row: SessionVerdict): string {
  return `${prWords(row.pullRequest) ?? 'Its pull request'} with ${row.line}${row.revision ? ` at ${row.revision}` : ''}: the change shipped with this verdict`;
}

/**
 * The kind of check first, on every row: `test session · d2e8a1f · PR #142 open · maya`, with the
 * revision left out where the title is it; `verify` and what it verified (a repair's candidate or the
 * fields it set, as the fix's Verify step names it, else the code it ran at); `preview · on d2e8a1f · maya`.
 */
export function kindLine(row: VerdictRow): LinePart[] {
  if (row.kind === 'session') return [{ words: 'test session' }, ...(row.revision && !titledByRevision(row) ? [{ code: row.revision }] : []), ...pullRequest(row), ...who(row.by)];
  if (row.kind === 'verify') {
    if (row.candidate !== null || row.fields !== null) return [{ words: 'verify' }, { words: row.code }];
    return [{ words: 'verify' }, row.codeVersion ? { words: 'on', code: row.codeVersion } : { words: 'working tree' }];
  }
  return [{ words: row.kind }, ...(row.revision ? [{ words: 'on', code: row.revision }] : []), ...who(row.by)];
}

/** The lead's facts under its tally: the change (unless it is the revision, which the heading shows), on a revision's page its pull request, who made it, when. */
export function leadFacts(lead: SessionVerdict, when: string, o: { pr?: boolean } = {}): string[] {
  const pr = o.pr ? prWords(lead.pullRequest) : null;
  return [...(titledByRevision(lead) ? [] : [lead.title]), ...(pr ? [pr] : []), ...(lead.by ? [personName(lead.by)] : []), when];
}

/** The lead's next step is the page's lime while its revision failed or couldn't decide. */
export const leadIsOpen = (lead: SessionVerdict): boolean => lead.failed > 0 || lead.inconclusive > 0;

/** How many rows Show more asks for next: 50 more, up to the window, or null when the list holds every row it can. */
export function moreLimit(o: { shown: number; limit: number; count: number }): number | null {
  if (o.shown >= o.count || o.limit >= VERDICTS_MAX || o.shown < o.limit) return null;
  return Math.min(VERDICTS_MAX, o.limit + VERDICTS_STEP);
}
