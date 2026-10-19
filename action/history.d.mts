// Types for history.mjs, which the action runs as plain JavaScript.

/** Whether shadowlap.config.json gives any golden a gate against history. */
export function hasHistoryGate(config: unknown): boolean;

/** A cache key's part from a branch name. */
export function keyPart(s: string | null | undefined): string;

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

export function historyPlan(o: { keep: string; workdir: string; store: string; config: unknown; branch: string; defaultBranch: string; runId: string | undefined; attempt: string | undefined }): HistoryPlan;
