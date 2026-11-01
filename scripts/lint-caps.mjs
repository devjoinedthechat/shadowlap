// What is over a lint cap today, each held to what it is today. eslint.config.mjs caps every
// function's complexity, length and nesting and every file's length (CAPS); ruff caps every Python
// function's complexity (C901) and statements (PLR0915), as sdks/python/pyproject.toml sets them.
// lint-caps.json lists what was over a cap when it came: each function by its name in its file
// (scripts/lint-caps-rules.mjs names them; a Python function by its qualified name, its noqa on its
// def line), each too-long file by the file, with what it is. This checks that the list is exact, as
// `npm run lint` runs it: a function that shrank lowers its ceiling, one back within the cap leaves
// the list, and one past its ceiling, or new past the cap, fails. --write makes the changes that
// lower. It never adds a function or raises a ceiling, as code that grew past one is made smaller;
// --add does, for a cap made stricter, or a function renamed or moved, whose ceiling goes with it,
// and a pull request's CI fails on either (scripts/lint-caps-raised.mjs), for review to see.
//
// Usage: node scripts/lint-caps.mjs [--write [--add]]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { CAPS, IGNORED, TEST_FILES } from '../eslint.config.mjs';
import capRules, { PER_FUNCTION } from './lint-caps-rules.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const LIST = `${root}lint-caps.json`;
const write = process.argv.includes('--write');
const add = process.argv.includes('--add');

/** The Python caps, as sdks/python/pyproject.toml sets them for ruff, by the name lint-caps.json lists them under. */
const pyproject = readFileSync(`${root}sdks/python/pyproject.toml`, 'utf8');
const setting = (key) => {
  const m = new RegExp(`^${key}\\s*=\\s*(\\d+)`, 'm').exec(pyproject);
  if (!m) throw new Error(`sdks/python/pyproject.toml sets no ${key}`);
  return Number(m[1]);
};
/** A ruff finding's number: `is too complex (16 > 0)`, `Too many statements (51 > 0)`. */
const ruffValue = (message) => Number(/\((\d+) > \d+\)/.exec(message)?.[1]);
const PY_CAPS = {
  'python-complexity': { code: 'C901', max: setting('max-complexity'), words: 'complexity' },
  'python-statements': { code: 'PLR0915', max: setting('max-statements'), words: 'statements' },
};
/** The ruff `npm run lint` runs, pinned there. */
const RUFF = /uvx (ruff@[\d.]+)/.exec(JSON.parse(readFileSync(`${root}package.json`, 'utf8')).scripts.lint)?.[1];

const posix = (file) => relative(root, file).split(sep).join('/');

/**
 * What is over a cap now: for each per-function rule, `{ file: { function: value } }`; for max-lines,
 * `{ file: lines }`. ESLint with the per-function rules measuring, and its own max-lines at 0.
 */
async function measureScripts() {
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [
      { ignores: IGNORED },
      {
        files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
        languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
        plugins: { caps: capRules },
        rules: Object.fromEntries(Object.entries(CAPS).map(([rule, options]) => (PER_FUNCTION.includes(rule) ? [`caps/${rule}`, ['error', { ...options, measure: true }]] : [rule, ['error', { ...options, max: 0 }]]))),
      },
      { files: TEST_FILES, rules: { 'caps/max-lines-per-function': 'off' } },
    ],
  });
  const over = Object.fromEntries(Object.keys(CAPS).map((rule) => [rule, {}]));
  for (const result of await eslint.lintFiles(['.'])) {
    const file = posix(result.filePath);
    for (const m of result.messages) {
      if (m.fatal) throw new Error(`${file} could not be read: ${m.message}`);
      const rule = m.ruleId?.replace(/^caps\//, '');
      if (!rule || !(rule in CAPS)) continue;
      if (PER_FUNCTION.includes(rule)) {
        const { key, value } = JSON.parse(m.message);
        (over[rule][file] ??= {})[key] = value;
        continue;
      }
      const n = Number(/\((\d+)\)\. Maximum/.exec(m.message)?.[1]);
      if (Number.isFinite(n) && n > CAPS[rule].max) over[rule][file] = Math.max(over[rule][file] ?? 0, n);
    }
  }
  return over;
}

/** A Python function's qualified name, from the def on line `row` and the classes and functions it is in, by their indentation. */
export function qualifiedName(lines, row) {
  const def = /^(\s*)(?:async\s+)?def\s+(\w+)/.exec(lines[row - 1] ?? '');
  if (!def) return `line ${row}`;
  const names = [def[2]];
  let indent = def[1].length;
  for (let i = row - 2; i >= 0 && indent > 0; i--) {
    const outer = /^(\s*)(?:(?:async\s+)?def|class)\s+(\w+)/.exec(lines[i]);
    if (outer && outer[1].length < indent) {
      names.unshift(outer[2]);
      indent = outer[1].length;
    }
  }
  return names.join('.');
}

/**
 * The lines of a ruff config (pyproject.toml's tool.ruff, or ruff.toml) that waive a whole file from
 * C901 or PLR0915: its functions would escape ruff and this list alike, so they carry a noqa and a
 * ceiling each instead.
 */
