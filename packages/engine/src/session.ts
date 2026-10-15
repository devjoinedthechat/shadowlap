import { CLOCK_PLACEHOLDERS, maskClock } from './clock.js';
import { withoutPrompt } from './prompt.js';
import { hintsFor, structuralDiff } from './diff.js';
import type { CallKind, CallRecord, Coverage, DivergenceReport, Effect, NotReached, ReadPolicy, RunMode, WritePolicy } from './types.js';

/**
 * The per-run state machine: REPLAYING → DIVERGED, with call-key matching on
 * (kind, fingerprint, occurrence). One session exists per run in both modes; in record mode every
 * call is live, but occurrences still have to be counted.
 */

export interface ReplayOptions {
  writes: WritePolicy;
  reads: ReadPolicy;
  /** Tools whose first call is forced live: a fixed tool's call key doesn't change with its code, so it must be forced. */
  liveTools: ReadonlySet<string>;
  /**
   * The calls the recording covers, when it is partial (see `RunMeta.covers`): call kinds, and
   * `tool:<name>` for a tool whose calls it holds when it doesn't hold every tool's. A call it
   * doesn't cover runs live and never ends the replay, because its absence is expected rather than a
   * divergence. Undefined means the recording covers every kind.
   */
  kinds?: ReadonlySet<Coverage>;
  /**
   * Model calls to answer with an HTTP failure instead of the recording, by call number.
   * Error handling is the part of an agent a replay exercises for free, and the part no
   * recording of a healthy run contains: this is how a 429 or a 500 gets into the path.
   */
  failAt?: ReadonlyMap<number, number>;
  /** A call number forced live. */
  divergeAt?: number;
  /** A model call from which a changed prompt applies: earlier model calls match without their prompt, and this one is forced live. */
  promptFrom?: number;
  /** Tool results to substitute, by the parent run's call number (tool-result override). */
  overrides?: ReadonlyMap<number, unknown>;
  /**
   * Ask for a person's input live after the fork (`--live-input`). By default there is no one to
   * type there, so recorded input is served in the order it was given.
   */
  liveInput?: boolean;
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
  /** Reuse an occurrence instead of allocating one: this attempt retries an earlier call. */
  occurrence?: number;
  /**
   * The logical branch the call was made in (`scope()` in the SDKs), e.g. `orchestrator/researcher-2`.
   * Repeats are counted per scope, so identical calls from branches that run at once keep their own
   * recorded answers whatever order they arrive in.
   */
  scope?: string;
  /** A person's input (a `user_input` tool call, recorded with `meta.input`). */
  input?: boolean;
}

