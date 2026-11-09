import { act, createElement, useState, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatchingSettings } from '../src/settings.js';
import { ApiError } from '../ui/api.js';
import { ToastHost } from '../ui/components/Toast.js';
import { jobFooter } from '../ui/job-actions.js';
import { SettingsPage } from '../ui/pages/Settings.js';
import '../ui/pages/settings/jobs.js';
import { onSettingsChanged } from '../ui/pages/settings/events.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { ToastAction, ToastKind } from '../ui/toast.js';
import type { JobView } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Undo on what Settings writes in one click: a rule removed goes back at its number (an Undo pressed
 * before the removal has landed waits for it rather than being lost, and a second press sends
 * nothing), the clock and Push from CI go back to what the file said, and the normalizers calibrate
 * added come out again. ⌘Z does it while the toast shows; a refused Undo says why in the page's words.
 * The focus goes from a removed rule to the Remove taking its place, and to a rule put back. A rule
 * that can't be used gets no Undo: written back, every command would refuse the file.
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

/** `page` with its toast drawn, as the app draws it, so ⌘Z reaches the toast's Undo. */
function hosted(value: AppState, page: ReactElement): ReactElement {
  let id = 0;
  function Host() {
    const [toastText, setToastText] = useState<AppState['toastText']>(null);
    const toast = (text: string, kind: ToastKind = 'notice', action?: ToastAction) => {
      value.toast(text, kind, action);
      setToastText({ id: ++id, text, kind, ...(action ? { action } : {}) });
    };
    return createElement(AppContext.Provider, { value: { ...value, toast, toastText } }, page, createElement(ToastHost));
  }
  return createElement(Host);
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
    await act(async () => removed());
    await r.until('the toast', () => toasts.length === 1);
    expect(removeRule).toHaveBeenCalledWith('normalize', 2, 'v1');
    const [toast] = toasts;
    expect([toast.text, toast.kind, toast.action?.label, toast.action?.undo]).toEqual(['Normalizer removed from shadowlap.config.json', 'notice', 'Undo', true]);
    // At once, while the tab still shows the file the removal started from: it waits, then goes.
    shown = matching('v1');
    await act(async () => {
      toast.action!.run();
      toast.action!.run();
    });
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

  it('moves the focus from a removed rule to the Remove taking its place, whichever its shape, else the last row’s, else Add normalizer…, and to a rule put back', async () => {
    const toasts: Toasted[] = [];
    const [a, b, broken] = RULES;
    const c = { ...a, rule: { path: '$.ts', pattern: 'iso-date', replace: '<DATE>' }, path: '$.ts', pattern: 'iso-date', replace: '<DATE>' };
    const at = <T extends { n: number }>(row: T, n: number): T => ({ ...row, n });
    let shown = matching('v1', [at(a, 1), at(broken, 2), at(b, 3), at(c, 4)]);
    let answer = { rule: {} as unknown, version: 'v1' };
    const removeRule = vi.fn(async (_list: string, n: number) => ({ list: 'normalize', n, ...answer }));
    const restoreRule = vi.fn(async () => ({ list: 'normalize', n: 1, version: 'v4' }));
    r = await render(createElement(AppContext.Provider, { value: app({ matching: async () => shown, removeRule, restoreRule }, toasts) }, createElement(SettingsPage, { tab: 'matching' })));
    await r.until('the rules', () => r!.all('table.ruletable tbody tr').length === 4);
    const rows = () => r!.all('table.ruletable tbody tr').length;
    // Removes rule #n, the file then holding `left`, and gives the button pressed.
    const remove = async (n: number, rule: unknown, left: unknown[], version: string) => {
      const button = r!.one(`button[aria-label="Remove normalizer #${n}"]`);
      await r!.until('the Remove free', () => button.getAttribute('aria-disabled') === null);
      [shown, answer] = [matching(version, left), { rule, version }];
      const toasted = toasts.length;
      await r!.click(button);
      await r!.until('the row gone', () => toasts.length === toasted + 1 && rows() === left.length);
      return button;
    };
    const broke = () => r!.focused().closest('tr')?.querySelector('.rerr') ?? null;
    // A sound rule's Remove, the broken rule below taking its number: the same button keeps the focus.
    const first = await remove(1, a.rule, [at(broken, 1), at(b, 2), at(c, 3)], 'v2');
    expect([r.focused(), first.getAttribute('aria-label'), broke()]).toEqual([first, 'Remove normalizer #1', expect.anything()]);
    // The last row's: the focus moves to the row above at once.
    await remove(3, c.rule, [at(broken, 1), at(b, 2)], 'v3');
    expect(r.focused().getAttribute('aria-label')).toBe('Remove normalizer #2');
    // A broken rule's, a sound one taking its number: the same button again.
    expect(await remove(1, null, [at(b, 1)], 'v4')).toBe(first);
    expect([r.focused(), broke()]).toEqual([first, null]);
    // The only row's: Add normalizer… takes the focus. Its Undo puts the rule back, its Remove focused.
    await remove(1, b.rule, [], 'v5');
    expect(r.focused().textContent).toBe('Add normalizer…');
    shown = matching('v4', [at(b, 1)]);
    await act(async () => toasts.at(-1)!.action!.run());
    await r.until('the rule back', () => rows() === 1);
    await r.until('its Remove focused', () => r!.focused().getAttribute('aria-label') === 'Remove normalizer #1');
    expect(restoreRule).toHaveBeenCalledWith('normalize', 1, b.rule, 'v5');
  });

  it('says an Undo refused once the file changed since in the page’s words, and reads the file again', async () => {
    const toasts: Toasted[] = [];
    let shown = matching('v1');
    const reads = vi.fn(async () => shown);
    const removeRule = vi.fn(async () => ({ list: 'normalize', n: 2, rule: RULES[1].rule, version: 'v2' }));
    const restoreRule = vi.fn(async () => {
      throw new ApiError(409, 'shadowlap.config.json changed since it was read; reload it and try again');
    });
    r = await render(createElement(AppContext.Provider, { value: app({ matching: reads, removeRule, restoreRule }, toasts) }, createElement(SettingsPage, { tab: 'matching' })));
    await r.until('the rules', () => r!.all('table.ruletable tbody tr').length === 3);
    shown = matching('v2', [RULES[0], { ...RULES[2], n: 2 }]);
    await r.click(r.one('button[aria-label="Remove normalizer #2"]'));
    await r.until('the removal', () => toasts.length === 1 && r!.all('table.ruletable tbody tr').length === 2);
    // Changed in an editor since: the Undo is refused, and the tab shows the file as it is now.
    shown = matching('v3', [RULES[0]]);
    const read = reads.mock.calls.length;
    await act(async () => toasts[0].action!.run());
    await r.until('the refusal', () => toasts.length === 2);
    expect(restoreRule).toHaveBeenCalledWith('normalize', 2, RULES[1].rule, 'v2');
    expect([toasts[1].text, toasts[1].kind, toasts[1].action]).toEqual(['shadowlap.config.json changed on disk since this page read it. It shows the file as it is now; nothing was changed.', 'error', undefined]);
    await r.until('the file as it is now', () => r!.all('table.ruletable tbody tr').length === 1);
    expect(reads.mock.calls.length).toBeGreaterThan(read);
  });

  it('puts a removed rule back with ⌘Z while its toast shows, the focus on its Remove', async () => {
    const toasts: Toasted[] = [];
    let shown = matching('v1');
    const removeRule = vi.fn(async () => ({ list: 'normalize', n: 2, rule: RULES[1].rule, version: 'v2' }));
    const restoreRule = vi.fn(async () => ({ list: 'normalize', n: 2, version: 'v1' }));
    r = await render(hosted(app({ matching: async () => shown, removeRule, restoreRule }, toasts), createElement(SettingsPage, { tab: 'matching' })));
    await r.until('the rules', () => r!.all('table.ruletable tbody tr').length === 3);
    shown = matching('v2', [RULES[0], { ...RULES[2], n: 2 }]);
    await r.click(r.one('button[aria-label="Remove normalizer #2"]'));
    await r.until('its toast', () => r!.all('.toast .tbtn').length === 1 && r!.all('table.ruletable tbody tr').length === 2);
    shown = matching('v1');
    const e = await r.press('z', { metaKey: true }, r.document.body);
    await r.until('the rule back', () => r!.all('table.ruletable tbody tr').length === 3);
    expect([e.defaultPrevented, restoreRule.mock.calls]).toEqual([true, [['normalize', 2, RULES[1].rule, 'v2']]]);
    await r.until('its Remove focused', () => r!.focused().getAttribute('aria-label') === 'Remove normalizer #2' && r!.focused().closest('tr')!.textContent.includes('send_email'));
    expect(toasts.map((t) => t.text)).toEqual(['Normalizer removed from shadowlap.config.json', 'Rule back in shadowlap.config.json']);
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
    await act(async () => toasts[0].action!.run());
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
    await act(async () => toasts[0].action!.run());
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

describe('Undo on Store’s Push from CI', () => {
  /** Settings → Store with a store set up, Push from CI `ciPush` in the file at `version`. */
  const storeView = (ciPush: boolean, version: string) => ({
    config: config(version),
    configured: 's3://northwind-agent-runs/support-agent',
    error: null,
    status: { url: 's3://northwind-agent-runs/support-agent', name: 'northwind-agent-runs', region: 'eu-central-1', providerName: 'Amazon S3', access: 'AWS profile northwind-dev', syncedAt: null, inStore: 3, onlyLocal: 0, queued: 0, check: null, ciPush },
    ciStep: null,
    policy: { text: '{}', command: 'shadowlap store policy' },
    redactRules: 2,
  });

  it('turns it off from its Switch, named by its row’s label and line, and puts back what the file said, against the version the edit wrote', async () => {
    const toasts: Toasted[] = [];
    let [ciPush, version] = [true, 'v1'];
    // The file said nothing (on): off writes false, and its Undo takes the key out again.
    const setCiPush = vi.fn(async (on: boolean | null) => (on === false ? { ciPush: false, previous: true, was: null, changed: true, version: 'v2' } : { ciPush: true, previous: false, was: false, changed: true, version: 'v1' }));
    r = await render(createElement(AppContext.Provider, { value: app({ store: async () => storeView(ciPush, version), setCiPush }, toasts) }, createElement(SettingsPage, { tab: 'store' })));
    await r.until('the switch', () => r!.all('.settab [role="switch"]').length === 1);
    const on = r.one('.settab [role="switch"]');
    expect([on.getAttribute('aria-labelledby'), on.getAttribute('aria-describedby'), on.getAttribute('aria-checked')]).toEqual(['ciPush-name', 'ciPush-help', 'true']);
    expect([r.one('#ciPush-name').textContent, r.one('#ciPush-help').textContent]).toEqual(['Push from CI', 'CI pushes every test run, its report and each fix it opens, so history covers every pull request.']);
    [ciPush, version] = [false, 'v2'];
    await r.click(on);
    await r.until('the toast', () => toasts.length === 1);
    expect([toasts[0].text, toasts[0].kind, toasts[0].action?.label]).toEqual(['Push from CI off · written to shadowlap.config.json; commit it for CI to see it', 'notice', 'Undo']);
    await r.until('the switch off', () => r!.one('.settab [role="switch"]').getAttribute('aria-checked') === 'false');
    [ciPush, version] = [true, 'v1'];
    await act(async () => toasts[0].action!.run());
    await r.until('the toast back', () => toasts.length === 2);
    expect(setCiPush.mock.calls).toEqual([
      [false, 'v1'],
      [null, 'v2'],
    ]);
    expect([toasts[1].text, toasts[1].action]).toEqual(['Push from CI on · written to shadowlap.config.json; commit it for CI to see it', undefined]);
    await r.until('the switch on', () => r!.one('.settab [role="switch"]').getAttribute('aria-checked') === 'true');
  });

  it('offers no Undo for a write that changed nothing', async () => {
    const toasts: Toasted[] = [];
    // The route found the file saying off already and wrote nothing (`changed: false`, the version as it was): nothing to put back.
    const setCiPush = vi.fn(async () => ({ ciPush: false, previous: false, was: false, changed: false, version: 'v1' }));
    r = await render(createElement(AppContext.Provider, { value: app({ store: async () => storeView(true, 'v1'), setCiPush }, toasts) }, createElement(SettingsPage, { tab: 'store' })));
    await r.until('the switch', () => r!.all('.settab [role="switch"]').length === 1);
    await r.click(r.one('.settab [role="switch"]'));
    await r.until('the toast', () => toasts.length === 1);
    expect(setCiPush.mock.calls).toEqual([[false, 'v1']]);
    expect([toasts[0].text, toasts[0].kind, toasts[0].action]).toEqual(['Push from CI off · written to shadowlap.config.json; commit it for CI to see it', 'notice', undefined]);
  });
});
