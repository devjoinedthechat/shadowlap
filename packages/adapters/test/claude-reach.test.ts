import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { settingsPreToolUse, type SettingsPlaces } from '../src/claude-hooks.js';
import { claudeReach, type ReachOptions } from '../src/claude-reach.js';
import { frontmatter } from '../src/frontmatter.js';

/**
 * What the Claude Agent SDK's fence reads of Claude Code's own files, held to the cases its Python
 * twin is held to (sdks/python/tests/claude_reach_cases.json): the frontmatter of a skill or a
 * subagent, the PreToolUse hooks Claude Code runs beside the fence, and what the Claude Code CLI can
 * reach that the network guard can't watch.
 */

interface Cases {
  reach: Array<{ name: string; files: Record<string, unknown>; query: ReachOptions; places: SettingsPlaces; env: Record<string, string>; shadowlapBase: string; expect: string[] }>;
  frontmatter: Array<{ name: string; text: string; expect: Record<string, unknown> | null }>;
  hooks: Array<{ name: string; files: Record<string, unknown>; places: SettingsPlaces; env: Record<string, string>; expect: Array<Record<string, string>> }>;
}
const CASES = JSON.parse(readFileSync(new URL('../../../sdks/python/tests/claude_reach_cases.json', import.meta.url), 'utf8')) as Cases;

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** `$ROOT` in every string of a case, as the folder its files are written in. */
function rooted<T>(value: T, root: string): T {
  return JSON.parse(JSON.stringify(value).replaceAll('$ROOT', root)) as T;
}

/** A folder of the case's own with its files in it, objects written as JSON. */
function world(files: Record<string, unknown>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sl-claude-reach-')));
  roots.push(root);
  for (const [path, content] of Object.entries(rooted(files, root))) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

describe('the frontmatter of a skill or a subagent', () => {
  it.each(CASES.frontmatter.map((c) => [c.name, c] as const))('%s', (_, c) => {
    const keys = frontmatter(c.text);
    if (c.expect === null) return expect(keys).toBeNull();
    const read = Object.fromEntries([...keys!].map(([k, v]) => [k, 'unreadable' in v ? { $unreadable: true } : v.value]));
    expect(read).toEqual(c.expect);
  });
});

describe('the PreToolUse hooks Claude Code runs beside the fence', () => {
  it.each(CASES.hooks.map((c) => [c.name, c] as const))('%s', async (_, c) => {
    const root = world(c.files);
    const places = rooted({ ...c.places, env: c.env }, root);
    expect(await settingsPreToolUse(places, places.cwd!)).toEqual(rooted(c.expect, root));
  });
});

describe('what the Claude Code CLI can reach that the guard can\'t watch', () => {
  it.each(CASES.reach.map((c) => [c.name, c] as const))('%s', async (_, c) => {
    const root = world(c.files);
    const env = rooted(c.env, root);
    expect(await claudeReach(rooted(c.query, root), rooted({ ...c.places, env }, root), env, c.shadowlapBase)).toEqual(rooted(c.expect, root));
  });
});

describe("the query's managedSettings, an embedding host's policy", () => {
  // Not among the shared cases: the Python SDK has no managedSettings.
  const BASE = 'http://127.0.0.1:9/r/run/anthropic';
  const HOOK = { hooks: { Stop: [{ hooks: [{ type: 'command', command: './mine.sh' }] }] } };

  it("is taken at its disableAllHooks false, but not at its true, which Claude Code ignores on a machine with managed settings of its own", async () => {
    const root = world({ 'proj/.git/HEAD': 'ref: refs/heads/main\n', 'proj/.claude/settings.json': HOOK, 'home/.claude/settings.json': {} });
    const env = { HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'home', '.claude'), ANTHROPIC_BASE_URL: BASE, ANTHROPIC_API_KEY: 'sk-test', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    const reach = (managedSettings: Record<string, unknown>, user: Record<string, unknown> = {}) => {
      writeFileSync(join(root, 'home', '.claude', 'settings.json'), JSON.stringify(user));
      return claudeReach({ disallowedTools: ['WebFetch'] }, { cwd: join(root, 'proj'), sources: ['user', 'project', 'local'], managedFile: join(root, 'home', 'managed', 'managed-settings.json'), managedSettings, env }, env, BASE);
    };
    // Its true may be ignored: the project's hook may run, and is counted.
    expect(await reach({ disableAllHooks: true })).toEqual(['the command hook mine.sh in .claude/settings.json']);
    // Its false is the managed level's, over the user's true.
    expect(await reach({ disableAllHooks: false }, { disableAllHooks: true })).toEqual(['the command hook mine.sh in .claude/settings.json']);
    // Without it, the user's true leaves no hook outside managed settings.
    expect(await reach({}, { disableAllHooks: true })).toEqual([]);
  });
});
