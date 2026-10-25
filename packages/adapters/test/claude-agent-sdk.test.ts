import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Store, type RunRecord } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { BUILT_IN_EFFECTS, fenceHooks, withEffects, withFence, type HookMatcherLike } from '../src/claude-agent-sdk.js';
import { matcherPicks } from '../src/claude-hooks.js';
import { FakeClaudeCode, matches, type Hooks, type ToolResult } from './fake-claude-code.js';

/**
 * The Claude Agent SDK's built-in tools, recorded and fenced through its hooks, against a stand-in
 * for Claude Code's tool pipeline (fake-claude-code.ts) and a real sidecar: a recording, a replay
 * that runs no write again and hands the model what it read the first time, and a fork that refuses
 * or stubs the writes.
 */

let store: Store;
let sidecar: Sidecar;
const ROOT = '/proj';

beforeAll(async () => {
  store = Store.open(':memory:');
  sidecar = await Sidecar.start({ store });
});
afterEach(() => {
  delete process.env.SHADOWLAP_URL;
  delete process.env.SHADOWLAP_RUN_ID;
});
afterAll(async () => {
  await sidecar.close();
  store.close();
});

/** A Claude Code session on the project as it is before the agent runs; `beside`, the hooks of the settings files it loads. */
function session(hooks: Hooks, beside: Hooks = {}): FakeClaudeCode {
  const cc = new FakeClaudeCode(hooks, ROOT, beside);
  cc.files.set(`${ROOT}/notes.md`, 'old line\nmore\n');
  cc.web.set('https://example.com/docs', 'the docs page');
  return cc;
}

/** The query's hooks with the fence's in them. No settings file of this machine is read: only those the query names. */
const fenced = (query: { hooks?: Record<string, HookMatcherLike[]>; cwd?: string; settingSources?: string[] } = {}, log: (line: string) => void = () => {}): Hooks =>
  withFence({ settingSources: [], ...query }, { scratch: mkdtempSync(join(tmpdir(), 'shadowlap-fence-test-')), log, settings: { managedFile: null } }).hooks as unknown as Hooks;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A PreToolUse hook of the agent's own that marks every Bash command it is given, answering `delay` ms late. */
const marking = (delay: number): HookMatcherLike => ({
  matcher: 'Bash',
  hooks: [
    async (input: { tool_input: Record<string, unknown> }) => {
      await sleep(delay);
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input.tool_input, command: `${String(input.tool_input.command)} # checked` } } };
    },
  ],
});

/** The calls the model makes, as its recorded answers ask for them: the same on every replay. */
const SCRIPT: Array<[string, Record<string, unknown>]> = [
  ['Read', { file_path: `${ROOT}/notes.md` }],
  ['Bash', { command: 'echo hi > out.txt', description: 'write a file' }],
  ['Write', { file_path: `${ROOT}/report.md`, content: 'draft' }],
  ['Bash', { command: 'cd sub' }],
  ['Bash', { command: 'fail 3 tests failed' }],
  ['WebFetch', { url: 'https://example.com/docs', prompt: 'summarize' }],
  ['Edit', { file_path: `${ROOT}/notes.md`, old_string: 'old line', new_string: 'new line' }],
];

async function agent(cc: FakeClaudeCode, script = SCRIPT): Promise<{ results: ToolResult[]; notes: string[] }> {
  const results: ToolResult[] = [];
  for (const [i, [tool, input]] of script.entries()) results.push(await cc.call(tool, input, `toolu_${i}`));
  await cc.endBatch();
  await cc.stop();
  return { results, notes: [...cc.notes] };
}

function within(run: RunRecord): void {
  process.env.SHADOWLAP_URL = sidecar.url;
  process.env.SHADOWLAP_RUN_ID = run.runId;
}

const command = { argv: ['agent'], cwd: ROOT };

