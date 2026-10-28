/**
 * Claude Code's hooks, as the Claude Agent SDK's fence (claude-agent-sdk.ts) needs to know them:
 * which tools a matcher picks, the query's own PreToolUse and PostToolUse hooks run inside the
 * fence's and their answers put together as Claude Code puts several together, and the PreToolUse
 * hooks of settings files, plugins, skills and subagents, which Claude Code runs beside the fence,
 * where nothing can run them inside.
 *
 * Claude Code runs every hook that matches a tool call at once. It decides between their permission
 * decisions by precedence (deny, then defer, ask and allow), but it takes `updatedInput` and
 * `updatedToolOutput` from whichever hook answered last, which its documentation leaves open and
 * which a hook's own timing decides. A hook beside the fence can so put back the input of a recorded
 * write the fence turned into a stand-in, and the write runs again for real. Run inside the fence,
 * the query's hooks answer first, in the order they are given, and the fence has the last word.
 */

import { frontmatter } from './frontmatter.js';
import { isObject } from './is-object.js';

/** A hook matcher as the SDK takes one: the tools it picks, its callbacks, and their timeout in seconds. */
export interface HookMatcherLike {
  matcher?: string | null;
  hooks: readonly unknown[];
  timeout?: number | null;
}

/** A hook callback as the SDK calls one. */
type Callback = (input: unknown, toolUseID: string | undefined, options: { signal: AbortSignal }) => unknown;

/**
 * Whether a matcher picks a tool, by Claude Code's rules: none, "" or "*" pick every tool; one made
 * of letters, digits, `_`, `-`, spaces, `,` and `|` is a list of exact names; anything else is a
 * JavaScript regular expression, tested anywhere in the name. One that doesn't compile picks
 * nothing, or with `unsure` every tool, for a caller that must not miss one.
 */
export function matcherPicks(matcher: string | null | undefined, tool: string, unsure: 'none' | 'all' = 'none'): boolean {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true;
  if (/^[A-Za-z0-9_ ,|-]+$/.test(matcher)) return matcher.split(/[|,]/).some((m) => m.trim() === tool);
  try {
    return new RegExp(matcher).test(tool);
  } catch {
    return unsure === 'all';
  }
}

/** What one hook answered: its output, or that it ran out of time. */
type Answer = { output: Record<string, unknown> } | { timedOut: number };

/** The SDK's own default for a callback's timeout on PreToolUse and PostToolUse: the command hooks', 600 seconds. */
const DEFAULT_TIMEOUT_S = 600;

/**
 * The callbacks of `matchers` that pick `tool`, run at once as Claude Code runs them, each given the
 * input, the tool use id and a signal that aborts at its matcher's timeout or with `signal`. A
 * callback that throws answers `{}`, as it does under Claude Code: the call goes on as if it had
 * said nothing. An answer that isn't an object, or says `async`, has no say either.
 */
