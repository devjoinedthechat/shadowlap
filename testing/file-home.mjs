// Vitest's setup for each test file (vitest.config.ts): a Shadowlap home of the file's own, a folder
// in the run's (SHADOWLAP_TESTS_HOME, which no-stray-stores.mjs makes and removes), set as
// SHADOWLAP_HOME, which every process the file starts inherits. So the files Shadowlap keeps for this
// machine are never another test file's at once: its dashboards' project list and checks seen, its
// commands' agents and proxies. Writers that share a home on purpose race in checks-seen.test.ts.
//
// And the guard (home-guard.mjs): a write in the real home's Shadowlap files, or a process started
// to keep them there, is refused, and fails the test it happened in. A file whose run has no home
// of its own fails before its tests run: Vitest started with a config other than this repository's.
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach } from 'vitest';
import { guardHome, takeRefused } from './home-guard.mjs';

const run = process.env.SHADOWLAP_TESTS_HOME;
if (!run) {
  throw new Error(
    "this run of the tests has no Shadowlap home of its own (SHADOWLAP_TESTS_HOME), which testing/no-stray-stores.mjs makes: run Vitest with the repository's config, from its root or from a folder that holds tests (npx vitest run test/<file>), where vitest.config.mjs gives it the same setup.",
  );
}
guardHome();
// Through the guard: refused, and the file failed, where the run's home is in the real home's .shadowlap.
process.env.SHADOWLAP_HOME = mkdtempSync(join(run, 'file-'));

/** Fails the test, or the file, that a write or a process the guard refused came from. */
function failOnRefused() {
  const refused = takeRefused();
  if (refused.length) throw new Error(refused.join('\n'));
}
afterEach(failOnRefused);
afterAll(failOnRefused);
