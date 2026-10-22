import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '../ui/api.js';
import { JobDrawer } from '../ui/components/Drawer.js';
import { TopBar } from '../ui/shell/TopBar.js';
import { AppContext, type AppState, type WatchedJob } from '../ui/state.js';
import type { JobListItem, JobView } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * No job could be stopped, and once its drawer was closed a running job couldn't be found again:
 * the stop route existed, but nothing on the page called it. The drawer now has Stop while its job
 * runs, which asks first for a job that changes the working tree, and the top bar counts the jobs
 * running and opens the newest one's drawer again. Rendered as the shell renders them.
 */

const PROJECT = '/work/support-agent';

function job(over: Partial<JobView> = {}): JobView {
  return {
    id: 'a1b2c3d4e5f60718',
    kind: 'test',
    title: 'Running the tests',
    args: ['test', 'goldens/*'],
    worktree: { use: 'reads', doing: 'a test is running your agent from your working tree', folder: PROJECT },
    runId: null,
    opensRun: false,
    startedAt: 1_000,
    done: false,
    stopped: false,
    code: null,
    newRunId: null,
    lines: ['[shadowlap] replaying run 01M5H2FZFYHHRGKXNWV5QA70EW for goldens/01M5GS3E4G'],
    total: 1,
    ...over,
  };
}

const REPAIR = (over: Partial<JobView> = {}) =>
  job({ id: 'f00dfeedf00dfeed', kind: 'repair', title: 'Repairing', args: ['repair', '--fixes', 'fx-01M5GS4YK7'], worktree: { use: 'writes', doing: 'a repair is trying candidates in your working tree', folder: PROJECT }, ...over });

function app(over: Partial<AppState> & { client?: Partial<Client> } = {}): AppState {
  const base = {
    conn: 'ok',
    exported: false,
    meta: { version: null, dbPath: null, actions: true, project: { id: 'support-agent', name: 'support-agent', path: PROJECT } },
    runs: [],
    live: [],
    loadedAt: 0,
    runsTick: 0,
    feeds: {},
    jobs: [],
    actionsOff: null,
    hasKind: () => false,
    guard: (fn: () => void) => fn(),
    toast: () => undefined,
    closeJob: () => undefined,
    openJob: () => undefined,
    sideOpen: false,
    setSideOpen: () => undefined,
    setHelp: () => undefined,
    closeTopLayer: () => false,
    blockingLayer: () => true,
    registerLayer: () => () => undefined,
  };
  return { ...base, ...over } as unknown as AppState;
}

const watched = (j: JobView, open = true): WatchedJob => ({ job: j, lines: j.lines, open });

/** The drawer's header, as a person reads it: the job's title, then how it stands. */
const header = (r: Rendered) => `${r.one('.drawer header b').textContent} · ${r.one('.drawer header .st2').textContent}`;

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

