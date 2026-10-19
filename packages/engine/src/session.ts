import { CLOCK_PLACEHOLDERS, maskClock } from './clock.js';
import { multipartView } from './multipart.js';
import { withoutPrompt } from './prompt.js';
import { headerDiff, hintsFor, isHeaderEntry, structuralDiff } from './diff.js';
import { formatToolFailure, type ToolFailure } from './interventions.js';
import { isJudgeCall, JUDGE_SCOPE } from './judge-scope.js';
import type { CallKind, CallRecord, Coverage, DivergenceReport, Effect, NotReached, ReadPolicy, RunMode, WritePolicy } from './types.js';

/**
 * The per-run state machine: REPLAYING → DIVERGED, with call-key matching on
 * (kind, fingerprint, occurrence). One session exists per run in both modes; in record mode every
 * call is live, but occurrences still have to be counted.
 */

export interface ReplayOptions {
  writes: WritePolicy;
  reads: ReadPolicy;
  /**
   * Tools whose first call is forced live: a fixed tool's call key doesn't change with its code, so it
   * must be forced. After the fork, every call of one runs live: none is served from the recording.
   */
  liveTools: ReadonlySet<string>;
  /**
   * The calls the recording covers, when it is partial (see `RunMeta.covers`): call kinds, and
   * `tool:<name>` for a tool whose calls it holds when it doesn't hold every tool's. A call it
   * doesn't cover runs live and never ends the replay, because its absence is expected rather than a
   * divergence. Undefined means the recording covers every kind.
   */
  kinds?: ReadonlySet<Coverage>;
  /**
   * Model calls to answer with an HTTP failure instead of the recording, by the parent run's call
   * number. Error handling is the part of an agent a replay exercises for free, and the part no
   * recording of a healthy run contains: this is how a 429 or a 500 gets into the path.
   *
   * Like every flag that names a model call (this one, `divergeAt` on a model call and `promptFrom`),
   * it names a place among the recording's model calls, per scope when the recording has scopes
   * (see `place`): the replay's model call at that place is the one it applies to, whatever order
   * calls arrive in.
   */
  failAt?: ReadonlyMap<number, number>;
  /** A call number forced live: for a model call, the replay's model call at its place. */
  divergeAt?: number;
  /** A model call from which a changed prompt applies: earlier model calls match without their prompt, and this one is forced live. */
  promptFrom?: number;
  /** Tool results to substitute, by the parent run's call number (tool-result override). */
  overrides?: ReadonlyMap<number, unknown>;
  /**
   * Tool calls to fail instead of serving or running them, by the parent run's call number
   * (`--fail-at 19=timeout`). The tool doesn't run; the agent gets the error, and the run forks there.
   */
  toolFailures?: ReadonlyMap<number, ToolFailure>;
  /**
   * Text to add to a recorded tool result, by the parent run's call number (`--inject-result 9=…`):
   * the result is served as recorded with the text planted in it, as an attacker would leave it.
   */
  plants?: ReadonlyMap<number, string>;
  /**
   * Ask for a person's input live after the fork (`--live-input`). By default there is no one to
   * type there, so recorded input is served in the order it was given.
   */
  liveInput?: boolean;
  /**
   * After the fork, answer a write the recording made (the same tool, with the same arguments, the
   * same time it was called) with what it got then, an error included, instead of `writes`. Nothing
   * runs either way, and a stub never fails: a write that failed when it was recorded would pass
   * after a fork for no reason of the model's. Blame's probes ask for it.
   */
  recordedWrites?: boolean;
}

export const DEFAULT_REPLAY_OPTIONS: ReplayOptions = { writes: 'block', reads: 'live', liveTools: new Set() };

