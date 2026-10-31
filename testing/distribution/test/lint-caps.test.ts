import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { afterAll, describe, expect, it } from 'vitest';
import { raised, raisedSince } from '../../../scripts/lint-caps-raised.mjs';
import caps from '../../../scripts/lint-caps-rules.mjs';
import { fileWaivers, qualifiedName } from '../../../scripts/lint-caps.mjs';

/**
 * The caps held per function (scripts/lint-caps-rules.mjs): every function to the cap, and a function
 * over it today to a ceiling of its own, by its name in its file. A file's worst function once let every
 * other function in that file grow to it.
 */

const linter = new Linter({ configType: 'flat' });
/** Lints `code` as a TypeScript file with one per-function rule. */
function lint(code: string, rule: 'complexity' | 'max-lines-per-function' | 'max-depth', options: Record<string, unknown>) {
  return linter.verify(code, [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser }, plugins: { caps }, rules: { [`caps/${rule}`]: ['error', options] } }], 'held.ts');
}
/** Every function `code` has, by its name, with what the rule measures of it. */
const measured = (code: string, rule: 'complexity' | 'max-lines-per-function' | 'max-depth' = 'complexity') => Object.fromEntries(lint(code, rule, { max: 0, measure: true }).map((m) => Object.values(JSON.parse(m.message) as { key: string; value: number })));

/** A function `name` whose complexity is `n`: n − 1 ifs. */
const complex = (name: string, n: number) => `function ${name}(a: number) {\n${Array.from({ length: n - 1 }, (_, i) => `  if (a === ${i}) return ${i};`).join('\n')}\n  return -1;\n}\n`;

describe('a cap held per function', () => {
  it("holds every other function in a file to the cap, whatever one function's ceiling is", () => {
    const options = { max: 3, ceilings: { worst: 6 } };
    expect(lint(complex('worst', 6) + complex('fine', 3), 'complexity', options)).toEqual([]);
    // Another function in the same file may not grow to the worst one's ceiling, only to the cap.
    const grown = lint(complex('worst', 6) + complex('other', 5), 'complexity', options);
    expect(grown.map((m) => m.message)).toEqual(['other has a complexity of 5. Maximum allowed is 3.']);
    // The worst one is held to its own ceiling.
    expect(lint(complex('worst', 7), 'complexity', options).map((m) => m.message)).toEqual(['worst has a complexity of 7. Maximum allowed is 6 (its ceiling in lint-caps.json).']);
  });

  it('names each function by what it is called where it is, the functions it is in before it', () => {
    const code = [
      'class Store { open(a: number) { if (a) return 1; return 0; } get size() { return 1; } }',
      'const run = () => 1;',
      'function outer() { const inner = (b: number) => (b ? 1 : 2); return inner; }',
      "describe('the store', () => { it('opens', () => {}); });",
      "program.command('show').description('Shows a run').action(() => {});",
      "emitter.on('data', () => {});",
      'export default function () { return 1; }',
      "list.forEach(() => {}); list.forEach(() => {});",
    ].join('\n');
    expect(Object.keys(measured(code))).toEqual([
      'Store.open',
      'get Store.size',
      'run',
      'outer',
      'outer > inner',
      'describe("the store")',
      'describe("the store") > it("opens")',
      'action("show")',
      'emitter.on("data")',
      'default',
      'list.forEach(…)',
      // Where two in a file share a name, the later one is told apart by its place among them.
      'list.forEach(…) #2',
    ]);
  });

  it('measures how deep a function nests its blocks once, at its deepest', () => {
    const code = 'function deep(a: number) { if (a) { if (a > 1) { if (a > 2) { return 3; } } } for (;;) { break; } return 0; }\nfunction flat() { return 1; }';
    expect(measured(code, 'max-depth')).toEqual({ deep: 3 });
    expect(lint(code, 'max-depth', { max: 2 }).map((m) => m.message)).toEqual(['deep nests blocks too deeply (3). Maximum allowed is 2.']);
  });

  it('measures length as ESLint does, and holds it the same way', () => {
    const long = `function long() {\n${'  console.log(1);\n'.repeat(5)}}\n`;
    expect(measured(long, 'max-lines-per-function')).toEqual({ long: 7 });
    expect(lint(long, 'max-lines-per-function', { max: 5, ceilings: { long: 7 } })).toEqual([]);
  });
});

describe("a Python function's name in lint-caps.json", () => {
  it('is qualified by the classes and functions it is in', () => {
    const lines = ['class Tool:', '    def stream(self):', '        x = 1', '', '        @functools.wraps(fn)', '        def wrapper(*args):', '            return x', '', 'def top():', '    pass'];
    expect(qualifiedName(lines, 2)).toBe('Tool.stream');
    expect(qualifiedName(lines, 6)).toBe('Tool.stream.wrapper');
    expect(qualifiedName(lines, 9)).toBe('top');
  });

  it('is never waived for a whole file, where its functions would escape the list', () => {
    const toml = ['[tool.ruff.lint.per-file-ignores]', '"tests/**" = ["PT009", "S301"]', '"shadowlap/big.py" = ["C901"]', '', '[tool.ruff.lint.mccabe]', 'max-complexity = 15', '[lint.extend-per-file-ignores]', '"guard/x.py" = ["S110", "PLR0915"]'].join('\n');
    expect(fileWaivers(toml)).toEqual(['"shadowlap/big.py" = ["C901"]', '"guard/x.py" = ["S110", "PLR0915"]']);
    expect(fileWaivers('[tool.ruff.lint]\nselect = ["C90", "PLR0915"]')).toEqual([]);
  });
});

