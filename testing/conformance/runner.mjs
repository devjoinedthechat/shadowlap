// Drives a shadowlap SDK client through the conformance scenarios against a real sidecar on an
// in-memory store. No API keys and no network: only tool, clock and randomness calls are exercised.
// Build the repository first (`npm run build` at the root).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DEFAULT_REPLAY_OPTIONS, Store } from '../../packages/engine/dist/index.js';
import { Sidecar } from '../../packages/sidecar/dist/index.js';
import { SCENARIOS } from './scenarios.mjs';

const run = promisify(execFile);
const COMMAND = { argv: ['shadowlap-conformance'], cwd: '/' };

/** The client prints one JSON object on stdout; anything else it writes is diagnostic. */
function parseOutput(stdout, stderr, step) {
  const line = stdout.split('\n').filter((l) => l.trim().startsWith('{')).pop();
  if (!line) throw new Error(`step "${step}": the client printed no JSON object.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  try {
    return JSON.parse(line);
  } catch (err) {
    throw new Error(`step "${step}": the client's last JSON line did not parse (${err.message}): ${line}`, { cause: err });
  }
}

async function invoke(client, step, env) {
  const [cmd, ...args] = client.argv;
  let stdout;
  let stderr;
  try {
    ({ stdout, stderr } = await run(cmd, [...args, step], {
      cwd: client.cwd,
      env: { ...process.env, ...client.env, ...env },
      encoding: 'utf8',
      timeout: 60_000,
    }));
  } catch (err) {
    stdout = err.stdout ?? '';
    stderr = err.stderr ?? '';
    // A non-zero exit is allowed as long as the client still reported what it observed.
    if (!stdout.includes('{')) throw new Error(`step "${step}" failed to run: ${err.message}\nstderr:\n${stderr}`, { cause: err });
  }
  return parseOutput(stdout, stderr, step);
}

/**
 * Runs every scenario (or those named in `only`) against one client.
 * `client` is `{ name, argv, cwd?, env? }`; argv is the program, the step name is appended.
 * Returns `[{ scenario, why, ok, error }]`.
 */
export async function runConformance(client, { only } = {}) {
  const chosen = only?.length ? SCENARIOS.filter((s) => only.includes(s.name)) : SCENARIOS;
  const results = [];

  for (const scenario of chosen) {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store });
    try {
      let recordOut;
      let recordCalls = [];
      let replayOut;
      let replayCalls = [];

      if (scenario.inactive) {
        // Deliberately no SHADOWLAP_URL: the wrappers must be transparent.
        recordOut = await invoke(client, scenario.inactive, { SHADOWLAP_URL: '', SHADOWLAP_RUN_ID: '' });
      } else {
        const recorded = sidecar.startRun({ mode: 'record', command: COMMAND });
        recordOut = await invoke(client, scenario.record, { SHADOWLAP_URL: sidecar.url, SHADOWLAP_RUN_ID: recorded.runId, ...scenario.env });
        sidecar.endRun(recorded.runId, 'completed');
        recordCalls = store.getCalls(recorded.runId);

        if (scenario.replay) {
          const replayed = sidecar.startRun({
            mode: 'replay',
            parentRunId: recorded.runId,
            command: COMMAND,
            replay: { ...DEFAULT_REPLAY_OPTIONS, ...scenario.replayOptions },
          });
          replayOut = await invoke(client, scenario.replay, { SHADOWLAP_URL: sidecar.url, SHADOWLAP_RUN_ID: replayed.runId, ...scenario.env });
          sidecar.endRun(replayed.runId, 'completed');
          replayCalls = store.getCalls(replayed.runId);
        }
      }

      scenario.check({ recordOut, recordCalls, replayOut, replayCalls, store });
      results.push({ scenario: scenario.name, why: scenario.why, ok: true, error: null });
    } catch (err) {
      results.push({ scenario: scenario.name, why: scenario.why, ok: false, error: err.message });
    } finally {
      await sidecar.close();
      store.close();
    }
  }
  return results;
}

/** Prints a report and returns true when every scenario passed. */
export function report(clientName, results) {
  let failed = 0;
  for (const r of results) {
    if (r.ok) console.log(`  ok   ${r.scenario}`);
    else {
      failed++;
      console.log(`  FAIL ${r.scenario} — ${r.why}\n       ${r.error.split('\n').join('\n       ')}`);
    }
  }
  console.log(`${clientName}: ${results.length - failed}/${results.length} scenarios passed`);
  return failed === 0;
}
