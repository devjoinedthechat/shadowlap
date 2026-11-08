import type { CheckContext, CheckPreview } from '../src/check-preview.js';
import type { ChecksConfig, ConfigPrints, TestsWritten } from '../src/config-tests.js';
import type { Request } from './settings-api.js';

/**
 * The check builder's part of the API client (`client.checks`): the goldens of a run's agent with
 * their tests entries as written, what a run's calls offer before a call, a draft judged on the
 * agent's recordings, and a golden's tests entry written back. The write sends the version of
 * shadowlap.config.json the builder read and the prints of its keys and entries (`read`), so the
 * server refuses it with a 409 naming what changed on disk since. Types only from the server's
 * modules (src/config-tests.ts, src/check-preview.ts): nothing here needs Node.
 */

export type { CheckContext, CheckPreview, ChecksConfig, ConfigPrints };

/** Whose checks: the agent of a run, or one golden (a golden's own Edit checks). */
export type ChecksOf = { run: string } | { golden: string };

/** What a save answers: the entry's key, the file's new version, the labels added and removed, and whether anything changed. */
export type ChecksSaved = Omit<TestsWritten, 'event'>;

export interface ChecksApi {
  goldens(of: ChecksOf): Promise<ChecksConfig>;
  context(runId: string, at: number): Promise<CheckContext>;
  /** Judged on the agent's newest recordings, as `shadowlap check` judges them; it changes nothing. */
  preview(expect: unknown, of: ChecksOf, signal?: AbortSignal): Promise<CheckPreview>;
  /** The golden's entry as it changes: `{ expect }`, or `{ expect: null }` to take its checks out. */
  save(body: { golden: string; version: string; read: ConfigPrints; entry: { expect: unknown } }): Promise<ChecksSaved>;
}

export function checksApi(request: Request): ChecksApi {
  const q = encodeURIComponent;
  const send = <T,>(method: string, path: string, body: unknown, signal?: AbortSignal) => request<T>(path, { method, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  const whose = (of: ChecksOf) => ('run' in of ? `run=${q(of.run)}` : `golden=${q(of.golden)}`);
  return {
    goldens: (of) => request(`checks/goldens?${whose(of)}`),
    context: (runId, at) => request(`checks/context?run=${q(runId)}&at=${at}`),
    preview: (expect, of, signal) => send('POST', 'checks/preview', { expect, ...of }, signal),
    save: (body) => send('PUT', 'checks/tests', body),
  };
}

/** An exported copy makes no checks: every call says so. */
export function noChecks(refuse: () => Promise<never>): ChecksApi {
  return { goldens: refuse, context: refuse, preview: refuse, save: refuse };
}
