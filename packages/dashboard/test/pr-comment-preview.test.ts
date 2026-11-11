import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commentMarkdown, emptyCounts, Store, type InjectionGateData, type TestResultData } from '@shadowlap/engine';
import { startDashboard, type CiWorkflowsView, type Dashboard, type GoldenSource } from '../src/index.js';
import { postedBy, prCommentPreview, type PrCommentPreview } from '../src/pr-comment-preview.js';
import { inSessionOrder, keptDecisions, storedCommentResult } from '../src/session-comment.js';

/**
 * Settings → CI's preview of the pull request comment: the newest session that ran every golden and
 * wasn't interrupted, as it left it, in the engine's words and Markdown; who posts it, as the step
 * gives the action its token; the line under Your workflow naming the same session; and the route
 * behind the session token.
 */

const T0 = Date.UTC(2026, 9, 20, 9, 0);
const HOUR = 3_600_000;
const golden = (path: string): GoldenSource => ({ path, runId: null, packedAt: T0 - 48 * HOUR, mode: 'replay', repeat: 1, passes: 1, checks: [] });
const GOLDENS = [golden('goldens/refund-flow'), golden('goldens/refund-in-limit'), golden('goldens/escalate-over-limit')];
const PASSED: TestResultData = { mode: 'replay', verdict: 'passed', calls: { total: 8, replayed: 8, live: 0, blocked: 0, stubbed: 0 } };
const GATE: InjectionGateData = { resultId: 'ij-escalate', attempts: 6, obeyed: 0, influenced: 0, ignored: 6, inconclusive: 0, allowed: { obeyed: 0, influenced: null }, verdict: 'passed', reason: null, skipped: null };

/** A session that ran these goldens and ended: `failing` exited non-zero, and escalate-over-limit's injection gate passed. */
function session(store: Store, o: { revision: string | null; at: number; goldens?: string[]; failing?: string; interrupted?: boolean }): string {
  const ran = o.goldens ?? GOLDENS.map((g) => g.path);
  const s = store.startTestSession({ command: ['shadowlap', 'test', ...(o.goldens ?? ['goldens/*'])], revision: o.revision, actor: 'ci', startedAt: o.at, owner: null });
  ran.forEach((g, i) => {
    const failed = g === o.failing;
    const data: TestResultData = failed ? { mode: 'replay', verdict: 'failed' } : { ...PASSED, ...(g === 'goldens/escalate-over-limit' ? { injection: GATE } : {}) };
    store.addTestResult({ sessionId: s.sessionId, golden: g, ok: !failed, ...(failed ? { failure: 'exit' as const } : {}), reason: failed ? 'the agent exited with code 1' : null, runId: null, revision: o.revision, at: o.at + i + 1, data });
  });
  store.finishTestSession(s.sessionId, { passed: ran.filter((g) => g !== o.failing).length, failed: o.failing ? 1 : 0, upstreamRequests: 0, endedAt: o.at + 60_000, interrupted: !!o.interrupted });
  return s.sessionId;
}

const shown = (p: PrCommentPreview | { session: null }): PrCommentPreview => {
  expect(p.session).not.toBeNull();
  return p as PrCommentPreview;
};

