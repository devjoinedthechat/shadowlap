// The Claude Code plugin, its skill and the Cursor rule in coding-agents/ are installed by tools with
// formats of their own: a plugin manifest and a marketplace file Claude Code reads, a SKILL.md in the
// Agent Skills format (whose frontmatter claude.ai and the Skills API also take), and a Cursor
// project rule. These checks hold the files to those formats, to each other and to the CLI's
// version; CI also runs Claude Code's own validator on them (.github/workflows/coding-agents.yml).
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CURSOR_RULE, SKILL_COMMAND, SKILL_PLUGIN, SKILL_REPOSITORY } from '../../../packages/dashboard/src/agent-skill.js';
import { agentsSection } from '../../../packages/dashboard/src/settings.js';
import { DISPLAY_FIELDS, PLUGIN_DIR, ROOT, SKILL_FILE, frontmatter, read } from './instructions.js';

const plugin = JSON.parse(read(`${PLUGIN_DIR}/.claude-plugin/plugin.json`)) as Record<string, unknown> & { name: string; version: string; license: string; author?: { name?: string } };
const marketplace = JSON.parse(read('.claude-plugin/marketplace.json')) as { name: string; owner?: { name?: string }; plugins: Array<Record<string, unknown> & { name: string; source: string }> };
const skills = readdirSync(join(ROOT, PLUGIN_DIR, 'skills'));

describe('the skill', () => {
  it('is one skill, named as its folder, in the Agent Skills format', () => {
    expect(skills).toEqual(['debug-agent']);
    const { fields, body } = frontmatter(read(SKILL_FILE));
    // The fields claude.ai uploads and the Skills API accept; Claude Code takes more, but a skill
    // that keeps to these installs everywhere.
    expect([...fields.keys()].filter((k) => !['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'].includes(k))).toEqual([]);
    const name = fields.get('name')!;
    expect(name).toBe('debug-agent');
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(name.length).toBeLessThanOrEqual(64);
    const description = fields.get('description')!;
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(fields.get('license')).toBe(plugin.license);
    expect(fields.get('compatibility')!.length).toBeLessThanOrEqual(500);
    expect(body.split('\n').length).toBeLessThan(500);
  });

  it('pre-approves read-only commands only', () => {
    const allowed = frontmatter(read(SKILL_FILE)).fields.get('allowed-tools')!;
    const rules = [...allowed.matchAll(/Bash\(shadowlap ([a-z ]+?) \*\)/g)].map((m) => m[1]);
    expect(allowed.replace(/Bash\(shadowlap [a-z ]+? \*\)/g, '').trim(), 'only Bash(shadowlap <command> *) rules').toBe('');
    // Each only reads the store (search keeps its index there); none runs the agent or changes a run.
    expect(rules).toEqual(['ls', 'show', 'search', 'diff', 'fix ls']);
  });
});

describe('the Cursor rule', () => {
  it('is a project rule Agent applies when it finds it relevant, holding the skill’s instructions', () => {
    const skill = frontmatter(read(SKILL_FILE));
    const rule = frontmatter(read(CURSOR_RULE.source));
    expect(CURSOR_RULE.source.endsWith('.mdc'), 'Cursor reads rules only from .mdc files').toBe(true);
    // No globs and alwaysApply false: Cursor's "Apply Intelligently", decided by the description.
    expect([...rule.fields.keys()].sort()).toEqual(['alwaysApply', 'description']);
    expect(rule.fields.get('alwaysApply')).toBe('false');
    expect(rule.fields.get('description')).toBe(skill.fields.get('description'));
    expect(rule.body, `${CURSOR_RULE.source} holds the text of the skill after its frontmatter, word for word`).toBe(skill.body);
  });
});

describe('the plugin', () => {
  it('has a manifest Claude Code reads, versioned with the CLI', () => {
    const cli = JSON.parse(read('packages/cli/package.json')) as { version: string; license: string };
    expect(plugin.version).toBe(cli.version);
    expect(plugin.license).toBe(cli.license);
    expect(plugin.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(typeof plugin.description).toBe('string');
    expect(plugin.author?.name).toBeTruthy();
    expect(() => new URL(String(plugin.homepage)), 'homepage must parse as a URL, or the plugin fails to load').not.toThrow();
    // Keys Claude Code doesn't know are dropped, and fail `claude plugin validate --strict`.
    const known = ['$schema', 'name', 'displayName', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'metadata', 'icon', 'documentationUrl', 'supportUrl', 'privacyPolicyUrl', 'termsOfServiceUrl', 'defaultEnabled', 'dependencies', 'settings', 'userConfig', 'skills', 'commands', 'agents', 'hooks', 'mcpServers', 'lspServers', 'outputStyles', 'workflows', 'experimental'];
    expect(Object.keys(plugin).filter((k) => !known.includes(k))).toEqual([]);
    // Only the manifest goes in .claude-plugin/: components put there don't load.
    expect(readdirSync(join(ROOT, PLUGIN_DIR, '.claude-plugin'))).toEqual(['plugin.json']);
  });

  it('is listed by the repository’s marketplace under its own name, so it installs by name', () => {
    expect(marketplace.name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
    expect(marketplace.owner?.name).toBeTruthy();
    expect(marketplace.plugins).toHaveLength(1);
    const entry = marketplace.plugins[0]!;
    expect(entry.name, 'the entry and the manifest name the plugin alike').toBe(plugin.name);
    expect(entry.source).toBe(`./${PLUGIN_DIR}`);
    expect(existsSync(join(ROOT, entry.source, '.claude-plugin', 'plugin.json'))).toBe(true);
    // The manifest carries the version; an entry that sets one too draws a validator warning.
    expect(entry.version).toBeUndefined();
    // Claude Code shows the entry's value of a display field wherever the entry sets one, so the
    // entry sets none and plugin.json's are what users see, before an install and after it.
    for (const key of DISPLAY_FIELDS) expect(entry[key], `the marketplace entry's ${key} would hide plugin.json's`).toBeUndefined();
  });

  it('is what Settings → Coding agents will offer to install', () => {
    expect(SKILL_PLUGIN).toBe(`${plugin.name}@${marketplace.name}`);
    expect(SKILL_COMMAND).toBe(`/${plugin.name}:${skills[0]}`);
    expect(String(plugin.repository)).toBe(`https://github.com/${SKILL_REPOSITORY}`);
    expect(existsSync(join(ROOT, CURSOR_RULE.source))).toBe(true);
  });
});

describe('the section docs/agents.md gives to paste', () => {
  it('is there, as Settings shows it, and tells where the packaged instructions are and how each installs', () => {
    const doc = read('docs/agents.md');
    expect(agentsSection(doc)).toMatch(/shadowlap replay/);
    expect(doc).toContain(CURSOR_RULE.source);
    // Into the project, from the copy that came with the CLI; or everywhere, pinned to the CLI's
    // version, with the update that moves an earlier install to it (installing again doesn't).
    const everywhere = [`claude plugin marketplace add ${SKILL_REPOSITORY}@v$(shadowlap --version)\n`, `claude plugin install ${SKILL_PLUGIN}\n`, `claude plugin update ${SKILL_PLUGIN}\n`];
    for (const line of ['shadowlap skill install\n', 'shadowlap skill install cursor\n', ...everywhere]) expect(doc, line).toContain(line);
    // The plugin's README, which GitHub shows in its folder, gives the same.
    const readme = read(`${PLUGIN_DIR}/README.md`);
    for (const line of ['shadowlap skill install\n', ...everywhere]) expect(readme, line).toContain(line);
  });
});
