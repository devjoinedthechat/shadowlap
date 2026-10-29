import { isClaudeCodeSession } from './fingerprint.js';
import { isReservedScope } from './judge-scope.js';
import { loadApiRequest } from './manifest.js';
import { normalizeResponse } from './responses.js';
import type { StoreOf } from './store.js';
import type { CallRecord } from './types.js';
import { isObject } from './is-object.js';

/**
 * Tools the model called that Shadowlap never recorded. A recording holds every model answer, and
 * each answer names the tools the model asked for (Anthropic's `tool_use`, OpenAI's `tool_calls`,
 * the Responses API's `function_call`, Gemini's `functionCall`, Bedrock's `toolUse`). A tool the
 * agent wraps leaves a tool call of its own in the run; one it doesn't wrap (the Claude Agent SDK's
 * built-in Bash, a framework's tool, an MCP server reached without `shadowlap mcp`) ran in the agent
 * unseen, and a replay, which serves the answer that asked for it, runs it again for real. This
 * reads the run, not the code, so it finds tools a scan of the source misses.
 */

export type UnrecordedEffect = 'write' | 'read' | 'unknown';

export interface UnrecordedTool {
  /** The tool's name as the model called it. */
  name: string;
  /** How many times the model asked for it in the run's answers. */
  count: number;
  /** The model call whose answer first asked for it. */
  firstCallNo: number;
  /** What it does to the world, as far as Shadowlap can tell: declared in the config, a known built-in, its name, or unknown. */
  effect: UnrecordedEffect;
  /** Why it has that effect, in a few words: `declared write in shadowlap.config.json`, `a Claude Code built-in that runs a command`, `"send" changes something`. */
  why: string;
  /** How to have it recorded (unrecordedFix): through the Claude Agent SDK's fence, `shadowlap mcp`, or wrapped. */
  fix: UnrecordedFix;
}

export interface UnrecordedOptions {
  /** `tools.unrecorded` in shadowlap.config.json: the effect of a tool Shadowlap doesn't record, by name. */
  declared?: Readonly<Record<string, 'read' | 'write'>>;
  /** Whether the run's agent is Claude Code, whose built-ins are told apart by name; worked out from the run when absent (fromClaudeCode). */
  claudeCode?: boolean;
}

// ---- the config: tools.unrecorded ----

/** The key under `tools` in shadowlap.config.json that declares the effect of tools Shadowlap doesn't record; no tool's trust. */
export const UNRECORDED_KEY = 'unrecorded';

/**
 * `"tools": { "unrecorded": { "Bash": "write", "lookup_kb": "read" } }`, checked: the effect of each
 * tool the agent runs without Shadowlap recording it, which decides whether a replay may run it
 * again. Null when the config declares none.
 */
export function parseUnrecordedConfig(tools: unknown, file = 'shadowlap.config.json'): Record<string, 'read' | 'write'> | null {
  if (!isObject(tools) || tools[UNRECORDED_KEY] === undefined) return null;
  const raw = tools[UNRECORDED_KEY];
  if (!isObject(raw)) throw new Error(`${file}: tools.unrecorded must map tool names to "read" or "write", e.g. { "Bash": "write" }`);
  const out: Record<string, 'read' | 'write'> = {};
  for (const [name, effect] of Object.entries(raw)) {
    if (effect !== 'read' && effect !== 'write') throw new Error(`${file}: tools.unrecorded["${name}"] must be "read" or "write"`);
    out[name] = effect;
  }
  return out;
}

// ---- effects by name ----

