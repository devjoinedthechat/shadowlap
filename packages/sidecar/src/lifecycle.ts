/**
 * A run's life in the sidecar: the environment its processes get (envFor, envForSlot), its start
 * (startRun), with its parent read and matched as a replay matches it, an ended run opened again for
 * its judge's calls alone (openForJudge, closeForJudge), what is kept on it as it goes, and its end
 * (endRun), with the summary made from its calls as this process kept them, never read back from
 * the store, and what could not be written said once it is (endWritten).
 */
import { Session, isJudgeCall, normalizersHash, recordNotRecorded, storedModelResolver, summarizeJudge, summarizeRun, ulidNow, type CallRecord, type JudgeSummary, type Normalizer, type OverrideSources, type ReplayOptions, type RunCommand, type RunMeta, type RunMode, type RunRecord, type RunStatus, type RunSummary } from '@shadowlap/engine';
import { HttpError } from './answers.js';
import type { SidecarCore } from './core.js';
import { describeInterventions, RequestInterventions, type Interventions } from './interventions.js';
import { countHellos, missingPreload, unguardedReport, type GuardMode, type PreloadReport } from './preloads.js';
import { ProviderState } from './provider-state.js';
import { asMatched, capturedHttp, loadRequest, matchName, refingerprint, sentRequest, storedQuery, unqueried, unversioned, withoutParameters } from './replay-index.js';
import { ResponsesState } from './responses-state.js';
import { RunContext } from './run-context.js';

export interface StartRunInput {
  mode: RunMode;
  parentRunId?: string;
  command: RunCommand;
  codeVersion?: string | null;
  replay?: Partial<ReplayOptions>;
  interventions?: Interventions;
  /** The command being run came from an imported pack (recorded on the run so later replays ask again). */
  commandFromImport?: boolean;
  /** Where each `--override` result was read from, as typed (`{ 16: '@policy.json' }`): the run keeps the file's name, never the result. */
  overrideSources?: OverrideSources;
  /**
   * A stable name the run's traffic arrives under, as `/s/<slot>/…` in the base URLs from
   * `envForSlot`. A test worker creates its model clients once, and each test's run takes the slot
   * over in turn.
   */
  slot?: string;
  /** Never call a provider: a call that isn't served from the recording fails, as in `shadowlap test`. */
  offline?: boolean;
  /**
   * What to keep on the run from its start (who made it, the keys its environment held): written
   * with its record, so a caller stamps a run without writing to the store itself, and so without
   * waiting for another process's lock.
   */
  meta?: Partial<RunMeta>;
}

export interface EndRunResult {
  run: RunRecord;
  summary: RunSummary;
  /** Provider ids that received model calls during the run. */
  providers: string[];
  /** SDK languages seen on the call resolution API, from the SDK header each sends (else a user agent): typescript | python | mcp | other. */
  sdks: string[];
  /** Outbound connections the network guard saw bypassing Shadowlap, by host:port. */
  unguarded: Array<{ target: string; count: number; action: 'warned' | 'blocked' }>;
  /** WebSockets under a provider, by provider and path: tunnelled live and never recorded, or refused (an offline replay). */
  websockets: WebSocketUse[];
  /**
   * What the preloads in the agent's processes said (`POST /v1/hello`), for a run whose agent the
   * CLI started with them (expectPreloads); null for any other run.
   */
  preloads: PreloadReport | null;
}

export interface WebSocketUse {
  /** The provider and path, `openai /v1/realtime`. */
  target: string;
  count: number;
  action: 'tunnelled' | 'refused';
}

/**
 * The environment for a process whose calls belong to `runId`. The run id is in the provider base
 * URLs because model SDKs send no Shadowlap header, and several processes can record or replay
 * through one sidecar at once (`shadowlap replay --repeat --concurrency`). Without a run id, calls
 * go to whichever run started last, for hosts that start runs after creating their clients.
 */
export function envFor(core: SidecarCore, runId?: string): Record<string, string> {
  const env: Record<string, string> = { SHADOWLAP_URL: core.url, SHADOWLAP_HTTP2_URL: core.http2Url, ...(runId ? { SHADOWLAP_RUN_ID: runId } : {}) };
  const base = runId ? `${core.url}/r/${encodeURIComponent(runId)}` : core.url;
  for (const p of core.providers.values()) Object.assign(env, p.env(`${base}/${p.id}`));
  return env;
}

