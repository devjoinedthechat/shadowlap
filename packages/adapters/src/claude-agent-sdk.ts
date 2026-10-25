import { completeToolCall, resolveToolCall, ShadowlapInjectedFailure, ShadowlapWriteBlocked, type Effect, type Resolution } from '@shadowlap/sdk';
import { asOutput, combine, matcherPicks, runHooks, settingsPreToolUse, type HookMatcherLike, type SettingsHook, type SettingsPlaces } from './claude-hooks.js';
import { toOptions, wrapFirstArg, type EffectSpec } from './core.js';

/**
 * Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), and Claude Code headless underneath it.
 *
 * Its built-in tools (Bash, Write, Edit, Read, WebFetch, …) run inside the Claude Code process, where
 * no wrapper reaches them, so they are recorded and fenced through the SDK's hooks instead:
 *
 *   import { query } from '@anthropic-ai/claude-agent-sdk';
 *   import { withFence } from '@shadowlap/adapters/claude-agent-sdk';
 *
 *   for await (const message of query({ prompt, options: withFence({ cwd, allowedTools }) })) …
 *
 * - While recording, PostToolUse records each built-in tool's input and output through the sidecar,
 *   and PostToolUseFailure its failure.
 * - On replay, a recorded write never runs again: PreToolUse turns its input into a stand-in Claude
 *   Code accepts and that changes nothing outside a temporary folder (Bash runs `true`, or `cd` to
 *   the folder the command left, Write and Edit write a new file there), and PostToolUse hands the
 *   model the recorded output in its place (`updatedToolOutput`). A recorded Bash failure is
 *   reproduced by a command that prints its output and exits with its code. A read runs as it is,
 *   since reading changes nothing and keeps Claude Code's own file tracking as it was recorded, and
 *   the model gets the recorded output too.
 * - After a fork, a write is refused per `--writes`: `block` denies it with the refusal the model
 *   reads, `stub` runs the stand-in and answers with `onFork`'s output.
 *
 * Without Shadowlap (no SHADOWLAP_URL) every hook answers `{}`, and Claude Code runs as it would.
 * Claude Code checks a call's input against the files on disk before any hook runs, so a replay
 * forks, safely, at a call that depends on a file an earlier, fenced write would have changed: see
 * docs/frameworks.md for this and the other limits.
 *
 * Tools of an in-process MCP server (`createSdkMcpServer`) run in the agent's own process: wrap
 * them with `withEffects`, which records and fences them like any SDK tool.
 */

/** Claude Code's built-in tools that are recorded, with their effects. */
export const BUILT_IN_EFFECTS: Readonly<Record<string, Effect>> = Object.freeze({
  Read: 'read',
  Glob: 'read',
  Grep: 'read',
  WebFetch: 'read',
  WebSearch: 'read',
  Write: 'write',
  Edit: 'write',
  MultiEdit: 'write',
  NotebookEdit: 'write',
  Bash: 'write',
});

/** The fields of a hook's input the fence reads; every hook input the SDK passes has this shape. */
export interface HookInputLike {
  hook_event_name: string;
  tool_name?: unknown;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: unknown;
  cwd?: unknown;
  error?: unknown;
  is_interrupt?: unknown;
  agent_id?: unknown;
}

/** What a fence hook answers Claude Code: `{}`, or the fields of a hook's JSON output. */
export type FenceOutput = Record<string, unknown>;

export type FenceHook = (input: HookInputLike, toolUseID: string | undefined, options: { signal?: AbortSignal }) => Promise<FenceOutput>;

export interface FenceMatcher {
  matcher?: string;
  hooks: FenceHook[];
  timeout?: number;
}

export type { HookMatcherLike, SettingsPlaces } from './claude-hooks.js';

