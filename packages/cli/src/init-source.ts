import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * How `shadowlap init` reads a project's files: which source files it reads, the manifests it reads
 * dependencies from, and enough of Python's and JavaScript's call syntax to find a call's arguments,
 * an import's origin and a decorated function, never running any of it.
 */

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.venv', 'venv', 'env', '__pycache__', '.shadowlap', 'coverage', '.turbo', '.cache', 'site-packages', '.mypy_cache', '.pytest_cache', 'target']);

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py)$/;

const MAX_FILES = 3000;

const MAX_FILE_BYTES = 512 * 1024;

/**
 * A text file as Node and npm read it: a leading byte order mark, which Windows editors write, is
 * no part of the text (`require('./package.json')` drops it, and JSON.parse would refuse it).
 */
export function readUtf8(path: string): string {
  const text = readFileSync(path, 'utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readUtf8(path)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function installedVersion(cwd: string, pkg: string): string | null {
  const v = readJson(join(cwd, 'node_modules', pkg, 'package.json'))?.version;
  return typeof v === 'string' ? v : null;
}

/**
 * The quoted requirements in pyproject.toml's arrays with these keys (`dependencies = [...]`), read
 * a string at a time: extras (`"pydantic-ai-slim[openai]"`) put brackets inside the quotes, and a
 * marker (`; python_version >= '3.9'`) the other kind of quote.
 */
export function tomlRequirements(text: string, keys: readonly string[]): string[] {
  const specs: string[] = [];
  const array = new RegExp(`(?:^|\\n)\\s*(?:${keys.join('|')})\\s*=\\s*\\[((?:"[^"\\n]*"|'[^'\\n]*'|#[^\\n]*|[^\\]"'#])*)\\]`, 'g');
  // A comment in the array is passed over, quotes and all.
  for (const block of text.matchAll(array)) for (const s of block[1]!.matchAll(/"([^"\n]*)"|'([^'\n]*)'|#[^\n]*/g)) if (s[1] !== undefined || s[2] !== undefined) specs.push(s[1] ?? s[2]!);
  return specs;
}

/** Python dependency names from pyproject.toml, requirements files and Pipfile, lowercased and normalized. */
export function pythonDependencies(cwd: string): Set<string> {
  const names = new Set<string>();
  const add = (spec: string) => {
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec);
    if (m) names.add(m[1]!.toLowerCase().replace(/_/g, '-'));
  };
  const pyproject = join(cwd, 'pyproject.toml');
  if (existsSync(pyproject)) {
    const text = readUtf8(pyproject);
    for (const spec of tomlRequirements(text, ['dependencies', 'requires'])) add(spec);
    for (const section of text.matchAll(/\[tool\.poetry(?:\.group\.\w+)?\.dependencies\]([\s\S]*?)(?=\n\[|$)/g)) for (const line of section[1]!.split('\n')) if (/^\s*[\w.-]+\s*=/.test(line)) add(line);
  }
  for (const f of ['requirements.txt', 'requirements-dev.txt', 'requirements.in']) {
    const p = join(cwd, f);
    if (existsSync(p)) for (const line of readUtf8(p).split('\n')) if (line.trim() && !line.trim().startsWith('#') && !line.trim().startsWith('-')) add(line);
  }
  const pipfile = join(cwd, 'Pipfile');
  if (existsSync(pipfile)) for (const line of readUtf8(pipfile).split('\n')) if (/^\s*[\w.-]+\s*=/.test(line)) add(line);
  return names;
}

/**
 * The extras Python dependencies are asked for with (`pydantic-ai-slim[openai,anthropic]`), from
 * pyproject.toml (its dependency arrays, and Poetry's `extras = [...]`), requirements files and
 * Pipfile: an extra named after a provider installs that provider's SDK.
 */
export function pythonExtras(cwd: string): Array<{ name: string; extra: string }> {
  const out: Array<{ name: string; extra: string }> = [];
  const add = (name: string, list: string) => {
    for (const e of list.split(',')) {
      const extra = e.trim().replace(/^["']|["']$/g, '').toLowerCase();
      if (extra) out.push({ name: name.toLowerCase().replace(/_/g, '-'), extra });
    }
  };
  const spec = (text: string) => {
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*\[([^\]\n]*)\]/.exec(text);
    if (m) add(m[1]!, m[2]!);
  };
  const table = (line: string) => {
    const m = /^\s*([\w.-]+)\s*=\s*\{[^}]*\bextras\s*=\s*\[([^\]]*)\]/.exec(line);
    if (m) add(m[1]!, m[2]!);
  };
  const read = (f: string) => (existsSync(join(cwd, f)) ? readUtf8(join(cwd, f)) : '');
  const pyproject = read('pyproject.toml');
  for (const s of tomlRequirements(pyproject, ['dependencies', 'requires'])) spec(s);
  for (const line of pyproject.split('\n')) table(line);
  for (const f of ['requirements.txt', 'requirements-dev.txt', 'requirements.in']) for (const line of read(f).split('\n')) if (!line.trim().startsWith('#')) spec(line);
  for (const line of read('Pipfile').split('\n')) table(line);
  return out;
}

export function sourceFiles(cwd: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= MAX_FILES || depth > 8) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (out.length >= MAX_FILES) return;
      if (SKIP_DIRS.has(name) || (name.startsWith('.') && name !== '.')) continue;
      const path = join(dir, name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(path, depth + 1);
      else if (SOURCE.test(name) && !name.endsWith('.d.ts') && st.size <= MAX_FILE_BYTES) out.push(path);
    }
  };
  walk(cwd, 0);
  return out;
}