export async function runHooks(matchers: readonly HookMatcherLike[] | undefined, tool: string, input: unknown, toolUseID: string | undefined, signal: AbortSignal | undefined): Promise<Answer[]> {
  const picked = (matchers ?? []).filter((m) => matcherPicks(m.matcher, tool));
  const calls = picked.flatMap((m) => m.hooks.map((hook) => ({ hook: hook as Callback, timeout: typeof m.timeout === 'number' && m.timeout > 0 ? m.timeout : DEFAULT_TIMEOUT_S })));
  return Promise.all(
    calls.map(async ({ hook, timeout }): Promise<Answer> => {
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<Answer>((resolve) => {
        timer = setTimeout(() => {
          controller.abort(new Error(`the hook did not answer within ${timeout} seconds`));
          resolve({ timedOut: timeout });
        }, timeout * 1000);
      });
      try {
        const ran = Promise.resolve()
          .then(() => hook(input, toolUseID, { signal: controller.signal }))
          .then(
            (out): Answer => ({ output: isObject(out) && out.async !== true ? out : {} }),
            (): Answer => ({ output: {} }),
          );
        return await Promise.race([ran, late]);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    }),
  );
}

export type Decision = 'allow' | 'deny' | 'ask' | 'defer';
const RANK: Record<Decision, number> = { allow: 1, ask: 2, defer: 3, deny: 4 };

/** What several hooks answered, put together as Claude Code puts them together. */
export interface Combined {
  decision?: Decision;
  reason?: string;
  /** PreToolUse: the input the tool runs with, the last hook's (in the order given) that rewrote it. */
  updatedInput?: Record<string, unknown>;
  /** PostToolUse: what the model reads instead of the tool's output, the last hook's that replaced it. */
  output?: { value: unknown };
  /** PostToolUse: the MCP tool output the last hook replaced, under the older field. */
  mcpOutput?: { value: unknown };
  additionalContext?: string;
  /** The fields any event takes: shown to the person, and whether the agent goes on. */
  systemMessage?: string;
  stop?: { reason?: string };
  suppressOutput?: true;
}

/** The decision a hook's answer makes: `permissionDecision`, or the older `decision` (approve, block). */
function decisionOf(out: Record<string, unknown>, specific: Record<string, unknown>): { decision: Decision; reason?: string } | null {
  const d = specific.permissionDecision;
  if (d === 'allow' || d === 'deny' || d === 'ask' || d === 'defer') return { decision: d, ...(typeof specific.permissionDecisionReason === 'string' ? { reason: specific.permissionDecisionReason } : {}) };
  if (out.decision === 'block' || out.decision === 'approve') return { decision: out.decision === 'block' ? 'deny' : 'allow', ...(typeof out.reason === 'string' ? { reason: out.reason } : {}) };
  return null;
}

/**
 * Hooks' answers put together: the most restrictive decision, with its reason (deny, then defer,
 * ask and allow, as Claude Code documents it); the last rewrite of the input or the output, in the
 * order the hooks were given; every context and message, joined; a stop when any asks for one. A
 * hook that ran out of time blocks a PreToolUse call, as it does under Claude Code, and has no say
 * on a PostToolUse one.
 */
export function combine(answers: readonly Answer[], event: 'PreToolUse' | 'PostToolUse'): Combined {
  const out: Combined = {};
  const contexts: string[] = [];
  const messages: string[] = [];
  const decide = (decision: Decision, reason?: string) => {
    if (out.decision && RANK[decision] <= RANK[out.decision]) return;
    out.decision = decision;
    if (reason !== undefined) out.reason = reason;
    else delete out.reason;
  };
  for (const a of answers) {
    if ('timedOut' in a) {
      if (event === 'PreToolUse') decide('deny', `a PreToolUse hook did not answer within its timeout of ${a.timedOut} seconds`);
      continue;
    }
    const o = a.output;
    const specific = isObject(o.hookSpecificOutput) ? o.hookSpecificOutput : {};
    const d = event === 'PreToolUse' ? decisionOf(o, specific) : null;
    if (d) decide(d.decision, d.reason);
    if (event === 'PreToolUse' && isObject(specific.updatedInput)) out.updatedInput = specific.updatedInput;
    if (event === 'PostToolUse' && 'updatedToolOutput' in specific) out.output = { value: specific.updatedToolOutput };
    if (event === 'PostToolUse' && 'updatedMCPToolOutput' in specific) out.mcpOutput = { value: specific.updatedMCPToolOutput };
    if (typeof specific.additionalContext === 'string' && specific.additionalContext) contexts.push(specific.additionalContext);
    if (typeof o.systemMessage === 'string' && o.systemMessage) messages.push(o.systemMessage);
    if (o.continue === false) out.stop ??= typeof o.stopReason === 'string' ? { reason: o.stopReason } : {};
    if (o.suppressOutput === true) out.suppressOutput = true;
  }
  if (contexts.length) out.additionalContext = contexts.join('\n');
  if (messages.length) out.systemMessage = messages.join('\n');
  return out;
}

/** A combined answer as a hook returns it to Claude Code: `{}` when it says nothing. */
export function asOutput(c: Combined, event: 'PreToolUse' | 'PostToolUse'): Record<string, unknown> {
  const specific: Record<string, unknown> = {
    ...(c.decision ? { permissionDecision: c.decision } : {}),
    ...(c.decision && c.reason !== undefined ? { permissionDecisionReason: c.reason } : {}),
    ...(c.updatedInput ? { updatedInput: c.updatedInput } : {}),
    ...(c.output ? { updatedToolOutput: c.output.value } : {}),
    ...(c.mcpOutput ? { updatedMCPToolOutput: c.mcpOutput.value } : {}),
    ...(c.additionalContext ? { additionalContext: c.additionalContext } : {}),
  };
  return {
    ...(c.systemMessage ? { systemMessage: c.systemMessage } : {}),
    ...(c.stop ? { continue: false, ...(c.stop.reason ? { stopReason: c.stop.reason } : {}) } : {}),
    ...(c.suppressOutput ? { suppressOutput: true } : {}),
    ...(Object.keys(specific).length ? { hookSpecificOutput: { hookEventName: event, ...specific } } : {}),
  };
}

// ---- settings files, plugins, skills and subagents ----

/**
 * A PreToolUse entry Claude Code runs beside the fence: a settings file's, a plugin's, or one in a
 * skill's or a subagent's frontmatter.
 */
export interface SettingsHook {
  /** Where it is: a file, or the query option that holds it. */
  source: string;
  matcher?: string;
  /** A subagent's own: it runs only for that subagent's calls, whose `agent_type` this names. */
  agent?: string;
}

/**
 * Where Claude Code finds settings for the query, as its options say: the sources it loads
 * (`settingSources`; all three when absent), its working folder, `settings` (a settings object,
 * JSON text or a file, as the CLI's `--settings` takes, or a list of them), `managedSettings`, the
 * environment the CLI gets (`CLAUDE_CONFIG_DIR`, `HOME`), the folders it adds
 * (`additionalDirectories`) and the folders of the local plugins it loads (`plugins`).
 */
export interface SettingsPlaces {
  sources?: readonly string[] | null;
  cwd?: string | null;
  settings?: unknown;
  managedSettings?: unknown;
  env?: Readonly<Record<string, string | undefined>> | null;
  /**
   * The managed settings file an organization deploys: by default where Claude Code reads it on this
   * system; null for none. Its folder holds the rest of the organization's: `managed-settings.d/`,
   * `managed-mcp.json` and `.claude/skills/`.
   */
  managedFile?: string | null;
  addDirs?: readonly string[] | null;
  plugins?: readonly string[] | null;
}

/** One settings document Claude Code reads for the query: where it is, and what it holds (null for one it can't parse). */
export interface SettingsDocument {
  source: string;
  data: unknown;
  /** The organization's: the managed settings file, a drop-in beside it, or the query's `managedSettings`. */
  managed: boolean;
  /** Which settings it is, for keys Claude Code takes from some only (a repository's can't turn telemetry on). */
  scope: 'user' | 'project' | 'local' | 'managed' | 'query';
  /** The query's `managedSettings`: an embedding host's policy, which Claude Code ignores on a machine with managed settings of its own. */
  host?: true;
}

type Fs = typeof import('node:fs');
type Path = typeof import('node:path');

const load = (name: string): Promise<unknown> => import(/* webpackIgnore: true */ /* @vite-ignore */ name);

async function nodeModules(): Promise<{ fs: Fs; path: Path; os: typeof import('node:os') }> {
  return { fs: (await load('node:fs')) as Fs, path: (await load('node:path')) as Path, os: (await load('node:os')) as typeof import('node:os') };
}

/** The managed settings file an organization deploys, where Claude Code reads it on this system. */
function managedFile(platform: string, path: Path): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (platform === 'win32') return path.win32.join('C:\\Program Files', 'ClaudeCode', 'managed-settings.json');
  return '/etc/claude-code/managed-settings.json';
}

