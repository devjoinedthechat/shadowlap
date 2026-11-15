import { act, createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsPage } from '../ui/pages/Settings.js';
import type { ToolsSettings } from '../ui/settings-api.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { ToastAction } from '../ui/toast.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Settings → Tools tells the truth about where `shadowlap injection` plants and what a replay may run
 * again: a pure tool or what the user types, once marked untrusted, is planted in as the engine
 * plants (it skips only writes and tools of no effect), so its row says so and offers Mark trusted;
 * and a tool shadowlap doesn't record is declared a read or a write under `tools.unrecorded`, against
 * the version the tab read, with an Undo.
 */

type Row = ToolsSettings['live'][number];
const tool = (name: string, o: Partial<Row> = {}): Row => ({ name, effect: 'read', calls: 3, runs: 1, lastAt: 1, changed: false, mcp: false, trust: 'trusted', from: null, where: null, flip: `"tools": { "${name}": { "trust": "untrusted" } }`, input: false, test: null, ...o });
const untrusted = (name: string, o: Partial<Row> = {}) => tool(name, { trust: 'untrusted', from: 'config', where: 'shadowlap.config.json', flip: `"tools": { "${name}": { "trust": "trusted" } }`, ...o });
const declared = (name: string, effect: 'read' | 'write') => `"tools": { "unrecorded": { "${name}": "${effect}" } }`;

function tools(unrecorded: Array<{ name: string; effect: 'read' | 'write' }>, version: string): ToolsSettings {
  return {
    config: { version, error: null },
    entry: [],
    live: [tool('search_docs'), untrusted('calc', { effect: 'pure' }), untrusted('user_message', { input: true }), tool('format_date', { effect: 'pure' })],
    fenced: [tool('send_email', { effect: 'write' })],
    unrecorded,
    http: [],
    mcp: { files: [], servers: [], recorded: [], effects: [], clientConfigs: [], otherForms: [] },
  } as unknown as ToolsSettings;
}

function app(settings: Record<string, (...a: never[]) => Promise<unknown>>, toasts: Array<[string, ToastAction | undefined]>): AppState {
  return {
    client: { settings, startJob: async () => ({}), jobs: async () => [] },
    meta: { project: { id: 'research-agent', name: 'research-agent', path: '/work/research-agent' } },
    runs: [],
    feeds: {},
    jobs: [],
    actionsOff: null,
    hasKind: () => true,
    guard: (fn: () => void) => (fn(), true),
    watchJob: () => undefined,
    toast: (t: string, _kind?: string, action?: ToastAction) => void toasts.push([t, action]),
  } as unknown as AppState;
}

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

const cells = (row: { querySelectorAll: (s: string) => ArrayLike<{ textContent: string | null }> }) => Array.from(row.querySelectorAll('td'), (c) => c.textContent ?? '');

describe('Settings → Tools’ Trust table', () => {
  it('says a pure tool and what the user types are untrusted where they are marked so, and offers Mark trusted, as the engine plants there', async () => {
    r = await render(createElement(AppContext.Provider, { value: app({ tools: async () => tools([], 'v1') }, []) }, createElement(SettingsPage, { tab: 'tools' })));
    await r.until('the table', () => r!.all('.trusttab tbody tr').length > 0);
    const row = (name: string) => cells(r!.all('.trusttab tbody tr').find((tr) => tr.querySelector('code')!.textContent === name)!);
    expect(row('calc')).toEqual(['calc pure', 'served when the same', 'untrustedshadowlap.config.json', 'Mark trusted']);
    expect(row('user_message')).toEqual(['user_message input', '—', 'untrustedshadowlap.config.json', 'Mark trusted']);
    // One that isn't marked takes no mark: it brings nothing in.
    expect(row('format_date')).toEqual(['format_date pure', 'served when the same', '—', '']);
  });
});

describe('Settings → Tools’ tools shadowlap doesn’t record', () => {
  it('lists each declared with what it does, declares one typed a read against the version read, and undoes it', async () => {
    const toasts: Array<[string, ToastAction | undefined]> = [];
    const sent: Array<[string, 'read' | 'write' | null, string]> = [];
    let list: Array<{ name: string; effect: 'read' | 'write' }> = [{ name: 'Write', effect: 'write' }];
    let version = 'v1';
    const setUnrecorded = async (name: string, effect: 'read' | 'write' | null, expect: string) => {
      sent.push([name, effect, expect]);
      const was = list.find((t) => t.name === name)?.effect ?? null;
      list = effect ? [...list.filter((t) => t.name !== name), { name, effect }] : list.filter((t) => t.name !== name);
      version = `v${sent.length + 1}`;
      return { tool: name, effect, was, changed: true, version, line: declared(name, effect ?? was!) };
    };
    r = await render(createElement(AppContext.Provider, { value: app({ tools: async () => tools(list, version), setUnrecorded }, toasts) }, createElement(SettingsPage, { tab: 'tools' })));
    await r.until('the tools shadowlap doesn’t record', () => r!.all('.unrec li').length === 1);
    expect(r.all('.unrec li').map((li) => li.textContent)).toEqual(['Writedeclared a writeDeclare read']);
    await r.type(r.one('.unrec input'), 'Bash');
    await r.click(r.byText('.unrec form button', 'Declare read'));
    await r.until('the declaration landed', () => r!.all('.unrec li').length === 2);
    expect(sent).toEqual([['Bash', 'read', 'v1']]);
    expect(toasts[0][0]).toBe(`Wrote ${declared('Bash', 'read')} to shadowlap.config.json`);
    expect(r.all('.unrec li').map((li) => li.textContent)).toEqual(['Writedeclared a writeDeclare read', 'Bashdeclared a readDeclare write']);
    // Its Undo takes the line out again, against the version it wrote.
    await act(async () => toasts[0][1]!.run());
    await r.until('the undo landed', () => r!.all('.unrec li').length === 1);
    expect(sent[1]).toEqual(['Bash', null, 'v2']);
    expect(toasts[1][0]).toBe(`Took ${declared('Bash', 'read')} out of shadowlap.config.json`);
  });
});
