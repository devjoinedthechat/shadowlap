// The shapes the GitHub Action (action/*.mjs, plain JavaScript) works with, which its JSDoc names
// with `@import` and action/tsconfig.json checks the code against. The report it reads is the CLI's
// own (`shadowlap test --json`, PackResult in packages/cli/src/test-report.ts).
import type { RepairReport } from '@shadowlap/engine';
import type { PackResult, TestReport } from 'shadowlap';

/** The token the action speaks to GitHub with, where it came from, and whether GitHub starts workflows for what it does with it. */
export interface GitHubAuth {
  token: string | null;
  source: 'input' | 'gh-token' | 'github-token' | 'none';
  startsWorkflows: boolean;
}

/**
 * What the action reads of an object GitHub's REST API answers with (a pull request, a comment, a
 * user): each value is checked where it is read.
 */
export interface GitHubObject {
  id?: unknown;
  body?: unknown;
  html_url?: unknown;
  login?: unknown;
  message?: unknown;
  type?: unknown;
  user?: GitHubObject | null;
  performed_via_github_app?: { slug?: unknown } | null;
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text(): Promise<string>; headers?: { get(name: string): string | null } }>;

/** Whether the workflow was started on a fix's branch, and why not. */
export interface Dispatch {
  dispatched: boolean;
  workflow: string | null;
  why: string | null;
}

export interface PullRequest {
  number: number;
  baseRef: string | null;
  baseSha: string | null;
}

/** How keeping the comment went: `updated`, `created`, `denied` (the token may not comment) or `failed`; `skipped` and `none` come from postComment. */
export interface Posted {
  state: 'updated' | 'created' | 'denied' | 'failed' | 'skipped' | 'none';
  url: string | null;
  why: string | null;
}

/**
 * A golden's result in `shadowlap test --json`, as the CLI writes it (PackResult) and the action
 * reads it: a report an earlier CLI made may lack what the CLI has added since, so all of it but its
 * name and `ok` may be missing, and so may each run's verdict (a check's status already may).
 */
export type ReportResult = Pick<PackResult, 'name' | 'ok'> &
  Partial<Omit<PackResult, 'name' | 'ok' | 'runs'>> & {
    runs?: Array<Omit<PackRun, 'verdict'> & Partial<Pick<PackRun, 'verdict'>>>;
  };

/** One attempt's run in a result, as the CLI writes it. */
type PackRun = PackResult['runs'][number];

/** `shadowlap test --json` as the action reads it: the CLI's TestReport, each result as ReportResult has it. */
export type Report = Omit<TestReport, 'results'> & { results: ReportResult[] };

export interface FixPlan {
  result: ReportResult;
  /** Why it gets no fix attempt, or null. */
  skip: string | null;
  fixes?: string[];
  keeps?: string[];
}

/** A golden's own gate as repair takes it: an SPRT gate's figures, a fixed count, or one against history (which verify doesn't take). */
export type GoldenGate = { kind: 'sprt'; good: number; bad: number; risk: number; max: number } | { kind: 'count'; attempts: number; passes: number } | { kind: 'history' };

/** What one repair is given: a failing replay of each golden shown to the repairer, those held out, those kept, and the gate. */
export interface RepairPlan {
  result: ReportResult;
  fixes: string[];
  holdout: string[];
  keeps: string[];
  gate: GoldenGate | null;
  /** The goldens behind each: shown to the repairer, held out from it, kept. */
  goldens: { shown: string[]; heldOut: string[]; kept: string[] };
}

/** Goldens that fail the same check, repaired together: their failing replays all targets, their passing ones all kept. */
export interface FixGroup extends FixPlan {
  fixes: string[];
  keeps: string[];
  /** The goldens in it, in the report's order; the first names the branch. */
  members: FixPlan[];
}