describe('the Claude Agent SDK fence', () => {
  let recording: RunRecord;
  let recorded: { results: ToolResult[]; notes: string[] };
  let recordedWorld: FakeClaudeCode;

  it('records each built-in tool with its effect, its output, and a failure as a failure', async () => {
    recording = sidecar.startRun({ mode: 'record', command });
    within(recording);
    recordedWorld = session(fenced());
    recorded = await agent(recordedWorld);
    sidecar.endRun(recording.runId, 'completed');

    // The tools really ran while recording.
    expect(recordedWorld.ran).toEqual(['echo hi > out.txt', 'cd sub', 'fail 3 tests failed']);
    expect(recordedWorld.files.get(`${ROOT}/report.md`)).toBe('draft');
    expect(recordedWorld.files.get(`${ROOT}/notes.md`)).toBe('new line\nmore\n');
    expect(recorded.results[4]).toEqual({ content: 'Exit code 3\ntests failed', is_error: true });
    expect(recorded.notes).toEqual([`# Environment update\n - Primary working directory: ${ROOT}/sub (was ${ROOT})`]);

    const calls = store.getCalls(recording.runId).filter((c) => c.kind === 'tool');
    expect(calls.map((c) => `${c.name}:${c.effect}:${c.end?.outcome}`)).toEqual(['Read:read:ok', 'Bash:write:ok', 'Write:write:ok', 'Bash:write:ok', 'Bash:write:error', 'WebFetch:read:ok', 'Edit:write:ok']);
    expect(store.getJson(calls[1].requestRef!)).toEqual({ args: { command: 'echo hi > out.txt', description: 'write a file' } });
    // Where `cd` left the shell is kept beside its output, for the replay to put it back.
    expect(store.getJson(calls[3].end!.responseRef!)).toMatchObject({ result: { stdout: '', shadowlapCwd: `${ROOT}/sub` } });
    expect(store.getJson(calls[4].end!.responseRef!)).toEqual({ error: { name: 'ToolError', message: 'Exit code 3\ntests failed', code: '3' } });
  });

  it('replays without running a write again: the model reads what it read, and the project is left as it was', async () => {
    const replay = sidecar.startRun({ mode: 'replay', parentRunId: recording.runId, command });
    within(replay);
    const cc = session(fenced());
    // The page and a file changed since: the model is still handed what it read when recording.
    cc.files.set(`${ROOT}/notes.md`, 'old line\nmore\nand a line added since\n');
    const replayed = await agent(cc);
    const { summary } = sidecar.endRun(replay.runId, 'completed');

    expect(replayed).toEqual(recorded);
    expect(summary.divergence).toBeNull();
    expect(summary.byOrigin.replayed).toBe(7);
    // No write reached the project: Bash ran only stand-ins, and Write and Edit wrote elsewhere.
    expect(cc.ran.every((c) => c === 'true' || c.startsWith('cd -- ') || c.startsWith("printf '%s'"))).toBe(true);
    expect(cc.ran).toHaveLength(3);
    expect(cc.files.has(`${ROOT}/out.txt`)).toBe(false);
    expect(cc.files.has(`${ROOT}/report.md`)).toBe(false);
    expect(cc.files.get(`${ROOT}/notes.md`)).toBe('old line\nmore\nand a line added since\n');
    // Reads ran as they are (the fetch, and its model call, happened); the model got the recorded output.
    expect(cc.askedModel).toBe(1);
  });

  it('refuses a write after a fork, with the refusal the model reads, and runs reads live', async () => {
    const fork = sidecar.startRun({ mode: 'replay', parentRunId: recording.runId, command });
    within(fork);
    const cc = session(fenced());
    const script = SCRIPT.map(([tool, input]): [string, Record<string, unknown>] => (input.command === 'echo hi > out.txt' ? [tool, { ...input, command: 'echo bye > out.txt' }] : [tool, input]));
    const { results } = await agent(cc, script);
    const { summary } = sidecar.endRun(fork.runId, 'completed');

    expect(summary.divergence?.name).toBe('Bash');
    expect(results[1].is_error).toBe(true);
    expect(results[1].content).toMatch(/^PreToolUse:Bash hook error: .*blocked/);
    // Every write after the fork was refused; none ran.
    expect(cc.ran).toEqual([]);
    expect([...cc.files.keys()].filter((f) => f.startsWith(ROOT))).toEqual([`${ROOT}/notes.md`]);
    expect(results.slice(2, 5).every((r) => r.is_error && r.content.startsWith('PreToolUse:'))).toBe(true);
    expect(summary.byOrigin.blocked).toBeGreaterThanOrEqual(3);
    // The read after the fork ran live and was recorded.
    expect(results[5]).toEqual(recorded.results[5]);
    const live = store.getCalls(fork.runId).filter((c) => c.origin === 'live').map((c) => c.name);
    expect(live).toContain('WebFetch');
  });

  it('stubs a write after a fork under --writes stub: a stand-in runs, and the model reads it as done', async () => {
    const fork = sidecar.startRun({ mode: 'replay', parentRunId: recording.runId, command, replay: { writes: 'stub' } });
    within(fork);
    const cc = session(fenced());
    const script = SCRIPT.map(([tool, input]): [string, Record<string, unknown>] => (input.command === 'echo hi > out.txt' ? [tool, { ...input, command: 'echo bye > out.txt' }] : [tool, input]));
    const { results } = await agent(cc, script);
    const { summary } = sidecar.endRun(fork.runId, 'completed');

    expect(results[1]).toEqual({ content: '(Bash completed with no output)', is_error: false });
    expect(results[2]).toEqual({ content: `File created successfully at: ${ROOT}/report.md`, is_error: false });
    expect(cc.files.has(`${ROOT}/out.txt`)).toBe(false);
    expect(cc.files.has(`${ROOT}/report.md`)).toBe(false);
    expect(summary.byOrigin.stubbed).toBeGreaterThanOrEqual(2);
    // What the model read is what the recording keeps, so a replay of the fork reads it too.
    const stubbed = store.getCalls(fork.runId).find((c) => c.origin === 'stubbed' && c.name === 'Write')!;
    expect(store.getJson(stubbed.end!.responseRef!)).toMatchObject({ result: { filePath: `${ROOT}/report.md` } });
  });

  it('refuses a write it can\'t record, where a hook that failed would have let it run', async () => {
    // Started under Shadowlap, but the sidecar is gone: this could be a replay, so no write runs.
    process.env.SHADOWLAP_URL = 'http://127.0.0.1:9/gone';
    process.env.SHADOWLAP_RUN_ID = 'run-gone';
    const cc = session(fenced());
    const write = await cc.call('Bash', { command: 'echo hi > out.txt' }, 'toolu_a');
    const read = await cc.call('Read', { file_path: `${ROOT}/notes.md` }, 'toolu_b');
    expect(write.content).toMatch(/^PreToolUse:Bash hook error: shadowlap: Bash was not run: it is a write, and it could not be recorded/);
    expect(cc.ran).toEqual([]);
    expect(read).toEqual({ content: 'old line\nmore\n', is_error: false });
  });

  it('changes nothing outside Shadowlap', async () => {
    const cc = session(fenced());
    const { results } = await agent(cc);
    expect(cc.ran).toEqual(['echo hi > out.txt', 'cd sub', 'fail 3 tests failed']);
    expect(results).toEqual(recorded.results);
  });

  it('ends a call a permission refused after its hook ran, so the recording has no hole', async () => {
    const run = sidecar.startRun({ mode: 'record', command });
    within(run);
    const cc = session(fenced());
    const refused = await cc.call('Write', { file_path: '/etc/hosts', content: 'x' }, 'toolu_r');
    await cc.endBatch();
    sidecar.endRun(run.runId, 'completed');
    expect(refused).toEqual({ content: "Claude requested permissions to use Write, but you haven't granted it yet.", is_error: true });
    const [call] = store.getCalls(run.runId).filter((c) => c.kind === 'tool');
    expect(call.end?.outcome).toBe('error');
    expect(store.getJson(call.end!.responseRef!)).toMatchObject({ error: { name: 'NotRun' } });
  });

  it('forks safely where Claude Code checks a call against a file a fenced write never made', async () => {
    const script: Array<[string, Record<string, unknown>]> = [
      ['Write', { file_path: `${ROOT}/new.md`, content: 'alpha' }],
      ['Edit', { file_path: `${ROOT}/new.md`, old_string: 'alpha', new_string: 'beta' }],
    ];
    const rec = sidecar.startRun({ mode: 'record', command });
    within(rec);
    const first = await agent(session(fenced()), script);
    sidecar.endRun(rec.runId, 'completed');
    expect(first.results[1].is_error).toBe(false);

    const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command });
    within(rep);
    const cc = session(fenced());
    const again = await agent(cc, script);
    const { summary } = sidecar.endRun(rep.runId, 'completed');
    // Claude Code refuses the Edit before any hook hears of it: the file was never written. The
    // model reads something else (the replay forks), and nothing reached the project.
    expect(again.results[1]).toEqual({ content: '<tool_use_error>File does not exist.</tool_use_error>', is_error: true });
    expect(summary.divergence).not.toBeNull();
    expect(cc.files.has(`${ROOT}/new.md`)).toBe(false);
  });

  it('matches only the tools it records, by an exact list', () => {
    const { PreToolUse } = fenceHooks();
    const matcher = PreToolUse[0].matcher;
    expect(Object.keys(BUILT_IN_EFFECTS).every((t) => matches(matcher, t))).toBe(true);
    expect(['BashOutput', 'TodoWrite', 'Agent', 'mcp__orders__lookup_order'].some((t) => matches(matcher, t))).toBe(false);
    expect(matches(fenceHooks({ effects: { mcp__issues__search: 'read' } }).PreToolUse[0].matcher, 'mcp__issues__search')).toBe(true);
  });

  it('runs the query\'s own PreToolUse and PostToolUse hooks inside its own, and keeps the rest beside them', () => {
    const mine = { matcher: 'Bash', hooks: [async () => ({})] };
    const stop = { hooks: [async () => ({})] };
    const options = withFence({ cwd: ROOT, hooks: { PreToolUse: [mine], PostToolUse: [{ ...mine, timeout: 900 }], Stop: [stop] } });
    expect(options.cwd).toBe(ROOT);
    // One PreToolUse hook, the fence's, which picks every tool: the query's may pick any.
    expect(options.hooks.PreToolUse).toHaveLength(1);
    expect(options.hooks.PreToolUse[0]).not.toBe(mine);
    expect((options.hooks.PreToolUse[0] as { matcher?: string }).matcher).toBeUndefined();
    // It waits as long as the longest of theirs.
    expect((options.hooks.PostToolUse[0] as { timeout?: number }).timeout).toBe(900);
    expect(options.hooks.Stop[0]).toBe(stop);
    expect(options.hooks.Stop).toHaveLength(2);
    expect(Object.keys(options.hooks).sort()).toEqual(['PostToolBatch', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'Stop', 'SubagentStop']);
  });

  it('picks the tools Claude Code picks, by its matcher rules', () => {
    for (const [matcher, tool] of [[undefined, 'Bash'], ['', 'Bash'], ['*', 'Write'], ['Bash', 'Bash'], ['Bash', 'BashOutput'], ['Edit|Write', 'Write'], ['Edit, Write', 'Edit'], ['Edit.*', 'NotebookEdit'], ['^Edit$', 'NotebookEdit'], ['mcp__kb__.*', 'mcp__kb__search'], ['Notebook', 'NotebookEdit']] as const) {
      expect(matcherPicks(matcher, tool), `${String(matcher)} on ${tool}`).toBe(matches(matcher, tool));
    }
    // One that doesn't compile picks nothing, or every tool for a caller that must not miss one.
    expect(matcherPicks('(', 'Bash')).toBe(false);
    expect(matcherPicks('(', 'Bash', 'all')).toBe(true);
  });
});

