import type { ActionItem as ServerAction, CallDetail as ServerCallDetail, CallRow as ServerCallRow, LineageNode as ServerLineageNode, RunDetail as ServerRunDetail, RunListItem as ServerRunListItem } from '../src/api.js';

/**
 * The shapes the dashboard's API answers with, as the views read them: the server's types
 * (`src/api.ts`), widened with the fields other parts of the API add. Each added field is optional,
 * and every view renders it when it is there and falls back to what it can show without it. Types
 * only, and nothing that needs a browser: the tests type-check the modules that import these.
 */

/** How a run came out, as the server classifies it for the Runs table. */
export type RunOutcomeView =
  | { kind: 'running' }
  | { kind: 'diverged'; callNo: number }
  | { kind: 'lost'; callNo: number }
  | { kind: 'check-failed'; check: string | null }
  | { kind: 'passed'; checks: number }
  | { kind: 'clean' }
  | { kind: 'none' };

/** What `/api/runs` may add to a run: its origins, whether it is a test or an attempt, its blame and checks. */
export interface RunListExtras {
  /** One character per call, in order (r replayed, l live, o overridden, i injected, f failed, b blocked, s stubbed), or origin names. */
  origins?: string | string[] | null;
  /** A replay made by `shadowlap test`: the golden and the test session. */
  test?: { golden: string; session?: string } | null;
  /** Set on runs made by `--repeat`, blame and verify: bundled under the run they came from, not listed. */
  attempt?: string | boolean | null;
  repeat?: unknown;
  probe?: unknown;
  verify?: unknown;
  /** The run an attempt is bundled under, and what made it one (`repeat`, `probe`, `verify`). */
  attemptOf?: string | null;
  attemptKind?: string | null;
  blame?: { callNo: number | null } | null;
  /** Where blame found the run was lost, as the Runs table's rows say it. */
  lostAt?: number | null;
  checks?: { passed: number; total: number } | null;
  author?: string | null;
  /** What kind of run it is (`recording`, `fork`, `clean`, `replay`, `test`, `capture`, `pack`), as the server classifies it. */
  kind?: string | null;
  /** How it came out, as the server says it; the views work it out themselves without it. */
  outcome?: RunOutcomeView | null;
  failed?: boolean | null;
  /** How many attempts are bundled under the run. */
  attempts?: number | null;
}
export type RunListItem = ServerRunListItem & RunListExtras;

export interface CallRowExtras {
  /** For a replayed call: how long it took where it was recorded (the parent's call, or further back). */
  recordedMs?: number | null;
  /** What a tool returned, short enough for a table cell. */
  resultShort?: string | null;
  /** Which conversation of the run the call belongs to (a batch run holds many). */
  conversation?: number | null;
  /** A model call whose request starts its conversation. */
  conversationStart?: boolean;
  /** A tool call: the model call that asked for it. */
  requestedBy?: number | null;
  /** A model call where the prompt cache stopped hitting: the tokens sent again, and the call it is judged against. */
  cacheMiss?: { sentAgain: number; previousCallNo: number } | null;
  requestRef?: string | null;
  responseRef?: string | null;
  fingerprint?: string | null;
  /** A recorded user input (`user_input`), read like a tool. */
  input?: boolean;
}
export type CallRow = ServerCallRow & CallRowExtras;

export interface Intervention {
  /** The flag as given: `--fail-at 19=529`. */
  flag: string;
  value?: string | null;
  /** The call it applies to, when it names one. */
  callNo: number | null;
}

export interface BlameView {
  /** The model call whose answer lost the run; null when blame placed it nowhere. */
  callNo: number | null;
  /** The blamed call counted among the model calls in the blame's scope: k of m. */
  modelCall?: { k: number; m: number } | null;
  confidence?: string | null;
  rescuedRunId?: string | null;
  scope?: string | null;
  /** `blamed`, or `unrescuable` (no call it asked again saved the run), or `stopped` before it was done. */
  outcome?: 'blamed' | 'unrescuable' | 'stopped' | null;
}

export interface CheckView {
  label: string;
  ok: boolean;
  /** Attempts that passed it, of those that ran it. */
  count?: number;
  of?: number;
  detail?: string;
}

/** Where the prompt cache stopped hitting: the call, and the tokens it sent again. */
export interface CacheMissView {
  callNo: number;
  tokens: number;
  previousCallNo?: number | null;
  scope?: string | null;
}

/** What the run did that was not recorded, so a replay runs it for real. */
export interface NotRecordedView {
  /** Hosts reached without Shadowlap: how often, and whether the guard let them through. */
  hosts: Array<{ target: string; count: number | null; action: 'warned' | 'blocked' | null }>;
  /** Tools with no declared effect, which the run did not record. */
  tools: string[];
}

