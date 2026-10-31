import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { emptyCounts, Store, type DecisionCounts, type DecisionsVerify, type StoredFix, type TestFailure, type TestResultData, type VerdictStanding, type VerifyReport } from '@shadowlap/engine';
import { verifyReport } from '../../engine/test/fix-fixtures.js';
import { times, timesOf } from '../../engine/test/timing.js';
import type { GoldenSource } from '../src/tests.js';
import { sessionTitle, subjectRevisions, VERDICTS_WINDOW, verdictRevision, verdictsView, withSubjects, type PreviewVerdict, type SessionVerdict, type VerdictRevision, type VerdictsView, type VerifyVerdict } from '../src/verdicts.js';

/**
 * Changes › Verdicts as a read model: every change checked before it shipped, newest first, each
 * verdict in the words of the command that gave it. A revision a test session ran every golden at,
 * a preview, a migration, and a verify a fix keeps; the chips and their counts; a revision's page;
 * names only where checks are shared; and a store of 10,000 test sessions read a window at a time.
 */

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 20, 9, 0);
const at = (hours: number) => T0 + hours * HOUR;

const golden = (path: string, checks: string[] = []): GoldenSource => ({ path, runId: null, packedAt: T0 - 48 * HOUR, mode: 'replay', repeat: 1, passes: 1, checks });
const GOLDENS = [golden('goldens/refund-flow', ['issue_refund called 1 time']), golden('goldens/refund-in-limit'), golden('goldens/escalate-over-limit')];

type Verdict = 'passed' | 'failed' | 'inconclusive';
interface Result {
  golden: string;
  verdict: Verdict;
  failure?: TestFailure;
  reason?: string;
  runId?: string | null;
  data?: TestResultData;
}

const REPLAYED: TestResultData = { mode: 'replay', calls: { total: 8, replayed: 8, live: 0, blocked: 0, stubbed: 0 } };
const pass = (g: string, runId: string | null = null): Result => ({ golden: g, verdict: 'passed', runId, data: { ...REPLAYED, verdict: 'passed' } });
const diverged = (g: string, runId: string | null = null): Result => ({
  golden: g,
  verdict: 'failed',
  failure: 'diverged',
  reason: 'diverged at call 3 (api POST /v1/messages)',
  runId,
  data: { mode: 'replay', verdict: 'failed', divergence: { type: 'request_changed', callNo: 3, kind: 'api', name: 'POST /v1/messages', replayedBefore: 2, diff: [{ path: '$.model', op: 'changed', before: 'claude-sonnet-4-5', after: 'claude-sonnet-5-5' }], entries: 1, volatile: { values: [], explainsAll: false }, cause: '$.model', text: '✗ Diverged at call 3' } },
});
const unjudged = (g: string): Result => ({ golden: g, verdict: 'inconclusive', failure: 'inconclusive', reason: 'inconclusive: the judge check "polite" could not be judged', data: { mode: 'fork', verdict: 'inconclusive' } });

/** A test session that ran these goldens and ended, unless it was stopped or never ended. */
function session(store: Store, o: { revision: string | null; at: number; results: Result[]; actor?: string; command?: string[]; interrupted?: boolean; ended?: boolean }): string {
  const s = store.startTestSession({ command: o.command ?? ['shadowlap', 'test', 'goldens/*'], revision: o.revision, actor: o.actor ?? 'dana@example.com', startedAt: o.at, owner: null });
  o.results.forEach((r, i) => store.addTestResult({ sessionId: s.sessionId, golden: r.golden, ok: r.verdict === 'passed', ...(r.failure ? { failure: r.failure } : {}), reason: r.reason ?? null, runId: r.runId ?? null, revision: o.revision, at: o.at + i + 1, data: r.data ?? null }));
  if (o.ended !== false) store.finishTestSession(s.sessionId, { passed: o.results.filter((r) => r.verdict === 'passed').length, failed: o.results.filter((r) => r.verdict === 'failed').length, upstreamRequests: 0, endedAt: o.at + 60_000, interrupted: !!o.interrupted });
  return s.sessionId;
}