export interface ResolveInput {
  callNo: number;
  kind: CallKind;
  name: string;
  fingerprint: string;
  effect?: Effect | null;
  /** The (raw, un-normalized) request, used only to explain a divergence. */
  request?: unknown;
  /**
   * The call's name as matching reads it, when the provider leaves part of its path out of the
   * fingerprint (a Vertex AI call without its project and location): a changed request is compared
   * with recorded calls of this name, wherever they were made.
   */
  matchName?: string;
  /**
   * A model call's request headers that its fingerprint includes (`anthropic-beta`, …), as its
   * record keeps them in `meta.fingerprintHeaders`: a change to one is a divergence like any other,
   * so the report shows it too.
   */
  headers?: Record<string, string>;
  /** Reuse an occurrence instead of allocating one: this attempt retries an earlier call. */
  occurrence?: number;
  /**
   * The logical branch the call was made in (`scope()` in the SDKs), e.g. `orchestrator/researcher-2`.
   * Repeats are counted per scope, so identical calls from branches that run at once keep their own
   * recorded answers whatever order they arrive in.
   */
  scope?: string;
  /**
   * An intervention the caller applied that a diff can't show (a model switched in the path, a
   * setting the request already had): the call runs live, and the divergence report names the flag
   * (`by`) and the recorded call it stands in for (`counterpart`, the parent run's call number).
   */
  forced?: { by: string; counterpart?: number };
  /**
   * The flag that changed this request's body (`--inject`, `--set`): the call diverges on the change
   * as usual, its diff shows it, and the report names the flag instead of guessing at a normalizer.
   */
  changedBy?: string;
  /** A person's input (a `user_input` tool call, recorded with `meta.input`). */
  input?: boolean;
  /**
   * The name the recording holds this call under, when it is not `name`: a captured HTTP call's,
   * masked by the rules of the redacted copy being replayed. A divergence is explained against the
   * recorded calls of either name.
   */
  recordedName?: string;
}

export type Decision =
  | { origin: 'replayed'; occurrence: number; record: CallRecord }
  | { origin: 'overridden'; occurrence: number; record: CallRecord; result: unknown }
  /** The recorded result with `text` planted in it (`--inject-result`). Stored as overridden. */
  | { origin: 'planted'; occurrence: number; record: CallRecord; text: string }
  /** The tool fails as `--fail-at` asked, without running. Stored as live, with the failure marked injected. */
  | { origin: 'injected'; occurrence: number; record: CallRecord; failure: ToolFailure }
  | { origin: 'live'; occurrence: number }
  | { origin: 'blocked'; occurrence: number }
  | { origin: 'stubbed'; occurrence: number };

export interface SessionOptions {
  mode: RunMode;
  parentRunId?: string | null;
  parentCalls?: CallRecord[];
  replay?: Partial<ReplayOptions>;
  /** Loads a recorded call's request for divergence explanation. */
  loadRequest?: (record: CallRecord) => unknown;
  /**
   * A recorded call's name as matching reads it (`ResolveInput.matchName`), for finding the call a
   * changed request is compared with. Defaults to its name.
   */
  matchName?: (record: CallRecord) => string;
  /** Start times of the parent run and this one, when dates near either are masked for matching, on both sides (clock.ts). */
  clock?: { parent: number; run: number };
  /**
   * The parent run was made with what a person types recorded (`RunMeta.inputs`). One that wasn't
   * and holds no input call either predates recorded input: it never saw the agent's reads, so they
   * run live, as calls a partial recording doesn't cover do, instead of forking at the first one.
   */
  parentRecordsInput?: boolean;
}

const key = (kind: CallKind, fingerprint: string, occurrence: number, scope = '') => `${kind}\n${scope}\n${fingerprint}\n${occurrence}`;

export class Session {
  readonly mode: RunMode;
  readonly options: ReplayOptions;
  state: 'replaying' | 'diverged';
  divergence: DivergenceReport | null = null;
  readonly warnings: string[] = [];

  private readonly parentRunId: string | null;
  private readonly index = new Map<string, CallRecord>();
  /**
   * The recording's judge calls that got an answer back, by fingerprint, the newest kept: a judge
   * asked the very request again gets the answer it gave, however often it is asked.
   */
  private readonly judged = new Map<string, CallRecord>();
  private readonly parentCalls: CallRecord[];
  private readonly consumed = new Set<number>();
  /** Recorded calls a tool-call intervention (override, planted text, failure) took effect on. */
  private readonly applied = new Set<number>();
  /** Recorded calls whose intervention the caller could not carry out, and said so itself. */
  private readonly declinedCalls = new Set<number>();
  private readonly occurrences = new Map<string, number>();
  private readonly forcedTools = new Set<string>();
  /** The place (`place`) of each of the parent's model calls, by call number. */
  private readonly parentPlaces = new Map<number, string>();
  /** Model calls this run has made, retries not counted, per scope. */
  private readonly apiCounts = new Map<string, number>();
  /** This run's model calls answered with an injected failure, by its call number: the status, and the parent's call the flag named. */
  private readonly injected = new Map<number, { status: number; target: number }>();
  /** What forced the call being resolved live, for its divergence report. */
  private forcing: { by: string; counterpart?: number } | null = null;
  private readonly loadRequest: (record: CallRecord) => unknown;
  private readonly matchName: (record: CallRecord) => string;
  private readonly clock: SessionOptions['clock'];
  /** Whether the recording used scopes. If it didn't, scopes are ignored, so adding them later still replays. */
  private readonly scoped: boolean;
  /** Whether the recording holds what a person typed (see `SessionOptions.parentRecordsInput`). */
  private readonly holdsInput: boolean;
  private replayedCount = 0;

