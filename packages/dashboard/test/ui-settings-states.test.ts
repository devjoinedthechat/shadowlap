import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SkillOffer } from '../src/agent-skill.js';
import type { CodingAgentsSettings, MatchingSettings, RedactionSettings, StoreSettings, ToolsSettings } from '../src/settings.js';
import type { Client } from '../ui/api.js';
import { SettingsPage } from '../ui/pages/Settings.js';
import { agentFileWords, sharedSkillsWords, skillWords } from '../ui/pages/settings/logic.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Settings in the states a project gets into. With shadowlap.config.json unreadable, Matching still
 * said "No normalizers yet" under the warning, and Store offered Set up the store, which writes the
 * same unreadable file. With the project's folder gone, Settings showed a healthy empty project and
 * Add rule failed with a raw ENOENT, Coding agents and Tools said the project had no instruction
 * files, tool calls or MCP servers, and Matching showed a clock mode it hadn't read. And Coding
 * agents said agents need no plugin, while `shadowlap skill install` puts skills into the project,
 * which the tab never offered: it is built as the design has it now. Rendered as the page
 * renders them, from what the server sends.
 */

const BROKEN = 'shadowlap.config.json: not valid JSON (Unterminated string in JSON at position 400 (line 18 column 11))';
const config = (error: string | null) => ({ file: 'shadowlap.config.json', path: '/work/research-agent/shadowlap.config.json', exists: true, version: error ? null : 'absent', error });
const form = { kinds: ['api', 'tool'], patterns: ['email', 'uuid'], defaultReplace: '<REDACTED>' };

function matching(error: string | null): MatchingSettings {
  return { config: config(error), rules: [], form, clock: { mode: 'auto', explicit: false, error: null }, calibrate: { runId: 'R1', source: 'newest', command: 'shadowlap calibrate R1', argv: ['calibrate', 'R1'], recordings: [{ runId: 'R1' }] } } as unknown as MatchingSettings;
}

function redaction(error: string | null): RedactionSettings {
  return { config: config(error), rules: [], form, where: [], runs: [{ runId: 'R1', label: '01M5GS3GZR · node agent.mjs' }], previewRunId: 'R1', previewError: error } as unknown as RedactionSettings;
}

const store = (error: string | null): StoreSettings => ({ config: config(error), configured: null, error, status: null, ciStep: null, policy: null, redactRules: error ? null : 0 });

const SKILLS: SkillOffer['skills'] = [
  { name: 'setup-agent', command: '/shadowlap:setup-agent', shared: 'shadowlap-setup-agent', does: 'sets Shadowlap up for an agent' },
  { name: 'debug-agent', command: '/shadowlap:debug-agent', shared: 'shadowlap-debug-agent', does: 'debugs it and checks every change to it' },
];

function offer(o: { agents: SkillOffer['agents']; published?: boolean }): SkillOffer {
  return {
    published: o.published ?? false,
    version: '0.1.0',
    plugin: 'shadowlap@shadowlap',
    skills: SKILLS,
    claudeCode: { path: '.claude/skills/shadowlap', state: 'missing', blocked: null, install: null, installedVersion: null, marketplace: null, everywhere: null },
    agents: o.agents,
  };
}

const agents = (skill: SkillOffer): CodingAgentsSettings => ({ files: [{ path: 'CLAUDE.md', agents: 'Claude Code', found: false, type: null, mentions: false }], section: '## Debugging the agent with Shadowlap', source: 'docs/agents.md', skill });

function app(o: { client: Partial<Client['settings']> & { startJob?: Client['startJob'] }; missing?: boolean; watchJob?: AppState['watchJob'] }): AppState {
  const { startJob, ...settings } = o.client;
  const client = { settings, startJob: startJob ?? (async () => ({})), storeSetup: { view: async () => ({ active: false, next: null, setup: {}, ci: [] }) }, teamStore: async () => null, jobs: async () => [] };
  return {
    client,
    meta: { project: { id: 'research-agent', name: 'research-agent', path: '/work/research-agent', ...(o.missing ? { problem: '~/research-agent doesn’t exist any more. Remove the project, or put the folder back.', missing: true } : {}) } },
    runs: [],
    feeds: {},
    jobs: [],
    actionsOff: null,
    hasKind: () => true,
    guard: (fn: () => void) => fn(),
    watchJob: o.watchJob ?? (() => undefined),
    toast: () => undefined,
  } as unknown as AppState;
}

