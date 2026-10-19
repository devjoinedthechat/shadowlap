// Types for fix.mjs, which the action runs as plain JavaScript.

export interface ReportResult {
  name: string;
  /** The pack directory as given to shadowlap test, relative to the working directory. */
  dir?: string;
  golden?: string;
  /** `fork` goldens pass on their checks from wherever they diverge; `replay` ones must replay exactly. */
  mode?: 'replay' | 'fork';
  ok: boolean;
  failure?: 'diverged' | 'check' | 'exit' | 'no-calls' | 'error' | null;
  runId?: string | null;
  runs?: Array<{ runId: string; ok: boolean }>;
  expect?: Record<string, unknown> | null;
  /** The checks of the attempt shown, each with why it failed; a judge check's with its status (`inconclusive` when not judged) and judge. */
  checks?: Array<{ ok: boolean; label: string; detail: string | null; status?: string; judge?: { name: string } }> | null;
}

export interface FixPlan {
  result: ReportResult;
  /** Why it gets no fix attempt, or null. */
  skip: string | null;
  fixes?: string[];
  keeps?: string[];
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
}

export function planFixes(report: { results: ReportResult[] }): FixPlan[];
export function groupFixes(plans: FixPlan[]): FixGroup[];
export function branchName(result: ReportResult): string;
export function repairArgs(plan: FixPlan, options: { db: string | null; budget: number | string; repairer: string; expectFile: string }): string[];
export function cannotFix(workdir: string, env: NodeJS.ProcessEnv): string | null;
export function repairEnv(workdir: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function refreshGoldens(options: { cli: string; workdir: string; members: FixPlan[]; unfixed?: FixPlan[]; unfixedWhy?: string | null; results?: ReportResult[]; repair: { output?: { goldens?: string[]; patch?: string | null; branch?: string | null } }; guard?: string; env: NodeJS.ProcessEnv; scratch: string }): BranchState;
export function goldenNote(golden: GoldenState): string;
export function branchNote(state: { goldens: GoldenState[]; others?: OtherGoldens; checked?: boolean; why?: string | null }): string;
export function cannotPush(workdir: string): string | null;
export function forkPullRequest(env: NodeJS.ProcessEnv, read?: (path: string) => string): boolean;
export function pushFix(options: { cli: string; db: string | null; workdir: string; env: NodeJS.ProcessEnv; fixIds?: string[]; sentInJob?: Set<string>; read?: (path: string) => string }): FixPush;
export function pushLine(name: string, pushed: FixPush): string;
export function runFixes(options: { cli: string; db: string | null; workdir: string; report: { results: ReportResult[] }; budget: number; repairer: string; guard?: string; push?: boolean; env: NodeJS.ProcessEnv; log?: (line: string) => void }): FixOutcome[];
export function fixSummary(fixes: FixOutcome[], budget: number | string): string;
