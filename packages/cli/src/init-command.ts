import { existsSync, statSync } from 'node:fs';
import { configBuild, readConfigFile } from '@shadowlap/engine';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type InitReport, type Language } from './init-report.js';
import { readJson, readText, readUtf8, tomlRequirements } from './init-source.js';

/**
 * The command that starts a project's agent, as `shadowlap init` reads it: the package manager from
 * the lockfile, the workspace or the manifest, then a script, an entry file or the file that builds
 * the model client.
 */

type NodeManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

type PythonManager = 'uv' | 'poetry' | 'pip';

/** The Node package manager a folder's lockfile belongs to, if it has one. */
export function lockfileManager(dir: string): NodeManager | null {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun';
  if (existsSync(join(dir, 'package-lock.json')) || existsSync(join(dir, 'npm-shrinkwrap.json'))) return 'npm';
  return null;
}

/** The package manager package.json declares for Corepack: `"packageManager": "pnpm@9.12.0"`. */
export function declaredManager(pkg: Record<string, unknown> | null): NodeManager | null {
  const m = typeof pkg?.packageManager === 'string' ? /^(npm|pnpm|yarn|bun)@/.exec(pkg.packageManager) : null;
  return m ? (m[1] as NodeManager) : null;
}

/**
 * The folders above `cwd` a workspace holding it could be declared in, nearest first: up to the
 * repository's root (the first one with `.git`), and, outside a repository, never the home folder
 * or above it, where a stray lockfile says nothing about the project.
 */
function workspaceFolders(cwd: string, home: string = homedir()): string[] {
  const out: string[] = [];
  let dir = resolve(cwd);
  if (existsSync(join(dir, '.git'))) return out;
  const top = resolve(home);
  for (let up = dirname(dir); up !== dir; dir = up, up = dirname(up)) {
    const holdsHome = relative(up, top);
    if (!holdsHome || (!holdsHome.startsWith('..') && !isAbsolute(holdsHome))) break;
    out.push(up);
    if (existsSync(join(up, '.git'))) break;
  }
  return out;
}

/**
 * Whether a workspace's patterns (`apps/*`, `packages/**`, `!apps/legacy`) take in the folder at
 * `rel` from its root.
 */
function inWorkspace(rel: string, patterns: readonly string[]): boolean {
  const path = rel.split(sep).join('/');
  const matches = (pattern: string) => {
    const glob = pattern.trim().replace(/^\.\//, '').replace(/\/+$/, '');
    const re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '.*');
    return new RegExp(`^${re}$`).test(path);
  };
  const include = patterns.filter((p) => !p.startsWith('!'));
  return include.some(matches) && !patterns.filter((p) => p.startsWith('!')).some((p) => matches(p.slice(1)));
}

/** The `packages` pnpm-workspace.yaml lists, as a block (`- 'apps/*'`) or a flow sequence (`["apps/*"]`). */
function pnpmPackages(text: string): string[] {
  const head = /^packages\s*:[ \t]*([^\n]*)$/m.exec(text);
  if (!head) return [];
  const inline = head[1]!.replace(/\s+#.*$/, '').trim();
  if (inline.startsWith('[')) return [...inline.slice(1, inline.lastIndexOf(']')).matchAll(/"([^"]*)"|'([^']*)'|([^,\s][^,]*)/g)].map((m) => (m[1] ?? m[2] ?? m[3]!).trim());
  const out: string[] = [];
  for (const line of text.slice(head.index + head[0].length).split('\n').slice(1)) {
    const item = /^\s*-\s*(?:"([^"]*)"|'([^']*)'|([^#\s][^#]*?))\s*(?:#.*)?$/.exec(line);
    if (item) out.push(item[1] ?? item[2] ?? item[3]!);
    else if (line.trim() && !line.trim().startsWith('#')) break;
  }
  return out;
}

/**
 * The Node package manager of the workspace `cwd` is a package of, from its root up the tree:
 * pnpm's pnpm-workspace.yaml, or `workspaces` in package.json (Yarn, npm, Bun), whose manager the
 * root's packageManager field or lockfile names. Null when no workspace takes the folder in.
 */
