// Vitest's setup for each test file (vitest.config.ts): a Shadowlap home of the file's own, a folder
// in the run's (SHADOWLAP_TESTS_HOME, which no-stray-stores.mjs makes and removes), set as
// SHADOWLAP_HOME, which every process the file starts inherits. So the files Shadowlap keeps for this
// machine are never another test file's at once: its dashboards' project list and checks seen, its
// commands' agents and proxies. Writers that share a home on purpose race in checks-seen.test.ts.
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

const run = process.env.SHADOWLAP_TESTS_HOME;
if (run) process.env.SHADOWLAP_HOME = mkdtempSync(join(run, 'file-'));
