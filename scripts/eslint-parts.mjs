// ESLint over the repository as `eslint .` lints it, in two processes: the tests, then everything
// else. Each holds only the typed programs of its own files (tsconfig.test.json's alone spans every
// package's tests), so neither comes near the heap one run over everything outgrew. Fails when
// either part does.
import { spawnSync } from 'node:child_process';
import { TEST_FILES } from '../eslint.config.mjs';

const eslint = ['--max-old-space-size=8192', 'node_modules/eslint/bin/eslint.js', '--max-warnings', '0', '--no-error-on-unmatched-pattern'];
const parts = [
  { name: 'the tests', args: TEST_FILES },
  { name: 'the rest', args: ['.', ...TEST_FILES.flatMap((p) => ['--ignore-pattern', p])] },
];
let failed = false;
for (const part of parts) {
  const run = spawnSync(process.execPath, [...eslint, ...part.args], { stdio: 'inherit' });
  if (run.status !== 0) {
    failed = true;
    console.error(`eslint: ${part.name} failed (${String(run.status ?? run.signal)})`);
  }
}
process.exit(failed ? 1 : 0);
