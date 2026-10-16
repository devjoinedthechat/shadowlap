import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NO_COMMAND, Store, recordEvent } from '../src/index.js';
import { LIVE_RUN_MS, calibrationOutcome, countRunsAndAttempts, deriveSetup, earlierStage, emptyStoreFacts, initialSetup, isLiveRun, laterStage, readStoreFacts, runTotals, stageAtLeast, storeFacts, type RunFact, type SetupFindings, type StoreFacts } from '../src/projects/index.js';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function freshStore(): Store {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'sl-setup-')));
  dirs.push(d);
  return Store.open(join(d, 'shadowlap.db'));
}

/** Adds `n` calls to a run, as the sidecar records them. */
function addCalls(store: Store, runId: string, n: number): void {
  for (let callNo = 1; callNo <= n; callNo++) store.appendCallStart({ runId, callNo, kind: 'api', name: 'POST /v1/messages', fingerprint: `f${callNo}`, occurrence: 1, origin: 'live', effect: null, requestRef: null, meta: {}, at: Date.now() });
}

const fact = (runId: string, status: RunFact['status'] = 'completed', over: Partial<RunFact> = {}): RunFact => ({ runId, status, startedAt: 1, endedAt: status === 'running' ? null : 2, live: status === 'running', calls: 3, replayedClean: false, ...over });
const facts = (over: Partial<StoreFacts> = {}): StoreFacts => ({ ...emptyStoreFacts(), ...over });
const findings = (at: number, unwrapped: string[]): SetupFindings => ({
  at,
  language: 'Python',
  files: [],
  sdk: null,
  framework: null,
  command: ['python', 'agent.py'],
  commandFrom: null,
  config: { file: 'shadowlap.config.json', created: false, existed: true },
  tools: [
    { name: 'search', effect: 'read', wrapped: true, why: 'declared', file: 'agent.py', line: 1 },
    ...unwrapped.map((name, i) => ({ name, effect: 'write' as const, wrapped: false, why: '"send" changes something', file: 'agent.py', line: 10 + i })),
  ],
  wrap: [],
});

describe('setup stages', () => {
  it('only move forward', () => {
    expect(stageAtLeast('clean', 'recorded')).toBe(true);
    expect(stageAtLeast('inspected', 'recorded')).toBe(false);
    expect(laterStage('recorded', 'inspected')).toBe('recorded');
    expect(earlierStage('done', 'inspected')).toBe('inspected');
  });

  it('call a run live for an hour after it started, and not after', () => {
    const now = 10 * LIVE_RUN_MS;
    expect(isLiveRun({ status: 'running', startedAt: now - LIVE_RUN_MS + 1000 }, now)).toBe(true);
    expect(isLiveRun({ status: 'running', startedAt: now - LIVE_RUN_MS - 1000 }, now)).toBe(false);
    expect(isLiveRun({ status: 'completed', startedAt: now }, now)).toBe(false);
  });
});

