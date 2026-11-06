import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRowScope } from '../ui/run-row.js';
import { rowStep } from '../ui/run/row-step.js';
import type { JobView, NextStepRow } from '../ui/types.js';
import { addressBar } from './ui-route-helpers.js';

/**
 * ⌘K on a run's row, in its order: Open run, its next step, Replay, Compare, Copy ID, Select run.
 * Replay is the step where it leads, none while the run records; it starts where it is, on the run
 * it replays, unless it asks first, which the run's page does. It carries no key: r presses it on the
 * run's page only.
 */

const RUN = '01M5JEQWA2QMJ3NYD1C687WP08';
const PARENT = '01M5JEQXRGBX1QXGW0X8A3ZB4C';
const BLAME: NextStepRow = { key: 'blame', label: 'Run blame', command: `shadowlap blame ${RUN.slice(0, 10)}` };
const REPLAY: NextStepRow = { key: 'replay', label: 'Replay recording', runId: PARENT, title: `Replays ${PARENT.slice(0, 10)}, the recording this replay came from`, command: `shadowlap replay ${PARENT.slice(0, 10)}` };
const COMPARE: NextStepRow = { key: 'compare', label: 'Compare with parent', href: `#/compare/${PARENT}/${RUN}`, title: `Against ${PARENT.slice(0, 10)}`, command: `shadowlap diff ${PARENT.slice(0, 10)} ${RUN.slice(0, 10)}` };

/** What starts a job, as the app's: the action asked, and the job it watches. */
function starts(answer: () => Promise<JobView>) {
  const action = vi.fn((_runId: string, _key: string, _callNo: number | null) => answer());
  const watchJob = vi.fn();
  return { app: { client: { action } as never, guard: (fn: () => void) => fn(), watchJob }, action, watchJob };
}

function items(o: { next?: NextStepRow | null; replay?: NextStepRow | null; status?: string; app?: ReturnType<typeof starts>['app'] }) {
  const run = { runId: RUN, parentRunId: PARENT, startedAt: 1, mode: 'replay', status: o.status ?? 'completed', next: o.next ?? null, replay: o.replay ?? null };
  const runs = [run, { runId: PARENT, parentRunId: null, startedAt: 0, mode: 'record', status: 'completed' }];
  return runRowScope(run as never, { runs: runs as never, toast: () => undefined, pick: () => undefined, picked: false, pickKey: 'x' }).items(rowStep(null, () => undefined, o.app));
}

const labels = (list: ReturnType<typeof items>) => list.map((x) => x.label);
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { dispatchEvent: () => true });
  addressBar('#/runs');
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('⌘K on a run’s row', () => {
  it('lists Open run, its next step, Replay, Compare, Copy ID and Select run, in that order, only Select run with a key', () => {
    const list = items({ next: BLAME, replay: REPLAY });
    expect(labels(list)).toEqual(['Open run', 'Run blame', 'Replay recording', 'Compare with parent', 'Copy ID', 'Select run']);
    expect(list.filter((x) => x.key).map((x) => [x.label, x.key])).toEqual([['Select run', 'x']]);
    expect(list[2]).toMatchObject({ hint: `shadowlap replay ${PARENT.slice(0, 10)}`, job: true });
  });

  it('has Replay once where it leads, and a step that compares in Compare’s place', () => {
    expect(labels(items({ next: REPLAY }))).toEqual(['Open run', 'Replay recording', 'Compare with parent', 'Copy ID', 'Select run']);
    const list = items({ next: COMPARE, replay: REPLAY });
    expect(labels(list)).toEqual(['Open run', 'Replay recording', 'Compare with parent', 'Copy ID', 'Select run']);
    expect(list[2]).toMatchObject({ hint: COMPARE.command });
  });

  it('has no Replay while the run records', () => {
    expect(labels(items({ status: 'running', next: { key: 'replay', label: 'Replay', off: 'Replay once the recording finishes' } })).filter((l) => l.startsWith('Replay'))).toEqual([]);
    expect(labels(items({ status: 'running', next: BLAME, replay: REPLAY })).filter((l) => l.startsWith('Replay'))).toEqual([]);
  });

  it('starts Replay where it is, on the recording a replay came from, and watches its job', async () => {
    const s = starts(() => Promise.resolve({ id: 'j1' } as JobView));
    items({ next: BLAME, replay: REPLAY, app: s.app })[2]?.run();
    await settle();
    expect(s.action).toHaveBeenCalledWith(PARENT, 'r', null);
    expect(s.watchJob).toHaveBeenCalledTimes(1);
    expect(location.hash).toBe('#/runs');
  });

  it('opens the run for a Replay that asks first: for your command, or whether to run someone else’s', async () => {
    const s = starts(() => Promise.resolve({ id: 'j1' } as JobView));
    items({ next: BLAME, replay: { key: 'replay', label: 'Replay with your command…', runId: RUN }, app: s.app })[2]?.run();
    expect(s.action).not.toHaveBeenCalled();
    expect(location.hash).toBe(`#/run/${RUN}`);
    addressBar('#/runs');
    const asks = starts(() => Promise.reject(Object.assign(new Error('This run came from the team store: it runs node agent.mjs'), { status: 409, confirm: 'node agent.mjs' })));
    items({ next: BLAME, replay: REPLAY, app: asks.app })[2]?.run();
    await settle();
    expect(asks.action).toHaveBeenCalledTimes(1);
    expect(asks.watchJob).not.toHaveBeenCalled();
    expect(location.hash).toBe(`#/run/${RUN}`);
  });
});