const counts = (o: Partial<DecisionCounts>): DecisionCounts => ({ ...emptyCounts(), ...o });

/** A preview or migration as `decisions` and `migrate` keep one: the report without its runs, and a row a run. */
function preview(store: Store, o: { id: string; at: number; kind?: 'decisions' | 'migrate'; change?: Record<string, unknown>; counts?: DecisionCounts; flagged?: string[]; verify?: Partial<DecisionsVerify> | null; judge?: { changed: number; inconclusive: number } | null; stopReason?: string | null; runs: Array<{ runId: string; golden?: string | null; rank?: number | null; refused?: string }>; revision?: string | null; actor?: string; from?: string[]; to?: string }): void {
  const kind = o.kind ?? 'decisions';
  const report = { change: o.change ?? { model: 'claude-haiku-4-5', fields: {}, from: null, fromCode: null, text: 'the model claude-haiku-4-5' }, counts: o.counts ?? counts({}), flagged: o.flagged ?? [], verify: o.verify ? { verdict: 'accepted', verifyIds: [], runs: [], commands: [], spent: 0, upstreamRequests: 0, reasons: [], ...o.verify } : null, judge: o.judge ? { steps: o.judge.changed + o.judge.inconclusive, spent: 0, upstreamRequests: 0, unknownModels: [], ...o.judge } : null, stopReason: o.stopReason ?? null, notes: [], warnings: [] };
  const data = kind === 'migrate' ? { kind, from: o.from ?? [], to: o.to ?? 'claude-sonnet-5-5', decisions: { ...report, runs: [] }, passes: { verdict: o.verify?.verdict ?? 'not-run', runs: [] } } : { kind, ...report };
  store.putDecisionSession({ sessionId: o.id, kind, at: o.at, change: String(report.change.text ?? ''), actor: o.actor ?? 'ravi@example.com', revision: o.revision ?? null, data, runs: o.runs.map((r) => ({ runId: r.runId, golden: r.golden === undefined ? `goldens/${r.runId.toLowerCase()}` : r.golden, rank: r.rank ?? null, changed: r.rank ? 1 : 0, data: { runId: r.runId, refused: r.refused ?? null, decisions: [] } })) });
}

let fixes = 0;
/** A fix with a verify kept for it, as verify and repair keep one: the verdict, and its link with whether it counts. */
function fixVerify(store: Store, o: { verifyId: string; at: number; report: VerifyReport; title?: string; standing?: VerdictStanding; candidate?: number | null; link?: boolean }): string {
  const fixId = `fx-01M5FIX${String(++fixes).padStart(19, '0')}`;
  const fix: StoredFix = { fixId, title: o.title ?? 'issue_refund called with amount 240', labels: [], check: { expect: null, key: 'check:exit', oracle: ['the agent exits 0'], text: 'the agent exits 0' }, status: 'open', openedAt: o.at - HOUR, verifiedAt: null, appliedAt: null, data: {} };
  store.insertFix(fix);
  store.putVerdict({ verifyId: o.verifyId, at: o.at, verdict: o.report.verdict, repairId: o.candidate ? 'repair-munzln2i' : null, candidate: o.candidate ?? null, report: o.report, expect: null, command: 'shadowlap verify --fixes 01M3RZ0001 --keeps 01M3RZ0002' });
  if (o.link !== false) store.addFixLink(fixId, 'verify', o.verifyId, o.at, o.standing ?? { counts: true, why: null });
  return fixId;
}

let store: Store;
let fixAccepted = '';

