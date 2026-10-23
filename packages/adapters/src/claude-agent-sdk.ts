import { completeToolCall, resolveToolCall, ShadowlapInjectedFailure, ShadowlapWriteBlocked, type Effect, type Resolution } from '@shadowlap/sdk';
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

export type FenceOutput =
  | Record<string, never>
  | {
      hookSpecificOutput:
        | { hookEventName: 'PreToolUse'; permissionDecision: 'allow' | 'deny'; permissionDecisionReason: string; updatedInput?: Record<string, unknown> }
        | { hookEventName: 'PostToolUse'; updatedToolOutput: unknown };
    };

export type FenceHook = (input: HookInputLike, toolUseID: string | undefined, options: { signal?: AbortSignal }) => Promise<FenceOutput>;

export interface FenceMatcher {
  matcher?: string;
  hooks: FenceHook[];
}

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
}

/** A recorded Bash call that moved the shell's working folder keeps where it left it here, beside its output. */
const CWD = 'shadowlapCwd';

type Pending =
  | { kind: 'live'; callNo: number; name: string; effect: Effect; started: number; agent: string; cwd: unknown }
  | { kind: 'stubbed'; callNo: number; name: string; started: number; agent: string; input: Record<string, unknown>; scratch: string }
  | { kind: 'replayed'; name: string; agent: string; output: unknown }
  | { kind: 'failure'; name: string; agent: string };

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

/**
 * The hooks that record and fence Claude Code's built-in tools: PreToolUse, PostToolUse,
 * PostToolUseFailure, and PostToolBatch and Stop, which end a call Claude Code never ran (a
 * permission refused it after PreToolUse). Merge them into the query's `hooks`, or use `withFence`.
 */
export function fenceHooks(o: FenceOptions = {}): Record<'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'PostToolBatch' | 'Stop' | 'SubagentStop', FenceMatcher[]> {
  const effects: Record<string, Effect> = { ...BUILT_IN_EFFECTS, ...o.effects };
  const log = o.log ?? ((line: string) => process.stderr.write(`[shadowlap] ${line}\n`));
  const pending = new Map<string, Pending>();
  let scratch: Promise<Scratch> | undefined;
  const scratchDir = () => (scratch ??= makeScratch(o.scratch));

  const allow = (updatedInput: Record<string, unknown>, why: string): FenceOutput => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: why, updatedInput } });
  const deny = (reason: string): FenceOutput => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  const replaced = (output: unknown): FenceOutput => ({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: output } });

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

  const pre: FenceHook = async (input, toolUseID) => {
    const name = text(input.tool_name);
    const effect = effects[name];
    if (!effect) return {};
    const id = toolUseID ?? text(input.tool_use_id);
    const args = isRecord(input.tool_input) ? input.tool_input : {};
    const agent = text(input.agent_id);
    try {
      const r: Resolution | null = await resolveToolCall({ name, effect, args });
      if (r === null) return {};
      switch (r.origin) {
        case 'live':
          pending.set(id, { kind: 'live', callNo: r.callNo, name, effect, started: Date.now(), agent, cwd: input.cwd });
          return {};
        case 'blocked':
          return deny(r.error.message);
        case 'stubbed': {
          const stand = await standIn(name, args, undefined);
          if (!stand) {
            await completeToolCall(r.callNo, { outcome: 'error', error: { name: 'ShadowlapWriteBlocked', message: `${name} has no stand-in Claude Code takes, so it was refused instead of stubbed` } });
            return deny(`${name} was not run: write tools are stubbed after the fork (shadowlap replay --writes stub), and ${name} can't be.`);
          }
          pending.set(id, { kind: 'stubbed', callNo: r.callNo, name, started: Date.now(), agent, input: args, scratch: (await scratchDir()).dir });
          return allow(stand, 'shadowlap: a write stubbed after the fork');
        }
        case 'replayed': {
          if (r.outcome === 'ok') {
            const output = isRecord(r.result) && CWD in r.result ? Object.fromEntries(Object.entries(r.result).filter(([k]) => k !== CWD)) : r.result;
            if (effect !== 'write') {
              // A read runs as it is; the model gets the recorded output.
              pending.set(id, { kind: 'replayed', name, agent, output });
              return {};
            }
            const stand = await standIn(name, args, r.result);
            if (!stand) return deny(`shadowlap: ${name} was not run again on replay: it is a write, and it has no stand-in Claude Code takes. The replay forks here.`);
            pending.set(id, { kind: 'replayed', name, agent, output });
            return allow(stand, 'shadowlap: a recorded call, replayed');
          }
          if (r.injected) return deny(r.error.message);
          if (effect !== 'write') return {}; // a read that failed: it runs, and fails as it did
          const failure = name === 'Bash' ? bashFailure(r.error.message) : null;
          if (failure) {
            pending.set(id, { kind: 'failure', name, agent });
            return allow(await failingBash(args, failure), 'shadowlap: a recorded failure, replayed');
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
  };

  const post: FenceHook = async (input, toolUseID) => {
    const id = toolUseID ?? text(input.tool_use_id);
    const p = pending.get(id);
    if (!p) return {};
    pending.delete(id);
    try {
      switch (p.kind) {
        case 'replayed':
          return replaced(p.output);
        case 'failure':
          log(`the replayed failure of ${p.name} ran without failing; the replay forks here`);
          return {};
        case 'live': {
          const output = input.tool_response;
          // Where a command left the shell is part of what the model sees next: kept for the replay's stand-in.
          const moved = p.name === 'Bash' && typeof input.cwd === 'string' && typeof p.cwd === 'string' && input.cwd !== p.cwd;
          await completeToolCall(p.callNo, { outcome: 'ok', result: moved && isRecord(output) ? { ...output, [CWD]: input.cwd } : (output ?? null), latencyMs: Date.now() - p.started });
          return {};
        }
        case 'stubbed': {
          const output = stubOutput(p.name, p.input, input.tool_response);
          await completeToolCall(p.callNo, { outcome: 'ok', result: output ?? null, latencyMs: 0 });
          return replaced(output);
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
  // An exact list (letters, digits, _ and -), which Claude Code compares name by name; the hooks check the name again.
  const matcher = names.every((n) => /^[A-Za-z0-9_-]+$/.test(n)) ? names.join('|') : undefined;
  const on = (hook: FenceHook): FenceMatcher[] => [{ ...(matcher ? { matcher } : {}), hooks: [hook] }];
  return { PreToolUse: on(pre), PostToolUse: on(post), PostToolUseFailure: on(failed), PostToolBatch: [{ hooks: [settle] }], Stop: [{ hooks: [settle] }], SubagentStop: [{ hooks: [settle] }] };
}

/**
 * The query's options with the fence's hooks added to its own: `query({ prompt, options: withFence(options) })`.
 * Without Shadowlap the hooks answer `{}` at once, so the same options serve production.
 */
export function withFence<T extends object>(options: T, fence: FenceOptions = {}): T & { hooks: Record<string, unknown[]> } {
  const own = (options as { hooks?: Record<string, unknown[] | undefined> }).hooks ?? {};
  const hooks: Record<string, unknown[]> = {};
  for (const [event, matchers] of Object.entries(own)) if (matchers) hooks[event] = [...matchers];
  for (const [event, matchers] of Object.entries(fenceHooks(fence))) hooks[event] = [...(hooks[event] ?? []), ...matchers];
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
    return { ...t, handler } as T;
  });
}
