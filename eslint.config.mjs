// ESLint for every package, its tests and the repository's JavaScript, with typescript-eslint's
// type-checked rules. Each file is linted with the TypeScript program that checks it: a package's
// sources with its own tsconfig.json, the dashboard's browser code with ui/tsconfig.json, the tests
// with tsconfig.test.json (or tsconfig.test-dom.json, for those that import the browser code), and
// the JavaScript with tsconfig.lint.json. Run it after `npm run build`: packages read each other
// through their built declarations, as tsc -b does.
import { readFileSync } from 'node:fs';
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import vitest from '@vitest/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import ts from 'typescript';

const root = import.meta.dirname;

/** The tests tsconfig.test-dom.json type-checks, read from it so the two lists can't drift. */
const domTests = (() => {
  const { config, error } = ts.readConfigFile(`${root}/tsconfig.test-dom.json`, (file) => ts.sys.readFile(file));
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  return /** @type {string[]} */ (config.include);
})();

const packages = ['adapters', 'cli', 'collector', 'dashboard', 'engine', 'remote', 'sdk', 'sidecar', 'test', 'tui'];
const testingPackages = ['mock-anthropic', 'mock-gemini', 'mock-openai', 'reference-agent'];

/** Files linted with the type information of one TypeScript program. */
const program = (files, project, ignores = []) => ({
  files,
  ignores,
  languageOptions: { parserOptions: { project, tsconfigRootDir: root } },
});

const TESTS = ['packages/*/test/**/*.{ts,tsx}', 'testing/**/test/**/*.ts'];
/** The dashboard's real-browser tests, on Playwright: tests too, with a program of their own. */
const BROWSER_TESTS = ['packages/dashboard/browser/**/*.ts'];
const JS = ['**/*.{js,mjs,cjs}'];
/** The JavaScript that is tests: agents and fakes the tests run, and the harnesses under testing/. */
const JS_TESTS = ['packages/*/test/**/*.{js,mjs,cjs}', 'testing/**/*.{js,mjs,cjs}'];
/** Every test: its functions are its describe and it callbacks, which hold whole suites. */
export const TEST_FILES = [...TESTS, ...domTests, ...BROWSER_TESTS, ...JS_TESTS];

/** What is never linted: build output, installed packages, stores, a virtualenv, generated files. */
export const IGNORED = [
  '**/dist/**',
  '**/node_modules/**',
  '**/.shadowlap/**',
  // A Python virtualenv, as .gitignore has it: its packages ship JavaScript of their own.
  '**/.venv/**',
  'scripts/out/**',
  'sdks/python/build/**',
];

/**
 * Growth stops. No function takes more than 30 paths through it, runs past 150 lines or nests its
 * blocks more than 5 deep, and no file runs past 800 lines, blank lines and comments not counted. A
 * test's functions are its describe and it callbacks, which hold whole suites, so their length is
 * not capped. The files over a cap today are listed in lint-caps.json, each held to what it is today:
 * scripts/lint-caps.mjs keeps that list exact, as `npm run lint` runs it, and lowers it as they shrink.
 */
export const CAPS = {
  complexity: { max: 30 },
  'max-lines-per-function': { max: 150, skipBlankLines: true, skipComments: true, IIFEs: true },
  'max-depth': { max: 5 },
  'max-lines': { max: 800, skipBlankLines: true, skipComments: true },
};
/** Today's files over a cap, by rule, each with what it is today (scripts/lint-caps.mjs). */
const OVER = JSON.parse(readFileSync(`${root}/lint-caps.json`, 'utf8'));
/** A cap as a rule's options, at `max`. */
const capped = (rule, max = CAPS[rule].max) => ['error', { ...CAPS[rule], max }];

/**
 * What the code says one way, each ban with the message that names that way, for no-restricted-syntax.
 * The rule takes one list, and a block that sets it replaces the list an earlier block gave: each block
 * below names, with `bans`, every ban its files are held to.
 */
