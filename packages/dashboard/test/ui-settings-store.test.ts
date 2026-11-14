import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { StoreSettings } from '../src/settings.js';
import { PUSH_LOCAL } from '../ui/labels.js';
import { SettingsPage } from '../ui/pages/Settings.js';
import { storeLime } from '../ui/pages/settings/store-logic.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { StoreSetupView } from '../ui/store-api.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';

/**
 * Settings → Store: one lime button, the next step (Push local runs while finished runs are only on
 * this machine, else Continue setup while a setup is under way, else none); the bucket as code; Copy
 * access policy at the end of Who has access, copying what `shadowlap store policy` prints; Check
 * again at the end of Your access, running `store check` as a job; each card saying its command.
 */

const config = { file: 'shadowlap.config.json', path: '/work/support-agent/shadowlap.config.json', exists: true, version: 'v1', error: null };
const POLICY = '# The access to ask your cloud admin for (Amazon S3): one policy for people and protected branches, one for pull requests\n{}';

/** When this machine last pushed and pulled, and the later of the two, as teamStoreStatus sends them. */
function synced(pushedAt: number | null = null, pulledAt: number | null = null) {
  return { pushedAt, pulledAt, syncedAt: pushedAt === null && pulledAt === null ? null : Math.max(pushedAt ?? 0, pulledAt ?? 0) };
}

function store(onlyLocal: number, sync = synced()): StoreSettings {
  const status = { url: 's3://northwind-agent-runs/support-agent', name: 'northwind-agent-runs', region: 'eu-central-1', providerName: 'Amazon S3', access: 'AWS profile northwind-dev', ...sync, inStore: 3, onlyLocal, queued: 0, check: null, ciPush: true };
  return { config, configured: status.url, error: null, status, policy: { text: POLICY, command: 'shadowlap store policy' }, redactRules: 2 } as unknown as StoreSettings;
}

/** A setup under way at its second step, or none (finished). */
const setupView = (underWay: boolean) => ({ active: underWay, next: underWay ? { step: 2, title: 'Push your runs' } : null, ci: [], setup: { ciProvider: null } }) as unknown as StoreSetupView;

function app(onlyLocal: number, underWay: boolean, started: Array<[string, unknown]> = [], sync = synced()): AppState {
  const never = () => new Promise<never>(() => undefined);
  const settings = { store: async () => store(onlyLocal, sync), matching: never, project: never, redaction: never, codingAgents: never, tools: never, spending: never };
  return {
    client: { settings, startJob: async (kind: string, body: unknown) => (started.push([kind, body]), {}), storeSetup: { view: async () => setupView(underWay) }, teamStore: async () => null, jobs: async () => [], ciWorkflows: never },
    meta: { version: '0.1.0', project: { id: 'support-agent', name: 'support-agent', path: '/work/support-agent' } },
    runs: [],
    feeds: {},
    jobs: [],
    actionsOff: null,
    hasKind: () => true,
    guard: (fn: () => void) => fn(),
    watchJob: () => undefined,
    toast: () => undefined,
  } as unknown as AppState;
}

const card = (el: FakeElement) => JSON.parse(el.getAttribute('data-tip') ?? '{}') as { t: string; s?: string; cmd?: string };

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

async function storeTab(value: AppState): Promise<Rendered> {
  const page = await render(createElement(AppContext.Provider, { value }, createElement(SettingsPage, { tab: 'store' })));
  await page.until('the store', () => page.all('.settab dl.kvs').length > 0);
  return page;
}

const limes = (page: Rendered) => page.all('.settab .lime').map((b) => b.textContent);

describe('Settings → Store’s one lime', () => {
  it('follows what is left: Push while finished runs are only here, Continue setup while a setup is under way, else none', async () => {
    expect(storeLime(2, true)).toBe('push');
    expect(storeLime(0, true)).toBe('setup');
    expect(storeLime(0, false)).toBeNull();
    r = await storeTab(app(2, true));
    expect(limes(r)).toEqual(['Push local runs']);
    expect(r.byText('.setupnext a', 'Continue setup').getAttribute('href')).toBe('#/setup/store');
    await r.unmount();
    r = await storeTab(app(0, true));
    expect(limes(r)).toEqual(['Continue setup']);
    await r.unmount();
    r = await storeTab(app(0, false));
    expect(limes(r)).toEqual([]);
    expect(r.all('.setupnext')).toHaveLength(0);
  });

  it('gives Pull and Push local runs cards saying what they bring or copy, and their commands', async () => {
    r = await storeTab(app(2, false));
    expect(card(r.byText('.settab button', 'Pull'))).toEqual({ t: 'Pull', s: 'Teammates’ runs from the store', rows: [], cmd: '$ shadowlap pull' });
    expect(card(r.byText('.settab button', 'Push local runs'))).toEqual({ t: PUSH_LOCAL.label, s: PUSH_LOCAL.sub, rows: [], cmd: '$ shadowlap push --all' });
  });
});