/**
 * The environment for processes whose runs change over time under one slot: no run id, and base
 * URLs that stay valid while each new run takes the slot over (`startRun({ slot })`).
 */
export function envForSlot(core: SidecarCore, slot: string): Record<string, string> {
  if (!/^[\w.-]{1,64}$/.test(slot)) throw new HttpError(400, `a slot is 1 to 64 letters, digits, dots, dashes or underscores: ${slot}`);
  const base = `${core.url}/s/${slot}`;
  const env: Record<string, string> = { SHADOWLAP_URL: base, SHADOWLAP_HTTP2_URL: `${core.http2Url}/s/${slot}` };
  for (const p of core.providers.values()) Object.assign(env, p.env(`${base}/${p.id}`));
  return env;
}

/**
 * Starts a run. Its record is written through the store writer, as its calls are, so a start never
 * holds the thread the agents' answers stream on for another process's lock: at once when the
 * store is free, else once it is, with every write of the run after it. Reading the run in this
 * process waits for that (QueuedWrites), so a caller that stamps it as it starts finds it, and one
 * that passes what to stamp as `meta` never waits at all. A replay reads its parent whole, the
 * writes this process queued for the parent included.
 */
export function startRun(core: SidecarCore, input: StartRunInput): RunRecord {
  if (input.slot !== undefined) envForSlot(core, input.slot);
  // Known before the parent is fingerprinted, which masks dates against it.
  const startedAt = Date.now();
  let parentCalls: CallRecord[] | undefined;
  let parentStartedAt: number | undefined;
  // Whether the parent was recorded with what a person types (RunMeta.inputs); see the Session.
  let parentRecordsInput = false;
  let normalizers = core.normalizers;
  let redactions: Normalizer[] = [];
  // A replay that runs a command other than its parent's (`replay <run> -- <command>`) says so in its record.
  let ownCommand: string[] | undefined;
  // A parent made before requests kept their numbers stored them rounded: matched so.
  let roundedNumbers = false;
  // A parent that holds no header parameters (RunMeta.headerParameters) is matched without them,
  // and this run keeps none either, so its own replays match the same way.
  let headerParameters = true;
  if (input.mode === 'replay') {
    if (!input.parentRunId) throw new HttpError(400, 'replay needs a parentRunId');
    const parent = core.store.getRun(input.parentRunId);
    if (!parent) throw new HttpError(404, `unknown run ${input.parentRunId}`);
    const argv = input.command.argv;
    if (argv.length && (argv.length !== parent.command.argv.length || argv.some((a, i) => a !== parent.command.argv[i]))) ownCommand = argv;
    // A redacted recording matches only if the live request is masked the same way.
    if (parent.meta?.redactions?.length) {
      redactions = parent.meta.redactions;
      normalizers = [...normalizers, ...redactions];
    }
    headerParameters = parent.meta?.headerParameters === true;
    const kept = core.store.getCalls(input.parentRunId);
    const stored = headerParameters ? kept : kept.map((c) => withoutParameters(core, c));
    roundedNumbers = parent.meta?.exactNumbers !== true;
    // Stored fingerprints are valid under the list they were computed with; anything else recomputes them.
    parentStartedAt = parent.startedAt;
    parentRecordsInput = parent.meta?.inputs === true;
    if (input.replay?.promptFrom !== undefined) {
      const target = stored.find((c) => c.callNo === input.replay!.promptFrom);
      if (!target || target.kind !== 'api' || isJudgeCall(target)) throw new HttpError(400, `--prompt-from: call #${input.replay.promptFrom} is not a model call of run ${input.parentRunId}${target && isJudgeCall(target) ? ' (it is a judge check\'s)' : ''}`);
    }
    // Under "clock": "auto" both sides are masked against both runs' starts, and this run's start
    // is new, so the parent's stored fingerprints (made against its own start) never apply.
    const withoutPrompt = input.replay?.promptFrom !== undefined;
    if (core.clock === 'exact' && parent.meta?.normalizersHash === normalizersHash(normalizers, core.clock, withoutPrompt, roundedNumbers)) {
      // A captured HTTP call is matched with the credentials in its query or form body masked, which
      // a recording made by an earlier version stored as sent: those calls are fingerprinted again.
      // A judge's call is matched by its request as sent (judgeFingerprint), whatever the normalizers: those are fingerprinted again too.
      const again = (c: CallRecord) => capturedHttp(c) || isJudgeCall(c);
      const some = stored.some(again);
      parentCalls = some ? refingerprint(core, stored, { normalizers, clockRef: undefined, withoutPrompt, roundedNumbers, redactions }, again).calls : stored;
      core.log(`run ${input.parentRunId}: reusing stored fingerprints (${stored.length} calls${some ? ', captured HTTP and judge calls fingerprinted again' : ''})`);
    } else {
      // Most come from the cache (fingerprint-cache.ts), which the recording filled.
      const { calls, cached } = refingerprint(core, stored, { normalizers, clockRef: core.clock === 'auto' ? [parent.startedAt, startedAt] : undefined, withoutPrompt, roundedNumbers, redactions });
      parentCalls = calls;
      core.log(`run ${input.parentRunId}: re-fingerprinting ${stored.length} call${stored.length === 1 ? '' : 's'} under the current normalizers (${cached} from the cache)`);
    }
    // Compared as they are matched, so a divergence report never shows a sign-in beta as a change.
    parentCalls = parentCalls.map((c) => asMatched(core, c));
  }
  // Resolved against the parent before the run exists, so a target that is not a model call is refused with nothing created.
  // Flags name the agent's model calls: a judge's is never one of them, nor counted among them.
  const requestInterventions = input.interventions && parentCalls ? new RequestInterventions(parentCalls.filter((c) => !isJudgeCall(c)), input.interventions, (message) => {
    throw new HttpError(400, message);
  }) : null;
  // Every replay keeps the list, empty when it changed nothing, so a run made before replays kept
  // their flags (no list) is never taken for one that had none.
  const described = input.mode === 'replay' ? describeInterventions(input.replay, input.interventions, ownCommand, input.overrideSources) : null;
  const meta: RunMeta = {
    ...(input.meta ?? {}),
    normalizersHash: normalizersHash(normalizers, core.clock, input.replay?.promptFrom !== undefined, roundedNumbers),
    // Its model requests are stored with each number as the agent sent it.
    exactNumbers: true,
    ...(headerParameters ? { headerParameters: true } : {}),
    ...(input.commandFromImport ? { commandFromImport: true } : {}),
    ...(described ? { interventions: described } : {}),
  };
  const run: RunRecord = { runId: ulidNow(), parentRunId: input.parentRunId ?? null, mode: input.mode, status: 'running', divergence: null, command: input.command, codeVersion: input.codeVersion ?? null, startedAt, endedAt: null, meta };
  const clockRef = core.clock !== 'auto' ? undefined : parentStartedAt !== undefined ? [parentStartedAt, run.startedAt] : [run.startedAt];
  const session = new Session({
    mode: input.mode,
    parentRunId: input.parentRunId ?? null,
    ...(parentCalls ? { parentCalls } : {}),
    // A divergence's diff is worked out once its call is answered (explainWaiting), never on its path.
    deferExplain: true,
    ...(input.replay ? { replay: input.replay } : {}),
    loadRequest: (rec) => loadRequest(core, rec, roundedNumbers),
    matchName: (rec) => matchName(core, rec, redactions),
    // Its query as the call's identity reads it, under the rules that redacted it, as the live call's is.
    matchQuery: (rec) => storedQuery(rec, redactions),
    ...(clockRef !== undefined && parentStartedAt !== undefined ? { clock: { parent: parentStartedAt, run: run.startedAt } } : {}),
    ...(parentRecordsInput ? { parentRecordsInput } : {}),
  });
  const ctx = new RunContext(run, session, requestInterventions, normalizers, input.offline === true, input.slot ?? null, clockRef, input.replay?.promptFrom !== undefined, redactions, parentCalls ? unversioned(core, parentCalls) : undefined, parentCalls ? unqueried(core, parentCalls) : undefined, roundedNumbers, headerParameters);
  core.writer.write({
    what: `run ${run.runId}'s start`,
    of: { runId: run.runId, part: 'run' },
    run: () => void core.store.createRun({ runId: run.runId, mode: run.mode, parentRunId: run.parentRunId, command: run.command, codeVersion: run.codeVersion, startedAt, meta }),
    failed: (reason) => {
      ctx.lost = reason;
      ctx.warnings.push(`Run ${run.runId} could not be written to the store (${reason}): nothing of it is in the recording.`);
    },
  });
  // A fork's live Responses call may continue a response or a conversation the recording made: read when one does.
  if (parentCalls?.some((c) => c.kind === 'api' && /\/(responses|conversations)$/.test(c.name))) {
    const recorded = parentCalls;
    ctx.responses = new ResponsesState(recorded, {
      request: (rec) => sentRequest(core, rec),
      response: (rec) => ({ bytes: rec.end?.responseRef ? core.store.getBlob(rec.end.responseRef) : null, contentType: rec.end?.meta.headers?.['content-type'] }),
    });
  }
  // A fork's live call may name a Gemini cache the recording made, or a file it uploaded: read when one does.
  if (parentCalls && ProviderState.applies(parentCalls)) {
    ctx.providerState = new ProviderState(parentCalls, {
      request: (rec) => sentRequest(core, rec),
      response: (rec) => (rec.end?.responseRef ? core.store.getBlob(rec.end.responseRef) : null),
    });
  }
  core.runs.set(run.runId, ctx);
  if (input.slot !== undefined) core.slots.set(input.slot, run.runId);
  core.activeRunId = run.runId;
  core.log(`run ${run.runId} started (${input.mode})`);
  return run;
}

