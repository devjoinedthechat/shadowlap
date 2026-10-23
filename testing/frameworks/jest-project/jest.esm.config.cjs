// The same suite's ES module files, for Jest's ES module support (--experimental-vm-modules).
module.exports = {
  testMatch: ['<rootDir>/*.spec.mjs'],
  globalSetup: '@shadowlap/test/jest/global-setup',
  globalTeardown: '@shadowlap/test/jest/global-teardown',
  testEnvironment: '@shadowlap/test/jest/environment',
};