describe('deriveSetup', () => {
  it('shows the setup everywhere while a project has no runs', () => {
    expect(deriveSetup({ stage: 'added', runId: null }, facts())).toMatchObject({ stage: 'added', run: null, live: false, shows: 'everywhere', steps: { recorded: false, clean: false, tested: false }, empty: null });
    // A project set up whose runs are all gone starts again from its first steps.
    expect(deriveSetup({ stage: 'done', runId: 'GONE' }, facts())).toMatchObject({ stage: 'inspected', run: null, live: false, shows: 'everywhere' });
    // From inspecting, unless init ran there: a folder counted as set up when a dashboard started in it never was.
    expect(deriveSetup({ stage: 'done', runId: null, findings: null }, facts())).toMatchObject({ stage: 'added', shows: 'everywhere' });
    expect(deriveSetup({ stage: 'done', runId: null, findings: findings(1, []) }, facts())).toMatchObject({ stage: 'inspected', shows: 'everywhere' });
    expect(deriveSetup({ stage: 'inspected', runId: null, findings: null }, facts())).toMatchObject({ stage: 'added' });
  });

  it('counts a recording made in a terminal as the setup’s', () => {
    const r = deriveSetup({ stage: 'inspected', runId: null }, facts({ runs: 1, recordings: [fact('R1')] }));
    expect(r).toMatchObject({ stage: 'recorded', run: fact('R1'), live: false, shows: 'overview', own: false, steps: { recorded: true, clean: false, tested: false } });
  });

  it('follows a recording still being made, and holds the stage until it ends', () => {
    const r = deriveSetup({ stage: 'inspected', runId: 'R2' }, facts({ runs: 1, recordings: [fact('R2', 'running', { calls: 0 })], live: true }));
    expect(r).toMatchObject({ stage: 'inspected', run: { runId: 'R2' }, live: true, shows: 'overview', empty: null });
  });

  it('passes over a recording that was interrupted, or left running by a process that died', () => {
    const stale = fact('STALE', 'running', { live: false });
    expect(deriveSetup({ stage: 'inspected', runId: 'STALE' }, facts({ runs: 1, recordings: [stale] }))).toMatchObject({ stage: 'inspected', run: null, live: false, shows: 'overview' });
    const r = deriveSetup({ stage: 'inspected', runId: null }, facts({ runs: 3, recordings: [stale, fact('CRASHED', 'crashed'), fact('OK', 'failed')] }));
    expect(r).toMatchObject({ stage: 'recorded', run: { runId: 'OK' }, live: false });
  });

  it('never counts a recording with no calls: a typo, or an agent that failed before its first call', () => {
    // `shadowlap run -- nod agent.mjs`: exit 127, nothing recorded.
    const typo = fact('TYPO', 'failed', { calls: 0, startedAt: 5 });
    const r = deriveSetup({ stage: 'inspected', runId: 'TYPO' }, facts({ runs: 1, recordings: [typo] }));
    expect(r).toMatchObject({ stage: 'inspected', run: null, steps: { recorded: false }, empty: { runId: 'TYPO' } });
    // One that exits cleanly before calling its model recorded nothing either.
    expect(deriveSetup({ stage: 'inspected', runId: null }, facts({ runs: 1, recordings: [fact('QUIET', 'completed', { calls: 0 })] }))).toMatchObject({ run: null, empty: { runId: 'QUIET' } });
    // An earlier recording with calls stays the setup's, and the empty one is pointed out.
    const earlier = fact('R1', 'completed', { startedAt: 1 });
    expect(deriveSetup({ stage: 'recorded', runId: 'R1' }, facts({ runs: 2, recordings: [typo, earlier] }))).toMatchObject({ stage: 'recorded', run: { runId: 'R1' }, own: true, empty: { runId: 'TYPO' } });
  });

  it('follows the newest recording until the replay is clean: recording again replaces the first', () => {
    const r1 = fact('R1', 'completed', { startedAt: 10 });
    const r2 = fact('R2', 'completed', { startedAt: 20 });
    // R2 recorded in a terminal after wrapping the tools: the setup moves to it.
    const again = deriveSetup({ stage: 'recorded', runId: 'R1' }, facts({ runs: 2, recordings: [r2, r1] }));
    expect(again).toMatchObject({ stage: 'recorded', run: { runId: 'R2' }, own: false });
    // Once the list says the named one was calibrated, it stays the setup's.
    const pinned = deriveSetup({ stage: 'clean', runId: 'R1', calibration: { added: [] } }, facts({ runs: 2, recordings: [r2, r1] }));
    expect(pinned).toMatchObject({ stage: 'clean', run: { runId: 'R1' }, own: true, steps: { clean: true } });
  });

  it('honours what the list made only for the recording it names', () => {
    const r3 = fact('R3', 'completed', { startedAt: 30 });
    // The calibrated recording was deleted: its calibration and golden don't carry over to another one.
    const r = deriveSetup({ stage: 'tested', runId: 'DELETED', calibration: { added: [{ path: '$.system', why: null }] }, golden: 'goldens/agent' }, facts({ runs: 1, recordings: [r3] }));
    expect(r).toMatchObject({ stage: 'recorded', run: { runId: 'R3' }, own: false, steps: { recorded: true, clean: false, tested: false }, golden: null });
  });

  it('works out which tools weren’t wrapped when the recording was made', () => {
    const r1 = fact('R1', 'completed', { startedAt: 100 });
    const r2 = fact('R2', 'completed', { startedAt: 300 });
    const inspections = [
      { at: 50, unwrapped: ['save_report', 'notify_slack'] },
      { at: 200, unwrapped: [] },
    ];
    const state = { stage: 'recorded' as const, runId: 'R1', inspections, findings: findings(200, []) };
    expect(deriveSetup(state, facts({ runs: 1, recordings: [r1] })).unwrappedAtRecord).toEqual(['save_report', 'notify_slack']);
    // Recorded again after the tools were wrapped and checked again: nothing missing.
    expect(deriveSetup(state, facts({ runs: 2, recordings: [r2, r1] })).unwrappedAtRecord).toEqual([]);
    // Findings alone (a list from before inspections were kept) say it too.
    expect(deriveSetup({ stage: 'recorded', runId: null, findings: findings(50, ['send_email']) }, facts({ runs: 1, recordings: [r1] })).unwrappedAtRecord).toEqual(['send_email']);
    // A tool the recording called was wrapped by then, whatever init said before.
    expect(deriveSetup(state, facts({ runs: 1, recordings: [{ ...r1, tools: ['save_report', 'search'] }] })).unwrappedAtRecord).toEqual(['notify_slack']);
    // Inspected only after the recording: unknown, unless the list noted it when recording started.
    expect(deriveSetup({ stage: 'recorded', runId: 'R1', findings: findings(500, ['x']) }, facts({ runs: 1, recordings: [r1] })).unwrappedAtRecord).toEqual([]);
    expect(deriveSetup({ stage: 'recorded', runId: 'R1', unwrappedAtRecord: ['x'] }, facts({ runs: 1, recordings: [r1] })).unwrappedAtRecord).toEqual(['x']);
  });

  it('counts a clean replay of the recording as step 3, and a pack of it in the repository whose test passed as step 4', () => {
    const replayed = fact('R1', 'completed', { replayedClean: true });
    expect(deriveSetup({ stage: 'inspected', runId: null }, facts({ runs: 2, recordings: [replayed] }))).toMatchObject({ stage: 'clean', steps: { recorded: true, clean: true, tested: false } });
    const packs = [{ path: 'goldens/other', runIds: ['OTHER'] }, { path: 'goldens/agent', runIds: ['R1'] }];
    // Packed is not tested: the golden is known, its test hasn't run.
    const packed = deriveSetup({ stage: 'recorded', runId: 'R1' }, facts({ runs: 1, recordings: [fact('R1')] }), { packs });
    expect(packed).toMatchObject({ stage: 'recorded', steps: { recorded: true, clean: false, tested: false }, golden: 'goldens/agent', goldenTest: null });
    // Its test failed, then passed: the newest result decides.
    const test = (ok: boolean, over: object = {}) => ({ golden: 'goldens/agent', ok, at: 5, reason: ok ? null : 'diverged at call 2', goldenRunId: 'R1', ...over });
    expect(deriveSetup({ stage: 'recorded', runId: 'R1' }, facts({ runs: 1, recordings: [fact('R1')], tests: [test(false)] }), { packs })).toMatchObject({ stage: 'recorded', steps: { tested: false }, goldenTest: { ok: false, reason: 'diverged at call 2' } });
    expect(deriveSetup({ stage: 'recorded', runId: 'R1' }, facts({ runs: 1, recordings: [fact('R1')], tests: [test(true)] }), { packs })).toMatchObject({ stage: 'tested', steps: { recorded: true, tested: true }, golden: 'goldens/agent', goldenTest: { ok: true } });
    // A test of another recording packed under the same name says nothing about this one.
    expect(deriveSetup({ stage: 'recorded', runId: 'R1' }, facts({ runs: 1, recordings: [fact('R1')], tests: [test(true, { goldenRunId: 'OLD' })] }), { packs })).toMatchObject({ steps: { tested: false }, goldenTest: null });
    // Tested from the setup, noted in the list, with no result in the store: the list's word for it.
    expect(deriveSetup({ stage: 'tested', runId: 'R1', golden: 'goldens/q3' }, facts({ runs: 1, recordings: [fact('R1')] }))).toMatchObject({ stage: 'tested', golden: 'goldens/q3', goldenTest: null });
    // The store's newest result wins over the list (which got as far as a clean replay before).
    expect(deriveSetup({ stage: 'tested', runId: 'R1', golden: 'goldens/q3' }, facts({ runs: 1, recordings: [fact('R1')], tests: [test(false, { golden: 'goldens/q3' })] }))).toMatchObject({ stage: 'clean', steps: { clean: true, tested: false } });
  });

  it('reads each golden’s newest test from the store, open or read-only', () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'sl-setup-tests-')));
    dirs.push(d);
    const path = join(d, 'shadowlap.db');
    const store = Store.open(path);
    const session = store.startTestSession({ command: ['shadowlap', 'test'], revision: null, actor: null });
    store.addTestResult({ sessionId: session.sessionId, golden: 'goldens/agent', ok: false, at: 10, reason: 'diverged', goldenRunId: 'R1' });
    const later = store.startTestSession({ command: ['shadowlap', 'test'], revision: null, actor: null });
    store.addTestResult({ sessionId: later.sessionId, golden: 'goldens/agent', ok: true, at: 20, goldenRunId: 'R1' });
    const expected = [{ golden: 'goldens/agent', ok: true, at: 20, reason: null, goldenRunId: 'R1' }];
    expect(storeFacts(store).tests).toEqual(expected);
    store.close();
    expect(readStoreFacts(path).tests).toEqual(expected);
  });

  it('is done once finished, with runs; a project with imports only is still set up', () => {
    expect(deriveSetup({ stage: 'done', runId: null }, facts({ runs: 3 }))).toMatchObject({ stage: 'done', run: null, live: false, shows: 'none', steps: { recorded: false, clean: false, tested: false } });
    expect(deriveSetup({ stage: 'tested', runId: 'R', golden: 'goldens/x' }, facts({ runs: 1, recordings: [fact('R')] })).shows).toBe('overview');
    // Finished: each step done only when there is something to show for it.
    const finished = deriveSetup({ stage: 'done', runId: 'R', calibration: { added: [] }, golden: null }, facts({ runs: 1, recordings: [fact('R')] }));
    expect(finished).toMatchObject({ stage: 'done', steps: { recorded: true, clean: true, tested: false }, golden: null });
    // Finished with its golden packed and tested: done. Skipped before the test passed: not, until one does.
    const packs = [{ path: 'goldens/x', runIds: ['R'] }];
    expect(deriveSetup({ stage: 'done', runId: 'R', golden: 'goldens/x' }, facts({ runs: 1, recordings: [fact('R')] }), { packs }).steps.tested).toBe(true);
    expect(deriveSetup({ stage: 'done', runId: 'R', golden: 'goldens/x', skipped: true }, facts({ runs: 1, recordings: [fact('R')] }), { packs }).steps.tested).toBe(false);
    const passing = facts({ runs: 1, recordings: [fact('R')], tests: [{ golden: 'goldens/x', ok: true, at: 9, reason: null, goldenRunId: 'R' }] });
    expect(deriveSetup({ stage: 'done', runId: 'R', golden: 'goldens/x', skipped: true }, passing, { packs }).steps.tested).toBe(true);
  });
});

