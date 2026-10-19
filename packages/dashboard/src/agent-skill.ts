import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The instructions docs/agents.md gives coding agents to paste, packaged: a Claude Code plugin with
 * one skill, `debug-agent`, and a Cursor rule holding the same text. They live in the repository's
 * coding-agents/ folder, versioned with the CLI, and a copy ships with it (in this package's
 * dist/coding-agents, beside the docs Settings reads). `shadowlap skill install` puts that copy into
 * a project, with no network: the plugin as a folder under `.claude/skills/`, where Claude Code loads
 * it for everyone working on the project, and the rule under `.cursor/rules/`. Settings → Coding
 * agents reads what a project has there, and offers the install.
 */

/**
 * Whether the owner has published the Claude Code plugin. Until then, Settings → Coding agents
 * offers no Install the skill: `install` is null in its read model. The Cursor rule needs nothing
 * published, so its install is offered either way.
 *
 * The owner publishes the plugin by hand, and flips this to true once it is published.
 */
export const SKILL_PUBLISHED = false;

/** The repository, which is its own Claude Code plugin marketplace (`.claude-plugin/marketplace.json`). */
export const SKILL_REPOSITORY = 'devjoinedthechat/shadowlap';
/** The plugin as Claude Code installs it from that marketplace, `<plugin>@<marketplace>`: both are named shadowlap. */
export const SKILL_PLUGIN = 'shadowlap@shadowlap';
/** The skill's command in Claude Code: the plugin's name, then the skill's. */
export const SKILL_COMMAND = '/shadowlap:debug-agent';
/** The Claude Code plugin: where it is in the repository, and where `shadowlap skill install` puts it in a project. */
export const CLAUDE_CODE_PLUGIN = { source: 'coding-agents/claude-code', path: '.claude/skills/shadowlap' } as const;
/** The Cursor rule: where it is in the repository, and where it goes in a project. */
export const CURSOR_RULE = { source: 'coding-agents/cursor/shadowlap.mdc', path: '.cursor/rules/shadowlap.mdc' } as const;

/** The coding agents `shadowlap skill install` installs for. */
export type CodingAgent = 'claude-code' | 'cursor';
export const CODING_AGENTS: readonly CodingAgent[] = ['claude-code', 'cursor'];
const TARGETS: Record<CodingAgent, { source: string; path: string }> = { 'claude-code': CLAUDE_CODE_PLUGIN, cursor: CURSOR_RULE };

/**
 * What a project has where the install goes, against this version's copy:
 * - `missing`: nothing there;
 * - `current`: this version's copy, file for file;
 * - `other-version`: (Claude Code) the plugin, as another version of Shadowlap wrote it;
 * - `changed`: something else, such as a copy edited here, or another version's Cursor rule.
 */
export type InstallState = 'missing' | 'current' | 'other-version' | 'changed';

export interface InstalledCopy {
  agent: CodingAgent;
  /** Where it goes, relative to the project. */
  path: string;
  state: InstallState;
  /** The version the plugin there says it is, when it is the plugin (Claude Code only). */
  installedVersion: string | null;
  /** Each file, relative to the project: the same as this version's, different, missing, or one this version doesn't have. */
  files: Array<{ path: string; is: 'same' | 'differs' | 'missing' | 'extra' }>;
  /** Why no install can write there, with or without `--force`: a link on the way out of the project, a folder where a file goes. */
  blocked: string | null;
}

export interface InstallResult {
  agent: CodingAgent;
  path: string;
  /** The version installed: this CLI's. */
  version: string;
  /** What was there before. */
  before: InstallState;
  installedVersion: string | null;
  outcome: 'installed' | 'updated' | 'unchanged' | 'refused';
  /** What happened to each file, relative to the project; `differs` and `extra` are what a refused install left as they are. */
  files: Array<{ path: string; action: 'written' | 'replaced' | 'removed' | 'unchanged' | 'differs' | 'extra' }>;
  /** Why it was refused, saying what `--force` would do when it can do anything. */
  reason: string | null;
}

/** A plugin folder or a rule far bigger than ours isn't ours: past these, nothing is read or written. */
const MAX_FILE = 1024 * 1024;
const MAX_ENTRIES = 500;

