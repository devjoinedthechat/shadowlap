import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Store, type RunRecord, type UnrecordedFix } from '@shadowlap/engine';
import { RunBuilder, toolUse, user } from '../../engine/test/run-fixtures.js';
import { AttemptRunner } from '../src/attempts.js';
import { CliError, EXIT } from '../src/exit-codes.js';
import { repeatUnderSidecar, testAttempt } from '../src/run-agent.js';
import { formatUnrecorded, unrecordedRefusal, unrecordedRunAnyway } from '../src/unrecorded.js';

/**
 * The runners every command that replays a recording shares (`testAttempt` for test, bisect and
 * calibrate, `repeatUnderSidecar` for `replay --repeat`, the AttemptRunner of blame, verify, repair
 * and injection) refuse a recording whose model called a tool it never recorded that writes, before
 * the agent starts: the agent would run it again for real. `--allow-unrecorded` lets it run.
 */

const dir = mkdtempSync(join(tmpdir(), 'sl-unrecorded-runners-'));
const db = join(dir, 'shadowlap.db');
const marker = join(dir, 'agent-ran');
// The agent the runners would start: it leaves a file behind, and makes no model call.
const argv = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`];
let parent: RunRecord;

beforeAll(() => {
  const store = Store.open(db);
  // Its model asked for Bash, which the agent ran unwrapped: the run recorded no call of it.
  const b = RunBuilder.start(store, { argv });
  b.model({ messages: [user('Clean up the build.')] }, [toolUse('Bash', { command: 'rm -rf build' }, 't1')]);
  parent = store.getRun(b.end())!;
  store.close();
});
afterEach(() => rmSync(marker, { force: true }));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** What a runner threw: a usage error naming the tool, with the agent never started. */
async function refused(run: () => Promise<unknown>): Promise<CliError> {
  const err = await run().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CliError);
  expect((err as CliError).exitCode).toBe(EXIT.usage);
  expect((err as CliError).message).toContain('holds model calls of a tool Shadowlap never recorded, which writes');
  expect((err as CliError).message).toContain('    Bash  1 call from model call #1 · a Claude Code built-in that runs a command');
  expect(existsSync(marker), 'the agent never started').toBe(false);
  return err as CliError;
}

const attemptOptions = { cwd: dir, upstreams: {}, extraEnv: {}, writes: 'block' as const, guard: 'off' as const, normalizers: [], prices: undefined, clock: undefined, spec: null };

describe('the runners every replaying command shares', () => {
  it('testAttempt refuses, and runs the agent with --allow-unrecorded', async () => {
    const store = Store.open(db);
    try {
      await refused(() => testAttempt(store, parent, attemptOptions));
      // Without the flag on the command, the refusal suggests none: it says to declare the tool instead.
      const plain = await refused(() => testAttempt(store, parent, attemptOptions));
      expect(plain.message).not.toContain('--allow-unrecorded');
      expect(plain.message).toContain('declare it a read in shadowlap.config.json');
      const flagged = await refused(() => testAttempt(store, parent, { ...attemptOptions, allowUnrecorded: new Set() }));
      expect(flagged.message).toContain('--allow-unrecorded Bash');
      const ran = await testAttempt(store, parent, { ...attemptOptions, allowUnrecorded: new Set(['Bash']) });
      expect(ran.code).toBe(0);
      expect(existsSync(marker)).toBe(true);
    } finally {
      store.close();
    }
  }, 30_000);

  it('repeatUnderSidecar refuses before any attempt starts', async () => {
    const count = () => {
      const runs = Store.open(db);
      try {
        return runs.allRuns().length;
      } finally {
        runs.close();
      }
    };
    const before = count();
    const start = (sidecar: Parameters<Parameters<typeof repeatUnderSidecar>[4]>[0]) => sidecar.startRun({ mode: 'replay', parentRunId: parent.runId, command: { argv, cwd: dir } });
    await refused(() => repeatUnderSidecar({ db }, argv, 2, 1, start, 'off', { recording: parent, allowUnrecorded: new Set() }));
    // No attempt was kept: none started.
    expect(count()).toBe(before);
  }, 30_000);

  it("blame's, verify's and repair's AttemptRunner refuses, and runs the agent with --allow-unrecorded", async () => {
    const settings = { writes: 'stub' as const, reads: 'replay' as const, liveTools: [], spec: null, budget: null, timeoutMs: 30_000, guard: 'off' as const };
    const runner = await AttemptRunner.start({ db }, { ...settings, allowUnrecorded: [] });
    try {
      await refused(() => runner.attempt({ parent, argv, commandFromImport: false }));
    } finally {
      await runner.close();
    }
    const allowed = await AttemptRunner.start({ db }, { ...settings, allowUnrecorded: ['Bash'] });
    try {
      const a = await allowed.attempt({ parent, argv, commandFromImport: false });
      expect(a.code).toBe(0);
      expect(existsSync(marker)).toBe(true);
    } finally {
      await allowed.close();
    }
  }, 30_000);
});

describe('a tool of unknown effect', () => {
  const run = { runId: '01K0UNKNOWN0000000000000000', meta: {} } as unknown as RunRecord;
  const tool = (name: string, effect: 'write' | 'read' | 'unknown', why: string, fix: UnrecordedFix = 'wrap') => ({ name, count: 1, firstCallNo: 2, effect, why, fix });

  it('is refused as a write is, as the MCP proxy takes a tool its server leaves unannotated', () => {
    const refusal = unrecordedRefusal(run, [tool('frobnicate', 'unknown', 'its name says nothing of what it does')], new Set(), ['shadowlap', 'replay', run.runId]);
    expect(refusal).toContain("01K0UNKNOW holds model calls of a tool Shadowlap never recorded, which may write: a replay serves the model's answers again, so it would run it again for real.");
    expect(refusal).toContain('    frobnicate  1 call from model call #2 · its name says nothing of what it does');
    expect(refusal).toContain(`shadowlap replay ${run.runId} --allow-unrecorded frobnicate`);
    expect(unrecordedRefusal(run, [tool('frobnicate', 'unknown', '…')], new Set(['frobnicate']), null)).toBeNull();
    // With a write beside it, both are named.
    const both = unrecordedRefusal(run, [tool('frobnicate', 'unknown', '…'), tool('Bash', 'write', 'a Claude Code built-in that runs a command', 'fence')], new Set(), null);
    expect(both).toContain('which write, or may:');
    expect(unrecordedRunAnyway([tool('frobnicate', 'unknown', '…'), tool('lookup_kb', 'read', '…')], new Set()).map((t) => t.name)).toEqual(['lookup_kb']);
  });

  it('says at the end of a run that it may write, so a replay refuses it', () => {
    const said = formatUnrecorded([tool('frobnicate', 'unknown', 'its name says nothing of what it does')], 'recording');
    expect(said).toContain('  frobnicate may write, so every command that replays the run refuses to run it again until it is recorded, declared a read, or allowed with --allow-unrecorded.');
    expect(said).toContain("To have it recorded and replayed, wrap it where your agent runs it: tool('frobnicate', { effect: 'write' }, fn) with @shadowlap/sdk;");
  });

  it('points a Claude Code built-in at the fence, an MCP tool at shadowlap mcp, and leaves a session tool alone', () => {
    // A subagent's own calls are named apart: Agent itself is no write, and nothing need be done about it.
    const agent = tool('Agent', 'read', 'a Claude Code built-in that starts a subagent, whose own tool calls are named apart', 'none');
    expect(unrecordedRefusal(run, [agent], new Set(), null)).toBeNull();
    expect(formatUnrecorded([agent], 'recording')).not.toContain('To have it recorded');
    const shell = tool('PowerShell', 'write', 'a Claude Code built-in that runs a command', 'fence-effects');
    expect(unrecordedRefusal(run, [shell], new Set(), null)).toContain("  So Shadowlap records it and a replay serves it: name it in withFence's effects, withFence(options, { effects: { 'PowerShell': 'write' } }) (with_fence in Python), which records it and refuses to run it again on replay.");
    const close = tool('mcp__issues__close_issue', 'write', '"close" changes something', 'mcp');
    expect(unrecordedRefusal(run, [close], new Set(), null)).toContain('connect Claude Code to its MCP server through shadowlap mcp, which records and fences its calls');
  });
});
