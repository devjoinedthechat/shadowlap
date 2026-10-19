import type { ActionItem as ServerAction, CallDetail as ServerCallDetail, CallRow as ServerCallRow, LineageNode as ServerLineageNode, RunDetail as ServerRunDetail, RunListItem as ServerRunListItem } from '../src/api.js';
import type { RunOffers as ServerRunOffers } from '../src/run-offers.js';

// Fixes (`/api/fixes`): the read model's own shapes, as the server sends them.
export type { BlameStep, CandidateVerdict, FixActions, FixBundle, FixBundleAttempt, FixDetail, FixList, FixRow, FixRunRef, FixStep, RepairStep, StepKey, StepState, VerifyRow, VerifyStep } from '../src/fixes.js';

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
  /** A model call: the tools its answer asked for, in order (a capture records none of their calls). */
  asks?: string[] | null;
  /** Which conversation of the run the call belongs to (a batch run holds many). */
  conversation?: number | null;
  /** A model call whose request starts its conversation. */
  conversationStart?: boolean;
  /** A tool call: the model call that asked for it. */
  requestedBy?: number | null;
  /** A tool call: the tool-use id the provider gave the request for it. */
  toolUseId?: string | null;
  /** A model call where the prompt cache stopped hitting: the tokens sent again, and the call it is judged against. */
  cacheMiss?: { sentAgain: number; previousCallNo: number } | null;
  requestRef?: string | null;
  responseRef?: string | null;
  fingerprint?: string | null;
  /** A recorded user input (`user_input`), read like a tool. */
  input?: boolean;
}
/** The server's row with the fields above as the views read them: they replace the server's own types for those fields. */
export type CallRow = Omit<ServerCallRow, keyof CallRowExtras> & CallRowExtras;

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
  /** What asking again did, in a few words: "asked again, it calls escalate instead". */
  short?: string | null;
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
  /** What a copy made now would mask: the rules that apply, and the values they hit in a pack (null when not counted, with why when it says; `busy` while it is yet to be counted), what only a copy that is read masks besides (`returned`), and what else they match that a pack leaves as it is (`unmasked`), each when there is any. */
  mask?: { rules: number; values: number | null; returned?: number; unmasked?: number; why?: string; busy?: true } | null;
  startedUtc?: string;
  endedUtc?: string | null;
  /** The run and the runs it came from, the recording first, each with its code version. */
  lineage?: Array<{ runId: string; codeVersion: string | null }>;
}

/**
 * How a run stands, as the server works it out for the run list and the run's page alike: its kind,
 * its outcome, whether that is a failure, and whether it was interrupted (stopped before it ended,
 * with nothing else that failed). `status` is the status the lists show.
 */
export interface RunStateView {
  status: 'running' | 'completed' | 'failed' | 'crashed';
  kind: string;
  outcome: RunOutcomeView;
  failed: boolean;
  interrupted: boolean;
  label: string;
}

/** What `/api/runs/:id` may add for the run page. */
export interface RunDetailExtras {
  /** How the run stands, as Runs, the sidebar and the Overview say it; absent from an older server. */
  state?: RunStateView | null;
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
  fix?: FixView | null;
  /**
   * How the run takes part in Fixes, when the server says: `failing`, `good`, `probe`, `rescued`,
   * `verify`, or `unblamed` (a failed run never blamed).
   */
  fixRole?: string | null;
  /** A failed run never blamed: the check a fix's labels suggest, for Run blame to use (`--expect`). */
  blameExpect?: unknown;
  /** The run's models by the short name a call row carries, as the run page names them (`claude-opus-5`). */
  models?: Record<string, string>;
}

/** A fix as the run page links to it: `#/fixes/<id>`, its status (`open`, `verified`, `applied`) and title. */
export interface FixView {
  id: string;
  status: string;
  title: string;
  /** Where it opens, when the server says. */
  href?: string | null;
  /** The check its failures failed, in words (`send_email never called`), when the server says. */
  check?: string | null;
}
/**
 * The server's run with the fields above as the views read them. The run page's read model sends
 * its own shapes for these (run-page.ts), and normalize.ts reshapes them once, so the view types
 * replace the server's rather than adding to them.
 */