export interface FenceOptions {
  /**
   * More tools to record, or other effects for the built-ins, by the name Claude Code calls them
   * (`mcp__issues__search` for a tool of an MCP server it connects to). A read runs as it is and the
   * model gets the recorded output; a write of a tool with no stand-in is refused on replay.
   */
  effects?: Record<string, Effect>;
  /**
   * What the model gets for a write stubbed after a fork (`--writes stub`), in the tool's own output
   * shape: Claude Code ignores an output that isn't. Default: the stand-in's output, with the
   * original path where it names the temporary one.
   */
  onFork?: (tool: string, input: Record<string, unknown>, standInOutput: unknown) => unknown;
  /** Where stand-ins write. Default: a new folder in the system's temporary folder. */
  scratch?: string;
  /** Where the fence says what it couldn't do. Default: standard error. */
  log?: (line: string) => void;
  /**
   * The query's own PreToolUse and PostToolUse hooks, run inside the fence's (withFence passes the
   * query's). Claude Code takes a rewritten input or output from whichever hook answers last, so a
   * hook beside the fence could put back the input of a recorded write, and the write would run
   * again for real. Inside, they answer first, in the order given, and the fence has the last word.
   */
  hooks?: { PreToolUse?: readonly HookMatcherLike[]; PostToolUse?: readonly HookMatcherLike[] };
  /**
   * Where Claude Code finds the settings it loads for the query (withFence passes its
   * `settingSources`, `cwd`, `settings`, `managedSettings` and `env`). A PreToolUse hook in them runs
   * beside the fence, where nothing can run it inside: a recorded write it could rewrite is refused
   * on replay rather than handed a stand-in. Default: all three sources, in the session's folder.
   */
  settings?: SettingsPlaces;
}

/** A recorded Bash call that moved the shell's working folder keeps where it left it here, beside its output. */
const CWD = 'shadowlapCwd';

/**
 * A call between its PreToolUse and its end. `input` is what the call was asked to run with, the
 * query's own hooks' rewrite included; `standIn` what the fence ran in its place, when it did.
 */
type Pending =
  | { kind: 'live'; callNo: number; name: string; effect: Effect; started: number; agent: string; cwd: unknown; input: Record<string, unknown> }
  | { kind: 'stubbed'; callNo: number; name: string; started: number; agent: string; input: Record<string, unknown>; standIn: Record<string, unknown> }
  | { kind: 'replayed'; name: string; agent: string; output: unknown; input: Record<string, unknown>; standIn: Record<string, unknown> | null }
  | { kind: 'failure'; name: string; agent: string; input: Record<string, unknown>; standIn: Record<string, unknown> };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A shell word that the shell takes as it is. */
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The exit code and the rest of a recorded Bash failure, as Claude Code writes one: `Exit code N`, then the output. */
function bashFailure(error: string): { code: number; rest: string } | null {
  const m = /^Exit code (\d{1,3})(?:\n([\s\S]*))?$/.exec(error);
  const code = m ? Number(m[1]) : NaN;
  return m && code > 0 && code < 256 ? { code, rest: m[2] ?? '' } : null;
}

/** The field of a tool's input that says what it acts on: Bash's command, the file a write writes. */
const ACTS_ON: Readonly<Record<string, string>> = { Bash: 'command', Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };

/**
 * Whether the call Claude Code ran is another than the stand-in the fence gave it: what it acts on
 * differs (another hook's rewrite came last). An input Claude Code doesn't show says nothing.
 */
function ranOther(name: string, ran: unknown, standIn: Record<string, unknown>): boolean {
  if (!isRecord(ran)) return false;
  const field = ACTS_ON[name];
  return field ? ran[field] !== standIn[field] : JSON.stringify(ran) !== JSON.stringify(standIn);
}

interface Scratch {
  dir: string;
  /** A path that doesn't exist yet, for a stand-in to create. */
  fresh(name: string): string;
  write(name: string, content: string): string;
}

async function makeScratch(dir: string | undefined): Promise<Scratch> {
  const load = (name: string): Promise<unknown> => import(/* webpackIgnore: true */ /* @vite-ignore */ name);
  const fs = (await load('node:fs')) as typeof import('node:fs');
  const os = (await load('node:os')) as typeof import('node:os');
  const path = (await load('node:path')) as typeof import('node:path');
  const base = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'shadowlap-fence-'));
  fs.mkdirSync(base, { recursive: true });
  let n = 0;
  // Plain names: Claude Code refuses writes to files such as .bashrc or folders such as .git, even when a hook allows them.
  const fresh = (name: string) => path.join(base, `${++n}-${name.replace(/[^\w-]/g, '_').slice(0, 60) || 'call'}.txt`);
  return {
    dir: base,
    fresh,
    write: (name, content) => {
      const file = fresh(name);
      fs.writeFileSync(file, content);
      return file;
    },
  };
}

