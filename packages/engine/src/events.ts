import type { NewStoredEvent, Store, StoredEvent } from './store.js';

/**
 * Activity events: what a command did that leaves nothing else in the store. The activity feed
 * merges these with events it derives from runs (a recording started, a fork, a clean replay), so a
 * command records an event only when the runs table can't tell the story by itself.
 *
 * Kinds are dotted, noun first. The ones in use:
 * - `normalizer.added`, `normalizer.removed` (ref: its path; data: the rule's kind, name, path,
 *   pattern and replace, and `via: 'calibrate'` when calibrate added it), `redaction.added`,
 *   `redaction.removed` (ref: its replacement; data: the same without the pattern, which can hold
 *   what the rule hides), `clock.set` (ref and data.clock: auto or exact; data.was): edits to
 *   shadowlap.config.json, from the CLI or Settings
 * - `runs.cleaned` (data: runs, blobs, bytes, interrupted, olderThanDays, keep): `shadowlap gc`
 *   deleted old runs or marked abandoned recordings interrupted
 * - `golden.packed`, `golden.updated`, `capture.imported`
 * - `test.session` (data: passed, failed), `bisect.found`
 * - `blame.done`, `repair.accepted`, `repair.empty`, `verify.rejected`, `verify.accepted`, `fix.applied`
 * - `pairs.exported`, `model.scored`
 * - `project.added`, `project.setup`, `project.removed`
 * - `store.pushed`, `store.pulled`
 * Add new kinds here, with the feature that records them.
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
export function recordEvent(store: Store, input: RecordEventInput): StoredEvent | null {
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
