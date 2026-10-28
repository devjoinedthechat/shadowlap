import type { NewStoredEvent, StoreOf, StoredEvent } from './store.js';

/**
 * Activity events: what a command did that leaves nothing else in the store. The activity feed
 * merges these with events it derives from runs (a recording started, a fork, a clean replay), so a
 * command records an event only when the runs table can't tell the story by itself.
 *
 * Kinds are dotted, noun first. The ones in use, with the `ref` and `data` fields the dashboard's
 * activity feed reads (packages/dashboard/src/activity.ts words them; a field it reads is a contract):
 * - `normalizer.added`, `normalizer.removed`: ref the rule's path; data the rule as stored (kind,
 *   name, path, pattern, replace), with `via: 'calibrate'` from `calibrate --write`
 * - `redaction.added`, `redaction.removed`: ref the replacement; data the rule without its pattern,
 *   which can hold what the rule hides
 * - `clock.set`: ref the mode (auto or exact); data { clock, was }. These and the rules above are
 *   edits to shadowlap.config.json, from the CLI or Settings
 * - `runs.cleaned`: data { runs, attempts, blobs, bytes, interrupted, olderThanDays, keep }: `shadowlap gc`
 *   deleted old runs (and `attempts`, those bundled under them) or marked abandoned recordings interrupted
 * - `golden.packed` (a pack in a goldens folder or named in the config's tests), `run.packed` (any
 *   other pack): runId, ref the folder relative to the project (its name alone when outside it,
 *   with `outside: true`); data { runs, calls, redacted }
 * - `golden.updated`: runId the new recording, ref the golden; data { session, previous, calls, checks }
 * - `capture.imported`: runId, ref the source's name; data { format, from, key, modelCalls, toolCalls }.
 *   One event per run an import keeps; the feed tells the events of one import (same actor and
 *   source, moments apart) as one entry. An event may instead list its runs in `runIds`.
 * - `test.session`: ref the session; data { passed, failed, inconclusive?, goldens, interrupted?, notRun? }
 * - `bisect.found`: ref the golden or run bisected (runId too, for a run); data { commit, subject, first,
 *   why, untested, answered?, … }; `bisect.none`: ref as for found; data { outcome, why, good, bad,
 *   answered? }: no first bad commit between them. `answered` is the golden's newest result as the
 *   search started { session, at, ok, revision }: the failure the answer is about
 * - `blame.done`: runId the blamed run, ref the fix (`fx-…`); data { outcome ('blamed',
 *   'unrescuable' or 'stopped'), callNo, confidence, title, range? { from, to, gradual? }: the calls
 *   it was lost between, two `gradual` ones when it was lost gradually around them }
 * - `repair.accepted`, `repair.empty`: ref the fix; data { repairId, title (accepted), why (empty) }
 * - `verify.accepted`, `verify.rejected`: ref the fix; data { verifyId, reasons }
 * - `fix.applied`: ref the fix; data { title }
 * - `pairs.exported`: ref the file; data { count }; `model.scored`: ref the model; data { model, tasks, mean }
 * - `project.added`, `project.removed`: ref the project; data { path, name, again? }
 * - `project.setup`: data { name, stage: 'done', skipped } from a setup, { name, config: 'created' } from init
 * - `store.set`: ref the bucket; data { provider, previous }; `store.ci`: ref the bucket, when one is
 *   set; data { push, previous }; `store.checked`: ref the bucket; data { ok, versioning, objectLock,
 *   encryption }
 * - `store.pushed`: ref the bucket; data { pushed, updated, repaired, queued, refused, blobs, bytes,
 *   pullRequest? }, or { pushed, updated, refused, queued: true } for runs pushed when they ended;
 *   `store.pulled`: ref the bucket; data { pulled, merged, failed, byAuthor, pullRequests? }
 * - `run.shared`: runId, ref the report's key in the bucket; data { runs, redacted, expiresAt, pullRequest? }
 * - `decisions.done`, `migrate.done`: ref the session (`dc-…`, `mg-…`); data { change, runs, flagged,
 *   spent }: `shadowlap decisions` or `migrate` asked recorded model calls again under a change
 * - `injection.tested`: runId the run tested, ref the golden (or the result's `inj-…` id); data
 *   { resultId, mode: 'plant', attempts, obeyed, influenced, ignored, inconclusive, verdict, reads,
 *   payloads, gate: 'passed' | 'failed' | 'inconclusive', session? } from planting, { resultId,
 *   mode: 'clean', read, attempts, verdict, decided, writes } from --clean
 * - `coverage.scanned`: ref the scan; data { runs, groups, uncovered, goldens, packed?, notPacked? }:
 *   `shadowlap coverage` read the imported runs, and with `--pack` made `packed` goldens and couldn't
 *   pack `notPacked` behaviours
 * - `chaos.session`: ref the session (runId the run, for `replay --chaos`); data { passed, failed,
 *   inconclusive, notApplicable, goldens, revision, interrupted? }: the error-path presets ran
 * - `skill.installed`: ref where it installed (`claude-code`, `agents` or `kiro`); data { path,
 *   version, outcome ('installed' or 'updated'), previous (the version replaced, or null) }:
 *   `shadowlap skill install` put the plugin, or the skills alone, into the project
 * Add new kinds here, with the feature that records them and the fields it records.
 */
export type EventKind = string;

export interface RecordEventInput {
  kind: EventKind;
  /** Who did it; the caller resolves it once per command with resolveAuthor(). */
  actor?: string | null;
  runId?: string | null;
  ref?: string | null;
  data?: Record<string, unknown> | null;
  at?: number;
}

/**
 * Records one activity event. Never throws: losing an activity line must not fail the command
 * that did the work (a read-only store, or one opened by an older build, simply skips it).
 */
export function recordEvent(store: StoreOf<'activity'>, input: RecordEventInput): StoredEvent | null {
  try {
    const event: NewStoredEvent = { kind: input.kind };
    if (input.actor !== undefined) event.actor = input.actor;
    if (input.runId !== undefined) event.runId = input.runId;
    if (input.ref !== undefined) event.ref = input.ref;
    if (input.data !== undefined) event.data = input.data;
    if (input.at !== undefined) event.at = input.at;
    return store.addEvent(event);
  } catch {
    return null;
  }
}
