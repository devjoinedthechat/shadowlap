import { act, createElement, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '../ui/api.js';
import { RECORD_ASK } from '../ui/page-ask.js';
import { RunsPage } from '../ui/pages/Runs.js';
import '../ui/palette-actions.js';
import { paletteSources, type PaletteContext } from '../ui/palette-sources.js';
import type { RecordConfirmation, RecordPlanView, SetupView } from '../ui/projects-api.js';
import { RecordRunAsks } from '../ui/runspage/RecordRun.js';
import { PULL_TIP, PUSH_TIP, RunsActions } from '../ui/runspage/RunsActions.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { TeamStoreView } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Runs' eyebrow names the project and the store its runs are kept in, `support-agent · local store`
 * or `· team store`, as the Overview's names the project and its week. Until the store has
 * answered, the project alone, so a team's project never reads `local store` first.
 */

const TEAM = { url: 's3://acme-runs/agents', key: 'k', configured: 's3://acme-runs/agents', provider: 's3', providerName: 'Amazon S3', bucket: 'acme-runs', prefix: 'agents', account: null, region: null, name: 'acme-runs', pushedAt: null, pulledAt: null, syncedAt: null, inStore: 0, onlyLocal: 0, localRuns: [], localAttempts: 0, queued: 0, check: null, access: 'write', ciPush: false, you: null } as unknown as TeamStoreView;

function page(store: Promise<TeamStoreView | null>) {
  const client = {
    exported: false,
    runsPage: () => Promise.resolve({ runs: [], total: 0, next: null, chipCounts: { all: 0, recording: 0, fork: 0, clean: 0, test: 0, capture: 0, failed: 0, local: 0 } }),
    runsByDay: () => new Promise(() => undefined),
    teamStore: () => store,
    knownRuns: (ids: string[]) => Promise.resolve(ids),
  } as unknown as Client;
  const app = { client, exported: false, meta: { project: { name: 'support-agent', path: '/work/support-agent' } }, tick: 0, runsTick: 0, feeds: {}, actionsOff: null, hasKind: () => false, guard: (fn: () => void) => fn(), watchJob: () => undefined, toast: () => undefined, refresh: () => undefined } as unknown as AppState;
  return createElement(AppContext.Provider, { value: app }, createElement(RunsPage, {}));
}

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

const eyebrow = () => r!.one('.eyebrow').textContent;

describe('the Runs page’s eyebrow', () => {
  it('names the project alone until the store answers, then its local store', async () => {
    let answer: (v: TeamStoreView | null) => void = () => undefined;
    r = await render(page(new Promise((done) => (answer = done))));
    expect(eyebrow()).toBe('support-agent');
    answer(null);
    await r.until('the store’s answer', () => eyebrow() !== 'support-agent');
    expect(eyebrow()).toBe('support-agent · local store');
  });

  it('says team store where the project has one', async () => {
    r = await render(page(Promise.resolve(TEAM)));
    await r.until('the store’s answer', () => eyebrow() !== 'support-agent');
    expect(eyebrow()).toBe('support-agent · team store');
  });
});

describe('Runs’ header actions', () => {
  let setStore: (s: TeamStoreView | null) => void = () => undefined;
  const recordAsked = vi.fn();
  function Holder({ first }: { first: TeamStoreView | null }) {
    const [store, set] = useState(first);
    setStore = set;
    return createElement(RunsActions, { store, onImport: () => undefined, onRecord: recordAsked });
  }
  function actions(store: TeamStoreView | null, over: Partial<AppState> = {}) {
    const startJob = vi.fn(() => Promise.resolve({ id: 'j1' }));
    recordAsked.mockClear();
    const app = { client: { startJob } as unknown as Client, actionsOff: null, hasKind: () => true, guard: (fn: () => void) => fn(), watchJob: () => undefined, ...over } as unknown as AppState;
    return { startJob, element: createElement(AppContext.Provider, { value: app }, createElement(Holder, { first: store })) };
  }
  const labels = () => r!.all('button').map((b) => b.textContent);

  it('are Pull, Record run…, Import capture… and Push local runs in lime while runs are only here, each card saying its command', async () => {
    const a = actions({ ...TEAM, onlyLocal: 3 });
    r = await render(a.element);
    expect(labels()).toEqual(['Pull', 'Record run…', 'Import capture…', 'Push local runs']);
    const push = r.all('button')[3];
    expect(push.className).toBe('btn lime');
    expect(push.getAttribute('data-tip')).toBe(PUSH_TIP);
    expect(JSON.parse(PUSH_TIP)).toEqual({ t: 'Push local runs', s: 'Copies them to the store with your credentials; nothing passes through shadowlap', rows: [], cmd: '$ shadowlap push --all' });
    expect(JSON.parse(r.all('button')[0].getAttribute('data-tip')!)).toEqual(JSON.parse(PULL_TIP));
    expect(JSON.parse(PULL_TIP)).toMatchObject({ t: 'Pull', s: 'Teammates’ runs from the store', cmd: '$ shadowlap pull' });
    await r.click(push);
    expect(a.startJob).toHaveBeenCalledWith('push', { all: true });
  });

  it('show no Push once every run is in the store, nor Pull without one', async () => {
    r = await render(actions(TEAM).element);
    expect(labels()).toEqual(['Pull', 'Record run…', 'Import capture…']);
    await r.unmount();
    r = await render(actions(null).element);
    expect(labels()).toEqual(['Record run…', 'Import capture…']);
  });

  it('offer Record run… where the dashboard records, its press asking for its dialog, and none where it records nothing', async () => {
    r = await render(actions(null).element);
    await r.click(r.byText('button', 'Record run…'));
    expect(recordAsked).toHaveBeenCalledTimes(1);
    await r.unmount();
    r = await render(actions(null, { hasKind: (kind: string) => kind !== 'record' }).element);
    expect(labels()).toEqual(['Import capture…']);
  });

  it('wait on a dashboard that changes nothing, each card saying why and a press starting nothing', async () => {
    const toast = vi.fn();
    const a = actions({ ...TEAM, onlyLocal: 1 }, { actionsOff: 'This dashboard is read-only', toast });
    r = await render(a.element);
    expect(labels()).toEqual(['Pull', 'Record run…', 'Import capture…', 'Push local runs']);
    for (const b of r.all('button')) {
      expect(b.getAttribute('aria-disabled')).toBe('true');
      expect(b.getAttribute('data-why')).toBe('This dashboard is read-only');
      expect(b.getAttribute('title')).toBeNull();
      expect(JSON.parse(b.getAttribute('data-tip')!)).toMatchObject({ t: b.textContent, s: 'This dashboard is read-only' });
    }
    expect(r.all('button')[3].className).toBe('btn');
    await r.click(r.all('button')[3]);
    await r.click(r.all('button')[1]);
    expect(a.startJob).not.toHaveBeenCalled();
    expect(recordAsked).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('This dashboard is read-only', 'notice', undefined);
  });

  it('hand Push’s focus to Import capture… when its runs are in the store', async () => {
    r = await render(actions({ ...TEAM, onlyLocal: 2 }).element);
    const push = r.all('button')[3];
    await r.click(push);
    expect(r.focused()).toBe(push);
    await act(async () => setStore(TEAM));
    expect(labels()).toEqual(['Pull', 'Record run…', 'Import capture…']);
    expect(r.focused().textContent).toBe('Import capture…');
  });
});

/**
 * Record run…, on Runs and in the palette: the setup's Record, on a project at any stage. Its field
 * starts from the command the setup records with; Record run plans it as the setup does, asks first
 * in the setup's own dialog where the folder never ran it, and starts the record job the drawer
 * follows.
 */
const COMMAND = 'node agent.mjs';
const PROJECT = 'support-agent';
/** What `POST /api/setup/record` answers for a command this folder ran before (engine record.ts `planRecording`). */
const KNOWN: RecordPlanView = { display: `shadowlap run -- ${COMMAND}`, argv: ['node', 'agent.mjs'], confirm: null };
/** And for one it never ran. */
const FIRST: RecordConfirmation = { title: 'Record run in ~/support-agent', lead: 'Records one run: every model and tool call.', moved: null, calls: { value: 'the real API, with your keys', quiet: 'never stored' }, command: `shadowlap run -- ${COMMAND}`, button: 'Record run' };

function asks(o: { setup?: () => Promise<Partial<SetupView> | null>; plan?: (project: string, command: string) => Promise<RecordPlanView>; jobs?: unknown[] } = {}) {
  const startJob = vi.fn((_kind: string, _fields: Record<string, unknown>) => Promise.resolve({ id: 'j1', kind: 'record' }));
  const planRecording = vi.fn(o.plan ?? (() => Promise.resolve(KNOWN)));
  const watchJob = vi.fn();
  const onClose = vi.fn();
  const client = { exported: false, startJob, jobs: () => Promise.resolve(o.jobs ?? []), projects: { setup: o.setup ?? (() => Promise.resolve({ command: COMMAND })), planRecording } } as unknown as Client;
  const app = { client, exported: false, actionsOff: null, conn: 'ok', meta: { project: { id: PROJECT, name: PROJECT, path: '/work/support-agent' } }, feeds: {}, jobs: [], hasKind: () => true, guard: (fn: () => void) => (fn(), true), toast: () => undefined, watchJob } as unknown as AppState;
  return { startJob, planRecording, watchJob, onClose, element: createElement(AppContext.Provider, { value: app }, createElement(RecordRunAsks, { onClose })) };
}

const field = () => r!.one('[role="dialog"] input[type="text"]') as unknown as { value: string };
const title = () => r!.one('[role="dialog"] h3').textContent.replace(/\u00a0/g, ' ');
const said = (selector: string) => r!.one(`[role="dialog"] ${selector}`).textContent.replace(/\u00a0/g, ' ');

describe('Record run…', () => {
  it('starts from the command the setup records with, and shows the command it runs and that your provider bills it', async () => {
    const a = asks();
    r = await render(a.element);
    await r.until('the setup’s command', () => field().value === COMMAND);
    expect(title()).toBe('Record run');
    expect(said('.cmdline')).toBe(`$shadowlap run -- ${COMMAND}`);
    expect(said('.dcost')).toBe('Billed by your provider · the agent’s own model calls');
    expect(said('.dlg-ok')).toBe('Record run');
    // The command shown follows what is typed.
    await r.type(r.one('[role="dialog"] input[type="text"]'), 'uv run agent.py');
    expect(said('.cmdline')).toBe('$shadowlap run -- uv run agent.py');
  });

  it('keeps what you typed before the setup answered', async () => {
    let answer: (v: Partial<SetupView>) => void = () => undefined;
    r = await render(asks({ setup: () => new Promise((done) => (answer = done)) }).element);
    await r.type(r.one('[role="dialog"] input[type="text"]'), 'uv run agent.py');
    answer({ command: COMMAND });
    await r.wait(0);
    expect(field().value).toBe('uv run agent.py');
  });

  it('records a command this folder ran before at once, the job the drawer follows', async () => {
    const a = asks();
    r = await render(a.element);
    await r.until('the setup’s command', () => field().value === COMMAND);
    await r.click(r.one('[role="dialog"] .dlg-ok'));
    await r.until('the job', () => a.startJob.mock.calls.length === 1);
    expect(a.planRecording).toHaveBeenCalledWith(PROJECT, COMMAND);
    expect(a.startJob).toHaveBeenCalledWith('record', { project: PROJECT, command: COMMAND });
    await r.until('closed', () => a.onClose.mock.calls.length === 1);
    expect(a.watchJob).toHaveBeenCalledTimes(1);
  });

  it('asks first, in the setup’s own dialog, the first time this folder runs the command, and records once you say yes', async () => {
    const a = asks({ plan: () => Promise.resolve({ ...KNOWN, confirm: FIRST }) });
    r = await render(a.element);
    await r.until('the setup’s command', () => field().value === COMMAND);
    await r.click(r.one('[role="dialog"] .dlg-ok'));
    await r.until('the ask', () => title() === 'Record run in ~/support-agent');
    expect(a.startJob).not.toHaveBeenCalled();
    expect(said('.cmdline')).toBe(`$shadowlap run -- ${COMMAND}`);
    await r.click(r.one('[role="dialog"] .dlg-ok'));
    await r.until('the job', () => a.startJob.mock.calls.length === 1);
    expect(a.startJob).toHaveBeenCalledWith('record', { project: PROJECT, command: COMMAND, confirmed: true });
  });

  it('keeps what you typed and says why where the server refuses it, starting nothing', async () => {
    const a = asks({ plan: () => Promise.reject(new Error('A single quote is never closed.')) });
    r = await render(a.element);
    await r.until('the setup’s command', () => field().value === COMMAND);
    await r.type(r.one('[role="dialog"] input[type="text"]'), "node agent.mjs 'hi");
    await r.click(r.one('[role="dialog"] .dlg-ok'));
    await r.until('the refusal', () => r!.all('[role="dialog"] .dwarn').length === 1);
    expect(said('.dwarn')).toBe('A single quote is never closed.');
    expect(field().value).toBe("node agent.mjs 'hi");
    expect(a.startJob).not.toHaveBeenCalled();
    expect(a.onClose).not.toHaveBeenCalled();
  });

  it('waits while a repair holds your working tree, as the server would refuse it', async () => {
    const repair = { id: 'j0', kind: 'repair', done: false, args: ['repair'], worktree: { use: 'writes', doing: 'a repair is verifying candidates made from your working tree', folder: '/work/support-agent' } };
    const a = asks({ jobs: [repair] });
    r = await render(a.element);
    await r.until('the repair', () => r!.one('[role="dialog"] .dlg-ok').getAttribute('aria-disabled') === 'true');
    expect(r.one('[role="dialog"] .dlg-ok').getAttribute('data-why')).toBe('A repair is verifying candidates made from your working tree: record once it is done.');
    await r.click(r.one('[role="dialog"] .dlg-ok'));
    expect(a.planRecording).not.toHaveBeenCalled();
  });

  it('starts from an empty field where the setup knows no command, Record run waiting for one', async () => {
    r = await render(asks({ setup: () => Promise.resolve({ command: null }) }).element);
    await r.wait(0);
    expect(field().value).toBe('');
    expect(said('.cmdline')).toBe('$shadowlap run -- <the command that starts your agent>');
    expect((r.one('[role="dialog"] .dlg-ok') as unknown as { disabled: boolean }).disabled).toBe(true);
  });
});

describe('Record run… in the palette', () => {
  const rows = (ctx: PaletteContext) =>
    paletteSources()
      .flatMap((source) => {
        try {
          return source(ctx);
        } catch {
          return [];
        }
      })
      .filter((x) => x.label === 'Record run…');
  const ctx = (app: Partial<AppState>, go: (to: string) => void = () => undefined) => ({ app: { exported: false, actionsOff: null, hasKind: () => true, guard: (fn: () => void) => (fn(), true), jobs: [], meta: { project: { id: PROJECT, path: '/work/support-agent' } }, client: { jobs: () => new Promise(() => undefined) }, ...app }, route: { page: 'overview' }, go }) as unknown as PaletteContext;

  it('is an action where the dashboard records, opening Runs to ask there', async () => {
    const went: string[] = [];
    const [row] = rows(ctx({}, (to) => void went.push(to)));
    expect(row).toMatchObject({ group: 'Actions', label: 'Record run…', hint: 'shadowlap run -- <command>', job: true });
    // The page's window, which an ask goes through.
    r = await render(createElement('div'));
    let asked = false;
    const stop = RECORD_ASK.on(() => (asked = true));
    row.run();
    stop();
    expect([asked, went]).toEqual([true, ['#/runs']]);
  });

  it('is not offered where the dashboard records nothing, nor in an exported copy', () => {
    expect(rows(ctx({ hasKind: (k: string) => k !== 'record' }))).toEqual([]);
    expect(rows(ctx({ exported: true }))).toEqual([]);
  });
});
