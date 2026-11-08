import { createHash } from 'node:crypto';
import { normalizeConversation, type Turn } from './conversation.js';
import { responseInfo, type RequestedTool, type RunConversations } from './conversations.js';
import { isHandover } from './decisions.js';
import { isObject } from './is-object.js';
import { isReservedScope } from './judge-scope.js';
import { loadApiRequest } from './manifest.js';
import type { StoreOf } from './store.js';
import type { CallRecord } from './types.js';

/**
 * The agents of a run: which agent made each call, and which call started each sub-agent. A run of
 * several agents is named by its scopes (`scope()` in the SDKs) where its author gave them; most give
 * none, and a trace imported from elsewhere names its agents in its spans. Each conversation
 * (conversations.ts) is one agent's, named by the first of these that says:
 *
 * - its scope, which the author gave: a conversation in `researcher` is the agent `researcher`;
 * - the agent an imported trace's spans name (`meta.agent`, kept on each model call);
 * - the tool that started it: a model call of another conversation asked for a tool (Claude Code's
 *   `Task`, an agent called as a tool, CrewAI's delegation) whose words open this conversation's first
 *   request, after that call's answer came. It is a sub-agent of that call's agent, named for what the
 *   tool started (`claude-code/Explore`), and it was started by that call (`spawnedBy`);
 * - otherwise its system prompt: the conversations sent one system prompt (its numbers aside, a date
 *   in it) are one agent's, named by who the prompt says it is ("You are a research assistant":
 *   `research-assistant`), else `agent-2`. In a scope, the first such agent is the scope itself.
 *
 * A handoff (`transfer_to_billing`) keeps the conversation but changes its agent: the calls after it
 * are `billing`'s. Every name is decided from the calls before it, so a recording's calls keep the
 * names they were first given as the run goes on, and the finished run read whole names them alike.
 * A run of one agent names it too; the dashboard shows agents only where there are two or more.
 * Names are for reading only: replay matches calls by scope, never by these.
 */

export interface CallAgent {
  /** The agent that made the call, its path's parts joined by `/`; null for a call in no conversation and no scope. */
  agent: string | null;
  /** A call of a sub-agent's conversation: the model call whose tool started it. */
  spawnedBy: number | null;
}

const NONE: CallAgent = Object.freeze({ agent: null, spawnedBy: null });

/** How many model calls with a linking argument a conversation's first request looks back through for what started it. */
const SPAWN_LOOK_BACK = 64;
/** How many model calls it looks back through at most, linking or not: a batch of thousands is read in time that grows with it. */
const SPAWN_SCAN = 256;
/** The fewest characters of a tool's argument that link a conversation to it: shorter ones are too common to tell. */
const LINK_MIN = 24;
/** How much of an argument, from its start, has to open the conversation. */
const LINK_MAX = 400;
/** How much of a first request's system prompt and user turns is searched. */
const TEXT_MAX = 65_536;
/** The longest part of an agent's path, and the longest path, as the sidecar takes a scope's. */
const PART_MAX = 60;
const PATH_MAX = 200;

interface Conversation {
  /** The agent its first model call was made by: the one a handoff hands back to. */
  root: string;
  scope: string;
  spawnedBy: number | null;
  /** Its model calls' agents, in call order. */
  steps: Array<[callNo: number, agent: string]>;
  lastModel: number;
  /** Its first request's first user message, whole, or null. */
  input: string | null;
}

interface Link {
  tool: RequestedTool;
  needle: string;
}

interface RequestText {
  system: string;
  /** The system prompt and the user turns, one line, cut at TEXT_MAX. */
  text: string;
  firstUser: string | null;
}