export type Decision =
  | { origin: 'replayed'; occurrence: number; record: CallRecord }
  | { origin: 'overridden'; occurrence: number; record: CallRecord; result: unknown }
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
  /** Start times of the parent run and this one, when dates near them are masked for matching (clock.ts). */
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
  private readonly parentCalls: CallRecord[];
  private readonly consumed = new Set<number>();
  private readonly occurrences = new Map<string, number>();
  private readonly forcedTools = new Set<string>();
  private readonly loadRequest: (record: CallRecord) => unknown;
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
    this.clock = opts.clock;
    this.state = this.mode === 'replay' ? 'replaying' : 'diverged';
    this.scoped = this.mode === 'record' || this.parentCalls.some((c) => typeof c.meta.scope === 'string');
    this.holdsInput = opts.parentRecordsInput === true || this.parentCalls.some((c) => c.meta.input === true);
    for (const c of this.parentCalls) {
      if (c.end) this.index.set(key(c.kind, c.fingerprint, c.occurrence, this.scopeOf(c.meta.scope)), c);
    }
  }

  private scopeOf(scope: unknown): string {
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

    const forced = this.isForced(input);
    if (this.state === 'replaying') {
      const record = forced ? undefined : this.index.get(key(input.kind, input.fingerprint, occurrence, scope));
      if (record && !this.consumed.has(record.callNo)) return this.serve(input, record, occurrence);
      this.state = 'diverged';
      this.divergence = this.explain(input, forced, occurrence);
    } else if (input.kind === 'tool' && (effect === 'pure' || (effect === 'read' && this.options.reads === 'replay'))) {
      // After divergence only declared-pure results (and reads, on request) may come from the recording.
      const record = this.index.get(key(input.kind, input.fingerprint, occurrence, scope));
      if (record && !this.consumed.has(record.callNo)) return this.serve(input, record, occurrence);
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

  /** Whether a partial recording holds calls like this one: their kind, or for a tool, its name. */
  private covers(input: ResolveInput): boolean {
    const kinds = this.options.kinds!;
    return kinds.has(input.kind) || (input.kind === 'tool' && kinds.has(`tool:${input.name}`));
  }

  /** Serves a matched record, substituting an override for a tool result when one was given. */
  private serve(input: ResolveInput, record: CallRecord, occurrence: number): Decision {
    this.consumed.add(record.callNo);
    this.replayedCount++;
    if (input.kind === 'tool' && this.options.overrides?.has(record.callNo)) {
      return { origin: 'overridden', occurrence, record, result: this.options.overrides.get(record.callNo) };
    }
    return { origin: 'replayed', occurrence, record };
  }

  /** Recorded calls this replay never reached. Meaningful once the run has ended. */
  notReached(): NotReached[] {
    return this.parentCalls
      .filter((c) => c.end && !this.consumed.has(c.callNo))
      .map((c) => ({ callNo: c.callNo, kind: c.kind, name: c.name }));
  }

  get replayed(): number {
    return this.replayedCount;
  }

  private isForced(input: ResolveInput): boolean {
    // An injected failure is a change to the response, so the run forks there like any other.
    if (input.kind === 'api' && this.options.failAt?.has(input.callNo)) return true;
    if (this.options.divergeAt !== undefined && input.callNo === this.options.divergeAt) return true;
    if (this.options.promptFrom !== undefined && input.callNo === this.options.promptFrom) return true;
    if (input.kind === 'tool' && this.options.liveTools.has(input.name) && !this.forcedTools.has(input.name)) {
      this.forcedTools.add(input.name);
      return true;
    }
    return false;
  }

  private explain(input: ResolveInput, forced: boolean, occurrence: number): DivergenceReport {
    const base = { callNo: input.callNo, kind: input.kind, name: input.name, replayedBefore: this.replayedCount };
    if (forced) {
      const failed = input.kind === 'api' ? this.options.failAt?.get(input.callNo) : undefined;
      const by =
        failed !== undefined
          ? `--fail-at ${input.callNo}=${failed}: answered with HTTP ${failed} instead of the recording, so the agent's error path runs`
          : this.options.divergeAt === input.callNo
            ? `--diverge-at ${input.callNo}`
            : this.options.promptFrom === input.callNo
              ? `--prompt-from ${input.callNo}: calls before it matched without their system prompt and tool definitions`
              : `--live-tool ${input.name}`;
      const record = this.index.get(key(input.kind, input.fingerprint, occurrence, this.scopeOf(input.scope)));
      return { ...base, type: 'forced', reason: `forced live by ${by}`, ...(record ? { counterpart: { runId: this.parentRunId ?? record.runId, callNo: record.callNo } } : {}) };
    }

    const remaining = this.parentCalls.filter((c) => c.end && !this.consumed.has(c.callNo));
    if (remaining.length === 0) {
      return { ...base, type: 'beyond_recording', reason: 'the agent made more calls than the recording contains' };
    }
    const sameName = remaining.filter((c) => c.kind === input.kind && c.name === input.name);
    // Within the same scope first: the closest call is most likely the same branch's.
    const sameScope = sameName.filter((c) => this.scopeOf(c.meta.scope) === this.scopeOf(input.scope));
    const candidates = sameScope.length ? sameScope : sameName;
    if (candidates.length === 0) {
      return { ...base, type: 'new_call', reason: `no recorded ${input.kind} call named "${input.name}" remains unconsumed` };
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
      // Diffed the way they were matched, so dates that are "today" in both runs aren't reported as changes.
      const mask = (v: unknown, ref?: number) => {
        const p = this.options.promptFrom !== undefined && input.kind === 'api' ? withoutPrompt(v) : v;
        return ref === undefined ? p : maskClock(p, ref);
      };
      const diff = structuralDiff(mask(recorded, this.clock?.parent), mask(input.request, this.clock?.run));
      if (!best || diff.length < best.diff.length) best = { record, diff };
    }
    if (!best) {
      const first = candidates[0]!;
      return { ...base, type: 'request_changed', counterpart: { runId: this.parentRunId ?? first.runId, callNo: first.callNo } };
    }
    const hints = best.diff.flatMap((e) => hintsFor(e, input.kind, input.name));
    if (this.clock && best.diff.some((e) => [e.before, e.after].some((v) => typeof v === 'string' && CLOCK_PLACEHOLDERS.some((p) => v.includes(p))))) {
      hints.push({ message: 'dates and timestamps within a day of each run\'s start match as <date>, <datetime> or <epoch>, so "today" in the recording matches "today" now; one side here is further from its run\'s start. If it is a fixed date, set "clock": "exact" in shadowlap.config.json' });
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
