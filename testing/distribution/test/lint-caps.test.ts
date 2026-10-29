import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import caps from '../../../scripts/lint-caps-rules.mjs';
import { qualifiedName } from '../../../scripts/lint-caps.mjs';

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
});