describe('initialSetup', () => {
  it('brings a finished setup back from the store, or counts recordings with goldens as set up', () => {
    const store = freshStore();
    recordEvent(store, { kind: 'project.setup', runId: 'R1', data: { stage: 'done', golden: 'goldens/refund' } });
    expect(initialSetup(storeFacts(store), 0)).toEqual({ stage: 'done', runId: 'R1', golden: 'goldens/refund' });
    expect(initialSetup(facts({ runs: 1, recordings: [fact('R')] }), 2)).toEqual({ stage: 'done', runId: null, golden: null });
    // Recordings that hold nothing don't make a project set up.
    expect(initialSetup(facts({ runs: 1, recordings: [fact('R', 'failed', { calls: 0 })] }), 2)).toEqual({ stage: 'added', runId: null, golden: null });
    expect(initialSetup(facts({ runs: 1, recordings: [fact('R')] }), 0)).toEqual({ stage: 'added', runId: null, golden: null });
    expect(initialSetup(facts(), 3)).toEqual({ stage: 'added', runId: null, golden: null });
    // The folder a dashboard starts in: any runs there mean it is in use already.
    expect(initialSetup(facts({ runs: 2 }), 0, { inUse: true })).toEqual({ stage: 'done', runId: null, golden: null });
    expect(initialSetup(facts(), 0, { inUse: true })).toEqual({ stage: 'added', runId: null, golden: null });
    // Closed, or Windows can't delete its folder afterwards: an open database file can't be removed there.
    store.close();
  });

  it('takes only a project.setup event that finished the setup as finished', () => {
    // `init` logs writing the config under the same kind: that is a step, not a finished setup.
    const store = freshStore();
    recordEvent(store, { kind: 'project.setup', ref: 'agent', data: { name: 'agent', config: 'created', languages: ['python'] } });
    expect(storeFacts(store).setupEvent).toBeNull();
    expect(initialSetup(storeFacts(store), 0)).toEqual({ stage: 'added', runId: null, golden: null });
    recordEvent(store, { kind: 'project.setup', runId: 'R1', data: { stage: 'done', name: 'agent', skipped: true, golden: null } });
    recordEvent(store, { kind: 'project.setup', ref: 'agent', data: { name: 'agent', config: 'created' } });
    expect(storeFacts(store).setupEvent).toMatchObject({ runId: 'R1', data: { stage: 'done' } });
    expect(initialSetup(storeFacts(store), 0)).toEqual({ stage: 'done', runId: 'R1', golden: null });
    store.close();
  });
});

