import { act, createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { BuildRow } from '../ui/pages/settings/BuildRow.js';
import type { BuildSettings } from '../ui/settings-api.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { ToastAction } from '../ui/toast.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Build, on Settings → Project: the command that builds the agent, which repair, fix apply, verify's
 * checkout, migrate apply and bisect run where no --build is given. Save writes it against the version
 * the row read, with Undo; an empty field takes the key out; a file whose build can't run says why.
 */

const settings = (build: string | null, version: string, problem: string | null = null): BuildSettings => ({ build, problem, config: { file: 'shadowlap.config.json', path: '/work/research-agent/shadowlap.config.json', exists: true, version, error: null } });

function app(api: Record<string, (...a: never[]) => Promise<unknown>>, toasts: Array<[string, ToastAction | undefined]>, o: Partial<AppState> = {}): AppState {
  return {
    client: { settings: api },
    meta: { project: { id: 'research-agent', name: 'research-agent', path: '/work/research-agent' } },
    runs: [],
    feeds: {},
    jobs: [],
    actionsOff: null,
    hasKind: () => true,
    guard: (fn: () => void) => (fn(), true),
    watchJob: () => undefined,
    toast: (t: string, _kind?: string, action?: ToastAction) => void toasts.push([t, action]),
    ...o,
  } as unknown as AppState;
}

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

const words = () => r!.one('#build').textContent.replace(/\u00a0/g, ' ');

describe('Build, on Settings → Project', () => {
  it('writes the command typed against the version read, says so with Undo, and takes it out again', async () => {
    const toasts: Array<[string, ToastAction | undefined]> = [];
    const sent: Array<[string | null, string]> = [];
    let now = settings(null, 'v1');
    const setBuild = async (command: string | null, expect: string) => {
      sent.push([command, expect]);
      const was = now.build;
      now = settings(command, `v${sent.length + 1}`);
      return { build: command, was, changed: true, version: now.config.version };
    };
    r = await render(createElement(AppContext.Provider, { value: app({ build: async () => now, setBuild }, toasts) }, createElement(BuildRow)));
    await r.until('the row', () => r!.all('#build').length === 1);
    expect(words()).toContain('Repair, fix apply, verify’s checkout of the code before a change, migrate apply and bisect run it where no --build is given');
    // Nothing typed yet: Save says what it waits for.
    const save = r.byText('#build button', 'Save');
    expect(save.getAttribute('data-why')).toBe('Type the command that builds the agent, or empty the field for none');
    await r.type(r.one('#build input'), 'npm run build');
    await r.click(r.byText('#build button', 'Save'));
    await r.until('the write', () => toasts.length === 1);
    expect(sent).toEqual([['npm run build', 'v1']]);
    expect(toasts[0][0]).toBe('Wrote "build": "npm run build" to shadowlap.config.json');
    await r.until('the row reads it again', () => (r!.one('#build input') as unknown as { value: string }).value === 'npm run build');
    // Its Undo takes the key out, against the version the write left.
    await act(async () => toasts[0][1]!.run());
    await r.until('the undo', () => toasts.length === 2);
    expect(sent[1]).toEqual([null, 'v2']);
    expect(toasts[1][0]).toBe('Took "build": "npm run build" out of shadowlap.config.json');
  });

  it('says why the file’s build can’t run, and writes nothing while actions are off', async () => {
    const problem = 'shadowlap.config.json: build must be the command that builds the agent, on one line, such as "npm run build"';
    r = await render(createElement(AppContext.Provider, { value: app({ build: async () => settings(null, 'v1', problem), setBuild: async () => ({}) }, [], { actionsOff: 'This dashboard is read-only' }) }, createElement(BuildRow)));
    await r.until('the row', () => r!.all('#build').length === 1);
    expect(r.one('#build .warn').textContent.replace(/\u00a0/g, ' ')).toBe(problem);
    expect(r.byText('#build button', 'Save').getAttribute('data-why')).toBe('This dashboard is read-only');
    expect(r.one('#build input').hasAttribute('readonly')).toBe(true);
  });
});