/**
 * The folder holding this version's coding-agents/: the copy this package ships in
 * dist/coding-agents, or, in a checkout of the repository, the repository's own. Null when neither
 * is there.
 */
export function shippedCodingAgents(): string | null {
  const shipped = fileURLToPath(new URL('./coding-agents/', import.meta.url));
  if (existsSync(join(shipped, 'claude-code', '.claude-plugin', 'plugin.json'))) return shipped;
  try {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string };
    if (pkg.name === 'shadowlap-monorepo' && existsSync(join(root, CLAUDE_CODE_PLUGIN.source))) return join(root, 'coding-agents');
  } catch {
    // installed without them
  }
  return null;
}

/** The version of the plugin in a coding-agents/ folder: its plugin.json's, which is the CLI's. */
export function shippedVersion(shipped: string | null = shippedCodingAgents()): string | null {
  if (!shipped) return null;
  try {
    const version = (JSON.parse(readFileSync(join(shipped, 'claude-code', '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: unknown }).version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

/**
 * The files an install writes, each relative to where it goes in the project (`''` for the rule,
 * which is one file), with its bytes: the plugin's folder but its README, which is for readers of
 * the repository, and the rule.
 */
export function shippedFiles(agent: CodingAgent, shipped: string): Array<{ rel: string; bytes: Buffer }> {
  const from = join(shipped, TARGETS[agent].source.slice('coding-agents/'.length));
  if (agent === 'cursor') return [{ rel: '', bytes: readFileSync(from) }];
  return walk(from)
    .filter((f) => f.kind === 'file' && f.rel !== 'README.md')
    .map((f) => ({ rel: f.rel, bytes: readFileSync(join(from, ...f.rel.split('/'))) }));
}

/** Every entry under a folder, depth first, without following links: files, links and folders, relative with `/`. */
function walk(dir: string, limit = MAX_ENTRIES): Array<{ rel: string; kind: 'file' | 'link' | 'folder' | 'other' }> {
  const out: Array<{ rel: string; kind: 'file' | 'link' | 'folder' | 'other' }> = [];
  const visit = (at: string, rel: string) => {
    for (const e of readdirSync(at, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (out.length >= limit) throw new Error(`more than ${limit} entries`);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) out.push({ rel: r, kind: 'link' });
      else if (e.isDirectory()) {
        out.push({ rel: r, kind: 'folder' });
        visit(join(at, e.name), r);
      } else out.push({ rel: r, kind: e.isFile() ? 'file' : 'other' });
    }
  };
  visit(dir, '');
  return out;
}

const inside = (path: string, root: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const lstat = (path: string): Stats | null => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

/**
 * Why nothing may be written under `path` (relative to the project, with `/`): a folder on the way
 * that is a link to outside the project, or a file where a folder goes. A link that stays inside
 * the project is followed, as a monorepo's shared rules folder is. Null when the way is clear.
 */
function blockedOnTheWay(cwd: string, path: string): string | null {
  const root = realpathSync(cwd);
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const shown = parts.slice(0, i).join('/');
    const full = join(cwd, ...parts.slice(0, i));
    const st = lstat(full);
    if (!st) return null;
    if (st.isSymbolicLink()) {
      let real: string;
      try {
        real = realpathSync(full);
      } catch {
        return `${shown} is a link to nothing`;
      }
      if (!inside(real, root)) return `${shown} is a link to outside the project`;
      if (!lstatSync(real).isDirectory()) return `${shown} is a link to a file, where a folder goes`;
    } else if (!st.isDirectory()) return `${shown} is a file, where a folder goes`;
  }
  return null;
}

/** A file's bytes when it is a regular file small enough to be ours; null for a link, a folder or anything else. */
function readOurs(path: string): Buffer | null {
  const st = lstat(path);
  if (!st?.isFile() || st.size > MAX_FILE) return null;
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/** The version a plugin.json gives the plugin, when it is Shadowlap's. */
function pluginVersion(bytes: Buffer | null): string | null {
  if (!bytes) return null;
  try {
    const manifest = JSON.parse(bytes.toString('utf8')) as { name?: unknown; version?: unknown };
    return manifest.name === 'shadowlap' && typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

/**
 * What the project at `cwd` has where `agent`'s install goes, against the copy in `shipped`. On the
 * way there, a link that stays inside the project is followed; at the install's own place (the
 * plugin's folder and everything in it, the rule's file) nothing is: a link there blocks the install,
 * since writing through it, or replacing it, would change what someone set up on purpose.
 */
export function installedCopy(cwd: string, agent: CodingAgent, shipped: string): InstalledCopy {
  const target = TARGETS[agent];
  const files = shippedFiles(agent, shipped);
  const at = (rel: string) => (rel ? `${target.path}/${rel}` : target.path);
  const full = (rel: string) => join(cwd, ...at(rel).split('/'));
  let blocked = blockedOnTheWay(cwd, agent === 'claude-code' ? target.path : target.path.slice(0, target.path.lastIndexOf('/')));
  const listed: InstalledCopy['files'] = [];

  // In the plugin's folder, what this version doesn't have: an older version's skill would go on loading.
  if (!blocked && agent === 'claude-code' && lstat(full(''))) {
    const ours = new Set(files.map((f) => f.rel));
    const folders = new Set(files.flatMap((f) => f.rel.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))));
    try {
      for (const e of walk(full(''))) {
        if (e.kind === 'link' || e.kind === 'other') blocked = `${at(e.rel)} is ${e.kind === 'link' ? 'a link' : 'not a file'}: remove it, then install again`;
        else if (e.kind === 'folder' && ours.has(e.rel)) blocked = `${at(e.rel)} is a folder, where a file goes`;
        else if (e.kind === 'file' && folders.has(e.rel)) blocked = `${at(e.rel)} is a file, where a folder goes`;
        // A folder this version doesn't have counts by the files in it, each listed on its own.
        else if (e.kind === 'file' && !ours.has(e.rel)) listed.push({ path: at(e.rel), is: 'extra' });
        if (blocked) break;
      }
    } catch (err) {
      blocked = `${target.path} holds ${err instanceof Error ? err.message : 'too many entries'}: it isn't a copy of the plugin`;
    }
  }
  if (!blocked) {
    for (const f of files) {
      const st = lstat(full(f.rel));
      if (!st) listed.push({ path: at(f.rel), is: 'missing' });
      else if (st.isSymbolicLink()) blocked = `${at(f.rel)} is a link: remove it, then install again`;
      else if (!st.isFile()) blocked = `${at(f.rel)} is ${st.isDirectory() ? 'a folder' : 'not a file'}, where a file goes`;
      else listed.push({ path: at(f.rel), is: readOurs(full(f.rel))?.equals(f.bytes) ? 'same' : 'differs' });
      if (blocked) break;
    }
  }
  listed.sort((a, b) => (a.path < b.path ? -1 : 1));

  const installedVersion = agent === 'claude-code' && !blocked ? pluginVersion(readOurs(full('.claude-plugin/plugin.json'))) : null;
  let state: InstallState;
  if (blocked) state = lstat(full('')) ? 'changed' : 'missing';
  else if (listed.every((f) => f.is === 'missing')) state = 'missing';
  else if (listed.every((f) => f.is === 'same')) state = 'current';
  else if (installedVersion !== null && installedVersion !== shippedVersion(shipped)) state = 'other-version';
  else state = 'changed';
  return { agent, path: target.path, state, installedVersion, files: blocked ? [] : listed, blocked };
}

/**
 * Puts this version's copy of `agent`'s instructions into the project at `cwd`. Files that are
 * there already and differ from this version's (another version's, or edited here) are left as they
 * are and the install is refused, unless `replace`; with it, they are replaced, and, in the plugin's
 * folder, files this version doesn't have are removed, so an older version's skill stops loading.
 * Nothing is ever written through a link out of the project.
 */
export function installCodingAgent(cwd: string, agent: CodingAgent, options: { replace?: boolean; shipped?: string | null } = {}): InstallResult {
  const shipped = options.shipped === undefined ? shippedCodingAgents() : options.shipped;
  if (!shipped) throw new Error("this shadowlap has no copy of the coding agents' instructions: install it again");
  const version = shippedVersion(shipped) ?? 'unknown';
  const copy = installedCopy(cwd, agent, shipped);
  const result = (outcome: InstallResult['outcome'], files: InstallResult['files'], reason: string | null = null): InstallResult => ({
    agent,
    path: copy.path,
    version,
    before: copy.state,
    installedVersion: copy.installedVersion,
    outcome,
    files,
    reason,
  });
  if (copy.blocked) return result('refused', [], `${copy.blocked}: nothing was written`);
  if (copy.state === 'current') return result('unchanged', copy.files.map((f) => ({ path: f.path, action: 'unchanged' })));
  if (copy.state !== 'missing' && !options.replace) {
    const left = copy.files.filter((f) => f.is === 'differs' || f.is === 'extra').map((f) => ({ path: f.path, action: f.is as 'differs' | 'extra' }));
    const there =
      copy.state === 'other-version'
        ? `holds the Claude Code plugin ${copy.installedVersion}, not ${version}`
        : `isn’t ${version}’s ${agent === 'claude-code' ? 'copy of the plugin' : 'rule'} (edited here, or ${agent === 'claude-code' ? 'from somewhere else' : 'another version’s'})`;
    return result('refused', left, `${copy.path} ${there}: --force replaces it with ${version}’s`);
  }

  const byPath = new Map(copy.files.map((f) => [f.path, f.is]));
  const done: InstallResult['files'] = [];
  for (const f of shippedFiles(agent, shipped)) {
    const path = f.rel ? `${copy.path}/${f.rel}` : copy.path;
    const is = byPath.get(path);
    if (is === 'same') {
      done.push({ path, action: 'unchanged' });
      continue;
    }
    const full = join(cwd, ...path.split('/'));
    makeFolders(cwd, path.slice(0, path.lastIndexOf('/')));
    // Written beside it and moved into place: a reader never sees half a file, and a link there is replaced, not followed.
    const temp = join(dirname(full), `.${basename(full)}.${process.pid}.${Date.now()}.tmp`);
    try {
      writeFileSync(temp, f.bytes, { flag: 'wx' });
      renameSync(temp, full);
    } finally {
      rmSync(temp, { force: true });
    }
    done.push({ path, action: is === 'missing' || is === undefined ? 'written' : 'replaced' });
  }
  for (const f of copy.files) {
    if (f.is !== 'extra') continue;
    rmSync(join(cwd, ...f.path.split('/')), { force: true });
    done.push({ path: f.path, action: 'removed' });
  }
  if (agent === 'claude-code') removeEmptyFolders(join(cwd, ...copy.path.split('/')));
  return result(copy.state === 'missing' ? 'installed' : 'updated', done);
}

/** Makes each folder of `path` (relative to the project, with `/`) that is missing, checking the way first. */
function makeFolders(cwd: string, path: string): void {
  const blocked = blockedOnTheWay(cwd, path);
  if (blocked) throw new Error(`${blocked}: nothing more was written`);
  mkdirSync(join(cwd, ...path.split('/')), { recursive: true });
}

/** Removes the folders under `dir` (not `dir` itself) that removing files left empty, deepest first. */
function removeEmptyFolders(dir: string): void {
  let entries;
  try {
    entries = walk(dir);
  } catch {
    return;
  }
  for (const e of entries.filter((x) => x.kind === 'folder').reverse()) {
    try {
      rmdirSync(join(dir, ...e.rel.split('/')));
    } catch {
      // not empty: something of the user's is in it
    }
  }
}

/** Claude Code's folder for the user's own settings: `CLAUDE_CONFIG_DIR`, or `~/.claude`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/**
 * Which of Claude Code's settings files turns on the plugin installed from the repository's
 * marketplace (`shadowlap@shadowlap`) for this project, weighed as Claude Code weighs them: the
 * local file over the project's, the project's over the user's. Null when none turns it on. Only
 * that yes or no is read from each file.
 */
export function marketplaceEnabled(cwd: string, configDir: string = claudeConfigDir()): 'user' | 'project' | 'local' | null {
  const files: Array<['user' | 'project' | 'local', string]> = [
    ['local', join(cwd, '.claude', 'settings.local.json')],
    ['project', join(cwd, '.claude', 'settings.json')],
    ['user', join(configDir, 'settings.json')],
  ];
  for (const [scope, file] of files) {
    const bytes = readOurs(file);
    if (!bytes) continue;
    try {
      const value = (JSON.parse(bytes.toString('utf8')) as { enabledPlugins?: Record<string, unknown> }).enabledPlugins?.[SKILL_PLUGIN];
      if (typeof value === 'boolean') return value ? scope : null;
    } catch {
      // a settings file Claude Code itself couldn't read
    }
  }
  return null;
}

/** What Install does for one coding agent: the job a click starts, and the same as a command. */
export interface AgentInstall {
  /** `POST /api/jobs` with this body; `replace` when it replaces what is there (another version's copy, or one edited here). */
  job: { kind: 'skill-install'; agent: CodingAgent; replace: boolean };
  command: string;
}

export interface AgentOffer {
  /** Where the install puts it, relative to the project. */
  path: string;
  state: InstallState;
  /** Why no install can write there (InstalledCopy.blocked). */
  blocked: string | null;
  /** What Install does here, or null when there is nothing it can do: the copy is current, the way is blocked, or (Claude Code) the plugin isn't published yet. */
  install: AgentInstall | null;
}

/** What Settings → Coding agents offers to install. */
export interface SkillOffer {
  /** Whether the owner has published the Claude Code plugin (SKILL_PUBLISHED). Until then, Install the skill isn't offered. */
  published: boolean;
  /** The version of the plugin and the rule that came with this CLI, which an install puts in the project; null when none came with it. */
  version: string | null;
  /** `shadowlap@shadowlap`. */
  plugin: string;
  /** `/shadowlap:debug-agent`. */
  command: string;
  claudeCode: AgentOffer & {
    /** The version of the plugin in the project's `.claude/skills/shadowlap`, when it is there. */
    installedVersion: string | null;
    /** The settings file that turns on the plugin installed from the marketplace (`shadowlap@shadowlap`) here, or null (marketplaceEnabled). */
    marketplace: 'user' | 'project' | 'local' | null;
    /**
     * Claude Code's own commands that install the plugin for every project on the machine, from
     * the repository's marketplace at this version's release tag; the last moves an earlier install
     * to it. Null until published, or for a version with no release tag.
     */
    everywhere: string[] | null;
  };
  cursor: AgentOffer;
}

/** The offer for the project at `cwd`. */
export function skillOffer(options: { cwd: string; published?: boolean; shipped?: string | null; claudeConfigDir?: string }): SkillOffer {
  const published = options.published ?? SKILL_PUBLISHED;
  const shipped = options.shipped === undefined ? shippedCodingAgents() : options.shipped;
  const version = shippedVersion(shipped);
  const look = (agent: CodingAgent): { offer: AgentOffer; installedVersion: string | null } => {
    const nothing = { offer: { path: TARGETS[agent].path, state: 'missing' as const, blocked: null, install: null }, installedVersion: null };
    if (!shipped) return nothing;
    let copy: InstalledCopy;
    try {
      copy = installedCopy(options.cwd, agent, shipped);
    } catch {
      // The project's folder can't be read: there is nothing to offer in it.
      return nothing;
    }
    const replace = copy.state !== 'missing';
    const can = copy.state !== 'current' && !copy.blocked && (agent === 'cursor' || published);
    const install: AgentInstall | null = can ? { job: { kind: 'skill-install', agent, replace }, command: `shadowlap skill install ${agent}${replace ? ' --force' : ''}` } : null;
    return { offer: { path: copy.path, state: copy.state, blocked: copy.blocked, install }, installedVersion: copy.installedVersion };
  };
  // A version that isn't a release's (unreadable, or not semver) has no tag to pin to.
  const release = version !== null && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version);
  const plugin = look('claude-code');
  return {
    published,
    version,
    plugin: SKILL_PLUGIN,
    command: SKILL_COMMAND,
    claudeCode: {
      ...plugin.offer,
      installedVersion: plugin.installedVersion,
      marketplace: marketplaceEnabled(options.cwd, options.claudeConfigDir ?? claudeConfigDir()),
      everywhere: published && release ? [`claude plugin marketplace add ${SKILL_REPOSITORY}@v${version}`, `claude plugin install ${SKILL_PLUGIN}`, `claude plugin update ${SKILL_PLUGIN}`] : null,
    },
    cursor: look('cursor').offer,
  };
}