export const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

/** A project-relative path with forward slashes on every platform, as people type and click them. */
export const rel = (cwd: string, file: string) => relative(cwd, file).split(sep).join('/');

/** Inside a line or block comment: `tool(` in prose is not a definition, nor `model: '…'` a model. */
export function inCommentAt(text: string, index: number, py: boolean): boolean {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const before = text.slice(lineStart, index);
  if (py) return before.includes('#');
  if (/\/\/|^\s*\*|^\s*\/\*/.test(before)) return true;
  const open = text.lastIndexOf('/*', index);
  return open >= 0 && text.lastIndexOf('*/', index) < open;
}

/** What a Python file imports by name (`from strands import tool as strands_tool`): each local name, with the module and the name it has there. */
export type PyImports = Map<string, { module: string; name: string }>;

export function pyImports(text: string): PyImports {
  const out: PyImports = new Map();
  for (const m of text.matchAll(/^[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]+(?:\(([^)]*)\)|([^\n]*))/gm)) {
    for (const part of (m[2] ?? m[3]!).replace(/#[^\n]*/g, '').replace(/\\\n/g, ' ').split(',')) {
      const p = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
      if (p) out.set(p[2] ?? p[1]!, { module: m[1]!, name: p[1]! });
    }
  }
  return out;
}

/** Where the string literal that starts at `i` ends (its closing quote), Python's triple quotes included. */
function stringEnd(text: string, i: number, py: boolean): number {
  const q = text[i]!;
  if (py && text.startsWith(q.repeat(3), i)) {
    const end = text.indexOf(q.repeat(3), i + 3);
    return end < 0 ? text.length : end + 2;
  }
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === q) return j;
    else if (text[j] === '\n' && q !== '`') return j;
  }
  return text.length;
}

/**
 * The arguments of a call (or the items of a list) whose bracket opens just before `open`, split at
 * its own commas, each with where it starts: null when it doesn't close within reach. Strings and
 * comments are passed over, so a comma or bracket in them splits nothing.
 */
export function callArguments(text: string, open: number, py: boolean): Array<{ text: string; at: number }> | null {
  return scanCall(text, open, py)?.args ?? null;
}

