import { existsSync, mkdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  behaviourSlug,
  commandIsImported,
  divergenceLine,
  fingerprintTool,
  hasRecordedCommand,
  loadApiRequest,
  normalizeConversation,
  packRun,
  responseInfo,
  runKind,
  safeLine,
  Store,
  type CallRecord,
  type CoverageGroup,
  type Coverage,
  type EffectOf,
  type RunRecord,
  type SerializedError,
} from '@shadowlap/engine';
import { logActivity } from './activity.js';
import { type ShadowlapConfig } from './config.js';
import { type PackJson } from './coverage.js';
import { GOLDENS_FOLDER } from './goldens.js';
import { providerIds, testAttempt, type GuardMode } from './run-agent.js';
import { quoteArgv } from './ui.js';

/**
 * `shadowlap coverage --pack`: a golden of one run of each behaviour no golden covers.
 *
 * An imported run is a capture of model calls: it holds no tool calls and no command, and `test`
 * can't replay what only holds those. So a capture becomes a golden the way the docs say an import
 * does, replayed with the agent's own command, and here without a live call or a real write:
 *
 *   1. its tool calls are rebuilt from its own conversation: each tool the model asked for, with the
 *      arguments it asked with, and the result the next request sent back to the model;
 *   2. the agent's command (given after `--`, or the command of this project's recording that sent
 *      the same first request) is run against that, offline, writes stubbed: every model call and
 *      tool result comes from the capture;
 *   3. a replay that sent every request the capture holds, and exited 0, is a recording of the agent
 *      as it is now doing what production did, and it is packed into the goldens folder.
 *
 * A replay that forked (the agent sends something else now: the code changed since the traffic, or
 * a tool's arguments are not the model's) is not packed, and says where it left the capture. All of
 * it happens in a store in memory: the project's store gets the golden's activity line, nothing else.
 */

/** How long a reproduction may take before it counts as one that didn't finish. */
const REPLAY_TIMEOUT_MS = 300_000;
/** Runs of a group tried before giving up on it. */
const CANDIDATES = 3;

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
export function askedTools(store: Store, calls: readonly CallRecord[]): Asked[] {
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

/**
 * The capture copied into `target` with its tool calls rebuilt from its conversation, and the
 * command to replay it with. A tool some of whose calls got no answer back (the capture ends before
 * it, or the agent never sent it) is left out whole: its calls run live in the replay, writes stubbed.
 */
export function rebuildCapture(source: Store, target: Store, capture: RunRecord, command: { argv: string[]; cwd: string }, effectOf: EffectOf): { run: RunRecord; tools: number; live: string[] } {
  const calls = source.getCalls(capture.runId);
  for (const hash of source.runBlobRefs(capture.runId)) {
    const bytes = source.getBlob(hash);
    if (bytes) target.putBlob(bytes);
  }
  const asked = askedTools(source, calls);
  const answered = new Set(asked.map((a) => a.name));
  for (const a of asked) if (!a.answer) answered.delete(a.name);
  const live = [...new Set(asked.filter((a) => !answered.has(a.name)).map((a) => a.name))].sort();
  const covers: Coverage[] = ['api', ...[...answered].sort().map((n) => `tool:${n}` as Coverage)];
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
    if (c.kind === 'tool') continue;
    // The tools this answer asked for, right after it, as the agent ran them.
    for (const a of asked.filter((x) => x.after.callNo === c.callNo && answered.has(x.name) && x.answer)) {
      const args = a.input ?? null;
      const { fingerprint } = fingerprintTool(a.name, args, []);
      // Counted per scope, as a replay counts them when the recording has scopes.
      const scope = typeof c.meta.scope === 'string' ? { scope: c.meta.scope } : {};
      const tool = { kind: 'tool' as const, name: a.name, fingerprint, occurrence: occurrence(`${scope.scope ?? ''}\n${fingerprint}`) };
      const at = c.end?.at ?? c.at;
      target.appendCallStart({ runId: run.runId, callNo: callNo++, ...tool, origin: 'live', effect: effectOf(a.name), requestRef: target.putJson({ args }), meta: scope, at });
      const error = a.answer!.isError ? errorValue(a.answer!.content) : null;
      target.appendCallEnd(tool, { runId: run.runId, callNo: callNo - 1, attempt: 0, responseRef: target.putJson(error ? { error } : { result: resultValue(a.answer!.content) }), outcome: error ? 'error' : 'ok', meta: error ? { error } : {}, at });
      tools++;
    }
  }
  target.transaction(() => {
    target.setRunStart(run.runId, capture.startedAt);
    target.endRun(run.runId, 'completed', endedAt);
  });
  return { run: target.getRun(run.runId)!, tools, live };
}

/**
 * The command that reproduces a capture, when none is given: the command of this project's newest
 * run whose first model call sent exactly the capture's first request, as its own recording (never a
 * command that came from a pack or the team store, which someone else chose). Null when none did.
 */