/** Verbs that change something: in a verb's place in a name, a write (`send_email`, `get_or_create_user`). */
const WRITE_VERBS = new Set(['send', 'create', 'write', 'delete', 'remove', 'update', 'upsert', 'insert', 'save', 'submit', 'pay', 'charge', 'refund', 'transfer', 'publish', 'deploy', 'notify', 'execute', 'exec', 'commit', 'push', 'merge', 'approve', 'cancel', 'move', 'rename', 'upload', 'add', 'invite', 'assign', 'apply', 'install', 'uninstall', 'kill', 'restart', 'trigger', 'tweet', 'edit', 'replace', 'modify', 'patch', 'checkout', 'purchase', 'buy', 'sell', 'click', 'fill', 'press', 'drag', 'navigate', 'repl', 'eval', 'overwrite', 'append', 'erase', 'purge', 'destroy', 'terminate', 'revoke', 'grant', 'escalate', 'enable', 'disable', 'subscribe', 'unsubscribe', 'reboot', 'shutdown', 'rollback', 'revert', 'truncate', 'wipe']);
/**
 * Words that change something as a verb but are as often nouns: a write only where a name puts its
 * verb, never at its end (`run_query` and `book_flight` write, `sales_order` and `user_record` don't).
 */
const WRITE_NOUN_VERBS = new Set(['post', 'set', 'put', 'book', 'order', 'run', 'email', 'mail', 'reply', 'schedule', 'archive', 'comment', 'close', 'open', 'type', 'select', 'start', 'stop', 'message', 'text', 'share', 'like', 'tag', 'label', 'mark', 'pin', 'star', 'follow', 'reset', 'clear', 'call', 'invoke', 'command', 'script', 'shell', 'bash', 'python', 'drop', 'sync', 'import', 'export', 'link', 'note', 'issue', 'file', 'log', 'record', 'store']);
/** Verbs that only look. */
const READ_VERBS = new Set(['get', 'read', 'fetch', 'search', 'list', 'find', 'lookup', 'query', 'load', 'browse', 'retrieve', 'check', 'describe', 'view', 'show', 'count', 'download', 'inspect', 'scrape', 'crawl', 'grep', 'ls', 'cat', 'tail', 'head', 'watch', 'poll', 'peek', 'preview', 'scan']);
/** Nouns of what a read returns, which say a name only looks when no verb does (`weather`, `browser_snapshot`). */
const READ_NOUNS = new Set(['weather', 'price', 'quote', 'snapshot', 'screenshot', 'status', 'info', 'exists', 'schema']);
const PURE_WORDS = new Set(['calc', 'calculate', 'compute', 'parse', 'format', 'convert', 'validate', 'math', 'sum', 'multiply', 'divide', 'round', 'hash', 'encode', 'decode', 'tokenize', 'sort', 'diff', 'render']);
/** The words that join two of a name's verbs, after which a verb's place comes again: `search_and_book`, `get_or_create`. */
const JOINS = new Set(['and', 'or', 'then']);
/**
 * Languages of statements the model writes and a tool runs, any of which can change data: a tool
 * that runs one (`sql_db_query`, `run_cypher`, `graphql_query`) can write, whatever its name's verb
 * says, since its input decides what it does.
 */
const STATEMENT_LANGUAGES = new Set(['sql', 'cypher', 'sparql', 'graphql', 'gql']);
const RUNS_A_STATEMENT = new Set(['query', 'run', 'execute', 'exec', 'statement', 'stmt']);

const isVerb = (w: string) => WRITE_VERBS.has(w) || WRITE_NOUN_VERBS.has(w) || READ_VERBS.has(w) || PURE_WORDS.has(w);

/**
 * A tool's effect as its name says it, or null when the name gives no hint. A verb counts where a
 * name puts its verb: first, or after `and`, `or` or `then`, so `search_and_book` books and
 * `get_or_create_user` creates, while the nouns of `get_merge_request` and `get_deploy_status` only
 * name what a read looks at. A name that leads with a noun puts its verb last (`user_create`,
 * `ticket_status_update`), where only a word that is never a noun counts. A tool that runs a
 * statement the model writes in SQL or a language like it can write (`sql_db_query`). Otherwise the
 * first word that only looks, or depends only on its input. `shadowlap init` suggests an effect for
 * an unwrapped tool the same way.
 */
