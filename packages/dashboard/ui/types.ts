import type { Estimate } from '../../engine/src/estimates/estimate.js';
import type { ActionItem as ServerAction, CallDetail as ServerCallDetail, CallRow as ServerCallRow, CallsPage as ServerCallsPage, LineageNode as ServerLineageNode, RunDetail as ServerRunDetail, RunListItem as ServerRunListItem } from '../src/api.js';
import type { NextStep, NextStepRow } from '../src/next-step.js';
import type { RunJudged } from '../src/run-outcome.js';
import type { RunOffers as ServerRunOffers } from '../src/run-offers.js';
import type { RunAbout } from '../../engine/src/about.js';
import type { JudgeOutcome } from '../../engine/src/types.js';
export type { AboutFrom, RunAbout } from '../../engine/src/about.js';
export type { BlameBeside, GateEntry, NextStep, NextStepRow } from '../src/next-step.js';

// Fixes (`/api/fixes`): the read model's own shapes, as the server sends them.
export type { BlameStep, CandidateVerdict, FixActions, FixBundle, FixBundleAttempt, FixDetail, FixList, FixPr, FixRow, FixRung, FixRunRef, FixStep, RepairStep, StepKey, StepLine, StepState, VerifyMore, VerifyRow, VerifyStep } from '../src/fixes.js';
export type { FixBucket, FixesView, FixesViewRow, UnblamedRow } from '../src/fixes-view.js';
export type { FixLead } from '../src/fix-lead.js';
export type { BlameCrash } from '../src/fix-blame-step.js';
// Injection tests (`/api/injection`): a result's row, and the report it keeps, as --json prints it.
export type { InjectionRow, RunInjection } from '../src/injection.js';
export type { ToolTrustRow } from '../src/tool-trust.js';
// What a run's page draws of them: a result's panel (its matrix's reads, payloads and cells), an attempt's plant, a report's preview.
export type { AttemptPlant, InjectionCellView, InjectionPanelView } from '../src/injection-view.js';
export type { ReportPreview } from '../src/injection-report.js';
export type { UntrustedView } from '../../engine/src/injection.js';
export type { AttemptReport as InjectionAttempt, CellReport as InjectionCell, CleanReport as InjectionCleanReport, InjectionReport, PlantReport as InjectionPlantReport, ProofParts } from '../../engine/src/injection.js';
export type { InjectionMark } from '../../engine/src/types.js';

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
  /** Lost at `callNo`, or with `range`, gradually around two calls (no one call lost it) or between two (the probes between could not decide). */
  | { kind: 'lost'; callNo: number; range?: { from: number; to: number; gradual?: true } | null }
  | { kind: 'check-failed'; check: string | null }
  /** No check failed, and one could not be decided. */
  | { kind: 'inconclusive'; check: string | null }
  /** `checks` passed; `notApplicable` did not apply, when any did. */
  | { kind: 'passed'; checks: number; notApplicable?: number }
  | { kind: 'clean' }
  | { kind: 'none' };

/** A run's outcome checks counted: `passed` of `total`, and when any, those `inconclusive` and `notApplicable`; the rest failed. */
export interface CheckCountsView {
  passed: number;
  total: number;
  inconclusive?: number;
  notApplicable?: number;
}

