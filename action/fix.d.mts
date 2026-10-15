// Types for fix.mjs, which the action runs as plain JavaScript.

export interface ReportResult {
  name: string;
  golden?: string;
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
}

export function planFixes(report: { results: ReportResult[] }): FixPlan[];
export function branchName(result: ReportResult): string;
export function repairArgs(plan: FixPlan, options: { db: string | null; budget: number | string; repairer: string; expectFile: string }): string[];
export function cannotFix(workdir: string, env: NodeJS.ProcessEnv): string | null;
export function repairEnv(workdir: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function runFixes(options: { cli: string; db: string | null; workdir: string; report: { results: ReportResult[] }; budget: number; repairer: string; env: NodeJS.ProcessEnv; log?: (line: string) => void }): FixOutcome[];
export function fixSummary(fixes: FixOutcome[], budget: number | string): string;
