import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Whether this run counts coverage (`vitest run --coverage`, CI's coverage job), which the tests read as SHADOWLAP_TEST_COVERAGE. */
const COVERAGE = process.argv.some((a) => /^--coverage(\.enabled)?(=true)?$/.test(a));

/** The repository's root, where every run's paths start. */
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

/**
 * The setup of a run of the tests started at the repository's root, this file's own, in a folder
 * that holds a suite, a package's or one under testing/, or in that suite's test folder: the
 * vitest.config.mjs in each passes the suite's folder here (`cd packages/dashboard && npx vitest run
 * test/<file>`). Vitest reads the config in the folder it starts in and none above it, so a run
 * started anywhere else has none of this: no shadowlap home of its own, so the dashboard's tests
 * write in the real ~/.shadowlap, no guard to fail them for it, and Vitest's 5 seconds for a test in
 * place of the timeouts below.
 */
export function testsIn(folder = ROOT) {
  const dir = resolve(folder);
  return defineConfig({
    // The setup's paths, the aliases' and the reports' start here, whichever folder the run started in.
    root: ROOT,
    resolve: {
      alias: {
        // Before the package itself: the browser-safe classification module the dashboard UI imports.
        '@shadowlap/engine/classify': fileURLToPath(new URL('./packages/engine/src/classify.ts', import.meta.url)),
        // The two the telemetry collector loads alone.
        '@shadowlap/engine/sqlite': fileURLToPath(new URL('./packages/engine/src/sqlite.ts', import.meta.url)),
        '@shadowlap/engine/body': fileURLToPath(new URL('./packages/engine/src/body.ts', import.meta.url)),
        '@shadowlap/engine': src('engine'),
        '@shadowlap/sidecar': src('sidecar'),
        '@shadowlap/sdk': src('sdk'),
        '@shadowlap/adapters': src('adapters'),
        '@shadowlap/tui/actions': fileURLToPath(new URL('./packages/tui/src/actions.ts', import.meta.url)),
        '@shadowlap/tui/data': fileURLToPath(new URL('./packages/tui/src/data.ts', import.meta.url)),
        '@shadowlap/tui/sse': fileURLToPath(new URL('./packages/tui/src/sse.ts', import.meta.url)),
        '@shadowlap/tui': src('tui'),
        '@shadowlap/dashboard': src('dashboard'),
        '@shadowlap/collector': src('collector'),
        '@shadowlap/remote': src('remote'),
        '@shadowlap-testing/mock-openai': fileURLToPath(new URL('./testing/mock-openai/src/index.ts', import.meta.url)),
        '@shadowlap-testing/mock-gemini': fileURLToPath(new URL('./testing/mock-gemini/src/index.ts', import.meta.url)),
        '@shadowlap-testing/mock-anthropic': fileURLToPath(new URL('./testing/mock-anthropic/src/index.ts', import.meta.url)),
      },
    },
    test: {
      // Every suite's tests from the root, and a suite's own from its folder, where a file is named from there (test/<file>).
      dir,
      include: dir === resolve(ROOT) ? ['packages/*/test/**/*.test.{ts,tsx}', 'testing/**/test/**/*.test.ts'] : ['test/**/*.test.{ts,tsx}'],
      // Fails the run when a test leaves a .shadowlap folder in the repository's root or testing/frameworks,
      // or anything in the checkout that git lists and the run didn't build. Gives the run a shadowlap
      // home of its own (SHADOWLAP_HOME), and under CI fails it when a test writes in the real ~/.shadowlap.
      globalSetup: ['./testing/no-stray-stores.mjs'],
      // Each test file a home of its own in the run's, which the processes it starts inherit, and the guard
      // that fails a test writing in the real home's shadowlap files, or starting a process to (home-guard.mjs).
      setupFiles: ['./testing/file-home.mjs'],
      // Python, which the guard's and the SDK's tests start, writes no __pycache__ beside what it imports. Under
      // coverage V8 counts each block of the packages' code and none of what native code runs, so a test timing the one
      // against the other (JSON.parse) has nothing to time: SHADOWLAP_TEST_COVERAGE says so.
      env: { PYTHONDONTWRITEBYTECODE: '1', ...(COVERAGE ? { SHADOWLAP_TEST_COVERAGE: '1' } : {}) },
      // A JUnit report alongside the usual output, so a failure survives the run. Test files execute
      // in parallel workers, and a summary line scrolling past in a CI log is how an intermittent
      // failure becomes "something failed once" instead of a name you can act on. No `retry`: a flake
      // that CI swallows is one nobody fixes.
      reporters: process.env.CI ? ['default', 'junit'] : ['default'],
      outputFile: { junit: 'vitest-junit.xml' },
      // With --coverage (CI's coverage job): V8's, of the packages' source, into coverage/. A report to
      // read, with no thresholds to fail on, written when tests fail too. What the end-to-end tests run
      // in a process of its own (the CLI as they start it) isn't counted: V8 sees the test workers only.
      coverage: {
        provider: 'v8',
        include: ['packages/*/src/**', 'packages/dashboard/ui/**'],
        reporter: ['text-summary', 'html', 'json-summary', 'lcov'],
        reportsDirectory: 'coverage',
        reportOnFailure: true,
      },
      esbuild: { jsx: 'automatic' },
      // Windows starts a process several times slower than macOS or Linux, and the end-to-end tests
      // start dozens (the CLI, agents, git): on a Windows runner the longest took 26 of the 30 seconds.
      testTimeout: process.platform === 'win32' ? 90_000 : 30_000,
      hookTimeout: process.platform === 'win32' ? 90_000 : 30_000,
    },
  });
}

export default testsIn();