const BANS = {
  // The engine's isObject is the one test for a plain object. The adapters, which install nothing but
  // the SDK, have a copy in is-object.ts.
  isObject: [
    {
      selector: ':matches(FunctionDeclaration, VariableDeclarator)[id.name=/^(isObject|isRecord|isPlainObject|plainObject)$/]',
      message: "Import isObject from '@shadowlap/engine' (or the package's own is-object.ts) instead of defining another.",
    },
  ],
  // messageOf(err) reads a caught value: `(err as Error).message` is undefined for a thrown string, and
  // the test spelled out is messageOf written again.
  messageOf: [
    {
      selector: "MemberExpression[property.name='message'][object.type='TSAsExpression'][object.typeAnnotation.typeName.name='Error']",
      message: "Read a caught value with messageOf(err) from '@shadowlap/engine': (err as Error).message is undefined when what was thrown is not an Error.",
    },
    {
      selector: "ConditionalExpression[test.operator='instanceof'][test.right.name='Error'][consequent.property.name='message'][alternate.callee.name='String']",
      message: "Read a caught value with messageOf(err) from '@shadowlap/engine'.",
    },
  ],
  // The CLI's exit statuses are a contract (docs/cli.md, "Exit status"), each named in EXIT (exit-codes.ts).
  exit: [
    {
      selector: "AssignmentExpression[left.object.name='process'][left.property.name='exitCode'][right.type='Literal']",
      message: 'Name the exit status with EXIT from exit-codes.ts: process.exitCode = EXIT.failed.',
    },
    {
      selector: "CallExpression[callee.object.name='process'][callee.property.name='exit'][arguments.0.type='Literal']",
      message: 'Name the exit status with EXIT from exit-codes.ts: process.exit(EXIT.usage).',
    },
  ],
};
/** no-restricted-syntax with the bans named. */
const bans = (...names) => ['error', ...names.flatMap((name) => BANS[name])];

