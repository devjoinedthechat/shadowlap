/**
 * Shared domain types. Field names mirror the store schema.
 */

export type CallKind = 'api' | 'tool' | 'clock' | 'random';
export type Origin = 'live' | 'replayed' | 'blocked' | 'stubbed' | 'overridden';
export type Effect = 'pure' | 'read' | 'write';
export type RunMode = 'record' | 'replay';
export type RunStatus = 'running' | 'completed' | 'failed' | 'crashed';
export type Outcome = 'ok' | 'error';
export type WritePolicy = 'block' | 'stub' | 'allow';
export type ReadPolicy = 'live' | 'replay';
/** What a partial recording holds: a call kind, or one tool's calls (`tool:<name>`). See `RunMeta.covers`. */
export type Coverage = CallKind | `tool:${string}`;

export interface RunCommand {
  argv: string[];
  cwd: string;
}

export interface RunRecord {
  runId: string;
  parentRunId: string | null;
  mode: RunMode;
  status: RunStatus;
  divergence: DivergenceReport | null;
  command: RunCommand;
  codeVersion: string | null;
  startedAt: number;
  endedAt: number | null;
  meta?: RunMeta;
}

/** Free-form per-call metadata. Known keys are documented here; unknown keys are preserved. */
export interface CallMeta {
  /** HTTP status of an API response. */
  status?: number;
  /** Filtered (non-credential) response headers. */
  headers?: Record<string, string>;
  latencyMs?: number;
  usage?: Usage;
  /** SDK retry counter as sent by the client (0 on the first attempt). */
  retryCount?: number;
  /** Whether an error outcome was retryable (429, 5xx, connection error). */
  retryable?: boolean;
  /** The failure was injected by `--fail-at`, not returned by the provider or the tool. */
  injected?: boolean;
  /** Hash of a tool implementation's source, for the changed-implementation warning. */
  implHash?: string;
  /** SSE event boundaries as [byteOffset, msSinceFirstByte] pairs, for paced replay. */
  chunks?: Array<[number, number]>;
  /** The parent run's call this call was replayed from. */
  replayedFrom?: number;
  /** The call was refused because the sidecar ran offline (`shadowlap test`); it never reached the provider. */
  offline?: boolean;
  /** Model calls: the provider id, the requested model, the provider's stop reason, and the response size in bytes. */
  provider?: string;
  model?: string;
  stopReason?: string;
  bytes?: number;
  error?: SerializedError;
  /** The logical branch the call was made in (`scope()` in the SDKs). */
  scope?: string;
  /** A person's input: a `user_input` tool call whose argument is the prompt and whose result is `{ text }`. */
  input?: boolean;
  /**
   * A tool call made through `shadowlap mcp`: the server's transport and its host (`--url`) or
   * command, and, on the first call to it in a run and whenever they change, the tools it offers.
   */
  mcp?: { transport: 'stdio' | 'http'; server: string; tools?: Array<{ name: string; effect: Effect }> };
  [key: string]: unknown;
}

/** Token usage. `inputTokens` is the uncached input; cache reads and writes are separate, whatever the provider reports. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface SerializedError {
  name: string;
  message: string;
  code?: string;
  data?: unknown;
}

export interface CallStartRow {
  runId: string;
  callNo: number;
  kind: CallKind;
  name: string;
  fingerprint: string;
  occurrence: number;
  origin: Origin;
  effect: Effect | null;
  requestRef: string | null;
  meta: CallMeta;
  at: number;
}

export interface CallEndRow {
  runId: string;
  callNo: number;
  attempt: number;
  responseRef: string | null;
  outcome: Outcome;
  meta: CallMeta;
  at: number;
}

/** A call as read back from the store: its start row, its final end row, and any earlier attempts. */
export interface CallRecord extends CallStartRow {
  end: CallEndRow | null;
  attempts: CallEndRow[];
}

/**
 * A rewrite rule. As a normalizer it masks values before fingerprinting; as a redaction rule it
 * masks stored content on export. Same shape, because a redacted recording must still match a
 * live request: the rules that redacted it are applied as normalizers when it is replayed.
 */
export interface Normalizer {
  /** Restrict to a call kind. Omit for any. */
  kind?: CallKind;
  /** Restrict to a call name (tool name, or e.g. "POST /v1/messages"). Omit for any. */
  name?: string;
  /** JSONPath subset: `$.a.b[0].c`, `[*]` and `.*` wildcards, `["key"]`. Omit to apply `pattern` to every string. */
  path?: string;
  /** Named pattern (`iso-date`, `iso-datetime`, `uuid`, `ulid`, `number`, `email`) or a `/regex/flags` literal. With a path, omit to replace the whole value. */
  pattern?: string;
  replace: string;
}

