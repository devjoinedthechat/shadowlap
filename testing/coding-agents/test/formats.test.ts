// The Claude Code plugin and its skills in coding-agents/ are installed by tools with formats of their
// own: a plugin manifest and a marketplace file Claude Code reads, and SKILL.md files in the Agent
// Skills format, which claude.ai and the Skills API take too, and which `shadowlap skill install
// agents` copies into the folder most other coding agents read skills from, under names of their own.
// These checks hold the files to those formats, to each other and to the CLI's version; CI also runs
// Claude Code's own validator and the format's reference validator on them
// (.github/workflows/coding-agents.yml).
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SKILLS as PLUGIN_SKILLS, SKILL_PLUGIN, SKILL_REPOSITORY, shippedFiles } from '../../../packages/dashboard/src/agent-skill.js';
import { agentsSection } from '../../../packages/dashboard/src/settings.js';
import { DISPLAY_FIELDS, PLUGIN_DIR, ROOT, SKILLS, frontmatter, read, skillFile } from './instructions.js';

const plugin = JSON.parse(read(`${PLUGIN_DIR}/.claude-plugin/plugin.json`)) as Record<string, unknown> & { name: string; version: string; license: string; author?: { name?: string } };
const marketplace = JSON.parse(read('.claude-plugin/marketplace.json')) as { name: string; owner?: { name?: string }; plugins: Array<Record<string, unknown> & { name: string; source: string }> };

/** What each skill may run without asking in Claude Code: commands that only read the store or check the setup. */
const PRE_APPROVED: Record<string, string[]> = {
  'debug-agent': ['ls', 'show', 'search', 'diff', 'fix ls', 'fix show'],
  'setup-agent': ['ls', 'show', 'doctor'],
};

describe('the skills', () => {
  it('are the plugin’s, each named as its folder, in the Agent Skills format, at the CLI’s version', () => {
    expect(readdirSync(join(ROOT, PLUGIN_DIR, 'skills')).sort()).toEqual([...SKILLS].sort());
    for (const name of SKILLS) {
      const { fields, body } = frontmatter(read(skillFile(name)));
      // The fields claude.ai uploads and the Skills API accept; Claude Code takes more, but a skill
      // that keeps to these installs everywhere.
      expect([...fields.keys()].filter((k) => !['name', 'description', 'license', 'compatibility', 'allowed-tools'].includes(k) && !k.startsWith('metadata.')), name).toEqual([]);
      expect(fields.get('name')).toBe(name);
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(name.length).toBeLessThanOrEqual(64);
      const description = fields.get('description')!;
      expect(description.length, name).toBeGreaterThan(0);
      expect(description.length, name).toBeLessThanOrEqual(1024);
      // Claude reads only the description to decide when to load a skill: it says when.
      expect(description, name).toMatch(/\. Use it (when|whenever) /);
      expect(fields.get('license')).toBe(plugin.license);
      expect(fields.get('compatibility')!.length).toBeLessThanOrEqual(500);
      // A copy outside the plugin has no manifest: it says its version here.
      expect(fields.get('metadata.version'), name).toBe(plugin.version);
      expect(body.split('\n').length).toBeLessThan(500);
    }
  });

  it('pre-approve read-only commands only', () => {
    for (const name of SKILLS) {
      const allowed = frontmatter(read(skillFile(name))).fields.get('allowed-tools')!;
      const rules = [...allowed.matchAll(/Bash\(shadowlap ([a-z ]+?) \*\)/g)].map((m) => m[1]);
      expect(allowed.replace(/Bash\(shadowlap [a-z ]+? \*\)/g, '').trim(), `${name}: only Bash(shadowlap <command> *) rules`).toBe('');
      // Each only reads the store (search keeps its index there) or checks the setup; none runs the agent or changes a run.
      expect(rules, name).toEqual(PRE_APPROVED[name]);
    }
  });
});

describe('the skills in .agents/skills', () => {
  it('are the plugin’s, each named shadowlap-<name> as its folder is, without Claude Code’s pre-approvals', () => {
    const files = shippedFiles('agents', join(ROOT, 'coding-agents'));
    expect(files.map((f) => f.rel)).toEqual([...SKILLS].sort().map((name) => `shadowlap-${name}/SKILL.md`));
    for (const f of files) {
      const name = f.rel.slice('shadowlap-'.length, -'/SKILL.md'.length);
      const original = frontmatter(read(skillFile(name)));
      const shared = frontmatter(f.bytes.toString('utf8'));
      // The format wants a skill's name to be its folder's; in a folder every tool's skills share, the prefix keeps ours apart.
      expect(shared.fields.get('name')).toBe(`shadowlap-${name}`);
      expect(PLUGIN_SKILLS.find((s) => s.name === name)?.shared).toBe(`shadowlap-${name}`);
      // allowed-tools names Claude Code's tools: other agents name theirs otherwise.
      expect(shared.fields.has('allowed-tools')).toBe(false);
      for (const [key, value] of original.fields) if (key !== 'name' && key !== 'allowed-tools') expect(shared.fields.get(key), `${name}: ${key}`).toBe(value);
      expect(shared.body, `${name}: the same instructions, word for word`).toBe(original.body);
    }
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
    const entry = marketplace.plugins[0];
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
    for (const s of PLUGIN_SKILLS) expect(s.command).toBe(`/${plugin.name}:${s.name}`);
    expect(String(plugin.repository)).toBe(`https://github.com/${SKILL_REPOSITORY}`);
  });
});

describe('the section docs/agents.md gives to paste', () => {
  it('is there, as Settings shows it, and tells where the packaged instructions are and how each installs', () => {
    const doc = read('docs/agents.md');
    expect(agentsSection(doc)).toMatch(/shadowlap replay/);
    // Into the project, from the copy that came with the CLI; or everywhere, pinned to the CLI's
    // version, with the update that moves an earlier install to it (installing again doesn't).
    const everywhere = [`claude plugin marketplace add ${SKILL_REPOSITORY}@v$(shadowlap --version)\n`, `claude plugin install ${SKILL_PLUGIN}\n`, `claude plugin update ${SKILL_PLUGIN}\n`];
    for (const line of ['shadowlap skill install\n', 'shadowlap skill install agents\n', 'shadowlap skill install kiro\n', ...everywhere]) expect(doc, line).toContain(line);
    // The plugin's README, which GitHub shows in its folder, gives the same.
    const readme = read(`${PLUGIN_DIR}/README.md`);
    for (const line of ['shadowlap skill install\n', 'shadowlap skill install agents\n', ...everywhere]) expect(readme, line).toContain(line);
  });
});