/** The longest timeout of the query's matchers, when it is longer than the SDK's default: the fence's hook waits for theirs. */
function longest(matchers: readonly HookMatcherLike[] | undefined): number | undefined {
  const most = Math.max(0, ...(matchers ?? []).map((m) => (typeof m.timeout === 'number' ? m.timeout : 0)));
  return most > 600 ? most : undefined;
}

/**
 * The hooks that record and fence Claude Code's built-in tools: PreToolUse, PostToolUse,
 * PostToolUseFailure, and PostToolBatch and Stop, which end a call Claude Code never ran (a
 * permission refused it after PreToolUse). Use `withFence`, which runs the query's own PreToolUse and
 * PostToolUse hooks inside these; merged into the query's `hooks` by hand, pass those as `hooks`.
 */
export function fenceHooks(o: FenceOptions = {}): Record<'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'PostToolBatch' | 'Stop' | 'SubagentStop', FenceMatcher[]> {
  const effects: Record<string, Effect> = { ...BUILT_IN_EFFECTS, ...o.effects };
  const log = o.log ?? ((line: string) => process.stderr.write(`[shadowlap] ${line}\n`));
  const pending = new Map<string, Pending>();
  let scratch: Promise<Scratch> | undefined;
  const scratchDir = () => (scratch ??= makeScratch(o.scratch));
  /** The folder the session started in, where Claude Code reads the project's settings: the first hook's, unless withFence said. */
  let projectDir: string | null = o.settings?.cwd ?? null;
  const said = new Set<string>();
  const once = (key: string, line: string) => {
    if (said.has(key)) return;
    said.add(key);
    log(line);
  };

  const allow = (updatedInput: Record<string, unknown>, why: string): FenceOutput => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: why, updatedInput } });
  const deny = (reason: string): FenceOutput => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

  /** The harmless call that runs in place of a recorded write, as Claude Code accepts it; null where there is none. */
  async function standIn(name: string, input: Record<string, unknown>, recorded: unknown): Promise<Record<string, unknown> | null> {
    switch (name) {
      case 'Bash': {
        const cwd = isRecord(recorded) ? text(recorded[CWD]) : '';
        // Only what Claude Code tracks of a command: where it left the shell.
        return { ...input, command: cwd ? `cd -- ${shellQuote(cwd)} 2>/dev/null || true` : 'true', run_in_background: false };
      }
      case 'Write':
        return { file_path: (await scratchDir()).fresh('write'), content: '' };
      case 'Edit':
        // An edit with nothing to find creates a new file: the only edit Claude Code takes on a file nobody read.
        return { file_path: (await scratchDir()).fresh('edit'), old_string: '', new_string: '.' };
      case 'MultiEdit':
        return { file_path: (await scratchDir()).fresh('edit'), edits: [{ old_string: '', new_string: '.' }] };
      default:
        return null;
    }
  }

  /** A recorded Bash failure, reproduced: the same output, the same exit code. */
  async function failingBash(input: Record<string, unknown>, failure: { code: number; rest: string }): Promise<Record<string, unknown>> {
    const printed = failure.rest.length > 16_000 || failure.rest.includes('\0') ? `cat -- ${shellQuote((await scratchDir()).write('output', failure.rest))}` : `printf '%s' ${shellQuote(failure.rest)}`;
    return { ...input, command: `${printed}; exit ${failure.code}`, run_in_background: false };
  }

  /** The output a stubbed write answers with: the stand-in's, naming the original path rather than the temporary one. */
  function stubOutput(name: string, input: Record<string, unknown>, output: unknown): unknown {
    if (o.onFork) return o.onFork(name, input, output);
    if (isRecord(output) && typeof output.filePath === 'string' && typeof input.file_path === 'string') return { ...output, filePath: input.file_path };
    return output;
  }

  /** A PreToolUse hook of the settings Claude Code loads that picks `name`, or null: it runs beside the fence. */
  async function besides(name: string): Promise<SettingsHook | null> {
    const hooks = await settingsPreToolUse(o.settings ?? {}, projectDir ?? process.cwd());
    return hooks.find((h) => matcherPicks(h.matcher, name, 'all')) ?? null;
  }
  const where = (h: SettingsHook) => `a PreToolUse hook in ${h.source}${h.matcher !== undefined ? ` (matcher "${h.matcher}")` : ''}`;

  /**
   * A write the fence would hand a stand-in, refused instead when a settings file's hook could
   * rewrite its input after the fence: the recorded write would run again for real.
   */
  async function standInOrRefuse(name: string, stand: Record<string, unknown>, why: string): Promise<FenceOutput> {
    const beside = await besides(name);
    if (!beside) return allow(stand, why);
    const reason = `shadowlap: ${name} was not run again: ${where(beside)} runs beside Shadowlap's, and Claude Code takes the input from whichever hook answers last, so it could run the recorded ${name} again for real. The replay forks here. Give that hook to the query in its hooks option, where withFence runs it inside the fence, or leave that settings file out of settingSources for this agent.`;
    once(`beside:${name}`, reason);
    return deny(reason);
  }

  /** The fence's own answer to a call, from the input the call would run with (the query's hooks' rewrite included). */
  async function fence(input: HookInputLike, id: string, args: Record<string, unknown>): Promise<FenceOutput> {
    const name = text(input.tool_name);
    const effect = effects[name]!;
    const agent = text(input.agent_id);
    try {
      const r: Resolution | null = await resolveToolCall({ name, effect, args });
      if (r === null) return {};
      switch (r.origin) {
        case 'live':
          pending.set(id, { kind: 'live', callNo: r.callNo, name, effect, started: Date.now(), agent, cwd: input.cwd, input: args });
          // Recorded as it runs; a replay of it will meet the same settings hook, and refuse it.
          if (effect === 'write') {
            const beside = await besides(name);
            if (beside) once(`record:${name}`, `${where(beside)} runs beside Shadowlap's for ${name}: a replay of this run refuses ${name} rather than let that hook run it again for real. Give the hook to the query in its hooks option, where withFence runs it inside the fence.`);
          }
          return {};
        case 'blocked':
          return deny(r.error.message);
        case 'stubbed': {
          const stand = await standIn(name, args, undefined);
          if (!stand) {
            await completeToolCall(r.callNo, { outcome: 'error', error: { name: 'ShadowlapWriteBlocked', message: `${name} has no stand-in Claude Code takes, so it was refused instead of stubbed` } });
            return deny(`${name} was not run: write tools are stubbed after the fork (shadowlap replay --writes stub), and ${name} can't be.`);
          }
          const out = await standInOrRefuse(name, stand, 'shadowlap: a write stubbed after the fork');
          if (isRecord(out.hookSpecificOutput) && out.hookSpecificOutput.permissionDecision === 'deny') {
            await completeToolCall(r.callNo, { outcome: 'error', error: { name: 'ShadowlapWriteBlocked', message: String(out.hookSpecificOutput.permissionDecisionReason) } });
            return out;
          }
          pending.set(id, { kind: 'stubbed', callNo: r.callNo, name, started: Date.now(), agent, input: args, standIn: stand });
          return out;
        }
        case 'replayed': {
          if (r.outcome === 'ok') {
            const output = isRecord(r.result) && CWD in r.result ? Object.fromEntries(Object.entries(r.result).filter(([k]) => k !== CWD)) : r.result;
            if (effect !== 'write') {
              // A read runs as it is; the model gets the recorded output.
              pending.set(id, { kind: 'replayed', name, agent, output, input: args, standIn: null });
              return {};
            }
            const stand = await standIn(name, args, r.result);
            if (!stand) return deny(`shadowlap: ${name} was not run again on replay: it is a write, and it has no stand-in Claude Code takes. The replay forks here.`);
            const out = await standInOrRefuse(name, stand, 'shadowlap: a recorded call, replayed');
            if (!isRecord(out.hookSpecificOutput) || out.hookSpecificOutput.permissionDecision !== 'deny') pending.set(id, { kind: 'replayed', name, agent, output, input: args, standIn: stand });
            return out;
          }
          if (r.injected) return deny(r.error.message);
          if (effect !== 'write') return {}; // a read that failed: it runs, and fails as it did
          const failure = name === 'Bash' ? bashFailure(r.error.message) : null;
          if (failure) {
            const stand = await failingBash(args, failure);
            const out = await standInOrRefuse(name, stand, 'shadowlap: a recorded failure, replayed');
            if (!isRecord(out.hookSpecificOutput) || out.hookSpecificOutput.permissionDecision !== 'deny') pending.set(id, { kind: 'failure', name, agent, input: args, standIn: stand });
            return out;
          }
          return deny(r.error.message);
        }
        default:
          return deny(`shadowlap: the sidecar answered ${name} with an unknown origin; it was not run`);
      }
    } catch (err) {
      // A hook that throws lets the tool run unchanged, so nothing may escape: a write that can't be
      // recorded is refused (this could be a replay), and a read runs unrecorded.
      log(`could not record ${name}: ${message(err)}`);
      return effect === 'write' ? deny(`shadowlap: ${name} was not run: it is a write, and it could not be recorded (${message(err)}). A write never runs unrecorded under Shadowlap, since this may be a replay.`) : {};
    }
  }

  const pre: FenceHook = async (input, toolUseID, options) => {
    projectDir ??= text(input.cwd) || null;
    const name = text(input.tool_name);
    // The query's own hooks first, as Claude Code would run them: a refusal of theirs stands, and
    // nothing runs, so nothing is recorded or fenced; a rewrite of theirs is what the call runs with.
    const own = combine(await runHooks(o.hooks?.PreToolUse, name, input, toolUseID, options?.signal), 'PreToolUse');
    if (own.decision === 'deny' || own.decision === 'defer' || !effects[name]) return asOutput(own, 'PreToolUse');
    const args = own.updatedInput ?? (isRecord(input.tool_input) ? input.tool_input : {});
    const out = await fence({ ...input, tool_input: args }, toolUseID ?? text(input.tool_use_id), args);
    const mine = isRecord(out.hookSpecificOutput) ? out.hookSpecificOutput : null;
    if (!mine) return asOutput(own, 'PreToolUse');
    // The fence has the last word on the input; the more restrictive decision stands, a person's ask over its allow.
    const decision = mine.permissionDecision === 'deny' ? 'deny' : own.decision === 'ask' ? 'ask' : 'allow';
    const reason = decision === own.decision && own.reason !== undefined ? own.reason : String(mine.permissionDecisionReason);
    const { updatedInput: _theirs, ...rest } = own;
    return asOutput({ ...rest, decision, reason, ...(isRecord(mine.updatedInput) ? { updatedInput: mine.updatedInput } : {}) }, 'PreToolUse');
  };

  /**
   * Another hook's rewrite came after the fence's stand-in, so Claude Code ran the call itself: a
   * recorded write ran again for real. The model is not handed the recording as if nothing happened,
   * a stubbed call is not kept as stubbed, and the session stops there.
   */
  async function lost(p: Exclude<Pending, { kind: 'live' }>, ran: unknown): Promise<FenceOutput> {
    const field = ACTS_ON[p.name];
    const what = field && isRecord(ran) ? ` (${field}: ${JSON.stringify(ran[field])})` : '';
    const line = `shadowlap: another PreToolUse hook replaced the stand-in Shadowlap gave ${p.name}, so Claude Code ran the call itself${what}: on a replay, that is the recorded call run again for real. The session stops here. A hook the fence doesn't run did it, one in a settings file, a plugin or managed settings: see Claude Agent SDK in docs/frameworks.md.`;
    log(line);
    if (p.kind === 'stubbed') await completeToolCall(p.callNo, { outcome: 'error', error: { name: 'ShadowlapFenceLost', message: line } }).catch((err: unknown) => log(`could not record that ${p.name} ran: ${message(err)}`));
    return { continue: false, stopReason: line, systemMessage: line };
  }

  const post: FenceHook = async (input, toolUseID, options) => {
    const id = toolUseID ?? text(input.tool_use_id);
    const name = text(input.tool_name);
    const p = pending.get(id);
    pending.delete(id);
    /** The query's own PostToolUse hooks, on what the model is to read, as they ran on it when it was recorded. */
    const theirs = async (seen: { input: Record<string, unknown>; response: unknown } | null, mine: { value: unknown } | null): Promise<FenceOutput> => {
      const given = seen ? { ...input, tool_input: seen.input, tool_response: seen.response } : input;
      const own = combine(await runHooks(o.hooks?.PostToolUse, name, given, toolUseID, options?.signal), 'PostToolUse');
      return asOutput(own.output || !mine ? own : { ...own, output: mine }, 'PostToolUse');
    };
    if (!p) return theirs(null, null);
    try {
      if (p.kind !== 'live' && p.standIn && ranOther(p.name, input.tool_input, p.standIn)) return await lost(p, input.tool_input);
      switch (p.kind) {
        case 'replayed':
          return await theirs({ input: p.input, response: p.output }, { value: p.output });
        case 'failure':
          log(`the replayed failure of ${p.name} ran without failing; the replay forks here`);
          return await theirs(null, null);
        case 'live': {
          const output = input.tool_response;
          // Where a command left the shell is part of what the model sees next: kept for the replay's stand-in.
          const moved = p.name === 'Bash' && typeof input.cwd === 'string' && typeof p.cwd === 'string' && input.cwd !== p.cwd;
          await completeToolCall(p.callNo, { outcome: 'ok', result: moved && isRecord(output) ? { ...output, [CWD]: input.cwd } : (output ?? null), latencyMs: Date.now() - p.started });
          return await theirs(null, null);
        }
        case 'stubbed': {
          const output = stubOutput(p.name, p.input, input.tool_response);
          await completeToolCall(p.callNo, { outcome: 'ok', result: output ?? null, latencyMs: 0 });
          return await theirs({ input: p.input, response: output }, { value: output });
        }
      }
    } catch (err) {
      log(`could not record the result of ${p.name}: ${message(err)}`);
      return {};
    }
  };

  const failed: FenceHook = async (input, toolUseID) => {
    const id = toolUseID ?? text(input.tool_use_id);
    const p = pending.get(id);
    if (!p) return {};
    pending.delete(id);
    try {
      if (p.kind !== 'live' && p.standIn && ranOther(p.name, input.tool_input, p.standIn)) return await lost(p, input.tool_input);
      if (p.kind === 'live' || p.kind === 'stubbed') {
        const error = text(input.error) || 'the tool failed';
        const code = /^Exit code (\d+)/.exec(error)?.[1];
        await completeToolCall(p.callNo, {
          outcome: 'error',
          error: { name: 'ToolError', message: error, ...(code ? { code } : {}), ...(input.is_interrupt === true ? { data: { interrupted: true } } : {}) },
          latencyMs: Date.now() - p.started,
        });
      } else if (p.kind === 'replayed') log(`the stand-in for ${p.name} failed; the replay forks here`);
    } catch (err) {
      log(`could not record the failure of ${p.name}: ${message(err)}`);
    }
    return {};
  };

  /** Calls PreToolUse saw that never ran (a permission refused them): ended, so the recording has no hole. */
  const settle: FenceHook = async (input) => {
    const agent = text(input.agent_id);
    for (const [id, p] of [...pending]) {
      if (p.agent !== agent) continue;
      pending.delete(id);
      if (p.kind !== 'live' && p.kind !== 'stubbed') continue;
      await completeToolCall(p.callNo, { outcome: 'error', error: { name: 'NotRun', message: `Claude Code did not run ${p.name}: a permission rule, canUseTool or a person refused it` } }).catch((err: unknown) => log(`could not record that ${p.name} did not run: ${message(err)}`));
    }
    return {};
  };

  const names = Object.keys(effects);
  // An exact list (letters, digits, _ and -), which Claude Code compares name by name; the hooks
  // check the name again. With the query's own hooks inside, every tool: theirs may pick any.
  const listed = names.every((n) => /^[A-Za-z0-9_-]+$/.test(n)) ? names.join('|') : undefined;
  const on = (hook: FenceHook, inner?: readonly HookMatcherLike[]): FenceMatcher[] => {
    const matcher = inner?.length ? undefined : listed;
    const timeout = longest(inner);
    return [{ ...(matcher ? { matcher } : {}), hooks: [hook], ...(timeout ? { timeout } : {}) }];
  };
  return { PreToolUse: on(pre, o.hooks?.PreToolUse), PostToolUse: on(post, o.hooks?.PostToolUse), PostToolUseFailure: on(failed), PostToolBatch: [{ hooks: [settle] }], Stop: [{ hooks: [settle] }], SubagentStop: [{ hooks: [settle] }] };
}