export interface RunMeta {
  /** Rules applied to this run's stored content on export; replays apply them as normalizers. */
  redactions?: Normalizer[];
  /** Hash of the fingerprint version and the normalizers this run's stored fingerprints were computed under; a replay under the same list reuses them. */
  normalizersHash?: string;
  /** Set by `unpack`: the run came from a pack, so its recorded command is someone else's. */
  imported?: { at: number; from: string };
  /**
   * A partial recording: the call kinds it actually contains. An import that only saw the network
   * covers `['api']`; a trace that kept some tools' outputs adds `tool:<name>` for each of those
   * tools. A replay runs every other call live instead of diverging on its absence. Absent means
   * the recording covers everything, which is what a `shadowlap run` produces.
   */
  covers?: Coverage[];
  /**
   * The run was made with what a person types recorded (`user_input` calls, `CallMeta.input`), as
   * every agent the CLI starts is. A recording without the mark and without an input call predates
   * that, so a replay of it runs the agent's reads live instead of forking at the first one.
   */
  inputs?: boolean;
  /** The run replayed a command that came from an imported pack. */
  commandFromImport?: boolean;
  /** One attempt of `shadowlap replay --repeat`: attempts of one invocation share the group. */
  repeat?: { group: string; attempt: number; of: number };
  /** Outcome checks from `shadowlap test` or `shadowlap blame`, as they came out for this run. */
  checks?: Array<{ ok: boolean; label: string; detail: string | null }>;
  /** One attempt of a `shadowlap blame` probe: the run blamed, the model call forced live, and whether the attempt passed. */
  probe?: { of: string; callNo: number; passed: boolean };
  /** The last `shadowlap blame` of this run. */
  blame?: BlameRecord;
  /** One attempt of `shadowlap verify`: the role its recording played, and whether the attempt passed. */
  verify?: { role: 'target' | 'holdout' | 'good'; passed: boolean };
  /** Labels people gave the run: `bug`, `good`, `refund-flow`. */
  labels?: string[];
  /** Notes on the run, or on one of its calls. */
  notes?: RunNote[];
  /** Who made the run (resolveAuthor): an email, a user name, or `ci`. */
  author?: string;
  /** Set on runs made by `shadowlap test`: the golden replayed and the test session it belongs to. */
  test?: { golden: string; session: string };
  /** What a replay changed, as the flags that change it: what made a fork, and how to make it again. */
  interventions?: RunIntervention[];
  /**
   * The checks a replay was judged by when they were given with `--expect` (checks from the config
   * are found again from the recording), so making the fork again judges it the same way.
   */
  expect?: Record<string, unknown>;
  /** What the run did that Shadowlap did not record, so a replay runs it for real (run-facts.ts). */
  notRecorded?: NotRecorded;
}

/**
 * One change a replay made, as its flag. `at` is the parent run's call number it applies at, or null
 * for a policy (`--writes stub`), a tool named by name (`--live-tool`) or another command (`command`:
 * the replay ran `-- <command>` instead of its parent's, which the run's own record holds). `flag` is
 * for display, with long values shortened; `args` are the exact CLI arguments, left out when a value
 * is too large to keep (and for `command`).
 */
export interface RunIntervention {
  kind: 'inject' | 'set' | 'model' | 'override' | 'plant' | 'fail' | 'diverge' | 'prompt-from' | 'live-tool' | 'writes' | 'reads' | 'command';
  at: number | null;
  flag: string;
  args?: string[];
}

export interface NotRecorded {
  /** Outbound connections the network guard saw bypass Shadowlap (`host:port`), with how often and whether they were let through. */
  hosts: Array<{ target: string; count: number; action: 'warned' | 'blocked' }>;
  /** Tools `shadowlap init` finds in the project with no declared effect, which the run did not record. */
  tools: string[];
}

/** What `shadowlap blame` found, kept on the run it blamed. */
export interface BlameRecord {
  at: number;
  outcome: 'blamed' | 'unrescuable' | 'stopped';
  /** The model call whose recorded answer lost the run, or null. */
  callNo: number | null;
  confidence: 'high' | 'medium' | 'low';
  /** A fork that passed from the blamed call on. */
  rescuedRunId: string | null;
  /** Request fields a probe changed from the probed call on; empty when it only resampled. */
  fields: Record<string, unknown>;
  /** The scope whose model calls were probed, when blame was limited to one. */
  scope?: string;
  oracle: string[];
  probes: Array<{ callNo: number; passes: number; attempts: number; rescued: boolean }>;
  spent: number;
}

export interface RunNote {
  /** The call the note is about, or null for the run. */
  callNo: number | null;
  text: string;
  at: number;
}

export type DivergenceType = 'request_changed' | 'new_call' | 'forced' | 'beyond_recording';

export interface DiffEntry {
  path: string;
  op: 'changed' | 'added' | 'removed';
  before?: unknown;
  after?: unknown;
}

export interface Hint {
  message: string;
  normalizer?: Normalizer;
}

export interface DivergenceReport {
  type: DivergenceType;
  callNo: number;
  kind: CallKind;
  name: string;
  /** Calls served from the recording before this one. */
  replayedBefore: number;
  counterpart?: { runId: string; callNo: number };
  diff?: DiffEntry[];
  hints?: Hint[];
  reason?: string;
}

export interface NotReached {
  callNo: number;
  kind: CallKind;
  name: string;
}

export interface RunSummary {
  runId: string;
  mode: RunMode;
  status: RunStatus;
  total: number;
  byOrigin: Record<Origin, number>;
  byKind: Record<CallKind, number>;
  /** Live API calls, i.e. requests that reached the upstream provider. */
  upstreamRequests: number;
  /** Live calls Shadowlap answered itself with `--fail-at`: model calls that reached no provider, tools that did not run. */
  injected: number;
  /**
   * Model calls answered with the reason an intervention could not be applied to them: they reached no
   * provider either. `summarizeRun` always counts them; a summary built or saved elsewhere may not.
   */
  refused?: number;
  /**
   * The run came from elsewhere — a pack someone recorded, or a capture — so the calls it holds were
   * made by someone else's process. Its cost is `captured`, not `spent`, and it made no upstream requests.
   */
  imported: boolean;
  /** Usage recorded on replayed API calls: tokens that did not have to be spent again. */
  tokensNotRespent: Usage;
  /**
   * Approximate USD: `spent` on live model calls, `saved` by replayed ones, `captured` for the calls an
   * imported run holds (spent by whoever made the traffic, not here). Models without a known price are listed.
   */
  cost: { spent: number; saved: number; captured: number; unknownModels: string[] };
  /** Wall-clock milliseconds of the run, when it has ended. */
  durationMs: number | null;
  notReached: NotReached[];
  warnings: string[];
  divergence: DivergenceReport | null;
}
