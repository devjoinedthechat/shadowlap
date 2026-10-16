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
}

export interface FixPlan {
  result: ReportResult;
  /** Why it gets no fix attempt, or null. */
  skip: string | null;
  fixes?: string[];
  keeps?: string[];
}

/** The golden on a fix's branch: re-recorded under the fix, left as it is because it may fork, or stale (and why). */
export interface GoldenState {
  state: 'recorded' | 'fork' | 'stale';
  golden: string;
  why: string | null;
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
  /** With push: whether the fix went to the team store (null when it wasn't asked to). */
  pushed?: boolean | null;
}

export function planFixes(report: { results: ReportResult[] }): FixPlan[];
export function branchName(result: ReportResult): string;
export function repairArgs(plan: FixPlan, options: { db: string | null; budget: number | string; repairer: string; expectFile: string }): string[];
export function cannotFix(workdir: string, env: NodeJS.ProcessEnv): string | null;
export function repairEnv(workdir: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function refreshGolden(options: { cli: string; workdir: string; result: ReportResult; repair: { output?: { goldens?: string[]; patch?: string | null; branch?: string | null } }; guard?: string; env: NodeJS.ProcessEnv; scratch: string }): GoldenState;
export function goldenNote(golden: GoldenState): string;
export function cannotPush(workdir: string): string | null;
export function runFixes(options: { cli: string; db: string | null; workdir: string; report: { results: ReportResult[] }; budget: number; repairer: string; guard?: string; push?: boolean; env: NodeJS.ProcessEnv; log?: (line: string) => void }): FixOutcome[];
export function fixSummary(fixes: FixOutcome[], budget: number | string): string;