  constructor(opts: SessionOptions) {
    this.mode = opts.mode;
    this.options = { ...DEFAULT_REPLAY_OPTIONS, ...opts.replay };
    this.parentRunId = opts.parentRunId ?? null;
    this.parentCalls = opts.parentCalls ?? [];
    this.loadRequest = opts.loadRequest ?? (() => undefined);
    this.matchName = opts.matchName ?? ((record) => record.name);
    this.clock = opts.clock;
    this.state = this.mode === 'replay' ? 'replaying' : 'diverged';
    // The judge's scope is Shadowlap's, not the agent's: a recording whose only scope is the judge's has none of its own.
    this.scoped = this.mode === 'record' || this.parentCalls.some((c) => typeof c.meta.scope === 'string' && !isJudgeCall(c));
    this.holdsInput = opts.parentRecordsInput === true || this.parentCalls.some((c) => c.meta.input === true);
    for (const c of this.parentCalls) {
      // A judge call that failed holds no verdict: the judge is asked again.
      if (isJudgeCall(c)) {
        const held = this.judged.get(c.fingerprint);
        if (c.kind === 'api' && c.end?.outcome === 'ok' && (!held || held.callNo < c.callNo)) this.judged.set(c.fingerprint, c);
        continue;
      }
      if (c.end) this.index.set(key(c.kind, c.fingerprint, c.occurrence, this.scopeOf(c.meta.scope)), c);
    }
    // Flags name the agent's model calls by their place; the judge's are never among them.
    const parentCounts = new Map<string, number>();
    for (const c of [...this.parentCalls].sort((a, b) => a.callNo - b.callNo)) if (c.kind === 'api' && !isJudgeCall(c)) this.parentPlaces.set(c.callNo, this.nextPlace(c.meta.scope, parentCounts));
  }

  /**
   * A model call's place: the n-th model call of its scope, or of the run when the recording has no
   * scopes, counted in `counts`. Flags that name a model call by number name its place, so they reach
   * the same request when sub-agents send theirs in another order, or tool calls come in between
   * differently.
   */
  private nextPlace(scope: unknown, counts: Map<string, number>): string {
    const s = this.scopeOf(scope);
    const n = counts.get(s) ?? 0;
    counts.set(s, n + 1);
    return `${s}\n${n}`;
  }

  private scopeOf(scope: unknown): string {
    if (scope === JUDGE_SCOPE) return JUDGE_SCOPE;
    return this.scoped && typeof scope === 'string' ? scope : '';
  }

  /** Allocates the next occurrence for a (kind, fingerprint) within a scope. */
  nextOccurrence(kind: CallKind, fingerprint: string, scope?: string): number {
    const k = `${kind}\n${this.scopeOf(scope)}\n${fingerprint}`;
    const n = (this.occurrences.get(k) ?? 0) + 1;
    this.occurrences.set(k, n);
    return n;
  }

