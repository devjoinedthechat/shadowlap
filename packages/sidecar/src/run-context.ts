/**
 * A run as the sidecar holds it while it records or replays: its session, the calls it gave out and
 * how each attempt of them went, the retries they wait for, what its end reads of them, and what its
 * agent's processes said along the way. One RunContext per run the sidecar has open; every module
 * that handles a call reads and changes the call's run through it.
 */
import { judgeRules, type CallEndRow, type CallKind, type CallRecord, type CallStartRow, type Decision, type Effect, type Normalizer, type Origin, type ResolveInput, type RunRecord, type Session } from '@shadowlap/engine';
import { rulesId } from './fingerprint-cache.js';
import type { CallPlace, RequestInterventions } from './interventions.js';
import type { GuardMode, Hello } from './preloads.js';
import type { ProviderState } from './provider-state.js';
import type { ResponsesState } from './responses-state.js';

export interface CallIdentity {
  kind: CallKind;
  name: string;
  fingerprint: string;
  occurrence: number;
}

export interface TrackedCall {
  identity: CallIdentity;
  effect: Effect | null;
  origin: Origin;
  decision: Decision;
  /** Attempt numbers given out: an attempt takes its number as it starts, so two at once never share one. */
  attempts: number;
  /** Attempts started and not ended yet. */
  inFlight: number;
  /** Whether the latest attempt failed in a way the agent's client retries: the call then waits for that retry (RunContext.retries). */
  retryable: boolean;
  /** Set once an attempt has ended (tool calls await `complete`). */
  done: boolean;
  /** The queue of RunContext.retries a retry of this call is looked for in. */
  retryKey?: string;
  /** Its place among the recording's model calls, as interventions count them. */
  place?: CallPlace;
}

export class RunContext {
  nextCallNo = 1;
  readonly calls = new Map<number, TrackedCall>();
  /**
   * The run's calls as its end reads them, each kept as its rows are queued for the store (keepStart,
   * keepEnd): its end never reads the store, which another process may hold, so it never waits for
   * the lock (endRun). An answer's chunk timing and headers stay the store's alone.
   */
  private readonly records = new Map<number, CallRecord>();
  /**
   * Calls whose last attempt failed in a way the agent's client retries and that have nothing in
   * flight, oldest failure first, by what identifies their request (its scope and fingerprint, or with
   * interventions its fingerprint before any rewrite). The next identical request that reads as a
   * retry is the first one's, so identical calls made at once (best-of-n sampling) each keep their
   * own answer however their retries interleave.
   */
  readonly retries = new Map<string, number[]>();
  /** WebSockets under a provider this run tunnelled or refused, by provider and path. */
  readonly websockets = new Map<string, { count: number; action: 'tunnelled' | 'refused' }>();
  /** The run's normalizers and its judge's rules as a fingerprint cache key names them, worked out once. */
  private ruleIds: { normalizers: string; judge: string } | null = null;
  readonly warnings: string[] = [];
  readonly providersUsed = new Set<string>();
  readonly sdksSeen = new Set<string>();
  /**
   * A model call came from Claude Code, as its user agent names it (`claude-cli/…`): kept on the run
   * (`meta.claudeCode`), whose Claude Code built-ins are then told apart by name (fromClaudeCode).
   */
  claudeCode = false;
  readonly unguarded = new Map<string, { count: number; action: 'warned' | 'blocked' }>();
  // ---- the preloads' hellos and the SDKs' versions (preloads.ts) ----
  /** The guard the CLI started the run's agent with, preloads and all (expectPreloads); null when it started none. */
  preloadGuard: GuardMode | null = null;
  /** The runtimes the config's guard.accept takes, whose unguarded paths fail no run (preloads.ts unguardedReport). */
  preloadAccept: ReadonlySet<string> = new Set();
  /**
   * Each process whose preload said it loaded, by runtime and process id (at most MAX_HELLOS kept),
   * and how many in all: the Claude Agent SDK's fence says hello for the Claude Code CLI from its own
   * process, beside that process's own.
   */
  readonly hellos = new Map<string, Hello>();
  readonly hellosBeyond = new Map<string, number>();
  /** SDK versions already warned about, `node/0.2`. */
  readonly sdkWarned = new Set<string>();
  private readonly warnedTools = new Set<string>();
  /**
   * An ended run opened again for its judge's calls alone (openForJudge): it takes nothing else, and
   * closing it leaves the run's status and end as they were. The first call number it gave out.
   */
  judgeOnly: { from: number } | null = null;
  /** What the recording kept on OpenAI's side, for a live Responses call that continues it (responses-state.ts); null without one. */
  responses: ResponsesState | null = null;
  /** The Gemini caches the recording made and the files it uploaded, for a live call that names one (provider-state.ts); null without any. */
  providerState: ProviderState | null = null;
  /** Why the run itself could not be written to the store, when it couldn't: none of its calls can be then. */
  lost: string | null = null;
  /** Its summary is made (endRun): store trouble said from here on is kept for endWritten. */
  ended = false;

