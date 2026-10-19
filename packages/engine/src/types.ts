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
  /** A model call's query string as the agent sent it, without `?` and without credentials (Azure's `api-version=…`, Gemini's `alt=sse`). */
  query?: string;
  /** The logical branch the call was made in (`scope()` in the SDKs). */
  scope?: string;
  /** A person's input: a `user_input` tool call whose argument is the prompt and whose result is `{ text }`. */
  input?: boolean;
  /**
   * A tool call made through `shadowlap mcp`: the server's transport and its host (`--url`) or
   * command, and, on the first call to it in a run and whenever they change, the tools it offers.
   */
  mcp?: { transport: 'stdio' | 'http'; server: string; tools?: Array<{ name: string; effect: Effect; trust?: 'untrusted' }> };
  /**
   * Whether the tool brings outside text in (a web page, an email, a ticket), where `shadowlap
   * injection` plants payloads, as declared when the call was made (`trustFrom`): the config's
   * `tools` (either way), the SDK's `trust` option or an MCP server's `openWorldHint` (untrusted only).
   * The config read when a run is analysed wins over it (injection.ts).
   */
  trust?: 'untrusted' | 'trusted';
  trustFrom?: 'config' | 'sdk' | 'mcp';
  /**
   * A call Shadowlap's judge made (scope `shadowlap:judge`): the check it answered, by its name in
   * the config; `ask`, a digest of the check's question, what it reads and its model (judgeAskId);
   * and `v`, the version of the request it sent (JUDGE_REQUEST_VERSION), absent before it was kept.
   */
  judge?: { check: string; ask: string; v?: number };
  [key: string]: unknown;
}

/** A check's verdict. These are the only verdict words, in the CLI, the reports, the JSON and every page. */
export type CheckStatus = 'passed' | 'failed' | 'inconclusive' | 'not-applicable';

/** How a judge check came out, kept beside its result. */
export interface JudgeOutcome {
  /** The check's name in the config. */
  name: string;
  model: string;
  /** What the judge read: the final answer, the agent's output, or the run. */
  of: 'answer' | 'output' | 'run';
  /** The judge's answer, or null when it was not judged. */
  verdict: 'yes' | 'no' | null;
  /** Where the verdict came from: the recording (free, the same every time) or the judge, asked live. Null when not judged. */
  source: 'recording' | 'live' | null;
  /** USD the judge's call cost: 0 from the recording, null for a model with no price. */
  cost: number | null;
  /** How many of the project's redaction rules applied to what the judge read. */
  redactions: number;
  /**
   * Whether what the judge read had what replay matching masks masked too (the project's normalizers,
   * dates near the run's start): the agent's requests when it read the run, what it printed when it
   * read the output. Absent from results kept before it was.
   */
  normalized?: boolean;
  /** Characters of what it read that were left out, to keep it within the judge's limit; 0 when it read it whole. */
  cut: number;
  /** The judge's call in the run, when it made one. */
  callNo?: number;
}

/**
 * One check's result, as a run or a test result keeps it: `status` passed, failed, inconclusive or
 * not applicable (absent on results kept before checks had one, which `ok` then says), `ok` (true
 * for passed and not applicable), what was expected (`label`), what happened (`detail`), and for a
 * judge check its `reason`, where its verdict came from (`source`) and how it came out (`judge`).
 */
export interface StoredCheck {
  status?: CheckStatus;
  ok: boolean;
  label: string;
  detail: string | null;
  /** A judge check's reason for its verdict, in its own words. */
  reason?: string;
  /** Where a judge check's verdict came from: the recording, or the judge asked live. */
  source?: 'recording' | 'live';
  judge?: JudgeOutcome;
}

/** What a run's judge calls did and cost, apart from the agent's calls (`RunSummary.judge`). */
export interface JudgeSummary {
  calls: number;
  /** Answered from the recording, at no cost. */
  replayed: number;
  /** Asked live. */
  live: number;
  /**
   * Answered by no one: the recording didn't hold them, and there was no way to ask the judge live.
   * A run keeps no such call now (nothing is kept of a request no one answered), so it is 0 but for
   * runs recorded before.
   */
  notAsked: number;
  upstreamRequests: number;
  /** USD the live ones cost, and what the ones from the recording would have. */
  spent: number;
  saved: number;
  unknownModels: string[];
}

