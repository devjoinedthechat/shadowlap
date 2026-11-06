import { act, createElement, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Client } from '../ui/api.js';
import { ToastHost } from '../ui/components/Toast.js';
import { OfflineBar } from '../ui/shell/Connection.js';
import { setSingleKeys } from '../ui/shortcuts.js';
import { AppContext, AppProvider, useApp, type AppState } from '../ui/state.js';
import { ACTION_TOAST_MS, announce, TOAST_MS, toastKey, type ToastAction } from '../ui/toast.js';
import type { JobView } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * One toast at a time, as `ToastHost` draws it: how long it stays and what holds it, what a screen
 * reader hears, who answers the undo keys, and the keyboard's way out of its button. Where it sits is
 * browser/dock.spec.ts's: it takes layout.
 */

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Shown = NonNullable<AppState['toastText']>;

function page() {
  const set: { toast: ((t: AppState['toastText']) => void) | null } = { toast: null };
  function Host() {
    const [toastText, setToastText] = useState<AppState['toastText']>(null);
    set.toast = setToastText;
    return createElement(
      AppContext.Provider,
      { value: { toastText, conn: 'ok', jobs: [] } as unknown as AppState },
      createElement('main', { id: 'view', tabIndex: -1 }, createElement('button', { className: 'mine', type: 'button' }, 'A control'), createElement('input', { type: 'search' })),
      createElement(ToastHost),
    );
  }
  return { Host, show: (t: Partial<Shown> & { id: number }) => act(async () => set.toast!({ text: 'Done', kind: 'notice', ...t })), clear: () => act(async () => set.toast!(null)) };
}

const later = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));
const mine = () => r!.one('button.mine') as unknown as HTMLElement;
const said = () => r!.one('.sr[role="status"]').textContent;

describe('how long a toast stays', () => {
  it('goes after 5 seconds, 8 with a button, and an error after 8', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { Host, show } = page();
    r = await render(createElement(Host));
    expect([TOAST_MS.notice, ACTION_TOAST_MS, TOAST_MS.error]).toEqual([5000, 8000, 8000]);
    await show({ id: 1 });
    await later(4999);
    expect(r.all('.toast')).toHaveLength(1);
    await later(2);
    expect(r.all('.toast')).toHaveLength(0);
    await show({ id: 2, action: { label: 'Open fix', run: () => undefined } });
    await later(7999);
    expect(r.all('.toast')).toHaveLength(1);
    await later(2);
    expect(r.all('.toast')).toHaveLength(0);
    await show({ id: 3, kind: 'error' });
    await later(7999);
    expect(r.all('.toast')).toHaveLength(1);
    await later(2);
    expect(r.all('.toast')).toHaveLength(0);
  });

  it('is held while the pointer or the focus is on its button', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { Host, show } = page();
    r = await render(createElement(Host));
    await show({ id: 1, action: { label: 'Open fix', run: () => undefined } });
    const button = r.one('.toast .tbtn');
    await r.hover(button);
    await later(ACTION_TOAST_MS * 2);
    expect(r.all('.toast')).toHaveLength(1);
    await r.fire(button, 'focusin');
    await r.fire(button, 'focusout');
    await later(ACTION_TOAST_MS + 1);
    expect(r.all('.toast')).toHaveLength(0);
  });

  it('takes the place of the one on the screen at once, which is told it went', async () => {
    const gone: boolean[] = [];
    const { Host, show } = page();
    r = await render(createElement(Host));
    await show({ id: 1, text: 'First', action: { label: 'Undo', undo: true, run: () => undefined, onGone: (acted) => gone.push(acted) } });
    await show({ id: 2, text: 'Second' });
    expect(gone).toEqual([false]);
    expect(r.all('.toast').map((t) => t.textContent)).toEqual(['Second']);
  });

  it('goes when its job’s drawer says the same', async () => {
    const gone: boolean[] = [];
    const { Host, show, clear } = page();
    r = await render(createElement(Host));
    await show({ id: 1, action: { label: 'Show', run: () => undefined, onGone: (acted) => gone.push(acted) } });
    await clear();
    expect(gone).toEqual([false]);
    expect(r.all('.toast')).toHaveLength(0);
  });

  it('tells its action it was pressed, then does it, once', async () => {
    const calls: string[] = [];
    const { Host, show } = page();
    r = await render(createElement(Host));
    await show({ id: 1, action: { label: 'Open fix', run: () => calls.push('run'), onGone: (acted) => calls.push(`gone ${acted}`) } });
    await r.click(r.one('.toast .tbtn'));
    expect(calls).toEqual(['gone true', 'run']);
    expect(r.all('.toast')).toHaveLength(0);
  });
});