describe('the fence beside other hooks', () => {
  const SCRIPT_BASH: Array<[string, Record<string, unknown>]> = [['Bash', { command: 'echo hi > out.txt' }]];

  /** A recording of one Bash call, made with these hooks. */
  async function recorded(hooks: Hooks, script = SCRIPT_BASH): Promise<{ run: RunRecord; cc: FakeClaudeCode }> {
    const run = sidecar.startRun({ mode: 'record', command });
    within(run);
    const cc = session(hooks);
    await agent(cc, script);
    sidecar.endRun(run.runId, 'completed');
    return { run, cc };
  }

  // Claude Code takes the rewrite of whichever hook answers last: a hook of the agent's own that
  // answered after the fence put the recorded command back, and the replay ran it for real.
  it.each([0, 150])('runs a PreToolUse hook of the query first, answering %ims late, so a replay never runs the write', async (delay) => {
    const { run, cc } = await recorded(fenced({ hooks: { PreToolUse: [marking(delay)] } }));
    // While recording the call runs as the hook rewrote it, and is recorded so.
    expect(cc.ran).toEqual(['echo hi > out.txt # checked']);
    const [call] = store.getCalls(run.runId).filter((c) => c.kind === 'tool');
    expect(store.getJson(call.requestRef!)).toEqual({ args: { command: 'echo hi > out.txt # checked' } });

    const replay = sidecar.startRun({ mode: 'replay', parentRunId: run.runId, command });
    within(replay);
    const again = session(fenced({ hooks: { PreToolUse: [marking(delay)] } }));
    const { results } = await agent(again, SCRIPT_BASH);
    const { summary } = sidecar.endRun(replay.runId, 'completed');
    expect(again.ran).toEqual(['true']);
    expect(summary.divergence).toBeNull();
    expect(results[0]).toEqual({ content: 'ran: echo hi > out.txt # checked', is_error: false });
  });

  it('blocks a call whose PreToolUse hook does not answer within its timeout, as Claude Code does', async () => {
    const run = sidecar.startRun({ mode: 'record', command });
    within(run);
    const slow: HookMatcherLike = { matcher: 'Bash', timeout: 0.05, hooks: [async () => (await sleep(5_000), {})] };
    const cc = session(fenced({ hooks: { PreToolUse: [slow] } }));
    const { results } = await agent(cc, SCRIPT_BASH);
    sidecar.endRun(run.runId, 'completed');
    expect(cc.ran).toEqual([]);
    expect(results[0]).toEqual({ content: 'PreToolUse:Bash hook error: a PreToolUse hook did not answer within its timeout of 0.05 seconds', is_error: true });
  });

  it("keeps a refusal of the query's own: the call never runs, and nothing is recorded", async () => {
    const refusing: HookMatcherLike = { matcher: 'Bash', hooks: [async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no shell here' } })] };
    const { run, cc } = await recorded(fenced({ hooks: { PreToolUse: [refusing] } }));
    expect(cc.ran).toEqual([]);
    expect(store.getCalls(run.runId).filter((c) => c.kind === 'tool')).toEqual([]);
  });

  it('runs a PostToolUse hook of the query on the recorded output, as it ran on the live one', async () => {
    // It marks what the model reads; answering late, beside the fence it replaced the recorded output with its mark of the stand-in's.
    const noting: HookMatcherLike = {
      matcher: 'Bash',
      hooks: [
        async (input: { tool_response: { stdout: string } }) => {
          await sleep(150);
          return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { ...input.tool_response, stdout: `${input.tool_response.stdout} (noted)` } } };
        },
      ],
    };
    const listing: Array<[string, Record<string, unknown>]> = [['Bash', { command: 'ls' }]];
    const { run } = await recorded(fenced({ hooks: { PostToolUse: [noting] } }), listing);
    const replay = sidecar.startRun({ mode: 'replay', parentRunId: run.runId, command });
    within(replay);
    const cc = session(fenced({ hooks: { PostToolUse: [noting] } }));
    const { results } = await agent(cc, listing);
    sidecar.endRun(replay.runId, 'completed');
    expect(cc.ran).toEqual(['true']);
    expect(results[0]).toEqual({ content: 'ran: ls (noted)', is_error: false });
  });

  it("refuses a recorded write that a settings file's PreToolUse hook could rewrite, and names the file", async () => {
    const { run } = await recorded(fenced());
    const project = mkdtempSync(join(tmpdir(), 'shadowlap-settings-'));
    try {
      mkdirSync(join(project, '.claude'));
      const file = join(project, '.claude', 'settings.json');
      writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './mark.sh' }] }] } }));
      const replay = sidecar.startRun({ mode: 'replay', parentRunId: run.runId, command });
      within(replay);
      const said: string[] = [];
      // Claude Code runs the file's hook beside the fence, and its rewrite answers last.
      const cc = session(fenced({ cwd: project, settingSources: ['project'] }, (l) => said.push(l)), { PreToolUse: [marking(150)] as unknown as Hooks['PreToolUse'] });
      const { results } = await agent(cc, SCRIPT_BASH);
      sidecar.endRun(replay.runId, 'completed');
      expect(cc.ran).toEqual([]);
      expect(results[0].is_error).toBe(true);
      expect(results[0].content).toContain(`shadowlap: Bash was not run again: a PreToolUse hook in ${file} (matcher "Bash") runs beside Shadowlap's`);
      expect(said.join('\n')).toContain(file);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('stops the session when a hook it never saw replaced its stand-in, and hands the model no recording', async () => {
    const { run } = await recorded(fenced());
    const replay = sidecar.startRun({ mode: 'replay', parentRunId: run.runId, command });
    within(replay);
    const said: string[] = [];
    // A plugin's or a managed hook: in no file the fence reads, and answering last.
    const cc = session(fenced({}, (l) => said.push(l)), { PreToolUse: [marking(150)] as unknown as Hooks['PreToolUse'] });
    const { results } = await agent(cc, [...SCRIPT_BASH, ['Bash', { command: 'echo bye > out.txt' }]]);
    sidecar.endRun(replay.runId, 'completed');
    // The write ran, which the fence could not stop; the model reads what it did, not the recording, and nothing runs after it.
    expect(cc.ran).toEqual(['echo hi > out.txt # checked']);
    expect(results[0]).toEqual({ content: 'ran: echo hi > out.txt # checked', is_error: false });
    expect(cc.stopReason).toMatch(/^shadowlap: another PreToolUse hook replaced the stand-in Shadowlap gave Bash, so Claude Code ran the call itself \(command: "echo hi > out.txt # checked"\)/);
    expect(results[1]).toEqual({ content: `the session was stopped: ${cc.stopReason}`, is_error: true });
    expect(said.join('\n')).toContain('another PreToolUse hook replaced the stand-in');
  });
});

