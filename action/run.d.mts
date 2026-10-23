// Types for run.mjs, which the action runs as plain JavaScript.
import type { FixOutcome, ReportResult } from './fix.mjs';
import type { Fetch } from './github.mjs';

export function outputsOf(report: { passed: number; failed: number; session?: string | null; results: ReportResult[] }, fixes: FixOutcome[], paths: { json: string; markdown: string; junit: string }): Record<string, string | number>;
export function main(env?: NodeJS.ProcessEnv, deps?: { fetch?: Fetch }): Promise<number>;
