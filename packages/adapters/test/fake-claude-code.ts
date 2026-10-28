/**
 * A stand-in for Claude Code's tool pipeline, to test hooks against without the CLI. It follows the
 * SDK's documented hook contract:
 *
 * - matchers: none, "" or "*" match every tool; letters, digits, _, -, spaces, "," and "|" are an
 *   exact list; anything else is an unanchored regular expression;
 * - every matching callback gets (input, toolUseID, { signal }) and they run at once, the query's
 *   own and those of the settings files Claude Code loads (`beside`) alike;
 * - PreToolUse decisions combine deny > defer > ask > allow, and `updatedInput` replaces the whole input;
 * - a hook's `continue: false` stops the session: no tool call runs after it;
 * - PostToolUse fires after a call that succeeded, with `tool_input` and `tool_response`, and
 *   `updatedToolOutput` replaces the output when it has the tool's output shape (ignored otherwise);
 * - PostToolUseFailure fires when the call throws, with `error`, and never for a call refused before
 *   it ran (its input invalid, or a permission refused it).
 *
 * and does what Claude Code 2.1.309 was seen to do where the documentation is silent: when several
hooks rewrite the input or the output, the one that answered last wins; it validates a
 * call's input against the files before any hook (an Edit of a file never read, or whose text isn't
 * there, is refused, and no hook hears of it); it validates a hook's rewritten input again; a deny
 * reaches the model as "PreToolUse:<tool> hook error: <reason>"; a hook that throws counts as `{}`,
 * so the tool runs; a Bash failure reads "Exit code N" then its output; a Bash command that moves the
 * shell adds a note to what the model reads next; and a write outside the working folder needs a
 * permission, which only a hook's "allow" or the agent's canUseTool gives.
 *
 * The files are kept in memory, so a test sees every write; the commands Bash runs are interpreted
 * for the few forms the tests and the fence use (`true`, `cd`, `printf '%s' …; exit N`, `cat -- …`,
 * `echo … > file`, `fail …`).
 */
import { readFileSync } from 'node:fs';

export interface HookCallbackLike {
  (input: Record<string, unknown>, toolUseID: string | undefined, options: { signal: AbortSignal }): Promise<Record<string, unknown>>;
}
export interface HookMatcherLike {
  matcher?: string;
  hooks: HookCallbackLike[];
}
export type Hooks = Partial<Record<string, HookMatcherLike[]>>;

/** What the model reads for one tool call. */
export interface ToolResult {
  content: string;
  is_error: boolean;
}

/** A tool's output shape: its required fields and their types, as the output schema checks them. */
const SHAPES: Record<string, Record<string, 'string' | 'number' | 'boolean' | 'object'>> = {
  Bash: { stdout: 'string', stderr: 'string', interrupted: 'boolean' },
  Write: { type: 'string', filePath: 'string', content: 'string' },
  Edit: { filePath: 'string', oldString: 'string', newString: 'string' },
  Read: { type: 'string', file: 'object' },
  WebFetch: { bytes: 'number', code: 'number', result: 'string', url: 'string' },
  WebSearch: { query: 'string', results: 'object' },
  Glob: { filenames: 'object', numFiles: 'number' },
};

/** The input fields each tool takes; anything else in a hook's rewrite is dropped, as the schema does. */
const INPUTS: Record<string, string[]> = {
  Bash: ['command', 'description', 'timeout', 'run_in_background'],
  Write: ['file_path', 'content'],
  Edit: ['file_path', 'old_string', 'new_string', 'replace_all'],
  Read: ['file_path', 'offset', 'limit'],
  WebFetch: ['url', 'prompt'],
  WebSearch: ['query'],
  Glob: ['pattern', 'path'],
  NotebookEdit: ['notebook_path', 'new_source', 'cell_id', 'edit_mode'],
};
const REQUIRED: Record<string, string[]> = {
  Bash: ['command'],
  Write: ['file_path', 'content'],
  Edit: ['file_path', 'old_string', 'new_string'],
  Read: ['file_path'],
  WebFetch: ['url', 'prompt'],
  WebSearch: ['query'],
  Glob: ['pattern'],
  NotebookEdit: ['notebook_path', 'new_source'],
};

const RANK: Record<string, number> = { deny: 4, defer: 3, ask: 2, allow: 1 };

/** Whether a hook's matcher picks a tool, by the documented rules. */
export function matches(matcher: string | undefined, tool: string): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  if (/^[A-Za-z0-9_ ,|-]+$/.test(matcher)) return matcher.split(/[|,]/).some((m) => m.trim() === tool);
  return new RegExp(matcher).test(tool);
}

