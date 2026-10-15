import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NO_COMMAND, Store, calibrationOutcome, deriveSetup, emptyStoreFacts, initialSetup, laterStage, earlierStage, recordEvent, runTotals, stageAtLeast, storeFacts, type RunFact, type StoreFacts } from '../src/index.js';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function freshStore(): Store {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'sl-setup-')));
  dirs.push(d);
  return Store.open(join(d, 'shadowlap.db'));
}

const fact = (runId: string, status: RunFact['status'] = 'completed', live = status === 'running'): RunFact => ({ runId, status, startedAt: 1, endedAt: status === 'running' ? null : 2, live });
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

  it('passes over a recording that was interrupted, or left running by a process that died', () => {
    const stale = fact('STALE', 'running', false);
    expect(deriveSetup({ stage: 'inspected', runId: 'STALE' }, facts({ runs: 1, recordings: [stale] }))).toEqual({ stage: 'inspected', run: null, live: false, shows: 'overview' });
    const r = deriveSetup({ stage: 'inspected', runId: null }, facts({ runs: 3, recordings: [stale, fact('CRASHED', 'crashed'), fact('OK', 'failed')] }));
    expect(r).toMatchObject({ stage: 'recorded', run: { runId: 'OK' }, live: false });
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
    // The folder a dashboard starts in: any runs there mean it is in use already.
    expect(initialSetup(facts({ runs: 2 }), 0, { inUse: true })).toEqual({ stage: 'done', runId: null, golden: null });
    expect(initialSetup(facts(), 0, { inUse: true })).toEqual({ stage: 'added', runId: null, golden: null });
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
    expect(f.recordings.map((r) => [r.runId, r.live])).toEqual([[live, true], [failed, false], [first, false]]);
    expect(f.live).toBe(true);
    expect(f.addedBefore).toBe(true);
    expect(f.setupEvent).toBeNull();
    store.close();
  });

  it('calls a run marked running long ago not live', () => {
    const store = freshStore();
    store.createRun({ mode: 'record', command: { argv: ['node', 'a.mjs'], cwd: '/x' }, startedAt: Date.now() - 2 * 60 * 60 * 1000 });
    const f = storeFacts(store);
    expect(f.live).toBe(false);
    expect(f.recordings[0]!.live).toBe(false);
    store.close();
  });

  it('lists the setup’s own recording however many came after it', () => {
    const store = freshStore();
    const first = store.createRun({ mode: 'record', command: { argv: ['node', 'a.mjs'], cwd: '/x' }, startedAt: 1000 }).runId;
    store.endRun(first, 'completed');
    for (let i = 0; i < 60; i++) store.endRun(store.createRun({ mode: 'record', command: { argv: ['node', 'a.mjs'], cwd: '/x' }, startedAt: 2000 + i }).runId, 'completed');
    expect(storeFacts(store).recordings.map((r) => r.runId)).not.toContain(first);
    expect(storeFacts(store, Date.now(), { keep: first }).recordings.map((r) => r.runId)).toContain(first);
    expect(deriveSetup({ stage: 'clean', runId: first }, storeFacts(store, Date.now(), { keep: first })).run?.runId).toBe(first);
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

describe('calibrationOutcome', () => {
  const result = (over: Record<string, unknown>) => ({ runId: 'R1', clean: true, rounds: [], normalizers: [], written: false, stopped: null, ...over });
  const uuid = { kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' };

  it('completes the step on its own when the recording replays clean as it is', () => {
    expect(calibrationOutcome(result({}))).toEqual({ done: true, added: [], proposed: [], stopped: null });
  });

  it('offers what it found, and completes the step once that is written', () => {
    expect(calibrationOutcome(result({ normalizers: [uuid] }))).toEqual({ done: false, added: [], proposed: [{ path: '$.metadata.user_id', why: null }], stopped: null });
    expect(calibrationOutcome(result({ normalizers: [uuid, { pattern: 'uuid', replace: '<UUID>', why: 'a value generated on each run' }], written: true }))).toEqual({
      done: true,
      added: [{ path: '$.metadata.user_id', why: null }, { path: '(every string)', why: 'a value generated on each run' }],
      proposed: [],
      stopped: null,
    });
  });

  it('says why it stopped short, and reads nothing else as a result', () => {
    expect(calibrationOutcome(result({ clean: false, stopped: { why: 'still diverging after 8 rounds', details: '' } }))).toEqual({ done: false, added: [], proposed: [], stopped: 'still diverging after 8 rounds' });
    expect(calibrationOutcome(result({ clean: false, normalizers: [uuid], stopped: null }))).toMatchObject({ done: false, proposed: [{ path: '$.metadata.user_id' }], stopped: 'the replay isn’t clean yet' });
    for (const bad of [null, 'clean', { clean: 'yes', normalizers: [] }, { clean: true }]) expect(calibrationOutcome(bad)).toBeNull();
  });
});