/** The run's record for the Provenance tab, when the server works it out (every field optional). */
export interface ProvenanceView {
  models?: Array<{ model: string; calls: number }>;
  /** The providers the model calls went to, most used first. */
  providers?: Array<{ provider: string; calls: number }>;
  calls?: { model: number; tool: number; other: number; scopes: number };
  upstream?: { requests: number; spent: number };
  /** What a copy made now would mask: the rules that apply, and the values they hit (null when not counted). */
  mask?: { rules: number; values: number | null } | null;
  startedUtc?: string;
  endedUtc?: string | null;
}

/** What `/api/runs/:id` may add for the run page. */
export interface RunDetailExtras {
  /** The recorded duration of every replayed call, summed up the parent chain. */
  notWaitedMs?: number | null;
  forkAt?: number | null;
  intervention?: Intervention | null;
  /** A fork that blame made: the run it rescued, and the call it asked again. */
  rescuedBy?: { runId: string; callNo: number | null } | null;
  blame?: BlameView | null;
  checks?: CheckView[] | null;
  notRecorded?: NotRecordedView | null;
  cache?: { readShare: number | null; misses: CacheMissView[] } | null;
  provenance?: ProvenanceView | null;
  /** The fix this failure belongs to. */
  fix?: { id: string; status: string; title: string } | null;
}
export type RunDetail = Omit<ServerRunDetail, 'calls' | 'actions'> & { calls: CallRow[]; actions: ActionItem[] } & RunDetailExtras;

/**
 * An action as the fork menu lists it; `flag`, `group` and `hint` come with the newer action list.
 * `group: null` is an action with a place of its own (Replay, Pack, a normalizer); `choices` are
 * answers a prompt offers as a list (any other answer is accepted too).
 */
export type ActionItem = Omit<ServerAction, 'prompt'> & {
  prompt: { label: string; placeholder?: string; initial?: string; choices?: ReadonlyArray<{ value: string; label: string }> } | null;
  flag?: string;
  group?: 'call' | 'run' | null;
  hint?: string;
};

export type CallDetail = Omit<ServerCallDetail, 'call' | 'actions'> & {
  call: ServerCallDetail['call'] & CallRowExtras;
  actions: ActionItem[];
  /** The fork menu's header for the call: `At #19 · search_web · read tool`. */
  forkTitle?: string;
};

export type LineageNode = ServerLineageNode & { probe?: unknown; verify?: unknown; origins?: string | string[] | null };

export interface LiveRun {
  runId: string;
  calls: number;
}

export interface Meta {
  version: string | null;
  dbPath: string | null;
  /** Actions can run: started by `shadowlap dashboard`, and not read-only. */
  actions: boolean;
  /** An exported HTML copy: recorded data only, no server behind it. */
  static?: boolean;
  exportedAt?: number;
  redacted?: boolean;
  runIds?: string[];
  readOnly?: boolean;
  /** Why it is read-only, for the disabled controls' hover. */
  readOnlyReason?: string | null;
  /** Where the server listens: 127.0.0.1:4777. */
  address?: string | null;
  storeBytes?: number | null;
  /** Runs (attempts left out) and attempts. */
  counts?: { runs: number; attempts: number } | null;
  live?: LiveRun[];
  /** The job kinds `POST /api/jobs` accepts. An action whose kind is missing is not shown. */
  jobKinds?: string[];
  /** The most an upload may hold, in bytes; null when uploads are not possible. */
  uploadLimit?: number | null;
  project?: { name: string; path: string } | null;
  /** How many redaction rules a copy made now applies. */
  redactRules?: number | null;
}

export interface JobLink {
  label: string;
  href: string;
}

export interface JobFile {
  fileId: string;
  name: string;
  label?: string | null;
  /** Relative to the project folder. */
  path?: string;
  bytes?: number | null;
  /** A folder, such as a pack: named in the drawer, not downloaded. */
  directory?: boolean;
}

export interface JobView {
  id: string;
  args: string[];
  runId: string | null;
  opensRun: boolean;
  startedAt: number;
  done: boolean;
  code: number | null;
  newRunId: string | null;
  lines: string[];
  total: number;
  kind?: string;
  title?: string;
  endedAt?: number | null;
  runs?: string[];
  links?: JobLink[];
  files?: JobFile[];
  result?: unknown;
}

/** `/api/changes`: whether anything shown changed since the cursor. */
export interface Changes {
  cursor?: string;
  version?: string | number;
  changed?: boolean;
  runs?: boolean;
  calls?: boolean;
  events?: boolean;
  jobs?: boolean;
  live?: LiveRun[];
}

/** What `shadowlap export html` embeds: the answers this page would otherwise have asked a server for. */
export interface StaticPayload {
  shadowlap: string | null;
  exportedAt: number;
  runIds: string[];
  redacted: boolean;
  responses: Record<string, unknown>;
}