describe('Settings → Store’s facts', () => {
  it('sets the bucket and an AWS profile as code, with Copy access policy and Check again at the ends of their rows', async () => {
    const started: Array<[string, unknown]> = [];
    r = await storeTab(app(0, false, started));
    const dd = r.all('.settab dl.kvs dd');
    expect(dd[0].querySelector('code')!.textContent).toBe('s3://northwind-agent-runs/support-agent');
    expect(dd[2].querySelector('code')!.textContent).toBe('northwind-dev');
    const policy = dd[1].querySelector('button')!;
    expect(policy.getAttribute('aria-label')).toBe('Copy access policy');
    expect(card(policy)).toMatchObject({ t: 'Copy access policy', s: 'The access to ask your cloud admin for: list, read, write and delete in this bucket' });
    const check = r.byText('.settab dl.kvs dd button', 'Check again');
    expect(card(check)).toEqual({ t: 'Check again', s: 'Lists, writes, reads and deletes a test object with the credentials on this machine', rows: [], cmd: '$ shadowlap store check' });
    check.click();
    await r.until('the job', () => started.length > 0);
    // store check, which writes nothing: never store set --check, which reopens a finished setup.
    expect(started).toEqual([['store-check', {}]]);
  });
});

describe('Settings → Store’s last sync', () => {
  const lastSync = (page: Rendered) => page.all('.settab dl.kvs dd')[3].textContent.replace(/\u00a0/g, ' ');

  it('says when this machine last pushed and when it last pulled, and never before either', async () => {
    r = await storeTab(app(2, false));
    expect(lastSync(r)).toMatch(/^never 3 runs in the store · 2 only on this machine/);
    await r.unmount();
    r = await storeTab(app(2, false, [], synced(new Date(2025, 8, 30, 9, 0).getTime(), null)));
    expect(lastSync(r)).toMatch(/^pushed Sep 30, 2025 · pulled never 3 runs in the store/);
  });

  it('pulls the runs named as the store lists them, and pull requests’ runs once asked, the command following the fields', async () => {
    const started: Array<[string, unknown]> = [];
    r = await storeTab(app(0, false, started));
    const open = r.byText('.settab dl.kvs dd button', 'Pull runs…');
    expect(card(open)).toEqual({ t: 'Pull runs…', s: 'The runs you name, or pull requests’ runs too', rows: [], cmd: '$ shadowlap pull <run…>' });
    await r.click(open);
    const field = r.one('[role="dialog"] .form input');
    const command = () => r!.one('[role="dialog"] .cmdline').textContent;
    expect(command()).toBe('$shadowlap pull');
    // Nothing the CLI would read as a flag reaches it: the way on says why, and starts nothing.
    await r.type(field, '--all');
    expect(r.one('[role="dialog"] .fieldnote.err').textContent.replace(/\u00a0/g, ' ')).toBe('--all is no run: name one by its id, or its first 4 characters or more.');
    await r.click(r.one('[role="dialog"] .dlg-ok'));
    expect(started).toEqual([]);
    await r.type(field, '01k5cq4n7g, 01K5CR 01k5cq4n7g');
    expect(r.all('[role="dialog"] .fieldnote.err')).toHaveLength(0);
    expect(command()).toBe('$shadowlap pull 01K5CQ4N7G 01K5CR');
    await r.click(r.byText('[role="dialog"] .switch', 'Pull requests’ runs too'));
    expect(command()).toBe('$shadowlap pull 01K5CQ4N7G 01K5CR --include-pr');
    await r.click(r.one('[role="dialog"] .dlg-ok'));
    await r.until('the job', () => started.length > 0);
    expect(started).toEqual([['pull', { runIds: ['01K5CQ4N7G', '01K5CR'], includePr: true }]]);
  });
});
