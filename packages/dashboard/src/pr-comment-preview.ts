import { COMMENT_FOOT, commentHead, commentInjection, commentMarkdown, commentRows, type ActionStep, type StoreOf } from '@shadowlap/engine';
import { costPart, decisionsPart, inSessionOrder, keptDecisions, storedCommentResult, type KeptCost, type KeptDecisions, type KeptInjection } from './session-comment.js';
import type { GoldenSource } from './tests.js';
import { newestFullSession } from './verdicts.js';

/**
 * Settings → CI's preview of the pull request comment (GET /api/ci/comment): the comment as the
 * Action would post it, from the newest session here that ran every golden and wasn't interrupted
 * (newestFullSession, the one Verdicts leads with), as that session left it, its revision as it is
 * (`d2e8a1f+dirty`): a golden replayed on its own since waits for the next such session. Its words
 * are the engine's (pr-comment), and its Markdown is the engine's renderer given no marker, no base,
 * no fixes and no job address, which only the job knows. It reads the session's results and what its
 * comment kept, never a run or a call.
 */

type Store = StoreOf<'readModels' | 'tests'>;

export interface PrCommentPreview {
  /** The session it is made from, its revision as it is. */
  session: { id: string; revision: string | null; at: number };
  /** The heading's tally: `2 of 3 goldens passed · 1 failed`. */
  head: string;
  /** Each golden's row, worst first, with its verdict line. */
  rows: Array<{ verdict: string; golden: string; line: string }>;
  /** The decisions the session's job kept; null for none. */
  decisions: KeptDecisions | null;
  /** A run's cost before and after; null without both. */
  cost: KeptCost | null;
  /** Each injection gate that ran. */
  injection: KeptInjection[];
  /** Who posts it: `github-actions`, or the account the step's own token belongs to. */
  postedBy: string;
  /** The comment's last line, where each failure is in full, as text: the job's page it links to is the job's own. */
  foot: string;
  /** The comment as Markdown: what Copy Markdown copies. */
  markdown: string;
}

/** A token the job gives every step: what the action comments with when the step names no other. */
const JOB_TOKEN = /^\$\{\{\s*(?:secrets\.GITHUB_TOKEN|github\.token)\s*\}\}$/;

/**
 * Who posts the comment, as the repository's step gives the action its token, in the order the
 * action takes one (action/github.mjs): a `github-token` input, else a `GH_TOKEN` or `GITHUB_TOKEN` in
 * the step's env; one that is the job's own token, or none, posts as `github-actions`. Without the
 * step (no workflow yet), `github-actions`.
 */
export function postedBy(step: Pick<ActionStep, 'inputs' | 'envValues'> | null): string {
  const own = (v: string | undefined): boolean => !!v?.trim() && !JOB_TOKEN.test(v.trim());
  if (!step) return 'github-actions';
  if (own(step.inputs['github-token'])) return 'the account github-token belongs to';
  const name = step.envValues.GH_TOKEN?.trim() ? 'GH_TOKEN' : step.envValues.GITHUB_TOKEN?.trim() ? 'GITHUB_TOKEN' : null;
  return name && own(step.envValues[name]) ? `the account ${name} belongs to` : 'github-actions';
}

/** The comment's preview; `{ session: null }` before a session ran every golden. */
export function prCommentPreview(store: Store, goldens: readonly GoldenSource[], o: { step: Pick<ActionStep, 'inputs' | 'envValues'> | null }): PrCommentPreview | { session: null } {
  const s = newestFullSession(store, goldens);
  if (!s) return { session: null };
  const results = inSessionOrder(store.listTestResults({ sessionId: s.sessionId, limit: 100_000 })).map(storedCommentResult);
  const decisions = keptDecisions(store, s.comment?.decisions);
  const costPerRun = s.comment?.costPerRun ?? null;
  return {
    session: { id: s.sessionId, revision: s.revision, at: s.endedAt ?? s.startedAt },
    head: commentHead(results),
    rows: commentRows(results),
    decisions: decisionsPart(decisions),
    cost: costPart(costPerRun),
    injection: commentInjection(results),
    postedBy: postedBy(o.step),
    foot: COMMENT_FOOT,
    markdown: commentMarkdown({ results, decisions, costPerRun }),
  };
}