/** What `/api/runs` may add to a run: its origins, whether it is a test or an attempt, its blame and checks. */
export interface RunListExtras {
  /** One character per call, in order (r replayed, l live, o overridden, i injected, f failed, b blocked, s stubbed), or origin names. */
  origins?: string | string[] | null;
  /** Its totals (what it spent, its calls by origin) aren't added up yet: the list is asked again once they are. */
  warming?: true | null;
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
  /** The fork blame rescued a run with: the run it rescued. A run of its own, though blame made it as a probe. */
  rescues?: string | null;
  /** Where blame found the run lost: `range`, the two calls it was lost around or between, when no one call is pinned. */
  blame?: { callNo: number | null; range?: { from: number; to: number; gradual?: true } | null } | null;
  /** Where blame found the run was lost, as the Runs table's rows say it. */
  lostAt?: number | null;
  checks?: CheckCountsView | null;
  author?: string | null;
  /** What kind of run it is (`recording`, `fork`, `clean`, `replay`, `test`, `capture`, `pack`), as the server classifies it. */
  kind?: string | null;
  /** How it came out, as the server says it; the views work it out themselves without it. */
  outcome?: RunOutcomeView | null;
  failed?: boolean | null;
  /** How many attempts are bundled under the run. */
  attempts?: number | null;
  /**
   * What the run was about, one quiet line worked out from it (decision 10: the id is its name).
   * Absent from an older server, and from a copy exported before it: the views show the id alone.
   */
  about?: RunAbout | null;
  /** Its outcome by checks, as the server judged it (run-outcome.ts); absent from an older server, and while it isn't judged yet. */
  judged?: RunJudged | null;
  /** For a test replay its agent's exit failed: the code, as its test result keeps it. */
  exitCode?: number;
  /** For a failed test replay whose golden passed when it ran again since: the run that passed, which its status names. */
  fixedBy?: string;
  /** What its page leads with, in the light form a list carries; absent from an exported copy. */
  next?: NextStepRow | null;
  /** What its page's Replay replays, where its next step is another: for ⌘K on its row. Absent from an exported copy. */
  replay?: NextStepRow | null;
}
export type RunListItem = Omit<ServerRunListItem, 'about'> & RunListExtras;

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
  /** A top agent's conversation start: the first sentence of what it was asked; absent from an older server or copy. */
  conversationInput?: string | null;
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
  /** The two calls it was lost around or between, when no one call is pinned: the banner says so, never "lost at". */
  range?: { from: number; to: number; gradual?: true } | null;
  /** The blamed call counted among the model calls in the blame's scope: k of m. */
  modelCall?: { k: number; m: number } | null;
  confidence?: string | null;
  rescuedRunId?: string | null;
  scope?: string | null;
  /** `blamed`, or `unrescuable` (no call it asked again saved the run), or `stopped` before it was done. */
  outcome?: 'blamed' | 'unrescuable' | 'stopped' | null;
  /** An `unrescuable` blame whose first probe couldn't tell: inconclusive at the first model call, never "no call saves the run". */
  unsettled?: boolean;
  /** What asking again did, in a few words: "asked again, it calls escalate instead". */
  short?: string | null;
}

export interface CheckView {
  label: string;
  ok: boolean;
  /** How it came out, when the server says: a result kept before results had a status reads as `ok` says. */
  status?: CheckStatusView;
  /** A judge's reason for its verdict, and where the verdict came from. */
  reason?: string;
  source?: 'recording' | 'live';
  /** Attempts that passed it, of those that ran it. */
  count?: number;
  of?: number;
  detail?: string;
  /** A judge check's judge, as the run endpoint keeps it: its verdict, where that came from, what it cost and read, and its call in the run. */
  judge?: JudgeOutcome;
}

/** How a check came out: passed, failed, inconclusive (it could not be decided) or not applicable (a `when` whose condition never held). */
export type CheckStatusView = 'passed' | 'failed' | 'inconclusive' | 'not-applicable';

/** One check's result as the CLI reports it (`shadowlap check --json`, a test's checks). `ok` is true for passed and not applicable. */
export interface CheckResultView {
  status: CheckStatusView;
  ok: boolean;
  label: string;
  detail: string | null;
  /** A judge's reason, and where its verdict came from. */
  reason?: string;
  source?: 'recording' | 'live';
}

