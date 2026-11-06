import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatchingSettings } from '../src/settings.js';
import { jobFooter } from '../ui/job-actions.js';
import { SettingsPage } from '../ui/pages/Settings.js';
import '../ui/pages/settings/jobs.js';
import { onSettingsChanged } from '../ui/pages/settings/events.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { ToastAction } from '../ui/toast.js';
import type { JobView } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Undo on what Settings writes in one click: a rule removed goes back at its number (an Undo pressed
 * before the removal has landed waits for it rather than being lost, and a second press sends
 * nothing), the clock goes back to what the file said, and the normalizers calibrate added come out
 * again. A rule that can't be used gets no Undo: written back, every command would refuse the file.
 */

const config = (version: string) => ({ file: 'shadowlap.config.json', path: '/work/research-agent/shadowlap.config.json', exists: true, version, error: null });
const form = { kinds: ['api', 'tool'], patterns: ['email', 'uuid'], defaultReplace: '<NORMALIZED>' };
const RULES = [
  { n: 1, rule: { path: '$.id', pattern: 'uuid', replace: '<UUID>' }, scope: 'every call', path: '$.id', pattern: 'uuid', patternType: 'named', replace: '<UUID>', error: null, remove: [] },
  { n: 2, rule: { kind: 'tool', name: 'send_email', path: '$.to', pattern: 'email', replace: '<EMAIL>' }, scope: 'tool · send_email', path: '$.to', pattern: 'email', patternType: 'named', replace: '<EMAIL>', error: null, remove: [] },
  { n: 3, rule: null, scope: 'every call', path: null, pattern: null, patternType: 'whole', replace: null, error: 'a rule has no field color', remove: [] },
];

function matching(version: string, rules: unknown[] = RULES, mode: 'auto' | 'exact' = 'auto'): MatchingSettings {
  return { config: config(version), rules, form, clock: { mode, explicit: false, error: null }, calibrate: { runId: 'R1', source: 'newest', command: 'shadowlap calibrate R1', argv: ['calibrate', 'R1'], recordings: [{ runId: 'R1' }] } } as unknown as MatchingSettings;
}

interface Toasted {
  text: string;
  kind: string | undefined;
  action: ToastAction | undefined;
}

function app(settings: Record<string, unknown>, toasts: Toasted[]): AppState {
  return {
    client: { settings, startJob: async () => ({}), storeSetup: { view: async () => null }, teamStore: async () => null, jobs: async () => [] },
    meta: { version: '0.1.0', project: { id: 'research-agent', name: 'research-agent', path: '/work/research-agent' } },
    runs: [],
    feeds: {},
    jobs: [],
    actionsOff: null,
    conn: 'live',
    hasKind: () => true,
    guard: (fn: () => void) => fn(),
    watchJob: () => undefined,
    toast: (text: string, kind?: string, action?: ToastAction) => toasts.push({ text, kind, action }),
  } as unknown as AppState;
}

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