/**
 * Opens an ended run again for its judge's calls alone, as `pack` judges a recording: a request in
 * the scope `shadowlap:judge` with this process's judge token (see judgeToken) is recorded into it
 * after its own calls, answered from its parent's judge calls when it is a replay and the same
 * request is there, else live. Anything else is refused. `closeForJudge` closes it again, leaving
 * the run's status and end as they were. A run still going takes judge calls as it is.
 */
export function openForJudge(core: SidecarCore, runId: string): void {
  if (core.runs.has(runId)) return;
  const run = core.store.getRun(runId);
  if (!run) throw new HttpError(404, `unknown run ${runId}`);
  const parent = run.parentRunId ? core.store.getRun(run.parentRunId) : null;
  // A judge's request is matched by its bytes as sent, under the rules that redacted the parent
  // alone (judgeFingerprint); the run's own calls are matched as its replay matched them.
  const redactions = parent?.meta?.redactions ?? [];
  const normalizers = redactions.length ? [...core.normalizers, ...redactions] : core.normalizers;
  const clockRef = core.clock !== 'auto' ? undefined : parent ? [parent.startedAt, run.startedAt] : [run.startedAt];
  const roundedNumbers = parent !== null && parent.meta?.exactNumbers !== true;
  const recorded = parent ? refingerprint(core, core.store.getCalls(parent.runId).filter(isJudgeCall), { normalizers, clockRef, withoutPrompt: false, roundedNumbers, redactions }).calls : [];
  const session = new Session({ mode: parent ? 'replay' : 'record', parentRunId: parent?.runId ?? null, parentCalls: recorded });
  const ctx = new RunContext(run, session, null, normalizers, false, null, clockRef, false, redactions, undefined, undefined, roundedNumbers);
  ctx.nextCallNo = core.store.getCalls(runId).reduce((n, c) => Math.max(n, c.callNo), 0) + 1;
  ctx.judgeOnly = { from: ctx.nextCallNo };
  core.runs.set(runId, ctx);
  core.log(`run ${runId} opened for its judge`);
}