beforeAll(() => {
  store = Store.open(':memory:');
  store.createRun({ runId: '01M5REPLAYFLOW000000000000', mode: 'replay', command: { argv: ['node', 'agent.mjs'], cwd: '.' } });
  store.transaction(() => {
    // c91d0f4: every golden passed. d2e8a1f was tested twice: the newer session's verdict stands.
    session(store, { revision: 'c91d0f4', at: at(0), actor: 'ci', results: GOLDENS.map((g) => pass(g.path)) });
    session(store, { revision: 'd2e8a1f', at: at(2), results: GOLDENS.map((g) => pass(g.path)) });
    session(store, { revision: 'd2e8a1f', at: at(4), actor: 'maya@example.com', results: [diverged('goldens/refund-flow', '01M5REPLAYFLOW000000000000'), pass('goldens/refund-in-limit', '01M5GONE000000000000000000'), unjudged('goldens/escalate-over-limit')] });
    // Add normalizer and re-run: one golden, with changes on top. No change of its own.
    session(store, { revision: 'd2e8a1f+dirty', at: at(5), command: ['shadowlap', 'test', 'goldens/refund-flow'], results: [pass('goldens/refund-flow')] });
    // Stopped by a signal, and one whose process went away before it ended: neither judged every golden.
    session(store, { revision: 'e5f6a7b', at: at(6), interrupted: true, results: [pass('goldens/refund-flow')] });
    session(store, { revision: 'f00ba47', at: at(7), ended: false, results: [pass('goldens/refund-flow')] });
    // Tested with no revision: one golden left inconclusive.
    session(store, { revision: null, at: at(8), results: [pass('goldens/refund-flow'), pass('goldens/refund-in-limit'), unjudged('goldens/escalate-over-limit')] });
  });

  // Previews, each kept in a transaction of its own: one not verified yet, its two flagged runs a write's and a stop's.
  preview(store, { id: 'dc-01M5000000000000000000000A', at: at(1), revision: 'd2e8a1f', counts: counts({ 1: 1, 2: 2, 3: 1, 4: 1, 5: 2, same: 40 }), judge: { changed: 1, inconclusive: 0 }, flagged: ['01K5RUN0000000000000000001', '01K5RUN0000000000000000002'], runs: [{ runId: '01K5RUN0000000000000000001', rank: 1 }, { runId: '01K5RUN0000000000000000002', rank: 2 }, { runId: '01K5RUN0000000000000000003' }] });
  // Verified: accepted, rejected, inconclusive; and one verified on one of its two flagged runs.
  preview(store, { id: 'dc-01M5000000000000000000000B', at: at(3), flagged: ['01K5RUN0000000000000000001'], verify: { verdict: 'accepted', verifyIds: ['vf-01M5FROMPREVIEW0000000000'], runs: [{ runId: '01K5RUN0000000000000000001', role: 'good', outcome: 'kept', passes: 12, attempts: 12 }] }, counts: counts({ 1: 1 }), runs: [{ runId: '01K5RUN0000000000000000001', rank: 1 }, { runId: '01K5RUN0000000000000000004' }] });
  preview(store, { id: 'dc-01M5000000000000000000000C', at: at(9), change: { model: null, fields: { temperature: 0 }, from: null, fromCode: null, text: 'temperature=0' }, flagged: ['01K5RUN0000000000000000001', '01K5RUN0000000000000000002'], verify: { verdict: 'rejected', runs: [{ runId: '01K5RUN0000000000000000001', role: 'good', outcome: 'broken', passes: 0, attempts: 3 }, { runId: '01K5RUN0000000000000000002', role: 'good', outcome: 'kept', passes: 12, attempts: 12 }] }, counts: counts({ 1: 2 }), runs: [{ runId: '01K5RUN0000000000000000001', rank: 1 }, { runId: '01K5RUN0000000000000000002', rank: 1 }] });
  preview(store, { id: 'dc-01M5000000000000000000000D', at: at(10), flagged: ['01K5RUN0000000000000000002'], verify: { verdict: 'incomplete', runs: [{ runId: '01K5RUN0000000000000000002', role: 'target', outcome: 'inconclusive', passes: 50, attempts: 80 }] }, counts: counts({ 2: 1 }), runs: [{ runId: '01K5RUN0000000000000000002', golden: null, rank: 2 }] });
  preview(store, { id: 'dc-01M5000000000000000000000E', at: at(11), flagged: ['01K5RUN0000000000000000001', '01K5RUN0000000000000000002'], verify: { verdict: 'accepted', runs: [{ runId: '01K5RUN0000000000000000001', role: 'good', outcome: 'kept', passes: 12, attempts: 12 }] }, counts: counts({ 1: 1, 2: 1 }), runs: [{ runId: '01K5RUN0000000000000000001', rank: 1 }, { runId: '01K5RUN0000000000000000002', rank: 2 }, { runId: '01K5RUN0000000000000000003' }] });
  // Nothing flagged: the same decisions; and a changed prompt that could not ask a run.
  preview(store, { id: 'dc-01M5000000000000000000000F', at: at(12), counts: counts({ same: 30, 5: 3 }), runs: [{ runId: '01K5RUN0000000000000000001' }] });
  preview(store, { id: 'dc-01M5000000000000000000000G', at: at(13), change: { model: null, fields: {}, from: null, fromCode: { calls: 2 }, text: 'the prompt and tools in the working tree' }, counts: counts({ same: 12 }), runs: [{ runId: '01K5RUN0000000000000000001' }, { runId: '01K5RUN0000000000000000005', refused: 'its first request differs in more than its system prompt and tools ($.model changed)' }] });
  // A migration, verified.
  preview(store, { id: 'mg-01M5000000000000000000000H', at: at(14), kind: 'migrate', from: ['claude-sonnet-4-5'], to: 'claude-sonnet-5-5', change: { model: 'claude-sonnet-5-5', fields: {}, from: ['claude-sonnet-4-5'], fromCode: null, text: 'the model claude-sonnet-5-5' }, counts: counts({ 2: 1, same: 20 }), flagged: ['01K5RUN0000000000000000002'], verify: { verdict: 'accepted', runs: [{ runId: '01K5RUN0000000000000000002', role: 'good', outcome: 'kept', passes: 12, attempts: 12 }] }, runs: [{ runId: '01K5RUN0000000000000000002', rank: 2 }, { runId: '01K5RUN0000000000000000006' }] });

  store.transaction(() => {
    // A fix's verifies: accepted, rejected, inconclusive, and a repair's candidate that doesn't count for it.
    fixAccepted = fixVerify(store, { verifyId: 'vf-01M5000000000000000000000A', at: at(15), report: verifyReport([{ runId: '01M3RZ0001000000000000000A', role: 'target', pass: true }, { runId: '01M3RZ0002000000000000000A', role: 'good', pass: true }]) });
    fixVerify(store, { verifyId: 'vf-01M5000000000000000000000B', at: at(16), title: 'send_email before issue_refund', report: verifyReport([{ runId: '01M3RZ0003000000000000000A', role: 'target', pass: false }, { runId: '01M3RZ0004000000000000000A', role: 'holdout', pass: true }]) });
    const open = verifyReport([{ runId: '01M3RZ0005000000000000000A', role: 'target', pass: true }, { runId: '01M3RZ0006000000000000000A', role: 'good', pass: true }]);
    fixVerify(store, { verifyId: 'vf-01M5000000000000000000000C', at: at(17), report: { ...open, verdict: 'incomplete', runs: [open.runs[0], { ...open.runs[1], verdict: 'open', decision: 'inconclusive' }] } });
    fixVerify(store, { verifyId: 'vf-01M5000000000000000000000D', at: at(18), candidate: 3, standing: { counts: false, why: 'another-check', missing: ['send_email called 0 times'] }, report: verifyReport([{ runId: '01M3RZ0007000000000000000A', role: 'target', pass: true }]) });
    // The verify the accepted preview ran, which a fix keeps too: the preview's verdict, no row of its own. And a verify no fix keeps.
    fixVerify(store, { verifyId: 'vf-01M5FROMPREVIEW0000000000', at: at(3.5), report: verifyReport([{ runId: '01K5RUN0000000000000000001', role: 'target', pass: true }]) });
    fixVerify(store, { verifyId: 'vf-01M5NOFIX000000000000000', at: at(19), link: false, report: verifyReport([{ runId: '01M3RZ0008000000000000000A', role: 'target', pass: true }]) });
  });
});

