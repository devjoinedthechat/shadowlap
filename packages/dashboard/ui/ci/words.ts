import { dayClock } from '../goldens.js';

/**
 * The pull request comment's words around its preview, as Settings → CI, a revision's page and the
 * palette say them: the session the preview reads, and why Preview pull request comment waits. No
 * DOM here: the tests import it.
 */

/** `d2e8a1f at Oct 1, 10:02`, or `d2e8a1f, just now` within a minute: a full sha cut to seven, `d2e8a1f+dirty` as it is, `no revision` for none. */
export function sessionWhen(revision: string | null, at: number, now = Date.now()): string {
  const rev = revision ? (/^[0-9a-f]{8,}$/i.test(revision) ? revision.slice(0, 7) : revision) : 'no revision';
  return now - at < 60_000 ? `${rev}, just now` : `${rev} at ${dayClock(at)}`;
}

/** Preview pull request comment's card line: the session it reads. */
export const previewSub = (s: { revision: string | null; at: number }, now = Date.now()): string => `From the last test session, ${sessionWhen(s.revision, s.at, now)}`;

/** Why Preview pull request comment waits before any session ran every golden: the toast a press raises, and its card's line. */
export const PREVIEW_WAIT = { why: 'No test session yet: run the tests once', whyTip: 'The comment is the last test session’s: run the tests once' } as const;

/** The marks the drawn comment gives a verdict, where the Markdown has ❌, 🟡 and ✅. */
export const DRAWN_MARK: Record<string, string> = { failed: '✗', inconclusive: '?', passed: '✓' };

/** A verdict's class in the drawn comment: `fail`, `inc` or `pass`. */
export const markTone = (verdict: string): 'fail' | 'inc' | 'pass' => (verdict === 'passed' ? 'pass' : verdict === 'inconclusive' ? 'inc' : 'fail');
