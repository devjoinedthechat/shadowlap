import { isReservedScope } from './judge-scope.js';
import { normalizeResponse } from './responses.js';
import type { Store } from './store.js';
import type { CallRecord } from './types.js';

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
  /** Why it has that effect, in a few words: `declared write in shadowlap.config.json`, `a built-in that writes`, `"send" changes something`. */
  why: string;
}

export interface UnrecordedOptions {
  /** `tools.unrecorded` in shadowlap.config.json: the effect of a tool Shadowlap doesn't record, by name. */
  declared?: Readonly<Record<string, 'read' | 'write'>>;
}

// ---- the config: tools.unrecorded ----

/** The key under `tools` in shadowlap.config.json that declares the effect of tools Shadowlap doesn't record; no tool's trust. */
export const UNRECORDED_KEY = 'unrecorded';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

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

/** Verbs that change something wherever they stand in a name: `get_or_create_user` creates, `search_and_replace` replaces. */
const WRITE_VERBS = new Set(['send', 'create', 'write', 'delete', 'remove', 'update', 'upsert', 'insert', 'save', 'submit', 'pay', 'charge', 'refund', 'transfer', 'publish', 'deploy', 'notify', 'execute', 'exec', 'commit', 'push', 'merge', 'approve', 'cancel', 'move', 'rename', 'upload', 'add', 'invite', 'assign', 'apply', 'install', 'uninstall', 'kill', 'restart', 'trigger', 'tweet', 'edit', 'replace', 'modify', 'patch', 'checkout', 'purchase', 'buy', 'sell', 'click', 'fill', 'press', 'drag', 'navigate', 'repl', 'eval', 'overwrite', 'append', 'erase', 'purge', 'destroy', 'terminate', 'revoke', 'grant', 'escalate', 'enable', 'disable', 'subscribe', 'unsubscribe', 'reboot', 'shutdown', 'rollback', 'revert', 'truncate', 'wipe']);
/**
 * Words that change something as a name's verb, where names put it, first, but are as often nouns
 * after it: `run_query` runs, `get_run_status` reads; `open_pull_request` opens, `lookup_order` reads.
 */
const WRITE_FIRST = new Set(['post', 'set', 'put', 'book', 'order', 'run', 'email', 'mail', 'reply', 'schedule', 'archive', 'comment', 'close', 'open', 'type', 'select', 'start', 'stop', 'message', 'text', 'share', 'like', 'tag', 'label', 'mark', 'pin', 'star', 'follow', 'reset', 'clear', 'call', 'invoke', 'command', 'script', 'shell', 'bash', 'python', 'drop', 'sync', 'import', 'export', 'link', 'note', 'issue', 'file', 'log', 'record', 'store']);
const READ_WORDS = new Set(['get', 'read', 'fetch', 'search', 'list', 'find', 'lookup', 'query', 'load', 'browse', 'retrieve', 'check', 'describe', 'view', 'show', 'count', 'download', 'inspect', 'weather', 'scrape', 'crawl', 'grep', 'ls', 'cat', 'tail', 'head', 'watch', 'poll', 'price', 'quote', 'snapshot', 'screenshot', 'status', 'info', 'exists', 'peek', 'preview', 'scan']);
const PURE_WORDS = new Set(['calc', 'calculate', 'compute', 'parse', 'format', 'convert', 'validate', 'math', 'sum', 'multiply', 'divide', 'round', 'hash', 'encode', 'decode', 'tokenize', 'sort', 'diff', 'render']);

/**
 * A tool's effect as its name says it, or null when the name gives no hint. A verb that changes
 * something decides wherever it stands (`get_or_create_user`, `search_and_replace`); a word that is
 * as often a noun decides only as the name's first, where names put their verb (`send_email`,
 * `lookupOrder`); then the first word that only looks, or depends only on its input. `shadowlap init`
 * suggests an effect for an unwrapped tool the same way.
 */
export function toolNameEffect(name: string): { effect: 'write' | 'read' | 'pure'; word: string } | null {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const changes = words.find((w) => WRITE_VERBS.has(w)) ?? (words[0] !== undefined && WRITE_FIRST.has(words[0]) ? words[0] : undefined);
  if (changes) return { effect: 'write', word: changes };
  for (const word of words) {
    if (READ_WORDS.has(word)) return { effect: 'read', word };
    if (PURE_WORDS.has(word)) return { effect: 'pure', word };
  }
  return null;
}

/**
 * Tools agent runtimes and providers define and the agent runs itself: the Claude Agent SDK's and
 * Claude Code's built-ins, Anthropic's client tools (bash, the text editor, computer use) and the
 * Responses API's (computer use, the local shell, apply_patch).
 */
const BUILT_IN_WRITES = new Set(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'KillShell', 'KillBash', 'bash', 'computer', 'str_replace_editor', 'str_replace_based_edit_tool', 'text_editor', 'local_shell', 'shell', 'apply_patch']);
const BUILT_IN_READS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead', 'BashOutput', 'TodoWrite', 'TodoRead', 'ExitPlanMode']);

/** A built-in the provider runs itself and answers within the same response (web search, code execution, an MCP connector): nothing runs in the agent. */
function providerRun(block: { name: string; hosted?: true }): boolean {
  return block.hosted === true && !/^(computer(\.|$)|local_shell$|shell$|apply_patch$)/.test(block.name);
}

/** `mcp__<server>__<tool>`, as Claude Code and the Claude Agent SDK name an MCP server's tool: the tool's own name. */
const MCP_PREFIXED = /^mcp__[^_](?:.*?)__(.+)$/;
export function mcpToolName(name: string): string | null {
  return MCP_PREFIXED.exec(name)?.[1] ?? null;
}

/** A tool's effect, and why: declared in the config, a built-in's, its name's, or unknown. An MCP tool's prefix is set aside. */
export function unrecordedEffect(name: string, declared: Readonly<Record<string, 'read' | 'write'>> = {}): { effect: UnrecordedEffect; why: string } {
  const bare = mcpToolName(name);
  const said = Object.hasOwn(declared, name) ? declared[name] : bare !== null && Object.hasOwn(declared, bare) ? declared[bare] : undefined;
  if (said === 'read' || said === 'write') return { effect: said, why: `declared ${said} in shadowlap.config.json` };
  if (BUILT_IN_WRITES.has(name) || name.startsWith('computer.')) return { effect: 'write', why: 'a built-in that writes' };
  if (BUILT_IN_READS.has(name)) return { effect: 'read', why: 'a built-in that only reads' };
  const byName = toolNameEffect(bare ?? name);
  if (byName) return { effect: byName.effect === 'write' ? 'write' : 'read', why: byName.effect === 'write' ? `"${byName.word}" changes something` : byName.effect === 'read' ? `"${byName.word}" only looks` : `"${byName.word}" depends only on its input` };
  return { effect: 'unknown', why: 'its name says nothing of what it does' };
}

// ---- the run ----

/** The tools a model call's answer asked for that the agent runs, in order; none for a call that failed. */
function askedFor(store: Store, call: CallRecord): string[] {
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
export function unrecordedTools(store: Store, runId: string, options: UnrecordedOptions = {}): UnrecordedTool[] {
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
  return [...found].map(([name, { count, firstCallNo }]) => ({ name, count, firstCallNo, ...unrecordedEffect(name, options.declared) }));
}
