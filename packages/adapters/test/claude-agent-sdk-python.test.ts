import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, type RunRecord } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';

/**
 * The Python fence (shadowlap.adapters.claude_agent_sdk) against a real sidecar: an agent's tool calls
 * run through the stand-in for Claude Code's tool pipeline, as a subprocess, recorded, replayed with
 * no write run again, and forked with the writes refused.
 */

const SCRIPT = fileURLToPath(new URL('../../../sdks/python/tests/claude_agent_script.py', import.meta.url));

function python(): string | null {
  for (const cmd of ['python3', 'python']) {
    try {
      if (/Python 3\.(9|[1-9]\d)/.test(execFileSync(cmd, ['--version'], { encoding: 'utf8' }))) return cmd;
    } catch {
      // the next one
    }
  }
  return null;
}
const PYTHON = python();

interface Output {
  results: Array<{ content: string; is_error: boolean }>;
  notes: string[];
  ran: string[];
  project: string[];
}

describe.skipIf(!PYTHON)('the Python Claude Agent SDK fence, against a real sidecar', () => {
  let store: Store;
  let sidecar: Sidecar;
  beforeAll(async () => {
    store = Store.open(':memory:');
    sidecar = await Sidecar.start({ store });
  });
  afterAll(async () => {
    await sidecar.close();
    store.close();
  });

  // Async on purpose: the sidecar serves from this event loop.
  const agent = async (run: RunRecord, extra: Record<string, string> = {}): Promise<Output> => {
    const { stdout } = await promisify(execFile)(PYTHON!, [SCRIPT], { env: { ...process.env, ...sidecar.envFor(run.runId), ...extra }, encoding: 'utf8' });
    return JSON.parse(stdout.trim().split('\n').pop()!) as Output;
  };
  const command = { argv: ['agent'], cwd: '/proj' };

  let recording: RunRecord;
  let recorded: Output;

  it('records each built-in tool, and the tools really run', async () => {
    recording = sidecar.startRun({ mode: 'record', command });
    sidecar.expectPreloads(recording.runId, 'warn');
    recorded = await agent(recording);
    const ended = sidecar.endRun(recording.runId, 'completed');
    // The fence said the Claude Code CLI runs with no guard: the run names it.
    expect(ended.preloads?.hellos).toEqual({ 'claude-code': 1 });
    expect(ended.preloads?.unguarded).toContain('the Claude Code CLI the Claude Agent SDK runs');
    expect(recorded.ran).toEqual(['echo hi > out.txt', 'cd sub', 'fail 3 tests failed']);
    expect(recorded.project).toEqual(['/proj/notes.md', '/proj/out.txt', '/proj/report.md']);
    const calls = store.getCalls(recording.runId).filter((c) => c.kind === 'tool');
    expect(calls.map((c) => `${c.name}:${c.effect}:${c.end?.outcome}`)).toEqual(['Read:read:ok', 'Bash:write:ok', 'Write:write:ok', 'Bash:write:ok', 'Bash:write:error', 'Edit:write:ok']);
  });

  it('replays with no write run again, and the model reads what it read', async () => {
    const replay = sidecar.startRun({ mode: 'replay', parentRunId: recording.runId, command });
    const out = await agent(replay);
    const { summary } = sidecar.endRun(replay.runId, 'completed');
    expect(summary.divergence).toBeNull();
    expect(summary.byOrigin.replayed).toBe(6);
    expect(out.results).toEqual(recorded.results);
    expect(out.notes).toEqual(recorded.notes);
    expect(out.project).toEqual(['/proj/notes.md']);
    expect(out.ran).toHaveLength(3);
    expect(out.ran.every((c) => c === 'true' || c.startsWith('cd -- ') || c.startsWith("printf '%s'"))).toBe(true);
  });

  it('forks at a changed command and refuses every write after it', async () => {
    const fork = sidecar.startRun({ mode: 'replay', parentRunId: recording.runId, command });
    const out = await agent(fork, { VARIANT: 'changed' });
    const { summary } = sidecar.endRun(fork.runId, 'completed');
    expect(summary.divergence?.name).toBe('Bash');
    expect(out.ran).toEqual([]);
    expect(out.project).toEqual(['/proj/notes.md']);
    expect(out.results.slice(1).every((r) => r.is_error && r.content.startsWith('PreToolUse:'))).toBe(true);
    expect(summary.byOrigin.blocked).toBe(5);
  });
});