/** Closes a run `openForJudge` opened: what the judge's calls made through it did and cost, or null when it wasn't open for its judge. */
export function closeForJudge(core: SidecarCore, runId: string): JudgeSummary | null {
  const ctx = core.runs.get(runId);
  if (!ctx?.judgeOnly) return null;
  core.runs.delete(runId);
  // As the run's end reads its calls (RunContext.records): those the judge made through it.
  const made = ctx.recorded().filter(isJudgeCall);
  // Made by this process, whatever made the run: a recording that came from a pack had its own
  // calls made somewhere else, but these went upstream, and were paid for, here.
  return summarizeJudge(ctx.run, made, { ...(core.prices ? { prices: core.prices } : {}), modelOf: storedModelResolver(core.store), imported: false });
}

/**
 * Says the CLI starts this run's agent with Shadowlap's preloads, under `guard`: each of its Node
 * and Python processes then says it loaded (`POST /v1/hello`), and a run that made model or tool
 * calls with none loaded is one the guard never watched, which endRun says, and fails under block.
 */
export function expectPreloads(core: SidecarCore, runId: string, guard: GuardMode, accept: readonly string[] = []): void {
  const ctx = core.runs.get(runId);
  if (!ctx) return;
  ctx.preloadGuard = guard;
  // The runtimes the guard takes as they are under --guard block (guard.accept): the Claude Code CLI.
  ctx.preloadAccept = new Set(accept);
}

