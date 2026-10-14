import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
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
      '@shadowlap-testing/mock-openai': fileURLToPath(new URL('./testing/mock-openai/src/index.ts', import.meta.url)),
      '@shadowlap-testing/mock-gemini': fileURLToPath(new URL('./testing/mock-gemini/src/index.ts', import.meta.url)),
      '@shadowlap-testing/mock-anthropic': fileURLToPath(new URL('./testing/mock-anthropic/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.{ts,tsx}', 'testing/**/test/**/*.test.ts', 'experiments/*/test/**/*.test.mjs'],
    // A JUnit report alongside the usual output, so a failure survives the run. Test files execute
    // in parallel workers, and a summary line scrolling past in a CI log is how an intermittent
    // failure becomes "something failed once" instead of a name you can act on. No `retry`: a flake
    // that CI swallows is one nobody fixes.
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'vitest-junit.xml' },
    esbuild: { jsx: 'automatic' },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