const scopeOf = (c: CallRecord): string => (typeof c.meta.scope === 'string' ? c.meta.scope : '');
const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** One part of an agent's path: one line, no `/`, at most PART_MAX characters. */
function part(s: string): string {
  return flat(s.replace(/[\u0000-\u001f\u007f]/g, ' '))
    .replace(/\//g, '-')
    .slice(0, PART_MAX);
}

const join = (parent: string | null, child: string): string => (parent ? `${parent}/${child}` : child).slice(0, PATH_MAX);
const parentOf = (path: string): string | null => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null);
const leaf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
/** Two names for one agent: `Triage Agent`, `triage_agent`. */
const sameName = (a: string, b: string): boolean => a.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') === b.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** An imported trace's agent for a model call, or null. */
function tracedAgent(c: CallRecord): string | null {
  const a = c.meta.agent;
  if (typeof a !== 'string') return null;
  const path = a.split('/').map(part).filter(Boolean).join('/').slice(0, PATH_MAX);
  return path || null;
}

const textOf = (turn: Turn): string =>
  turn.blocks
    .filter((b): b is Extract<Turn['blocks'][number], { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join(' ');

/** What a model request says before any answer: its system prompt and its user turns. */
function requestText(store: StoreOf<'recording'>, c: CallRecord): RequestText {
  let body: unknown;
  try {
    body = c.requestRef ? loadApiRequest(store, c.requestRef) : undefined;
  } catch {
    body = undefined;
  }
  const conversation = body === undefined ? null : normalizeConversation(body);
  const system: string[] = [];
  const user: string[] = [];
  let firstUser: string | null = null;
  for (const turn of conversation?.turns ?? []) {
    if (turn.role === 'system') system.push(textOf(turn));
    else if (turn.role === 'user') {
      const t = textOf(turn).trim();
      if (t && firstUser === null) firstUser = t;
      user.push(t);
    }
  }
  const s = flat(system.join(' '));
  return { system: s, text: flat(`${s} ${user.join(' ')}`).slice(0, TEXT_MAX), firstUser };
}

/** The agents' system prompts, told apart with their numbers left out (a date or a ticket count in them). */
const promptKey = (system: string): string => (system ? createHash('sha256').update(system.replace(/\d+/g, '0')).digest('base64url').slice(0, 16) : '');

/** Words that end who a prompt says the agent is: "a research assistant *that* …". */
const ROLE_STOP = new Set(
  'a an the who that which for with in at on to and or of by from as is are will can should must your you i now here responsible tasked working helping acting designed built called named part whose'.split(' '),
);

/** Who a system prompt says the agent is, as a name: "You are Claude Code, …" is `claude-code`; null when it doesn't say. */
export function roleName(system: string): string | null {
  const m = /\byou are (?:an? |the )?([^.,:;!?()\n]{2,80})/iu.exec(system.slice(0, 400));
  if (!m) return null;
  const words: string[] = [];
  for (const w of m[1]!.split(/\s+/)) {
    const word = w.replace(/['’]s$/u, '').replace(/[^\p{L}\p{N}_-]/gu, '');
    if (!word || ROLE_STOP.has(word.toLowerCase()) || words.length === 4) break;
    words.push(word.toLowerCase());
  }
  const name = words.join('-');
  return name.length >= 2 ? part(name) : null;
}

/** The string arguments a tool was asked for, nested ones too, JSON in a string read. */
function strings(v: unknown, depth = 0, out: string[] = []): string[] {
  if (typeof v === 'string') {
    const t = v.trim();
    if (depth < 3 && (t.startsWith('{') || t.startsWith('['))) {
      try {
        return strings(JSON.parse(t), depth + 1, out);
      } catch {
        // a string that only looks like JSON
      }
    }
    out.push(v);
  } else if (depth < 3 && (Array.isArray(v) || isObject(v))) {
    for (const x of Object.values(v)) strings(x, depth + 1, out);
  }
  return out;
}

const named = (input: unknown, ...keys: string[]): string | null => {
  if (!isObject(input)) return null;
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return part(v);
  }
  return null;
};

/**
 * What a tool that started a sub-agent names it: Claude Code's `Task` by its `subagent_type`, CrewAI's
 * delegation by its `coworker`, an agent called as a tool by the tool's name.
 */
export function spawnedName(tool: { name: string; input: unknown }): string {
  if (/^(task|agent)$/i.test(tool.name)) return named(tool.input, 'subagent_type', 'agent', 'description') ?? part(tool.name);
  return named(tool.input, 'coworker', 'agent', 'agent_name', 'subagent', 'subagent_type', 'assistant') ?? part(tool.name);
}

/** The agent a handoff tool hands to: `transfer_to_billing` is `billing`; a bare `handoff` names it in its arguments. */
export function handoverTarget(tool: { name: string; input: unknown }): string | null {
  const bare = tool.name.replace(/^(transfer_to_|handoff_to_|hand_off_to_)/i, '');
  if (bare && bare !== tool.name) return part(bare);
  return named(tool.input, 'agent', 'agent_name', 'to', 'target', 'assistant');
}

/**
 * A run's agents, worked out as its model calls arrive: `update` with the calls and their
 * conversations as they stand reads each new model call once, in call order, so a recording's page
 * that asks every two seconds pays for the calls that arrived since; `runAgents` reads a finished run.
 */
export class RunAgents {
  private readonly convs = new Map<number, Conversation>();
  /** The model calls read, in call order: where a first request looks back for what started it. */
  private readonly models: number[] = [];
  private readonly agentOf = new Map<number, string>();
  private readonly byNo = new Map<number, CallRecord>();
  /** Each scope's agents by system prompt (promptKey), and the names given in it. */
  private readonly roles = new Map<string, { byKey: Map<string, string>; taken: Set<string> }>();
  private readonly links = new Map<number, { rec: CallRecord; list: Link[] }>();
  private conversations: RunConversations | null = null;

  constructor(private readonly store: StoreOf<'recording'>) {}

  update(calls: readonly CallRecord[], conversations: RunConversations): this {
    this.conversations = conversations;
    for (const c of calls) this.byNo.set(c.callNo, c);
    for (const c of calls) {
      if (c.kind !== 'api' || this.agentOf.has(c.callNo) || !conversations.requests.has(c.callNo)) continue;
      const n = conversations.byCall.get(c.callNo)?.conversation;
      if (typeof n === 'number') this.place(c, n);
    }
    return this;
  }

  /** The agent of a call, and the call that started its conversation as a sub-agent. */
  of(callNo: number): CallAgent {
    const placed = this.conversations?.byCall.get(callNo);
    const conv = typeof placed?.conversation === 'number' ? this.convs.get(placed.conversation) : undefined;
    if (!conv) {
      const c = this.byNo.get(callNo);
      return c ? ownAgent(c) : NONE;
    }
    // A tool call is the agent's that asked for it: a handoff's own tool call is the agent's that handed off.
    return { agent: stepAt(conv.steps, placed?.requestedBy ?? callNo), spawnedBy: conv.spawnedBy };
  }

  /** A conversation's first user message, whole, as its first request holds it; null when it holds none. */
  input(conversation: number): string | null {
    return this.convs.get(conversation)?.input ?? null;
  }

  private place(c: CallRecord, n: number): void {
    const traced = tracedAgent(c);
    let conv = this.convs.get(n);
    let agent: string;
    if (!conv) {
      const scope = scopeOf(c);
      const req = requestText(this.store, c);
      const spawn = isReservedScope(scope) ? null : this.spawner(c, req.text);
      agent = traced ?? (spawn ? this.spawnedAgent(c, scope, spawn) : this.byPrompt(scope, req.system));
      conv = { root: agent, scope, spawnedBy: spawn?.model ?? null, steps: [], lastModel: c.callNo, input: req.firstUser };
      this.convs.set(n, conv);
    } else {
      const current = conv.steps.at(-1)![1];
      agent = traced ?? this.handedTo(conv, current) ?? current;
      conv.lastModel = c.callNo;
    }
    conv.steps.push([c.callNo, agent]);
    this.agentOf.set(c.callNo, agent);
    this.models.push(c.callNo);
  }

  /** The model call, of another conversation, whose tool's words open this request, answered before it was sent. */
  private spawner(c: CallRecord, text: string): { model: number; tool: RequestedTool } | null {
    if (text.length < LINK_MIN) return null;
    const from = Math.max(0, this.models.length - SPAWN_SCAN);
    for (let i = this.models.length - 1, looked = 0; i >= from && looked < SPAWN_LOOK_BACK; i--) {
      const m = this.byNo.get(this.models[i]!)!;
      if (isReservedScope(scopeOf(m))) continue;
      const links = this.linksOf(m);
      if (!links.length) continue;
      looked++;
      if (!m.end || m.end.at > c.at) continue;
      for (const l of links) if (text.includes(l.needle)) return { model: m.callNo, tool: l.tool };
    }
    return null;
  }

  private linksOf(m: CallRecord): Link[] {
    const had = this.links.get(m.callNo);
    if (had?.rec === m) return had.list;
    const list: Link[] = [];
    for (const tool of responseInfo(this.store, m).tools) {
      if (isHandover(tool.name)) continue;
      for (const s of strings(tool.input)) {
        const needle = flat(s).slice(0, LINK_MAX);
        if (needle.length >= LINK_MIN) list.push({ tool, needle });
      }
    }
    this.links.set(m.callNo, { rec: m, list });
    return list;
  }

  /** A sub-agent's name: the scope its author gave it, else what started it, under its caller. */
  private spawnedAgent(c: CallRecord, scope: string, spawn: { model: number; tool: RequestedTool }): string {
    const caller = this.byNo.get(spawn.model)!;
    if (scope && scope !== scopeOf(caller)) return scope;
    return join(this.agentOf.get(spawn.model) ?? null, spawnedName(spawn.tool));
  }

  /** A conversation's agent by its system prompt, in its scope: the scope itself for the first, a name for each after. */
  private byPrompt(scope: string, system: string): string {
    if (isReservedScope(scope)) return scope;
    let r = this.roles.get(scope);
    if (!r) this.roles.set(scope, (r = { byKey: new Map(), taken: new Set() }));
    const key = promptKey(system);
    let name = r.byKey.get(key);
    if (name === undefined) {
      if (scope && !r.byKey.size) name = scope;
      else {
        const base = join(scope || null, roleName(system) ?? `agent-${r.byKey.size + 1}`);
        name = base;
        for (let k = 2; r.taken.has(name); k++) name = `${base}-${k}`;
      }
      r.byKey.set(key, name);
      r.taken.add(name);
    }
    return name;
  }

  /** The agent the previous model call of a conversation handed it to, or null when it handed off to none. */
  private handedTo(conv: Conversation, current: string): string | null {
    const prev = this.byNo.get(conv.lastModel);
    const tool = prev ? responseInfo(this.store, prev).tools.find((t) => isHandover(t.name)) : undefined;
    const target = tool ? handoverTarget(tool) : null;
    if (!target || sameName(target, leaf(current))) return null;
    if (sameName(target, leaf(conv.root))) return conv.root;
    // Inside a scope its author gave, the agent handed to stays in it.
    if (conv.scope && conv.root === conv.scope) return join(conv.scope, target);
    return join(parentOf(conv.root), target);
  }
}

/** The agent at a call: that of the latest model call of its conversation up to it, else its first's. */
function stepAt(steps: ReadonlyArray<[number, string]>, callNo: number): string {
  let lo = 0;
  let hi = steps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (steps[mid]![0] <= callNo) lo = mid + 1;
    else hi = mid;
  }
  return steps[Math.max(0, lo - 1)]![1];
}

/** A call's agent from what it carries itself, an imported trace's agent or else its scope: for a call read without its run's conversations. */
export function ownAgent(c: CallRecord): CallAgent {
  const agent = tracedAgent(c) ?? (scopeOf(c) || null);
  return agent ? { agent, spawnedBy: null } : NONE;
}

/** A finished run's agents, from its calls and their conversations (runConversations). */
export function runAgents(store: StoreOf<'recording'>, calls: readonly CallRecord[], conversations: RunConversations): RunAgents {
  return new RunAgents(store).update(calls, conversations);
}