class ToolError extends Error {}

export class FakeClaudeCode {
  /** The project's files, by absolute path. */
  readonly files = new Map<string, string>();
  /** Files Claude Code has seen this session (read or written), as its read tracking keeps them. */
  readonly readState = new Set<string>();
  /** Every command Bash ran, as it ran it. */
  readonly ran: string[] = [];
  /** Pages WebFetch can fetch, by URL; a fetch also asks the model to read the page, which `askedModel` counts. */
  readonly web = new Map<string, string>();
  askedModel = 0;
  /** What the model read after each tool call besides its result: Claude Code's note that the shell moved. */
  readonly notes: string[] = [];
  /** Each hook event as it fired, with the tool. */
  readonly events: string[] = [];
  cwd: string;
  /** The agent's canUseTool: asked for a call that needs a permission no hook gave. Default: refused. */
  canUseTool: (tool: string, input: Record<string, unknown>) => { behavior: 'allow' } | { behavior: 'deny'; message: string } = (tool) => ({ behavior: 'deny', message: `Claude requested permissions to use ${tool}, but you haven't granted it yet.` });
  /** Why a hook stopped the session (`continue: false`), once one has: no tool call runs after it. */
  stopReason: string | null = null;
  /** The subagent the calls are made in, as Claude Code names it in each hook's input; null for the main session. */
  agent: { id: string; type: string } | null = null;

  constructor(
    private readonly hooks: Hooks,
    readonly root: string,
    /** Hooks of the settings files Claude Code loads, which run beside the query's. */
    private readonly beside: Hooks = {},
  ) {
    this.cwd = root;
  }

  /** One tool call, as the model asked for it: what the model reads back. */
  async call(tool: string, input: Record<string, unknown>, id: string): Promise<ToolResult> {
    if (this.stopReason !== null) return { content: `the session was stopped: ${this.stopReason}`, is_error: true };
    const checked = this.parse(tool, input);
    if (typeof checked === 'string') return { content: `<tool_use_error>InputValidationError: ${checked}</tool_use_error>`, is_error: true };
    // The model's own input is checked against the files before any hook hears of the call.
    const invalid = this.validate(tool, checked);
    if (invalid) return { content: `<tool_use_error>${invalid}</tool_use_error>`, is_error: true };

    const base = { session_id: 's', transcript_path: '/t', cwd: this.cwd, permission_mode: 'default', tool_name: tool, tool_use_id: id, ...(this.agent ? { agent_id: this.agent.id, agent_type: this.agent.type } : {}) };
    const pre = await this.run('PreToolUse', tool, { ...base, hook_event_name: 'PreToolUse', tool_input: checked }, id);
    let decision: string | undefined;
    let reason = '';
    let updated: Record<string, unknown> | undefined;
    for (const out of pre) {
      const h = out.hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> } | undefined;
      if (!h) continue;
      if (h.permissionDecision && (RANK[h.permissionDecision] ?? 0) > (decision ? (RANK[decision] ?? 0) : 0)) {
        decision = h.permissionDecision;
        reason = h.permissionDecisionReason ?? '';
      }
      if (h.updatedInput) updated = h.updatedInput;
    }
    this.stopped(pre);
    if (decision === 'deny') return { content: `PreToolUse:${tool} hook error: ${reason}`, is_error: true };
    if (decision === 'defer') return { content: `deferred: ${reason}`, is_error: true };
    let used = checked;
    if (updated) {
      const again = this.parse(tool, updated);
      if (typeof again === 'string') return { content: `PreToolUse hook for ${tool} returned updatedInput that failed schema validation: ${again}`, is_error: true };
      const refused = this.validate(tool, again);
      if (refused) return { content: `PreToolUse hook for ${tool} returned updatedInput that the tool refused: ${refused}\nThe tool input from the model was valid; the hook's rewrite of it was not.`, is_error: true };
      used = again;
    }
    if (decision !== 'allow' && this.needsPermission(tool, used)) {
      const asked = this.canUseTool(tool, used);
      if (asked.behavior === 'deny') return { content: asked.message, is_error: true };
    }