const page = (value: AppState, tab: string) => render(createElement(AppContext.Provider, { value }, createElement(SettingsPage, { tab })));

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

describe('Settings while shadowlap.config.json can’t be read', () => {
  it('says the rules can’t be read where they would be, and offers no Calibrate', async () => {
    r = await page(app({ client: { matching: async () => matching(BROKEN) } }), 'matching');
    await r.until('the tab', () => r!.all('.settab .emptyline, .ruletable').length > 0);
    expect(r.one('.settab .emptyline').textContent).toBe('The rules can’t be read until the file is fixed.');
    expect(r.all('.setrow b').map((b) => b.textContent)).toEqual(['Dates and times']);
    // A verdict line: its word first, in the error tone, which its heading names for a screen reader too.
    expect(r.one('.verdict h2').textContent.replace(/\s+/g, ' ')).toBe('can’t read Fix shadowlap.config.json to change these settings');
    expect(r.one('.verdict .vw').className).toBe('vw err');
  });

  it('says so on Redaction too, with no preview of rules it can’t read', async () => {
    r = await page(app({ client: { redaction: async () => redaction(BROKEN) } }), 'redaction');
    await r.until('the tab', () => r!.all('.settab .emptyline, .ruletable').length > 0);
    expect(r.one('.settab .emptyline').textContent).toBe('The rules can’t be read until the file is fixed.');
    expect(r.all('.preview')).toHaveLength(0);
  });

  it('offers no store setup, which would write into the file every command refuses', async () => {
    r = await page(app({ client: { store: async () => store(BROKEN) } }), 'store');
    await r.until('the tab', () => r!.all('.settab .stepempty').length > 0);
    expect(r.one('.settab .stepempty h2').textContent).toBe('The store can’t be read');
    expect(r.one('.settab .stepempty p').textContent).toBe('Settings reads the team store from shadowlap.config.json, which can’t be read until it is fixed.');
    expect(r.all('.settab .stepempty a, .settab .stepempty button')).toHaveLength(0);
  });

  it('offers Set up team store for a file that reads and names none', async () => {
    r = await page(app({ client: { store: async () => store(null) } }), 'store');
    await r.until('the tab', () => r!.all('.settab .stepempty').length > 0);
    expect(r.one('.settab .stepempty h2').textContent).toBe('No store yet');
    expect(r.byText('.settab .stepempty a', 'Set up team store').getAttribute('href')).toBe('#/setup/store');
  });

  it('still says "No normalizers yet" and offers Calibrate for a file that reads', async () => {
    r = await page(app({ client: { matching: async () => matching(null) } }), 'matching');
    await r.until('the tab', () => r!.all('.settab .emptyline, .ruletable').length > 0);
    expect(r.one('.settab .emptyline').textContent).toContain('No normalizers yet');
    expect(r.all('.setrow b').map((b) => b.textContent)).toEqual(['Dates and times', 'Calibrate']);
  });

  it('titles and confirms each rule dialog with its button’s name', async () => {
    for (const [tab, client, button, name] of [
      ['matching', { matching: async () => matching(null) }, 'Add normalizer…', 'Add normalizer'],
      ['redaction', { redaction: async () => redaction(null) }, 'Add redaction rule…', 'Add redaction rule'],
    ] as const) {
      r = await page(app({ client }), tab);
      await r.until('the tab', () => r!.all('.settab .emptyline, .ruletable').length > 0);
      await r.click(r.byText('.settab header button', button));
      await r.until('the dialog', () => r!.all('.dialog').length === 1);
      expect([r.one('.dialog header h3').textContent, r.one('.dialog .dlg-ok').textContent]).toEqual([name, name]);
      await r.unmount();
      r = null;
    }
  });
});

