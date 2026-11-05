import { act, createElement, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '../ui/api.js';
import { RunsPage } from '../ui/pages/Runs.js';
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
  function Holder({ first }: { first: TeamStoreView | null }) {
    const [store, set] = useState(first);
    setStore = set;
    return createElement(RunsActions, { store, onImport: () => undefined });
  }
  function actions(store: TeamStoreView | null, over: Partial<AppState> = {}) {
    const startJob = vi.fn(() => Promise.resolve({ id: 'j1' }));
    const app = { client: { startJob } as unknown as Client, actionsOff: null, hasKind: () => true, guard: (fn: () => void) => fn(), watchJob: () => undefined, ...over } as unknown as AppState;
    return { startJob, element: createElement(AppContext.Provider, { value: app }, createElement(Holder, { first: store })) };
  }
  const labels = () => r!.all('button').map((b) => b.textContent);

  it('are Pull, Import capture… and Push local runs in lime while runs are only here, each card saying its command', async () => {
    const a = actions({ ...TEAM, onlyLocal: 3 });
    r = await render(a.element);
    expect(labels()).toEqual(['Pull', 'Import capture…', 'Push local runs']);
    const push = r.all('button')[2];
    expect(push.className).toBe('btn lime');
    expect(push.getAttribute('data-tip')).toBe(PUSH_TIP);
    expect(JSON.parse(PUSH_TIP)).toEqual({ t: 'Push local runs', s: 'Copies them to the store with your credentials; nothing passes through Shadowlap', rows: [], cmd: '$ shadowlap push --all' });
    expect(JSON.parse(r.all('button')[0].getAttribute('data-tip')!)).toEqual(JSON.parse(PULL_TIP));
    expect(JSON.parse(PULL_TIP)).toMatchObject({ t: 'Pull', s: 'Teammates’ runs from the store', cmd: '$ shadowlap pull' });
    await r.click(push);
    expect(a.startJob).toHaveBeenCalledWith('push', { all: true });
  });

  it('show no Push once every run is in the store, nor Pull without one', async () => {
    r = await render(actions(TEAM).element);
    expect(labels()).toEqual(['Pull', 'Import capture…']);
    await r.unmount();
    r = await render(actions(null).element);
    expect(labels()).toEqual(['Import capture…']);
  });

  it('say why each is off on a dashboard that changes nothing, with no card over the reason', async () => {
    r = await render(actions({ ...TEAM, onlyLocal: 1 }, { actionsOff: 'This dashboard is read-only' }).element);
    for (const b of r.all('button')) {
      expect(b.getAttribute('disabled')).toBe('');
      expect(b.getAttribute('title')).toBe('This dashboard is read-only');
      expect(b.getAttribute('data-tip')).toBeNull();
    }
  });

  it('hand Push’s focus to Import capture… when its runs are in the store', async () => {
    r = await render(actions({ ...TEAM, onlyLocal: 2 }).element);
    const push = r.all('button')[2];
    await r.click(push);
    expect(r.focused()).toBe(push);
    await act(async () => setStore(TEAM));
    expect(labels()).toEqual(['Pull', 'Import capture…']);
    expect(r.focused().textContent).toBe('Import capture…');
  });
});