afterAll(() => store?.close());

const row = <T>(rows: readonly { id: string }[], id: string) => rows.find((r) => r.id === id) as T;

describe('every change checked', () => {
  it('lists each change once, newest first: revisions, previews, migrations and the verifies fixes keep', () => {
    const view = verdictsView(store, GOLDENS);
    expect(view.rows.map((r) => [r.kind, r.id])).toEqual([
      ['verify', 'vf-01M5000000000000000000000D'],
      ['verify', 'vf-01M5000000000000000000000C'],
      ['verify', 'vf-01M5000000000000000000000B'],
      ['verify', 'vf-01M5000000000000000000000A'],
      ['migration', 'mg-01M5000000000000000000000H'],
      ['preview', 'dc-01M5000000000000000000000G'],
      ['preview', 'dc-01M5000000000000000000000F'],
      ['preview', 'dc-01M5000000000000000000000E'],
      ['preview', 'dc-01M5000000000000000000000D'],
      ['preview', 'dc-01M5000000000000000000000C'],
      ['session', 'no-revision'],
      ['session', 'd2e8a1f'],
      ['preview', 'dc-01M5000000000000000000000B'],
      ['preview', 'dc-01M5000000000000000000000A'],
      ['session', 'c91d0f4'],
    ]);
    expect(view.counts).toEqual({ all: 15, sessions: 3, previews: 8, verifies: 4 });
    expect(view.more).toBe(false);
  });

  it('gives a revision the newest session that ran every golden there, its verdict and tally in the test command’s words', () => {
    const view = verdictsView(store, GOLDENS);
    expect(row<SessionVerdict>(view.rows, 'd2e8a1f')).toMatchObject({ title: 'Commit d2e8a1f', checked: '3 goldens', moved: ['1 golden failed', '1 inconclusive'], word: 'failed', tone: 'no', line: '1 passed, 1 failed, 1 inconclusive', revision: 'd2e8a1f', key: 'd2e8a1f', command: 'shadowlap test goldens/*', goldens: 3, passed: 1, failed: 1, inconclusive: 1 });
    expect(row<SessionVerdict>(view.rows, 'c91d0f4')).toMatchObject({ moved: ['every golden held'], word: 'passed', tone: 'ok', line: '3 passed, 0 failed' });
    expect(row<SessionVerdict>(view.rows, 'no-revision')).toMatchObject({ title: 'Tested with no revision', revision: null, moved: ['1 inconclusive'], word: 'inconclusive', tone: 'y', line: '2 passed, 0 failed, 1 inconclusive' });
    // The newest revision's verdict leads the page.
    expect(view.lead).toMatchObject({ id: 'no-revision', word: 'inconclusive' });
    expect(verdictsView(store, GOLDENS, { kind: 'verifies' }).lead).toMatchObject({ id: 'no-revision' });
  });

  it('says a preview is not verified until verify settled the runs it flags, then gives verify’s verdict', () => {
    const rows = verdictsView(store, GOLDENS).rows;
    expect(row<PreviewVerdict>(rows, 'dc-01M5000000000000000000000A')).toMatchObject({ title: 'Model switch to claude-haiku-4-5', checked: '3 goldens', moved: ['1 write changed', '1 stop or hand-over changed', '1 judged otherwise', '2 reads changed'], word: 'not verified', tone: 'y', line: '2 of 3 goldens to verify', runs: 3, flagged: 2, flaggedRank: 1, toVerify: 2, revision: 'd2e8a1f' });
    expect(row<PreviewVerdict>(rows, 'dc-01M5000000000000000000000B')).toMatchObject({ word: 'accepted', tone: 'ok', line: 'The change keeps 1 of 1 good run', toVerify: 0 });
    expect(row<PreviewVerdict>(rows, 'dc-01M5000000000000000000000C')).toMatchObject({ title: 'Field change to temperature=0', word: 'rejected', tone: 'no', line: 'The change keeps 1 of 2 good runs', moved: ['2 writes changed'] });
    expect(row<PreviewVerdict>(rows, 'dc-01M5000000000000000000000D')).toMatchObject({ checked: '1 run', word: 'inconclusive', tone: 'y', line: 'The change fixes 0 of 1 target run (1 inconclusive)', flaggedRank: 2 });
    // Verified on one of the two runs it flags: not yet a verdict on the change.
    expect(row<PreviewVerdict>(rows, 'dc-01M5000000000000000000000E')).toMatchObject({ word: 'not verified', line: '1 of 3 goldens to verify', toVerify: 1 });
  });

  it('says what a preview that flags no run found, in its own headline, and when it settled nothing', () => {
    const rows = verdictsView(store, GOLDENS).rows;
    expect(row<PreviewVerdict>(rows, 'dc-01M5000000000000000000000F')).toMatchObject({ word: 'nothing to verify', tone: null, line: 'No write and no stop changes: 3 decisions differ in reads or text', moved: [], flagged: 0, flaggedRank: null });
    expect(row<PreviewVerdict>(rows, 'dc-01M5000000000000000000000G')).toMatchObject({ title: 'Changed prompt and tools', word: 'not verified', tone: 'y', line: '1 of 2 runs could not be asked' });
  });

  it('names a migration by its switch and gives verify’s verdict on it', () => {
    expect(row<PreviewVerdict>(verdictsView(store, GOLDENS).rows, 'mg-01M5000000000000000000000H')).toMatchObject({ kind: 'migration', title: 'claude-sonnet-4-5 → claude-sonnet-5-5', checked: '2 goldens', moved: ['1 stop or hand-over changed'], word: 'accepted', line: 'The change keeps 1 of 1 good run' });
  });

  it('gives a fix’s verify in verify’s words, titled by its fix, and leaves out the verify a preview ran', () => {
    const rows = verdictsView(store, GOLDENS).rows;
    expect(row<VerifyVerdict>(rows, 'vf-01M5000000000000000000000A')).toMatchObject({ fixId: fixAccepted, title: 'issue_refund called with amount 240', checked: '2 runs', moved: ['1 fixed', '1 kept'], word: 'accepted', tone: 'ok', line: 'The change fixes 1 of 1 target run and keeps 1 of 1 good run', code: '370712a+dirty', verdict: 'accepted', counts: true, by: null });
    expect(row<VerifyVerdict>(rows, 'vf-01M5000000000000000000000B')).toMatchObject({ title: 'send_email before issue_refund', moved: ['1 not fixed', '1 fixed'], word: 'rejected', tone: 'no', line: 'The change fixes 0 of 1 target run and 1 of 1 held-out run' });
    // verify's incomplete is inconclusive, as every verdict that settled nothing reads.
    expect(row<VerifyVerdict>(rows, 'vf-01M5000000000000000000000C')).toMatchObject({ moved: ['1 fixed', '1 inconclusive'], word: 'inconclusive', tone: 'y', verdict: 'incomplete', line: 'The change fixes 1 of 1 target run and keeps 0 of 1 good run (1 inconclusive)' });
    expect(row<VerifyVerdict>(rows, 'vf-01M5000000000000000000000D')).toMatchObject({ code: 'repair candidate 3', counts: false });
    expect(rows.map((r) => r.id)).not.toContain('vf-01M5FROMPREVIEW0000000000');
    expect(rows.map((r) => r.id)).not.toContain('vf-01M5NOFIX000000000000000');
  });

  it('filters by chip, newest first, to the limit, and says when there are more', () => {
    expect(verdictsView(store, GOLDENS, { kind: 'sessions' }).rows.map((r) => r.id)).toEqual(['no-revision', 'd2e8a1f', 'c91d0f4']);
    const previews = verdictsView(store, GOLDENS, { kind: 'previews', limit: 3 });
    expect(previews.rows.map((r) => r.id)).toEqual(['mg-01M5000000000000000000000H', 'dc-01M5000000000000000000000G', 'dc-01M5000000000000000000000F']);
    expect(previews.more).toBe(true);
    // The counts are the window's, whatever is shown.
    expect(previews.counts).toEqual({ all: 15, sessions: 3, previews: 8, verifies: 4 });
    expect(verdictsView(store, GOLDENS, { kind: 'verifies' }).rows.every((r) => r.kind === 'verify')).toBe(true);
  });

  it('names who checked a change only where checks are shared', () => {
    const alone = verdictsView(store, GOLDENS).rows;
    expect(alone.map((r) => r.by)).toEqual(alone.map(() => null));
    const team = verdictsView(store, GOLDENS, { shared: true }).rows;
    expect(row<SessionVerdict>(team, 'd2e8a1f').by).toBe('maya@example.com');
    expect(row<PreviewVerdict>(team, 'dc-01M5000000000000000000000A').by).toBe('ravi@example.com');
    // A verify keeps no one's name.
    expect(row<VerifyVerdict>(team, 'vf-01M5000000000000000000000A').by).toBeNull();
  });

  it('titles a revision by its commit’s subject where git has it', () => {
    const view = verdictsView(store, GOLDENS);
    expect(subjectRevisions(view)).toEqual(['d2e8a1f', 'c91d0f4']);
    const named = withSubjects(view, new Map([['d2e8a1f', 'Tighten refund wording']]));
    expect(row<SessionVerdict>(named.rows, 'd2e8a1f')).toMatchObject({ title: 'Tighten refund wording', subject: 'Tighten refund wording' });
    expect(row<SessionVerdict>(named.rows, 'c91d0f4')).toMatchObject({ title: 'Commit c91d0f4', subject: null });
    expect([sessionTitle('d2e8a1f+dirty', 'Tighten refund wording'), sessionTitle('d2e8a1f+dirty', null), sessionTitle(null, null)]).toEqual(['Tighten refund wording, with uncommitted changes', 'Uncommitted changes on d2e8a1f', 'Tested with no revision']);
  });
});