    let output: unknown;
    try {
      output = this.execute(tool, used);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.stopped(await this.run('PostToolUseFailure', tool, { ...base, cwd: this.cwd, hook_event_name: 'PostToolUseFailure', tool_input: used, error, is_interrupt: false }, id));
      return { content: error, is_error: true };
    }
    const post = await this.run('PostToolUse', tool, { ...base, cwd: this.cwd, hook_event_name: 'PostToolUse', tool_input: used, tool_response: output }, id);
    for (const out of post) {
      const h = out.hookSpecificOutput as { updatedToolOutput?: unknown } | undefined;
      if (h && 'updatedToolOutput' in h && fits(tool, h.updatedToolOutput)) output = h.updatedToolOutput;
    }
    this.stopped(post);
    return { content: render(tool, output), is_error: false };
  }

  /** A hook that answered `continue: false` stops the session. */
  private stopped(outs: ReadonlyArray<Record<string, unknown>>): void {
    const stop = outs.find((o) => o.continue === false);
    if (stop && this.stopReason === null) this.stopReason = typeof stop.stopReason === 'string' ? stop.stopReason : 'stopped by a hook';
  }

  /** The end of a batch of tool calls, and of the turn: the hooks that fire there. */
  async endBatch(): Promise<void> {
    await this.run('PostToolBatch', '', { session_id: 's', cwd: this.cwd, hook_event_name: 'PostToolBatch' }, undefined);
  }
  async stop(): Promise<void> {
    await this.run('Stop', '', { session_id: 's', cwd: this.cwd, hook_event_name: 'Stop', stop_hook_active: false }, undefined);
  }

  private async run(event: string, tool: string, input: Record<string, unknown>, id: string | undefined): Promise<Array<Record<string, unknown>>> {
    this.events.push(`${event}${tool ? `:${tool}` : ''}`);
    const callbacks = [...(this.hooks[event] ?? []), ...(this.beside[event] ?? [])].filter((m) => event === 'Stop' || event === 'PostToolBatch' || matches(m.matcher, tool)).flatMap((m) => m.hooks);
    const signal = new AbortController().signal;
    // In the order they answered: a rewrite of the input or the output is the last one's. A callback
    // that throws counts as {}: the call goes on as if it had said nothing.
    const answered: Array<Record<string, unknown>> = [];
    await Promise.all(callbacks.map((cb) => cb(input, id, { signal }).catch(() => ({})).then((out) => void answered.push(out))));
    return answered;
  }

  private parse(tool: string, input: Record<string, unknown>): Record<string, unknown> | string {
    const known = INPUTS[tool];
    if (!known) return { ...input };
    const missing = (REQUIRED[tool] ?? []).filter((k) => input[k] === undefined);
    if (missing.length) return `${missing.join(', ')} is missing`;
    return Object.fromEntries(Object.entries(input).filter(([k]) => known.includes(k)));
  }

  private path(p: unknown): string {
    const s = String(p);
    return s.startsWith('/') ? s : `${this.cwd}/${s}`;
  }

  /** Claude Code's checks of a call's input against the files, before it runs. */
  private validate(tool: string, input: Record<string, unknown>): string | null {
    if (tool === 'Read' && !this.files.has(this.path(input.file_path))) return 'File does not exist.';
    if (tool === 'Write') {
      const file = this.path(input.file_path);
      if (this.files.has(file) && !this.readState.has(file)) return 'File has not been read yet. Read it first before writing to it.';
    }
    if (tool === 'Edit') {
      const file = this.path(input.file_path);
      const now = this.files.get(file);
      if (now === undefined) return input.old_string === '' ? null : 'File does not exist.';
      if (input.old_string === '') return 'Cannot create new file - file already exists.';
      if (!this.readState.has(file)) return 'File has not been read yet. Read it first before writing to it.';
      if (!now.includes(String(input.old_string))) return `String to replace not found in file.\nString: ${String(input.old_string)}`;
    }
    if (tool === 'NotebookEdit' && !this.readState.has(this.path(input.notebook_path))) return 'File has not been read yet. Read it first before writing to it.';
    return null;
  }

  /** A write outside the working folder asks for a permission. */
  private needsPermission(tool: string, input: Record<string, unknown>): boolean {
    const file = tool === 'Write' || tool === 'Edit' || tool === 'Read' ? this.path(input.file_path) : null;
    return file !== null && !file.startsWith(this.root);
  }

  private execute(tool: string, input: Record<string, unknown>): unknown {
    switch (tool) {
      case 'Bash':
        return this.bash(String(input.command));
      case 'Write': {
        const file = this.path(input.file_path);
        const before = this.files.get(file);
        this.files.set(file, String(input.content));
        this.readState.add(file);
        return { type: before === undefined ? 'create' : 'update', filePath: String(input.file_path), content: String(input.content), structuredPatch: [], originalFile: before ?? null };
      }
      case 'Edit': {
        const file = this.path(input.file_path);
        const before = this.files.get(file) ?? '';
        this.files.set(file, input.old_string === '' ? String(input.new_string) : before.replace(String(input.old_string), String(input.new_string)));
        this.readState.add(file);
        return { filePath: String(input.file_path), oldString: String(input.old_string), newString: String(input.new_string), originalFile: before, structuredPatch: [], userModified: false, replaceAll: false };
      }
      case 'Read': {
        const file = this.path(input.file_path);
        const content = this.files.get(file)!;
        this.readState.add(file);
        return { type: 'text', file: { filePath: String(input.file_path), content, numLines: content.split('\n').length, startLine: 1, totalLines: content.split('\n').length } };
      }
      case 'WebFetch': {
        const page = this.web.get(String(input.url));
        if (page === undefined) throw new ToolError(`Request failed with status code 404`);
        this.askedModel++;
        return { bytes: page.length, code: 200, codeText: 'OK', result: `summary of ${page}`, durationMs: 1, url: String(input.url) };
      }
      case 'NotebookEdit':
        this.files.set(this.path(input.notebook_path), String(input.new_source));
        return { new_source: String(input.new_source), cell_type: 'code', language: 'python', edit_mode: 'replace', notebook_path: String(input.notebook_path), original_file: '', updated_file: '' };
      default:
        return { content: [{ type: 'text', text: `${tool} ran` }] };
    }
  }

  /** The few command forms the tests use. */
  private bash(command: string): unknown {
    this.ran.push(command);
    let m: RegExpExecArray | null;
    if (command === 'true') return { stdout: '', stderr: '', interrupted: false, isImage: false };
    if ((m = /^builtin cd -- '((?:[^']|'\\'')*)' 2>\/dev\/null \|\| true$/.exec(command)) || (m = /^cd (\S+)$/.exec(command))) {
      const to = m[1].replace(/'\\''/g, "'");
      const next = to.startsWith('/') ? to : `${this.cwd}/${to}`;
      if (next !== this.cwd) this.notes.push(`# Environment update\n - Primary working directory: ${next} (was ${this.cwd})`);
      this.cwd = next;
      return { stdout: '', stderr: '', interrupted: false, isImage: false };
    }
    if ((m = /^printf '%s' '((?:[^']|'\\'')*)'; exit (\d+)$/.exec(command))) throw new ToolError(`Exit code ${m[2]}\n${m[1].replace(/'\\''/g, "'")}`.trim());
    if ((m = /^cat -- '((?:[^']|'\\'')*)'; exit (\d+)$/.exec(command))) throw new ToolError(`Exit code ${m[2]}\n${readFileSync(m[1].replace(/'\\''/g, "'"), 'utf8')}`.trim());
    if ((m = /^echo (.*) > (\S+)$/.exec(command))) {
      this.files.set(this.path(m[2]), `${m[1]}\n`);
      return { stdout: '', stderr: '', interrupted: false, isImage: false };
    }
    if ((m = /^fail (\d+) (.*)$/.exec(command))) throw new ToolError(`Exit code ${m[1]}\n${m[2]}`);
    return { stdout: `ran: ${command}`, stderr: '', interrupted: false, isImage: false };
  }
}

/** Whether an output has the tool's output shape. An MCP tool's output is never checked. */
function fits(tool: string, output: unknown): boolean {
  const shape = SHAPES[tool];
  if (!shape) return true;
  if (typeof output !== 'object' || output === null) return false;
  return Object.entries(shape).every(([k, type]) => typeof (output as Record<string, unknown>)[k] === type && (output as Record<string, unknown>)[k] !== null);
}

/** What the model reads for a tool's output, from the output alone, as Claude Code's mappers write it. */
function render(tool: string, output: unknown): string {
  const o = output as Record<string, unknown>;
  switch (tool) {
    case 'Bash':
      return [String(o.stdout).trimEnd(), String(o.stderr).trim()].filter(Boolean).join('\n') || '(Bash completed with no output)';
    case 'Write':
      return o.type === 'create' ? `File created successfully at: ${String(o.filePath)}` : `The file ${String(o.filePath)} has been updated successfully.`;
    case 'Edit':
      return `The file ${String(o.filePath)} has been updated successfully.`;
    case 'Read':
      return String((o.file as { content: string }).content);
    case 'WebFetch':
      return String(o.result);
    default:
      return JSON.stringify(output);
  }
}
