import { describe, expect, it } from 'vitest';
import { approx } from '../ui/format.js';
import { normalizeRunDetail, normalizeState } from '../ui/normalize.js';
import { failedWord, familyLine, familyLineParts, isFailed, isInterrupted, repeatBundle, runGlyph, runOutcome, runTag, sideLine, type RunLike } from '../ui/runs.js';
import { lineageRunLike, runLikeOf } from '../ui/run/model.js';
import { datasetTooMany, DATASET_MAX_RUNS } from '../ui/run/share.js';
import { blameScope, scopeChips, scopeHint } from '../ui/scopes.js';
import type { LineageNode, RunDetail, RunListItem } from '../ui/types.js';
import { MAX_DATASET_RUNS } from '../src/run-exports.js';

// How a run stands, in the words every list and the run's page use: an interrupted run is neutral
// everywhere, a run the server counts failed is failed everywhere.

const base: RunLike = { runId: '01K5CQ4N7G0000000000000000', parentRunId: null, mode: 'record', status: 'completed', divergence: null, command: 'node refund_agent.mjs T-8813', codeVersion: null, startedAt: 0, calls: 8, spent: 0.004, saved: 0, captured: 0, imported: false, covers: null, source: null, labels: [] };
const cut: RunLike = { ...base, status: 'crashed', kind: 'recording', outcome: { kind: 'none' }, failed: false };

describe('an interrupted run, everywhere it is shown', () => {
  it('reads as interrupted in a neutral tone, never as a failure', () => {
    expect(isInterrupted(cut)).toBe(true);
    expect(isFailed(cut)).toBe(false);
    // The run page's tag, the sidebar's line and icon, the Runs table's status, the Forks tree's line.
    expect(runTag(cut)).toEqual({ cls: '', text: 'interrupted' });
    expect(sideLine(cut)).toEqual({ text: 'recording · interrupted · 8 calls' });
    expect(runGlyph(cut)).toEqual({ kind: 'rec', label: 'Recording, interrupted' });
    expect(runOutcome(cut)).toEqual({ tone: 'n', text: 'interrupted' });
    expect(familyLine(cut)).toBe('recording · interrupted · 8 calls');
    // A replay stopped the same way says what it was.
    const replay: RunLike = { ...cut, mode: 'replay', parentRunId: '01K5CQ4N7F0000000000000000', kind: 'replay' };
    expect(sideLine(replay)).toEqual({ text: 'replay · interrupted · 8 calls' });
    expect(runTag(replay)).toEqual({ cls: '', text: 'interrupted' });
    // So does a fork, in the sidebar as in the Forks view: what it is, then that it stopped.
    const fork: RunLike = { ...cut, mode: 'replay', parentRunId: '01K5CQ4N7F0000000000000000', divergence: { callNo: 3, type: 'request_changed' }, origins: 'rrllllll', kind: 'fork' };
    expect(sideLine(fork)).toEqual({ text: 'fork @3 · interrupted · 8 calls' });
    expect(familyLine(fork)).toBe('fork @3 · interrupted · 8 calls');
    expect(runOutcome(fork)).toEqual({ tone: 'n', text: 'interrupted' });
    expect(runGlyph(fork)).toEqual({ kind: 'fork', label: 'Fork at #3, interrupted' });
    // The fork's tag says what it is; its page's eyebrow says that it stopped.
    expect(runTag(fork)).toEqual({ cls: 'fork', text: 'fork @3' });
  });

  it('is interrupted without the server too: a stop is not a failure', () => {
    const older: RunLike = { ...base, status: 'crashed' };
    expect(isFailed(older)).toBe(false);
    expect(runOutcome(older)).toEqual({ tone: 'n', text: 'interrupted' });
  });

  it('says a run whose agent exited with an error failed, in Runs as in the sidebar; a check, when one failed', () => {
    // The engine's outcome for an agent's error exit names no check.
    const exited: RunLike = { ...base, status: 'failed', kind: 'recording', outcome: { kind: 'check-failed', check: null }, failed: true };
    expect(runOutcome(exited)).toEqual({ tone: 'err', text: 'failed' });
    expect(sideLine(exited)).toEqual({ err: 'failed', text: ' · 8 calls' });
    const checked: RunLike = { ...exited, outcome: { kind: 'check-failed', check: 'issue_refund never called' } };
    expect(runOutcome(checked)).toEqual({ tone: 'err', text: 'check failed' });
    expect(sideLine(checked)).toEqual({ err: 'check failed', text: ' · 8 calls' });
    // Blame confirmed a run that exited 0 fails the check it was given, though it placed it on no call.
    const blamed: RunLike = { ...exited, status: 'completed' };
    expect(runOutcome(blamed)).toEqual({ tone: 'err', text: 'check failed' });
    expect(sideLine(blamed)).toEqual({ err: 'check failed', text: ' · 8 calls' });
    expect(failedWord(blamed)).toBe('check failed');
  });

  it('fails as the server says when it failed something before it stopped', () => {
    const failed: RunLike = { ...cut, outcome: { kind: 'check-failed', check: 'send_email called once' }, failed: true };
    expect(isInterrupted(failed)).toBe(false);
    expect(runTag(failed)).toEqual({ cls: 'fail', text: 'failed' });
    expect(sideLine(failed)).toEqual({ err: 'check failed', text: ' · 8 calls' });
  });
});