describe('Settings for a project whose folder is gone', () => {
  it('says so in its header, turns every edit off with why, and shows no rules it can’t read', async () => {
    r = await page(app({ missing: true, client: { matching: async () => matching(null) } }), 'matching');
    await r.until('the tab', () => r!.all('.settab .emptyline, .ruletable').length > 0);
    expect(r.one('.ph h1').textContent).toBe('Can’t open research-agent');
    expect(r.byText('.ph button', 'Remove project…').disabled).toBe(false);
    const why = 'research-agent’s folder is gone: put it back or remove the project';
    const add = r.byText('.settab header button', 'Add normalizer…');
    expect(add.getAttribute('aria-disabled')).toBe('true');
    expect(add.getAttribute('data-why')).toBe(why);
    for (const b of r.all('.settab .seg button')) expect(b.getAttribute('data-why')).toBe(why);
    // Not a healthy project with no normalizers yet, and nothing to calibrate.
    expect(r.one('.settab .emptyline').textContent).toBe('The rules can’t be read while the folder is gone.');
    expect(r.all('.setrow b').map((b) => b.textContent)).toEqual(['Dates and times']);
  });

  it('shows no redaction rules or preview there', async () => {
    r = await page(app({ missing: true, client: { redaction: async () => redaction(null) } }), 'redaction');
    await r.until('the tab', () => r!.all('.settab .emptyline, .ruletable').length > 0);
    expect(r.one('.settab .emptyline').textContent).toBe('The rules can’t be read while the folder is gone.');
    expect(r.all('.preview')).toHaveLength(0);
    expect(r.byText('.settab header button', 'Add redaction rule…').getAttribute('aria-disabled')).toBe('true');
  });

  it('offers no store setup there', async () => {
    r = await page(app({ missing: true, client: { store: async () => store(null) } }), 'store');
    await r.until('the tab', () => r!.all('.settab .stepempty').length > 0);
    expect(r.one('.settab .stepempty h2').textContent).toBe('The store can’t be read');
    expect(r.one('.settab .stepempty p').textContent).toBe('Settings reads the team store from shadowlap.config.json, in the project’s folder, which is gone.');
    expect(r.all('.settab .stepempty a, .settab .stepempty button')).toHaveLength(0);
  });
});