describe('the pull request comment’s preview', () => {
  let store: Store;
  let full = '';
  beforeAll(() => {
    store = Store.open(':memory:');
    full = session(store, { revision: 'd2e8a1f+dirty', at: T0, failing: 'goldens/refund-flow' });
    // Since: a golden replayed on its own, a session a signal stopped, and one that never ended.
    session(store, { revision: 'e5f6a7b', at: T0 + HOUR, goldens: ['goldens/refund-flow'] });
    session(store, { revision: 'e5f6a7b', at: T0 + 2 * HOUR, interrupted: true });
    store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'f00ba47', actor: 'ci', startedAt: T0 + 3 * HOUR, owner: null });
  });
  afterAll(() => store?.close());

  it('waits for a session that ran every golden and ended', () => {
    const empty = Store.open(':memory:');
    try {
      expect(prCommentPreview(empty, GOLDENS, { step: null })).toEqual({ session: null });
      session(empty, { revision: 'a1a1a1a', at: T0, interrupted: true });
      empty.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'b2b2b2b', actor: 'ci', startedAt: T0 + HOUR, owner: null });
      expect(prCommentPreview(empty, GOLDENS, { step: null })).toEqual({ session: null });
    } finally {
      empty.close();
    }
  });

  it('is the newest session that ran every golden as it left it, its revision as it is, whatever ran on its own since', () => {
    const p = shown(prCommentPreview(store, GOLDENS, { step: null }));
    expect(p.session).toEqual({ id: full, revision: 'd2e8a1f+dirty', at: T0 + 60_000 });
    expect(p.head).toBe('2 of 3 goldens passed · 1 failed');
    expect(p.rows.map((r) => [r.verdict, r.golden])).toEqual([
      ['failed', 'goldens/refund-flow'],
      ['passed', 'goldens/refund-in-limit'],
      ['passed', 'goldens/escalate-over-limit'],
    ]);
    // The injection lines come from the results; no decisions or cost were kept.
    expect(p.injection).toEqual([{ verdict: 'passed', golden: 'goldens/escalate-over-limit', resultId: 'ij-escalate', line: 'passed · 6 attempts · 0 obeyed (at most 0 allowed) · 0 influenced · 6 ignored', tally: '6 attempts · 0 obeyed (at most 0 allowed) · 0 influenced · 6 ignored' }]);
    expect([p.decisions, p.cost, p.postedBy]).toEqual([null, null, 'github-actions']);
    expect(p.markdown).toContain('#### Injection');
    expect(p.markdown).not.toContain('#### Decisions');
    // The comment's last line in the engine's words, as text: the job's page it links to is the job's own, so the Markdown has none.
    expect(p.foot).toBe("The job's summary has each failure in full.");
    expect(p.markdown).not.toContain("The job's summary");
  });

  it('carries the decisions and the cost once the session keeps them, its Markdown the engine’s with no marker, base, fixes or job address', () => {
    store.putDecisionSession({
      sessionId: 'dc-01M5PREVIEW00000000000000',
      kind: 'decisions',
      at: T0 + 30_000,
      change: 'the prompt and tools in the working tree',
      actor: 'ci',
      revision: 'd2e8a1f+dirty',
      data: { kind: 'decisions', counts: { ...emptyCounts(), same: 12 }, flagged: [] },
      runs: [{ runId: '01K5RUNPREVIEW000000000001', golden: 'goldens/refund-flow', rank: null, changed: 0, data: { runId: '01K5RUNPREVIEW000000000001', refused: null, decisions: [] } }],
    });
    store.setTestSessionComment(full, { decisions: 'dc-01M5PREVIEW00000000000000' });
    store.setTestSessionComment(full, { costPerRun: { before: 0.041, after: 0.043 } });
    const p = shown(prCommentPreview(store, GOLDENS, { step: null }));
    expect(p.decisions).toMatchObject({ sessionId: 'dc-01M5PREVIEW00000000000000', mark: '✓', rows: [], note: null });
    expect(p.decisions!.headline).toBe(`${p.decisions!.sentence}, under the prompt and tools this pull request sends`);
    expect(p.cost).toMatchObject({ line: '≈$0.041 → ≈$0.043 (+5%)' });
    const results = inSessionOrder(store.listTestResults({ sessionId: full, limit: 100 })).map(storedCommentResult);
    expect(p.markdown).toBe(commentMarkdown({ results, decisions: keptDecisions(store, 'dc-01M5PREVIEW00000000000000'), costPerRun: { before: 0.041, after: 0.043 } }));
    expect(p.markdown).toContain('Cost per run: ≈$0.041 → ≈$0.043 (+5%)');
    for (const part of ['<!--', 'Compared with', 'Fix on failure', "The job's summary"]) expect(p.markdown).not.toContain(part);
  });

  it('is posted as github-actions unless the step gives the action a token of its own, which it takes in the action’s order', () => {
    const step = (inputs: Record<string, string>, envValues: Record<string, string> = {}) => ({ inputs, envValues });
    expect(postedBy(null)).toBe('github-actions');
    expect(postedBy(step({}))).toBe('github-actions');
    expect(postedBy(step({ 'github-token': '${{ secrets.GITHUB_TOKEN }}' }, { GH_TOKEN: '${{ github.token }}' }))).toBe('github-actions');
    expect(postedBy(step({ 'github-token': '${{ secrets.BOT_TOKEN }}' }, { GH_TOKEN: '${{ secrets.OTHER }}' }))).toBe('the account github-token belongs to');
    expect(postedBy(step({ 'github-token': '${{ github.token }}' }, { GH_TOKEN: '${{ secrets.BOT_TOKEN }}' }))).toBe('the account GH_TOKEN belongs to');
    expect(postedBy(step({}, { GITHUB_TOKEN: '${{ secrets.BOT_TOKEN }}' }))).toBe('the account GITHUB_TOKEN belongs to');
    // GH_TOKEN goes first, as the action reads it, even when it is the job's own.
    expect(postedBy(step({}, { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}', GITHUB_TOKEN: '${{ secrets.BOT_TOKEN }}' }))).toBe('github-actions');
  });
});

describe('GET /api/ci/comment', () => {
  let store: Store;
  let dash: Dashboard;
  const api = (path: string, token: string | null = dash.token) => fetch(`${dash.url}/api/${path}`, { headers: token ? { 'x-shadowlap-token': token } : {} });
  beforeAll(async () => {
    store = Store.open(':memory:');
    session(store, { revision: 'd2e8a1f', at: T0, failing: 'goldens/refund-flow' });
    session(store, { revision: 'e5f6a7b', at: T0 + HOUR, goldens: ['goldens/refund-flow'] });
    dash = await startDashboard({ store, spawnCli: () => spawn(process.execPath, ['-e', ''], { stdio: ['ignore', 'pipe', 'pipe'] }), goldens: () => GOLDENS });
  });
  afterAll(async () => {
    await dash?.close();
    store?.close();
  });

  it('answers the preview only with the session token, and the line under Your workflow names the same session', async () => {
    expect((await api('ci/comment', null)).status).toBe(401);
    const res = await api('ci/comment');
    expect(res.status).toBe(200);
    const p = (await res.json()) as PrCommentPreview;
    expect(p.session).toMatchObject({ revision: 'd2e8a1f' });
    expect(p.head).toBe('2 of 3 goldens passed · 1 failed');
    // Without a CI report, Settings → CI's line names the session the preview reads, not the golden replayed on its own since.
    const view = (await (await api('ci/workflows')).json()) as CiWorkflowsView;
    expect(view.workflow.session).toMatchObject({ ci: false, revision: 'd2e8a1f', text: '2 of 3 goldens passed · 1 failed' });
  });
});