describe('a failed recording in the Forks tree', () => {
  it('sets what went wrong apart, as the sidebar does', () => {
    const failed: RunLike = { ...base, kind: 'recording', outcome: { kind: 'lost', callNo: 9 }, failed: true };
    // What it spent, as the page writes an estimate wherever it shows one.
    const spent = approx(base.spent);
    expect(familyLineParts(failed)).toEqual({ err: 'check failed', text: ` · 8 calls · ${spent}` });
    expect(familyLineParts({ ...base, kind: 'recording', outcome: { kind: 'check-failed', check: null }, failed: true, status: 'failed' })).toEqual({ err: 'failed', text: ` · 8 calls · ${spent}` });
    expect(familyLineParts(base)).toEqual({ err: null, text: `recording · 8 calls · ${spent}` });
  });
});

describe('a run of the family, in Forks and in Provenance’s lineage', () => {
  const node = (over: Partial<LineageNode> = {}): LineageNode => ({ runId: '01K5CQ4N7G0000000000000000', parentRunId: null, depth: 0, mode: 'record', status: 'completed', label: 'recording', divergence: null, calls: 8, spent: 0.004, saved: 0, startedAt: 0, repeat: null, checks: null, ...over });
  it('reads its own state from the run list, never the run on the page', () => {
    const listed = { runId: '01K5CQ4N7G0000000000000000', status: 'crashed', kind: 'recording', outcome: { kind: 'none' }, failed: false, command: 'node agent.mjs', labels: [] } as unknown as RunListItem;
    const like = lineageRunLike(node(), listed);
    expect(like).toMatchObject({ status: 'crashed', kind: 'recording', failed: false, command: 'node agent.mjs' });
    expect(runGlyph(like)).toEqual({ kind: 'rec', label: 'Recording, interrupted' });
    // A recording the list doesn't hold is drawn from the lineage alone: a recording, whatever the page shows.
    expect(runGlyph(lineageRunLike(node(), undefined))).toEqual({ kind: 'rec', label: 'Recording' });
    expect(runGlyph(lineageRunLike(node({ mode: 'replay', parentRunId: '01K5CQ4N7F0000000000000000', divergence: { callNo: 5, type: 'forced' } }), undefined))).toEqual({ kind: 'fork', label: 'Fork at #5' });
  });

  it('reads its state from the lineage when the server sends it, for an attempt the lists leave out too', () => {
    // A --repeat attempt its recorder left: the lineage says interrupted, and the list doesn't hold it.
    const attempt = node({ mode: 'replay', parentRunId: '01K5CQ4N7F0000000000000000', divergence: { callNo: 3, type: 'request_changed' }, status: 'crashed', kind: 'fork', outcome: { kind: 'none' }, failed: false, repeat: { group: 'g1', attempt: 2, of: 3 } });
    const like = lineageRunLike(attempt, undefined);
    expect(like).toMatchObject({ status: 'crashed', kind: 'fork', outcome: { kind: 'none' }, failed: false });
    expect(familyLine(like)).toBe('fork @3 · interrupted · 8 calls');
    // The lineage's state wins over a list row read before the recorder was found gone.
    const stale = { runId: attempt.runId, status: 'running', kind: 'fork', outcome: { kind: 'running' }, failed: false, command: 'node agent.mjs', labels: [] } as unknown as RunListItem;
    expect(lineageRunLike(attempt, stale)).toMatchObject({ status: 'crashed', outcome: { kind: 'none' }, command: 'node agent.mjs' });
    // An attempt of a --repeat bundle says so beside its id, marked apart (grey), and the bundle counts
    // it neither passed nor failed.
    const bundle = repeatBundle([
      { runId: '01K5CQ4N7A0000000000000000', status: 'completed', divergence: { callNo: 3 }, spent: 0.01, startedAt: 0, repeat: { attempt: 1, of: 3 }, checks: null },
      { runId: attempt.runId, status: like.status, divergence: { callNo: 3 }, spent: 0.01, startedAt: 1, repeat: { attempt: 2, of: 3 }, checks: null },
    ]);
    expect(bundle.line).toBe('forked 2 attempts, 1 passed, 1 interrupted · ≈$0.020');
    expect(bundle.attempts).toEqual([
      { runId: '01K5CQ4N7A0000000000000000', text: '01K5CQ4N7A · passed', ok: true },
      { runId: attempt.runId, text: '01K5CQ4N7G · interrupted', ok: false, cut: true },
    ]);
  });
});

