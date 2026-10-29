import { existsSync, mkdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  behaviourSlug,
  commandFinder,
  divergenceLine,
  editConfigFile,
  fillCommand,
  fingerprintTool,
  firstMessage,
  isObject,
  loadApiRequest,
  messageOf,
  normalizeConversation,
  packRun,
  unpackRun,
  requestMessage,
  responseInfo,
  safeLine,
  Store,
  type StoreOf,
  type CallMeta,
  type CallRecord,
  type CoverageGroup,
  type CoverageNotPacked,
  type CoveragePackMode,
  type Coverage,
  type EffectOf,
  type InferredCommand,
  type RunRecord,
  type SerializedError,
  type StoredCoveragePack,
} from '@shadowlap/engine';
import { logActivity } from './activity.js';
import { lastLine } from './chaos.js';
import { type ShadowlapConfig } from './config.js';
import { GOLDENS_FOLDER } from './goldens.js';
import { placeholdersFor } from './placeholder-keys.js';
import { providerIds, testAttempt, type GuardMode, type TestAttempt } from './run-agent.js';
import { quoteArgv } from './ui.js';

/**
 * `shadowlap coverage --pack`: a golden of one run of each behaviour no golden covers.
 *
 * An imported run is a capture of model calls: it holds no command, and usually no tool calls, and
 * `test` can't replay what only holds those. So a capture becomes a golden the way the docs say an
 * import does, replayed with the agent's own command, and here without a live call or a real write:
 *
 *   1. its tool calls are rebuilt from its own conversation: each tool the model asked for, with the
 *      arguments it asked with, and the result the next request sent back to the model (in the
 *      shape an MCP tool answers in, for a tool this store knows as one); a tool the capture holds
 *      calls of itself keeps them;
 *   2. the agent's command is run against that, offline, writes stubbed: every model call and tool
 *      result comes from the capture. The command is that of this project's run that sent the same
 *      first request, else the one given after `--`, whose `{message}` stands for the capture's own
 *      input: the text of the first user message it sent (or, as `{message:/regex/}`, the part of it
 *      the regex picks), so each capture is started as production started it;
 *   3. a replay that sent every request the capture holds, and exited 0, is a recording of the agent
 *      as it is now doing what production did, and it is packed into the goldens folder.
 *
 * A replay that forked is not packed, and says where it left the capture: a command that started the
 * agent with another first message than production's is the wrong command (or a template that needs
 * `{message}`); one that started it the same way and still forked means the agent sends something
 * else now, the code having changed since the traffic. With `--fork` and the checks that say what the
 * agent must do instead, such a behaviour is packed anyway, as a golden that forks where the agent
 * parts from production and passes on those checks: the test that the change holds, on production's
 * own input. All of it happens in a store in memory: the project's store gets the golden's activity
 * line and the attempt (coverage_packs), nothing else.
 */

/** How long a reproduction may take before it counts as one that didn't finish. */
const REPLAY_TIMEOUT_MS = 300_000;
/** Runs of a group tried before giving up on it. */
const CANDIDATES = 3;

// ---- rebuilding a capture ----