describe('what a screen reader hears', () => {
  it('says a toast and its button in the one polite region, and what shows is in no region', async () => {
    const { Host, show } = page();
    r = await render(createElement(Host));
    await show({ id: 1, text: 'Blamed · exit 0', action: { label: 'Open fix', run: () => undefined } });
    await r.until('the words', () => said() !== '');
    expect(said()).toBe('Blamed · exit 0 · Open fix in the notice');
    await show({ id: 2, text: 'Labelled good', action: { label: 'Undo', undo: true, run: () => undefined } });
    await r.until('the words', () => said().startsWith('Labelled'));
    expect(said()).toMatch(/^Labelled good\. Undo with (Command|Control) Z$/);
    expect(r.all('[role="status"] .toast')).toHaveLength(0);
  });

  it('reads an error out at once in an alert of its own, with its × and any way on', async () => {
    const { Host, show } = page();
    r = await render(createElement(Host));
    await show({ id: 1, kind: 'error', text: 'Tried repairing · exit 1', action: { label: 'Open fix', run: () => undefined } });
    const alert = r.one('[role="alert"]');
    expect(r.one('[role="alert"] .toast').className).toContain('err');
    expect(alert.textContent).toContain('Tried repairing · exit 1');
    expect(r.one('[role="alert"] .tbtn').textContent).toBe('Open fix');
    expect(r.one('[role="alert"] .tx').getAttribute('aria-label')).toBe('Dismiss');
    await r.click(r.one('[role="alert"] .tx'));
    expect(r.all('.toast')).toHaveLength(0);
  });

  it('says what the palette found in the same region', async () => {
    const { Host } = page();
    r = await render(createElement(Host));
    await act(async () => announce('3 results'));
    await r.until('the words', () => said() !== '');
    expect(said()).toBe('3 results');
  });
});

describe('the undo keys', () => {
  it('answer an Undo: ⌘Z or Ctrl Z from anywhere but a field, and u through its key while single keys are on', async () => {
    let ran = 0;
    const { Host, show } = page();
    r = await render(createElement(Host));
    const undo: ToastAction = { label: 'Undo', undo: true, run: () => void ran++ };
    await show({ id: 1, action: undo });
    expect(r.one('.toast .tbtn').getAttribute('aria-keyshortcuts')).toBe('Meta+Z Control+Z u');
    // With single keys off it names ⌘Z alone, which still answers.
    await act(async () => setSingleKeys(false));
    expect(r.one('.toast .tbtn').getAttribute('aria-keyshortcuts')).toBe('Meta+Z Control+Z');
    await act(async () => setSingleKeys(true));
    (r.one('input') as unknown as HTMLElement).focus();
    await r.press('z', { metaKey: true }, r.one('input'));
    expect(ran).toBe(0);
    await r.press('z', { metaKey: true, shiftKey: true }, r.document.body);
    expect(ran).toBe(0);
    const e = await r.press('z', { metaKey: true }, r.document.body);
    expect(e.defaultPrevented).toBe(true);
    expect(ran).toBe(1);
    expect(toastKey.current).toBeNull();
    await show({ id: 2, action: undo });
    await r.press('z', { ctrlKey: true }, r.document.body);
    expect(ran).toBe(2);
    await show({ id: 3, action: undo });
    await act(async () => void toastKey.current!());
    expect(ran).toBe(3);
  });

  it('never press a way on', async () => {
    let ran = 0;
    const { Host, show } = page();
    r = await render(createElement(Host));
    await show({ id: 1, action: { label: 'Open fix', run: () => void ran++ } });
    expect(r.one('.toast .tbtn').hasAttribute('aria-keyshortcuts')).toBe(false);
    expect(toastKey.current).toBeNull();
    await r.press('z', { metaKey: true }, r.document.body);
    expect(ran).toBe(0);
  });
});