  resolve(input: ResolveInput): Decision {
    const occurrence = input.occurrence ?? this.nextOccurrence(input.kind, input.fingerprint, input.scope);
    const scope = this.scopeOf(input.scope);
    const effect = input.effect ?? null;

    if (input.scope === JUDGE_SCOPE) return this.judge(input, occurrence);
    if (this.mode === 'record') return { origin: 'live', occurrence };

    // A partial recording never saw this kind of call, so its absence is not a divergence: run it
    // live, but keep the write policy, because a live write is still a real side effect.
    if (this.options.kinds && !this.covers(input)) {
      if (input.kind === 'tool' && effect === 'write') {
        if (this.options.writes === 'block') return { origin: 'blocked', occurrence };
        if (this.options.writes === 'stub') return { origin: 'stubbed', occurrence };
      }
      return { origin: 'live', occurrence };
    }
    // A recording made before what a person types was recorded never saw the agent's reads.
    if (input.input && !this.holdsInput) return { origin: 'live', occurrence };

    const place = input.kind === 'api' && input.occurrence === undefined ? this.nextPlace(input.scope, this.apiCounts) : undefined;
    const forced = this.isForced(input, place);
    if (this.state === 'replaying') {
      const record = forced ? undefined : this.index.get(key(input.kind, input.fingerprint, occurrence, scope));
      if (record && !this.consumed.has(record.callNo) && !input.changedBy) return this.serve(input, record, occurrence);
      this.state = 'diverged';
      // A flag changed this request, yet it matches the recording: a normalizer or --prompt-from masks
      // the change for matching. The flag named this call, so it still forks here.
      this.divergence =
        record && !this.consumed.has(record.callNo) && input.changedBy
          ? { callNo: input.callNo, kind: input.kind, name: input.name, replayedBefore: this.replayedCount, type: 'forced', reason: `forced live by ${input.changedBy}, a change the normalizers or --prompt-from hide from matching`, counterpart: { runId: this.parentRunId ?? record.runId, callNo: record.callNo } }
          : this.explain(input, forced, occurrence);
    } else if (input.kind === 'tool' && !forced && !this.options.liveTools.has(input.name) && (effect === 'pure' || (effect === 'read' && this.options.reads === 'replay') || (effect === 'write' && this.options.recordedWrites))) {
      // After divergence only declared-pure results (and reads, on request) may come from the
      // recording, and the writes it made, when asked: what the world answered them, never a fence
      // or a failure a flag made. Never for a call a flag forces live (`--diverge-at` on it), nor for
      // a tool `--live-tool` names: its code changed since the recording, so what it returned then is
      // no answer for it, however the run got here.
      const record = this.index.get(key(input.kind, input.fingerprint, occurrence, scope));
      const answered = effect !== 'write' || (record && (record.origin === 'live' || record.origin === 'replayed') && !record.end?.meta.injected);
      if (record && answered && !this.consumed.has(record.callNo)) return this.serve(input, record, occurrence);
    }
    // A tool asked to fail that the run reaches after its fork: the same tool with the same arguments
    // (and occurrence) is the recorded call, wherever it now falls.
    if (input.kind === 'tool' && this.options.toolFailures?.size) {
      const record = this.index.get(key(input.kind, input.fingerprint, occurrence, scope));
      const failure = record && !this.consumed.has(record.callNo) ? this.options.toolFailures.get(record.callNo) : undefined;
      if (record && failure) {
        this.consumed.add(record.callNo);
        this.applied.add(record.callNo);
        return { origin: 'injected', occurrence, record, failure };
      }
    }

    // After the fork there is no one to type: a person's input comes from the recording, in the
    // order it was given, whatever the prompt now says.
    if (input.input && !this.options.liveInput) {
      const next = this.parentCalls.find((c) => c.meta.input === true && c.end && !this.consumed.has(c.callNo));
      if (next) return this.serve(input, next, occurrence);
    }

    // Live region.
    if (input.kind === 'tool' && effect === 'write') {
      if (this.options.writes === 'block') return { origin: 'blocked', occurrence };
      if (this.options.writes === 'stub') return { origin: 'stubbed', occurrence };
    }
    return { origin: 'live', occurrence };
  }

  /**
   * A judge call (the scope `shadowlap:judge`): answered from the recording when it holds the very
   * same request with an answer, whatever the agent's replay did, else run live. The sidecar
   * fingerprints a judge's request as it was sent, with no normalizer and no masking of dates: the
   * judge read every byte of it, so its answer is served for those bytes alone. It never moves the
   * replay: it is no call of the agent's, so it neither forks the replay nor counts as replayed, and
   * a missing one means "ask the judge live", not "the agent changed".
   */
  private judge(input: ResolveInput, occurrence: number): Decision {
    const record = this.judgedFor(input.fingerprint);
    return record ? { origin: 'replayed', occurrence, record } : { origin: 'live', occurrence };
  }

  /** The recorded judge call that answers this very request, or undefined: none in a recording, nor in a replay whose recording never asked it. */
  judgedFor(fingerprint: string): CallRecord | undefined {
    return this.mode === 'replay' ? this.judged.get(fingerprint) : undefined;
  }

  /** Whether a partial recording holds calls like this one: their kind, or for a tool, its name. */
  private covers(input: ResolveInput): boolean {
    const kinds = this.options.kinds!;
    return kinds.has(input.kind) || (input.kind === 'tool' && kinds.has(`tool:${input.name}`));
  }