export function fileWaivers(toml) {
  const out = [];
  let inTable = false;
  for (const line of toml.split('\n')) {
    const header = /^\s*\[(.+)\]\s*$/.exec(line);
    if (header) {
      inTable = header[1].includes('per-file-ignores');
      continue;
    }
    if ((inTable || line.includes('per-file-ignores')) && /"(C90\d*|PLR0915)"/.test(line)) out.push(line.trim());
  }
  return out;
}

/** The Python functions over a cap now, `{ file: { qualified name: value } }` by rule: ruff with every limit at 0, noqa and per-file ignores aside. */
function measurePython() {
  if (!RUFF) throw new Error("package.json's lint script names no ruff to run");
  const waived = ['sdks/python/pyproject.toml', 'ruff.toml'].flatMap((file) => fileWaivers(readFileSync(`${root}${file}`, 'utf8')).map((line) => `${file}: ${line}`));
  if (waived.length) throw new Error(`a file waived from a Python cap escapes lint-caps.json: give each of its functions over the cap a noqa and a ceiling instead\n${waived.join('\n')}`);
  const select = Object.values(PY_CAPS)
    .map((c) => c.code)
    .join(',');
  const json = execFileSync(
    'uvx',
    [RUFF, 'check', '--select', select, '--config', 'lint.mccabe.max-complexity = 0', '--config', 'lint.pylint.max-statements = 0', '--config', 'lint.per-file-ignores = {}', '--config', 'lint.extend-per-file-ignores = {}', '--ignore-noqa', '--exit-zero', '--output-format', 'json', '.'],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  const over = Object.fromEntries(Object.keys(PY_CAPS).map((rule) => [rule, {}]));
  const sources = new Map();
  for (const m of JSON.parse(json)) {
    const entry = Object.entries(PY_CAPS).find(([, c]) => c.code === m.code);
    if (!entry) continue;
    const [rule, cap] = entry;
    const value = ruffValue(m.message);
    if (!(value > cap.max)) continue;
    const file = posix(m.filename);
    if (!sources.has(file)) sources.set(file, readFileSync(m.filename, 'utf8').split('\n'));
    (over[rule][file] ??= {})[qualifiedName(sources.get(file), m.location.row)] = value;
  }
  return over;
}

/** One rule's list, flat: `file`, or `file › function`, each with its number. */
const flat = (byFile) => Object.entries(byFile).flatMap(([file, held]) => (typeof held === 'number' ? [[file, held]] : Object.entries(held).map(([fn, n]) => [`${file} › ${fn}`, n])));

/** Checks the list, or with --write lowers it, and with --add adds to it. */
async function main() {
  const listed = JSON.parse(readFileSync(LIST, 'utf8'));
  const now = { ...(await measureScripts()), ...measurePython() };
  const caps = { ...Object.fromEntries(Object.entries(CAPS).map(([rule, c]) => [rule, { max: c.max, words: rule }])), ...PY_CAPS };
  const next = {};
  const changes = [];
  const grown = [];

  for (const [rule, cap] of Object.entries(caps)) {
    const perFile = rule === 'max-lines';
    const held = new Map(flat(listed[rule] ?? {}));
    const at = new Map(flat(now[rule] ?? {}));
    const kept = new Map();
    for (const [where, ceiling] of held) {
      const n = at.get(where);
      if (n === undefined) changes.push(`${where}: within the ${cap.words} cap of ${cap.max} now${perFile ? '' : ', or gone'}, so off the list`);
      else if (n < ceiling) changes.push(`${where}: ${cap.words} ${n}, under its ceiling of ${ceiling}`);
      else if (n > ceiling) grown.push(`${where}: ${cap.words} ${n}, past its ceiling of ${ceiling}`);
      if (n !== undefined) kept.set(where, add ? n : Math.min(n, ceiling));
    }
    for (const [where, n] of at) {
      if (held.has(where)) continue;
      grown.push(`${where}: ${cap.words} ${n}, past the cap of ${cap.max}`);
      if (add) kept.set(where, n);
    }
    next[rule] = {};
    for (const [where, n] of [...kept].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (perFile) next[rule][where] = n;
      else {
        const [file, fn] = where.split(' › ');
        (next[rule][file] ??= {})[fn] = n;
      }
    }
  }

  const count = (list) => Object.values(list).reduce((n, files) => n + flat(files).length, 0);
  if (write) {
    writeFileSync(LIST, `${JSON.stringify(next, null, 2)}\n`);
    for (const line of add ? [...changes, ...grown] : changes) console.log(line);
    if (grown.length && !add) {
      console.error(`\nlint-caps.json lowers no further than this: ${grown.length} past a ceiling or a cap, which lint refuses. Make them smaller; a function renamed or moved takes its ceiling with --write --add.`);
      process.exitCode = 1;
    }
  } else if (changes.length || grown.length) {
    for (const line of [...changes, ...grown]) console.error(line);
    if (changes.length) console.error('\nlint-caps.json is not exact: `node scripts/lint-caps.mjs --write` lowers it.');
    process.exitCode = 1;
  } else {
    console.log(`lint-caps.json is exact: ${count(next)} ceilings.`);
  }
}

/** Run as a script, not imported (as a test imports qualifiedName). */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