/** The other goldens the session tested, replayed on a fix's branch. */
export interface OtherGoldens {
  /** Passed before the fix, and diverge or fail under it. */
  diverging: string[];
  /** Failed before the fix too. */
  failing: string[];
  /** Neither passed nor failed under the fix, which says nothing of what it changes. */
  inconclusive?: string[];
  /** Inconclusive before the fix, and fail under it. */
  unsettled?: string[];
  /** May fork, so they run live from where they diverge and were not replayed. */
  unreplayed: string[];
  /** Would have been replayed, but the replay with the fix could not run. */
  unchecked?: string[];
  /** How many were replayed. */
  replayed: number;
}

/** A fix's branch: its own goldens, the other goldens, and whether the replay with the fix ran. */
export interface BranchState {
  goldens: GoldenState[];
  others: OtherGoldens;
  checked: boolean;
  /** Why the replay with the fix could not run, or null. */
  why?: string | null;
  /** The fix-build that ran again once the fix was taken back out of the working tree failed, and how. */
  warning?: string | null;
}

/**
 * The golden on a fix's branch: re-recorded under the fix, left as it is because it may fork, stale
 * (and why), or unfixed: it fails the same check, and the fix was verified without it (why says how
 * that came about), so it stays as it was.
 */
export interface GoldenState {
  state: 'recorded' | 'fork' | 'stale' | 'unfixed';
  golden: string;
  why: string | null;
  /** An unfixed golden that may fork: on the branch it runs live from where it diverges. */
  fork?: boolean;
}

/**
 * With push, how a fix's push to the team store went: `sent`, push reported sending it; `pr`, a pull
 * request's job, whose runs went to its own folder (`pr` is its number) and which sends no fixes;
 * `off`, the team turned pushing from CI off; `failed`, it couldn't happen or push didn't say it did
 * (`why`: no store, no credentials, a fork's pull request, the store out of reach, a fix push's report
 * leaves out). None of them fails the job.
 */
export interface FixPush {
  state: 'sent' | 'pr' | 'off' | 'failed';
  why: string | null;
  pr: string | null;
}

export interface FixOutcome {
  golden?: string;
  name: string;
  outcome: 'opened' | 'skipped' | 'no-fix' | 'not-opened';
  why: string | null;
  pr: string | null;
  branch?: string;
  title?: string | null;
  spent: number;
  verify?: string | null;
  goldenState?: GoldenState | null;
  /** Each of the fix's own goldens on its branch. */
  goldenStates?: GoldenState[];
  /** The other goldens, replayed on the fix's branch. */
  others?: OtherGoldens;
  /** What its repair could spend. */
  budget?: number;
  /** With push: how the fix's push to the team store went (null when it wasn't asked to). */
  pushed?: FixPush | null;
  /** How the pull request's checks start: by the token it was opened with, the workflow started on its branch, or not at all, and why. */
  checks?: { state: 'token' | 'dispatched' | 'not-started'; workflow: string | null; why: string | null } | null;
  /** What the fix was verified on. */
  verifiedOn?: RepairPlan['goldens'];
}

/** A result as the test history keeps it. */
export interface StoredResult {
  golden: string;
  ok: boolean;
  failure: string | null;
  reason: string | null;
  data: Record<string, unknown> | null;
}

export interface StoredSession {
  sessionId: string;
  startedAt: number;
  endedAt: number | null;
  revision: string | null;
  results: StoredResult[];
}

/** The base branch's last session, its results by golden. */
export interface BaseSession {
  sessionId: string;
  revision: string | null;
  startedAt: number;
  results: Map<string, StoredResult>;
}

/** How the action keeps the store between jobs for a gate against history (history.mjs historyPlan). */
export interface HistoryPlan {
  /** Keep the store between jobs in the Actions cache. */
  keep: boolean;
  /** The store's file, with its write-ahead log and shared memory. */
  path: string[];
  /** One per run, so each run saves what it adds. */
  key: string;
  /** This branch's newest first, then the default branch's. */
  restoreKeys: string[];
}

/**
 * `shadowlap repair --json` as the action reads it: the engine's RepairReport, with the fixes the CLI
 * kept for it, or the error a repair that could not run prints in its place. A report an earlier CLI
 * made may lack what was added since.
 */
export type RepairJson = Partial<RepairReport> & { fixes?: Array<{ fixId?: unknown } | null>; error?: { message?: string } };
