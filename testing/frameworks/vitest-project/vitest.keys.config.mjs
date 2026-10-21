import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['keys.check.mjs'],
    globalSetup: ['@shadowlap/test/global-setup'],
    setupFiles: ['@shadowlap/test/setup'],
  },
});