export function toolNameEffect(name: string): { effect: 'write' | 'read' | 'pure'; word: string } | null {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (!words.length) return null;
  const places = words.filter((w, i) => i === 0 || JOINS.has(words[i - 1]!));
  const last = words.length > 1 && !isVerb(words[0]!) ? words.at(-1)! : null;
  const writes = [...places.filter((w) => WRITE_VERBS.has(w) || WRITE_NOUN_VERBS.has(w)), ...(last && WRITE_VERBS.has(last) ? [last] : [])];
  // Named, for the reason a person reads, by the plainest verb in it that changes something (`python_repl`: "repl").
  if (writes.length) return { effect: 'write', word: words.find((w) => WRITE_VERBS.has(w)) ?? writes[0]! };
  const language = words.find((w) => STATEMENT_LANGUAGES.has(w));
  if (language && words.some((w) => RUNS_A_STATEMENT.has(w))) return { effect: 'write', word: language };
  for (const word of words) {
    if (READ_VERBS.has(word) || READ_NOUNS.has(word)) return { effect: 'read', word };
    if (PURE_WORDS.has(word)) return { effect: 'pure', word };
  }
  return null;
}

/**
 * Claude Code's built-in tools, which the Claude Agent SDK runs, by what each does (Claude Code's
 * tools reference names them): those that run a command, change a file or send something out write;
 * those that look, or keep the session's own state (its task list, its mode), only read. Agent and
 * Workflow start subagents, whose own tool calls a recording names apart and the fence sees.
 */
