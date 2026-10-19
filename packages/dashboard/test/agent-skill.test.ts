import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { SKILL_PUBLISHED, installCodingAgent, installedCopy, marketplaceEnabled, shippedCodingAgents, shippedFiles, shippedVersion, skillOffer } from '../src/agent-skill.js';
import { cliSpawner, startDashboard, type JobView } from '../src/index.js';
import { codingAgentsSettings } from '../src/settings.js';

/**
 * The coding agents' plugin and rule come with the CLI, and `shadowlap skill install` puts that
 * copy into a project: the plugin into `.claude/skills/shadowlap`, the rule into
 * `.cursor/rules/shadowlap.mdc`. It never changes what it didn't write unless told to, never writes
 * through a link out of the project, and Settings → Coding agents reads what a project has there,
 * offering Install the skill only once the owner has published it.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FAKE = fileURLToPath(new URL('./fake-settings-cli.mjs', import.meta.url));
const shipped = shippedCodingAgents()!;
const version = (JSON.parse(readFileSync(join(ROOT, 'packages', 'cli', 'package.json'), 'utf8')) as { version: string }).version;
const PLUGIN_FILES = ['.claude/skills/shadowlap/.claude-plugin/plugin.json', '.claude/skills/shadowlap/skills/debug-agent/SKILL.md'];
const RULE = '.cursor/rules/shadowlap.mdc';

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
  it('is the repository’s plugin and rule, at the CLI’s version, without the plugin’s README', () => {
    expect(shipped).toBeTruthy();
    expect(shippedVersion(shipped)).toBe(version);
    expect(shippedFiles('claude-code', shipped).map((f) => f.rel)).toEqual(['.claude-plugin/plugin.json', 'skills/debug-agent/SKILL.md']);
    for (const f of shippedFiles('claude-code', shipped)) expect(f.bytes.toString('utf8'), f.rel).toBe(repo(`coding-agents/claude-code/${f.rel}`));
    expect(shippedFiles('cursor', shipped).map((f) => [f.rel, f.bytes.toString('utf8')])).toEqual([['', repo('coding-agents/cursor/shadowlap.mdc')]]);
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
    const skill = PLUGIN_FILES[1]!;
    write(cwd, skill, `${read(cwd, skill)}\nOur own line.\n`);
    const edited = read(cwd, skill);
    const refused = installCodingAgent(cwd, 'claude-code', { shipped });
    expect(refused).toMatchObject({ before: 'changed', installedVersion: version, outcome: 'refused', files: [{ path: skill, action: 'differs' }] });
    expect(refused.reason).toBe(`.claude/skills/shadowlap isn’t ${version}’s copy of the plugin (edited here, or from somewhere else): --force replaces it with ${version}’s`);
    expect(read(cwd, skill)).toBe(edited);
    const replaced = installCodingAgent(cwd, 'claude-code', { shipped, replace: true });
    expect(replaced).toMatchObject({ outcome: 'updated', files: [{ path: PLUGIN_FILES[0], action: 'unchanged' }, { path: skill, action: 'replaced' }] });
    expect(installedCopy(cwd, 'claude-code', shipped).state).toBe('current');
  });

  it('updates another version’s copy with replace, removing what this version doesn’t have', () => {
    const cwd = scratch('older');
    installCodingAgent(cwd, 'claude-code', { shipped });
    const manifest = PLUGIN_FILES[0]!;
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
    expect(readdirSync(join(cwd, '.claude', 'skills', 'shadowlap', 'skills'))).toEqual(['debug-agent']);
    expect(installedCopy(cwd, 'claude-code', shipped).state).toBe('current');
  });

  it('puts the rule into .cursor/rules beside the project’s own, and leaves an edited one unless told', () => {
    const cwd = scratch('cursor');
    write(cwd, '.cursor/rules/house-style.mdc', '---\ndescription: Our style\nalwaysApply: true\n---\n');
    expect(installCodingAgent(cwd, 'cursor', { shipped })).toMatchObject({ path: RULE, before: 'missing', installedVersion: null, outcome: 'installed', files: [{ path: RULE, action: 'written' }] });
    expect(read(cwd, RULE)).toBe(repo('coding-agents/cursor/shadowlap.mdc'));
    expect(installedCopy(cwd, 'cursor', shipped).state).toBe('current');
    write(cwd, RULE, 'our rule now');
    expect(installCodingAgent(cwd, 'cursor', { shipped })).toMatchObject({ before: 'changed', outcome: 'refused', reason: `${RULE} isn’t ${version}’s rule (edited here, or another version’s): --force replaces it with ${version}’s` });
    expect(read(cwd, RULE)).toBe('our rule now');
    expect(installCodingAgent(cwd, 'cursor', { shipped, replace: true })).toMatchObject({ outcome: 'updated', files: [{ path: RULE, action: 'replaced' }] });
    expect(readdirSync(join(cwd, '.cursor', 'rules')).sort()).toEqual(['house-style.mdc', 'shadowlap.mdc']);
  });

  it('never writes through a link out of the project, nor replaces a link it finds in its place', () => {
    const outside = scratch('outside');
    // .cursor/rules is a link to a folder outside the project: refused, with replace too.
    const cwd = scratch('linked');
    mkdirSync(join(cwd, '.cursor'));
    symlinkSync(outside, join(cwd, '.cursor', 'rules'), 'dir');
    for (const replace of [false, true]) {
      expect(installCodingAgent(cwd, 'cursor', { shipped, replace })).toMatchObject({ outcome: 'refused', files: [], reason: '.cursor/rules is a link to outside the project: nothing was written' });
    }
    expect(readdirSync(outside)).toEqual([]);
    expect(installedCopy(cwd, 'cursor', shipped)).toMatchObject({ state: 'missing', blocked: '.cursor/rules is a link to outside the project' });

    // A link that stays in the project, as a monorepo's shared rules folder: followed.
    const mono = scratch('mono');
    mkdirSync(join(mono, 'shared', 'rules'), { recursive: true });
    mkdirSync(join(mono, '.cursor'));
    symlinkSync(join(mono, 'shared', 'rules'), join(mono, '.cursor', 'rules'), 'dir');
    expect(installCodingAgent(mono, 'cursor', { shipped }).outcome).toBe('installed');
    expect(readFileSync(join(mono, 'shared', 'rules', 'shadowlap.mdc'), 'utf8')).toBe(repo('coding-agents/cursor/shadowlap.mdc'));

    // The rule's own file a link (to a file outside): never followed, never replaced.
    const target = join(outside, 'theirs.mdc');
    writeFileSync(target, 'theirs');
    const own = scratch('own-link');
    mkdirSync(join(own, '.cursor', 'rules'), { recursive: true });
    symlinkSync(target, join(own, '.cursor', 'rules', 'shadowlap.mdc'));
    expect(installCodingAgent(own, 'cursor', { shipped, replace: true })).toMatchObject({ before: 'changed', outcome: 'refused', reason: `${RULE} is a link: remove it, then install again: nothing was written` });
    expect(readFileSync(target, 'utf8')).toBe('theirs');

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

  it('offers no Install the skill until the owner has published it, and the rule at any time', () => {
    const cwd = scratch('offer');
    const offer = skillOffer({ cwd, published: false, shipped, claudeConfigDir: home() });
    expect(offer).toEqual({
      published: false,
      version,
      plugin: 'shadowlap@shadowlap',
      command: '/shadowlap:debug-agent',
      claudeCode: { path: '.claude/skills/shadowlap', state: 'missing', blocked: null, install: null, installedVersion: null, marketplace: null, everywhere: null },
      cursor: { path: RULE, state: 'missing', blocked: null, install: { job: { kind: 'skill-install', agent: 'cursor', replace: false }, command: 'shadowlap skill install cursor' } },
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
    installCodingAgent(cwd, 'cursor', { shipped });
    let offer = skillOffer({ cwd, published: true, shipped, claudeConfigDir: home() });
    expect([offer.claudeCode.state, offer.claudeCode.install, offer.claudeCode.installedVersion]).toEqual(['current', null, version]);
    expect([offer.cursor.state, offer.cursor.install]).toEqual(['current', null]);
    write(cwd, PLUGIN_FILES[0]!, read(cwd, PLUGIN_FILES[0]!).replace(`"version": "${version}"`, '"version": "0.0.9"'));
    write(cwd, RULE, 'edited');
    offer = skillOffer({ cwd, published: true, shipped, claudeConfigDir: home() });
    expect(offer.claudeCode).toMatchObject({ state: 'other-version', installedVersion: '0.0.9', install: { job: { kind: 'skill-install', agent: 'claude-code', replace: true }, command: 'shadowlap skill install claude-code --force' } });
    expect(offer.cursor).toMatchObject({ state: 'changed', install: { job: { agent: 'cursor', replace: true }, command: 'shadowlap skill install cursor --force' } });
    // Blocked: nothing an install could do there.
    const linked = scratch('offer-linked');
    mkdirSync(join(linked, '.cursor'));
    symlinkSync(scratch('elsewhere'), join(linked, '.cursor', 'rules'), 'dir');
    expect(skillOffer({ cwd: linked, published: true, shipped, claudeConfigDir: home() }).cursor).toMatchObject({ blocked: '.cursor/rules is a link to outside the project', install: null });
  });

  it('says which settings file turns on a marketplace install, and offers nothing a CLI without the copy could do', () => {
    const cwd = scratch('marketplace');
    const user = home();
    writeFileSync(join(user, 'settings.json'), JSON.stringify({ enabledPlugins: { 'shadowlap@shadowlap': true } }));
    expect(skillOffer({ cwd, published: true, shipped, claudeConfigDir: user }).claudeCode.marketplace).toBe('user');
    const none = skillOffer({ cwd, published: true, shipped: null, claudeConfigDir: user });
    expect(none).toMatchObject({ version: null, claudeCode: { install: null, everywhere: null }, cursor: { install: null } });
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
    expect(await started({ agent: 'cursor' })).toMatchObject({ args: ['skill', 'install', 'cursor'], title: 'Adding the Cursor rule' });
    expect(await started({ agent: 'claude-code', replace: true })).toMatchObject({ args: ['skill', 'install', 'claude-code', '--force'], title: 'Installing the skill' });
    for (const body of [{ agent: 'codex' }, {}, { agent: 'cursor', replace: 'yes' }]) expect((await api('jobs', { kind: 'skill-install', ...body })).status, JSON.stringify(body)).toBe(400);
  });
});