describe('storeFacts', () => {
  it('counts runs and attempts apart, and lists only recordings made here, with their calls', () => {
    const store = freshStore();
    const make = (opts: { mode?: 'record' | 'replay'; parent?: string; meta?: Record<string, unknown>; argv?: string[]; status?: 'completed' | 'failed' | 'running'; calls?: number } = {}) => {
      const run = store.createRun({ mode: opts.mode ?? 'record', command: { argv: opts.argv ?? ['node', 'agent.mjs'], cwd: '/x' }, ...(opts.parent ? { parentRunId: opts.parent } : {}), ...(opts.meta ? { meta: opts.meta } : {}) });
      addCalls(store, run.runId, opts.calls ?? 2);
      if ((opts.status ?? 'completed') !== 'running') store.endRun(run.runId, (opts.status ?? 'completed') as 'completed' | 'failed');
      return run.runId;
    };
    const first = make();
    const failed = make({ status: 'failed', calls: 0 });
    make({ mode: 'replay', parent: first });
    make({ mode: 'replay', parent: first, meta: { repeat: { group: 'g', attempt: 1, of: 2 } } });
    make({ mode: 'replay', parent: first, meta: { repeat: { group: 'g', attempt: 2, of: 2 } } });
    make({ mode: 'replay', parent: first, meta: { probe: { of: first, callNo: 3, passed: true } } });
    make({ meta: { imported: { at: 1, from: 'goldens/x' } } });
    make({ argv: [NO_COMMAND] });
    const live = make({ status: 'running', calls: 1 });
    recordEvent(store, { kind: 'project.added', ref: 'p' });

    const f = storeFacts(store);
    expect(f.runs).toBe(6);
    expect(f.attempts).toBe(3);
    expect(f.recordings.map((r) => [r.runId, r.live, r.calls, r.replayedClean])).toEqual([
      [live, true, 1, false],
      [failed, false, 0, false],
      [first, false, 2, true],
    ]);
    expect(f.live).toBe(true);
    expect(f.addedBefore).toBe(true);
    expect(f.setupEvent).toBeNull();
    store.close();
  });

  it('counts runs and attempts as the status bar does: a rescued fork and an attempt whose run is gone are runs', () => {
    const store = freshStore();
    const make = (opts: { mode?: 'record' | 'replay'; parent?: string; meta?: Record<string, unknown> } = {}) => {
      const run = store.createRun({ mode: opts.mode ?? 'record', command: { argv: ['node', 'agent.mjs'], cwd: '/x' }, ...(opts.parent ? { parentRunId: opts.parent } : {}), ...(opts.meta ? { meta: opts.meta } : {}) });
      store.endRun(run.runId, 'completed');
      return run.runId;
    };
    const failed = make();
    const rescued = make({ mode: 'replay', parent: failed, meta: { probe: { of: failed, callNo: 3, passed: true } } });
    make({ mode: 'replay', parent: failed, meta: { probe: { of: failed, callNo: 3, passed: false } } });
    store.updateRunMeta(failed, { blame: { at: 1, outcome: 'blamed', callNo: 3, rescuedRunId: rescued } } as never);
    // A verify attempt of a run since deleted, and a test run (never an attempt).
    const gone = make();
    make({ mode: 'replay', parent: gone, meta: { verify: { role: 'target', passed: true } } });
    store.deleteRun(gone);
    make({ mode: 'replay', parent: failed, meta: { test: { golden: 'goldens/x', session: 's1' } } });
    expect(countRunsAndAttempts(store.allRuns())).toEqual({ runs: 4, attempts: 1 });
    expect(storeFacts(store)).toMatchObject({ runs: 4, attempts: 1 });
    store.close();
  });

  it('counts a replay as clean only when it ended as the recording did, without a divergence and with calls', () => {
    const store = freshStore();
    const record = (status: 'completed' | 'failed') => {
      const r = store.createRun({ mode: 'record', command: { argv: ['node', 'a.mjs'], cwd: '/x' } });
      addCalls(store, r.runId, 2);
      store.endRun(r.runId, status);
      return r.runId;
    };
    const replay = (parent: string, status: 'completed' | 'failed', opts: { calls?: number; diverged?: boolean } = {}) => {
      const r = store.createRun({ mode: 'replay', parentRunId: parent, command: { argv: ['node', 'a.mjs'], cwd: '/x' } });
      addCalls(store, r.runId, opts.calls ?? 2);
      if (opts.diverged) store.setDivergence(r.runId, { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0 });
      store.endRun(r.runId, status);
    };
    const forked = record('completed');
    replay(forked, 'completed', { diverged: true });
    const noCalls = record('completed');
    replay(noCalls, 'completed', { calls: 0 });
    const exitsWithError = record('failed');
    replay(exitsWithError, 'failed');
    const otherEnding = record('completed');
    replay(otherEnding, 'failed');
    const byId = new Map(storeFacts(store).recordings.map((r) => [r.runId, r.replayedClean]));
    expect([byId.get(forked), byId.get(noCalls), byId.get(exitsWithError), byId.get(otherEnding)]).toEqual([false, false, true, false]);
    store.close();
  });

  it('lists the tools the newest recording and the setup’s own called, from a store or read without changing it', () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'sl-setup-tools-')));
    dirs.push(d);
    const db = join(d, 'shadowlap.db');
    const store = Store.open(db);
    const recordWith = (tools: string[], startedAt: number) => {
      const r = store.createRun({ mode: 'record', command: { argv: ['node', 'a.mjs'], cwd: d }, startedAt });
      addCalls(store, r.runId, 1);
      tools.forEach((name, i) => store.appendCallStart({ runId: r.runId, callNo: 2 + i, kind: 'tool', name, fingerprint: `t${i}`, occurrence: 1, origin: 'live', effect: 'write', requestRef: null, meta: {}, at: startedAt }));
      store.endRun(r.runId, 'completed');
      return r.runId;
    };
    const own = recordWith(['search'], 1000);
    recordWith(['notify_slack'], 2000);
    const newest = recordWith(['save_report', 'save_report', 'search'], 3000);
    for (const f of [storeFacts(store, Date.now(), { keep: own }), readStoreFacts(db, Date.now(), { keep: own })]) {
      expect(f.recordings.map((r) => [r.runId === newest ? 'newest' : r.runId === own ? 'own' : 'middle', r.tools?.sort()])).toEqual([
        ['newest', ['save_report', 'search']],
        ['middle', undefined],
        ['own', ['search']],
      ]);
    }
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
    addCalls(store, first, 1);
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
    for (const bad of [null, 'clean', { clean: 'yes', normalizers: [] }, { clean: true }, []]) expect(calibrationOutcome(bad)).toBeNull();
  });

  it('reads why each value varies from the proposals beside the normalizers, which stay as the config takes them', () => {
    const system = { kind: 'api', path: '$.system', replace: '<VALUE>' };
    const proposals = [
      { normalizer: uuid, why: 'this looks like a UUID' },
      { normalizer: system, why: 'a value generated on each run' },
    ];
    expect(calibrationOutcome(result({ normalizers: [uuid, system], proposals }))).toEqual({
      done: false,
      added: [],
      proposed: [
        { path: '$.metadata.user_id', why: 'this looks like a UUID' },
        { path: '$.system', why: 'a value generated on each run' },
      ],
      stopped: null,
    });
    // A reason for another normalizer than the one at its place isn't taken.
    expect(calibrationOutcome(result({ normalizers: [system], proposals: [proposals[0]] }))?.proposed).toEqual([{ path: '$.system', why: null }]);
  });

  it('counts what a calibrate run with --write proposed as in the config, even when it found it there already', () => {
    // Calibrate may say it wrote nothing new (`written: false`, `added: []`) when the rule was in the config already.
    const already = result({ normalizers: [uuid], written: false, added: [] });
    expect(calibrationOutcome(already)).toMatchObject({ done: false, proposed: [{ path: '$.metadata.user_id' }] });
    expect(calibrationOutcome(already, { write: true })).toEqual({ done: true, added: [{ path: '$.metadata.user_id', why: null }], proposed: [], stopped: null });
    // Stopped short with --write: what it found is in the config, and the step isn't done.
    expect(calibrationOutcome(result({ clean: false, normalizers: [uuid], stopped: { why: 'a change Shadowlap cannot tell apart from a real one' } }), { write: true })).toEqual({ done: false, added: [{ path: '$.metadata.user_id', why: null }], proposed: [], stopped: 'a change Shadowlap cannot tell apart from a real one' });
  });
});
