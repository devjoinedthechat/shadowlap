// Stands in for `shadowlap calibrate` and `shadowlap gc` in the Settings route tests: it prints what
// the real commands print and sends their result on fd 3 the way emitJobEvent does.
import { writeSync } from 'node:fs';

let args = process.argv.slice(2);
if (args[0] === '--db') args = args.slice(2);
const fd = Number(process.env.SHADOWLAP_EVENTS_FD);
const emit = (event) => {
  if (Number.isInteger(fd) && fd >= 3) writeSync(fd, `${JSON.stringify(event)}\n`);
};

const [cmd, ...rest] = args;
if (cmd === 'calibrate') {
  const runId = rest[0];
  const write = rest.includes('--write');
  const clean = process.env.FAKE_CLEAN === '1';
  console.log(`⑂ Calibrating ${runId.slice(0, 10)} (node agent.mjs): replaying it offline until it is clean`);
  const normalizers = clean
    ? []
    : [
        { kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>', why: 'this looks like a UUID' },
        { kind: 'tool', name: 'save_report', path: '$.args.path', replace: '<PATH>', why: 'a value generated on each run' },
      ];
  // A calibration still running, for as long as a test needs one.
  if (process.env.FAKE_HOLD_MS) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_HOLD_MS)));
  if (clean) console.log('  round 1  clean: 2/2 calls replayed');
  else {
    console.log('  round 1  diverged at call 1 (api POST /v1/messages)');
    console.log('           + $.metadata.user_id: this looks like a UUID  uuid');
    console.log('  round 2  clean: 2/2 calls replayed');
  }
  emit({ type: 'result', data: { runId, source: 'given', clean: true, rounds: [], normalizers, written: write && normalizers.length > 0, added: write ? normalizers.map((_, i) => i + 1) : [], stopped: null } });
  console.log(clean ? '✓ This recording replays clean with the current rules. Nothing to add.' : '✓ 2 normalizers make this recording replay clean. Add them with --write, or one by one:');
} else if (cmd === 'gc') {
  const dryRun = rest.includes('--dry-run');
  const at = (flag) => (rest.includes(flag) ? rest[rest.indexOf(flag) + 1] : undefined);
  const olderThan = at('--older-than');
  const before = at('--before');
  const count = Number(process.env.FAKE_GC_COUNT ?? 2);
  // A dry run from a gc that names neither a cutoff nor --keep (an older Shadowlap's report).
  const cutoff = process.env.FAKE_GC_NO_CUTOFF === '1' ? null : before !== undefined ? Number(before) : 1_757_000_000_000;
  const bytes = Number(process.env.FAKE_GC_BYTES ?? 2048);
  const report = { dryRun, olderThanDays: olderThan !== undefined ? Number(olderThan) : null, keep: null, cutoff, total: 9, count, runs: [], expect: `${count}-0123456789abcdef`, blobs: bytes ? 3 : 0, bytes, recording: [], recordingCount: Number(process.env.FAKE_GC_RECORDING ?? 0), abandoned: [], abandonedCount: 0, deferred: false, store: { path: 'x.db', before: 4096, free: Number(process.env.FAKE_GC_FREE ?? 0), after: dryRun ? null : 2048 } };
  emit({ type: 'result', data: report });
  console.log(dryRun ? `✓ dry run: would delete ${count} runs and free 2.0 kB. To delete exactly these runs: shadowlap gc --before ${cutoff} --expect ${report.expect}` : `✓ deleted ${count} runs and 3 blobs · store 4.0 kB → 2.0 kB`);
} else {
  console.error(`fake-settings-cli: unknown command ${cmd}`);
  process.exitCode = 2;
}
