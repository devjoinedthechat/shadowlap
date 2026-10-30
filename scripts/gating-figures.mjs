#!/usr/bin/env node
// The figures docs/gating.md gives for goldens with too few sessions for an inconclusive to count by
// default, worked out by the engine's seeded loops (packages/engine/test/history-loop.ts) over 400
// histories each: a healthy suite's first 20 sessions, an agent that drops after its goldens' 15th
// session, and the same drop after their 30th. They take minutes, so they are not worked out on every
// test run:
//
//   node scripts/gating-figures.mjs
//
// writes packages/engine/test/gating-figures.json and prints the sentences and tables to put in
// docs/gating.md.
// packages/engine/test/gating-figures.test.ts holds the page to the file, and the file to the code: it
// works out each loop's first 10 histories again, which come out as the file keeps them only while the
// planner, the rule and the loop are as they were when it was written.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
// The test writes outside the checkout, which the test run holds to be left as it was found.
const dir = mkdtempSync(join(tmpdir(), 'gating-figures-'));
const out = join(dir, 'gating-figures.json');
try {
  const r = spawnSync(process.execPath, [vitest, 'run', 'packages/engine/test/gating-figures.test.ts', '--silent=false'], { cwd: root, stdio: 'inherit', env: { ...process.env, SHADOWLAP_GATING_FIGURES: out } });
  if (r.status !== 0) process.exit(r.status ?? 1);
  copyFileSync(out, join(root, 'packages', 'engine', 'test', 'gating-figures.json'));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