/** {@link callArguments}, with where the bracket that closes the call is. */
function scanCall(text: string, open: number, py: boolean): { args: Array<{ text: string; at: number }>; end: number } | null {
  const out: Array<{ text: string; at: number }> = [];
  const push = (from: number, to: number) => {
    const raw = text.slice(from, to);
    if (raw.trim()) out.push({ text: raw.trim(), at: from + raw.length - raw.trimStart().length });
  };
  let depth = 1;
  let start = open;
  const limit = Math.min(text.length, open + 20_000);
  for (let i = open; i < limit; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'" || (c === '`' && !py)) i = stringEnd(text, i, py);
    else if (py ? c === '#' : c === '/' && text[i + 1] === '/') i = text.indexOf('\n', i) < 0 ? limit : text.indexOf('\n', i);
    else if (!py && c === '/' && text[i + 1] === '*') i = text.indexOf('*/', i + 2) < 0 ? limit : text.indexOf('*/', i + 2) + 1;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (--depth === 0) {
        push(start, i);
        return { args: out, end: i };
      }
    } else if (c === ',' && depth === 1) {
      push(start, i);
      start = i + 1;
    }
  }
  return null;
}

/** A Python keyword argument's value (`model="gpt-5"`), with where it starts; undefined when the call doesn't give it. */
export function kwarg(args: ReadonlyArray<{ text: string; at: number }>, key: string): { text: string; at: number } | undefined {
  for (const a of args) {
    const m = new RegExp(`^${key}\\s*=(?!=)\\s*`).exec(a.text);
    if (m) return { text: a.text.slice(m[0].length), at: a.at + m[0].length };
  }
  return undefined;
}

/** The arguments given by position, before any keyword or unpacked one. */
export const positional = (args: ReadonlyArray<{ text: string; at: number }>) => args.filter((a) => !/^(\*|\w+\s*=(?!=))/.test(a.text));

/** A plain string literal's text (`"gpt-5"`, `'anthropic:claude-sonnet-4-5'`); null for anything else, an f-string or a variable. */
export const literal = (raw: string | undefined): string | null => (raw === undefined ? null : (/^[rRuU]?(["'`])([^"'`\\\n${}]*)\1$/.exec(raw)?.[2] ?? null));

/** The calls in a Python file of the names it imports from a module (`Agent(` for `from strands import Agent`), with where each call's parenthesis opens. */
export function pyCalls(text: string, imports: PyImports, module: RegExp, names: readonly string[]): Array<{ index: number; open: number; name: string; local: string; module: string }> {
  const out: Array<{ index: number; open: number; name: string; local: string; module: string }> = [];
  for (const [local, from] of imports) {
    if (!module.test(from.module) || !names.includes(from.name)) continue;
    for (const m of text.matchAll(new RegExp(`(?<![\\w.])${local}\\s*\\(`, 'g'))) {
      if (!inCommentAt(text, m.index, true) && !/\b(?:def|class)\s+$/.test(text.slice(Math.max(0, m.index - 10), m.index))) out.push({ index: m.index, open: m.index + m[0].length, name: from.name, local, module: from.module });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Where a Python name comes from: imported (`strands_tool` from strands' `tool`), or dotted (`langchain_core.tools.tool`); null for neither. */
export function pyOrigin(imports: PyImports, name: string): { module: string; name: string } | null {
  const imported = imports.get(name);
  if (imported) return imported;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { module: name.slice(0, dot), name: name.slice(dot + 1) } : null;
}

/**
 * Python functions with their decorators, each decorator whole though it spans lines
 * (`@tool(\n    "lookup_order", …)`), and where the first one starts.
 */
export function pyDecoratedDefs(text: string): Array<{ index: number; name: string; decorators: string[] }> {
  const out: Array<{ index: number; name: string; decorators: string[] }> = [];
  let i = 0;
  while (i < text.length) {
    const next = text.indexOf('\n', i);
    const lineEnd = next < 0 ? text.length : next;
    if (!/^[ \t]*@[\w.]+/.test(text.slice(i, lineEnd))) {
      i = lineEnd + 1;
      continue;
    }
    const decorators: string[] = [];
    let j = i;
    for (;;) {
      const d = /^[ \t]*@[\w.]+[ \t]*/.exec(text.slice(j, j + 400));
      if (!d) break;
      let end = j + d[0].length;
      if (text[end] === '(') {
        const call = scanCall(text, end + 1, true);
        if (!call) break;
        end = call.end + 1;
      }
      decorators.push(text.slice(j, end).trim());
      const nl = text.indexOf('\n', end);
      if (nl < 0) break;
      j = nl + 1;
    }
    const def = /^[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)[ \t]*\(/.exec(text.slice(j, j + 300));
    if (def && decorators.length) out.push({ index: i, name: def[1]!, decorators });
    i = j > i ? j : lineEnd + 1;
  }
  return out;
}

export function readText(path: string, limit = 2 * 1024 * 1024): string {
  try {
    if (statSync(path).size > limit) return '';
    return readUtf8(path);
  } catch {
    return '';
  }
}
