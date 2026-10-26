import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
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
    include: ['packages/*/test/**/*.test.{ts,tsx}', 'testing/**/test/**/*.test.ts', 'experiments/*/test/**/*.test.mjs'],
    // Fails the run when a test leaves a .shadowlap folder in the repository's root or testing/frameworks,
    // or anything in the checkout that git lists and the run didn't build.
    globalSetup: ['./testing/no-stray-stores.mjs'],
    // Python, which the guard's and the SDK's tests start, writes no __pycache__ beside what it imports.
    env: { PYTHONDONTWRITEBYTECODE: '1' },
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