/** The result of a `check` job: `shadowlap check --json`, recordings judged by a check with nothing replayed. */
export interface CheckReportView {
  expect: unknown;
  recordings: Array<{ runId: string; pack: string | null; labels: string[]; source: string; outcome: 'passed' | 'failed' | 'inconclusive'; why: string[]; checks: CheckResultView[] }>;
  counts: { passed: number; failed: number; inconclusive: number };
  unchecked: string[];
  /** Recordings labelled good that fail, labelled bug that pass. */
  notes: string[];
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
  /** The providers the model calls went to, most used first; `via`, the host of another's format they went through. */
  providers?: Array<{ provider: string; calls: number; via?: string }>;
  /** The preloads in the agent's processes, as the run keeps them (`RunMeta.preloads`), or null. */
  preloads?: { guard: 'warn' | 'block' | 'off'; hellos: Record<string, number>; missing: string | null; unguarded?: string | null } | null;
  calls?: { model: number; tool: number; other: number; scopes: number };
  upstream?: { requests: number; spent: number };
  /** What a copy made now would mask: the rules that apply, and the values they hit in a pack (null when not counted, with why when it says; `busy` while it is yet to be counted), what only a copy that is read masks besides (`returned`), what else they match that a pack leaves as it is (`unmasked`), and the run's own canaries they would have masked, which a copy keeps and the count leaves out (`kept`), each when there is any. */
  mask?: { rules: number; values: number | null; returned?: number; unmasked?: number; kept?: number; why?: string; busy?: true } | null;
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
  /** Attempts bundled under the run, at any depth, which deleting it takes with it; absent from an older server or copy. */
  attempts?: number;
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
  /** A blame probe's attempt: the run it probed and the model call it asked again, which its banner links back to. */
  probeOf?: { of: string; callNo: number } | null;
  /** A verify attempt: where the verdict it counted towards opens. */
  verifyOf?: { href: string } | null;
  /**
   * An attempt made with others (a probe's, a verify's, a `--repeat`'s): its place among them and how
   * many were made, which its record's `repeat.of` (the most that could be) is not. Absent from an older server.
   */
  attemptPlace?: { k: number; n: number } | null;
  /** The run's models by the short name a call row carries, as the run page names them (`claude-opus-5`). */
  models?: Record<string, string>;
  /** What the run was about, as the lists say it; absent from an older server. */
  about?: RunAbout | null;
  /** Its next step, the header's lime button (src/next-step.ts); in an exported copy only a comparison it can make. */
  next?: NextStep;
  /** Replay as the header keeps it beside the next step: on a clean or a test replay, its recording's. */
  replay?: NextStep;
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
  /** How it stands, as Fixes says it, in the words its link says, when the server says (fix-for-run.ts `fixSaid`). */
  said?: { tone: 'warn' | 'ok' | 'err'; text: string; why: string } | null;
  /** What the run's finding says of it, when the server says: how it stands, for a run that fails in it (fix-for-run.ts `fixStateWords`); what a good run of it is for. */
  state?: string | null;
}
/**
 * The server's run with the fields above as the views read them. The run page's read model sends
 * its own shapes for these (run-page.ts), and normalize.ts reshapes them once, so the view types
 * replace the server's rather than adding to them.
 */
export type RunDetail = Omit<ServerRunDetail, 'calls' | 'actions' | keyof RunDetailExtras> & { calls: CallRow[]; actions: ActionItem[] } & RunDetailExtras;

/**
 * The Overview while the server is still adding up the runs' totals it reads (`GET /api/summary`): how
 * many of the runs it adds up are done. Asked again, it answers with the Overview once they all are.
 */
export interface OverviewWarming {
  warming: { done: number; total: number };
}

/** A page of a run's calls after the first (`GET /api/runs/:id/calls?from=`, contract 8). */
export type CallsPage = Omit<ServerCallsPage, 'calls'> & { calls: CallRow[] };

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
export type ActionItem = Omit<ServerAction, 'prompt' | 'flag' | 'group' | 'hint' | 'command' | 'noSystemMessage' | 'warns'> & {
  prompt: { label: string; placeholder?: string; initial?: string; choices?: readonly PromptChoice[] } | null;
  flag?: string;
  group?: 'call' | 'run' | null;
  hint?: string;
  command?: string;
  noSystemMessage?: string;
  warns?: string;
};

