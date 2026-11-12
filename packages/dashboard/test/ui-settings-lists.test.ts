import { createElement, useState, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ToolsSettings } from '../src/settings.js';
import { RuleTable } from '../ui/pages/settings/RuleTable.js';
import { SettingsPage } from '../ui/pages/Settings.js';
import { parseRoute } from '../ui/route.js';
import type { RuleRow } from '../ui/settings-api.js';
import { Keyboard } from '../ui/shell/Keyboard.js';
import { Palette } from '../ui/shell/Palette.js';
import type { AppState } from '../ui/state.js';
import { AppContext } from '../ui/state.js';
import { addressBar, app } from './ui-route-helpers.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Settings' lists in the keys' reach (`useListKeys`): the normalizers and redaction rules, and the
 * MCP servers. j and k walk their rows, drawn `.krow`; a row leads nowhere, so Enter on it offers
 * what ⌘K offers: a rule's Remove, waiting as its button waits, and a server's copy the line.
 */

let r: Rendered | null = null;
beforeAll(() => {
  Object.assign(globalThis, { innerWidth: 1440, innerHeight: 900 });
});
beforeEach(() => {
  addressBar('#/settings/matching');
});
afterEach(async () => {
  await r?.unmount();
  r = null;
});

const RULES = [
  { n: 1, rule: { path: '$.id', pattern: 'uuid', replace: '<UUID>' }, scope: 'every call', path: '$.id', pattern: 'uuid', patternType: 'named', replace: '<UUID>', error: null, remove: [] },
  { n: 2, rule: null, scope: 'every call', path: null, pattern: null, patternType: 'whole', replace: null, error: 'a rule has no field color', remove: [] },
] as unknown as RuleRow[];

/** A page with the shell's keys and the palette, which opens as ⌘K or Enter on a row asks. */
function withPalette(state: Partial<AppState>, page: ReactNode, route: string) {
  function Opener() {
    const [open, setOpen] = useState(false);
    return createElement(AppContext.Provider, { value: app({ ...state, palette: open, setPalette: setOpen }) }, createElement('main', { id: 'view' }, page), createElement(Keyboard), createElement(Palette, { route: parseRoute(route) }));
  }
  return createElement(Opener);
}

const rowInFocus = () => r!.focused().getAttribute('data-rowkey');
const labels = () => r!.all('.palit .pl').map((x) => x.textContent);

describe('a rule table', () => {
  const table = (off: string | null, removed: number[]) => withPalette({}, createElement(RuleTable, { list: 'normalize', rows: RULES, off, onRemove: (row: RuleRow) => void removed.push(row.n) }), '#/settings/matching');

  it('walks its rules with j and k, and offers a rule’s Remove on Enter, named by its number', async () => {
    const removed: number[] = [];
    r = await render(table(null, removed));
    expect(r.all('table.ruletable tbody tr').map((tr) => tr.getAttribute('data-rowkey'))).toEqual(['rule:1', 'rule:2']);
    await r.press('j');
    expect(rowInFocus()).toBe('rule:1');
    expect(r.all('.krow').map((x) => x.getAttribute('data-rowkey'))).toEqual(['rule:1']);
    await r.press('j');
    expect(rowInFocus()).toBe('rule:2');
    await r.press('Enter');
    await r.until('the palette', () => r!.all('.palette').length === 1);
    expect(labels()).toEqual(['Remove']);
    expect(r.one('.palg').textContent).toContain('Normalizer #2');
    await r.click(r.one('.palit'));
    expect(removed).toEqual([2]);
  });

  it('has Remove wait on ⌘K as its button waits', async () => {
    const removed: number[] = [];
    r = await render(table('Read-only: this dashboard was started with --read-only', removed));
    await r.press('j');
    await r.press('k', { metaKey: true });
    await r.until('the palette', () => r!.all('.palette').length === 1);
    expect(r.one('.palit').getAttribute('aria-disabled')).toBe('true');
    await r.click(r.one('.palit'));
    expect(removed).toEqual([]);
  });
});

describe('the MCP servers', () => {
  const servers = [
    { file: '.mcp.json', name: 'github', transport: 'stdio', target: 'npx -y @modelcontextprotocol/server-github', recorded: null, viaShadowlap: false, line: 'shadowlap mcp -- npx -y @modelcontextprotocol/server-github', putBack: [] },
    { file: '.mcp.json', name: 'linear', transport: 'http', target: 'https://mcp.linear.app/mcp', recorded: { tools: 4, writes: 1 }, viaShadowlap: true, line: null, putBack: [] },
  ];
  const tools = { config: { version: 'v1', error: null }, entry: [], live: [], fenced: [], http: [], mcp: { files: [], servers, recorded: [], effects: [], clientConfigs: [], otherForms: [] } } as unknown as ToolsSettings;
  const state = { client: { settings: { tools: async () => tools } }, meta: { project: { id: 'research-agent', name: 'research-agent', path: '/work/research-agent' } }, feeds: {}, toast: () => undefined } as unknown as Partial<AppState>;

  it('walks its rows with j, and offers copy the line on Enter where a server has one, nothing where it has none', async () => {
    addressBar('#/settings/tools');
    r = await render(withPalette(state, createElement(SettingsPage, { tab: 'tools' }), '#/settings/tools'));
    await r.until('the servers', () => r!.all('.mcptable tbody tr').length === 2);
    expect(r.all('.mcptable tbody tr').map((tr) => tr.getAttribute('data-rowkey'))).toEqual(['mcp:.mcp.json/github', 'mcp:.mcp.json/linear']);
    await r.press('j');
    expect(rowInFocus()).toBe('mcp:.mcp.json/github');
    await r.press('Enter');
    await r.until('the palette', () => r!.all('.palette').length === 1);
    expect(labels()).toEqual(['Copy the line']);
    expect(r.one('.palg').textContent).toContain('github');
    await r.press('Escape', {}, r.one('.palin input'));
    await r.until('it to close', () => r!.all('.palette').length === 0);
    await r.press('j');
    expect(rowInFocus()).toBe('mcp:.mcp.json/linear');
    await r.press('Enter');
    expect(r.all('.palette')).toEqual([]);
  });
});