describe('lint-caps.json in a pull request', () => {
  // `--write --add` raises a ceiling or adds one, as a function renamed or moved needs, and review alone
  // would stop it: CI holds each pull request to its base branch (scripts/lint-caps-raised.mjs).
  const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
  const SCRIPT = join(ROOT, 'scripts', 'lint-caps-raised.mjs');
  const LIST = { complexity: { 'a.ts': { run: 40, walk: 35 }, 'b.ts': { parse: 33 } }, 'max-lines': { 'a.ts': 900, 'c.ts': 820 } };
  const repos: string[] = [];
  afterAll(() => {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true });
  });

  it('may lower a ceiling or take one off', () => {
    expect(raised(LIST, LIST)).toEqual([]);
    expect(raised(LIST, { complexity: { 'a.ts': { run: 38 } }, 'max-lines': { 'a.ts': 850 } })).toEqual([]);
    expect(raised(LIST, {})).toEqual([]);
  });

  it('may not add a ceiling or raise one, and names each', () => {
    const now = { complexity: { 'a.ts': { run: 41, walk: 35, grown: 31 }, 'b.ts': { parse: 33 }, 'd.ts': { fresh: 32 } }, 'max-lines': { 'a.ts': 901, 'c.ts': 820 }, 'max-depth': { 'b.ts': { parse: 6 } } };
    expect(raised(LIST, now)).toEqual([
      'a.ts › run: complexity 41, raised from 40',
      'a.ts › grown: complexity 31, added',
      'd.ts › fresh: complexity 32, added',
      'a.ts: max-lines 901, raised from 900',
      'b.ts › parse: max-depth 6, added',
    ]);
  });

  it("holds the working tree's list to where the branch left the ref it is given, and ends with 1 for one added or raised", () => {
    // Its real path, as Node names the script it runs: macOS's temporary folder is behind a link.
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'sl-lint-caps-raised-')));
    repos.push(repo);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: repo, stdio: 'ignore' });
    const put = (list: object) => writeFileSync(join(repo, 'lint-caps.json'), `${JSON.stringify(list, null, 2)}\n`);
    git('init', '-q');
    writeFileSync(join(repo, 'README.md'), 'a project\n');
    git('add', 'README.md');
    git('commit', '-q', '-m', 'start');
    git('tag', 'start');
    put(LIST);
    git('add', 'lint-caps.json');
    git('commit', '-q', '-m', 'the list');
    git('branch', 'base');
    git('checkout', '-q', '-b', 'feature');
    // The base branch lowers a ceiling after the branch left it: the branch, which still has the old
    // one, raises nothing.
    git('checkout', '-q', 'base');
    put({ ...LIST, complexity: { ...LIST.complexity, 'a.ts': { run: 38, walk: 35 } } });
    git('commit', '-q', '-am', 'run shrank');
    git('checkout', '-q', 'feature');
    put({ ...LIST, complexity: { ...LIST.complexity, 'a.ts': { run: 40, walk: 36 } } });
    expect(raisedSince(repo, 'base')).toEqual(['a.ts › walk: complexity 36, raised from 35']);
    // Where the list wasn't there, every ceiling in it is added.
    expect(raisedSince(repo, 'start')).toEqual(['a.ts › run: complexity 40, added', 'a.ts › walk: complexity 36, added', 'b.ts › parse: complexity 33, added', 'a.ts: max-lines 900, added', 'c.ts: max-lines 820, added']);

    // The script, from the repository it is in, as CI runs it.
    mkdirSync(join(repo, 'scripts'));
    copyFileSync(SCRIPT, join(repo, 'scripts', 'lint-caps-raised.mjs'));
    const run = (...args: string[]) => spawnSync(process.execPath, [join(repo, 'scripts', 'lint-caps-raised.mjs'), ...args], { encoding: 'utf8' });
    const grown = run('base');
    expect(grown.status).toBe(1);
    expect(grown.stderr).toContain('lint-caps.json adds or raises a ceiling since base:\n  - a.ts › walk: complexity 36, raised from 35\n');
    put(LIST);
    expect(run('base')).toMatchObject({ status: 0, stdout: 'lint-caps.json adds no ceiling and raises none since base\n' });
    expect(run('no-such-branch').status).toBe(2);
    expect(run().status).toBe(2);
  });

  it('is checked on every pull request, against its base branch', () => {
    const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const job = /^ {2}lint-ceilings:\n((?: {4}.*\n|\n)+)/m.exec(ci)?.[1] ?? '';
    expect(job).toContain("if: github.event_name == 'pull_request'");
    // The base branch and the history back to where the request left it, not the one commit a checkout fetches.
    expect(job).toMatch(/^ {10}fetch-depth: 0$/m);
    expect(job).toContain('BASE: origin/${{ github.base_ref }}');
    expect(job).toContain('run: node scripts/lint-caps-raised.mjs "$BASE"');
  });
});