describe('a revision’s page', () => {
  it('gives its goldens as that session judged them, worst first with notes, and the previews asked at it', () => {
    const page = verdictRevision(store, GOLDENS, 'd2e8a1f')!;
    expect(page.row).toMatchObject({ key: 'd2e8a1f', word: 'failed' });
    expect(page.goldens).toEqual([
      { golden: 'goldens/refund-flow', name: 'refund-flow', verdict: 'failed', note: 'diverged at call 3 · $.model', runId: '01M5REPLAYFLOW000000000000' },
      { golden: 'goldens/escalate-over-limit', name: 'escalate-over-limit', verdict: 'inconclusive', note: 'inconclusive: the judge check "polite" could not be judged', runId: null },
      // Its replay is no longer in the store: nothing to open.
      { golden: 'goldens/refund-in-limit', name: 'refund-in-limit', verdict: 'passed', note: '8/8 replayed', runId: null },
    ]);
    expect(page.lead).toMatchObject({ golden: 'goldens/refund-flow' });
    expect(page.decisions.map((d) => [d.id, d.word])).toEqual([['dc-01M5000000000000000000000A', 'not verified']]);
    expect(withSubjects(page, new Map([['d2e8a1f', 'Tighten refund wording']])).row.title).toBe('Tighten refund wording');
  });

  it('opens with no revision too, leads with nothing when every golden passed, and is null for a change no session checked', () => {
    expect(verdictRevision(store, GOLDENS, 'no-revision')).toMatchObject({ row: { title: 'Tested with no revision' }, lead: { golden: 'goldens/escalate-over-limit' }, decisions: [] });
    expect(verdictRevision(store, GOLDENS, 'c91d0f4')).toMatchObject({ lead: null });
    for (const key of ['d2e8a1f+dirty', 'e5f6a7b', 'f00ba47', '0000000', '../etc', '']) expect(verdictRevision(store, GOLDENS, key), key).toBeNull();
  });
});