/**
 * Keeps `patch` on a run's metadata. For a run this sidecar has open it goes through the store
 * writer, after the run's start, so it never waits on the thread for another process's lock (a
 * caller that stamps a run as it starts can pass the stamp as StartRunInput.meta instead); any
 * other run's is written at once.
 */
export function updateRunMeta(core: SidecarCore, runId: string, patch: Partial<RunMeta>): void {
  const ctx = core.runs.get(runId);
  if (!ctx) return core.store.updateRunMeta(runId, patch);
  ctx.run.meta = { ...(ctx.run.meta ?? {}), ...patch };
  core.writer.write({
    what: `run ${runId}'s metadata`,
    of: { runId, part: 'run' },
    run: () => core.store.updateRunMeta(runId, patch),
    failed: (reason) => core.storeTrouble(ctx, 'store:meta', `What was kept on run ${runId} could not be written to the store (${reason}).`),
  });
}

/**
 * Waits for a run this sidecar ended to be written, its queued rows and its end, as settled waits,
 * and gives what could not be: the store trouble its summary, made before, could not say. A command
 * that prints the summary adds these lines to it.
 */
export async function endWritten(core: SidecarCore, runId: string): Promise<string[]> {
  await core.writer.settled(runId);
  const lines = core.lateTrouble.get(runId) ?? [];
  core.lateTrouble.delete(runId);
  return lines;
}

/**
 * Ends a run. Its summary is made from its calls as this process kept them while it queued their
 * rows (RunContext.records), never read back from the store: while another process holds the
 * store, the end waits for nothing, and another run's stream goes on. What the end keeps (its
 * status, what its preloads said, the hosts it reached unrecorded, its WebSockets) is one write
 * through the store writer, as its calls are; a caller that reads the run next waits for
 * `settled(runId)` first, on the writer's timer.
 */