describe('a test whose golden may fork, in the sidebar', () => {
  it('says where it forked and how much ran live, not that it replayed offline', () => {
    const test: RunLike = { ...base, mode: 'replay', parentRunId: '01K5CQ4N7F0000000000000000', divergence: { callNo: 3, type: 'request_changed' }, test: { golden: 'goldens/budget' }, origins: 'rrllllll', kind: 'test', outcome: { kind: 'passed', checks: 1 }, failed: false };
    expect(sideLine(test)).toEqual({ text: 'test · forked at #3 · 6 live' });
    expect(sideLine({ ...test, origins: 'rrrrrrrr', divergence: null })).toEqual({ text: 'test · offline · 0 upstream' });
    // Failing its check after it forked, it failed on the check, not at the fork.
    expect(sideLine({ ...test, outcome: { kind: 'check-failed', check: 'at most 29000 input tokens' }, failed: true })).toEqual({ err: 'test failed', text: ' · 8 calls' });
  });
});

describe('the run page’s reading of the server’s state', () => {
  const detail = (state: unknown): RunDetail =>
    normalizeRunDetail({
      run: { runId: base.runId, parentRunId: null, mode: 'record', status: 'crashed', divergence: null, command: { argv: ['node', 'refund_agent.mjs'], cwd: '/w' }, codeVersion: null, startedAt: 0, endedAt: null, meta: {} },
      label: 'recording',
      source: null,
      summary: { total: 8, byKind: { api: 3, tool: 3, clock: 1, random: 1 }, byOrigin: {}, upstreamRequests: 3, cost: { spent: 0.004, saved: 0, captured: 0, unknownModels: [] }, tokensNotRespent: { inputTokens: 0 }, durationMs: 400, imported: false },
      calls: [],
      parent: null,
      children: [],
      actions: [],
      fix: null,
      state,
    } as unknown as RunDetail);

  it('takes the kind, outcome and failure from the state, so the page says what Runs says', () => {
    const d = detail({ status: 'crashed', kind: 'recording', outcome: { kind: 'none' }, failed: false, interrupted: true, label: 'recording' });
    expect(d.state).toEqual({ status: 'crashed', kind: 'recording', outcome: { kind: 'none' }, failed: false, interrupted: true, label: 'recording' });
    const like = runLikeOf(d);
    expect(isFailed(like)).toBe(false);
    expect(isInterrupted(like)).toBe(true);
    expect(runTag(like)).toEqual({ cls: '', text: 'interrupted' });
  });

  it('keeps nothing it can’t read', () => {
    expect(normalizeState({ status: 'gone', failed: false, outcome: { kind: 'none' } })).toBeNull();
    expect(normalizeState({ status: 'crashed', failed: 'no', outcome: { kind: 'none' } })).toBeNull();
    expect(normalizeState({ status: 'crashed', failed: false, outcome: { kind: 'lost' } })).toBeNull();
    expect(normalizeState({ status: 'completed', failed: true, outcome: { kind: 'check-failed', check: 3 } })).toMatchObject({ outcome: { kind: 'check-failed', check: null }, interrupted: false });
    // A run whose only undecided check is a judge's with no verdict: no failure.
    expect(normalizeState({ status: 'completed', failed: false, outcome: { kind: 'inconclusive', check: 'polite' } })).toMatchObject({ outcome: { kind: 'inconclusive', check: 'polite' }, failed: false });
    expect(detail(null).state).toBeNull();
  });
});