export function nodeWorkspaceManager(cwd: string): NodeManager | null {
  for (const dir of workspaceFolders(cwd)) {
    const rel = relative(dir, resolve(cwd));
    const pnpm = join(dir, 'pnpm-workspace.yaml');
    if (existsSync(pnpm)) {
      // A pnpm-workspace.yaml that lists no packages still makes pnpm the manager below it.
      const listed = pnpmPackages(readText(pnpm));
      if (!listed.length || inWorkspace(rel, listed)) return 'pnpm';
    }
    const root = readJson(join(dir, 'package.json'));
    const ws = root?.workspaces;
    const patterns = Array.isArray(ws) ? ws : ws && typeof ws === 'object' && Array.isArray((ws as { packages?: unknown }).packages) ? (ws as { packages: unknown[] }).packages : [];
    if (inWorkspace(rel, patterns.filter((p): p is string => typeof p === 'string'))) return declaredManager(root) ?? lockfileManager(dir) ?? 'npm';
  }
  return null;
}

/** The `[tool.uv.workspace]` table of a pyproject.toml, without its header; null when it has none. */
function uvWorkspaceTable(text: string): string | null {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.trim() === '[tool.uv.workspace]');
  if (at < 0) return null;
  const end = lines.findIndex((line, i) => i > at && line.trim().startsWith('['));
  return lines.slice(at + 1, end < 0 ? undefined : end).join('\n');
}

/** Whether a uv workspace above `cwd` lists it among its `members` (and doesn't `exclude` it). */
function inUvWorkspace(cwd: string): boolean {
  for (const dir of workspaceFolders(cwd)) {
    const table = uvWorkspaceTable(readText(join(dir, 'pyproject.toml')));
    if (table === null) continue;
    const rel = relative(dir, resolve(cwd));
    if (inWorkspace(rel, [...tomlRequirements(table, ['members']), ...tomlRequirements(table, ['exclude']).map((e) => `!${e}`)])) return true;
  }
  return false;
}

/**
 * How the Python side is installed and run: uv with a uv.lock here or as a member of a uv workspace,
 * Poetry with a poetry.lock or a `[tool.poetry]` table here, pip otherwise.
 */
export function pythonManager(cwd: string): PythonManager {
  if (existsSync(join(cwd, 'uv.lock'))) return 'uv';
  if (existsSync(join(cwd, 'poetry.lock')) || /^\[tool\.poetry\]\s*$/m.test(readText(join(cwd, 'pyproject.toml')))) return 'poetry';
  return inUvWorkspace(cwd) ? 'uv' : 'pip';
}

/** A Python file run the way its project runs Python: `uv run agent.py`, `poetry run python agent.py`. */
function runPython(manager: PythonManager, file: string): string[] {
  return manager === 'uv' ? ['uv', 'run', file] : manager === 'poetry' ? ['poetry', 'run', 'python', file] : ['python', file];
}