/** The managed settings file the places name, or this system's. */
export function managedFileOf(places: SettingsPlaces, path: Path): string | null {
  return places.managedFile === undefined ? managedFile(process.platform, path) : places.managedFile;
}

/** The folder Claude Code keeps its own files in: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function configDirOf(env: Readonly<Record<string, string | undefined>>, path: Path, home: string): string {
  return env.CLAUDE_CONFIG_DIR || path.join(env.HOME || home, '.claude');
}

/** The environment the CLI reads its folders from: the process's, with the query's on top. */
const envOf = (places: SettingsPlaces) => ({ ...process.env, ...(places.env ?? {}) });

/** The names in a folder, none when it can't be listed. */
function listDir(fs: Fs, dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** The PreToolUse entries of one settings document, each with a hook. */
function preToolUse(settings: unknown, source: string, agent?: string): SettingsHook[] {
  if (!isObject(settings) || !isObject(settings.hooks) || !Array.isArray(settings.hooks.PreToolUse)) return [];
  return settings.hooks.PreToolUse.filter((e): e is Record<string, unknown> => isObject(e) && Array.isArray(e.hooks) && e.hooks.length > 0).map((e) => ({ source, ...(typeof e.matcher === 'string' ? { matcher: e.matcher } : {}), ...(agent !== undefined ? { agent } : {}) }));
}

/**
 * The settings documents Claude Code reads for the query, in its order: the user's file (in
 * `CLAUDE_CONFIG_DIR`, else `~/.claude`), the project's in its working folder, the local one there
 * and at the root of the repository the folder is in, and of the main checkout for a linked
 * worktree, the managed settings file and every `*.json` in `managed-settings.d/` beside it in
 * alphabetical order, the query's `settings`, and its `managedSettings`. A file that isn't there is
 * left out; one that can't be parsed holds null.
 */
export async function settingsDocuments(places: SettingsPlaces, cwd: string): Promise<SettingsDocument[]> {
  const { fs, path, os } = await nodeModules();
  const env = envOf(places);
  const sources = places.sources ?? ['user', 'project', 'local'];
  const read = (file: string): unknown => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };
  const docs: SettingsDocument[] = [];
  const add = (file: string, scope: SettingsDocument['scope']) => {
    if (fs.existsSync(file)) docs.push({ source: file, data: read(file), managed: scope === 'managed', scope });
  };
  if (sources.includes('user')) add(path.join(configDirOf(env, path, os.homedir()), 'settings.json'), 'user');
  if (sources.includes('project')) add(path.join(cwd, '.claude', 'settings.json'), 'project');
  if (sources.includes('local')) {
    // The session folder's, as the Agent SDK documents it; and, as Claude Code itself reads it from a
    // folder inside a repository, the repository root's, and for a linked worktree the main
    // checkout's (the settings page's "Where Claude Code keeps the local file in a git repository").
    const { root, main } = repositoryRoots(fs, path, cwd);
    for (const dir of new Set([cwd, ...(root ? [root] : []), ...(main ? [main] : [])])) add(path.join(dir, '.claude', 'settings.local.json'), 'local');
  }
  const managed = managedFileOf(places, path);
  if (managed) {
    add(managed, 'managed');
    // Claude Code merges the drop-ins after the file, in alphabetical order, skipping hidden files and any not ending in .json.
    const dropins = path.join(path.dirname(managed), 'managed-settings.d');
    for (const name of listDir(fs, dropins).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort()) add(path.join(dropins, name), 'managed');
  }
  // The query's own settings: an object, JSON text, or a file, as `--settings` takes them.
  for (const given of [places.settings].flat()) {
    if (isObject(given)) docs.push({ source: "the query's settings option", data: given, managed: false, scope: 'query' });
    else if (typeof given === 'string' && given.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(given);
      } catch {
        parsed = read(path.resolve(cwd, given));
      }
      docs.push({ source: isObject(parsed) && given.trim().startsWith('{') ? "the query's settings option" : path.resolve(cwd, given), data: parsed, managed: false, scope: 'query' });
    }
  }
  if (isObject(places.managedSettings)) docs.push({ source: "the query's managedSettings option", data: places.managedSettings, managed: true, scope: 'managed', host: true });
  return docs;
}