describe('Stop in the job drawer', () => {
  it('stops a job that only runs the agent at once, and says it is stopping until it has', async () => {
    const stopJob = vi.fn(async () => ({ stopped: true }));
    const j = job();
    r = await render(createElement(AppContext.Provider, { value: app({ client: { stopJob } as unknown as Client, jobs: [watched(j)] }) }, createElement(JobDrawer)));
    const stop = r.byText('.drawer header button', 'Stop');
    expect(stop.getAttribute('title')).toBe("Stops shadowlap test 'goldens/*' as Ctrl-C would");
    await r.click(stop);
    expect(stopJob).toHaveBeenCalledWith(j.id);
    // No question asked: nothing in the working tree is left part way.
    expect(r.all('.dialog')).toHaveLength(0);
    expect(r.byText('.drawer header button', 'Stopping…').disabled).toBe(true);
  });

  it('asks first for a job that changes the working tree, and sends nothing until asked to', async () => {
    const stopJob = vi.fn(async () => ({ stopped: true }));
    const j = REPAIR();
    r = await render(createElement(AppContext.Provider, { value: app({ client: { stopJob } as unknown as Client, jobs: [watched(j)] }) }, createElement(JobDrawer)));
    await r.click(r.byText('.drawer header button', 'Stop'));
    expect(r.one('.dialog h3').textContent).toBe('Stop the repair?');
    expect(r.one('.dialog header p').textContent).toContain('puts back the file it changed');
    // Keep it running: the dialog goes, the repair goes on.
    await r.click(r.byText('.dialog button', 'Keep it running'));
    expect(r.all('.dialog')).toHaveLength(0);
    expect(stopJob).not.toHaveBeenCalled();
    await r.click(r.byText('.drawer header button', 'Stop'));
    await r.click(r.byText('.dialog button', 'Stop the repair'));
    expect(stopJob).toHaveBeenCalledWith(j.id);
    expect(r.all('.dialog')).toHaveLength(0);
  });

  it('says a stopped job was stopped, and offers Stop only while a job runs', async () => {
    r = await render(createElement(AppContext.Provider, { value: app({ client: {} as Client, jobs: [watched(job({ done: true, stopped: true, code: 143, endedAt: 2_000 }))] }) }, createElement(JobDrawer)));
    expect(header(r)).toBe('Running the tests · stopped · exit 143');
    expect(r.all('.drawer header button').map((b) => b.textContent)).toEqual(['']);
  });

  it('says so when the job had ended before the stop reached it', async () => {
    const toast = vi.fn();
    const stopJob = vi.fn(async () => ({ stopped: false }));
    r = await render(createElement(AppContext.Provider, { value: app({ client: { stopJob } as unknown as Client, toast, jobs: [watched(job())] }) }, createElement(JobDrawer)));
    await r.click(r.byText('.drawer header button', 'Stop'));
    await r.until('the answer to the stop', () => toast.mock.calls.length > 0);
    expect(toast).toHaveBeenCalledWith('Running the tests had ended already');
  });
});

describe('The top bar’s jobs chip', () => {
  /** A client whose server runs `listed`, and answers what the top bar asks besides. */
  const client = (listed: JobListItem[]) => ({ jobs: vi.fn(async () => listed), teamStore: vi.fn(async () => null), fixes: vi.fn(async () => ({ fixes: [] })) }) as unknown as Client;
  const listedJob = (j: JobView): JobListItem => {
    const { lines: _lines, result: _result, ...item } = j;
    return item;
  };

  it('counts a job started elsewhere, and opens its drawer', async () => {
    const openJob = vi.fn();
    const j = REPAIR();
    r = await render(createElement(AppContext.Provider, { value: app({ client: client([listedJob(j)]), openJob }) }, createElement(TopBar, { route: { page: 'fixes', id: null, step: null, sub: null } })));
    await r.until('the chip', () => r!.all('button.jobchip').length > 0);
    const chip = r.one('button.jobchip');
    expect(chip.textContent).toBe('1 job running');
    expect(chip.getAttribute('title')).toBe('Repairing: open its drawer');
    await r.click(chip);
    expect(openJob).toHaveBeenCalledWith(j.id);
  });

  it('opens the newest job whose drawer is closed, and shows nothing once none is left to find', async () => {
    const openJob = vi.fn();
    const older = job({ id: '0000000000000001', startedAt: 1_000 });
    const newer = REPAIR({ startedAt: 2_000 });
    r = await render(createElement(AppContext.Provider, { value: app({ client: client([listedJob(newer), listedJob(older)]), openJob, jobs: [watched(newer)] }) }, createElement(TopBar, { route: { page: 'tests' } })));
    await r.until('the chip', () => r!.all('button.jobchip').length > 0);
    expect(r.one('button.jobchip').textContent).toBe('2 jobs running');
    // The newest has its drawer open already: the chip opens the other one.
    await r.click(r.one('button.jobchip'));
    expect(openJob).toHaveBeenCalledWith(older.id);
  });

  it('shows no chip while nothing runs', async () => {
    r = await render(createElement(AppContext.Provider, { value: app({ client: client([listedJob(job({ done: true, code: 0 }))]) }) }, createElement(TopBar, { route: { page: 'tests' } })));
    await r.wait(50);
    expect(r.all('button.jobchip')).toHaveLength(0);
  });
});
