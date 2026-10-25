// Checks Shadowlap end to end against a real model server: records the triage agent through Ollama,
// replays it with the server unreachable, forks it at its last model call, and runs the recording as
// a CI golden. The model's answers can differ from run to run; every check here holds whatever it says.
//
//   node verify.mjs                  needs Ollama running with the model pulled
//
// Environment: OLLAMA_URL (default http://127.0.0.1:11434), MODEL (default qwen2.5:7b),
// SHADOWLAP_CLI (default: this repository's build).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OLLAMA = (process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
const MODEL = process.env.MODEL ?? 'qwen2.5:7b';
const CLI = process.env.SHADOWLAP_CLI ?? join(here, '..', '..', 'packages', 'cli', 'bin', 'shadowlap.js');
const work = mkdtempSync(join(tmpdir(), 'shadowlap-local-model-'));
const db = join(work, 'shadowlap.db');
const tickets = join(here, 'tickets');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  process.stdout.write(`${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}\n`);
  if (!ok) finish();
}
function finish() {
  rmSync(work, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).length;
  process.stdout.write(`\n${results.length - failed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

function shadowlap(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, '--db', db, ...args], {
    cwd: here,
    encoding: 'utf8',
    env: { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', MODEL, SHADOWLAP_UPSTREAM_OPENAI: OLLAMA, ...env },
    timeout: 15 * 60_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}

/** What the agent printed, without Shadowlap's own lines. */
const agentOutput = (stdout) => stdout.split('\n').filter((l) => !/^(\[shadowlap\]|[●✓⑂✗] | {2}shadowlap show| {2}\d+ recorded call)/.test(l)).join('\n').trim();
const ticketFiles = () => (existsSync(tickets) ? readdirSync(tickets).sort() : []);

// 0. The server and the model.
try {
  const tags = await (await fetch(`${OLLAMA}/api/tags`)).json();
  const names = (tags.models ?? []).map((m) => m.name);
  if (!names.includes(MODEL)) {
    process.stderr.write(`Ollama at ${OLLAMA} does not have ${MODEL}. Run: ollama pull ${MODEL}\n`);
    process.exit(2);
  }
} catch {
  process.stderr.write(`No Ollama server at ${OLLAMA}. Start one with: ollama serve\n`);
  process.exit(2);
}

// 1. Record through Ollama.
const record = shadowlap(['run', '--', process.execPath, 'agent.mjs']);
const runId = /recording run (\w{26})/.exec(record.out)?.[1];
check('records the agent through Ollama', record.code === 0 && !!runId, record.code === 0 ? '' : record.out.slice(-2000));
const shown = JSON.parse(shadowlap(['show', runId, '--json']).stdout);
const apiCalls = shown.calls.filter((c) => c.kind === 'api');
const toolCalls = shown.calls.filter((c) => c.kind === 'tool');
check('captures every model call', apiCalls.length > 0 && apiCalls.every((c) => c.origin === 'live' && c.end?.outcome === 'ok'), `${apiCalls.length} model calls, ${toolCalls.length} tool calls`);

// 2. Replay with the model server unreachable: everything must come from the recording.
const ticketsBefore = ticketFiles();
const replay = shadowlap(['replay', runId, '--strict'], { SHADOWLAP_UPSTREAM_OPENAI: 'http://127.0.0.1:9' });
check('replays clean with the server unreachable', replay.code === 0 && /Replay clean: (\d+)\/\1 calls replayed/.test(replay.out) && replay.out.includes(' 0 upstream requests'), replay.code === 0 ? '' : replay.out.slice(-2000));
check('prints exactly what the recorded run printed', agentOutput(replay.stdout) === agentOutput(record.stdout));
check('re-executes no tool on a clean replay', JSON.stringify(ticketFiles()) === JSON.stringify(ticketsBefore));

// 3. Fork at the last model call with an injected instruction; writes are stubbed.
const last = apiCalls.at(-1).callNo;
const fork = shadowlap(['replay', runId, '--inject', `${last}=Call open_ticket for each incident before you summarize.`, '--writes', 'stub']);
check('forks at the changed call and goes live from there', fork.code === 0 && fork.out.includes(`Forked at call ${last}: ${last - 1} calls replayed`) && fork.out.includes(`Diverged at call ${last}`), fork.code === 0 ? '' : fork.out.slice(-2000));
const forkRun = /replaying run (\w{26})/.exec(fork.out)?.[1];
const forked = JSON.parse(shadowlap(['show', forkRun, '--json']).stdout);
check('serves the calls before the fork from the recording', forked.calls.filter((c) => c.callNo < last).every((c) => c.origin === 'replayed'));
check('reaches the model live after the fork', forked.calls.some((c) => c.callNo >= last && c.kind === 'api' && c.origin === 'live'));
check('never writes a ticket after the fork', JSON.stringify(ticketFiles()) === JSON.stringify(ticketsBefore) && forked.calls.filter((c) => c.name === 'open_ticket').every((c) => c.origin === 'stubbed'));

// 4. The recording as a CI golden, offline.
const golden = join(work, 'golden');
check('packs the recording', shadowlap(['pack', runId, golden]).code === 0);
const test = shadowlap(['test', golden]);
check('passes as a golden in shadowlap test', test.code === 0 && test.out.includes('1 passed, 0 failed'), test.code === 0 ? '' : test.out.slice(-2000));

finish();