/** The session's folder and each above it up to its repository's root, as project skills and subagents load; the folder alone outside a repository. */
export function projectDirs(fs: Fs, path: Path, cwd: string): string[] {
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (fs.existsSync(path.join(dir, '.git'))) return dirs;
    if (path.dirname(dir) === dir) return [cwd];
  }
}

/**
 * The repository the session's folder is in: its root, the first folder up from it with a `.git`
 * (a folder, or the file a linked worktree has), and for a linked worktree the main checkout's root,
 * which its `.git` file names through the git folder's `commondir`. Nulls outside a repository, and
 * for a main checkout there is none other than the root.
 */
export function repositoryRoots(fs: Fs, path: Path, cwd: string): { root: string | null; main: string | null } {
  let root = cwd;
  while (!fs.existsSync(path.join(root, '.git'))) {
    if (path.dirname(root) === root) return { root: null, main: null };
    root = path.dirname(root);
  }
  try {
    const dotGit = path.join(root, '.git');
    if (!fs.statSync(dotGit).isFile()) return { root, main: null };
    const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1];
    if (!gitdir) return { root, main: null };
    const own = path.resolve(root, gitdir);
    // A linked worktree's git folder names the repository's own (`commondir`); a submodule's names none.
    const common = path.resolve(own, fs.readFileSync(path.join(own, 'commondir'), 'utf8').trim());
    return { root, main: path.basename(common) === '.git' && path.dirname(common) !== root ? path.dirname(common) : null };
  } catch {
    return { root, main: null };
  }
}

