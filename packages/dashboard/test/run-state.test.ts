import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { runDetail } from '../src/api.js';
import { listRunsPage, recentRuns, runState } from '../src/runs-list.js';
import { addRun, DAY, HOUR } from './read-model-store.js';

/**
 * One read model decides how a run stands, for the run list (Runs, the sidebar, the Overview) and for
 * the run's own page: a run its recorder left is interrupted everywhere, never failed on one screen
 * and neutral on another; a test whose golden may fork is judged by its checks on both; a run a fix
 * lists among its failing runs failed that fix's check on both.
 */

const NOW = Date.UTC(2026, 9, 1, 10, 15);
let store: Store;
const id: Record<string, string> = {};

beforeAll(() => {
  store = Store.open(':memory:');
  id.rec = addRun(store, { startedAt: NOW - DAY, calls: 'l'.repeat(8) });
  // Ctrl-C: ended by the CLI as interrupted.
  id.crashed = addRun(store, { startedAt: NOW - 5 * HOUR, status: 'crashed', calls: 'llll' });
  // Killed before it ended, two days ago: still marked running, with nothing recording it.
  id.left = '01K4ZZ0000000000000000LEFT';
  store.importRun({ runId: id.left, parentRunId: null, mode: 'record', status: 'running', divergence: null, command: { argv: ['node', 'agent.mjs'], cwd: '/work' }, codeVersion: null, startedAt: NOW - 2 * DAY, endedAt: null });
  // Recording right now, in this process.
  id.live = addRun(store, { startedAt: NOW - 60_000, status: 'running', calls: 'll' });
  // A golden that may fork (its checks judge it, nothing was refused offline): it left the recording at #3, went live, and its checks passed.
  id.forked = addRun(store, { parent: id.rec, startedAt: NOW - 4 * HOUR, divergence: 3, calls: 'rrllllll', meta: { test: { golden: 'goldens/budget', session: 's1' }, checks: [{ ok: true, label: 'at most 29000 input tokens', detail: null }] } });
  // The same golden, failing its check after it forked.
  id.forkedFail = addRun(store, { parent: id.rec, startedAt: NOW - 3 * HOUR, divergence: 3, calls: 'rrllllll', meta: { test: { golden: 'goldens/budget', session: 's2' }, checks: [{ ok: false, label: 'at most 29000 input tokens', detail: '38337 input tokens' }] } });
  // A golden with no checks: where it diverged is what it failed on.
  id.diverged = addRun(store, { parent: id.rec, startedAt: NOW - 2 * HOUR, status: 'failed', divergence: 3, calls: 'rrf', meta: { test: { golden: 'goldens/replay', session: 's3' } } });
  // verify was told this run fails the fix's check: it kept no check of its own.
  id.target = addRun(store, { startedAt: NOW - 6 * HOUR, calls: 'llllll', meta: { labels: ['refund-bug'] } });
  store.insertFix({
    fixId: 'fx-01K4ZZFIX0000000000000000',
    title: 'Refunds above the limit issued without approval',
    labels: ['refund-bug'],
    check: { expect: { tools: { issue_refund: { count: 0, args: { amount: 240 } } } }, key: 'check:x', oracle: ['issue_refund never called with {"amount":240}'], text: 'issue_refund never called with {"amount":240}' },
    status: 'verified',
    openedAt: NOW - 5 * HOUR,
    verifiedAt: NOW - 4 * HOUR,
    appliedAt: null,
    data: {},
  });
  store.addFixLink('fx-01K4ZZFIX0000000000000000', 'failing', id.target, NOW - 5 * HOUR);
});
afterAll(() => store.close());

const row = (runId: string) => listRunsPage(store, { limit: 500, includeAttempts: true }).runs.find((r) => r.runId === runId)!;

describe('how a run stands, on its page and in the lists', () => {
  it('says a run that was only interrupted is interrupted, not failed, wherever it is shown', () => {
    for (const runId of [id.crashed, id.left]) {
      const state = runState(store, runId)!;
      expect(state).toMatchObject({ status: 'crashed', outcome: { kind: 'none' }, failed: false, interrupted: true, kind: 'recording' });
      expect(row(runId)).toMatchObject({ status: 'crashed', outcome: { kind: 'none' }, failed: false });
      expect(recentRuns(store).find((r) => r.runId === runId)).toMatchObject({ status: 'crashed', failed: false });
      // The run's own page reads the same state, and a recorder that went away no longer reads as recording.
      const detail = runDetail(store, runId)!;
      expect(detail.state).toEqual(state);
      expect(detail.run.status).toBe('crashed');
    }
    // Recording now is not interrupted.
    expect(runState(store, id.live)).toMatchObject({ status: 'running', outcome: { kind: 'running' }, interrupted: false });
    expect(runDetail(store, id.live)!.run.status).toBe('running');
  });

  it('judges a test of a golden that may fork by its checks, and one held to its recording by where it diverged', () => {
    expect(runState(store, id.forked)).toMatchObject({ kind: 'test', outcome: { kind: 'passed', checks: 1 }, failed: false });
    expect(runState(store, id.forkedFail)).toMatchObject({ kind: 'test', outcome: { kind: 'check-failed', check: 'at most 29000 input tokens' }, failed: true });
    expect(runState(store, id.diverged)).toMatchObject({ kind: 'test', outcome: { kind: 'diverged', callNo: 3 }, failed: true });
  });

  it('counts a run a fix lists among its failing runs as failing that fix’s check, when it kept no outcome of its own', () => {
    const state = runState(store, id.target)!;
    expect(state).toMatchObject({ outcome: { kind: 'check-failed', check: 'issue_refund never called with {"amount":240}' }, failed: true, interrupted: false });
    expect(row(id.target)).toMatchObject({ outcome: state.outcome, failed: true });
    // The Failed chip counts it.
    expect(listRunsPage(store, { limit: 500, types: ['failed'] }).runs.map((r) => r.runId)).toContain(id.target);
  });

  it('agrees with the run list on every run', () => {
    const page = listRunsPage(store, { limit: 500, includeAttempts: true });
    expect(page.runs.length).toBeGreaterThan(5);
    for (const r of page.runs) {
      const d = runDetail(store, r.runId)!;
      expect({ status: d.state!.status, outcome: d.state!.outcome, failed: d.state!.failed, kind: d.state!.kind }, r.runId).toEqual({ status: r.status, outcome: r.outcome, failed: r.failed, kind: r.kind });
      expect(d.run.status, r.runId).toBe(r.status);
    }
  });

  it('knows no state for a run that is not in the store', () => {
    expect(runState(store, '01K4ZZ00000000000000000000')).toBeNull();
  });
});