describe('Coding agents, as the design has it', () => {
  const shared = (state: SkillOffer['agents']['state'], o: { blocked?: string; installedVersion?: string } = {}): SkillOffer['agents'] => {
    const replace = state !== 'missing';
    return {
      path: '.agents/skills',
      state,
      blocked: o.blocked ?? null,
      installedVersion: o.installedVersion ?? (state === 'missing' ? null : '0.1.0'),
      install: state === 'current' || o.blocked ? null : { job: { kind: 'skill-install', agent: 'agents', replace }, command: `shadowlap skill install agents${replace ? ' --force' : ''}` },
    };
  };
  const files = (o: { claude?: boolean; agentsMd?: boolean; skills?: boolean; rules?: boolean } = {}) => [
    { path: 'CLAUDE.md', agents: 'Claude Code', found: !!o.claude, type: o.claude ? 'file' : null, mentions: false },
    { path: 'AGENTS.md', agents: 'Codex, Cursor and others', found: !!o.agentsMd, type: o.agentsMd ? 'file' : null, mentions: false },
    { path: '.agents/skills', agents: 'Codex, Cursor, GitHub Copilot, Gemini CLI and others', found: !!o.skills, type: o.skills ? 'folder' : null, mentions: !!o.skills },
    { path: '.cursor/rules', agents: 'Cursor', found: !!o.rules, type: o.rules ? 'folder' : null, mentions: false },
    { path: '.github/copilot-instructions.md', agents: 'GitHub Copilot', found: false, type: null, mentions: false },
  ];
  const withFiles = (skill: SkillOffer, f = files()) => ({ ...agents(skill), files: f }) as unknown as CodingAgentsSettings;
  const rows = (x: Rendered) => x.all('.agentfiles div').map((d) => d.textContent);

  it('says coding agents need no MCP server, and puts Add the skills on the .agents/skills row', async () => {
    const startJob = vi.fn(async () => ({}));
    const watchJob = vi.fn();
    r = await page(app({ client: { agents: async () => withFiles(offer({ agents: shared('missing') })), startJob: startJob as unknown as Client['startJob'] }, watchJob }), 'agents');
    await r.until('the tab', () => r!.all('.agentfiles').length > 0);
    expect(r.one('.settab .pbody p.muted').textContent).toBe('Coding agents need no MCP server: the CLI is their interface, and every command reads and writes JSON.');
    // No row of its own for the skills, and none for the plugin, which isn't published; Cursor's rules and Copilot's file only where the project has them.
    expect(r.all('.settab .setrow')).toHaveLength(0);
    expect(rows(r)).toEqual(['CLAUDE.mdnot in this project', 'AGENTS.mdnot in this project', '.agents/skillsnot in this projectAdd the skills']);
    const add = r.byText('.agentfiles button', 'Add the skills');
    expect(add.className).toBe('btn sm');
    expect(add.getAttribute('title')).toBe('shadowlap skill install agents · writes shadowlap-setup-agent and shadowlap-debug-agent to .agents/skills, from the copy that comes with the CLI');
    await r.click(add);
    expect(startJob).toHaveBeenCalledWith('skill-install', { agent: 'agents', replace: false });
    expect(watchJob).toHaveBeenCalled();
  });

  it('names the skills and their version once they are in, and the files of the agents that read them need no section', async () => {
    r = await page(app({ client: { agents: async () => withFiles(offer({ agents: shared('current') }), files({ agentsMd: true, skills: true, rules: true })) } }), 'agents');
    await r.until('the tab', () => r!.all('.agentfiles').length > 0);
    expect(rows(r)).toEqual([
      'CLAUDE.mdnot in this project',
      'AGENTS.mdfound · the skills give Codex and others the section',
      '.agents/skillsfound · shadowlap-setup-agent, shadowlap-debug-agent, 0.1.0',
      '.cursor/rulesfound · Cursor reads the skills in .agents/skills',
    ]);
    expect(r.all('.agentfiles button')).toHaveLength(0);
  });

  it('asks before Replace writes this version’s skills over ones edited here, and updates another version’s without a question', async () => {
    const startJob = vi.fn(async () => ({}));
    r = await page(app({ client: { agents: async () => withFiles(offer({ agents: shared('changed') }), files({ skills: true })), startJob: startJob as unknown as Client['startJob'] } }), 'agents');
    await r.until('the tab', () => r!.all('.agentfiles').length > 0);
    expect(rows(r)[2]).toBe('.agents/skillsfound · Shadowlap’s skills, edited hereReplace with 0.1.0’s copy…');
    await r.click(r.byText('.agentfiles button', 'Replace with 0.1.0’s copy…'));
    expect(startJob).not.toHaveBeenCalled();
    expect(r.one('.dialog h3').textContent).toBe('Replace skills with 0.1.0’s copy?');
    await r.click(r.byText('.dialog button', 'Replace skills'));
    expect(startJob).toHaveBeenCalledWith('skill-install', { agent: 'agents', replace: true });

    await r.unmount();
    startJob.mockClear();
    r = await page(app({ client: { agents: async () => withFiles(offer({ agents: shared('other-version', { installedVersion: '0.0.9' }) }), files({ skills: true })), startJob: startJob as unknown as Client['startJob'] } }), 'agents');
    await r.until('the tab', () => r!.all('.agentfiles').length > 0);
    expect(rows(r)[2]).toBe('.agents/skillsfound · Shadowlap’s skills 0.0.9Update to 0.1.0');
    await r.click(r.byText('.agentfiles button', 'Update to 0.1.0'));
    expect(startJob).toHaveBeenCalledWith('skill-install', { agent: 'agents', replace: true });
    expect(r.all('.dialog')).toHaveLength(0);
  });

  it('says why a blocked install can’t go in, with no button', async () => {
    r = await page(app({ client: { agents: async () => withFiles(offer({ agents: shared('missing', { blocked: '.agents/skills is a link to outside the project' }) }), files({ skills: true })) } }), 'agents');
    await r.until('the tab', () => r!.all('.agentfiles').length > 0);
    expect(rows(r)[2]).toBe('.agents/skillsfound · mentions Shadowlap.agents/skills is a link to outside the project');
    expect(r.one('.agentfiles .agwhy').className).toBe('warn agwhy');
    expect(r.all('.agentfiles button')).toHaveLength(0);
  });

  it('shows The skills once the plugin is published: Install the skills in lime, their commands, and every project’s commands', async () => {
    const startJob = vi.fn(async () => ({}));
    const published = offer({ published: true, agents: shared('missing') });
    published.claudeCode = { ...published.claudeCode, install: { job: { kind: 'skill-install', agent: 'claude-code', replace: false }, command: 'shadowlap skill install claude-code' }, everywhere: ['claude plugin marketplace add devjoinedthechat/shadowlap@v0.1.0', 'claude plugin install shadowlap@shadowlap', 'claude plugin update shadowlap@shadowlap'] };
    r = await page(app({ client: { agents: async () => withFiles(published, files({ claude: true })), startJob: startJob as unknown as Client['startJob'] } }), 'agents');
    await r.until('the tab', () => r!.all('.agentfiles').length > 0);
    const row = r.one('.setrow.skrow');
    expect(row.querySelector('b')!.textContent).toBe('The skills');
    expect(row.querySelector('span')!.textContent).toBe(
      'setup-agent sets Shadowlap up for an agent, and debug-agent debugs it and checks every change to it: they package the section below for Claude Code, which uses each when a task calls for it, or on /shadowlap:setup-agent and /shadowlap:debug-agent.',
    );
    expect(row.querySelector('.cmdline')!.textContent).toBe('$shadowlap skill install claude-code');
    const install = r.byText('.skrow button', 'Install the skills');
    expect(install.className).toBe('btn lime');
    expect(rows(r)[0]).toBe('CLAUDE.mdfound · no Shadowlap section yet');
    const all = r.byText('.skrow button', 'Show commands for every project');
    expect(all.getAttribute('aria-expanded')).toBe('false');
    await r.click(all);
    expect(all.textContent).toBe('Hide commands for every project');
    expect(all.getAttribute('aria-controls')).toBe('skall');
    // The commands in a box of their own, its Copy in the corner named for what it copies.
    expect(r.one('#skall .boxcopy').getAttribute('aria-label')).toBe('Copy commands');
    expect(r.all('.skrow .cmdline')[1].textContent).toBe('$claude plugin marketplace add devjoinedthechat/shadowlap@v0.1.0$claude plugin install shadowlap@shadowlap$claude plugin update shadowlap@shadowlap');
    await r.click(install);
    expect(startJob).toHaveBeenCalledWith('skill-install', { agent: 'claude-code', replace: false });
  });

  it('says where the plugin is installed, and CLAUDE.md needs no section then', async () => {
    const published = offer({ published: true, agents: shared('current') });
    published.claudeCode = { ...published.claudeCode, state: 'current' };
    r = await page(app({ client: { agents: async () => withFiles(published, files({ claude: true })) } }), 'agents');
    await r.until('the tab', () => r!.all('.agentfiles').length > 0);
    expect(r.all('.skrow span').map((x) => x.textContent)).toContain('Installed in .claude/skills/shadowlap, 0.1.0. Commit it, and everyone working on the project has it too.');
    expect(r.one('.skrow .st').textContent).toBe('installed · 0.1.0');
    expect(r.all('.skrow button')).toHaveLength(0);
    expect(rows(r)[0]).toBe('CLAUDE.mdfound · the skills give Claude Code the section');
  });

  it('updates another version’s plugin without a question, and asks before replacing one edited here', async () => {
    const startJob = vi.fn(async () => ({}));
    const other = offer({ published: true, agents: shared('current') });
    other.claudeCode = { ...other.claudeCode, state: 'other-version', installedVersion: '0.0.9', install: { job: { kind: 'skill-install', agent: 'claude-code', replace: true }, command: 'shadowlap skill install claude-code --force' } };
    r = await page(app({ client: { agents: async () => withFiles(other), startJob: startJob as unknown as Client['startJob'] } }), 'agents');
    await r.until('the tab', () => r!.all('.agentfiles').length > 0);
    expect(r.one('.skrow span.warn').textContent).toBe('0.0.9 in the project.');
    expect(r.one('.skrow .cmdline').textContent).toBe('$shadowlap skill install claude-code --force');
    await r.click(r.byText('.skrow button', 'Update to 0.1.0'));
    expect(startJob).toHaveBeenCalledWith('skill-install', { agent: 'claude-code', replace: true });
    expect(r.all('.dialog')).toHaveLength(0);
  });

  it('words each state of a copy in the project', () => {
    const names = SKILLS.map((x) => x.shared);
    expect(sharedSkillsWords({ found: false, mentions: false }, shared('missing'), '0.1.0', names)).toEqual({ text: 'not in this project', tone: 'muted', action: { label: 'Add the skills', ask: false }, why: null });
    expect(sharedSkillsWords({ found: true, mentions: false }, shared('missing'), '0.1.0', names)).toMatchObject({ text: 'found · no Shadowlap skills yet', tone: 'warn', action: { label: 'Add the skills' } });
    expect(sharedSkillsWords({ found: true, mentions: true }, shared('current'), '0.1.0', names)).toEqual({ text: 'found · shadowlap-setup-agent, shadowlap-debug-agent, 0.1.0', tone: 'ok', action: null, why: null });
    expect(sharedSkillsWords({ found: true, mentions: true }, shared('other-version', { installedVersion: '0.0.9' }), '0.1.0', names)).toMatchObject({ text: 'found · Shadowlap’s skills 0.0.9', tone: 'warn', action: { label: 'Update to 0.1.0', ask: false } });
    expect(sharedSkillsWords({ found: true, mentions: true }, shared('changed'), '0.1.0', names)).toMatchObject({ tone: 'warn', action: { label: 'Replace with 0.1.0’s copy…', ask: true } });
    expect(agentFileWords({ found: true, mentions: false })).toEqual({ text: 'found · no Shadowlap section yet', tone: 'warn' });
    expect(agentFileWords({ found: true, mentions: false }, 'the skills give Codex and others the section')).toEqual({ text: 'found · the skills give Codex and others the section', tone: 'ok' });
    const plugin = (state: SkillOffer['claudeCode']['state'], installedVersion: string | null = null) => ({ state, blocked: null, installedVersion, install: state === 'current' ? null : { job: { kind: 'skill-install' as const, agent: 'claude-code' as const, replace: state !== 'missing' }, command: `shadowlap skill install claude-code${state !== 'missing' ? ' --force' : ''}` } });
    expect(skillWords(plugin('missing'), '0.1.0')).toMatchObject({ installed: false, command: 'shadowlap skill install claude-code', action: { label: 'Install the skills', ask: false } });
    expect(skillWords(plugin('other-version', '0.0.9'), '0.1.0')).toMatchObject({ line: '0.0.9 in the project.', tone: 'warn', action: { label: 'Update to 0.1.0', ask: false } });
    expect(skillWords(plugin('changed'), '0.1.0')).toMatchObject({ line: 'Edited here.', action: { label: 'Replace with 0.1.0’s copy…', ask: true } });
    expect(skillWords({ ...plugin('changed'), blocked: '.claude/skills/shadowlap/SKILL.md is a link: remove it, then install again' }, '0.1.0')).toEqual({ installed: false, line: '.claude/skills/shadowlap/SKILL.md is a link: remove it, then install again', tone: 'warn', command: null, action: null });
  });

  it('says the instruction files can’t be read while the folder is gone, and offers no install', async () => {
    r = await page(app({ missing: true, client: { agents: async () => withFiles(offer({ agents: shared('missing') })) } }), 'agents');
    await r.until('the tab', () => r!.all('.agentsgone').length > 0);
    expect(r.one('.agentsgone').textContent).toBe('The instruction files can’t be read while the folder is gone.');
    expect(r.all('.agentfiles')).toHaveLength(0);
    // The section's one Copy, in its box's corner.
    expect(r.all('.settab button').map((b) => b.getAttribute('aria-label'))).toEqual(['Copy section']);
  });
});