/** At most this many skill and subagent files are read for one query: a folder of thousands says nothing more. */
const MAX_COMPONENT_FILES = 500;

/** The skill and subagent files Claude Code loads for the query, and its local plugins' hook files. */
export interface ComponentFiles {
  skills: string[];
  agents: string[];
  pluginHooks: string[];
}

/**
 * Where Claude Code loads skills and subagents from for the query, as the Agent SDK's documentation
 * lists them: under `user`, the skills and agents folders in `CLAUDE_CONFIG_DIR` (else `~/.claude`);
 * under `project`, `.claude/skills/` and `.claude/agents/` in the working folder and each folder above
 * it up to the repository's root, and in each added folder; the organization's skills in
 * `.claude/skills/` beside the managed settings file; and the skills, agents and `hooks/hooks.json`
 * of each local plugin the query loads.
 */
export async function componentFiles(places: SettingsPlaces, cwd: string): Promise<ComponentFiles> {
  const { fs, path, os } = await nodeModules();
  const env = envOf(places);
  const sources = places.sources ?? ['user', 'project', 'local'];
  const config = configDirOf(env, path, os.homedir());
  const managed = managedFileOf(places, path);
  const plugins = (places.plugins ?? []).map((p) => path.resolve(cwd, p));
  // In a linked worktree with none of its own, the main checkout's, as Claude Code loads its skills.
  const { root, main } = repositoryRoots(fs, path, cwd);
  const fromMain = (kind: 'skills' | 'agents') => (main && root && !fs.existsSync(path.join(root, '.claude', kind)) ? [path.join(main, '.claude', kind)] : []);
  const skillDirs = [
    ...(sources.includes('user') ? [path.join(config, 'skills')] : []),
    ...(sources.includes('project') ? [...[...projectDirs(fs, path, cwd), ...(places.addDirs ?? []).map((d) => path.resolve(cwd, d))].map((d) => path.join(d, '.claude', 'skills')), ...fromMain('skills')] : []),
    ...(managed ? [path.join(path.dirname(managed), '.claude', 'skills')] : []),
    ...plugins.map((p) => path.join(p, 'skills')),
  ];
  const agentDirs = [
    ...(sources.includes('user') ? [path.join(config, 'agents')] : []),
    ...(sources.includes('project') ? [...[...projectDirs(fs, path, cwd), ...(places.addDirs ?? []).map((d) => path.resolve(cwd, d))].map((d) => path.join(d, '.claude', 'agents')), ...fromMain('agents')] : []),
    ...plugins.map((p) => path.join(p, 'agents')),
  ];
  let budget = MAX_COMPONENT_FILES;
  const skills: string[] = [];
  for (const dir of new Set(skillDirs)) {
    for (const name of listDir(fs, dir).sort()) {
      const file = path.join(dir, name, 'SKILL.md');
      if (budget > 0 && !name.startsWith('.') && fs.existsSync(file)) {
        skills.push(file);
        budget--;
      }
    }
  }
  // Subagent files, in the folder and the folders inside it.
  const agents: string[] = [];
  const walk = (dir: string, depth: number) => {
    for (const name of listDir(fs, dir).sort()) {
      if (budget <= 0 || name.startsWith('.')) continue;
      const file = path.join(dir, name);
      if (name.endsWith('.md')) {
        agents.push(file);
        budget--;
      } else if (depth < 3) {
        try {
          if (fs.statSync(file).isDirectory()) walk(file, depth + 1);
        } catch {
          // Gone, or not readable: Claude Code can't load it either.
        }
      }
    }
  };
  for (const dir of new Set(agentDirs)) walk(dir, 0);
  const pluginHooks = plugins.map((p) => path.join(p, 'hooks', 'hooks.json')).filter((f) => fs.existsSync(f));
  return { skills, agents, pluginHooks };
}