export type RunDetail = Omit<ServerRunDetail, 'calls' | 'actions' | keyof RunDetailExtras> & { calls: CallRow[]; actions: ActionItem[] } & RunDetailExtras;

/**
 * An answer a prompt offers in its list. One with `text` needs a few words more: the dialog shows a
 * field labelled `text`, and sends the value followed by what was typed (`error:` + `connection reset`).
 */
export interface PromptChoice {
  value: string;
  label: string;
  text?: string;
}

/**
 * An action as the fork menu lists it; `flag`, `group` and `hint` come with the newer action list.
 * `group: null` is an action with a place of its own (Replay, Pack, a normalizer); `choices` are
 * answers a prompt offers as a list (any other answer is accepted too).
 */
export type ActionItem = Omit<ServerAction, 'prompt' | 'flag' | 'group' | 'hint'> & {
  prompt: { label: string; placeholder?: string; initial?: string; choices?: readonly PromptChoice[] } | null;
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

/**
 * What the run page offers for a run beyond its record (`/api/runs/:id/offers`): how many redaction
 * rules each copy applies, where the run stands with the team store, the check Run blame uses, Find
 * the commit's revisions, and the diverged test's actions.
 */
export type RunOffers = ServerRunOffers;
export type BlameOffer = NonNullable<ServerRunOffers['blame']>;
export type BisectOffer = NonNullable<ServerRunOffers['bisect']>;
export type TestBannerOffer = NonNullable<ServerRunOffers['test']>;

export interface LiveRun {
  runId: string;
  calls: number;
  /** Its call events, starts and answers: a recording's page asks for its newest calls when they move. */
  events?: number;
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
  /** An exported copy of many runs compares each with this one only (Compare's pickers offer those pairs). */
  compareWith?: string | null;
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
  /**
   * With several projects: its `id` in the list, its folder as the switcher shows it (`display`),
   * whether its setup is finished, why its store can't be opened (`problem`), and what part of the
   * dashboard couldn't start for it (`notice`).
   */
  project?: { name: string; path: string; id?: string; display?: string; settingUp?: boolean; problem?: string; notice?: string } | null;
  /** How many redaction rules a copy made now applies. */
  redactRules?: number | null;
}

export interface JobLink {
  label: string;
  href: string;
  /** Beside the job's primary action: the drawer shows it as a plain link, above its buttons. */
  secondary?: boolean;
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
  /**
   * How it uses its project's working tree: a job that `writes` it (repair, fix apply) runs alone in
   * it, one that `reads` it (runs the agent from it) never alongside one that writes. `doing` says
   * what it is doing there, `folder` the folder it runs in. Null when it runs no agent.
   */
  worktree?: { use: 'reads' | 'writes'; doing: string; folder?: string | null } | null;
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
  /** With several projects: the one the job runs in (its runs and links are that project's). */
  project?: { id: string; name: string };
}

/** A job in `GET /api/jobs`: everything but its output and its result. */
export type JobListItem = Omit<JobView, 'lines' | 'result'>;

/** `/api/changes`: whether anything shown changed since the cursor. */
export interface Changes {
  cursor?: string;
  version?: string | number;
  changed?: boolean;
  runs?: boolean;
  calls?: boolean;
  events?: boolean;
  jobs?: boolean;
  /** Other counted tables that changed, by name (`fixes`, …). */
  other?: string[];
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

// ---- overview-runs: the Overview, the Runs page, imports and the team store -------------------
// The server's own shapes, as its read models answer: nothing other parts of the API reshape.

export type { CacheMissRow, CacheUse, DaySums, FixesFunnel, GridFamily, GridRow, NeedsLook, NeedsLookRow, OutcomeStrip, OverviewSummary, RunGrid, TestsTile, TodayPanel, WeekSums } from '../src/overview.js';
export type { BulkSkip, ChipCounts, DayCount, DeleteResult, RunRow, RunsByDay, RunsPage, RunSort as ServerRunSort, RunType as ServerRunType } from '../src/runs-list.js';
export type { DaysBisect, RunsPageRow } from '../src/routes/runs-list.js';
export type { TraceSourceView } from '../src/routes/imports.js';
export type { TeamStoreStatus } from '../src/team-store.js';
export type { ActivityIcon, ActivityItem, ActivityPage, UploadView } from '../src/views.js';
/** A hit from what runs recorded, naming the run it is an attempt of (the palette's In recorded data). */
export type { RecordedHit, SearchAnswer } from '../src/search-hits.js';

/** What the Runs table asks the server for: a page under the chips, the filter field, the days picked and the sort. */
export interface RunsQuery {
  limit?: number;
  cursor?: string | null;
  /** The days picked: the first one's start and the day after the last one's start. */
  from?: number | null;
  to?: number | null;
  /** The chip picked: a kind, or failed; none for All. */
  types?: readonly string[];
  q?: string;
  sort?: 'when' | 'calls' | 'spent';
}

/** The team store as the screens show it: what this machine knows of it, and who it records as (the By column's "you"). */
export type TeamStoreView = import('../src/team-store.js').TeamStoreStatus & { you: string | null };

/** Where the trace stores are reached from this machine, and whether their keys are set here. */
export interface ImportSources {
  formats: readonly string[];
  traces: { langfuse: import('../src/routes/imports.js').TraceSourceView; langsmith: import('../src/routes/imports.js').TraceSourceView };
  uploadLimit: number | null;
}

/** A bulk label's answer: each run labelled, with its labels after, and the runs left alone with why. */
export interface LabelRunsResult {
  done: Array<{ runId: string; labels: string[] }>;
  skipped: Array<{ runId: string; reason: string }>;
}

// ---- Tests (#/tests) and Settings → CI: the tests slice's read models, as the server sends them.

/** `GET /api/tests`: the goldens on disk and how each did, with the reports as the CLI prints them. */
export type { BisectChoices, BisectMiss, BisectRange, BisectRevision, DivergenceView, FailureView, FoundCommit, GoldenRow, HistoryCell, SinceResult, TestRunBanner, TestsSessionView, TestsVerdict, TestsView } from '../src/tests.js';
/** `GET /api/tests/runs/:id`: what a run's page offers about a test replay, and Find the commit's choices. */
export interface TestRunView {
  banner: import('../src/tests.js').TestRunBanner | null;
  bisect: import('../src/tests.js').BisectChoices | null;
}
/** `GET /api/ci/workflows`: both CI panels for the options they are set to. */
export type { CiListRow, CiTeamStore, CiWorkflowOptions, CiWorkflowsView, PullRequestPreview } from '../src/ci-workflows.js';

// ---- Training (#/training): the training read model's answers, as the server sends them (src/training.ts) ----
export type { ModelCardView, ModelOptionView, ModelsView, PairGroupView, PipView, ScoreDialogView, ScoreRowView, SourceView, TaskRowView, TaskUpdate, TrainingView } from '../src/training.js';

// The decision diff (`/api/decisions`): the read model's own shapes, as the server sends them.
export type { DecisionCell, DecisionRow, DecisionSessionView, DecisionsListView, RetirementsView } from '../src/decisions.js';
export type { DecisionChange, DecisionRun, DecisionStep, DecisionsReport, DecisionView } from '../../engine/src/decisions.js';
export type { RetirementNotice } from '../../engine/src/model-retirements.js';
/** One session whole: a decisions report (`decisions --json`) or a migrate report, with the matrix the page draws. */
export type DecisionSessionDetail = Record<string, unknown> & { kind: 'decisions' | 'migrate'; matrix: import('../src/decisions.js').DecisionRow[] };
/** A run's decisions under each session that asked it again, newest first. */
export type RunDecisionsView = ReturnType<typeof import('../src/decisions.js').runDecisions>;

// ---- Compare (#/compare/<a>/<b>): two runs compared, with what git says about the code between them (src/compare.ts) ----
export type { CodeChange } from '../src/compare.js';
/** `GET /api/compare`: the engine's comparison, and the code card's commits (absent from an exported copy, which has no git behind it). */
export type CompareView = Omit<import('../src/compare.js').CompareView, 'code'> & { code?: import('../src/compare.js').CodeChange | null };
