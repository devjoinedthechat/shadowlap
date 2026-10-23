// A Jest suite's configuration, as docs/testing.md gives it.
module.exports = {
  testMatch: ['<rootDir>/*.test.cjs'],
  globalSetup: '@shadowlap/test/jest/global-setup',
  globalTeardown: '@shadowlap/test/jest/global-teardown',
  testEnvironment: '@shadowlap/test/jest/environment',
};