describe('verdicts at scale', () => {
  const SESSIONS = 10_000;
  const PREVIEWS = 1_000;
  const VERIFIES = 1_000;
  let big: Store;
  const goldens = Array.from({ length: 5 }, (_, i) => golden(`goldens/g${i}`));

  beforeAll(() => {
    big = Store.open(':memory:');
    big.transaction(() => {
      for (let i = 0; i < SESSIONS; i++) session(big, { revision: (0x1000000 + i).toString(16), at: at(i), results: goldens.map((g, k) => (k === i % 7 ? diverged(g.path) : pass(g.path))) });
    });
    for (let i = 0; i < PREVIEWS; i++) preview(big, { id: `dc-01M6${String(i).padStart(22, '0')}`, at: at(i * 10 + 5), flagged: ['01K5RUN0000000000000000001'], counts: counts({ 1: 1, same: 30 }), runs: [{ runId: '01K5RUN0000000000000000001', rank: 1 }, { runId: '01K5RUN0000000000000000002' }] });
    big.transaction(() => {
      for (let i = 0; i < VERIFIES; i++) fixVerify(big, { verifyId: `vf-01M6${String(i).padStart(22, '0')}`, at: at(i * 10 + 7), report: verifyReport([{ runId: '01M3RZ0001000000000000000A', role: 'target', pass: i % 2 === 0 }, { runId: '01M3RZ0002000000000000000A', role: 'good', pass: true }]) });
    });
  }, 120_000);

  afterAll(() => big?.close());

  it('reads a window of the newest sessions, previews and verifies, however many the store keeps', () => {
    // What the read takes from the store, row by row.
    let rows = 0;
    const spies = [
      vi.spyOn(big, 'listTestSessions').mockImplementation(function (this: Store, o) {
        const out = Store.prototype.listTestSessions.call(this, o);
        rows += out.length;
        return out;
      }),
      vi.spyOn(big, 'testSessionGoldens').mockImplementation(function (this: Store, ids) {
        const out = Store.prototype.testSessionGoldens.call(this, ids);
        for (const set of out.values()) rows += set.size;
        return out;
      }),
      vi.spyOn(big, 'listTestResults').mockImplementation(function (this: Store, o) {
        const out = Store.prototype.listTestResults.call(this, o);
        rows += out.length;
        return out;
      }),
      vi.spyOn(big, 'query').mockImplementation(function (this: Store, sql, ...params) {
        const out = Store.prototype.query.call(this, sql, ...params);
        rows += out.length;
        return out;
      }),
    ];
    let view: VerdictsView;
    let page: VerdictRevision | null;
    try {
      view = verdictsView(big, goldens, { limit: 200 });
      page = verdictRevision(big, goldens, view.lead!.key);
    } finally {
      for (const s of spies) s.mockRestore();
    }
    expect(view.rows).toHaveLength(200);
    expect(view.counts).toEqual({ all: 3 * VERDICTS_WINDOW, sessions: VERDICTS_WINDOW, previews: VERDICTS_WINDOW, verifies: VERDICTS_WINDOW });
    expect(view.more).toBe(true);
    expect(view.lead).toMatchObject({ key: (0x1000000 + SESSIONS - 1).toString(16), word: 'failed', line: '4 passed, 1 failed' });
    expect(page?.goldens).toHaveLength(5);
    // The store holds 50,000 results, 10,000 sessions, 1,000 previews and 1,000 verifies: the list and
    // a page read a few thousand rows between them, the window's.
    expect(rows, `the list and a page read ${rows} rows`).toBeLessThan(5_000);

    // Held against this machine, not a number of milliseconds: a twentieth to a thirtieth of one plain
    // read of every result here; under one such read, whatever the machine.
    const t = timesOf({
      list: () => verdictsView(big, goldens),
      page: () => verdictRevision(big, goldens, view.lead!.key),
      every: () => big.query('SELECT * FROM test_results'),
    });
    console.log(`verdicts over ${SESSIONS} test sessions, ${PREVIEWS} previews and ${VERIFIES} verifies: ${rows} rows read; the list ${t.list.toFixed(1)} ms CPU, a revision's page ${t.page.toFixed(1)} ms; a read of every result ${t.every.toFixed(1)} ms`);
    expect(t.list, `the list took ${times(t.list, t.every)} a read of every result`).toBeLessThan(t.every);
    expect(t.page, `a page took ${times(t.page, t.every)} a read of every result`).toBeLessThan(t.every);
  }, 120_000);
});
