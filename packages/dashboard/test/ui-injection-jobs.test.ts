import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolsSettings } from '../src/settings.js';
import { SettingsPage } from '../ui/pages/Settings.js';
import { GLOSSARY } from '../ui/glossary.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { ToastAction } from '../ui/toast.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Running injection tests from the dashboard, and the writes that go with them: Settings → Tools'
 * Trust table, whose Mark untrusted and Mark trusted write a tool's trust against the version read,
 * with an Undo, and the `tools` entry they write under it, the line written here marked.
 */

type Row = ToolsSettings['live'][number];
const tool = (name: string, o: Partial<Row> = {}): Row => ({ name, effect: 'read', calls: 3, runs: 1, lastAt: 1, changed: false, mcp: false, trust: 'trusted', from: null, where: null, flip: `"tools": { "${name}": { "trust": "untrusted" } }`, input: false, test: null, ...o });
const line = (name: string, trust: string) => `"tools": { "${name}": { "trust": "${trust}" } }`;

function tools(marks: Record<string, 'trusted' | 'untrusted'>, version: string): ToolsSettings {
  const read = (name: string) => (marks[name] === 'untrusted' ? tool(name, { trust: 'untrusted', from: 'config', where: 'shadowlap.config.json', flip: line(name, 'trusted') }) : tool(name));
  const names = Object.keys(marks);
  return {
    config: { version, error: null },
    entry: names.map((n, i) => ({ tool: n, text: `  "${n}": { "trust": "${marks[n]}" }${i < names.length - 1 ? ',' : ''}` })),
    live: [read('search_docs'), tool('user_message', { input: true }), read('get_ticket'), tool('calc', { effect: 'pure' })],
    fenced: [tool('send_email', { effect: 'write' })],
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
    guard: (fn: () => void) => fn(),
    watchJob: () => undefined,
    toast: (t: string, _kind?: string, action?: ToastAction) => void toasts.push([t, action]),
  } as unknown as AppState;
}

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

// A cell's words, less the glossary's cards its terms carry.
const cells = (row: { querySelectorAll: (s: string) => ArrayLike<{ textContent: string | null }> }) => Array.from(row.querySelectorAll('td'), (c) => (c.textContent ?? '').replace(GLOSSARY.blocked, '').replace(GLOSSARY.stubbed, ''));

describe('Settings → Tools’ Trust table', () => {
  it('lists reads first, untrusted first among them, then pure, input and writes, a mark only on a read', async () => {
    const toasts: Array<[string, ToastAction | undefined]> = [];
    r = await render(createElement(AppContext.Provider, { value: app({ tools: async () => tools({ get_ticket: 'untrusted' }, 'v1') }, toasts) }, createElement(SettingsPage, { tab: 'tools' })));
    await r.until('the table', () => r!.all('.trusttab tbody tr').length > 0);
    expect(r.all('.trusttab thead th').map((h) => h.textContent)).toEqual(['Tool', 'After a fork', 'Trust', 'Change']);
    expect(r.all('.trusttab tbody tr').map(cells)).toEqual([
      ['get_ticket read', 'runs live', 'untrustedshadowlap.config.json', 'Mark trusted'],
      ['search_docs read', 'runs live', 'trusted', 'Mark untrusted'],
      ['calc pure', 'served when the same', '—', ''],
      ['user_message input', '—', '—', ''],
      ['send_email write', 'blocked or stubbed', '—', ''],
    ]);
    expect(r.one('.trusttab code.wr').textContent).toBe('send_email');
    expect(JSON.parse(r.all('.trusttab .trust.na')[2].getAttribute('data-tip')!)).toMatchObject({ t: 'A write', s: 'Never planted in: an instruction arrives in what the agent reads, and a write’s result is only its receipt' });
    // Mark untrusted's card: the line it writes, as its command.
    expect(JSON.parse(r.all('.trustbtn')[1].getAttribute('data-tip')!)).toMatchObject({ t: 'Mark search_docs untrusted', cmd: line('search_docs', 'untrusted') });
    // The entry, folded, its Copy beside the toggle.
    const [toggle, copy] = r.all('.egrp .wftog button');
    expect([toggle.textContent, toggle.getAttribute('aria-expanded'), r.one('#toolsCfg').hasAttribute('hidden'), copy.textContent]).toEqual(['Show the tools entry', 'false', true, 'Copy entry']);
    expect(r.one('#toolsCfg pre').textContent).toBe('"tools": {\n  "get_ticket": { "trust": "untrusted" }\n}');
  });

  it('writes a mark against the version read, keeps the row in place, opens the entry on the line written, and undoes it', async () => {
    const toasts: Array<[string, ToastAction | undefined]> = [];
    const sent: unknown[][] = [];
    let marks: Record<string, 'trusted' | 'untrusted'> = { get_ticket: 'untrusted' };
    let version = 'v1';
    const setToolTrust = async (name: string, trust: 'trusted' | 'untrusted' | null, expect: string) => {
      sent.push([name, trust, expect]);
      const was = marks[name] ?? null;
      marks = { ...marks };
      if (trust) marks[name] = trust;
      else delete marks[name];
      version = `v${sent.length + 1}`;
      return { tool: name, trust, was, changed: true, version, line: line(name, trust ?? was) };
    };
    r = await render(createElement(AppContext.Provider, { value: app({ tools: async () => tools(marks, version), setToolTrust: setToolTrust }, toasts) }, createElement(SettingsPage, { tab: 'tools' })));
    await r.until('the table', () => r!.all('.trustbtn').length === 2);
    await r.click(r.all('.trustbtn')[1]);
    await r.until('the write landed', () => r!.all('.trusttab tbody tr')[1]?.querySelector('.trust')?.textContent === 'untrusted');
    expect(sent).toEqual([['search_docs', 'untrusted', 'v1']]);
    expect(toasts[0][0]).toBe(`Wrote ${line('search_docs', 'untrusted')} to shadowlap.config.json`);
    // The row stays where it was, though it is untrusted now; its button says the other mark.
    expect(r.all('.trusttab tbody tr').map((t) => t.querySelector('code')!.textContent)).toEqual(['get_ticket', 'search_docs', 'calc', 'user_message', 'send_email']);
    expect(r.all('.trustbtn')[1].textContent).toBe('Mark trusted');
    expect(r.one('#toolsCfg').hasAttribute('hidden')).toBe(false);
    expect(r.one('#toolsCfg pre').textContent).toBe('  "tools": {\n    "get_ticket": { "trust": "untrusted" },\n+   "search_docs": { "trust": "untrusted" }\n  }');
    // Undo takes the line out again, against the version the write left.
    toasts[0][1]!.run();
    await r.until('the undo landed', () => toasts.length === 2);
    expect(sent[1]).toEqual(['search_docs', null, 'v2']);
    expect(toasts[1][0]).toBe(`Took ${line('search_docs', 'untrusted')} out of shadowlap.config.json`);
  });
});