describe('tools of an in-process MCP server', () => {
  const ran: string[] = [];
  const lookup = { name: 'lookup_order', description: 'Look up an order', inputSchema: {}, handler: async (args: { id: string }) => (ran.push(`lookup ${args.id}`), { content: [{ type: 'text', text: `order ${args.id}: shipped` }] }) };
  const refund = { name: 'issue_refund', description: 'Refund an order', inputSchema: {}, handler: async (args: { id: string }) => (ran.push(`refund ${args.id}`), { content: [{ type: 'text', text: `refunded ${args.id}` }] }) };
  const tools = withEffects('orders', [lookup, refund], { lookup_order: 'read', issue_refund: 'write' });

  it('records them under the names the model calls them by, and replays them without running', async () => {
    const rec = sidecar.startRun({ mode: 'record', command });
    within(rec);
    expect(await tools[0].handler({ id: 'A-1' })).toEqual({ content: [{ type: 'text', text: 'order A-1: shipped' }] });
    await tools[1].handler({ id: 'A-1' });
    sidecar.endRun(rec.runId, 'completed');
    expect(store.getCalls(rec.runId).map((c) => `${c.name}:${c.effect}`)).toEqual(['mcp__orders__lookup_order:read', 'mcp__orders__issue_refund:write']);
    expect(ran).toEqual(['lookup A-1', 'refund A-1']);

    const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command });
    within(rep);
    expect(await tools[0].handler({ id: 'A-1' })).toEqual({ content: [{ type: 'text', text: 'order A-1: shipped' }] });
    expect(await tools[1].handler({ id: 'A-1' })).toEqual({ content: [{ type: 'text', text: 'refunded A-1' }] });
    expect(sidecar.endRun(rep.runId, 'completed').summary.divergence).toBeNull();
    expect(ran).toHaveLength(2);

    // After a fork the write answers as a tool that failed, which the model reads, and never runs.
    const fork = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command });
    within(fork);
    await tools[0].handler({ id: 'B-2' });
    const refused = (await tools[1].handler({ id: 'B-2' })) as { isError?: boolean; content: Array<{ text: string }> };
    sidecar.endRun(fork.runId, 'completed');
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/blocked/);
    expect(ran).toEqual(['lookup A-1', 'refund A-1', 'lookup B-2']);
  });

  it('needs an effect for every tool', () => {
    expect(() => withEffects('orders', [lookup, refund], { lookup_order: 'read' })).toThrow(/missing for issue_refund/);
  });
});