export function inferCommand(store: Store, capture: RunRecord): { argv: string[]; from: string } | null {
  const first = store.getCalls(capture.runId).find((c) => c.kind === 'api' && c.requestRef);
  if (!first?.requestRef) return null;
  const rows = store.query(
    `SELECT e.run_id AS run_id FROM call_events e JOIN runs r ON r.run_id = e.run_id
     WHERE e.phase = 'start' AND e.kind = 'api' AND e.request_ref = ? AND e.run_id <> ?
       AND e.call_no = (SELECT MIN(f.call_no) FROM call_events f WHERE f.run_id = e.run_id AND f.phase = 'start' AND f.kind = 'api')
     ORDER BY r.started_at DESC, r.run_id DESC LIMIT 50`,
    first.requestRef,
    capture.runId,
  );
  for (const row of rows) {
    const run = store.getRun(String(row.run_id));
    if (!run || run.status === 'running' || !hasRecordedCommand(run) || commandIsImported(run) || runKind(run) === 'capture') continue;
    return { argv: run.command.argv, from: run.runId };
  }
  return null;
}

/** A folder for the new golden under `folder`, named after its behaviour: `-2`, `-3`… when that is taken. */
export function goldenDir(projectDir: string, folder: string, group: CoverageGroup): string {
  const base = behaviourSlug(group.behaviour, group.key);
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base}-${i}`;
    if (!existsSync(join(projectDir, folder, name))) return join(folder, name);
  }
}

export interface PackContext {
  /** The project's store: the captures, and the golden's activity line. */
  store: Store;
  projectDir: string;
  config: Pick<ShadowlapConfig, 'normalize' | 'redact' | 'prices' | 'clock' | 'http'>;
  /** The agent's command, given after `--`: every group is replayed with it. */
  argv?: string[] | null;
  effectOf: EffectOf;
  guard: GuardMode;
  folder?: string;
  /** Says what it is doing, a line at a time. */
  log?: (line: string) => void;
  timeoutMs?: number;
}

/** Makes a golden of one run of a group: the newest run that the agent, replayed with its command, reproduces. */
export async function packGroup(group: CoverageGroup, members: ReadonlyMap<string, RunRecord>, o: PackContext): Promise<PackJson> {
  const folder = o.folder ?? GOLDENS_FOLDER;
  const offline = Object.fromEntries([...Object.keys(providerIds()), 'http'].map((id) => [id, 'offline']));
  const tried: string[] = [];
  const candidates = group.runIds.map((id) => members.get(id) ?? o.store.getRun(id)).filter((r): r is RunRecord => !!r).slice(0, CANDIDATES);
  if (!candidates.length) return { key: group.key, golden: null, runId: null, from: null, command: null, why: 'its runs are no longer in the store' };
  let last: PackJson | null = null;
  for (const capture of candidates) {
    const command = o.argv?.length ? { argv: o.argv, from: '--' } : inferCommand(o.store, capture);
    if (!command) {
      tried.push(capture.runId);
      last = { key: group.key, golden: null, runId: null, from: capture.runId, command: null, why: `no command: no recording in this store sent ${capture.runId.slice(0, 10)}'s first request, so nothing says what starts the agent; give its command after --` };
      continue;
    }
    const mem = Store.open(':memory:');
    try {
      const rebuilt = rebuildCapture(o.store, mem, capture, { argv: command.argv, cwd: o.projectDir }, o.effectOf);
      const live = rebuilt.live.length ? `; ${rebuilt.live.map(safeLine).join(', ')} run${rebuilt.live.length === 1 ? 's' : ''} live (no answer to every call in the capture)` : '';
      o.log?.(`[shadowlap] reproducing ${capture.runId} with ${safeLine(quoteArgv(command.argv))}: offline, ${rebuilt.tools} tool result${rebuilt.tools === 1 ? '' : 's'} from its conversation, writes stubbed${live}`);
      const attempt = await testAttempt(mem, rebuilt.run, {
        cwd: o.projectDir,
        upstreams: offline,
        extraEnv: {},
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
      if (s.divergence || attempt.code !== 0) {
        const where = s.divergence ? divergenceLine(s.divergence) : `the agent exited with code ${attempt.code}`;
        const tail = attempt.output.trim().split('\n').slice(-1)[0];
        last = { key: group.key, golden: null, runId: null, from: capture.runId, command, why: `${safeLine(quoteArgv(command.argv))} doesn't reproduce ${capture.runId.slice(0, 10)}: ${where}${!s.divergence && tail ? ` (${safeLine(tail).slice(0, 160)})` : ''}` };
        continue;
      }
      const rel = goldenDir(o.projectDir, folder, group);
      const dir = resolve(o.projectDir, rel);
      mkdirSync(resolve(o.projectDir, folder), { recursive: true });
      const packed = packRun(mem, s.runId, dir, { redact: o.config.redact });
      const where = relative(o.projectDir, dir).split('\\').join('/');
      logActivity(o.store, { kind: 'golden.packed', runId: capture.runId, ref: where, data: { runs: packed.runs.length, calls: packed.calls, redacted: packed.redacted, from: 'coverage', behaviour: group.key, run: s.runId } });
      return { key: group.key, golden: where, runId: s.runId, from: capture.runId, command, why: null };
    } finally {
      mem.close();
    }
  }
  return last ?? { key: group.key, golden: null, runId: null, from: null, command: null, why: 'none of its runs could be reproduced' };
}