export type CallDetail = Omit<ServerCallDetail, 'call' | 'actions'> & {
  call: ServerCallDetail['call'] & CallRowExtras;
  actions: ActionItem[];
  /** The fork menu's header for the call: `At #19 · search_web · read tool`. */
  forkTitle?: string;
};

/** A run of a family: what an older server or a copy leaves out (its origins, its test, its about line) is optional. */
export type LineageNode = Omit<ServerLineageNode, 'origins' | 'test' | 'about'> & { probe?: unknown; verify?: unknown; origins?: string | string[] | null; test?: ServerLineageNode['test'] | null; about?: RunAbout | null };

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
  /** An exported copy: how many redaction rules were applied to it. */
  redactedRules?: number;
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
  /** Open in editor: what it runs here (`code --goto <file>:<line>`); null or absent where it can't open one, as in an exported copy. */
  editor?: string | null;
  /**
   * With several projects: its `id` in the list, its folder as the switcher shows it (`display`),
   * whether its setup is finished, why its store can't be opened (`problem`; `missing` when its
   * folder is gone from disk), and what part of the dashboard couldn't start for it (`notice`).
   */
  project?: { name: string; path: string; id?: string; display?: string; settingUp?: boolean; problem?: string; missing?: boolean; notice?: string } | null;
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
  /** The fix it blames, repairs, verifies or applies (full id); absent for a job about no fix yet. */
  fixId?: string;
  opensRun: boolean;
  startedAt: number;
  done: boolean;
  /** Someone asked it to stop (Stop in its drawer, or another tab's): its end is that stop. */
  stopped?: boolean;
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
  /** What a billed job is estimated to cost, as its card and its ask say it: its drawer says it beside running. */
  estimate?: Pick<Estimate, 'usd' | 'ceiling' | 'per' | 'stops'> | null;
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

export type { CacheMissRow, CacheUse, DaySums, FixesFunnel, LookAdvice, LookStep, NeedsLook, NeedsLookRow, OutcomeStrip, OverviewSummary, TestsTile, TodayPanel, WeekSums } from '../src/overview.js';
export type { BulkSkip, ChipCounts, DayCount, DeleteResult, RunRow, RunsByDay, RunsPage, RunSort as ServerRunSort, RunType as ServerRunType } from '../src/runs-list.js';
export type { DaysBisect, RunsPageRow } from '../src/routes/runs-list.js';
export type { FailedCheck, Issue, IssueDetail, IssueKind, IssueRun, IssueRunsPage, IssuesPage } from '../src/issues.js';
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
  traces: Record<import('../src/routes/imports.js').TraceSource, import('../src/routes/imports.js').TraceSourceView>;
  uploadLimit: number | null;
}

/** A bulk label's answer: each run labelled, with its labels after, and the runs left alone with why. */
export interface LabelRunsResult {
  done: Array<{ runId: string; labels: string[] }>;
  skipped: Array<{ runId: string; reason: string }>;
}

// ---- Tests (#/tests) and Settings → CI: the tests slice's read models, as the server sends them.

/** `GET /api/tests`: the goldens on disk and how each did, with the reports as the CLI prints them. */
export type { BisectChoices, BisectRange, BisectRevision, DivergenceView, FailureView, FollowedGolden, GatePreview, GateResultView, GateView, GoldenCheck, GoldenRow, GoldenVerdict, HistoryCell, HistoryDrop, InconclusiveView, MoreAttempts, RevisionFact, SinceResult, TestRunBanner, TestsSessionView, TestsVerdict, TestsView, UnjudgedCheck, UntestedCommit } from '../src/tests.js';
export type { BisectMiss, FoundChange, FoundCommit } from '../src/tests-bisect.js';
export type { CrashError } from '../src/crash-error.js';
export type { Followed, GoldenReport, HintKey, Piece, ReportLine, ReportPart, ReportTone, TestsAnswer } from '../src/golden-report.js';
/** `GET /api/tests/evidence`: a gated golden's attempts, each judged from its own run, and the words its evidence says why its gate stopped with. */
export type { EvidenceAttempt, EvidenceWords, TestEvidence } from '../src/tests-evidence.js';
/** `GET /api/tests/runs/:id`: what a run's page offers about a test replay, and Find breaking commit's choices. */
export interface TestRunView {
  banner: import('../src/tests.js').TestRunBanner | null;
  bisect: import('../src/tests.js').BisectChoices | null;
}
/** `GET /api/ci/workflows`: both CI panels for the options they are set to. */
export type { CiListRow, CiSession, CiTeamStore, CiWorkflowOptions, CiWorkflowsView, PullRequestPreview } from '../src/ci-workflows.js';
/** `GET /api/ci/comment`: the pull request comment as the Action would post it, from the newest session that ran every golden. */
export type { PrCommentPreview } from '../src/pr-comment-preview.js';