/** The options of a query that say where Claude Code finds its settings and hooks. */
interface QueryOptionsLike {
  hooks?: Record<string, unknown[] | undefined>;
  settingSources?: readonly string[];
  cwd?: string;
  settings?: unknown;
  managedSettings?: unknown;
  env?: Record<string, string | undefined>;
}

/**
 * The query's options with the fence's hooks in them: `query({ prompt, options: withFence(options) })`.
 * The query's own PreToolUse and PostToolUse hooks run inside the fence's, first; its other hooks
 * stay where they are, beside the fence's. Without Shadowlap the hooks answer as the query's own
 * would, so the same options serve production.
 */
export function withFence<T extends object>(options: T, fence: FenceOptions = {}): T & { hooks: Record<string, unknown[]> } {
  const q = options as QueryOptionsLike;
  const own = q.hooks ?? {};
  const inner = { PreToolUse: [...((own.PreToolUse ?? []) as HookMatcherLike[]), ...(fence.hooks?.PreToolUse ?? [])], PostToolUse: [...((own.PostToolUse ?? []) as HookMatcherLike[]), ...(fence.hooks?.PostToolUse ?? [])] };
  const settings: SettingsPlaces = { ...(q.settingSources ? { sources: q.settingSources } : {}), cwd: q.cwd ?? process.cwd(), settings: q.settings, managedSettings: q.managedSettings, ...(q.env ? { env: q.env } : {}), ...fence.settings };
  const hooks: Record<string, unknown[]> = {};
  for (const [event, matchers] of Object.entries(own)) if (matchers && event !== 'PreToolUse' && event !== 'PostToolUse') hooks[event] = [...matchers];
  for (const [event, matchers] of Object.entries(fenceHooks({ ...fence, hooks: inner, settings }))) hooks[event] = [...(hooks[event] ?? []), ...matchers];
  return { ...options, hooks };
}