describe('the keyboard’s way out', () => {
  it('takes the focus when asked, starting no time until it leaves, and Esc or Tab hands it back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { Host, show } = page();
    r = await render(createElement(Host));
    mine().focus();
    await show({ id: 1, action: { label: 'Open Tests', run: () => undefined, focus: true, returnTo: mine() } });
    const button = r.one('.toast .tbtn');
    expect(r.focused()).toBe(button);
    await later(ACTION_TOAST_MS * 2);
    expect(r.all('.toast')).toHaveLength(1);
    await r.press('Escape', {}, button);
    expect(r.focused()).toBe(r.one('button.mine'));
    // Off the button, its time starts.
    await r.fire(button, 'focusout');
    await later(ACTION_TOAST_MS + 1);
    expect(r.all('.toast')).toHaveLength(0);
    await show({ id: 2, action: { label: 'Open Tests', run: () => undefined, focus: true, returnTo: mine() } });
    await r.press('Tab', {}, r.one('.toast .tbtn'));
    expect(r.focused()).toBe(r.one('button.mine'));
  });

  it('gives the focus back before a newer toast takes the place of one that held it', async () => {
    const { Host, show } = page();
    r = await render(createElement(Host));
    mine().focus();
    await show({ id: 1, action: { label: 'Open Tests', run: () => undefined, focus: true } });
    expect(r.focused()).toBe(r.one('.toast .tbtn'));
    await show({ id: 2, text: 'Second' });
    expect(r.focused()).toBe(r.one('button.mine'));
  });

  it('gives the control the focus before its way out runs', async () => {
    let at: unknown = null;
    const { Host, show } = page();
    r = await render(createElement(Host));
    mine().focus();
    await show({ id: 1, action: { label: 'Open Tests', run: () => (at = r!.focused()), returnTo: mine() } });
    await r.click(r.one('.toast .tbtn'));
    expect(at).toBe(r.one('button.mine'));
  });
});

describe('the offline bar', () => {
  const value = (o: Partial<AppState> = {}) => ({ conn: 'offline', loadedAt: 1_700_000_000_000, retryIn: 7, retrying: false, retryNow: () => undefined, toast: () => undefined, ...o }) as unknown as AppState;

  it('says what failed, what shows and the command, the countdown outside what is read out', async () => {
    r = await render(createElement(AppContext.Provider, { value: value() }, createElement(OfflineBar)));
    const bar = r.one('.connbar');
    expect(bar.hasAttribute('role')).toBe(false);
    expect(r.one('.connbar [role="status"] .ct').textContent).toMatch(/^Can’t reach the dashboard server · showing what loaded at .+ · actions paused ·$/);
    expect(r.all('.connbar [role="status"] .cr')).toHaveLength(0);
    expect(r.one('.connbar .cr').textContent).toBe('Retrying in 7s');
    expect(r.one('.connbar .cc code').textContent).toBe('shadowlap dashboard');
    expect(r.one('.ccopy').getAttribute('aria-label')).toBe('Copy command');
    expect(JSON.parse(r.one('.ccopy').getAttribute('data-tip')!)).toMatchObject({ t: 'Copy command', s: 'Starts the dashboard server again' });
    expect(r.document.body.className).toContain('is-offline');
  });

  it('leaves out the time when nothing has loaded yet, and waits on Retry while it retries', async () => {
    r = await render(createElement(AppContext.Provider, { value: value({ loadedAt: null, retrying: true }) }, createElement(OfflineBar)));
    expect(r.one('.ct').textContent).toContain('showing what loaded ·');
    expect(r.one('.cr').textContent).toBe('Reconnecting…');
    expect(r.byText('.connbar button', 'Retry now').disabled).toBe(true);
  });

  it('opens why on a phone from its button', async () => {
    r = await render(createElement(AppContext.Provider, { value: value() }, createElement(OfflineBar)));
    const why = r.byText('.connbar button', 'Why');
    expect(why.getAttribute('aria-expanded')).toBe('false');
    expect(why.getAttribute('aria-controls')).toBe('connWhyText');
    await r.click(why);
    expect(r.one('.connbar').className).toContain('open');
    expect(r.byText('.connbar button', 'Why').getAttribute('aria-expanded')).toBe('true');
    expect(r.one('#connWhyText').textContent).toMatch(/^Can’t reach the dashboard server, so this shows what loaded at .+\. Start it again:$/);
  });
});