/** The first script `pyproject.toml` declares (`[project.scripts]`, or Poetry's `[tool.poetry.scripts]`), by name. */
function pythonScript(cwd: string): { name: string; table: string } | null {
  let text: string;
  try {
    text = readUtf8(join(cwd, 'pyproject.toml'));
  } catch {
    return null;
  }
  for (const table of ['[project.scripts]', '[tool.poetry.scripts]']) {
    const at = text.split('\n').findIndex((line) => line.trim() === table);
    if (at < 0) continue;
    for (const line of text.split('\n').slice(at + 1)) {
      const t = line.trim();
      if (t.startsWith('[')) break;
      const m = /^["']?([A-Za-z0-9][\w.-]*)["']?\s*=\s*["'][^"']+["']/.exec(t);
      if (m) return { name: m[1]!, table };
    }
  }
  return null;
}

/**
 * The file package.json says the project runs from: its `bin` (the only one, or the first), then
 * its `main`. A path inside the folder that is there, as Node would find it (`lib/cli` is
 * `lib/cli.js`); null otherwise.
 */
function nodeEntry(cwd: string, pkg: Record<string, unknown> | null): { file: string; from: string } | null {
  const bin = pkg?.bin;
  const named: Array<[string, unknown]> = typeof bin === 'string' ? [['bin', bin]] : bin && typeof bin === 'object' ? Object.entries(bin as Record<string, unknown>).slice(0, 1).map(([name, file]) => [`bin.${name}`, file]) : [];
  named.push(['main', pkg?.main]);
  for (const [key, value] of named) {
    if (typeof value !== 'string' || !value.trim() || isAbsolute(value)) continue;
    const given = value.trim().replace(/^\.\//, '');
    if (given.split(/[\\/]/).includes('..')) continue;
    const file = [given, `${given}.js`, `${given}.mjs`, `${given}.cjs`].find((f) => existsSync(join(cwd, f)) && statSync(join(cwd, f)).isFile());
    if (file) return { file, from: `package.json ${key}: ${value.trim()}` };
  }
  return null;
}

/**
 * The model client a file imports, by the name it is imported as (`@anthropic-ai/sdk`, `openai`): a
 * provider's SDK, or an agent framework's model or runner. Not a framework's tools alone (`ai`'s
 * `tool`, `langchain_core`), which a module of tools imports too. Null for none.
 */
function modelImport(file: string, text: string): string | null {
  if (file.endsWith('.py')) {
    const m = /^[ \t]*(?:from[ \t]+(anthropic|openai|pydantic_ai|crewai|langgraph|langchain_(?:openai|anthropic|google_genai|google_vertexai|aws))(?:\.[\w.]+)?[ \t]+import\b|import[ \t]+(anthropic|openai)\b|from[ \t]+google[ \t]+import[ \t]+(genai)\b)/m.exec(text);
    return m ? (m[3] ? 'google-genai' : (m[1] ?? m[2])!) : null;
  }
  const m = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"](@anthropic-ai\/[\w.-]+|openai|@google\/genai|@ai-sdk\/[\w.-]+|@openai\/agents|@mastra\/core|@langchain\/(?:openai|anthropic|google-genai|google-vertexai|aws|langgraph))['"]/.exec(text);
  return m ? m[1]! : null;
}

/** Where a command found by its file came from, as the setup words it: `the entry file agent.py`. */
const entryFile = (file: string) => `the entry file ${file}`;

/** Files that aren't how an agent starts, whatever they import: tests, fixtures and tool configs. */
const NOT_AN_ENTRY = /^(test_.*|.*_test\.py|.*\.(test|spec)\.[cm]?[jt]sx?|conftest\.py|setup\.py|.*\.config\.[cm]?[jt]s|.*\.d\.[cm]?ts)$/;

/**
 * The agent's file when nothing names how it starts: the one file at the top of the folder that
 * imports a model SDK or an agent framework (`triage.mjs`), and that no other file there imports.
 * Null when there are none or several, since a guess between them would only be a guess.
 */
function modelEntry(cwd: string, texts: ReadonlyArray<readonly [string, string]>, python: PythonManager): InitReport['command'] {
  const top = texts.filter(([f]) => relative(cwd, f) === basename(f) && /\.(py|[cm]?js|[cm]?ts|tsx)$/.test(f) && !NOT_AN_ENTRY.test(basename(f)));
  const calling = top.filter(([f, t]) => modelImport(f, t) !== null).map(([f]) => basename(f));
  if (calling.length !== 1) return null;
  const file = calling[0]!;
  const stem = file.replace(/\.[^.]+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A module another file imports is part of the agent, not where it starts.
  const imported = file.endsWith('.py') ? new RegExp(`^[ \\t]*(?:from[ \\t]+\\.?${stem}[ \\t]+import|import[ \\t]+${stem}\\b)`, 'm') : new RegExp(`['"]\\.\\/${stem}(?:\\.[cm]?[jt]sx?)?['"]`);
  if (top.some(([f, t]) => basename(f) !== file && imported.test(t))) return null;
  const argv = file.endsWith('.py') ? runPython(python, file) : /\.([cm]?ts|tsx)$/.test(file) ? ['npx', 'tsx', file] : ['node', file];
  return { argv, from: entryFile(file) };
}

/**
 * The command that builds the agent, as package.json's `build` script runs with the project's package
 * manager (`npm run build`, `pnpm build`): what `build` in shadowlap.config.json would name, so repair,
 * fix apply, verify, migrate apply and bisect rebuild a compiled agent. Null without one, or for one
 * that watches rather than builds. `configured` is the build the config names, when it reads.
 */
export function detectBuild(cwd: string, pkg: Record<string, unknown> | null, manager: InitReport['packageManager']): InitReport['build'] {
  const script = ((pkg?.scripts ?? {}) as Record<string, unknown>).build;
  if (typeof script !== 'string' || !script.trim() || /(?:--watch|\s-w)\b/.test(script)) return null;
  const argv = manager === 'pnpm' || manager === 'yarn' ? [manager, 'build'] : manager === 'bun' ? ['bun', 'run', 'build'] : ['npm', 'run', 'build'];
  let configured: string | null = null;
  try {
    configured = configBuild(readConfigFile(cwd).data.build);
  } catch {
    // a config that can't be read names no build here: doctor says what is wrong with it
  }
  return { argv, from: `package.json scripts.build: ${script}`, configured };
}

export function detectCommand(cwd: string, pkg: Record<string, unknown> | null, manager: InitReport['packageManager'], python: PythonManager, languages: Language[], texts: ReadonlyArray<readonly [string, string]> = []): InitReport['command'] {
  const scripts = (pkg?.scripts ?? {}) as Record<string, string>;
  const runner = manager === 'pnpm' ? ['pnpm'] : manager === 'yarn' ? ['yarn'] : manager === 'bun' ? ['bun', 'run'] : ['npm', 'run'];
  for (const name of ['agent', 'start', 'dev', 'run']) {
    const script = scripts[name];
    // A script that starts a web dev server or a watcher is not the agent itself, nor one that serves
    // agents and waits for requests (`mastra dev`, `mastra start`).
    if (typeof script === 'string' && !/\b(next|vite|nodemon|webpack|--watch|tsc -w|mastra\s+(?:dev|start|build))\b/.test(script)) return { argv: name === 'start' && runner[0] === 'npm' ? ['npm', 'start'] : [...runner, name], from: `package.json scripts.${name}: ${script}` };
  }
  // The file the package says it runs from, before guessing one by its name: a bin, then main.
  const entry = nodeEntry(cwd, pkg);
  if (entry) return { argv: /\.(ts|mts|cts|tsx)$/.test(entry.file) ? ['npx', 'tsx', entry.file] : ['node', entry.file], from: entry.from };
  if (languages.includes('python')) {
    // A script the project declares is how it is meant to start: `uv run research-agent`.
    const script = pythonScript(cwd);
    if (script) return { argv: python === 'pip' ? [script.name] : [python, 'run', script.name], from: `${script.table} in pyproject.toml` };
    for (const f of ['agent.py', 'main.py', 'app.py', 'run.py', 'src/agent.py', 'src/main.py']) {
      if (existsSync(join(cwd, f))) return { argv: runPython(python, f), from: entryFile(f) };
    }
  }
  for (const f of ['agent.ts', 'src/agent.ts', 'index.ts', 'src/index.ts', 'main.ts', 'src/main.ts']) {
    if (existsSync(join(cwd, f))) return { argv: ['npx', 'tsx', f], from: entryFile(f) };
  }
  for (const f of ['agent.mjs', 'agent.js', 'index.mjs', 'index.js', 'main.js', 'src/index.js']) {
    if (existsSync(join(cwd, f))) return { argv: ['node', f], from: entryFile(f) };
  }
  // Named after what it does (`triage.mjs`): the one file at the top that calls a model.
  return modelEntry(cwd, texts, python);
}