  /** Serves a matched record, substituting an override for a tool result when one was given. */
  private serve(input: ResolveInput, record: CallRecord, occurrence: number): Decision {
    this.consumed.add(record.callNo);
    if (input.kind === 'tool') {
      const failure = this.options.toolFailures?.get(record.callNo);
      if (failure) {
        // The tool's answer is replaced by a failure nobody recorded: the run forks here, like a
        // model call answered with --fail-at, and the replay counts it as no replayed call.
        this.applied.add(record.callNo);
        if (this.state === 'replaying') {
          this.state = 'diverged';
          this.divergence = {
            type: 'forced',
            callNo: input.callNo,
            kind: input.kind,
            name: input.name,
            replayedBefore: this.replayedCount,
            reason: `forced by --fail-at ${record.callNo}=${formatToolFailure(failure)}: ${input.name} did not run, and the agent got ${failure.kind === 'timeout' ? 'a timeout' : failure.kind === 'status' ? `an HTTP ${failure.status}` : 'an error'} instead, so its error path runs`,
            counterpart: { runId: this.parentRunId ?? record.runId, callNo: record.callNo },
          };
        }
        return { origin: 'injected', occurrence, record, failure };
      }
    }
    this.replayedCount++;
    if (input.kind === 'tool' && this.options.overrides?.has(record.callNo)) {
      this.applied.add(record.callNo);
      return { origin: 'overridden', occurrence, record, result: this.options.overrides.get(record.callNo) };
    }
    if (input.kind === 'tool' && this.options.plants?.has(record.callNo)) {
      this.applied.add(record.callNo);
      return { origin: 'planted', occurrence, record, text: this.options.plants.get(record.callNo)! };
    }
    return { origin: 'replayed', occurrence, record };
  }

  /**
   * The run has ended. A replay that never diverged, yet left recorded model or tool calls unmade,
   * stopped before its recording did: every request it sent matched, but what it never sent (the
   * last model turn, a write) is as much a change, so it leaves the recording there, at the first
   * such call. Clock and random reads left over never make it one. Returns that divergence, which
   * `divergence` holds from now on, or null.
   */
  end(): DivergenceReport | null {
    if (this.mode !== 'replay' || this.state !== 'replaying') return null;
    // The judge's calls are none of the agent's: one never asked again is judged live, not missing.
    const recorded = this.parentCalls.filter((c) => c.end && !isJudgeCall(c));
    const first = recorded.filter((c) => (c.kind === 'api' || c.kind === 'tool') && !this.consumed.has(c.callNo)).reduce<CallRecord | null>((a, c) => (a && a.callNo < c.callNo ? a : c), null);
    if (!first) return null;
    this.state = 'diverged';
    this.divergence = {
      type: 'ended_early',
      callNo: first.callNo,
      kind: first.kind,
      name: first.name,
      replayedBefore: this.replayedCount,
      recorded: recorded.length,
      reason: `the agent stopped after ${this.replayedCount} of the ${recorded.length} recorded calls, before making #${first.callNo}`,
      counterpart: { runId: this.parentRunId ?? first.runId, callNo: first.callNo },
    };
    return this.divergence;
  }

  /** Recorded calls this replay never reached. Meaningful once the run has ended. */
  notReached(): NotReached[] {
    return this.parentCalls
      .filter((c) => c.end && !this.consumed.has(c.callNo) && !isJudgeCall(c))
      .map((c) => ({ callNo: c.callNo, kind: c.kind, name: c.name }));
  }

  /**
   * The caller could not carry out the intervention on this recorded call (text to plant in a result
   * that has none) and has said why; `unapplied` leaves it out.
   */
  declined(callNo: number): void {
    this.applied.delete(callNo);
    this.declinedCalls.add(callNo);
  }