describe('a job the page follows', () => {
  function job(over: Partial<JobView> = {}): JobView {
    return { id: 'a1', kind: 'action', args: ['replay', 'X'], worktree: null, runId: 'X', opensRun: true, startedAt: 1, done: false, stopped: false, code: null, newRunId: null, lines: [], total: 0, ...over };
  }
  /** The app over a client whose job polls answer `answer`; `on.app` is the app as it stands. */
  async function follow(answer: (id: string) => JobView | Error) {
    vi.stubGlobal('location', { search: '', hash: '#/', pathname: '/', host: '127.0.0.1:4777' });
    const on: { app: AppState | null } = { app: null };
    const client = {
      exported: false,
      meta: () => Promise.resolve({ version: '0', dbPath: null, actions: true, readOnly: false, readOnlyReason: null, address: '127.0.0.1:4777', storeBytes: null, counts: { runs: 0, attempts: 0 }, jobKinds: [] }),
      runs: () => Promise.resolve([]),
      changes: () => Promise.resolve({ cursor: 'c', changed: false, runs: false, calls: false, live: [] }),
      job: (id: string) => {
        const a = answer(id);
        return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
      },
    } as unknown as Client;
    function Probe() {
      const app = useApp();
      void [app.jobs, app.toastText, app.conn];
      on.app = app;
      return null;
    }
    r = await render(createElement(AppProvider, { client, children: createElement(Probe) }));
    return on;
  }

  it('offers the way on of a job a newer one replaced when it ends', async () => {
    const answers = new Map<string, JobView>([
      ['a1', job()],
      ['b2', job({ id: 'b2' })],
    ]);
    const on = await follow((id) => answers.get(id)!);
    await act(async () => on.app!.watchJob(Promise.resolve(answers.get('a1')!)));
    await act(async () => on.app!.watchJob(Promise.resolve(answers.get('b2')!)));
    expect(on.app!.jobs.map((w) => [w.job.id, w.open])).toEqual([
      ['a1', false],
      ['b2', true],
    ]);
    answers.set('a1', job({ done: true, code: 0, newRunId: '01KNEW', lines: ['✓ Replay clean: 30/30 calls replayed'], total: 1 }));
    await r!.until('its toast', () => on.app!.toastText !== null);
    expect(on.app!.toastText).toMatchObject({ text: 'Replayed · reproduced · exit 0', kind: 'notice', action: { label: 'Open replay' } });
  });

  it('offers to show one with no way on, which opens it', async () => {
    const answers = new Map<string, JobView>([
      ['a1', job()],
      ['b2', job({ id: 'b2' })],
    ]);
    const on = await follow((id) => answers.get(id)!);
    await act(async () => on.app!.watchJob(Promise.resolve(answers.get('a1')!)));
    await act(async () => on.app!.watchJob(Promise.resolve(answers.get('b2')!)));
    answers.set('a1', job({ done: true, code: 2, lines: ['shadowlap: no run X'], total: 1 }));
    await r!.until('its toast', () => on.app!.toastText !== null);
    expect(on.app!.toastText).toMatchObject({ text: 'Tried replaying · shadowlap: no run X', kind: 'error', action: { label: 'Show' } });
    await act(async () => on.app!.toastText!.action!.run());
    expect(on.app!.jobs.find((w) => w.open)?.job.id).toBe('a1');
    expect(on.app!.jobs.find((w) => w.open)?.focus).toBe(true);
  });

  it('leaves the toast of a hidden job to its drawer, and says nothing of one on the screen', async () => {
    let answer = job();
    const on = await follow(() => answer);
    await act(async () => on.app!.watchJob(Promise.resolve(answer)));
    answer = job({ done: true, code: 0 });
    await r!.until('its end', () => on.app!.jobs[0]?.job.done === true);
    expect(on.app!.toastText).toBeNull();
  });

  it('says a hidden job the server lost as an error', async () => {
    const on = await follow(() => new ApiError(404, 'no such job'));
    await act(async () => on.app!.watchJob(Promise.resolve(job({ title: 'Forking' }))));
    await act(async () => on.app!.closeJob('a1'));
    await r!.until('its toast', () => on.app!.toastText !== null);
    expect(on.app!.toastText).toMatchObject({ text: 'Forking: the dashboard server no longer has this job', kind: 'error' });
    expect(on.app!.jobs[0]).toMatchObject({ lost: true, hidden: true });
  });
});
