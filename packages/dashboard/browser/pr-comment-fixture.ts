import type { Page, Route } from '@playwright/test';
import { JUDGED_IN_RECORDED_STATE_SHORT, PR_DECISIONS_SUFFIX } from '@shadowlap/engine';
import type { KeptDecisions, KeptInjection, PrCommentPreview, SessionCommentParts, SessionVerdict, VerdictFlag, VerdictRevision, VerdictRow, VerdictsView } from '../ui/types.js';
import { RESET_RETRY } from './dashboard.js';

/** A session's pull request, merged: the flag a page draws when its verdict didn't pass. */
const merged = (n: number) => ({ number: n, url: `https://github.com/example/agent/pull/${n}`, state: 'merged' as const });
const flagOf = (word: string): VerdictFlag | null => (word === 'failed' ? 'merged while failing' : word === 'inconclusive' ? 'merged while inconclusive' : null);

/** A session that ran for a pull request that merged, the newest #142, flagged where it didn't pass. */
const withPullRequest = (s: SessionVerdict, i: number): SessionVerdict => ({ ...s, pullRequest: merged(142 - i), flag: flagOf(s.word) });

/** Verdicts' rows, each session's with its pull request, newest first. */
function rowsWithPullRequests(rows: readonly VerdictRow[]): VerdictRow[] {
  const sessions = rows.filter((r) => r.kind === 'session');
  return rows.map((r) => (r.kind === 'session' ? withPullRequest(r, sessions.indexOf(r)) : r));
}

/**
 * What a session's comment carried, over the goldens it names: the decisions at rank 1 and 2 of the
 * first, with a call long enough to be cut; a run's cost before and after; an injection gate that
 * failed, one that passed and one that ran no attempt.
 */
function commentParts(goldens: readonly string[]): SessionCommentParts {
  const [first = 'goldens/refund-over-limit', second = first, third = second] = goldens;
  const sentence = `1 of ${goldens.length} goldens decides a write or when to stop differently`;
  const decisions: KeptDecisions = {
    sessionId: 'dc-01M5SWEEP0000000000000000',
    mark: '✗',
    sentence,
    headline: `${sentence}${PR_DECISIONS_SUFFIX}`,
    rows: [
      { rank: 1, golden: first, callNo: 11, detail: 'add_note is no longer called; issue_refund is called', recorded: `add_note({"order":"ord-1042","text":"${'over the limit, '.repeat(6)}"})`, now: 'issue_refund({"order":"ord-1042","amount":240})' },
      { rank: 2, golden: first, callNo: 12, detail: 'ends the run', recorded: 'escalate({"to":"tier-2"})', now: 'text: Refunded.' },
    ],
    note: JUDGED_IN_RECORDED_STATE_SHORT,
  };
  const tally = (obeyed: number, allowed: number) => `6 attempts · ${obeyed} obeyed (at most ${allowed} allowed) · 0 influenced · ${6 - obeyed} ignored`;
  const injection: KeptInjection[] = [
    { verdict: 'failed', golden: first, resultId: null, line: `failed · ${tally(2, 0)}`, tally: tally(2, 0) },
    { verdict: 'inconclusive', golden: third, resultId: null, line: 'inconclusive', tally: null },
    { verdict: 'passed', golden: second, resultId: null, line: `passed · ${tally(0, 0)}`, tally: tally(0, 0) },
  ];
  return { decisions, cost: { before: 0.041, after: 0.043, line: '≈$0.041 → ≈$0.043 (+5%)', amounts: '≈$0.041 → ≈$0.043', change: '+5%' }, injection };
}

/** The page's own answer, changed: asked in full, since an answer the page holds already (304) has no body to change. */
const changed = <T>(change: (real: T) => T) => async (route: Route) => {
  const headers = Object.fromEntries(Object.entries(route.request().headers()).filter(([k]) => k !== 'if-none-match' && k !== 'if-modified-since'));
  const res = await route.fetch({ headers, ...RESET_RETRY });
  if (res.status() !== 200) return route.fulfill({ response: res });
  await route.fulfill({ response: res, json: change((await res.json()) as T) });
};

/**
 * The pull request comment as the demo store can't give it, for the sweeps: the demo's sessions run
 * for no pull request and keep no comment parts (scripts/demo-store.mjs), so the preview gains the
 * decisions, a run's cost and three injection gates, and every session on Verdicts and its revision's
 * page a merged pull request, with the flag where it didn't pass and what its comment carried.
 */
export async function routePrCommentFixture(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/ci/comment',
    changed<PrCommentPreview | { session: null }>((real) => {
      if (!real.session) throw new Error('the demo store has no test session that ran every golden');
      return { ...real, ...commentParts(real.rows.map((r) => r.golden)) };
    }),
  );
  await page.route((url) => url.pathname === '/api/verdicts', changed<VerdictsView>((real) => ({ ...real, lead: real.lead && withPullRequest(real.lead, 0), rows: rowsWithPullRequests(real.rows) })));
  await page.route(
    (url) => url.pathname.startsWith('/api/verdicts/'),
    changed<VerdictRevision>((real) => ({ ...real, row: withPullRequest(real.row, 0), comment: commentParts(real.goldens.map((g) => g.golden)) })),
  );
}
