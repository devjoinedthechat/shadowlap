// An agent that passes about two times in three: it runs the command it is given, then exits 1
// every third time it is run, counted in the file named first. Verify's gate sees a run passing
// between its two rates, which it can't tell apart in a few attempts.
//
//   node flaky-agent.mjs <counter file> <command> [args...]
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const [counter, command, ...args] = process.argv.slice(2);
let n = 0;
try {
  n = Number(readFileSync(counter, 'utf8')) || 0;
} catch {
  // the first run
}
writeFileSync(counter, String(n + 1));
const run = spawnSync(command, args, { stdio: 'inherit' });
process.exit(run.status === 0 && (n + 1) % 3 !== 0 ? 0 : 1);