export function endRun(core: SidecarCore, runId: string, status: Exclude<RunStatus, 'running'>): EndRunResult {
  const ctx = core.runs.get(runId);
  if (!ctx) throw new HttpError(404, `unknown run ${runId}`);
  if (ctx.judgeOnly) throw new HttpError(409, `run ${runId} has ended; it is open for its judge's calls only`);
  // A divergence still waiting for its diff gets it before the run ends.
  core.explainWaiting(ctx);
  // A replay that never diverged but stopped before its recording did leaves it there: kept on
  // the run, so everything that reads the store tells it from a clean replay.
  if (ctx.session.end()) core.noteDivergence(ctx);
  // Every call of the run as the store holds it once its queued rows are made (any that couldn't be, in its warnings).
  const calls = ctx.recorded();
  // A run that made model or tool calls with no preload loaded was never watched by the guard:
  // under --guard block it fails, whatever its agent did.
  const preloads = preloadReport(ctx, calls);
  // An agent that exited 0 whose run fails for the guard: its summary says not watched, never that it exited with an error.
  if (preloads?.failed && status === 'completed') {
    status = 'failed';
    preloads.exitedOk = true;
  }
  core.runs.delete(runId);
  if (core.activeRunId === runId) core.activeRunId = null;
  if (ctx.slot !== null && core.slots.get(ctx.slot) === runId) core.slots.delete(ctx.slot);
  const run: RunRecord = ctx.run;
  const unguarded = [...ctx.unguarded.entries()].map(([target, v]) => ({ target, ...v })).sort((a, b) => b.count - a.count);
  // WebSockets (OpenAI Realtime): what went over them is in no recording.
  const websockets = [...ctx.websockets.entries()].map(([target, v]): WebSocketUse => ({ target, ...v })).sort((a, b) => b.count - a.count);
  // Kept on the run for its page: what its preloads said and its WebSockets. The summary goes, the run stays.
  const patch: Partial<RunMeta> = {
    ...(preloads ? { preloads: { guard: preloads.guard, hellos: preloads.hellos, ...(preloads.missing ? { missing: preloads.missing } : {}), ...(preloads.unguarded ? { unguarded: preloads.unguarded } : {}) } } : {}),
    ...(websockets.length ? { websockets } : {}),
    ...(ctx.claudeCode ? { claudeCode: true as const } : {}),
  };
  const endedAt = Date.now();
  if (ctx.lost === null) {
    core.writer.write({
      what: `run ${runId}'s end`,
      of: { runId, part: 'run' },
      run: () => {
        core.store.endRun(runId, status, endedAt);
        if (Object.keys(patch).length) core.store.updateRunMeta(runId, patch);
        // Kept on the run as well as printed: its page says what a replay runs for real.
        if (unguarded.length) recordNotRecorded(core.store, runId, { hosts: unguarded });
      },
      // Tried until the store is free, however long another process holds it: without its end, the run reads as running.
      retain: true,
      failed: (reason) => core.storeTrouble(ctx, 'store:end', `That run ${runId} ended could not be written to the store (${reason}): it reads as running until a later command finds no process recording it.`),
    });
  }
  const warnings = [...ctx.warnings];
  if (preloads?.missing) warnings.push(preloads.missing);
  if (preloads?.unguarded) warnings.push(preloads.unguarded);
  if (unguarded.length) {
    const list = unguarded.map((u) => `${u.target} (${u.count})`).join(', ');
    const blocked = unguarded.some((u) => u.action === 'blocked');
    warnings.push(
      blocked
        ? `${unguarded.length} outbound connection target${unguarded.length === 1 ? '' : 's'} bypassed Shadowlap and ${unguarded.length === 1 ? 'was' : 'were'} blocked: ${list}. Wrap these calls as tools, or allow them with SHADOWLAP_GUARD_ALLOW.`
        : run.mode === 'replay'
          ? `${unguarded.length} outbound connection target${unguarded.length === 1 ? '' : 's'} bypassed Shadowlap during the replay: ${list}. They ran live and will run on every replay; wrap them as tools, or replay with --guard block.`
          : `${unguarded.length} outbound connection target${unguarded.length === 1 ? '' : 's'} bypassed Shadowlap during the recording: ${list}. They were not recorded and will run again on replay; wrap them as tools.`,
    );
  }
  // An intervention that never took effect leaves a run that looks like an answer to a question nobody asked.
  warnings.push(...ctx.session.unapplied(), ...(ctx.interventions?.unapplied() ?? []), ...(ctx.interventions?.warnings ?? []));
  // A model call --fail-at named, by its place among the recording's model calls, that the replay never made.
  warnings.push(...ctx.session.unappliedFailures());
  warnings.push(...webSocketWarnings(websockets, run.mode));
  if (run.mode === 'record' && !calls.some((c) => c.kind === 'api') && !websockets.some((u) => u.action === 'tunnelled')) {
    warnings.push(
      calls.length === 0
        ? 'Nothing was recorded: no model API call or SDK call reached Shadowlap. In Node and Python agents, calls to Anthropic, OpenAI, Gemini, Azure OpenAI, Vertex AI and Bedrock are captured in the process; other runtimes need their SDK to read ANTHROPIC_BASE_URL, OPENAI_BASE_URL or GOOGLE_GEMINI_BASE_URL, which shadowlap run sets. A client with a base URL on another host (set SHADOWLAP_UPSTREAM_<PROVIDER> to it), SHADOWLAP_CAPTURE=off, or an agent that failed before its first call all look like this.'
        : `${calls.length} ${calls.every((c) => c.meta.http) ? 'HTTP' : 'SDK'} call${calls.length === 1 ? '' : 's'} recorded but no model API calls. If the agent calls a model, its client is not going through Shadowlap (a client configured with its own base URL bypasses the ANTHROPIC_BASE_URL / OPENAI_BASE_URL / GOOGLE_GEMINI_BASE_URL that shadowlap run sets).`,
    );
  }
  const ended: RunRecord = { ...run, status, endedAt, meta: { ...(run.meta ?? {}), ...patch } };
  const summary = summarizeRun(ended, calls, ctx.session.notReached(), warnings, { ...(core.prices ? { prices: core.prices } : {}), modelOf: storedModelResolver(core.store) });
  // What goes wrong writing the run from here on, its summary made, is said apart (endWritten).
  ctx.ended = true;
  core.log(`run ${runId} ended (${status})`);
  return { run: ended, summary, providers: [...ctx.providersUsed].sort(), sdks: [...ctx.sdksSeen].sort(), unguarded, websockets, preloads };
}

