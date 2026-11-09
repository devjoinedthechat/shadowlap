import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodingAgentsSettings, ToolsSettings } from '../src/settings.js';
import { SettingsPage } from '../ui/pages/Settings.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Settings → Tools and Coding agents as the design draws them: Tools headed in words with its
 * settled sentence (writes are blocked or stubbed unless you allow them), the MCP clients' configs
 * folded under Show the client’s config, each box's one Copy named for what it copies, and Coding
 * agents' section in a box with its Copy in the corner and the line on where to paste it under it.
 */

const SETTLED = 'Declared in the agent’s code. After a fork, reads run live and writes are blocked or stubbed unless you allow them, so by default a replay never acts on the world twice.';
const EXAMPLE = '{\n  "mcpServers": {\n    "filesystem": { "command": "npx", "args": ["shadowlap", "mcp", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem"] }\n  }\n}';

function tools(clientConfigs: ToolsSettings['mcp']['clientConfigs'], otherForms: ToolsSettings['mcp']['otherForms'] = []): ToolsSettings {
  return { live: [], fenced: [], http: [], mcp: { files: [], servers: [], recorded: [], effects: [], clientConfigs, otherForms } } as unknown as ToolsSettings;
}

const agents: CodingAgentsSettings = {
  files: [{ path: 'CLAUDE.md', agents: 'Claude Code', found: true, type: 'file', mentions: false }],
  section: '## Debugging the agent with Shadowlap',
  source: 'docs/agents.md',
  skill: null,
} as unknown as CodingAgentsSettings;

function app(settings: Record<string, () => Promise<unknown>>, toasts: string[] = []): AppState {
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
    toast: (t: string) => void toasts.push(t),
  } as unknown as AppState;
}

const page = (value: AppState, tab: string) => render(createElement(AppContext.Provider, { value }, createElement(SettingsPage, { tab })));

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

describe('Settings → Tools', () => {
  it('is headed Tools, what a fork runs again, and keeps the settled sentence: writes are fenced unless you allow them', async () => {
    r = await page(app({ tools: async () => tools([]) }), 'tools');
    await r.until('the tab', () => r!.all('.egrp.mcp').length > 0);
    expect(r.one('.settab .panel.sec h2').textContent).toBe('Tools');
    expect(r.one('.settab .panel.sec .sub').textContent).toBe('what a fork runs again');
    expect(r.one('.settab .panel.sec .pbody p.muted').textContent).toBe(SETTLED);
    // With no config to copy, nothing folds.
    expect(r.all('.wftog')).toHaveLength(0);
  });

  it('folds the client’s config under its toggle, closed at first and as it was left while the page is open', async () => {
    const toasts: string[] = [];
    const value = app({ tools: async () => tools([{ file: null, text: EXAMPLE, putBack: [], notes: [] }]) }, toasts);
    r = await page(value, 'tools');
    await r.until('the tab', () => r!.all('.egrp.mcp').length > 0);
    const toggle = r.one('.wftog button');
    expect(toggle.textContent).toBe('Show the client’s config');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('mcpCfg');
    expect(r.one('#mcpCfg').hasAttribute('hidden')).toBe(true);
    await r.click(toggle);
    expect(toggle.textContent).toBe('Hide the client’s config');
    expect(r.one('#mcpCfg').hasAttribute('hidden')).toBe(false);
    // The docs' example in a box, its one Copy in the corner named for what it copies.
    expect(r.one('#mcpCfg .boxwrap.mcpjson pre.codebox').textContent).toBe(EXAMPLE);
    const copy = r.one('#mcpCfg .boxwrap .boxcopy');
    expect(copy.getAttribute('aria-label')).toBe('Copy MCP config');
    await r.unmount();
    // Back on the tab, it is as it was left.
    r = await page(value, 'tools');
    await r.until('the tab', () => r!.all('.egrp.mcp').length > 0);
    expect(r.one('.wftog button').getAttribute('aria-expanded')).toBe('true');
    await r.click(r.one('.wftog button'));
    expect(r.one('#mcpCfg').hasAttribute('hidden')).toBe(true);
  });

  it('names a project file’s config in its box’s header, Copy MCP config beside it, and what the copy leaves out right under it', async () => {
    const text = '{ "mcpServers": { "stripe": { "url": "http://127.0.0.1:4790/mcp" } } }';
    r = await page(app({ tools: async () => tools([{ file: '.mcp.json', text, putBack: [{ server: 'stripe', values: ['headers.Authorization'] }], notes: [] }], ['stdio']) }), 'tools');
    await r.until('the tab', () => r!.all('.egrp.mcp').length > 0);
    await r.click(r.one('.wftog button'));
    const box = r.one('#mcpCfg .codewrap');
    expect(box.querySelector('.codehead span')!.textContent).toBe('.mcp.json');
    expect(box.querySelector('.codehead button')!.textContent).toBe('Copy MCP config');
    expect(box.querySelector('pre.codebox')!.textContent).toBe(text);
    const kids = r.one('#mcpCfg').children.map((c) => c.className);
    expect(kids).toEqual(['codewrap', 'fieldnote warn putback', 'mcpform2']);
    expect(r.one('#mcpCfg .putback').textContent).toBe('Values aren’t copied. Put these back before the client starts the server:stripe headers.Authorization');
  });
});

describe('Settings → Coding agents', () => {
  it('gives the section a box with Copy section in its corner, and says under it where to paste it', async () => {
    r = await page(app({ agents: async () => agents }), 'agents');
    await r.until('the tab', () => r!.all('.agentfiles').length > 0);
    expect(r.one('.boxwrap.md pre.codebox').textContent).toBe('## Debugging the agent with Shadowlap');
    expect(r.one('.boxwrap.md .boxcopy').getAttribute('aria-label')).toBe('Copy section');
    const kids = r.one('.boxwrap.md').parentNode!.children;
    const hint = kids[kids.indexOf(r.one('.boxwrap.md')) + 1];
    expect([hint.tagName.toLowerCase(), hint.className, hint.textContent]).toEqual(['p', 'hintx', 'Paste it into CLAUDE.md.']);
  });
});
