import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { emptyCounts, NO_TOKENS, Store, type DecisionCounts, type DecisionRun, type DecisionStep, type DecisionsVerify, type StoredFix, type TestFailure, type TestResultData, type VerdictStanding, type VerifyReport } from '@shadowlap/engine';
import { verifyReport } from '../../engine/test/fix-fixtures.js';
import { times, timesOf } from '../../engine/test/timing.js';
import type { GoldenSource } from '../src/tests.js';
import { commitsWanted, sessionTitle, VERDICTS_WINDOW, verdictRevision, verdictsLimit, verdictsView, withCommits, type PreviewVerdict, type SessionVerdict, type VerdictRevision, type VerdictsView, type VerifyVerdict } from '../src/verdicts.js';

/**
 * Changes › Verdicts as a read model: every change checked before it shipped, newest first, each
 * verdict as the command that gave it gives it. A revision a test session ran every golden at, a
 * preview, a migration, and a verify a fix keeps; a preview or a migration that settles nothing; the
 * chips and their counts; a revision's page; names only where checks are shared; and a store of
 * 10,000 test sessions, or of sessions of 100 goldens, read a window at a time.
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
function preview(store: Store, o: { id: string; at: number; kind?: 'decisions' | 'migrate'; change?: Record<string, unknown>; counts?: DecisionCounts; flagged?: string[]; verify?: Partial<DecisionsVerify> | null; judge?: { changed: number; inconclusive: number } | null; stopReason?: string | null; runs: Array<{ runId: string; golden?: string | null; rank?: number | null; refused?: string }>; revision?: string | null; actor?: string; from?: string[]; to?: string; passes?: Array<{ verdict: string; verified: boolean }> }): void {
  const kind = o.kind ?? 'decisions';
  const report = { change: o.change ?? { model: 'claude-haiku-4-5', fields: {}, from: null, fromCode: null, text: 'the model claude-haiku-4-5' }, counts: o.counts ?? counts({}), flagged: o.flagged ?? [], verify: o.verify ? { verdict: 'accepted', verifyIds: [], runs: [], commands: [], spent: 0, upstreamRequests: 0, reasons: [], ...o.verify } : null, judge: o.judge ? { steps: o.judge.changed + o.judge.inconclusive, spent: 0, upstreamRequests: 0, unknownModels: [], ...o.judge } : null, stopReason: o.stopReason ?? null, notes: [], warnings: [] };
  // A migration keeps its What still passes beside the decision diff: verify's verdict, and how each run fares.
  const passes = { verdict: o.verify?.verdict ?? 'not-run', runs: (o.passes ?? []).map((x, i) => ({ runId: o.runs[i]?.runId ?? `01K5RUN${i}`, golden: null, outcome: x.verified ? 'kept' : 'unchanged', tally: null, ...x })) };
  const data = kind === 'migrate' ? { kind, from: o.from ?? [], to: o.to ?? 'claude-sonnet-5-5', decisions: { ...report, runs: [] }, passes, stopReason: report.stopReason } : { kind, ...report };
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
  preview(store, { id: 'mg-01M5000000000000000000000H', at: at(14), kind: 'migrate', from: ['claude-sonnet-4-5'], to: 'claude-sonnet-5-5', change: { model: 'claude-sonnet-5-5', fields: {}, from: ['claude-sonnet-4-5'], fromCode: null, text: 'the model claude-sonnet-5-5' }, counts: counts({ 2: 1, same: 20 }), flagged: ['01K5RUN0000000000000000002'], verify: { verdict: 'accepted', runs: [{ runId: '01K5RUN0000000000000000002', role: 'good', outcome: 'kept', passes: 12, attempts: 12 }] }, runs: [{ runId: '01K5RUN0000000000000000002', rank: 2 }, { runId: '01K5RUN0000000000000000006' }], passes: [{ verdict: 'passed', verified: true }, { verdict: 'passed', verified: false }] });

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

  it('gives a revision the newest session that ran every golden there, its verdict in the test command’s word and its tally counting what passed', () => {
    const view = verdictsView(store, GOLDENS);
    expect(row<SessionVerdict>(view.rows, 'd2e8a1f')).toMatchObject({ title: 'Commit d2e8a1f', checked: '3 goldens', moved: ['1 golden failed', '1 inconclusive'], word: 'failed', tone: 'no', line: '1 of 3 goldens passed', revision: 'd2e8a1f', key: 'd2e8a1f', command: 'shadowlap test goldens/*', goldens: 3, passed: 1, failed: 1, inconclusive: 1 });
    expect(row<SessionVerdict>(view.rows, 'c91d0f4')).toMatchObject({ moved: ['every golden held'], word: 'passed', tone: 'ok', line: '3 of 3 goldens passed' });
    expect(row<SessionVerdict>(view.rows, 'no-revision')).toMatchObject({ title: 'Tested with no revision', revision: null, moved: ['1 inconclusive'], word: 'inconclusive', tone: 'y', line: '2 of 3 goldens passed' });
    // The newest revision's verdict leads the page.
    expect(view.lead).toMatchObject({ id: 'no-revision', word: 'inconclusive', line: '2 of 3 goldens passed' });
    expect(verdictsView(store, GOLDENS, { kind: 'verifies' }).lead).toMatchObject({ id: 'no-revision' });
  });

  it('says a preview is not verified until verify took the runs it flags, then gives verify’s verdict in its head’s words', () => {
    const rows = verdictsView(store, GOLDENS).rows;
    expect(row<PreviewVerdict>(rows, 'dc-01M5000000000000000000000A')).toMatchObject({ title: 'Model switch to claude-haiku-4-5', checked: '3 goldens', moved: ['1 write changed', '2 stops changed', '2 reads changed'], word: 'not verified', tone: 'y', line: '2 of 3 goldens to verify', runs: 3, flagged: 2, flaggedRank: 1, toVerify: 2, revision: 'd2e8a1f' });
    expect(row<PreviewVerdict>(rows, 'dc-01M5000000000000000000000B')).toMatchObject({ word: 'accepted', tone: 'ok', line: 'Every run it verified kept passing', toVerify: 0 });
    expect(row<PreviewVerdict>(rows, 'dc-01M5000000000000000000000C')).toMatchObject({ title: 'Field change to temperature=0', word: 'rejected', tone: 'no', line: 'The change broke a run that worked', moved: ['2 writes changed'] });
    expect(row<PreviewVerdict>(rows, 'dc-01M5000000000000000000000D')).toMatchObject({ checked: '1 run', word: 'inconclusive', tone: 'y', line: 'Not every run settled', flaggedRank: 2 });
    // Verified on one of the two runs it flags: not yet a verdict on the change.
    expect(row<PreviewVerdict>(rows, 'dc-01M5000000000000000000000E')).toMatchObject({ word: 'not verified', line: '1 of 3 goldens to verify', toVerify: 1 });
  });

  it('says what a preview that flags no run found, its headline’s sentence, and that one which could not ask a run settled nothing', () => {
    const rows = verdictsView(store, GOLDENS).rows;
    expect(row<PreviewVerdict>(rows, 'dc-01M5000000000000000000000F')).toMatchObject({ word: 'nothing to verify', tone: null, line: 'No write and no stop changes', moved: [], flagged: 0, flaggedRank: null });
    // As decisions exits 3 for it: inconclusive, with why, never a word that reads as all clear.
    expect(row<PreviewVerdict>(rows, 'dc-01M5000000000000000000000G')).toMatchObject({ title: 'Changed prompt and tools', word: 'inconclusive', tone: 'y', line: '1 run could not be asked' });
  });

  it('names a migration by its switch and gives verify’s verdict on it', () => {
    expect(row<PreviewVerdict>(verdictsView(store, GOLDENS).rows, 'mg-01M5000000000000000000000H')).toMatchObject({ kind: 'migration', title: 'claude-sonnet-4-5 → claude-sonnet-5-5', checked: '2 goldens', moved: ['1 stop changed'], word: 'accepted', line: 'Every run it verified kept passing' });
  });

  it('gives a fix’s verify in its head’s words, titled by its fix, and leaves out the verify a preview ran', () => {
    const rows = verdictsView(store, GOLDENS).rows;
    expect(row<VerifyVerdict>(rows, 'vf-01M5000000000000000000000A')).toMatchObject({ fixId: fixAccepted, title: 'issue_refund called with amount 240', checked: '2 runs', moved: ['1 fixed', '1 kept'], word: 'accepted', tone: 'ok', line: 'Fixes the run that failed, keeps the one that worked', code: '370712a+dirty', repairId: null, candidate: null, codeVersion: '370712a+dirty', fields: null, verdict: 'accepted', counts: true, by: null });
    expect(row<VerifyVerdict>(rows, 'vf-01M5000000000000000000000B')).toMatchObject({ title: 'send_email before issue_refund', moved: ['1 not fixed', '1 fixed'], word: 'rejected', tone: 'no', line: 'The change did not fix 1 of the 2 runs that failed' });
    // verify's incomplete is inconclusive, as every verdict that settled nothing reads.
    expect(row<VerifyVerdict>(rows, 'vf-01M5000000000000000000000C')).toMatchObject({ moved: ['1 fixed', '1 inconclusive'], word: 'inconclusive', tone: 'y', verdict: 'incomplete', line: 'Not every run settled' });
    // A repair's candidate: what it verified, by the repair and the candidate, apart from the code it ran at.
    expect(row<VerifyVerdict>(rows, 'vf-01M5000000000000000000000D')).toMatchObject({ code: 'repair candidate 3', repairId: 'repair-munzln2i', candidate: 3, codeVersion: '370712a+dirty', counts: false });
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

  it('names who made a change only where checks are shared: a commit’s author, who ran a preview', () => {
    const subjects = new Map([['d2e8a1f', 'Tighten refund wording']]);
    const authors = new Map([['d2e8a1f', 'jonas@example.com'], ['c91d0f4', 'dana@example.com']]);
    const alone = withCommits(verdictsView(store, GOLDENS), subjects, authors).rows;
    expect(alone.map((r) => r.by)).toEqual(alone.map(() => null));
    const view = verdictsView(store, GOLDENS, { shared: true });
    // The read model knows no commit's author: git says it (withCommits), never the session's runner, who is `ci` for CI's.
    expect(row<SessionVerdict>(view.rows, 'c91d0f4').by).toBeNull();
    const team = withCommits(view, subjects, authors).rows;
    expect(row<SessionVerdict>(team, 'd2e8a1f').by).toBe('jonas@example.com');
    expect(row<SessionVerdict>(team, 'c91d0f4').by).toBe('dana@example.com');
    // No commit to ask git about.
    expect(row<SessionVerdict>(team, 'no-revision').by).toBeNull();
    expect(row<PreviewVerdict>(team, 'dc-01M5000000000000000000000A').by).toBe('ravi@example.com');
    // A verify keeps no one's name.
    expect(row<VerifyVerdict>(team, 'vf-01M5000000000000000000000A').by).toBeNull();
  });

  it('titles a revision by its commit’s subject where git has it', () => {
    const view = verdictsView(store, GOLDENS);
    expect(commitsWanted(view)).toEqual(['d2e8a1f', 'c91d0f4']);
    const named = withCommits(view, new Map([['d2e8a1f', 'Tighten refund wording']]));
    expect(row<SessionVerdict>(named.rows, 'd2e8a1f')).toMatchObject({ title: 'Tighten refund wording', subject: 'Tighten refund wording' });
    expect(row<SessionVerdict>(named.rows, 'c91d0f4')).toMatchObject({ title: 'Commit c91d0f4', subject: null });
    expect([sessionTitle('d2e8a1f+dirty', 'Tighten refund wording'), sessionTitle('d2e8a1f+dirty', null), sessionTitle(null, null)]).toEqual(['Tighten refund wording, with uncommitted changes', 'Uncommitted changes on d2e8a1f', 'Tested with no revision']);
  });

  it('shows a whole number of rows from 1 to the window, 50 unless asked', () => {
    expect([verdictsLimit(null), verdictsLimit(''), verdictsLimit('abc'), verdictsLimit('Infinity'), verdictsLimit('0'), verdictsLimit('-1'), verdictsLimit('1.7'), verdictsLimit('12'), verdictsLimit('500'), verdictsLimit(3.9)]).toEqual([50, 50, 50, 50, 1, 1, 1, 12, VERDICTS_WINDOW, 3]);
    expect(verdictsView(store, GOLDENS, { limit: 2.5 }).rows).toHaveLength(2);
  });
});

describe('a preview or a migration that settles nothing', () => {
  // Each session kept as decisions and migrate keep one (keepDecisions): the report without its runs,
  // and each run a row of its own, its rank what most samples show, its whole report as its data.
  let kept: Store;
  const T = at(100);
  const step = (o: Partial<DecisionStep> = {}): DecisionStep => ({ callNo: 1, step: 1, scope: null, rank: null, majority: null, changes: [], recorded: { stop: 'answer', stopReason: 'end_turn', tools: [], text: 'Refund issued.' }, now: null, samples: { asked: 3, answered: 3, changed: 0, ranks: [0, 0, 0] }, model: { recorded: 'claude-sonnet-4-5', asked: 'claude-haiku-4-5' }, tokens: { before: null, after: null }, cost: { before: null, after: null, spent: 0 }, thinkingStripped: 0, error: null, ...o });
  /** A step the model answered none of the samples of. */
  const unanswered = step({ samples: { asked: 3, answered: 0, changed: 0, ranks: [] }, error: 'HTTP 529: overloaded' });
  /** A text-only step whose words a judge check reads but could not judge in one sample: it waits on a judge. */
  const waits = step({ rank: 5, majority: 5, samples: { asked: 3, answered: 3, changed: 3, ranks: [5, 5, 5], unjudged: 1 } });
  /** A step that decided otherwise while its request as recorded got too few answers to tell it from the model's own variation. */
  const uncontrolled = step({ sampled: 2, samples: { asked: 3, answered: 3, changed: 2, ranks: [2, 2, 0] }, control: { asked: 3, answered: 1, changed: 0, ranks: [0], error: 'HTTP 529: overloaded' } });
  const run = (runId: string, decisions: DecisionStep[], o: Partial<DecisionRun> = {}): DecisionRun => {
    const c = { ...emptyCounts(), noise: 0 };
    // Counted as decisions counts a run's steps: a step that waits on its control is not asked.
    for (const s of decisions) if (s.rank !== null) c[String(s.rank) as '1']++;
    else if (s.control && s.control.answered < 3) c.notAsked++;
    else if (s.samples.answered) c.same++;
    else c.notAsked++;
    return { runId, golden: `goldens/${runId.slice(-1)}`, steps: decisions.length, asked: decisions.filter((s) => s.samples.answered).length, rank: null, majority: null, counts: c, cost: { before: null, after: null, spent: 0 }, tokens: { before: NO_TOKENS, after: NO_TOKENS }, thinkingStripped: 0, refused: null, decisions, warnings: [], ...o };
  };
  const keep = (id: string, minutes: number, runs: DecisionRun[], o: { flagged?: string[]; verify?: Partial<DecisionsVerify>; judge?: number; stopReason?: string; kind?: 'decisions' | 'migrate'; passes?: Array<{ verdict: string; verified: boolean }> } = {}) => {
    const total = emptyCounts();
    for (const r of runs) for (const k of Object.keys(total) as Array<keyof DecisionCounts>) total[k] = (total[k] ?? 0) + (r.counts[k] ?? 0);
    const report = { kind: 'decisions', change: { model: 'claude-haiku-4-5', fields: {}, from: null, fromCode: null, text: 'the model claude-haiku-4-5' }, samples: 3, counts: total, flagged: o.flagged ?? [], verify: o.verify ? { verdict: 'accepted', verifyIds: [], runs: [], commands: [], spent: 0, upstreamRequests: 0, reasons: [], ...o.verify } : null, judge: o.judge ? { steps: o.judge, changed: 0, inconclusive: o.judge, spent: 0, upstreamRequests: 0, unknownModels: [] } : null, stopReason: o.stopReason ?? null, notes: [], warnings: [] };
    const kind = o.kind ?? 'decisions';
    const data = kind === 'migrate' ? { kind, from: ['claude-sonnet-4-5'], to: 'claude-haiku-4-5', decisions: { ...report, kind: 'decisions', runs: [] }, passes: { verdict: report.verify?.verdict ?? 'not-run', runs: (o.passes ?? []).map((x, i) => ({ runId: runs[i]!.runId, golden: runs[i]!.golden, outcome: x.verified ? 'kept' : 'not-asked', tally: null, ...x })) }, stopReason: report.stopReason } : report;
    kept.putDecisionSession({ sessionId: id, kind, at: T + minutes * 60_000, change: 'the model claude-haiku-4-5', actor: 'ravi@example.com', revision: null, data, runs: runs.map((r) => ({ runId: r.runId, golden: r.golden, rank: r.majority, changed: r.decisions.filter((x) => x.rank !== null).length, data: r as unknown as Record<string, unknown> })) });
  };
  const flaggedRun = (runId: string) => run(runId, [step({ rank: 1, majority: 1, samples: { asked: 3, answered: 3, changed: 3, ranks: [1, 1, 1] } })], { rank: 1, majority: 1 });
  const verdictOf = (id: string) => verdictsView(kept, []).rows.find((r) => r.id === id) as PreviewVerdict;

  beforeAll(() => {
    kept = Store.open(':memory:');
    // Every model call of one run got no answer, while the other run's did.
    keep('dc-01M7000000000000000000000A', 1, [run('01K7RUN0000000000000000001', [step(), step()]), run('01K7RUN0000000000000000002', [unanswered, unanswered])]);
    keep('dc-01M7000000000000000000000B', 2, [run('01K7RUN0000000000000000003', [step(), uncontrolled])]);
    keep('dc-01M7000000000000000000000C', 3, [run('01K7RUN0000000000000000004', [step(), waits], { rank: 5 })], { judge: 1 });
    keep('dc-01M7000000000000000000000D', 4, [run('01K7RUN0000000000000000005', [step()])], { stopReason: 'the budget of $0.10 is spent' });
    // One step of a run got no answer, the rest did: the run was asked, and the preview settled.
    keep('dc-01M7000000000000000000000E', 5, [run('01K7RUN0000000000000000006', [step(), unanswered])]);
    // A run it flags waits on a judge too: verify took it and kept it.
    keep('dc-01M7000000000000000000000F', 6, [run('01K7RUN0000000000000000007', [waits, step({ rank: 1, majority: 1 })], { rank: 1, majority: 1 })], { judge: 1, flagged: ['01K7RUN0000000000000000007'], verify: { runs: [{ runId: '01K7RUN0000000000000000007', role: 'good', outcome: 'kept', passes: 12, attempts: 12 }] } });
    // Verify rejected the change on one run it flags, and has the other still to take.
    keep('dc-01M7000000000000000000000G', 7, [flaggedRun('01K7RUN0000000000000000008'), flaggedRun('01K7RUN0000000000000000009')], { flagged: ['01K7RUN0000000000000000008', '01K7RUN0000000000000000009'], verify: { verdict: 'rejected', runs: [{ runId: '01K7RUN0000000000000000008', role: 'good', outcome: 'broken', passes: 0, attempts: 3 }] } });
    // Migrations: the run it flags kept while another got no answer, so migrate says Not settled; and one that breaks a run.
    keep('mg-01M7000000000000000000000H', 8, [flaggedRun('01K7RUN000000000000000000A'), run('01K7RUN000000000000000000B', [unanswered])], { kind: 'migrate', flagged: ['01K7RUN000000000000000000A'], verify: { runs: [{ runId: '01K7RUN000000000000000000A', role: 'good', outcome: 'kept', passes: 12, attempts: 12 }] }, passes: [{ verdict: 'passed', verified: true }, { verdict: 'inconclusive', verified: false }] });
    keep('mg-01M7000000000000000000000J', 9, [flaggedRun('01K7RUN000000000000000000C')], { kind: 'migrate', flagged: ['01K7RUN000000000000000000C'], verify: { verdict: 'rejected', runs: [{ runId: '01K7RUN000000000000000000C', role: 'good', outcome: 'broken', passes: 0, attempts: 3 }] }, passes: [{ verdict: 'failed', verified: true }] });
  });

  afterAll(() => kept?.close());

  it('says a preview that flags no run settled nothing, and why, as decisions exits 3 for it', () => {
    expect(verdictOf('dc-01M7000000000000000000000A')).toMatchObject({ word: 'inconclusive', tone: 'y', line: '1 run could not be asked' });
    expect(verdictOf('dc-01M7000000000000000000000B')).toMatchObject({ word: 'inconclusive', tone: 'y', line: "1 run has a changed step the request as recorded got no answer for, so it could not be told from the model's own variation" });
    expect(verdictOf('dc-01M7000000000000000000000C')).toMatchObject({ word: 'inconclusive', tone: 'y', line: '1 run has a text-only change a judge check reads that could not be judged' });
    expect(verdictOf('dc-01M7000000000000000000000D')).toMatchObject({ word: 'inconclusive', tone: 'y', line: 'It stopped before every step was asked: the budget of $0.10 is spent' });
    expect(verdictOf('dc-01M7000000000000000000000E')).toMatchObject({ word: 'nothing to verify', tone: null, line: 'The same decisions at every step asked' });
  });

  it('gives verify’s verdict once it took every run a preview flags, whatever waits in them', () => {
    expect(verdictOf('dc-01M7000000000000000000000F')).toMatchObject({ word: 'accepted', line: 'Every run it verified kept passing' });
    // Rejected on one run, the other still to verify: no verdict on the change yet.
    expect(verdictOf('dc-01M7000000000000000000000G')).toMatchObject({ word: 'not verified', tone: 'y', line: '1 of 2 goldens to verify', toVerify: 1 });
  });

  it('gives a migration migrate’s own verdict: inconclusive while a run is, rejected when it breaks one', () => {
    expect(verdictOf('mg-01M7000000000000000000000H')).toMatchObject({ kind: 'migration', word: 'inconclusive', tone: 'y', line: '1 run is inconclusive', toVerify: 0 });
    expect(verdictOf('mg-01M7000000000000000000000J')).toMatchObject({ kind: 'migration', word: 'rejected', tone: 'no', line: 'The change broke a run that worked' });
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
    expect(withCommits(page, new Map([['d2e8a1f', 'Tighten refund wording']])).row.title).toBe('Tighten refund wording');
    expect(page.shared).toBe(false);
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
  /** Verifies previews ran, which no fix keeps: each newer than every fix's, so the window walks past them all. */
  const UNLINKED = 5_000;
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
      const kept = verifyReport([{ runId: '01K5RUN0000000000000000001', role: 'good', pass: true }]);
      for (let i = 0; i < UNLINKED; i++) big.putVerdict({ verifyId: `vf-01M7${String(i).padStart(22, '0')}`, at: at(SESSIONS + i), verdict: 'accepted', repairId: null, candidate: null, report: kept, expect: null, command: 'shadowlap decisions --verify dc-01M6' });
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
    expect(view.lead).toMatchObject({ key: (0x1000000 + SESSIONS - 1).toString(16), word: 'failed', line: '4 of 5 goldens passed' });
    expect(page?.goldens).toHaveLength(5);
    // The store holds 50,000 results, 10,000 sessions, 1,000 previews and 1,000 verifies: the list and
    // a page read a few thousand rows between them, the window's.
    expect(rows, `the list and a page read ${rows} rows`).toBeLessThan(5_000);

    // Held against this machine, not a number of milliseconds: a twentieth to a thirtieth of one plain
    // read of every result here; under one such read, whatever the machine. The verifies no fix keeps
    // are walked past by their index, never read: the list costs less than reading what every verdict
    // says of its runs.
    const t = timesOf({
      list: () => verdictsView(big, goldens),
      page: () => verdictRevision(big, goldens, view.lead!.key),
      every: () => big.query('SELECT * FROM test_results'),
      verdicts: () => big.query(`SELECT json_extract(record, '$.report.runs') AS runs FROM verdicts`),
    });
    console.log(`verdicts over ${SESSIONS} test sessions, ${PREVIEWS} previews and ${VERIFIES + UNLINKED} verifies (${UNLINKED} no fix keeps): ${rows} rows read; the list ${t.list.toFixed(1)} ms CPU, a revision's page ${t.page.toFixed(1)} ms; a read of every result ${t.every.toFixed(1)} ms, of every verdict's runs ${t.verdicts.toFixed(1)} ms`);
    expect(t.list, `the list took ${times(t.list, t.every)} a read of every result`).toBeLessThan(t.every);
    expect(t.list, `the list took ${times(t.list, t.verdicts)} a read of every verdict's runs`).toBeLessThan(t.verdicts);
    expect(t.page, `a page took ${times(t.page, t.every)} a read of every result`).toBeLessThan(t.every);
  }, 120_000);

  it('reads which goldens a session ran only for one that didn’t ask for them all, however many goldens there are', () => {
    // 400 sessions of 100 goldens each: 40,000 results, every session's command goldens/*.
    const wide = Store.open(':memory:');
    try {
      const many = Array.from({ length: 100 }, (_, i) => golden(`goldens/w${String(i).padStart(3, '0')}`));
      wide.transaction(() => {
        for (let i = 0; i < 400; i++) session(wide, { revision: (0x2000000 + i).toString(16), at: at(i), results: many.map((g, k) => (k === i % 100 ? diverged(g.path) : pass(g.path))) });
        // Add normalizer and re-run, newest of all: one golden named, so its golden set is read, and it fills no column.
        session(wide, { revision: (0x2000000 + 399).toString(16), at: at(400), command: ['shadowlap', 'test', 'goldens/w000'], results: [pass('goldens/w000')] });
      });
      let sets = 0;
      const spy = vi.spyOn(wide, 'testSessionGoldens').mockImplementation(function (this: Store, ids) {
        sets += ids.length;
        return Store.prototype.testSessionGoldens.call(this, ids);
      });
      let view: VerdictsView;
      try {
        view = verdictsView(wide, many);
        verdictRevision(wide, many, view.lead!.key);
      } finally {
        spy.mockRestore();
      }
      // The list and a page each read the golden set of the one session that named a golden.
      expect(sets).toBe(2);
      // The window's 200 sessions, the re-run among them, which is no revision's row.
      expect(view.counts.sessions).toBe(VERDICTS_WINDOW - 1);
      expect(view.lead).toMatchObject({ key: (0x2000000 + 399).toString(16), goldens: 100, line: '99 of 100 goldens passed' });
      const t = timesOf({
        list: () => verdictsView(wide, many),
        page: () => verdictRevision(wide, many, view.lead!.key),
        every: () => wide.query('SELECT * FROM test_results'),
      });
      console.log(`verdicts over 400 test sessions of 100 goldens: the list ${t.list.toFixed(1)} ms CPU, a revision's page ${t.page.toFixed(1)} ms; a read of every result ${t.every.toFixed(1)} ms`);
      expect(t.list, `the list took ${times(t.list, t.every)} a read of every result`).toBeLessThan(t.every / 2);
      expect(t.page, `a page took ${times(t.page, t.every)} a read of every result`).toBeLessThan(t.every / 2);
    } finally {
      wide.close();
    }
  }, 120_000);
});