describe('Undo on Matching', () => {
  it('puts a removed rule back at its number, pressed before the removal has landed, and only once', async () => {
    const toasts: Toasted[] = [];
    let shown = matching('v1');
    let removed!: () => void;
    const removeRule = vi.fn(() => new Promise((done) => (removed = () => done({ list: 'normalize', n: 2, rule: RULES[1].rule, version: 'v2' }))));
    const restoreRule = vi.fn(async () => ({ list: 'normalize', n: 2, version: 'v1' }));
    const settings = { matching: async () => shown, removeRule, restoreRule };
    r = await render(createElement(AppContext.Provider, { value: app(settings, toasts) }, createElement(SettingsPage, { tab: 'matching' })));
    await r.until('the rules', () => r!.all('table.ruletable tbody tr').length === 3);
    await r.click(r.one('button[aria-label="Remove normalizer #2"]'));
    shown = matching('v2', [RULES[0], RULES[2]]);
    removed();
    await r.until('the toast', () => toasts.length === 1);
    expect(removeRule).toHaveBeenCalledWith('normalize', 2, 'v1');
    const [toast] = toasts;
    expect([toast.text, toast.kind, toast.action?.label, toast.action?.undo]).toEqual(['Normalizer removed from shadowlap.config.json', 'notice', 'Undo', true]);
    // At once, while the tab still shows the file the removal started from: it waits, then goes.
    shown = matching('v1');
    toast.action!.run();
    toast.action!.run();
    await r.until('the rule back', () => toasts.length === 2);
    expect(restoreRule).toHaveBeenCalledTimes(1);
    expect(restoreRule).toHaveBeenCalledWith('normalize', 2, RULES[1].rule, 'v2');
    expect([toasts[1].text, toasts[1].action]).toEqual(['Rule back in shadowlap.config.json', undefined]);
    await r.until('the table', () => r!.all('table.ruletable tbody tr').length === 3);
  });

  it('removes a rule that can’t be used with no Undo', async () => {
    const toasts: Toasted[] = [];
    const settings = { matching: async () => matching('v1'), removeRule: async () => ({ list: 'normalize', n: 3, rule: { color: 'red' }, version: 'v2' }), restoreRule: vi.fn() };
    r = await render(createElement(AppContext.Provider, { value: app(settings, toasts) }, createElement(SettingsPage, { tab: 'matching' })));
    await r.until('the rules', () => r!.all('table.ruletable tbody tr').length === 3);
    await r.click(r.one('button[aria-label="Remove normalizer #3"]'));
    await r.until('the toast', () => toasts.length === 1);
    expect([toasts[0].text, toasts[0].action]).toEqual(['Normalizer removed from shadowlap.config.json', undefined]);
  });

  it('puts the clock back as the file had it, taking the key out where it had none', async () => {
    const toasts: Toasted[] = [];
    let shown = matching('v1', []);
    const setClock = vi.fn(async (mode: 'auto' | 'exact' | null) => (mode === 'exact' ? { clock: 'exact', was: null, changed: true, version: 'v2' } : { clock: 'auto', was: 'exact', changed: true, version: 'v1' }));
    const settings = { matching: async () => shown, setClock };
    r = await render(createElement(AppContext.Provider, { value: app(settings, toasts) }, createElement(SettingsPage, { tab: 'matching' })));
    await r.until('the clock', () => r!.all('.seg button').length === 2);
    shown = matching('v2', [], 'exact');
    await r.click(r.byText('.seg button', 'exact'));
    await r.until('the toast', () => toasts.length === 1);
    expect([toasts[0].text, toasts[0].action?.label]).toEqual(['clock: exact · written to shadowlap.config.json', 'Undo']);
    shown = matching('v1', []);
    toasts[0].action!.run();
    await r.until('the clock back', () => toasts.length === 2);
    expect(setClock.mock.calls).toEqual([
      ['exact', 'v1'],
      [null, 'v2'],
    ]);
    expect(toasts[1].text).toBe('clock: auto · written to shadowlap.config.json');
  });
});

describe('Undo on calibrate’s Add normalizer', () => {
  it('takes out what it added, the highest number first, each against the version the last wrote, and offers the button again', async () => {
    const toasts: Toasted[] = [];
    const versions: Record<number, string> = { 5: 'v3', 4: 'v2' };
    const removeRule = vi.fn(async (_list: string, n: number) => ({ list: 'normalize', n, rule: {}, version: versions[n] }));
    const settings = { writeCalibration: async () => ({ added: [4, 5], already: [], version: 'v4' }), removeRule };
    const changed = vi.fn();
    const off = onSettingsChanged(changed);
    const job = { id: 'job1', kind: 'calibrate', done: true, result: { runId: 'R1', normalizers: [{ path: '$.a' }, { path: '$.b' }] } } as unknown as JobView;
    const Footer = jobFooter('calibrate')!;
    r = await render(createElement(AppContext.Provider, { value: app(settings, toasts) }, createElement(Footer, { job })));
    await r.click(r.byText('button', 'Add 2 normalizers'));
    await r.until('the toast', () => toasts.length === 1);
    expect([toasts[0].text, toasts[0].action?.label]).toEqual(['Added to shadowlap.config.json · normalizers #4, #5', 'Undo']);
    expect(r.one('button').textContent).toBe('Added');
    toasts[0].action!.run();
    await r.until('the rules out', () => toasts.length === 2);
    expect(removeRule.mock.calls).toEqual([
      ['normalize', 5, 'v4'],
      ['normalize', 4, 'v3'],
    ]);
    expect(toasts[1].text).toBe('Rules removed from shadowlap.config.json');
    expect(changed).toHaveBeenCalled();
    await r.until('the button again', () => r!.one('button').textContent === 'Add 2 normalizers');
    off();
  });
});