const CLAUDE_CODE_TOOLS: Readonly<Record<string, { effect: 'read' | 'write'; why: string }>> = (() => {
  const out: Record<string, { effect: 'read' | 'write'; why: string }> = {};
  const as = (effect: 'read' | 'write', why: string, names: string[]) => names.forEach((n) => (out[n] = { effect, why: `a Claude Code built-in that ${why}` }));
  as('write', 'runs a command', ['Bash', 'PowerShell']);
  as('write', 'runs a command, or opens a WebSocket', ['Monitor']);
  as('write', 'changes a file', ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
  as('write', 'stops a background task', ['KillShell', 'KillBash', 'TaskStop']);
  as('write', 'makes or leaves a git worktree', ['EnterWorktree', 'ExitWorktree']);
  as('write', 'publishes a page on claude.ai', ['Artifact']);
  as('write', 'sends a notification', ['PushNotification']);
  as('write', 'makes or runs a scheduled task on claude.ai', ['RemoteTrigger']);
  as('write', 'sends a message to another agent or session', ['SendMessage']);
  as('write', 'sends a file to the person', ['SendUserFile']);
  as('write', 'uploads a guide to share', ['ShareOnboardingGuide']);
  as('read', 'only reads', ['Read', 'Glob', 'Grep', 'LS', 'LSP', 'WebFetch', 'WebSearch', 'NotebookRead', 'BashOutput', 'TaskOutput', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ToolSearch', 'WaitForMcpServers', 'ListAgents', 'CronList', 'TaskGet', 'TaskList']);
  as('read', 'starts a subagent, whose own tool calls are named apart', ['Agent', 'Task', 'Workflow']);
  as('read', "loads a skill's instructions", ['Skill']);
  as('read', 'asks the person a question', ['AskUserQuestion']);
  as('read', "keeps the session's task list", ['TodoWrite', 'TodoRead', 'TaskCreate', 'TaskUpdate']);
  as('read', "switches the session's mode", ['EnterPlanMode', 'ExitPlanMode']);
  as('read', 'schedules a prompt in the session', ['CronCreate', 'CronDelete', 'ScheduleWakeup']);
  as('read', 'shows findings in the session', ['ReportFindings']);
  as('read', 'drafts feedback the person sends or not', ['SendFeedback']);
  as('read', 'ends the session', ['EndConversation']);
  as('read', "hands a subagent's report back", ['SubagentHandback']);
  return Object.freeze(out);
})();

/**
 * Claude Code's built-ins the Claude Agent SDK's fence (withFence) records and fences as it is, as
 * its BUILT_IN_EFFECTS lists them: a run that left one unrecorded ran without it.
 */
export const FENCED_BUILT_INS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']);

/** Other runtimes' and providers' client tools the agent runs itself: Anthropic's (bash, the text editor, computer use) and the Responses API's (computer use, the local shell, apply_patch). */
const CLIENT_WRITES = new Set(['bash', 'computer', 'str_replace_editor', 'str_replace_based_edit_tool', 'text_editor', 'local_shell', 'shell', 'apply_patch']);

/**
 * How to have an unrecorded tool recorded: `fence`, a Claude Code built-in the Claude Agent SDK's
 * fence records as it is; `fence-effects`, another Claude Code built-in that writes, which the
 * fence records once its effects name it; `mcp`, an MCP server's tool, recorded when Claude Code
 * reaches the server through `shadowlap mcp`; `none`, a Claude Code built-in that keeps to its own
 * session; `wrap`, anything else, wrapped where the agent runs it.
 */
export type UnrecordedFix = 'fence' | 'fence-effects' | 'mcp' | 'none' | 'wrap';

export function unrecordedFix(name: string, options: { claudeCode?: boolean } = {}): UnrecordedFix {
  if (options.claudeCode) {
    if (FENCED_BUILT_INS.has(name)) return 'fence';
    const builtIn = Object.hasOwn(CLAUDE_CODE_TOOLS, name) ? CLAUDE_CODE_TOOLS[name] : undefined;
    if (builtIn) return builtIn.effect === 'write' ? 'fence-effects' : 'none';
  }
  if (mcpToolName(name) !== null) return 'mcp';
  return 'wrap';
}

/**
 * Whether a run's agent is Claude Code, which the Claude Agent SDK runs: a model call came with its
 * user agent (`meta.claudeCode`), its fence said hello for the CLI (`preloads.hellos['claude-code']`),
 * or a model request carries the session identifier only Claude Code sends (`metadata.user_id`,
 * isClaudeCodeSession), which a recording made before the user agent was kept holds too. Claude
 * Code's built-in tools are told apart by name in such a run only: in another agent's, a tool named
 * `Skill` or `TaskCreate` is the agent's own, read by its name like any other.
 */
export function fromClaudeCode(store: StoreOf<'recording'>, runId: string, calls: readonly CallRecord[] = store.getCalls(runId)): boolean {
  const meta = store.getRun(runId)?.meta;
  if (meta?.claudeCode === true) return true;
  const hellos = meta?.preloads?.hellos;
  if (hellos && typeof hellos === 'object' && Number((hellos as Record<string, unknown>)['claude-code'] ?? 0) > 0) return true;
  // Every request of a session carries it: the first few say.
  for (const c of calls.filter((x) => x.kind === 'api' && x.requestRef).slice(0, 3)) {
    try {
      const body = loadApiRequest(store, c.requestRef!) as { metadata?: { user_id?: unknown } } | null;
      if (isClaudeCodeSession(body?.metadata?.user_id)) return true;
    } catch {
      // a request it can't read says nothing of who sent it
    }
  }
  return false;
}

/** A built-in the provider runs itself and answers within the same response (web search, code execution, an MCP connector): nothing runs in the agent. */
function providerRun(block: { name: string; hosted?: true }): boolean {
  return block.hosted === true && !/^(computer(\.|$)|local_shell$|shell$|apply_patch$)/.test(block.name);
}

/** `mcp__<server>__<tool>`, as Claude Code and the Claude Agent SDK name an MCP server's tool: the tool's own name. */
const MCP_PREFIXED = /^mcp__[^_](?:.*?)__(.+)$/;
export function mcpToolName(name: string): string | null {
  return MCP_PREFIXED.exec(name)?.[1] ?? null;
}

/**
 * A tool's effect, and why: declared in the config, a built-in's, its name's, or unknown. An MCP
 * tool's prefix is set aside. Claude Code's built-ins are named so only in a run from Claude Code
 * (`claudeCode`, fromClaudeCode).
 */
export function unrecordedEffect(name: string, declared: Readonly<Record<string, 'read' | 'write'>> = {}, options: { claudeCode?: boolean } = {}): { effect: UnrecordedEffect; why: string } {
  const bare = mcpToolName(name);
  const said = Object.hasOwn(declared, name) ? declared[name] : bare !== null && Object.hasOwn(declared, bare) ? declared[bare] : undefined;
  if (said === 'read' || said === 'write') return { effect: said, why: `declared ${said} in shadowlap.config.json` };
  const builtIn = options.claudeCode && Object.hasOwn(CLAUDE_CODE_TOOLS, name) ? CLAUDE_CODE_TOOLS[name] : undefined;
  if (builtIn) return builtIn;
  if (CLIENT_WRITES.has(name) || name.startsWith('computer.')) return { effect: 'write', why: 'a built-in that writes' };
  const byName = toolNameEffect(bare ?? name);
  if (byName) {
    const why = byName.effect === 'write' ? (STATEMENT_LANGUAGES.has(byName.word) ? `it runs ${byName.word === 'gql' ? 'GraphQL' : byName.word.toUpperCase()} the model writes, which can change data` : `"${byName.word}" changes something`) : byName.effect === 'read' ? `"${byName.word}" only looks` : `"${byName.word}" depends only on its input`;
    return { effect: byName.effect === 'write' ? 'write' : 'read', why };
  }
  return { effect: 'unknown', why: 'its name says nothing of what it does' };
}

// ---- the run ----

/** The tools a model call's answer asked for that the agent runs, in order; none for a call that failed. */
function askedFor(store: StoreOf<'recording'>, call: CallRecord): string[] {
  const end = call.end;
  if (call.kind !== 'api' || !end?.responseRef || end.outcome !== 'ok') return [];
  try {
    const bytes = store.getBlob(end.responseRef);
    if (!bytes?.length) return [];
    const provider = end.meta.provider ?? call.meta.provider;
    const r = normalizeResponse(bytes, end.meta.headers?.['content-type'], end.meta.chunks ?? [], typeof provider === 'string' ? provider : undefined);
    return r.blocks.flatMap((b) => (b.type === 'tool_call' && !providerRun(b) ? [b.name] : []));
  } catch {
    return [];
  }
}

/**
 * The tools the model called in a run that the run recorded no call of, the first asked for first:
 * how often the model asked, from which model call, and their effect. A tool the run recorded any
 * call of is left out, an MCP tool the model named with its server's prefix (`mcp__kb__search`)
 * included when the run recorded it under its own name (`search`, through `shadowlap mcp`). Calls
 * Shadowlap makes itself (its judge's) are none of the agent's.
 */
export function unrecordedTools(store: StoreOf<'recording'>, runId: string, options: UnrecordedOptions = {}): UnrecordedTool[] {
  const calls = store.getCalls(runId);
  const recorded = new Set(calls.filter((c) => c.kind === 'tool').map((c) => c.name));
  const isRecorded = (name: string) => recorded.has(name) || recorded.has(mcpToolName(name) ?? name);
  const found = new Map<string, { count: number; firstCallNo: number }>();
  for (const c of [...calls].sort((a, b) => a.callNo - b.callNo)) {
    if (c.kind !== 'api' || isReservedScope(c.meta.scope)) continue;
    for (const name of askedFor(store, c)) {
      if (isRecorded(name)) continue;
      const seen = found.get(name);
      if (seen) seen.count++;
      else found.set(name, { count: 1, firstCallNo: c.callNo });
    }
  }
  // Claude Code's built-ins are its own only in a run from Claude Code.
  const claudeCode = found.size > 0 && (options.claudeCode ?? fromClaudeCode(store, runId, calls));
  return [...found].map(([name, { count, firstCallNo }]) => ({ name, count, firstCallNo, ...unrecordedEffect(name, options.declared, { claudeCode }), fix: unrecordedFix(name, { claudeCode }) }));
}