/** A recorded tool result as the next request carried it back: JSON when it reads as JSON, else the text. */
function resultValue(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

/** A tool error as an agent hands it to the model, `TimeoutError: lookup timed out`, read back into the error the SDK raises. */
function errorValue(content: string): SerializedError {
  const m = /^([A-Za-z_$][\w$]*(?:Error|Exception)): ([\s\S]*)$/.exec(content);
  return m ? { name: m[1]!, message: m[2]! } : { name: 'Error', message: content };
}

interface Asked {
  /** The model call that asked. */
  after: CallRecord;
  name: string;
  input: unknown;
  id: string | null;
  answer: { content: string; isError: boolean } | null;
}

/**
 * Each tool call the model asked for in a capture, with the answer the agent sent back in a later
 * request: by the call's id where the provider gives one, else by name, in order.
 */
export function askedTools(store: StoreOf<'recording'>, calls: readonly CallRecord[]): Asked[] {
  const api = calls.filter((c) => c.kind === 'api').sort((a, b) => a.callNo - b.callNo);
  const asked: Asked[] = [];
  for (const c of api) {
    if (c.end?.outcome !== 'ok') continue;
    for (const t of responseInfo(store, c).tools) asked.push({ after: c, name: t.name, input: t.input, id: t.id, answer: null });
  }
  if (!asked.length) return asked;
  // The tool results each later request carries, in order.
  const results: Array<{ callNo: number; content: string; isError: boolean; id: string | null; name: string | null }> = [];
  const seen = new Set<string>();
  for (const c of api) {
    if (!c.requestRef) continue;
    let body: unknown;
    try {
      body = loadApiRequest(store, c.requestRef);
    } catch {
      continue;
    }
    const conversation = normalizeConversation(body, typeof c.meta.model === 'string' ? c.meta.model : null);
    let n = 0;
    for (const turn of conversation?.turns ?? []) {
      for (const b of turn.blocks) {
        if (b.type !== 'tool_result') continue;
        // Every request carries the whole conversation: a result counts once, from the first request that sent it.
        const key = b.id ? `id:${b.id}` : `n:${n++}:${b.name ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ callNo: c.callNo, content: b.content, isError: b.isError === true, id: b.id ?? null, name: b.name ?? null });
      }
    }
  }
  const used = new Set<number>();
  for (const a of asked) {
    const i = results.findIndex((r, j) => !used.has(j) && r.callNo > a.after.callNo && (a.id ? r.id === a.id : !r.id && (r.name === null || r.name === a.name)));
    if (i < 0) continue;
    used.add(i);
    a.answer = { content: results[i]!.content, isError: results[i]!.isError };
  }
  return asked;
}

/** What `mcpMetaOf` found, per store and tool: a pack rebuilds the same tools for several captures. */
const mcpSeen = new WeakMap<object, Map<string, NonNullable<CallMeta['mcp']> | null>>();

/**
 * How this store last recorded a tool served through `shadowlap mcp`: its `meta.mcp`. An MCP tool's
 * answer reaches the agent as MCP content, so a rebuilt answer must take that shape too, or the
 * agent's MCP client would get a value it never sees from a server.
 */
function mcpMetaOf(store: StoreOf<'readModels'>, tool: string): NonNullable<CallMeta['mcp']> | null {
  let seen = mcpSeen.get(store);
  if (!seen) {
    seen = new Map();
    mcpSeen.set(store, seen);
  }
  if (seen.has(tool)) return seen.get(tool)!;
  const found = readMcpMeta(store, tool);
  seen.set(tool, found);
  return found;
}

function readMcpMeta(store: StoreOf<'readModels'>, tool: string): NonNullable<CallMeta['mcp']> | null {
  const row = store.query(`SELECT json_extract(meta, '$.mcp') AS mcp FROM call_events WHERE phase = 'start' AND kind = 'tool' AND name = ? AND json_extract(meta, '$.mcp') IS NOT NULL ORDER BY at DESC LIMIT 1`, tool)[0];
  if (!row || typeof row.mcp !== 'string') return null;
  try {
    const v = JSON.parse(row.mcp) as { transport?: unknown; server?: unknown };
    return (v.transport === 'stdio' || v.transport === 'http') && typeof v.server === 'string' ? { transport: v.transport, server: v.server } : null;
  } catch {
    return null;
  }
}

/**
 * The capture copied into `target` with its tool calls rebuilt from its conversation, and the
 * command to replay it with. A tool the capture holds calls of itself (a trace that kept them, an
 * HTTP service a HAR saw) keeps those, served as they were recorded. A tool some of whose calls got
 * no answer back (the capture ends before it, or the agent never sent it) is left out whole: its
 * calls run live in the replay, writes stubbed.
 */
export function rebuildCapture(source: StoreOf<'recording' | 'cleanup' | 'readModels'>, target: StoreOf<'recording'>, capture: RunRecord, command: { argv: string[]; cwd: string }, effectOf: EffectOf): { run: RunRecord; tools: number; live: string[] } {
  const calls = source.getCalls(capture.runId);
  for (const hash of source.runBlobRefs(capture.runId)) {
    const bytes = source.getBlob(hash);
    if (bytes) target.putBlob(bytes);
  }
  const kept = new Set(calls.filter((c) => c.kind === 'tool').map((c) => c.name));
  const asked = askedTools(source, calls).filter((a) => !kept.has(a.name));
  const answered = new Set(asked.map((a) => a.name));
  for (const a of asked) if (!a.answer) answered.delete(a.name);
  const live = [...new Set(asked.filter((a) => !answered.has(a.name)).map((a) => a.name))].sort();
  const mcp = new Map([...answered].map((name) => [name, mcpMetaOf(source, name)]));
  const covered = new Set<string>([...(capture.meta?.covers ?? []).filter((c) => c.startsWith('tool:')).map((c) => c.slice(5)), ...answered]);
  const covers: Coverage[] = ['api', ...[...covered].sort().map((n) => `tool:${n}` as Coverage)];
  const run = target.createRun({
    mode: 'record',
    command,
    meta: { covers, ...(capture.meta?.normalizersHash ? { normalizersHash: capture.meta.normalizersHash } : {}), ...(capture.meta?.redactions ? { redactions: capture.meta.redactions } : {}), labels: ['imported'] },
  });
  const occurrences = new Map<string, number>();
  const occurrence = (fingerprint: string) => {
    const n = (occurrences.get(fingerprint) ?? 0) + 1;
    occurrences.set(fingerprint, n);
    return n;
  };
  let callNo = 1;
  let tools = 0;
  let endedAt = capture.startedAt;
  for (const c of [...calls].sort((a, b) => a.callNo - b.callNo)) {
    const no = callNo++;
    const identity = { kind: c.kind, name: c.name, fingerprint: c.fingerprint, occurrence: c.occurrence };
    target.appendCallStart({ runId: run.runId, callNo: no, ...identity, origin: c.origin, effect: c.effect, requestRef: c.requestRef, meta: c.meta, at: c.at });
    if (c.end) target.appendCallEnd(identity, { ...c.end, runId: run.runId, callNo: no });
    endedAt = Math.max(endedAt, c.end?.at ?? c.at);
    if (c.kind !== 'api') continue;
    // The tools this answer asked for, right after it, as the agent ran them.
    for (const a of asked.filter((x) => x.after.callNo === c.callNo && answered.has(x.name) && x.answer)) {
      const args = a.input ?? null;
      const { fingerprint } = fingerprintTool(a.name, args, []);
      // Counted per scope, as a replay counts them when the recording has scopes.
      const scope = typeof c.meta.scope === 'string' ? { scope: c.meta.scope } : {};
      const server = mcp.get(a.name) ?? null;
      const tool = { kind: 'tool' as const, name: a.name, fingerprint, occurrence: occurrence(`${scope.scope ?? ''}\n${fingerprint}`) };
      const at = c.end?.at ?? c.at;
      target.appendCallStart({ runId: run.runId, callNo: callNo++, ...tool, origin: 'live', effect: effectOf(a.name), requestRef: target.putJson({ args }), meta: { ...scope, ...(server ? { mcp: server } : {}) }, at });
      const answer = a.answer!;
      if (server) {
        // An MCP tool answers with content, a failure included (isError): the agent joins its text.
        const result = { content: [{ type: 'text', text: answer.content }], ...(answer.isError ? { isError: true } : {}) };
        target.appendCallEnd(tool, { runId: run.runId, callNo: callNo - 1, attempt: 0, responseRef: target.putJson({ result }), outcome: 'ok', meta: {}, at });
      } else {
        const error = answer.isError ? errorValue(answer.content) : null;
        target.appendCallEnd(tool, { runId: run.runId, callNo: callNo - 1, attempt: 0, responseRef: target.putJson(error ? { error } : { result: resultValue(answer.content) }), outcome: error ? 'error' : 'ok', meta: error ? { error } : {}, at });
      }
      tools++;
    }
  }
  target.transaction(() => {
    target.setRunStart(run.runId, capture.startedAt);
    target.endRun(run.runId, 'completed', endedAt);
  });
  return { run: target.getRun(run.runId)!, tools, live };
}

/** A folder for the new golden under `folder`, named after its behaviour: `-2`, `-3`… when that is taken. */
export function goldenDir(projectDir: string, folder: string, group: CoverageGroup): string {
  const base = behaviourSlug(group.behaviour, group.key);
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base}-${i}`;
    if (!existsSync(join(projectDir, folder, name))) return join(folder, name);
  }
}

// ---- packing a group ----

/** What `--pack` made of one group, as `coverage --json` prints it. */
export interface PackJson {
  key: string;
  /** The golden written, or null when none could be. */
  golden: string | null;
  /** The run packed: the replay that reproduced the capture, or the capture rebuilt for a golden that forks. */
  runId: string | null;
  /** The imported run it reproduces. */
  from: string | null;
  /** The command it ran, and where that came from: the run here that sent the same first request, or `--`. */
  command: { argv: string[]; from: string } | null;
  /** `replay` for a golden that replays the capture, `fork` for one that forks (`--fork`); null when not packed. */
  mode: CoveragePackMode | null;
  /** Why it wasn't packed, as a word; null when it was. */
  reason: CoverageNotPacked | null;
  /** Why it wasn't packed, in a sentence. */
  why: string | null;
}

export interface PackContext {
  /** The project's store: the captures, the golden's activity line, and what was made of each group. */
  store: Store;
  projectDir: string;
  config: Pick<ShadowlapConfig, 'normalize' | 'redact' | 'prices' | 'clock' | 'http'>;
  /** The agent's command given after `--`, its `{message}` filled for each capture: tried after the one a run here says. */
  argv?: string[] | null;
  effectOf: EffectOf;
  guard: GuardMode;
  folder?: string;
  /**
   * `--fork`: what the agent must do on this input now, as a tests entry's `expect`. The behaviour is
   * packed as a golden that forks and passes on these checks, its tests entry written with them,
   * whether or not the agent still reproduces it.
   */
  fork?: { expect: Record<string, unknown> } | null;
  /** Finds the command a run here says: one per pack, reading the store once. */
  finder?: (capture: RunRecord) => InferredCommand | null;
  /** Says what it is doing, a line at a time. */
  log?: (line: string) => void;
  timeoutMs?: number;
  now?: () => number;
}

/** One reproduction of a capture with one command. */
interface Reproduction {
  capture: RunRecord;
  command: { argv: string[]; from: string };
  attempt: TestAttempt;
  /** The replay's first message, when it forked at its first model call (a clock read may come before it). */
  sent: string | null;
}

const short = (id: string) => id.slice(0, 10);
const quoted = (s: string) => `“${safeLine(s.length > 80 ? `${s.slice(0, 79)}…` : s)}”`;

/** Rebuilds a capture and replays it with a command, offline, in a store in memory of its own. */
async function reproduce(capture: RunRecord, command: { argv: string[]; from: string }, o: PackContext): Promise<{ mem: Store; rebuilt: RunRecord; result: Reproduction }> {
  const offline = Object.fromEntries([...Object.keys(providerIds()), 'http'].map((id) => [id, 'offline']));
  const mem = Store.open(':memory:');
  try {
    const rebuilt = rebuildCapture(o.store, mem, capture, { argv: command.argv, cwd: o.projectDir }, o.effectOf);
    const live = rebuilt.live.length ? `; ${rebuilt.live.map(safeLine).join(', ')} run${rebuilt.live.length === 1 ? 's' : ''} live (no answer to every call in the capture)` : '';
    o.log?.(`[shadowlap] reproducing ${capture.runId} with ${safeLine(quoteArgv(command.argv))}: offline, ${rebuilt.tools} tool result${rebuilt.tools === 1 ? '' : 's'} from its conversation, writes stubbed${live}`);
    const attempt = await testAttempt(mem, rebuilt.run, {
      cwd: o.projectDir,
      upstreams: offline,
      // Offline, the agent gets a placeholder for each key the environment lacks.
      extraEnv: placeholdersFor(mem, rebuilt.run, 'offline'),
      writes: 'stub',
      guard: o.guard,
      normalizers: o.config.normalize,
      prices: o.config.prices,
      clock: o.config.clock,
      http: o.config.http,
      spec: null,
      argv: command.argv,
      timeoutMs: o.timeoutMs ?? REPLAY_TIMEOUT_MS,
      onSignal: 'exit',
    });
    const s = attempt.ended.summary;
    let sent: string | null = null;
    const first = s.divergence ? mem.getCalls(s.runId).find((c) => c.kind === 'api' && c.requestRef) : undefined;
    if (first?.requestRef && s.divergence?.callNo === first.callNo) {
      try {
        sent = requestMessage(loadApiRequest(mem, first.requestRef), typeof first.meta.model === 'string' ? first.meta.model : null);
      } catch {
        sent = null;
      }
    }
    return { mem, rebuilt: rebuilt.run, result: { capture, command, attempt, sent } };
  } catch (err) {
    mem.close();
    throw err;
  }
}

/** Why a reproduction didn't reproduce its capture, and whether `--fork` may pack the capture anyway. */
function notReproduced(r: Reproduction, message: string | null): { reason: CoverageNotPacked; why: string; forkable: boolean } {
  const s = r.attempt.ended.summary;
  const cmd = safeLine(quoteArgv(r.command.argv));
  if (s.divergence) {
    // At its first request, a different first message means the command started the agent with other input.
    if (message !== null && r.sent !== null && r.sent !== message) {
      return { reason: 'other-message', forkable: false, why: `${cmd} starts the agent with another first message than ${short(r.capture.runId)}'s: production sent ${quoted(message)}, the agent sent ${quoted(r.sent)}; put {message} where the agent's input goes` };
    }
    return { reason: 'not-reproduced', forkable: true, why: `${cmd} doesn't reproduce ${short(r.capture.runId)}: ${divergenceLine(s.divergence)}, where the agent sends something else now` };
  }
  const said = lastLine(r.attempt.output);
  return { reason: 'agent-error', forkable: false, why: `${cmd} exited with code ${r.attempt.code} on what ${short(r.capture.runId)} got back${said ? ` (${said})` : ''}` };
}

/** Packs a run of the store in memory as the group's golden; writes its tests entry for one that forks. */
function packGolden(mem: Store, runId: string, group: CoverageGroup, capture: RunRecord, command: { argv: string[]; from: string }, mode: CoveragePackMode, o: PackContext): PackJson {
  const folder = o.folder ?? GOLDENS_FOLDER;
  const rel = goldenDir(o.projectDir, folder, group);
  const dir = resolve(o.projectDir, rel);
  mkdirSync(resolve(o.projectDir, folder), { recursive: true });
  const packed = packRun(mem, runId, dir, { redact: o.config.redact });
  // The golden is this machine's: made here, from the agent's own command. Kept in the project's
  // store as a recording of its own, so `test` runs its command without asking, as it runs any golden
  // recorded here (golden-consent.ts); a pack someone sent is held as imported.
  unpackRun(o.store, dir, { madeHere: true });
  const where = relative(o.projectDir, dir).split('\\').join('/');
  if (mode === 'fork' && o.fork) {
    const expect = o.fork.expect;
    editConfigFile(o.projectDir, {}, (data) => {
      const tests: Record<string, unknown> = isObject(data.tests) ? data.tests : {};
      tests[where] = { fork: true, expect };
      data.tests = tests;
    });
  }
  logActivity(o.store, { kind: 'golden.packed', runId: capture.runId, ref: where, data: { runs: packed.runs.length, calls: packed.calls, redacted: packed.redacted, from: 'coverage', behaviour: group.key, run: runId, ...(mode === 'fork' ? { fork: true } : {}) } });
  return { key: group.key, golden: where, runId, from: capture.runId, command, mode, reason: null, why: null };
}

/**
 * Makes a golden of one run of a group: the newest run that the agent, replayed with its command,
 * reproduces. With `--fork`, the newest one it no longer reproduces, started as production started
 * it, is packed instead as a golden that forks. What it made, or why not, is kept in the store.
 */
export async function packGroup(group: CoverageGroup, members: ReadonlyMap<string, RunRecord>, o: PackContext): Promise<PackJson> {
  const made = await packOne(group, members, o);
  try {
    const kept: StoredCoveragePack = { key: made.key, at: (o.now ?? Date.now)(), golden: made.golden, runId: made.runId, from: made.from, mode: made.mode, reason: made.reason, why: made.why, command: made.command };
    o.store.saveCoveragePack(kept);
  } catch (err) {
    o.log?.(`[shadowlap] what --pack made of ${group.key} was not kept: ${messageOf(err)}`);
  }
  return made;
}

async function packOne(group: CoverageGroup, members: ReadonlyMap<string, RunRecord>, o: PackContext): Promise<PackJson> {
  const find = o.finder ?? commandFinder(o.store);
  const none = (reason: CoverageNotPacked, why: string, from: string | null = null, command: PackJson['command'] = null): PackJson => ({ key: group.key, golden: null, runId: null, from, command, mode: null, reason, why });
  const candidates = group.runIds.map((id) => members.get(id) ?? o.store.getRun(id)).filter((r): r is RunRecord => !!r).slice(0, CANDIDATES);
  if (!candidates.length) return none('gone', 'its runs are no longer in the store');
  let last: PackJson | null = null;
  // Why it wasn't packed: what a command a run here says found says more than a command given for
  // every behaviour does, and that says more than having no command; the newest capture's, at each.
  const rank = (p: PackJson) => (p.reason === 'no-command' ? 0 : p.command?.from === '--' ? 1 : 2);
  const keep = (p: PackJson) => {
    if (!last || rank(p) > rank(last)) last = p;
  };
  /** The newest capture the agent, started as production started it, no longer reproduces: what --fork packs. */
  let forkable: { capture: RunRecord; command: { argv: string[]; from: string } } | null = null;
  for (const capture of candidates) {
    const message = firstMessage(o.store, capture.runId);
    const commands: Array<{ argv: string[]; from: string }> = [];
    const inferred = find(capture);
    if (inferred) commands.push(inferred);
    let unfilled: string | null = null;
    if (o.argv?.length) {
      const filled = fillCommand(o.argv, message);
      if ('why' in filled) unfilled = filled.why;
      else if (!inferred || quoteArgv(filled.argv) !== quoteArgv(inferred.argv)) commands.push({ argv: filled.argv, from: '--' });
    }
    if (!commands.length) {
      keep(none('no-command', unfilled ? `no command for ${short(capture.runId)}: ${unfilled}` : `no command: no run here sent ${short(capture.runId)}'s first request, so nothing says what starts the agent; give its command after --, with {message} where its input goes`, capture.runId));
      continue;
    }
    for (const command of commands) {
      const { mem, result } = await reproduce(capture, command, o);
      try {
        const s = result.attempt.ended.summary;
        if (!s.divergence && result.attempt.code === 0) return packGolden(mem, s.runId, group, capture, command, o.fork ? 'fork' : 'replay', o);
        const why = notReproduced(result, message);
        keep(none(why.reason, why.why, capture.runId, command));
        if (why.forkable) forkable ??= { capture, command };
      } finally {
        mem.close();
      }
    }
  }
  if (o.fork && forkable) {
    // Production's run, rebuilt with the command that starts the agent as production did: the golden
    // forks where the agent parts from it, and passes on the checks --fork gave.
    const mem = Store.open(':memory:');
    try {
      const rebuilt = rebuildCapture(o.store, mem, forkable.capture, { argv: forkable.command.argv, cwd: o.projectDir }, o.effectOf);
      return packGolden(mem, rebuilt.run.runId, group, forkable.capture, forkable.command, 'fork', o);
    } finally {
      mem.close();
    }
  }
  return last ?? none('no-command', 'none of its runs could be reproduced');
}