/** A file's text, or null when it can't be read. */
function readText(fs: Fs, file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The PreToolUse hooks of the skills, subagents and local plugins the query loads (`files`, as
 * hookSources leaves them). Claude Code keeps a skill's for the rest of the session once the skill
 * is invoked, which can come at any turn, so each counts from the start; a subagent's run only while
 * that subagent runs, so each is for that subagent's calls alone. A frontmatter whose hooks can't be
 * read counts as a hook on every tool.
 */
async function componentPreToolUse(files: ComponentFiles): Promise<SettingsHook[]> {
  const { fs, path } = await nodeModules();
  const out: SettingsHook[] = [];
  const fromFrontmatter = (file: string, agent: boolean) => {
    const text = readText(fs, file);
    const keys = text === null ? null : frontmatter(text);
    if (!keys) return;
    const name = keys.get('name');
    const own = agent ? (name && 'value' in name && typeof name.value === 'string' && name.value.trim() ? name.value.trim() : path.basename(file, '.md')) : undefined;
    const hooks = keys.get('hooks');
    if (!hooks) return;
    if ('unreadable' in hooks) out.push({ source: `${file}, whose hooks Shadowlap could not read`, ...(own !== undefined ? { agent: own } : {}) });
    else out.push(...preToolUse({ hooks: hooks.value }, file, own));
  };
  for (const f of files.skills) fromFrontmatter(f, false);
  for (const f of files.agents) fromFrontmatter(f, true);
  for (const f of files.pluginHooks) {
    let data: unknown;
    try {
      data = JSON.parse(readText(fs, f) ?? '');
    } catch {
      out.push({ source: `${f}, which Shadowlap could not read` });
      continue;
    }
    out.push(...preToolUse(data, f));
  }
  return out;
}

/** A hook Claude Code runs itself, of any event: its type, and the command it runs or the URL it posts to. */
export interface HookItem {
  source: string;
  type: string;
  command?: string;
  url?: string;
}

/** Every hook of every event in one settings document (or a frontmatter's `hooks`, or a plugin's hooks.json). */
function hookItemsOf(settings: unknown, source: string): HookItem[] {
  if (!isObject(settings) || !isObject(settings.hooks)) return [];
  const out: HookItem[] = [];
  for (const entries of Object.values(settings.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      if (!isObject(e) || !Array.isArray(e.hooks)) continue;
      for (const h of e.hooks) {
        if (!isObject(h)) continue;
        out.push({ source, type: typeof h.type === 'string' ? h.type : 'command', ...(typeof h.command === 'string' ? { command: h.command } : {}), ...(typeof h.url === 'string' ? { url: h.url } : {}) });
      }
    }
  }
  return out;
}

/** Which hooks `disableAllHooks` leaves Claude Code running: every one, the managed settings' alone, or none. */
type HooksOn = 'all' | 'managed' | 'none';

/**
 * Which hooks Claude Code runs for the query by `disableAllHooks`. It takes the key, as any other,
 * from the highest level that sets it: managed settings (the file, then each drop-in replacing what
 * the one before said), then the query's `settings` (`--settings`), the local file, the project's
 * and the user's (the settings page's "Settings precedence"; the hooks reference's "Disable or
 * remove hooks"). A `true` in managed settings turns every hook off, and one from any other level
 * those outside managed settings. Where Claude Code may not read a value, only its `false` is
 * taken, so a hook that may run is counted: the query's `managedSettings`, which Claude Code ignores
 * on a machine with managed settings of its own; a local file at the repository's root or the main
 * checkout's (`ownLocal` is the session folder's, which it always reads), which it reads only with a
 * home folder, off Windows and in a repository the user owns; and a level whose files disagree.
 */
function hooksOn(docs: readonly SettingsDocument[], ownLocal: string): HooksOn {
  const said = (d: SettingsDocument) => (isObject(d.data) && typeof d.data.disableAllHooks === 'boolean' ? d.data.disableAllHooks : undefined);
  let managed: boolean | undefined;
  for (const d of docs) if (d.managed && !d.host && said(d) !== undefined) managed = said(d);
  if (managed !== undefined) return managed ? 'none' : 'all';
  if (docs.some((d) => d.host && said(d) === false)) return 'all';
  for (const scope of ['query', 'local', 'project', 'user'] as const) {
    const level = docs.filter((d) => d.scope === scope && !d.managed);
    if (level.some((d) => said(d) === false)) return 'all';
    if (level.some((d) => said(d) === true && (scope !== 'local' || d.source === ownLocal))) return 'managed';
  }
  return 'all';
}

/**
 * The settings documents, and the skills, subagents and local plugins, whose hooks Claude Code runs
 * for the query, as `disableAllHooks` leaves them (hooksOn): none when managed settings turn every
 * hook off; when another level turns them off, the managed settings' and the organization's skills
 * (in the folder beside the managed settings file) alone, as Claude Code's settings reference says
 * it keeps running managed hooks; else all of them.
 */
async function hookSources(places: SettingsPlaces, cwd: string): Promise<{ docs: SettingsDocument[]; files: ComponentFiles }> {
  const { path } = await nodeModules();
  const docs = await settingsDocuments(places, cwd);
  const on = hooksOn(docs, path.join(cwd, '.claude', 'settings.local.json'));
  if (on === 'none') return { docs: [], files: { skills: [], agents: [], pluginHooks: [] } };
  const files = await componentFiles(places, cwd);
  if (on === 'all') return { docs, files };
  const managed = managedFileOf(places, path);
  const organization = managed === null ? null : path.join(path.dirname(managed), '.claude', 'skills') + path.sep;
  return { docs: docs.filter((d) => d.managed), files: { skills: organization === null ? [] : files.skills.filter((f) => f.startsWith(organization)), agents: [], pluginHooks: [] } };
}

/**
 * Every hook Claude Code runs for the query, of every event, as `settingsPreToolUse` finds the
 * PreToolUse ones: the settings documents', and the skills', subagents' and local plugins', as
 * `disableAllHooks` leaves them (hookSources). A frontmatter or a hooks file it can't read is one of
 * `type` `unreadable`.
 */
export async function hookItems(places: SettingsPlaces, cwd: string): Promise<HookItem[]> {
  const { fs } = await nodeModules();
  const { docs, files } = await hookSources(places, cwd);
  const out = docs.flatMap((d) => hookItemsOf(d.data, d.source));
  for (const file of [...files.skills, ...files.agents]) {
    const text = readText(fs, file);
    const hooks = (text === null ? null : frontmatter(text))?.get('hooks');
    if (!hooks) continue;
    if ('unreadable' in hooks) out.push({ source: file, type: 'unreadable' });
    else out.push(...hookItemsOf({ hooks: hooks.value }, file));
  }
  for (const file of files.pluginHooks) {
    let data: unknown;
    try {
      data = JSON.parse(readText(fs, file) ?? '');
    } catch {
      out.push({ source: file, type: 'unreadable' });
      continue;
    }
    out.push(...hookItemsOf(data, file));
  }
  return out;
}

/**
 * The PreToolUse hooks Claude Code runs beside the fence for the query, read as they are now
 * (Claude Code reloads a file that changes): those of every settings document it reads
 * (settingsDocuments), and of the skills, subagents and local plugins it loads
 * (componentPreToolUse), as `disableAllHooks` leaves them (hookSources), so a hook Claude Code
 * won't run refuses no recorded write; where Claude Code may not read the value that would turn
 * one off, the hook counts. A file that can't be read or parsed holds none, as Claude Code skips
 * it; a frontmatter is the exception, read as a hook on every tool.
 */
export async function settingsPreToolUse(places: SettingsPlaces, cwd: string): Promise<SettingsHook[]> {
  const { docs, files } = await hookSources(places, cwd);
  return [...docs.flatMap((d) => preToolUse(d.data, d.source)), ...(await componentPreToolUse(files))];
}

/** Whether a hook of `h` runs for a call of the subagent `agentType` (the main session's when empty). */
export function hookRunsFor(h: SettingsHook, agentType: string): boolean {
  if (h.agent === undefined) return true;
  // A plugin's subagent is named with its plugin's: `plugin:agent`.
  return agentType === h.agent || agentType.endsWith(`:${h.agent}`);
}
