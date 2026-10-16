// Stands in for the shadowlap CLI in the Tests routes' tests. It prints the command it was given and
// reports on fd 3 the way `shadowlap test` does: the replay it made, a link to it, and the Tests link.
// A golden whose name has "broken" in it fails; `normalize add` succeeds unless its replacement is <FAIL>.
// While the file FAKE_TESTS_HOLD names exists, `test` waits: a session still running.
import { existsSync, writeSync } from 'node:fs';

const args = process.argv.slice(2);
const fd = Number(process.env.SHADOWLAP_EVENTS_FD);
const emit = (event) => {
  if (Number.isInteger(fd) && fd >= 3) writeSync(fd, `${JSON.stringify(event)}\n`);
};

console.log(`argv ${JSON.stringify(args)}`);
if (args[0] === 'normalize') {
  if (args.includes('<FAIL>')) {
    console.error('✗ that rule would mask nothing');
    process.exit(2);
  }
  console.log('added normalizer #1 to shadowlap.config.json');
  process.exit(0);
}
if (args[0] === 'test') {
  const hold = process.env.FAKE_TESTS_HOLD;
  while (hold && existsSync(hold)) await new Promise((r) => setTimeout(r, 20));
  const broken = args.some((a) => a.includes('broken'));
  const runId = broken ? '01K5CQ4V5K0000000000000001' : '01K5CQ4V5K0000000000000002';
  emit({ type: 'run', runId, role: broken ? 'failing' : 'passing' });
  emit({ type: 'link', label: broken ? 'Open the run' : 'Open the passing run', href: `#/run/${runId}` });
  emit({ type: 'link', label: 'Tests', href: '#/tests' });
  console.log(broken ? '✗ broken: diverged at call 1 (api POST /v1/messages)' : '✓ refund-in-limit: 8/8 replayed, 2 checks passed');
  process.exit(broken ? 1 : 0);
}
process.exit(0);
