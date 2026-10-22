import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SkillOffer } from '../src/agent-skill.js';
import type { CodingAgentsSettings, MatchingSettings, RedactionSettings, StoreSettings } from '../src/settings.js';
import type { Client } from '../ui/api.js';
import { SettingsPage } from '../ui/pages/Settings.js';
import { agentFileWords, cursorRuleWords, skillWords } from '../ui/pages/settings/logic.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Settings in the states a project gets into. With shadowlap.config.json unreadable, Matching still
 * said "No normalizers yet" under the warning, and Store offered Set up the store, which writes the
 * same unreadable file. With the project's folder gone, Settings showed a healthy empty project and
 * Add rule failed with a raw ENOENT, and Coding agents said the project had no instruction files.
 * And Coding agents said agents need no plugin, while `shadowlap skill install` puts a Cursor rule
 * into the project, which the tab never offered: it is built as the design has it now. Rendered as
 * the page renders them, from what the server sends.
 */

const BROKEN = 'shadowlap.config.json: not valid JSON (Unterminated string in JSON at position 400 (line 18 column 11))';
const config = (error: string | null) => ({ file: 'shadowlap.config.json', path: '/work/research-agent/shadowlap.config.json', exists: true, version: error ? null : 'absent', error });
const form = { kinds: ['api', 'tool'], patterns: ['email', 'uuid'], defaultReplace: '<REDACTED>' };

function matching(error: string | null): MatchingSettings {
  return { config: config(error), rules: [], form, clock: { mode: 'auto', explicit: false, error: null }, calibrate: { runId: 'R1', source: 'newest', label: 'Calibrate 01M5GS3GZR', command: 'shadowlap calibrate 01M5GS3GZR', argv: ['calibrate', 'R1'] } } as unknown as MatchingSettings;
}

function redaction(error: string | null): RedactionSettings {
  return { config: config(error), rules: [], form, where: [], runs: [{ runId: 'R1', label: '01M5GS3GZR · node agent.mjs' }], previewRunId: 'R1', previewError: error } as unknown as RedactionSettings;
}

const store = (error: string | null): StoreSettings => ({ config: config(error), configured: null, error, status: null, ciStep: null, redactRules: error ? null : 0 }) as unknown as StoreSettings;

function offer(o: { cursor: SkillOffer['cursor']; published?: boolean }): SkillOffer {
  return {
    published: o.published ?? false,
    version: '0.1.0',
    plugin: 'shadowlap@shadowlap',
    command: '/shadowlap:debug-agent',
    claudeCode: { path: '.claude/skills/shadowlap', state: 'missing', blocked: null, install: null, installedVersion: null, marketplace: null, everywhere: null },
    cursor: o.cursor,
  };
}

const agents = (skill: SkillOffer): CodingAgentsSettings => ({ files: [{ path: 'CLAUDE.md', agents: 'Claude Code', found: false, type: null, mentions: false }], section: '## Debugging the agent with Shadowlap', source: 'docs/agents.md', skill }) as unknown as CodingAgentsSettings;

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
    registerLayer: () => () => undefined,
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
    await r.until('the tab', () => r!.all('.ruletable').length > 0);
    expect(r.one('.ruletable td.none').textContent).toBe('The rules can’t be read until the file is fixed.');
    expect(r.all('.setrow b').map((b) => b.textContent)).toEqual(['Dates and times']);
    expect(r.one('.verdict h2').textContent).toBe('Fix shadowlap.config.json to change these settings');
  });

  it('says so on Redaction too, with no preview of rules it can’t read', async () => {
    r = await page(app({ client: { redaction: async () => redaction(BROKEN) } }), 'redaction');
    await r.until('the tab', () => r!.all('.ruletable').length > 0);
    expect(r.one('.ruletable td.none').textContent).toBe('The rules can’t be read until the file is fixed.');
    expect(r.all('.preview')).toHaveLength(0);
  });

  it('offers no store setup, which would write into the file every command refuses', async () => {
    r = await page(app({ client: { store: async () => store(BROKEN) } }), 'store');
    await r.until('the tab', () => r!.all('.nostore').length > 0);
    expect(r.one('.nostore h3').textContent).toBe('The store can’t be read');
    expect(r.one('.nostore p').textContent).toBe('Settings reads the team store from shadowlap.config.json, which can’t be read until it is fixed.');
    expect(r.all('.nostore a, .nostore button')).toHaveLength(0);
  });

  it('offers Set up the store for a file that reads and names none', async () => {
    r = await page(app({ client: { store: async () => store(null) } }), 'store');
    await r.until('the tab', () => r!.all('.nostore').length > 0);
    expect(r.one('.nostore h3').textContent).toBe('No store yet');
    expect(r.byText('.nostore a', 'Set up the store').getAttribute('href')).toBe('#/setup/store');
  });

  it('still says "No normalizers yet" and offers Calibrate for a file that reads', async () => {
    r = await page(app({ client: { matching: async () => matching(null) } }), 'matching');
    await r.until('the tab', () => r!.all('.ruletable').length > 0);
    expect(r.one('.ruletable td.none').textContent).toContain('No normalizers yet');
    expect(r.all('.setrow b').map((b) => b.textContent)).toEqual(['Dates and times', 'Calibrate']);
  });
});