describe('the rest of Settings while its file or folder can’t be read', () => {
  const tools = { live: [], fenced: [], http: [], mcp: { files: [], servers: [], recorded: [], effects: [], clientConfigs: [], otherForms: [] } } as unknown as ToolsSettings;

  it('says on Tools that the recorded calls and the MCP configs can’t be read while the folder is gone', async () => {
    r = await page(app({ missing: true, client: { tools: async () => tools } }), 'tools');
    await r.until('the tab', () => r!.all('.egrp').length > 0);
    const text = r.one('.settab').textContent;
    expect(text).toContain('The recorded tool calls can’t be read while the folder is gone.');
    expect(text).toContain('The MCP configs can’t be read while the folder is gone.');
    expect(text).not.toContain('No tool calls recorded yet');
    expect(text).not.toContain('No MCP server in');
  });

  it('still says there are none in a folder that is there', async () => {
    r = await page(app({ client: { tools: async () => tools } }), 'tools');
    await r.until('the tab', () => r!.all('.egrp').length > 0);
    expect(r.one('.settab').textContent).toContain('No tool calls recorded yet');
  });

  it('shows no clock mode as chosen while the file can’t be read, or the folder is gone', async () => {
    const pressed = (x: Rendered) => x.all('.settab .seg[aria-labelledby="clock-name"] button').map((b) => b.getAttribute('aria-pressed'));
    r = await page(app({ client: { matching: async () => matching(BROKEN) } }), 'matching');
    await r.until('the tab', () => r!.all('.settab .emptyline, .ruletable').length > 0);
    expect(pressed(r)).toEqual(['false', 'false']);
    await r.unmount();
    r = await page(app({ missing: true, client: { matching: async () => matching(null) } }), 'matching');
    await r.until('the tab', () => r!.all('.settab .emptyline, .ruletable').length > 0);
    expect(pressed(r)).toEqual(['false', 'false']);
    await r.unmount();
    r = await page(app({ client: { matching: async () => matching(null) } }), 'matching');
    await r.until('the tab', () => r!.all('.settab .emptyline, .ruletable').length > 0);
    expect(pressed(r)).toEqual(['true', 'false']);
  });
});

describe('a tab that is loading, or whose read failed', () => {
  it('draws its section in quiet bars under its title while it loads', async () => {
    r = await page(app({ client: { tools: () => new Promise<never>(() => undefined) } }), 'tools');
    await r.until('the bars', () => r!.all('.settab .skel').length > 0);
    expect(r.one('.settab .skel h2').textContent).toBe('Tools');
    expect(r.one('.settab .skel [role="status"]').textContent.trim()).toBe('Loading Tools…');
    expect(r.all('.settab .skel .skbars i')).toHaveLength(3);
  });

  it('says what the server said in one line in the error tone, and reads the tab again on Retry', async () => {
    let asked = 0;
    const project = async () => {
      asked++;
      throw new Error('The dashboard server answered 500 for this page’s data.');
    };
    r = await page(app({ client: { project } }), 'project');
    await r.until('the error', () => r!.all('.settab .loaderr').length > 0);
    expect(r.one('.settab .loaderr .st.err').textContent).toBe('couldn’t load');
    expect(r.one('.settab .loaderr p').textContent).toContain('The dashboard server answered 500 for this page’s data.');
    const before = asked;
    await r.click(r.byText('.settab .loaderr button', 'Retry'));
    await r.until('a second read', () => asked > before);
  });
});
