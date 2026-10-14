import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['*.spec.mjs'],
    globalSetup: ['@shadowlap/test/global-setup'],
    setupFiles: ['@shadowlap/test/setup'],
  },
});
