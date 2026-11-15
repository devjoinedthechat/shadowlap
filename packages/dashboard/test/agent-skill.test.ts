import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { SKILLS, SKILL_PUBLISHED, codingAgent, installCodingAgent, installedCopy, marketplaceEnabled, sharedSkill, shippedCodingAgents, shippedFiles, shippedVersion, skillOffer } from '../src/agent-skill.js';
import { cliSpawner, startDashboard, type JobView } from '../src/index.js';
import { codingAgentsSettings } from '../src/settings.js';

/**
 * The coding agents' skills come with the CLI, and `shadowlap skill install` puts that copy into a
 * project: the plugin into `.claude/skills/shadowlap`, the skills alone into `.agents/skills` (or
 * `.kiro/skills`), each as `shadowlap-<skill>`. It never changes what it didn't write unless told to,
 * never touches another tool's skills, never writes through a link out of the project, and Settings
 * → Coding agents reads what a project has there, offering Install the skills (the plugin) only once
 * the owner has published it.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FAKE = fileURLToPath(new URL('./fake-settings-cli.mjs', import.meta.url));
const shipped = shippedCodingAgents()!;
const version = (JSON.parse(readFileSync(join(ROOT, 'packages', 'cli', 'package.json'), 'utf8')) as { version: string }).version;
const PLUGIN_FILES = ['.claude/skills/shadowlap/.claude-plugin/plugin.json', '.claude/skills/shadowlap/skills/debug-agent/SKILL.md', '.claude/skills/shadowlap/skills/setup-agent/SKILL.md'];
const SHARED_FILES = ['.agents/skills/shadowlap-debug-agent/SKILL.md', '.agents/skills/shadowlap-setup-agent/SKILL.md'];
const sharedText = (name: string) => sharedSkill(repo(`coding-agents/claude-code/skills/${name}/SKILL.md`));

const dirs: string[] = [];
const scratch = (name: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `sl-skill-${name}-`)));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const read = (cwd: string, path: string) => readFileSync(join(cwd, ...path.split('/')), 'utf8');
const write = (cwd: string, path: string, text: string) => {
  mkdirSync(join(cwd, ...path.split('/').slice(0, -1)), { recursive: true });
  writeFileSync(join(cwd, ...path.split('/')), text);
};
const repo = (path: string) => readFileSync(join(ROOT, path), 'utf8');

describe('the copy that comes with the CLI', () => {
  it('is the repository’s plugin and its skills, at the CLI’s version, without the plugin’s README', () => {
    expect(shipped).toBeTruthy();
    expect(shippedVersion(shipped)).toBe(version);
    expect(shippedFiles('claude-code', shipped).map((f) => f.rel)).toEqual(['.claude-plugin/plugin.json', 'skills/debug-agent/SKILL.md', 'skills/setup-agent/SKILL.md']);
    for (const f of shippedFiles('claude-code', shipped)) expect(f.bytes.toString('utf8'), f.rel).toBe(repo(`coding-agents/claude-code/${f.rel}`));
    // The skills alone, each named for a folder other tools' skills share, without Claude Code's pre-approvals.
    expect(shippedFiles('agents', shipped).map((f) => [f.rel, f.bytes.toString('utf8')])).toEqual([
      ['shadowlap-debug-agent/SKILL.md', sharedText('debug-agent')],
      ['shadowlap-setup-agent/SKILL.md', sharedText('setup-agent')],
    ]);
    expect(shippedFiles('kiro', shipped)).toEqual(shippedFiles('agents', shipped));
    expect(sharedText('debug-agent')).toMatch(/^---\nname: shadowlap-debug-agent\n/);
    expect(sharedText('debug-agent')).not.toContain('allowed-tools:');
    expect(sharedText('debug-agent')).toContain(`metadata:\n  version: ${version}\n`);
  });

  it('takes each coding agent’s name for the folder it reads', () => {
    expect(['claude-code', 'agents', 'kiro'].map(codingAgent)).toEqual(['claude-code', 'agents', 'kiro']);
    expect(['codex', 'cursor', 'copilot', 'gemini', 'windsurf', 'opencode', 'zed'].map(codingAgent)).toEqual(Array(7).fill('agents'));
    expect(codingAgent('vim')).toBeNull();
    expect(SKILLS.map((s) => [s.name, s.command, s.shared])).toEqual([
      ['setup-agent', '/shadowlap:setup-agent', 'shadowlap-setup-agent'],
      ['debug-agent', '/shadowlap:debug-agent', 'shadowlap-debug-agent'],
    ]);
  });
});

describe('installing', () => {
  it('puts the plugin into the project, then finds it current and leaves it', () => {
    const cwd = scratch('fresh');
    expect(installedCopy(cwd, 'claude-code', shipped)).toMatchObject({ state: 'missing', installedVersion: null, blocked: null });
    const first = installCodingAgent(cwd, 'claude-code', { shipped });
    expect(first).toEqual({
      agent: 'claude-code',
      path: '.claude/skills/shadowlap',
      version,
      before: 'missing',
      installedVersion: null,
      outcome: 'installed',
      files: PLUGIN_FILES.map((path) => ({ path, action: 'written' })),
      reason: null,
    });
    for (const path of PLUGIN_FILES) expect(read(cwd, path)).toBe(repo(`coding-agents/claude-code/${path.slice('.claude/skills/shadowlap/'.length)}`));
    // No README, and nothing left over from the writing.
    expect(readdirSync(join(cwd, '.claude', 'skills', 'shadowlap')).sort()).toEqual(['.claude-plugin', 'skills']);
    expect(readdirSync(join(cwd, '.claude', 'skills', 'shadowlap', '.claude-plugin'))).toEqual(['plugin.json']);
    expect(installedCopy(cwd, 'claude-code', shipped)).toMatchObject({ state: 'current', installedVersion: version });
    expect(installCodingAgent(cwd, 'claude-code', { shipped })).toMatchObject({ before: 'current', outcome: 'unchanged', files: PLUGIN_FILES.map((path) => ({ path, action: 'unchanged' })) });
  });

  it('leaves a copy edited here as it is, and replaces it only with replace', () => {
    const cwd = scratch('edited');
    installCodingAgent(cwd, 'claude-code', { shipped });
    const skill = PLUGIN_FILES[1];
    write(cwd, skill, `${read(cwd, skill)}\nOur own line.\n`);
    const edited = read(cwd, skill);
    const refused = installCodingAgent(cwd, 'claude-code', { shipped });
    expect(refused).toMatchObject({ before: 'changed', installedVersion: version, outcome: 'refused', files: [{ path: skill, action: 'differs' }] });
    expect(refused.reason).toBe(`.claude/skills/shadowlap isn’t ${version}’s copy of the plugin (edited here, or from somewhere else): --force replaces it with ${version}’s`);
    expect(read(cwd, skill)).toBe(edited);
    const replaced = installCodingAgent(cwd, 'claude-code', { shipped, replace: true });
    expect(replaced).toMatchObject({ outcome: 'updated', files: [{ path: PLUGIN_FILES[0], action: 'unchanged' }, { path: skill, action: 'replaced' }, { path: PLUGIN_FILES[2], action: 'unchanged' }] });
    expect(installedCopy(cwd, 'claude-code', shipped).state).toBe('current');
  });

  it('updates another version’s copy with replace, removing what this version doesn’t have', () => {
    const cwd = scratch('older');
    installCodingAgent(cwd, 'claude-code', { shipped });
    const manifest = PLUGIN_FILES[0];
    write(cwd, manifest, read(cwd, manifest).replace(`"version": "${version}"`, '"version": "0.0.9"'));
    write(cwd, '.claude/skills/shadowlap/skills/old-skill/SKILL.md', '---\nname: old-skill\ndescription: An older version’s skill.\n---\n');
    write(cwd, '.claude/skills/shadowlap/skills/old-skill/notes/more.md', 'more');
    expect(installedCopy(cwd, 'claude-code', shipped)).toMatchObject({
      state: 'other-version',
      installedVersion: '0.0.9',
      files: [
        { path: manifest, is: 'differs' },
        { path: '.claude/skills/shadowlap/skills/debug-agent/SKILL.md', is: 'same' },
        { path: '.claude/skills/shadowlap/skills/old-skill/SKILL.md', is: 'extra' },
        { path: '.claude/skills/shadowlap/skills/old-skill/notes/more.md', is: 'extra' },
        { path: '.claude/skills/shadowlap/skills/setup-agent/SKILL.md', is: 'same' },
      ],
    });
    const refused = installCodingAgent(cwd, 'claude-code', { shipped });
    expect(refused.reason).toBe(`.claude/skills/shadowlap holds the Claude Code plugin 0.0.9, not ${version}: --force replaces it with ${version}’s`);
    expect(refused.files.map((f) => f.action)).toEqual(['differs', 'extra', 'extra']);
    expect(existsSync(join(cwd, '.claude', 'skills', 'shadowlap', 'skills', 'old-skill'))).toBe(true);

    const updated = installCodingAgent(cwd, 'claude-code', { shipped, replace: true });
    expect(updated).toMatchObject({ before: 'other-version', installedVersion: '0.0.9', outcome: 'updated' });
    expect(updated.files.filter((f) => f.action !== 'unchanged')).toEqual([
      { path: manifest, action: 'replaced' },
      { path: '.claude/skills/shadowlap/skills/old-skill/SKILL.md', action: 'removed' },
      { path: '.claude/skills/shadowlap/skills/old-skill/notes/more.md', action: 'removed' },
    ]);
    // The older skill's folders go with it: it would go on loading otherwise.
    expect(readdirSync(join(cwd, '.claude', 'skills', 'shadowlap', 'skills')).sort()).toEqual(['debug-agent', 'setup-agent']);
    expect(installedCopy(cwd, 'claude-code', shipped).state).toBe('current');
  });

  it('puts the skills into .agents/skills beside other tools’ skills, and leaves edited ones unless told', () => {
    const cwd = scratch('agents');
    write(cwd, '.agents/skills/house-style/SKILL.md', '---\nname: house-style\ndescription: Our style.\n---\n');
    expect(installedCopy(cwd, 'agents', shipped)).toMatchObject({ path: '.agents/skills', state: 'missing', installedVersion: null, blocked: null });
    expect(installCodingAgent(cwd, 'agents', { shipped })).toEqual({
      agent: 'agents',
      path: '.agents/skills',
      version,
      before: 'missing',
      installedVersion: null,
      outcome: 'installed',
      files: SHARED_FILES.map((path) => ({ path, action: 'written' })),
      reason: null,
    });
    expect(read(cwd, SHARED_FILES[0])).toBe(sharedText('debug-agent'));
    expect(readdirSync(join(cwd, '.agents', 'skills')).sort()).toEqual(['house-style', 'shadowlap-debug-agent', 'shadowlap-setup-agent']);
    expect(installedCopy(cwd, 'agents', shipped)).toMatchObject({ state: 'current', installedVersion: version });

    write(cwd, SHARED_FILES[1], `${read(cwd, SHARED_FILES[1])}\nOur own line.\n`);
    const refused = installCodingAgent(cwd, 'agents', { shipped });
    expect(refused).toMatchObject({ before: 'changed', installedVersion: version, outcome: 'refused', files: [{ path: SHARED_FILES[1], action: 'differs' }] });
    expect(refused.reason).toBe(`shadowlap’s skills in .agents/skills aren’t ${version}’s copy (edited here, or from somewhere else): --force replaces them with ${version}’s`);
    expect(installCodingAgent(cwd, 'agents', { shipped, replace: true })).toMatchObject({ outcome: 'updated', files: [{ path: SHARED_FILES[0], action: 'unchanged' }, { path: SHARED_FILES[1], action: 'replaced' }] });
    expect(read(cwd, '.agents/skills/house-style/SKILL.md')).toContain('name: house-style');
    // Kiro's folder takes the same skills.
    expect(installCodingAgent(cwd, 'kiro', { shipped })).toMatchObject({ path: '.kiro/skills', outcome: 'installed' });
    expect(read(cwd, '.kiro/skills/shadowlap-setup-agent/SKILL.md')).toBe(sharedText('setup-agent'));
  });

  it('updates another version’s skills with replace, removing a skill of ours this version doesn’t have, and nothing else', () => {
    const cwd = scratch('agents-older');
    installCodingAgent(cwd, 'agents', { shipped });
    for (const path of SHARED_FILES) write(cwd, path, read(cwd, path).replace(`  version: ${version}\n`, '  version: 0.0.9\n'));
    write(cwd, '.agents/skills/shadowlap-old-skill/SKILL.md', '---\nname: shadowlap-old-skill\ndescription: An older version’s skill.\nmetadata:\n  version: 0.0.9\n---\n');
    write(cwd, '.agents/skills/someone-elses/SKILL.md', '---\nname: someone-elses\ndescription: Not ours.\n---\n');
    expect(installedCopy(cwd, 'agents', shipped)).toMatchObject({
      state: 'other-version',
      installedVersion: '0.0.9',
      files: [
        { path: SHARED_FILES[0], is: 'differs' },
        { path: '.agents/skills/shadowlap-old-skill/SKILL.md', is: 'extra' },
        { path: SHARED_FILES[1], is: 'differs' },
      ],
    });
    expect(installCodingAgent(cwd, 'agents', { shipped }).reason).toBe(`.agents/skills holds shadowlap’s skills 0.0.9, not ${version}: --force replaces them with ${version}’s`);
    const updated = installCodingAgent(cwd, 'agents', { shipped, replace: true });
    expect(updated).toMatchObject({ before: 'other-version', installedVersion: '0.0.9', outcome: 'updated' });
    expect(updated.files).toEqual([
      { path: SHARED_FILES[0], action: 'replaced' },
      { path: SHARED_FILES[1], action: 'replaced' },
      { path: '.agents/skills/shadowlap-old-skill/SKILL.md', action: 'removed' },
    ]);
    // The older skill's folder goes with it; another tool's skill stays.
    expect(readdirSync(join(cwd, '.agents', 'skills')).sort()).toEqual(['shadowlap-debug-agent', 'shadowlap-setup-agent', 'someone-elses']);
    expect(installedCopy(cwd, 'agents', shipped).state).toBe('current');
  });

  it('never writes through a link out of the project, nor replaces a link it finds in its place', () => {
    const outside = scratch('outside');
    // .agents/skills is a link to a folder outside the project: refused, with replace too.
    const cwd = scratch('linked');
    mkdirSync(join(cwd, '.agents'));
    symlinkSync(outside, join(cwd, '.agents', 'skills'), 'dir');
    for (const replace of [false, true]) {
      expect(installCodingAgent(cwd, 'agents', { shipped, replace })).toMatchObject({ outcome: 'refused', files: [], reason: '.agents/skills is a link to outside the project: nothing was written' });
    }
    expect(readdirSync(outside)).toEqual([]);
    expect(installedCopy(cwd, 'agents', shipped)).toMatchObject({ state: 'missing', blocked: '.agents/skills is a link to outside the project' });

    // A link that stays in the project, as a folder of skills shared with Claude Code's: followed.
    const mono = scratch('mono');
    mkdirSync(join(mono, '.claude', 'skills'), { recursive: true });
    mkdirSync(join(mono, '.agents'));
    symlinkSync(join(mono, '.claude', 'skills'), join(mono, '.agents', 'skills'), 'dir');
    expect(installCodingAgent(mono, 'agents', { shipped }).outcome).toBe('installed');
    expect(readFileSync(join(mono, '.claude', 'skills', 'shadowlap-debug-agent', 'SKILL.md'), 'utf8')).toBe(sharedText('debug-agent'));

    // A skill's own folder a link (to a folder outside): never followed, never replaced.
    const own = scratch('own-link');
    mkdirSync(join(own, '.agents', 'skills'), { recursive: true });
    symlinkSync(outside, join(own, '.agents', 'skills', 'shadowlap-debug-agent'), 'dir');
    expect(installCodingAgent(own, 'agents', { shipped, replace: true })).toMatchObject({ before: 'changed', outcome: 'refused', reason: '.agents/skills/shadowlap-debug-agent is a link: remove it, then install again: nothing was written' });
    expect(readdirSync(outside)).toEqual([]);

    // A link inside the plugin's folder, and a file where a folder goes.
    const inPlugin = scratch('plugin-link');
    installCodingAgent(inPlugin, 'claude-code', { shipped });
    symlinkSync(outside, join(inPlugin, '.claude', 'skills', 'shadowlap', 'skills', 'elsewhere'), 'dir');
    expect(installCodingAgent(inPlugin, 'claude-code', { shipped, replace: true })).toMatchObject({ outcome: 'refused', reason: '.claude/skills/shadowlap/skills/elsewhere is a link: remove it, then install again: nothing was written' });
    const file = scratch('file');
    writeFileSync(join(file, '.claude'), 'not a folder');
    expect(installCodingAgent(file, 'claude-code', { shipped, replace: true })).toMatchObject({ before: 'missing', outcome: 'refused', reason: '.claude is a file, where a folder goes: nothing was written' });
  });
});

describe('which settings turn on the plugin installed from the marketplace', () => {
  it('are weighed as Claude Code weighs them: local over project over user', () => {
    const cwd = scratch('settings');
    const user = scratch('claude-home');
    const on = (value: boolean) => JSON.stringify({ enabledPlugins: { 'shadowlap@shadowlap': value, 'other@market': true } });
    expect(marketplaceEnabled(cwd, user)).toBeNull();
    writeFileSync(join(user, 'settings.json'), on(true));
    expect(marketplaceEnabled(cwd, user)).toBe('user');
    write(cwd, '.claude/settings.json', on(false));
    expect(marketplaceEnabled(cwd, user)).toBeNull();
    write(cwd, '.claude/settings.local.json', on(true));
    expect(marketplaceEnabled(cwd, user)).toBe('local');
    // A file Claude Code couldn't read either says nothing.
    write(cwd, '.claude/settings.local.json', '{ not json');
    expect(marketplaceEnabled(cwd, user)).toBeNull();
  });
});

describe('the offer on Settings → Coding agents', () => {
  const home = () => scratch('claude-home');

  it('offers no Install the skills until the owner has published the plugin, and the skills in .agents/skills at any time', () => {
    const cwd = scratch('offer');
    const offer = skillOffer({ cwd, published: false, shipped, claudeConfigDir: home() });
    expect(offer).toEqual({
      published: false,
      version,
      plugin: 'shadowlap@shadowlap',
      skills: SKILLS,
      claudeCode: { path: '.claude/skills/shadowlap', state: 'missing', blocked: null, install: null, installedVersion: null, marketplace: null, everywhere: null },
      agents: { path: '.agents/skills', state: 'missing', blocked: null, install: { job: { kind: 'skill-install', agent: 'agents', replace: false }, command: 'shadowlap skill install agents' }, installedVersion: null },
    });
    // The tab's read model carries it, for the project, as SKILL_PUBLISHED says.
    process.env.CLAUDE_CONFIG_DIR = home();
    try {
      const tab = codingAgentsSettings({ cwd }).skill;
      expect(tab.published).toBe(SKILL_PUBLISHED);
      expect(tab.claudeCode.install === null).toBe(!SKILL_PUBLISHED);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  it('once published, installs the plugin into the project in one click, or everywhere at this version’s tag', () => {
    const cwd = scratch('published');
    const offer = skillOffer({ cwd, published: true, shipped, claudeConfigDir: home() });
    expect(offer.claudeCode.install).toEqual({ job: { kind: 'skill-install', agent: 'claude-code', replace: false }, command: 'shadowlap skill install claude-code' });
    expect(offer.claudeCode.everywhere).toEqual([
      `claude plugin marketplace add devjoinedthechat/shadowlap@v${version}`,
      'claude plugin install shadowlap@shadowlap',
      // Installing again doesn't move an earlier install to this version; updating does.
      'claude plugin update shadowlap@shadowlap',
    ]);
  });

  it('follows what the project has: nothing to do once current, a replace for another version or an edit', () => {
    const cwd = scratch('states');
    installCodingAgent(cwd, 'claude-code', { shipped });
    installCodingAgent(cwd, 'agents', { shipped });
    let offer = skillOffer({ cwd, published: true, shipped, claudeConfigDir: home() });
    expect([offer.claudeCode.state, offer.claudeCode.install, offer.claudeCode.installedVersion]).toEqual(['current', null, version]);
    expect([offer.agents.state, offer.agents.install, offer.agents.installedVersion]).toEqual(['current', null, version]);
    write(cwd, PLUGIN_FILES[0], read(cwd, PLUGIN_FILES[0]).replace(`"version": "${version}"`, '"version": "0.0.9"'));
    write(cwd, SHARED_FILES[0], 'edited');
    offer = skillOffer({ cwd, published: true, shipped, claudeConfigDir: home() });
    expect(offer.claudeCode).toMatchObject({ state: 'other-version', installedVersion: '0.0.9', install: { job: { kind: 'skill-install', agent: 'claude-code', replace: true }, command: 'shadowlap skill install claude-code --force' } });
    expect(offer.agents).toMatchObject({ state: 'changed', install: { job: { agent: 'agents', replace: true }, command: 'shadowlap skill install agents --force' } });
    // Blocked: nothing an install could do there.
    const linked = scratch('offer-linked');
    mkdirSync(join(linked, '.agents'));
    symlinkSync(scratch('elsewhere'), join(linked, '.agents', 'skills'), 'dir');
    expect(skillOffer({ cwd: linked, published: true, shipped, claudeConfigDir: home() }).agents).toMatchObject({ blocked: '.agents/skills is a link to outside the project', install: null });
  });

  it('says which settings file turns on a marketplace install, and offers nothing a CLI without the copy could do', () => {
    const cwd = scratch('marketplace');
    const user = home();
    writeFileSync(join(user, 'settings.json'), JSON.stringify({ enabledPlugins: { 'shadowlap@shadowlap': true } }));
    expect(skillOffer({ cwd, published: true, shipped, claudeConfigDir: user }).claudeCode.marketplace).toBe('user');
    const none = skillOffer({ cwd, published: true, shipped: null, claudeConfigDir: user });
    expect(none).toMatchObject({ version: null, claudeCode: { install: null, everywhere: null }, agents: { install: null } });
  });
});

describe('Settings → Coding agents over HTTP', () => {
  let project: string;
  let store: Store;
  let dash: Awaited<ReturnType<typeof startDashboard>>;
  const env = { ...process.env };
  beforeAll(async () => {
    process.env.CLAUDE_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'sl-skill-claude-')));
    project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-skill-route-')));
    mkdirSync(join(project, '.shadowlap'));
    const dbPath = join(project, '.shadowlap', 'shadowlap.db');
    store = Store.open(dbPath);
    dash = await startDashboard({ store, dbPath, spawnCli: cliSpawner({ command: [process.execPath, FAKE], dbPath, cwd: project }), project: { path: project } });
  });
  afterAll(async () => {
    await dash.close();
    store.close();
    rmSync(project, { recursive: true, force: true });
    rmSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true, force: true });
    process.env = env;
  });
  const api = (path: string, body?: unknown) =>
    fetch(`${dash.url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-shadowlap-token': dash.token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  it('GET /api/settings/agents carries the offer for the project', async () => {
    const res = await api('settings/agents');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skill: unknown; section: string | null };
    expect(body.skill).toEqual(skillOffer({ cwd: project }));
    expect(body.section).toMatch(/shadowlap replay/);
  });

  it('the skill-install job runs skill install for the agent asked, with --force to replace', async () => {
    const started = async (body: Record<string, unknown>) => {
      const res = await api('jobs', { kind: 'skill-install', ...body });
      expect(res.status, JSON.stringify(body)).toBe(202);
      return (await res.json()) as JobView;
    };
    expect(await started({ agent: 'agents' })).toMatchObject({ args: ['skill', 'install', 'agents'], title: 'Adding the skills to .agents/skills' });
    expect(await started({ agent: 'kiro' })).toMatchObject({ args: ['skill', 'install', 'kiro'], title: 'Adding the skills to .kiro/skills' });
    expect(await started({ agent: 'claude-code', replace: true })).toMatchObject({ args: ['skill', 'install', 'claude-code', '--force'], title: 'Installing the skill' });
    // The job takes where to install, not an agent's name: the dashboard offers the folder.
    for (const body of [{ agent: 'codex' }, {}, { agent: 'agents', replace: 'yes' }]) expect((await api('jobs', { kind: 'skill-install', ...body })).status, JSON.stringify(body)).toBe(400);
  });
});