describe('Settings for a project whose folder is gone', () => {
  it('says so in its header, turns every edit off with why, and shows no rules it can’t read', async () => {
    r = await page(app({ missing: true, client: { matching: async () => matching(null) } }), 'matching');
    await r.until('the tab', () => r!.all('.ruletable').length > 0);
    expect(r.one('.ph h1').textContent).toBe('Can’t open research-agent');
    expect(r.byText('.ph button', 'Remove from the dashboard').disabled).toBe(false);
    const why = 'research-agent’s folder is gone: put it back or remove the project';
    const add = r.byText('.settab header button', 'Add normalizer');
    expect(add.disabled).toBe(true);
    expect(add.getAttribute('title')).toBe(why);
    for (const b of r.all('.settab .seg button')) expect(b.getAttribute('title')).toBe(why);
    // Not a healthy project with no normalizers yet, and nothing to calibrate.
    expect(r.one('.ruletable td.none').textContent).toBe('The rules can’t be read while the folder is gone.');
    expect(r.all('.setrow b').map((b) => b.textContent)).toEqual(['Dates and times']);
  });

  it('shows no redaction rules or preview there', async () => {
    r = await page(app({ missing: true, client: { redaction: async () => redaction(null) } }), 'redaction');
    await r.until('the tab', () => r!.all('.ruletable').length > 0);
    expect(r.one('.ruletable td.none').textContent).toBe('The rules can’t be read while the folder is gone.');
    expect(r.all('.preview')).toHaveLength(0);
    expect(r.byText('.settab header button', 'Add rule').disabled).toBe(true);
  });

  it('offers no store setup there', async () => {
    r = await page(app({ missing: true, client: { store: async () => store(null) } }), 'store');
    await r.until('the tab', () => r!.all('.nostore').length > 0);
    expect(r.one('.nostore h3').textContent).toBe('The store can’t be read');
    expect(r.one('.nostore p').textContent).toBe('Settings reads the team store from shadowlap.config.json, in the project’s folder, which is gone.');
    expect(r.all('.nostore a, .nostore button')).toHaveLength(0);
  });
});