export default defineConfig(
  globalIgnores(IGNORED),

  {
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked],
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      // `x == null` is how the code asks "null or undefined"; every other comparison is strict.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // A switch without a default must name every member of the union it switches on.
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
      // Returning a promise from inside try without awaiting it skips the catch and the finally.
      '@typescript-eslint/return-await': ['error', 'error-handling-correctness-only'],
      // Spreading a Promise, a function, an array or a class instance into an object loses what was meant.
      // Spreading a string into its code points is how the code walks characters, so strings are allowed.
      '@typescript-eslint/no-misused-spread': ['error', { allow: ['string'] }],
      '@typescript-eslint/no-deprecated': 'error',
      // `x as T` only, and an object literal asserted only where it is passed: one assigned is declared with
      // its type instead (`const x: T = { … }`), so a missing or misspelled field is caught. An array literal
      // asserted names its elements' type, which TypeScript would widen (`[a, b] as [number, number]`, `[] as
      // string[]`): it can't hide a field.
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'as', objectLiteralTypeAssertions: 'allow-as-parameter', arrayLiteralTypeAssertions: 'allow' }],
      // `this: void` says a function can't be called as a method; void stays out of other unions.
      '@typescript-eslint/no-invalid-void-type': ['error', { allowAsThisParameter: true, allowInGenericTypeArguments: true }],
      // Numbers and booleans read as they print; null, undefined, objects and arrays must be said in words.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        {
          allowNumber: true,
          allowBoolean: true,
          allowAny: false,
          allowNullish: false,
          allowRegExp: false,
          allowNever: false,
          allowArray: false,
          allow: [
            { from: 'lib', name: ['Error', 'URL', 'URLSearchParams'] },
            { from: 'package', package: 'url', name: ['URL', 'URLSearchParams'] },
          ],
        },
      ],
      // `{}` is what an unknown value is once null and undefined are taken out (`String(v ?? '')`); like
      // unknown, which the rule leaves alone, it may be anything, so it is no sign of a forgotten object.
      '@typescript-eslint/no-base-to-string': ['error', { ignoredTypeNames: ['Error', 'RegExp', 'URL', 'URLSearchParams', '{}'] }],
      // Passing on a caught value of unknown type is how an error travels; a known non-Error is still refused.
      '@typescript-eslint/prefer-promise-reject-errors': ['error', { allowThrowingAny: true, allowThrowingUnknown: true }],
      // node:test's test() and describe() return promises the runner itself waits for.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['test', 'it', 'describe', 'suite', 'before', 'after', 'beforeEach', 'afterEach'] },
          ],
        },
      ],
      // A leading underscore marks a name kept on purpose: an omitted property, an unused parameter.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],

      // A destructuring that declares one variable to reassign keeps the others beside it.
      'prefer-const': ['error', { destructuring: 'all' }],
      'no-restricted-syntax': bans('isObject'),

      // Off, each for its reason:
      // TypeScript keeps a variable narrowed when a callback assigns it (a flag a signal handler sets, the
      // best result a helper keeps), so nearly all of this rule's 416 findings here were checks that matter;
      // the rest guard input that arrives untyped (JSON, a JavaScript caller of the SDK).
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // The code matches control characters and terminal escapes on purpose (sanitizing names, stripping ANSI).
      'no-control-regex': 'off',
      // `x || fallback` is meant where it is written (an empty variable falls back too), and `??` where 0 or ''
      // must be kept: each of the rule's 147 findings here was read, and none drops a value it should keep.
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      // Names follow the code's own conventions (SQL columns, wire formats' snake_case keys, CONSTANTS).
      '@typescript-eslint/naming-convention': 'off',
      // With noUncheckedIndexedAccess, `xs[i]!` is how the code says an index it just checked exists.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // `() => setOpen(false)` returning the call's void is the code's idiom for handlers.
      '@typescript-eslint/no-confusing-void-expression': 'off',
      // `this` is aliased to name the object a patched or spied method was called on (`const rl = this`,
      // `program = this`) and to walk a fake DOM up from an element: each of its 7 findings here was that.
      '@typescript-eslint/no-this-alias': 'off',
      // A value's type says what it should be; converting one typed already is how the code reads one that
      // arrives untyped (a stored JSON field, an SQLite count that may come back a bigint, the environment),
      // as with no-unnecessary-condition above: each of its 84 findings here was at such a boundary.
      '@typescript-eslint/no-unnecessary-type-conversion': 'off',
      // The objects keys are deleted from are records the code reads and hands on as JSON (an environment, a
      // request's headers or body, a test's process.env), not maps of its own: each of its 36 findings was one.
      '@typescript-eslint/no-dynamic-delete': 'off',
      // `x === true` and `x === false` check what arrived (a stored check's `ok`, a config's flag, a stream's
      // isTTY, undefined off a terminal), whatever its type says: as with no-unnecessary-condition above.
      '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'off',
      // `void` says a callback returns nothing (`() => void ran++`, `return void (await exited)`), as with
      // no-confusing-void-expression above, and marks a name taken out of an object as unused on purpose.
      '@typescript-eslint/no-meaningless-void-operator': 'off',
    },
  },

  // Each file with the program that type-checks it.
  ...packages.map((p) => program([`packages/${p}/src/**/*.{ts,tsx}`], `packages/${p}/tsconfig.json`)),
  ...testingPackages.map((p) => program([`testing/${p}/src/**/*.ts`], `testing/${p}/tsconfig.json`)),
  program(['packages/dashboard/ui/**/*.{ts,tsx}'], 'packages/dashboard/ui/tsconfig.json'),
  program(BROWSER_TESTS, 'packages/dashboard/browser/tsconfig.json'),
  program([...TESTS, '**/*.d.mts'], 'tsconfig.test.json', domTests),
  program(domTests, 'tsconfig.test-dom.json'),
  program([...JS, 'vitest.config.ts'], 'tsconfig.lint.json'),

  // The tests.
  {
    files: [...TESTS, ...domTests, ...BROWSER_TESTS],
    rules: {
      // Tests read the CLI's JSON and their fixtures as any, and the assertion is the check.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // Fakes implement async interfaces without awaiting, and an async test that awaits nothing is harmless.
      '@typescript-eslint/require-await': 'off',
      // Tests hand methods to expect() to check what they are, not to call them.
      '@typescript-eslint/unbound-method': 'off',
      // A test's helper returns what the test says it read (`json<Report>(out)`): the assertions check it.
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
      // A fake is the few fields a test needs, asserted to the type the code takes (`{ … } as RunRecord`).
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'as', objectLiteralTypeAssertions: 'allow', arrayLiteralTypeAssertions: 'allow' }],
      // A test prints what it got, null and undefined included: in a label or an error that is what it
      // says, and in a string it compares a stray null fails the comparison. Arrays and objects still may not.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowAny: true, allowNullish: true, allowRegExp: true, allowNever: false, allowArray: false },
      ],
      '@typescript-eslint/restrict-plus-operands': ['error', { allowAny: true, allowNullish: true, allowNumberAndString: true, allowBoolean: false, allowRegExp: false }],
    },
  },

  // The tests vitest runs (the browser's run on Playwright's own runner), with its plugin's recommended rules.
  {
    files: [...TESTS, ...domTests],
    plugins: vitest.configs.recommended.plugins,
    rules: {
      ...vitest.configs.recommended.rules,
      // vitest's expect takes the message to fail with second: `expect(r.code, r.out).toBe(0)`.
      'vitest/valid-expect': ['error', { maxArgs: 2 }],
      // A hook asserts what it set up, so a suite whose setup failed says why.
      'vitest/no-standalone-expect': ['error', { additionalTestBlockFunctions: ['beforeAll', 'beforeEach', 'afterAll', 'afterEach'] }],
      // What holds on one platform only (a file's mode off Windows), or for some cases of a table, is asserted
      // where it holds: what the rest of the test asserts holds everywhere.
      'vitest/no-conditional-expect': 'off',
      // A test may assert through a helper of its file's own, each named here.
      'vitest/expect-expect': ['error', { assertFunctionNames: ['expect', 'expect*', 'rejects', 'refuses', 'follows', 'replaysEachBranch', 'holds', 'gitApplies'] }],
    },
  },
  // Each command's checks are functions in a table, which its tests call.
  { files: ['testing/coding-agents/test/commands.test.ts'], rules: { 'vitest/no-standalone-expect': 'off' } },

  // Growth stops (CAPS), a test's function length aside, and today's files over a cap held to what they
  // are (lint-caps.json).
  {
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    rules: Object.fromEntries(Object.keys(CAPS).map((rule) => [rule, capped(rule)])),
  },
  { files: TEST_FILES, rules: { 'max-lines-per-function': 'off' } },
  ...Object.entries(OVER).flatMap(([rule, files]) => Object.entries(files).map(([file, max]) => ({ files: [file], rules: { [rule]: capped(rule, max) } }))),

  // Files another pass is changing now, held out of the strict rules they don't meet yet until it merges.
  {
    files: ['packages/dashboard/src/read-pool.ts'],
    rules: { '@typescript-eslint/no-unnecessary-type-parameters': 'off' },
  },

  // The code of the packages that load the engine, the dashboard's browser code among it, reads a caught
  // value with messageOf; the CLI's names its exit statuses.
  {
    files: ['packages/{cli,collector,dashboard,engine,remote,sidecar,tui}/src/**/*.{ts,tsx}', 'packages/dashboard/ui/**/*.{ts,tsx}'],
    rules: { 'no-restricted-syntax': bans('isObject', 'messageOf') },
  },
  {
    files: ['packages/cli/src/**/*.ts'],
    rules: { 'no-restricted-syntax': bans('isObject', 'messageOf', 'exit') },
  },
  // The helpers themselves, and their copies where the engine can't be loaded: the adapters, and
  // @shadowlap/test's recording.ts, whose CommonJS copy loads only its own files.
  {
    files: ['packages/engine/src/{is-object,message-of}.ts', 'packages/adapters/src/is-object.ts', 'packages/test/src/recording.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  // The packages under testing/ are fakes and a reference agent: a fake implements an async interface
  // without awaiting, and the agent's tools are async as real ones are (their source is in its golden).
  {
    files: ['testing/*/src/**/*.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },

  // The JavaScript: scripts, the guard's preloads, the Action, test agents and harnesses.
  {
    files: JS,
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Its values are inferred, not declared, so most are any: these rules would flag nearly every line.
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // For the same reason a value it can't type is any, and one past code TypeScript can't follow reads as
      // never; null, undefined, objects and arrays are still refused.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowAny: true, allowNullish: false, allowRegExp: false, allowNever: true, allowArray: false },
      ],
      '@typescript-eslint/restrict-plus-operands': ['error', { allowAny: true, allowNullish: false, allowNumberAndString: false, allowBoolean: false, allowRegExp: false }],
      // Test agents and fake servers implement async interfaces without awaiting anything.
      '@typescript-eslint/require-await': 'off',
      // An SDK's enum is passed as the string it stands for: JavaScript has no enum to import it as.
      '@typescript-eslint/no-unsafe-enum-assignment': 'off',
      // Here the rule sees only Node's own methods, which this code keeps on purpose: the preloads to put them
      // back or call them on the patched object with .call(this, …), the Action to restore a warning
      // filter, a test agent to promisify readline's question with its own promisify.custom.
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    files: JS_TESTS,
    rules: {
      // As in the TypeScript tests: what a test prints, null and undefined included, is what it got.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowAny: true, allowNullish: true, allowRegExp: true, allowNever: true, allowArray: false },
      ],
      '@typescript-eslint/restrict-plus-operands': ['error', { allowAny: true, allowNullish: true, allowNumberAndString: true, allowBoolean: false, allowRegExp: false }],
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    // CommonJS loads its modules with require().
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  // The framework tests drive each framework's entry points, its older ones too (LangGraph's createReactAgent),
  // as the agents written against them call them; and they lint the same whether those frameworks are
  // installed here (testing/frameworks has packages of its own) or not, as on CI.
  {
    files: ['testing/frameworks/**'],
    rules: { '@typescript-eslint/no-deprecated': 'off' },
  },
  {
    files: ['testing/frameworks/jest-project/**'],
    languageOptions: { globals: { ...globals.jest } },
  },
  {
    files: ['testing/frameworks/**'],
    // The framework agents call each framework's own API, the parts it has deprecated included, as the agents they
    // stand for do. The frameworks are installed only where those suites run, so whether a call reads as deprecated
    // would depend on the machine lint runs on.
    rules: { '@typescript-eslint/no-deprecated': 'off' },
  },

  // React: the dashboard's browser code and the terminal UI.
  {
    files: ['packages/dashboard/ui/**/*.{ts,tsx}', 'packages/tui/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      // The checks from the React Compiler's rules that hold without it: a component made during render
      // remounts each time, and setState during render loops.
      'react-hooks/static-components': 'error',
      'react-hooks/set-state-in-render': 'error',
      'react-hooks/globals': 'error',
      'react-hooks/error-boundaries': 'error',
      // The plugin's other recommended rules check what the React Compiler needs to compile a component
      // (refs read during render, manual memoization kept, no Date.now() in render); neither UI is compiled
      // with it, and the latest-value ref and the kept summary those rules reject are deliberate here.
    },
  },
);