/** Whether a tool's results can carry an attacker's text: `untrusted` reads are where `shadowlap injection` plants. */
export type Trust = 'trusted' | 'untrusted';

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
  /**
   * Set by `unpack` and `pull`: the run came from a pack or the team store, so its recorded command
   * is someone else's. `from`: the pack's folder, or the store's URL (`s3://…`, `gs://…`, `az://…`,
   * `r2://…`), which marks a run pulled from it (`pulledRun`). `pr`: it came from a pull request's
   * folder in the store, so it never goes back into the store's own runs.
   */
  imported?: { at: number; from: string; pr?: string };
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
  /** Outcome checks from `shadowlap test` or `shadowlap blame`, as they came out for this run: a judge check's with its verdict and reason. Older runs' carry no `status`: read it with `checkStatus`. */
  checks?: StoredCheck[];
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
  /** With `author` `ci`: the CI provider it ran under (ciProvider): github, gitlab, buildkite… */
  ci?: string;
  /**
   * Set on runs made by `shadowlap test`: the golden replayed and the test session it belongs to. A
   * golden replayed more than once in a session (`repeat`) numbers its attempts from 1 (`attempt`),
   * and each is filed under the attempt the golden's result shows (`of`, on every attempt but that
   * one; under the first while the session still runs), as one test run with its attempts.
   */
  test?: { golden: string; session: string; attempt?: number; of?: string };
  /** What a replay changed, as the flags that change it: what made a fork, and how to make it again. */
  interventions?: RunIntervention[];
  /**
   * The checks a replay was judged by when they were given with `--expect` (checks from the config
   * are found again from the recording), so making the fork again judges it the same way.
   */
  expect?: Record<string, unknown>;
  /** What the run did that Shadowlap did not record, so a replay runs it for real (run-facts.ts). */
  notRecorded?: NotRecorded;
  /**
   * One attempt of `shadowlap tasks score` or `tasks serve`: the golden replayed up to the takeover
   * call, the model that answered from there (and its endpoint), and the share of checks it passed.
   * An attempt that stopped before it could be scored (the model didn't answer, the golden forked
   * before the takeover) has no score, and says why.
   */
  task?: { golden: string; model: string; baseUrl?: string; takeover: number; attempt: number; of: number; score: number | null; stopped?: string; session: string };
  /** One replay of `shadowlap injection`: which test made it, and what it showed (injection.ts). */
  injection?: InjectionMark;
}

/**
 * One replay `shadowlap injection` made, kept on its run: the result it belongs to (`inj-…`), its
 * role, the untrusted read (the parent's call number) and payload it tested, its canary, and what
 * it showed. `attempt` plants the payload; `baseline` replays from the read with nothing planted,
 * which `influenced` compares with; `clean` replaces the read with a neutral result (`--clean`).
 */
export interface InjectionMark {
  result: string;
  role: 'attempt' | 'baseline' | 'clean';
  read: number;
  payload?: string;
  attempt: number;
  of: number;
  canary?: { token: string; address: string; id: string; amount: string };
  verdict?: 'obeyed' | 'influenced' | 'ignored' | 'inconclusive';
  /** Why an inconclusive attempt shows nothing. */
  why?: string | null;
  /** The attempt's model call that first read the planted text: where it forked. */
  readAt?: number | null;
  /** What the verdict rests on: a write or a read carrying the canary, or a write no clean replay made. */
  evidence?: Array<{ callNo: number; tool: string; path: string; value: string; kind: 'canary' | 'read' | 'write' }>;
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

/**
 * Why a replay left its recording. `ended_early`: it never sent a request the recording doesn't
 * hold, but stopped before making every recorded model or tool call (`DivergenceReport.recorded`).
 */
export type DivergenceType = 'request_changed' | 'new_call' | 'forced' | 'beyond_recording' | 'ended_early';

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
  /**
   * `ended_early`: how many calls the recording holds, clock and random reads included. The replay
   * made `replayedBefore` of them, every one it made, and `callNo` is the first recorded model or
   * tool call it never made, numbered as the recording numbers it (`counterpart` names it too).
   */
  recorded?: number;
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
   * A teammate's recording pulled from the team store is not: its requests and spend count as its
   * author made them (`run.meta.author`; `run.meta.imported.from` names the store).
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
  /**
   * A run with judge calls: what they did and cost. Every other field is the agent's alone, so a
   * judge never changes what a run says the agent cost, sent upstream or replayed.
   */
  judge?: JudgeSummary;
}