  constructor(
    readonly run: RunRecord,
    readonly session: Session,
    readonly interventions: RequestInterventions | null,
    /** The sidecar's normalizers plus the rules that redacted the parent, if any. */
    readonly normalizers: Normalizer[],
    readonly offline = false,
    readonly slot: string | null = null,
    /**
     * The reference times dates are masked against, or undefined to match them exactly: the run's
     * start, and for a replay its recording's too, since what the replay serves back from the
     * recording carries the recording's dates.
     */
    readonly clockRef: readonly number[] | undefined,
    /** `--prompt-from`: model calls are matched without their system prompt and tool definitions. */
    readonly withoutPrompt = false,
    /**
     * The rules that redacted the parent, which masked its captured HTTP calls' names: a live call
     * is matched by its name masked the same way (matchedAs).
     */
    readonly redactions: Normalizer[] = [],
    /**
     * The providers whose calls in the parent name no API version (`Provider.apiVersion`), as a
     * trace's never do: a live call to one is matched and kept without the version it names.
     */
    readonly unversioned: ReadonlySet<string> = new Set(),
    /**
     * The providers none of whose model calls in the parent kept a query (`meta.query`), as a
     * recording made before calls kept one, or a trace's, never does: a live call to one is matched,
     * and kept, without its query.
     */
    readonly unqueried: ReadonlySet<string> = new Set(),
    /**
     * Whether a model request's numbers are read rounded, as JSON.parse reads them: so the parent,
     * recorded before requests kept their numbers (RunMeta.exactNumbers), is matched as it was stored.
     */
    readonly roundedNumbers = false,
    /**
     * Whether a model call is matched and kept with the parameters its provider takes as headers
     * (Provider.headerParameters): not when the parent holds none (RunMeta.headerParameters), as one
     * made before calls kept them, or imported, never does.
     */
    readonly headerParameters = true,
  ) {}

  /**
   * Opens the run's next call, as every kind of call starts: its number, the session's decision for
   * it (Session.resolve), and the call tracked from then on (`calls`). `extra` is what a model call
   * adds: the queue a retry of it is looked for in, and its place among the recording's model calls.
   */
  openCall(asked: Omit<ResolveInput, 'callNo'>, extra: Pick<TrackedCall, 'retryKey' | 'place'> = {}): { callNo: number; tracked: TrackedCall } {
    const callNo = this.nextCallNo++;
    const decision = this.session.resolve({ ...asked, callNo });
    const identity: CallIdentity = { kind: asked.kind, name: asked.name, fingerprint: asked.fingerprint, occurrence: decision.occurrence };
    const tracked: TrackedCall = { identity, effect: asked.effect ?? null, origin: storedOrigin(asked.kind, decision), decision, attempts: 0, inFlight: 0, retryable: false, done: false, ...extra };
    this.calls.set(callNo, tracked);
    return { callNo, tracked };
  }

