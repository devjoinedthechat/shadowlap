import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NO_COMMAND, Store, deriveSetup, emptyStoreFacts, initialSetup, laterStage, earlierStage, recordEvent, runTotals, stageAtLeast, storeFacts, type RunFact, type StoreFacts } from '../src/index.js';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function freshStore(): Store {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'sl-setup-')));
  dirs.push(d);
  return Store.open(join(d, 'shadowlap.db'));
}

const fact = (runId: string, status: RunFact['status'] = 'completed'): RunFact => ({ runId, status, startedAt: 1, endedAt: status === 'running' ? null : 2 });
const facts = (over: Partial<StoreFacts> = {}): StoreFacts => ({ ...emptyStoreFacts(), ...over });

describe('setup stages', () => {
  it('only move forward', () => {
    expect(stageAtLeast('clean', 'recorded')).toBe(true);
    expect(stageAtLeast('inspected', 'recorded')).toBe(false);
    expect(laterStage('recorded', 'inspected')).toBe('recorded');
    expect(earlierStage('done', 'inspected')).toBe('inspected');
  });
});

describe('deriveSetup', () => {
  it('shows the setup everywhere while a project has no runs', () => {
    expect(deriveSetup({ stage: 'added', runId: null }, facts())).toEqual({ stage: 'added', run: null, live: false, shows: 'everywhere' });
    // A project set up whose runs are all gone starts again from its first steps.
    expect(deriveSetup({ stage: 'done', runId: 'GONE' }, facts())).toEqual({ stage: 'inspected', run: null, live: false, shows: 'everywhere' });
  });

  it('counts a recording made in a terminal as the setup’s', () => {
    const r = deriveSetup({ stage: 'inspected', runId: null }, facts({ runs: 1, recordings: [fact('R1')] }));
    expect(r).toEqual({ stage: 'recorded', run: fact('R1'), live: false, shows: 'overview' });
  });

  it('follows a recording still being made, and holds the stage until it ends', () => {
    const r = deriveSetup({ stage: 'inspected', runId: 'R2' }, facts({ runs: 1, recordings: [fact('R2', 'running')], live: true }));
    expect(r).toEqual({ stage: 'inspected', run: fact('R2', 'running'), live: true, shows: 'overview' });
  });

  it('keeps the setup’s own recording, and falls back to the newest when it was deleted', () => {
    const recordings = [fact('NEW'), fact('SETUP')];
    expect(deriveSetup({ stage: 'clean', runId: 'SETUP' }, facts({ runs: 2, recordings })).run?.runId).toBe('SETUP');
    expect(deriveSetup({ stage: 'clean', runId: 'DELETED' }, facts({ runs: 2, recordings })).run?.runId).toBe('NEW');
  });

  it('is done once finished, with runs; a project with imports only is still set up', () => {
    expect(deriveSetup({ stage: 'done', runId: null }, facts({ runs: 3 }))).toEqual({ stage: 'done', run: null, live: false, shows: 'none' });
    expect(deriveSetup({ stage: 'tested', runId: 'R' }, facts({ runs: 1, recordings: [fact('R')] })).shows).toBe('overview');
  });
});

describe('initialSetup', () => {
  it('brings a finished setup back from the store, or counts recordings with goldens as set up', () => {
    const store = freshStore();
    recordEvent(store, { kind: 'project.setup', runId: 'R1', data: { stage: 'done', golden: 'goldens/refund' } });
    expect(initialSetup(storeFacts(store), 0)).toEqual({ stage: 'done', runId: 'R1', golden: 'goldens/refund' });
    expect(initialSetup(facts({ runs: 1, recordings: [fact('R')] }), 2)).toEqual({ stage: 'done', runId: null, golden: null });
    expect(initialSetup(facts({ runs: 1, recordings: [fact('R')] }), 0)).toEqual({ stage: 'added', runId: null, golden: null });
    expect(initialSetup(facts(), 3)).toEqual({ stage: 'added', runId: null, golden: null });
  });
});

describe('storeFacts', () => {
  it('counts runs and attempts apart, and lists only recordings made here', () => {
    const store = freshStore();
    const make = (opts: { mode?: 'record' | 'replay'; parent?: string; meta?: Record<string, unknown>; argv?: string[]; status?: 'completed' | 'failed' | 'running' } = {}) => {
      const run = store.createRun({ mode: opts.mode ?? 'record', command: { argv: opts.argv ?? ['node', 'agent.mjs'], cwd: '/x' }, ...(opts.parent ? { parentRunId: opts.parent } : {}), ...(opts.meta ? { meta: opts.meta } : {}) });
      if ((opts.status ?? 'completed') !== 'running') store.endRun(run.runId, (opts.status ?? 'completed') as 'completed' | 'failed');
      return run.runId;
    };
    const first = make();
    const failed = make({ status: 'failed' });
    make({ mode: 'replay', parent: first });
    make({ mode: 'replay', parent: first, meta: { repeat: { group: 'g', attempt: 1, of: 2 } } });
    make({ mode: 'replay', parent: first, meta: { repeat: { group: 'g', attempt: 2, of: 2 } } });
    make({ mode: 'replay', parent: first, meta: { probe: { of: first, callNo: 3, passed: true } } });
    make({ meta: { imported: { at: 1, from: 'goldens/x' } } });
    make({ argv: [NO_COMMAND] });
    const live = make({ status: 'running' });
    recordEvent(store, { kind: 'project.added', ref: 'p' });

    const f = storeFacts(store);
    expect(f.runs).toBe(6);
    expect(f.attempts).toBe(3);
    expect(f.recordings.map((r) => r.runId)).toEqual([live, failed, first]);
    expect(f.live).toBe(true);
    expect(f.addedBefore).toBe(true);
    expect(f.setupEvent).toBeNull();
    store.close();
  });

  it('calls a run marked running long ago not live', () => {
    const store = freshStore();
    store.createRun({ mode: 'record', command: { argv: ['node', 'a.mjs'], cwd: '/x' }, startedAt: Date.now() - 2 * 60 * 60 * 1000 });
    expect(storeFacts(store).live).toBe(false);
    store.close();
  });
});

describe('runTotals', () => {
  it('gives a run’s calls, spend and duration', () => {
    const store = freshStore();
    const run = store.createRun({ mode: 'record', command: { argv: ['node', 'a.mjs'], cwd: '/x' }, startedAt: 1000 });
    store.endRun(run.runId, 'completed', 39_200);
    expect(runTotals(store, run.runId)).toEqual({ runId: run.runId, status: 'completed', calls: 0, spent: 0, durationMs: 38_200 });
    expect(runTotals(store, 'NOPE')).toBeNull();
    store.close();
  });
});
