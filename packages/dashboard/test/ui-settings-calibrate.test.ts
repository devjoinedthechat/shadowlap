import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatchingSettings } from '../src/settings.js';
import { SettingsPage } from '../ui/pages/Settings.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';

/**
 * Matching's Calibrate: a picker of the recordings it can take beside its button, which reads
 * Calibrate and names the run it replays on its card; with no recording, no picker, and a button
 * that waits saying why. The pick is kept while the dashboard is open, and the job replays it.
 */

const A = '01M5GS3GZRA0000000000000AA';
const B = '01M5GS9K2PB0000000000000BB';
const config = { file: 'shadowlap.config.json', path: '/work/research-agent/shadowlap.config.json', exists: true, version: 'v1', error: null };
const form = { kinds: ['api', 'tool'], patterns: ['email', 'uuid'], defaultReplace: '<REDACTED>' };

function matching(calibrate: Partial<MatchingSettings['calibrate']>): MatchingSettings {
  const cal = { runId: A, source: 'newest', command: `shadowlap calibrate ${A.slice(0, 10)}`, argv: ['calibrate', A], recordings: [{ runId: A }, { runId: B }], ...calibrate };
  return { config, rules: [], form, clock: { mode: 'auto', explicit: false, error: null }, calibrate: cal } as unknown as MatchingSettings;
}

const runs = [
  { runId: A, about: { text: 'Refund order 4412', from: 'user' }, labels: [] },
  { runId: B, about: { text: 'Cancel ticket T-8812', from: 'user' }, labels: ['refund-flow'] },
];

function app(data: MatchingSettings, startJob = vi.fn(async () => ({}))): AppState {
  const never = () => new Promise<never>(() => undefined);
  const settings = { matching: async () => data, project: never, redaction: never, codingAgents: never, tools: never, store: never, spending: never };
  return {
    client: { settings, startJob, storeSetup: { view: never }, teamStore: async () => null, jobs: async () => [], ciWorkflows: never },
    meta: { version: '0.1.0', project: { id: 'research-agent', name: 'research-agent', path: '/work/research-agent' } },
    runs,
    feeds: {},
    jobs: [],
    actionsOff: null,
    hasKind: () => true,
    guard: (fn: () => void) => fn(),
    watchJob: () => undefined,
    toast: () => undefined,
  } as unknown as AppState;
}

const page = (value: AppState) => render(createElement(AppContext.Provider, { value }, createElement(SettingsPage, { tab: 'matching' })));
const card = (el: FakeElement) => JSON.parse(el.getAttribute('data-tip') ?? '{}') as { t: string; s?: string; cmd?: string };

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  vi.unstubAllGlobals();
});

describe('Calibrate', () => {
  it('reads Calibrate beside a picker of the recordings, its card naming the run it replays', async () => {
    const startJob = vi.fn(async () => ({}));
    r = await page(app(matching({}), startJob));
    await r.until('the row', () => r!.all('.setrow .rpick').length === 1);
    const button = r.byText('.setrow button.btn', 'Calibrate');
    expect(r.one('.setrow .rpick').getAttribute('aria-label')).toBe('The recording to calibrate: 01M5GS3GZR, Refund order 4412');
    expect(card(button)).toMatchObject({ t: 'Calibrates 01M5GS3GZR', s: 'Refund order 4412', cmd: '$ shadowlap calibrate 01M5GS3GZR' });
    // The picker sits between the row's line and its button, and isn't drawn as the line.
    expect(r.all('.setrow')[1].children.map((c) => c.className)).toEqual(['', 'pick', 'btn']);
    await r.click(button);
    expect(startJob).toHaveBeenCalledWith('calibrate', { runId: A });
  });

  it('replays the one picked, and starts on it again while the picker lists it', async () => {
    // The picker's list is placed in the window.
    vi.stubGlobal('innerWidth', 1440);
    vi.stubGlobal('innerHeight', 900);
    const startJob = vi.fn(async () => ({}));
    r = await page(app(matching({}), startJob));
    await r.until('the row', () => r!.all('.setrow .rpick').length === 1);
    await r.click(r.one('.setrow .rpick'));
    await r.click(r.all('[role="option"]')[1]);
    const button = r.byText('.setrow button.btn', 'Calibrate');
    expect(card(button)).toMatchObject({ t: 'Calibrates 01M5GS9K2P', s: 'Cancel ticket T-8812', cmd: '$ shadowlap calibrate 01M5GS9K2P' });
    await r.click(button);
    expect(startJob).toHaveBeenCalledWith('calibrate', { runId: B });
    await r.unmount();
    // Back on the tab: the one picked, then the setup's run, then the newest.
    r = await page(app(matching({ runId: A, source: 'setup' })));
    await r.until('the row', () => r!.all('.setrow .rpick').length === 1);
    expect(r.one('.setrow .rpick').getAttribute('aria-label')).toBe('The recording to calibrate: 01M5GS9K2P, Cancel ticket T-8812');
    await r.unmount();
    // Not listed any more: the server's again, the setup's run said so on the card.
    r = await page(app(matching({ runId: A, source: 'setup', recordings: [{ runId: A }] })));
    await r.until('the row', () => r!.all('.setrow .rpick').length === 1);
    expect(card(r.byText('.setrow button.btn', 'Calibrate'))).toMatchObject({ t: 'Calibrates 01M5GS3GZR', s: 'Refund order 4412 · the run this project’s setup recorded' });
  });

  it('waits with no recording to replay, offering no picker', async () => {
    r = await page(app(matching({ runId: null, source: null, command: null, argv: null, recordings: [] })));
    await r.until('the row', () => r!.all('.setrow').length === 2);
    const button = r.byText('.setrow button.btn', 'Calibrate');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('data-why')).toBe('Record a run first: Calibrate replays a recording');
    expect(card(button)).toMatchObject({ t: 'Calibrate', s: 'Record a run first: Calibrate replays a recording' });
    expect(r.all('.setrow .rpick')).toHaveLength(0);
  });
});