/**
 * What the run's preloads said, which endRun keeps on the run for its page (`RunMeta.preloads`), or
 * null when the CLI started its agent with none (expectPreloads). A run that made model or tool
 * calls (a judge's are the CLI's own) with no hello is `missing` one, unless the guard was turned off.
 */
function preloadReport(ctx: RunContext, calls: readonly CallRecord[]): PreloadReport | null {
  const guard = ctx.preloadGuard;
  if (guard === null) return null;
  const hellos = countHellos(ctx.hellos.values());
  for (const [runtime, n] of ctx.hellosBeyond) hellos[runtime] = (hellos[runtime] ?? 0) + n;
  const agent = calls.filter((c) => !isJudgeCall(c));
  const made = { api: agent.filter((c) => c.kind === 'api').length, tool: agent.filter((c) => c.kind === 'tool').length };
  const missing = guard !== 'off' && Object.keys(hellos).length === 0 && made.api + made.tool > 0 ? missingPreload(ctx.run.command.argv, made, guard) : null;
  // A process that said its guard is off was never watched either: the Claude Code CLI the Claude
  // Agent SDK runs, among them, unless its fence found nothing it can reach unwatched.
  const unguarded = unguardedReport(ctx.hellos.values(), guard, ctx.preloadAccept);
  return { guard, hellos, missing, unguarded: unguarded.line, failed: (missing !== null && guard === 'block') || unguarded.failed };
}

/** What a run's summary says of the WebSockets it tunnelled or refused: nothing that went over one is in a recording. */
function webSocketWarnings(used: readonly WebSocketUse[], mode: RunMode): string[] {
  const out: string[] = [];
  const listed = (action: WebSocketUse['action']) => used.filter((u) => u.action === action);
  const names = (us: readonly WebSocketUse[]) => us.map((u) => `${u.target} (${u.count})`).join(', ');
  const total = (us: readonly WebSocketUse[]) => us.reduce((n, u) => n + u.count, 0);
  const live = listed('tunnelled');
  if (live.length) {
    const n = total(live);
    const one = n === 1;
    const after = mode === 'replay' ? `${one ? 'It' : 'They'} ran for real during the replay, as ${one ? 'it does' : 'they do'} on every replay` : `A replay connects again for real`;
    out.push(`${n} WebSocket connection${one ? '' : 's'} went to the provider live and ${one ? 'was' : 'were'} not recorded: ${names(live)}. ${after}; an offline replay (shadowlap test) refuses ${one ? 'it' : 'them'}.`);
  }
  const refused = listed('refused');
  if (refused.length) {
    const n = total(refused);
    out.push(`${n} WebSocket connection${n === 1 ? ' was' : 's were'} refused: the replay is offline, and a recording holds no WebSocket to answer from: ${names(refused)}.`);
  }
  return out;
}
