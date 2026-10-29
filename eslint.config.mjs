// ESLint for every package, its tests and the repository's JavaScript, with typescript-eslint's
// type-checked rules. Each file is linted with the TypeScript program that checks it: a package's
// sources with its own tsconfig.json, the dashboard's browser code with ui/tsconfig.json, the tests
// with tsconfig.test.json (or tsconfig.test-dom.json, for those that import the browser code), and
// the JavaScript with tsconfig.lint.json. Run it after `npm run build`: packages read each other
// through their built declarations, as tsc -b does.
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
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
  globalIgnores([
    '**/dist/**',
    '**/node_modules/**',
    '**/.shadowlap/**',
    // A Python virtualenv, as .gitignore has it: its packages ship JavaScript of their own.
    '**/.venv/**',
    'scripts/out/**',
    'sdks/python/build/**',
  ]),

  {
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
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
      // A test prints what it got, null and undefined included: in a label or an error that is what it
      // says, and in a string it compares a stray null fails the comparison. Arrays and objects still may not.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowAny: true, allowNullish: true, allowRegExp: true, allowNever: false, allowArray: false },
      ],
    },
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
      // Test agents and fake servers implement async interfaces without awaiting anything.
      '@typescript-eslint/require-await': 'off',
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
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    // CommonJS loads its modules with require().
    rules: { '@typescript-eslint/no-require-imports': 'off' },
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
