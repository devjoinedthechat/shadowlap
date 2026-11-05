import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from '../ui/api.js';
import { RunsPage } from '../ui/pages/Runs.js';
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
