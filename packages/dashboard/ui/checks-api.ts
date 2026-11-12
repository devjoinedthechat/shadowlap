import type { CheckContext, CheckPreview, ContextCall, PreviewGolden, PreviewRow, ResultField } from '../src/check-preview.js';
import type { ChecksConfig, ConfigPrints, GoldenEntry, TestsWritten } from '../src/config-tests.js';
import type { CheckSuggestion, CheckSuggestions, SuggestedRule, SuggestionShape } from '../src/suggested-checks.js';
import type { FixCheckPreview, FixCheckRow } from '../src/fix-check.js';
import type { Request } from './settings-api.js';

/**
 * The check builder's part of the API client (`client.checks`): the goldens of a run's agent with
 * their tests entries as written, what a run's calls offer before a call, a draft judged on the
 * agent's recordings, the rules suggested from a failed recording, and a golden's tests entry written
 * back. The write sends the version of shadowlap.config.json the builder read and the prints of its
 * keys and entries (`read`), so the server refuses it with a 409 naming what changed on disk since.
 * In fix mode, a draft judged on an open fix's runs (`fixPreview`), which Save check gives the fix
 * through its job. Types only from the server's modules (src/config-tests.ts, src/check-preview.ts,
 * src/suggested-checks.ts, src/fix-check.ts): nothing here needs Node.
 */

export type { CheckContext, CheckPreview, CheckSuggestion, CheckSuggestions, ChecksConfig, ConfigPrints, ContextCall, FixCheckPreview, FixCheckRow, GoldenEntry, PreviewGolden, PreviewRow, ResultField, SuggestedRule, SuggestionShape };

/** What the builder asks suggestions with: the failed recording, the call the check is made from (null in a fix's builder, which sends the fix), the labels of the checks it holds. */
export interface SuggestionsAsk {
  run: string;
  at: number | null;
  have: readonly string[];
  fix?: string;
}

/** Whose checks: the agent of a run, or one golden (a golden's own Edit checks). */
export type ChecksOf = { run: string } | { golden: string };

/** What a save answers: the entry's key, the file's new version, the labels added and removed, and whether anything changed. */
/** A write's answer; `was`, for one that changed the file, is what its Undo sends. */
export type ChecksSaved = Omit<TestsWritten, 'event' | 'prior'> & { was?: string };

export interface ChecksApi {
  goldens(of: ChecksOf): Promise<ChecksConfig>;
  context(runId: string, at: number): Promise<CheckContext>;
  /** Judged on the agent's newest recordings, as `shadowlap check` judges them; it changes nothing. */
  preview(expect: unknown, of: ChecksOf, signal?: AbortSignal): Promise<CheckPreview>;
  /** At most three rules that fail the recording and none of its good runs, the builder's own left out; it changes nothing. */
  suggestions(ask: SuggestionsAsk, signal?: AbortSignal): Promise<CheckSuggestions>;
  /** The golden's entry as it changes: `{ expect }`, or `{ expect: null }` to take its checks out. */
  save(body: { golden: string; version: string; read: ConfigPrints; entry: { expect: unknown } }): Promise<ChecksSaved>;
  /**
   * Judged on every run an open fix holds, from what each recorded, as `shadowlap fix check` judges
   * them; it changes nothing. With `context`, a fix of any status, nothing refused or uncounted: its
   * runs beside a check added to the golden that guards it.
   */
  fixPreview(fixId: string, expect: unknown, o?: { context?: boolean; signal?: AbortSignal }): Promise<FixCheckPreview>;
  /** Puts back what the write that answered `was` changed, unless the file changed since (a 409). */
  undo(was: string): Promise<ChecksSaved>;
}

export function checksApi(request: Request): ChecksApi {
  const q = encodeURIComponent;
  const send = <T,>(method: string, path: string, body: unknown, signal?: AbortSignal) => request<T>(path, { method, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  const whose = (of: ChecksOf) => ('run' in of ? `run=${q(of.run)}` : `golden=${q(of.golden)}`);
  return {
    goldens: (of) => request(`checks/goldens?${whose(of)}`),
    context: (runId, at) => request(`checks/context?run=${q(runId)}&at=${at}`),
    preview: (expect, of, signal) => send('POST', 'checks/preview', { expect, ...of }, signal),
    suggestions: (ask, signal) => send('POST', 'checks/suggestions', ask, signal),
    save: (body) => send('PUT', 'checks/tests', body),
    fixPreview: (fixId, expect, o = {}) => send('POST', `fixes/${q(fixId)}/check-preview`, { expect, ...(o.context ? { context: true } : {}) }, o.signal),
    undo: (was) => send('POST', 'checks/tests/undo', { was }),
  };
}

/** An exported copy makes no checks: every call says so. */
export function noChecks(refuse: () => Promise<never>): ChecksApi {
  return { goldens: refuse, context: refuse, preview: refuse, suggestions: refuse, save: refuse, fixPreview: refuse, undo: refuse };
}