describe('the scope the page suggests blaming within', () => {
  it('names the scope that acts, not the model that plays its user', () => {
    const calls = [
      { callNo: 1, scope: 'customer', kind: 'api' },
      { callNo: 2, scope: 'agent', kind: 'api' },
      { callNo: 3, scope: 'agent', kind: 'tool' },
      { callNo: 4, scope: 'agent/policy-checker', kind: 'api' },
      { callNo: 5, scope: 'customer', kind: 'api' },
    ];
    expect(blameScope(calls, scopeChips(calls))).toBe('agent');
    // Without a nested scope, the one with the most tool calls; then the first.
    const flat = [
      { callNo: 1, scope: 'writer', kind: 'api' },
      { callNo: 2, scope: 'reviewer', kind: 'tool' },
    ];
    expect(blameScope(flat, scopeChips(flat))).toBe('reviewer');
    expect(blameScope([{ callNo: 1, scope: 'a', kind: 'api' }], ['a'])).toBe('a');
    expect(blameScope([], [])).toBeNull();
  });

  it('says so in the design’s words when the other scope only answers it, as a model playing the user does', () => {
    const calls = [
      { callNo: 1, scope: 'customer', kind: 'api' },
      { callNo: 2, scope: 'agent', kind: 'api' },
      { callNo: 3, scope: 'agent', kind: 'tool' },
      { callNo: 4, scope: 'agent/policy-checker', kind: 'api' },
    ];
    const chips = scopeChips(calls);
    expect(scopeHint(calls, chips, 'all')).toEqual({ lead: 'Blame only the agent, not the customer it answers', scope: 'agent' });
    // A scope picked: that one.
    expect(scopeHint(calls, chips, 'agent/policy-checker')).toEqual({ lead: 'Blame within this scope', scope: 'agent/policy-checker' });
    // Two scopes that both act (each calls tools): neither answers the other.
    const both = [...calls, { callNo: 5, scope: 'customer', kind: 'tool' }];
    expect(scopeHint(both, scopeChips(both), 'all')).toEqual({ lead: 'Blame within one scope', scope: 'agent' });
    expect(scopeHint([], [], 'all')).toBeNull();
  });
});

describe('a dataset of many runs', () => {
  it('takes as many runs as the export job does, and says what to do past that', () => {
    expect(DATASET_MAX_RUNS).toBe(MAX_DATASET_RUNS);
    expect(datasetTooMany(DATASET_MAX_RUNS)).toBeNull();
    expect(datasetTooMany(DATASET_MAX_RUNS + 1)).toBe('One dataset takes at most 500 runs: pick fewer, or export a label from a terminal with shadowlap export dataset --label <label>.');
  });
});