describe('Coding agents, as the design has it', () => {
  const cursor = (state: SkillOffer['cursor']['state'], o: { replace?: boolean; blocked?: string } = {}): SkillOffer['cursor'] => {
    const replace = o.replace ?? state !== 'missing';
    return { path: '.cursor/rules/shadowlap.mdc', state, blocked: o.blocked ?? null, install: state === 'current' || o.blocked ? null : { job: { kind: 'skill-install', agent: 'cursor', replace }, command: `shadowlap skill install cursor${replace ? ' --force' : ''}` } };
  };
  const files = (o: { claude?: boolean; rules?: boolean } = {}) => [
    { path: 'CLAUDE.md', agents: 'Claude Code', found: !!o.claude, type: o.claude ? 'file' : null, mentions: false },
    { path: 'AGENTS.md', agents: 'Codex, Cursor and others', found: false, type: null, mentions: false },
    { path: '.cursor/rules', agents: 'Cursor', found: !!o.rules, type: o.rules ? 'folder' : null, mentions: !!o.rules },
    { path: '.github/copilot-instructions.md', agents: 'GitHub Copilot', found: false, type: null, mentions: false },
  ];
  const withFiles = (skill: SkillOffer, f = files()) => ({ ...agents(skill), files: f }) as unknown as CodingAgentsSettings;
  const rows = (x: Rendered) => x.all('.agentfiles div').map((d) => d.textContent);

  it('says coding agents need no MCP server, and puts Add the Cursor rule on the .cursor/rules row', async () => {
    const startJob = vi.fn(async () => ({}));
    const watchJob = vi.fn();
    r = await page(app({ client: { agents: async () => withFiles(offer({ cursor: cursor('missing') })), startJob: startJob as unknown as Client['startJob'] }, watchJob }), 'agents');
    await r.until('the tab', () => r!.all('.agentfiles').length > 0);
    expect(r.one('.settab .pbody p.muted').textContent).toBe('Coding agents need no MCP server: the CLI is their interface, and every command reads and writes JSON.');
    // No row of its own for the rule, and none for the plugin, which isn't published.
    expect(r.all('.settab .setrow')).toHaveLength(0);
    expect(rows(r)).toEqual(['CLAUDE.mdnot in this project', 'AGENTS.mdnot in this project', '.cursor/rulesnot in this projectAdd the Cursor rule']);
    const add = r.byText('.agentfiles button', 'Add the Cursor rule');
    expect(add.className).toBe('btn sm');
    expect(add.getAttribute('title')).toBe('shadowlap skill install cursor · writes the rule to .cursor/rules/shadowlap.mdc, from the copy that comes with the CLI');
    await r.click(add);
    expect(startJob).toHaveBeenCalledWith('skill-install', { agent: 'cursor', replace: false });
    expect(watchJob).toHaveBeenCalled();
  });

  it('reads "found · shadowlap.mdc, 0.1.0" once the rule is in, with nothing to do', async () => {
    r = await page(app({ client: { agents: async () => withFiles(offer({ cursor: cursor('current') }), files({ rules: true })) } }), 'agents');
    await r.until('the tab', () => r!.all('.agentfiles').length > 0);
    expect(rows(r)[2]).toBe('.cursor/rulesfound · shadowlap.mdc, 0.1.0');
    expect(r.all('.agentfiles button')).toHaveLength(0);
    expect(r.all('.agentfiles span.ok').map((x) => x.textContent)).toEqual(['found · shadowlap.mdc, 0.1.0']);
  });

  it('asks before Replace writes this version’s rule over one edited here, or another version’s', async () => {
    const startJob = vi.fn(async () => ({}));
    r = await page(app({ client: { agents: async () => withFiles(offer({ cursor: cursor('changed') }), files({ rules: true })), startJob: startJob as unknown as Client['startJob'] } }), 'agents');
    await r.until('the tab', () => r!.all('.agentfiles').length > 0);
    expect(rows(r)[2]).toBe('.cursor/rulesfound · shadowlap.mdc, edited here or another version’sReplace with 0.1.0’s copy…');
    await r.click(r.byText('.agentfiles button', 'Replace with 0.1.0’s copy…'));
    expect(startJob).not.toHaveBeenCalled();
    expect(r.one('.dialog h3').textContent).toBe('Replace the Cursor rule with 0.1.0’s copy?');
    await r.click(r.byText('.dialog button', 'Replace'));
    expect(startJob).toHaveBeenCalledWith('skill-install', { agent: 'cursor', replace: true });
  });

  it('says why a blocked install can’t go in, with no button', async () => {
    r = await page(app({ client: { agents: async () => withFiles(offer({ cursor: cursor('changed', { blocked: '.cursor/rules is a link to outside the project' }) }), files({ rules: true })) } }), 'agents');
    await r.until('the tab', () => r!.all('.agentfiles').length > 0);
    expect(rows(r)[2]).toBe('.cursor/rulesfound · mentions Shadowlap.cursor/rules is a link to outside the project');
    expect(r.one('.agentfiles .agwhy').className).toBe('warn agwhy');
    expect(r.all('.agentfiles button')).toHaveLength(0);
  });

  it('shows The skill once the plugin is published: Install the skill in lime, its command, and every project’s commands', async () => {
    const startJob = vi.fn(async () => ({}));
    const published = offer({ published: true, cursor: cursor('missing') });
    published.claudeCode = { ...published.claudeCode, install: { job: { kind: 'skill-install', agent: 'claude-code', replace: false }, command: 'shadowlap skill install claude-code' }, everywhere: ['claude plugin marketplace add devjoinedthechat/shadowlap@v0.1.0', 'claude plugin install shadowlap@shadowlap', 'claude plugin update shadowlap@shadowlap'] };
    r = await page(app({ client: { agents: async () => withFiles(published, files({ claude: true })), startJob: startJob as unknown as Client['startJob'] } }), 'agents');
    await r.until('the tab', () => r!.all('.agentfiles').length > 0);
    const row = r.one('.setrow.skrow');
    expect(row.querySelector('b')!.textContent).toBe('The skill');
    expect(row.querySelector('span')!.textContent).toBe('debug-agent packages the section below for Claude Code: Claude uses it when a task calls for it, or on /shadowlap:debug-agent.');
    expect(row.querySelector('.cmdline')!.textContent).toBe('$shadowlap skill install claude-code');
    const install = r.byText('.skrow button', 'Install the skill');
    expect(install.className).toBe('btn lime');
    expect(rows(r)[0]).toBe('CLAUDE.mdfound · no Shadowlap section yet');
    await r.click(r.byText('.skrow button', 'In every project on this machine'));
    expect(r.all('.skrow .cmdline')[1]!.textContent).toBe('$claude plugin marketplace add devjoinedthechat/shadowlap@v0.1.0$claude plugin install shadowlap@shadowlap$claude plugin update shadowlap@shadowlap');
    await r.click(install);
    expect(startJob).toHaveBeenCalledWith('skill-install', { agent: 'claude-code', replace: false });
  });

  it('says where the skill is installed, and CLAUDE.md needs no section then', async () => {
    const published = offer({ published: true, cursor: cursor('current') });
    published.claudeCode = { ...published.claudeCode, state: 'current' };
    r = await page(app({ client: { agents: async () => withFiles(published, files({ claude: true })) } }), 'agents');
    await r.until('the tab', () => r!.all('.agentfiles').length > 0);
    expect(r.all('.skrow span').map((x) => x.textContent)).toContain('Installed in .claude/skills/shadowlap, 0.1.0. Commit it, and everyone working on the project has it too.');
    expect(r.one('.skrow .st').textContent).toBe('installed · 0.1.0');
    expect(r.all('.skrow button')).toHaveLength(0);
    expect(rows(r)[0]).toBe('CLAUDE.mdfound · the skill gives Claude Code the section');
  });

  it('updates another version’s plugin without a question, and asks before replacing one edited here', async () => {
    const startJob = vi.fn(async () => ({}));
    const other = offer({ published: true, cursor: cursor('current') });
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
    const file = { found: false, mentions: false };
    expect(cursorRuleWords(file, cursor('missing'), '0.1.0')).toEqual({ text: 'not in this project', tone: 'muted', action: { label: 'Add the Cursor rule', ask: false }, why: null });
    expect(cursorRuleWords({ found: true, mentions: true }, cursor('current'), '0.1.0')).toEqual({ text: 'found · shadowlap.mdc, 0.1.0', tone: 'ok', action: null, why: null });
    expect(cursorRuleWords({ found: true, mentions: true }, cursor('changed'), '0.1.0')).toMatchObject({ tone: 'warn', action: { label: 'Replace with 0.1.0’s copy…', ask: true } });
    expect(agentFileWords({ found: true, mentions: false })).toEqual({ text: 'found · no Shadowlap section yet', tone: 'warn' });
    const plugin = (state: SkillOffer['claudeCode']['state'], installedVersion: string | null = null) => ({ state, blocked: null, installedVersion, install: state === 'current' ? null : { job: { kind: 'skill-install' as const, agent: 'claude-code' as const, replace: state !== 'missing' }, command: `shadowlap skill install claude-code${state !== 'missing' ? ' --force' : ''}` } });
    expect(skillWords(plugin('missing'), '0.1.0')).toMatchObject({ installed: false, command: 'shadowlap skill install claude-code', action: { label: 'Install the skill', ask: false } });
    expect(skillWords(plugin('other-version', '0.0.9'), '0.1.0')).toMatchObject({ line: '0.0.9 in the project.', tone: 'warn', action: { label: 'Update to 0.1.0', ask: false } });
    expect(skillWords(plugin('changed'), '0.1.0')).toMatchObject({ line: 'Edited here.', action: { label: 'Replace with 0.1.0’s copy…', ask: true } });
    expect(skillWords({ ...plugin('changed'), blocked: '.claude/skills/shadowlap/SKILL.md is a link: remove it, then install again' }, '0.1.0')).toEqual({ installed: false, line: '.claude/skills/shadowlap/SKILL.md is a link: remove it, then install again', tone: 'warn', command: null, action: null });
  });

  it('says the instruction files can’t be read while the folder is gone, and offers no install', async () => {
    r = await page(app({ missing: true, client: { agents: async () => withFiles(offer({ cursor: cursor('missing') })) } }), 'agents');
    await r.until('the tab', () => r!.all('.agentsgone').length > 0);
    expect(r.one('.agentsgone').textContent).toBe('The instruction files can’t be read while the folder is gone.');
    expect(r.all('.agentfiles')).toHaveLength(0);
    expect(r.all('.settab button').map((b) => b.textContent)).toEqual(['Copy the section']);
  });
});