/** A tool of an in-process MCP server, as the SDK's `tool()` makes it. */
interface SdkMcpToolLike {
  name: string;
  handler: (args: never, extra: never) => Promise<unknown>;
}

/**
 * The tools of an in-process MCP server (`createSdkMcpServer`), recorded and fenced like any SDK
 * tool under the name the model calls them by, `mcp__<server>__<tool>`:
 *
 *   const tools = withEffects('orders', [lookupOrder, issueRefund], { lookup_order: 'read', issue_refund: 'write' });
 *   const orders = createSdkMcpServer({ name: 'orders', version: '1.0.0', tools });
 *
 * A write after a fork answers as an MCP tool that failed (`isError`), with the refusal as its text,
 * so the model reads it and carries on; under `--writes stub` it answers `onFork`'s result, or a text
 * saying the tool was not run.
 */
export function withEffects<T extends SdkMcpToolLike>(server: string, tools: readonly T[], effects: Record<string, EffectSpec>): T[] {
  const missing = tools.filter((t) => effects[t.name] === undefined).map((t) => t.name);
  if (missing.length) throw new TypeError(`withEffects: every tool needs an effect; missing for ${missing.join(', ')}`);
  return tools.map((t) => {
    const recordedName = `mcp__${server}__${t.name}`;
    const spec = effects[t.name]!;
    const options = toOptions(spec, recordedName, t.handler as (...args: never[]) => unknown);
    const stubbed = options.onFork ?? (() => ({ content: [{ type: 'text', text: `${t.name} was not executed: write tools are stubbed after the fork (shadowlap replay --writes stub).` }] }));
    const run = wrapFirstArg<unknown, [unknown], unknown>(recordedName, { ...options, onFork: stubbed }, t.handler as unknown as (args: unknown, extra: unknown) => Promise<unknown>);
    const handler = async (args: unknown, extra: unknown) => {
      try {
        return await run(args, extra);
      } catch (err) {
        // As an MCP server answers a tool whose handler failed: a result the model reads.
        if (err instanceof ShadowlapWriteBlocked || err instanceof ShadowlapInjectedFailure) return { content: [{ type: 'text', text: err.message }], isError: true };
        throw err;
      }
    };
    return { ...t, handler };
  });
}