  /**
   * Tool-call interventions that never took effect, each as a sentence: the run forked before
   * reaching the call, or reached it with other arguments, so the result it was meant to change
   * was never served. Meaningful once the run has ended.
   */
  unapplied(): string[] {
    const out: string[] = [];
    const where = this.divergence && this.divergence.type !== 'ended_early' ? `the replay forked at call ${this.divergence.callNo} before reaching it, and calls after a fork are matched to the recording only when they are the same call` : 'the run never made that call';
    const note = (flag: string, callNo: number) => {
      if (this.applied.has(callNo) || this.declinedCalls.has(callNo)) return;
      const rec = this.parentCalls.find((c) => c.callNo === callNo);
      out.push(`${flag} ${callNo} changed nothing: ${rec ? `#${callNo} ${rec.name} was not served, because ${where}` : `the recording has no call #${callNo}`}`);
    };
    for (const n of this.options.toolFailures?.keys() ?? []) note('--fail-at', n);
    for (const n of this.options.overrides?.keys() ?? []) note('--override', n);
    for (const n of this.options.plants?.keys() ?? []) {
      note('--inject-result', n);
      // Served, yet every later call matched the recording: no model saw the planted text.
      if (this.applied.has(n) && !this.divergence) out.push(`--inject-result ${n} reached no model: the replay stayed clean, so the agent never passed #${n}'s result on whole (an agent that cuts or summarizes what a tool returns can drop what was added)`);
    }
    return out;
  }

  get replayed(): number {
    return this.replayedCount;
  }

  /**
   * The failure `--fail-at` asked for on this run's model call `callNo` (every attempt of it): the
   * status, and the parent's call number the flag named. Undefined for a call no flag named.
   */
  injectedFailure(callNo: number): { status: number; target: number } | undefined {
    return this.injected.get(callNo);
  }

  /**
   * `--fail-at` flags on model calls that no call of this run took, each with why: the replay never
   * made a model call at that place. Meaningful once the run has ended.
   */
  unappliedFailures(): string[] {
    const taken = new Set([...this.injected.values()].map((i) => i.target));
    const out: string[] = [];
    for (const [target, status] of this.options.failAt ?? []) {
      if (taken.has(target)) continue;
      const place = this.parentPlaces.get(target);
      if (place === undefined) {
        out.push(`--fail-at ${target}=${status} changed nothing: call #${target} is not a model call of the recording`);
        continue;
      }
      const [scope, index] = place.split('\n') as [string, string];
      const made = this.apiCounts.get(scope) ?? 0;
      out.push(`--fail-at ${target}=${status} changed nothing: call #${target} is the recording's model call ${Number(index) + 1}${scope ? ` of scope ${scope}` : ''}, and the replay made ${made === 0 ? 'none' : `only ${made}`}${scope ? ' there' : ''}`);
    }
    return out;
  }

  /** Whether a call is forced live, with what forced it kept for its divergence report. */
  private isForced(input: ResolveInput, place: string | undefined): boolean {
    this.forcing = null;
    const at = (target: number | undefined) => target !== undefined && place !== undefined && this.parentPlaces.get(target) === place;
    // An injected failure is a change to the response, so the run forks there like any other.
    let failed: { by: string; counterpart: number } | undefined;
    for (const [target, status] of input.kind === 'api' ? (this.options.failAt ?? []) : []) {
      if (!at(target)) continue;
      this.injected.set(input.callNo, { status, target });
      failed = { by: `--fail-at ${target}=${status}: answered with HTTP ${status} instead of the recording, so the agent's error path runs`, counterpart: target };
      break;
    }
    const divergeAt = this.options.divergeAt;
    // --diverge-at on a model call names its place; on any other call, or past the recording, its number.
    const diverged = divergeAt !== undefined && (this.parentPlaces.has(divergeAt) ? at(divergeAt) : input.callNo === divergeAt);
    this.forcing =
      input.forced ??
      failed ??
      (diverged ? { by: `--diverge-at ${divergeAt}`, ...(this.parentPlaces.has(divergeAt!) ? { counterpart: divergeAt! } : {}) } : null) ??
      (at(this.options.promptFrom) ? { by: `--prompt-from ${this.options.promptFrom}: calls before it matched without their system prompt and tool definitions`, counterpart: this.options.promptFrom! } : null);
    if (this.forcing) return true;
    if (input.kind === 'tool' && this.options.liveTools.has(input.name) && !this.forcedTools.has(input.name)) {
      this.forcedTools.add(input.name);
      this.forcing = { by: `--live-tool ${input.name}` };
      return true;
    }
    return false;
  }

  private explain(input: ResolveInput, forced: boolean, occurrence: number): DivergenceReport {
    const base = { callNo: input.callNo, kind: input.kind, name: input.name, replayedBefore: this.replayedCount };
    if (forced) {
      const forcing = this.forcing ?? { by: 'an intervention' };
      const record = forcing.counterpart !== undefined ? this.parentCalls.find((c) => c.callNo === forcing.counterpart) : this.index.get(key(input.kind, input.fingerprint, occurrence, this.scopeOf(input.scope)));
      return { ...base, type: 'forced', reason: `forced live by ${forcing.by}`, ...(record ? { counterpart: { runId: this.parentRunId ?? record.runId, callNo: record.callNo } } : {}) };
    }

    const remaining = this.parentCalls.filter((c) => c.end && !this.consumed.has(c.callNo));
    const changedBy = input.changedBy ? `changed by ${input.changedBy}` : null;
    if (remaining.length === 0) {
      return { ...base, type: 'beyond_recording', reason: 'the agent made more calls than the recording contains' };
    }
    const name = input.matchName ?? input.name;
    const sameName = remaining.filter((c) => c.kind === input.kind && (this.matchName(c) === name || (input.recordedName !== undefined && c.name === input.recordedName)));
    // Within the same scope first: the closest call is most likely the same branch's.
    const sameScope = sameName.filter((c) => this.scopeOf(c.meta.scope) === this.scopeOf(input.scope));
    const candidates = sameScope.length ? sameScope : sameName;
    if (candidates.length === 0) {
      return { ...base, type: 'new_call', reason: `${changedBy ? `${changedBy}; ` : ''}no recorded ${input.kind} call named "${input.name}" remains unconsumed` };
    }

    // Among the unconsumed calls of the same kind and name, the one with the smallest structural diff.
    let best: { record: CallRecord; diff: ReturnType<typeof structuralDiff> } | null = null;
    for (const record of candidates) {
      let recorded: unknown;
      try {
        recorded = this.loadRequest(record);
      } catch {
        continue;
      }
      // Diffed the way they were matched, both sides against both runs' starts, so dates that are
      // "today" in either run (one the replay served back from the recording included) aren't reported as changes.
      const refs = this.clock ? [this.clock.parent, this.clock.run] : undefined;
      const mask = (v: unknown) => {
        // A form upload as it was matched: its parts, not its bytes with their random boundary.
        const view = input.kind === 'api' ? multipartView(v) : v;
        const p = this.options.promptFrom !== undefined && input.kind === 'api' ? withoutPrompt(view) : view;
        return refs === undefined ? p : maskClock(p, refs);
      };
      const diff = [...(input.kind === 'api' && input.headers ? headerDiff(record.meta.fingerprintHeaders as Record<string, string> | undefined, input.headers) : []), ...structuralDiff(mask(recorded), mask(input.request))];
      if (!best || diff.length < best.diff.length) best = { record, diff };
    }
    if (!best) {
      const first = candidates[0]!;
      return { ...base, type: 'request_changed', counterpart: { runId: this.parentRunId ?? first.runId, callNo: first.callNo }, ...(changedBy ? { reason: changedBy } : {}) };
    }
    // A change a flag made is the point of the fork, not a value to mask: no normalizer hints for it.
    if (changedBy) return { ...base, type: 'request_changed', reason: changedBy, counterpart: { runId: this.parentRunId ?? best.record.runId, callNo: best.record.callNo }, diff: best.diff };
    const hints = best.diff.flatMap((e) => (isHeaderEntry(e) ? [] : hintsFor(e, input.kind, input.name)));
    const headers = best.diff.filter(isHeaderEntry).map((e) => e.path.slice('headers.'.length));
    if (headers.length) {
      hints.push({ message: `the ${headers.join(' and ')} header${headers.length === 1 ? ' is' : 's are'} part of what makes a model call the same call, and no normalizer masks ${headers.length === 1 ? 'it' : 'them'}: send the recorded value, or record again with the new one` });
    }
    if (this.clock && best.diff.some((e) => [e.before, e.after].some((v) => typeof v === 'string' && CLOCK_PLACEHOLDERS.some((p) => v.includes(p))))) {
      hints.push({ message: 'dates and timestamps within a day of either run\'s start match as <date>, <datetime> or <epoch>, so "today" in the recording matches "today" now; one side here is further from both. If it is a fixed date, set "clock": "exact" in shadowlap.config.json' });
    }
    return {
      ...base,
      type: 'request_changed',
      counterpart: { runId: this.parentRunId ?? best.record.runId, callNo: best.record.callNo },
      diff: best.diff,
      ...(hints.length ? { hints } : {}),
    };
  }
}