// ---- Training (#/training): the training read model's answers, as the server sends them (src/training.ts) ----
export type { ModelCardView, ModelOptionView, ModelsView, PairGroupView, PipView, ScoreDialogView, ScoreRowView, SourceView, TaskRowView, TaskUpdate, TrainingView } from '../src/training.js';

// The decision diff (`/api/decisions`): the read model's own shapes, as the server sends them.
export type { DecisionCell, DecisionRow, DecisionSessionView, DecisionsListView, RetirementsView, RowEnding, RunDecisionsSession, ViewStep } from '../src/decisions.js';
export type { CellOpen, Toned } from '../src/decision-cells.js';
export type { PreviewCounts, PreviewKeyEntry, PreviewNext, PreviewReceipt, PreviewRowFacts, PreviewSession, PreviewVerify, PreviewView } from '../src/decision-view.js';
export type { DecisionChange, DecisionRun, DecisionStep, DecisionsReport, DecisionView } from '../../engine/src/decisions.js';
export type { RetirementNotice } from '../../engine/src/model-retirements.js';
// Changes › Migrate: what its bare tab opens on, and a migration worded whole for its page.
export type { MigrateRetiring, MigrateStartView, MigrateUse } from '../src/migrate-start.js';
export type { MigrateApplyOffer, MigrateChange, MigratePass, MigrateView } from '../src/migrate-view.js';
export type { AppliedGolden, AppliedState } from '../src/migrate-applied.js';
/** One session whole: a decisions report (`decisions --json`) or a migrate report, with the matrix the page draws and its `view`, worded on the server. */
export type DecisionSessionDetail = import('../src/decision-view.js').PreviewSession;
/** A run's decisions under each session that asked it again, newest first. */
export type RunDecisionsView = ReturnType<typeof import('../src/decisions.js').runDecisions>;
// Changes › Verdicts (`/api/verdicts`): every change checked, and the verdict it got.
export type { PreviewVerdict, SessionVerdict, VerdictGolden, VerdictRevision, VerdictRow, VerdictsKind, VerdictsView, VerdictWord, VerifyVerdict } from '../src/verdicts.js';
export type { KeptCost, KeptDecisions, KeptInjection, SessionCommentParts, VerdictFlag, VerdictPullRequest } from '../src/session-comment.js';
export type { CommentDecision } from '../../engine/src/pr-comment.js';

// ---- Compare (#/compare/<a>/<b>): two runs compared, with what git says about the code between them (src/compare.ts) ----
export type { CodeChange } from '../src/compare.js';
// Error-path presets (a run's presets matrix) and production coverage (Tests' Not covered panel).
export type { ChaosCell, ChaosMatrix, ChaosPresetInfo, ChaosSessionView, ChaosView } from '../src/chaos.js';
export type { PresetsPicks, PresetsPlan } from '../src/presets-plan.js';
export type { CoverageGroupView, CoverageLook, CoverageView } from '../src/coverage.js';
/** `GET /api/compare`: the engine's comparison, and the code card's commits (absent from an exported copy, which has no git behind it). */
export type CompareView = Omit<import('../src/compare.js').CompareView, 'code' | 'pair'> & { code?: import('../src/compare.js').CodeChange | null; pair?: import('../src/fork-differences.js').PairDifferences | null };
