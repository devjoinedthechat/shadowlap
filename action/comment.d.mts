// Types for comment.mjs, which the action runs as plain JavaScript.
import type { FixOutcome, ReportResult } from './fix.mjs';
import type { Fetch, GitHubAuth, Posted } from './github.mjs';

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

export function commentMarker(o?: { workflow?: string; job?: string; workdir?: string; recordings?: string }): string;
export function verdictLine(result: ReportResult & { gate?: { sentence?: string } | null; updated?: unknown; divergence?: { type: string; callNo: number } | null; attempts?: { total: number; passed: number } | null }): string;
export function baseSession(history: StoredSession[] | null, o: { baseRef: string | null; baseSha: string | null; current: string | null }): BaseSession | null;
export function readHistory(path: string | null, limit?: number): StoredSession[] | null;
export function commentBody(o: { report: { session?: string | null; results: ReportResult[] }; marker: string; base?: BaseSession | null; baseRef?: string | null; fixes?: FixOutcome[]; runUrl?: string | null; longest?: number }): string;
export function postComment(o: { env: NodeJS.ProcessEnv; auth: GitHubAuth; report: { session?: string | null; results: ReportResult[] }; fixes?: FixOutcome[]; store: string | null; recordings: string; workdir: string; fetch?: Fetch; read?: (path: string) => string }): Promise<Posted>;
export function commentNote(posted: Posted | null): string;
