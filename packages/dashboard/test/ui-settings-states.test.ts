import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SkillOffer } from '../src/agent-skill.js';
import type { CodingAgentsSettings, MatchingSettings, RedactionSettings, StoreSettings } from '../src/settings.js';
import type { Client } from '../ui/api.js';
import { SettingsPage } from '../ui/pages/Settings.js';
import { agentInstallWords } from '../ui/pages/settings/logic.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Settings in the states a project gets into. With shadowlap.config.json unreadable, Matching still
 * said "No normalizers yet" under the warning, and Store offered Set up the store, which writes the
 * same unreadable file. With the project's folder gone, Settings showed a healthy empty project and
 * Add rule failed with a raw ENOENT. And Coding agents said agents need no plugin, while `shadowlap
 * skill install` puts a Cursor rule into the project, which the tab never offered. Rendered as the
 * page renders them, from what the server sends.
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

describe('Coding agents', () => {
  const cursor = (state: SkillOffer['cursor']['state'], replace = state !== 'missing'): SkillOffer['cursor'] => ({ path: '.cursor/rules/shadowlap.mdc', state, blocked: null, install: state === 'current' ? null : { job: { kind: 'skill-install', agent: 'cursor', replace }, command: `shadowlap skill install cursor${replace ? ' --force' : ''}` } });

  it('says what the CLI is to them, without "need no plugin", and installs the Cursor rule', async () => {
    const startJob = vi.fn(async () => ({}));
    const watchJob = vi.fn();
    r = await page(app({ client: { agents: async () => agents(offer({ cursor: cursor('missing') })), startJob: startJob as unknown as Client['startJob'] }, watchJob }), 'agents');
    await r.until('the tab', () => r!.all('.agentfiles').length > 0);
    expect(r.one('.settab .pbody p.muted').textContent).not.toContain('need no plugin');
    expect(r.one('.settab .pbody p.muted').textContent).toContain('a Cursor rule to install');
    // The plugin's row waits until it is published; the rule's shows what the project has.
    expect(r.all('.setrow b').map((b) => b.textContent)).toEqual(['Cursor rule']);
    expect(r.one('.setrow').textContent).toContain('.cursor/rules/shadowlap.mdc · not in this project');
    const install = r.byText('.setrow button', 'Install');
    expect(install.getAttribute('title')).toBe('shadowlap skill install cursor');
    await r.click(install);
    expect(startJob).toHaveBeenCalledWith('skill-install', { agent: 'cursor', replace: false });
    expect(watchJob).toHaveBeenCalled();
  });

  it('asks before Update writes this version’s rule over another', async () => {
    const startJob = vi.fn(async () => ({}));
    r = await page(app({ client: { agents: async () => agents(offer({ cursor: cursor('changed') })), startJob: startJob as unknown as Client['startJob'] } }), 'agents');
    await r.until('the tab', () => r!.all('.agentfiles').length > 0);
    await r.click(r.byText('.setrow button', 'Update'));
    expect(startJob).not.toHaveBeenCalled();
    expect(r.one('.dialog h3').textContent).toBe('Replace the Cursor rule?');
    await r.click(r.byText('.dialog button', 'Update'));
    expect(startJob).toHaveBeenCalledWith('skill-install', { agent: 'cursor', replace: true });
  });

  it('shows the plugin once it is published, and nothing to do for this version’s copy', async () => {
    const published = offer({ published: true, cursor: cursor('current') });
    published.claudeCode = { ...published.claudeCode, state: 'other-version', installedVersion: '0.0.9', install: { job: { kind: 'skill-install', agent: 'claude-code', replace: true }, command: 'shadowlap skill install claude-code --force' } };
    r = await page(app({ client: { agents: async () => agents(published) } }), 'agents');
    await r.until('the tab', () => r!.all('.agentfiles').length > 0);
    expect(r.all('.setrow b').map((b) => b.textContent)).toEqual(['Claude Code plugin', 'Cursor rule']);
    expect(r.all('.setrow')[0]!.textContent).toContain('another version’s (0.0.9)');
    expect(r.all('.setrow')[1]!.textContent).toContain('this version’s (0.1.0)');
    expect(r.all('.setrow')[1]!.querySelector('button')).toBeNull();
  });

  it('words each state of a copy in the project', () => {
    const v = { version: '0.1.0', installedVersion: null };
    expect(agentInstallWords('cursor', { state: 'missing', blocked: null }, v)).toEqual({ name: 'Cursor rule', state: 'not in this project', tone: '', button: 'Install' });
    expect(agentInstallWords('cursor', { state: 'current', blocked: null }, v)).toEqual({ name: 'Cursor rule', state: 'this version’s (0.1.0)', tone: 'ok', button: null });
    expect(agentInstallWords('cursor', { state: 'changed', blocked: null }, v)).toMatchObject({ state: 'another version’s, or edited here', button: 'Update' });
    expect(agentInstallWords('claude-code', { state: 'other-version', blocked: null }, { version: '0.1.0', installedVersion: '0.0.9' })).toMatchObject({ name: 'Claude Code plugin', state: 'another version’s (0.0.9)', button: 'Update' });
    expect(agentInstallWords('cursor', { state: 'changed', blocked: '.cursor/rules is a link out of the project' }, v)).toMatchObject({ state: '.cursor/rules is a link out of the project', tone: 'warn', button: null });
  });
});