  /** Says `message` in the run's warnings, once for `tool`; whether it said it now. */
  warnOnce(tool: string, message: string): boolean {
    if (this.warnedTools.has(tool)) return false;
    this.warnedTools.add(tool);
    this.warnings.push(message);
    return true;
  }

  /** Keeps a call's start as the store will hold it (records), and gives it back: its write gives it its request's ref. */
  keepStart(row: CallStartRow): CallRecord {
    const record: CallRecord = { ...row, end: null, attempts: [] };
    this.records.set(row.callNo, record);
    return record;
  }

  /** Forgets a call whose start could not be written: the store holds nothing of it. */
  dropCall(callNo: number): void {
    this.records.delete(callNo);
  }

  /**
   * Keeps an attempt's end beside its call's start (records), as the store reads a call's ends: in
   * the order of their attempts, the last its end and the others its attempts. In place of `replacing`
   * (an error end written for one that couldn't be), or, with no end, without it (never written).
   */
  keepEnd(callNo: number, end: CallEndRow | null, replacing?: CallEndRow): void {
    const record = this.records.get(callNo);
    if (!record) return;
    const ends = [...record.attempts, ...(record.end ? [record.end] : [])].filter((e) => e !== replacing);
    if (end) ends.push(end);
    ends.sort((a, b) => a.attempt - b.attempt);
    record.end = ends.pop() ?? null;
    record.attempts = ends;
  }

  /** The run's calls as its end reads them (records), in order. */
  recorded(): CallRecord[] {
    return [...this.records.values()].sort((a, b) => a.callNo - b.callNo);
  }

  /** The run's rules as a fingerprint cache key names them (fingerprint-cache.ts). */
  get rules(): { normalizers: string; judge: string } {
    return (this.ruleIds ??= { normalizers: rulesId(this.normalizers), judge: rulesId(judgeRules(this.redactions)) });
  }

  /** The oldest call waiting for a retry of the request `key` identifies, now waiting no more; undefined when none is. */
  claimRetry(key: string): number | undefined {
    const waiting = this.retries.get(key);
    while (waiting?.length) {
      const callNo = waiting.shift()!;
      const call = this.calls.get(callNo);
      if (call?.retryable && call.inFlight === 0) return callNo;
    }
    return undefined;
  }

  /** Puts a call whose attempt just failed retryably at the back of its request's retry queue. */
  awaitRetry(callNo: number, key: string): void {
    const waiting = this.retries.get(key);
    if (waiting) waiting.push(callNo);
    else this.retries.set(key, [callNo]);
  }
}

/** How a decision is stored: a planted result as overridden, a failure Shadowlap answered as live (with `injected` on its end). */
export function storedOrigin(kind: CallKind, decision: Decision): Origin {
  if (decision.origin === 'planted') return 'overridden';
  if (decision.origin === 'injected') return 'live';
  // Overrides apply to tool results; a model call matched under one is a plain replay.
  if (decision.origin === 'overridden' && kind === 'api') return 'replayed';
  return decision.origin;
}

// ---- each attempt of a call: begun, then settled for the agent ----

/** Starts an attempt: its number taken now, before anything waits, and the call no longer waiting for a retry. */
export function beginAttempt(tracked: TrackedCall): number {
  tracked.retryable = false;
  tracked.inFlight++;
  return tracked.attempts++;
}

/** An attempt has ended for the agent: whether its client may retry it, and so whether the call waits for that retry. */
export function settleAttempt(ctx: RunContext, callNo: number, tracked: TrackedCall, retryable: boolean): void {
  tracked.inFlight = Math.max(0, tracked.inFlight - 1);
  tracked.done = true;
  tracked.retryable = retryable;
  if (retryable && tracked.retryKey !== undefined) ctx.awaitRetry(callNo, tracked.retryKey);
}
