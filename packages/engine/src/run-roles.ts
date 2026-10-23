/**
 * Which runs are attempts: the one rule the dashboard's counts, its lists, a run's page and the
 * project switcher go by.
 *
 * An attempt is a run a command made as one of several tries of another run, read together with the
 * other tries against the run it replayed, never on its own:
 *
 * - blame's probes (`meta.probe`), and the replay of the recording as recorded it starts from;
 * - verify's attempts (`meta.verify`);
 * - `replay --repeat`'s (`meta.repeat`), which an injection test's replays and a model's scoring
 *   carry too (`meta.injection`, `meta.task`): each is one of a batch whose verdict is the batch's;
 * - an error-path preset's (`meta.chaos`);
 * - a golden one test session replays more than once (`meta.test.of`), filed under the attempt its
 *   result shows.
 *
 * Two runs that carry one of those marks are runs of their own: the fork blame rescued a run with
 * (made as a probe, it is the path that passed, a fork that shows as one), and a probe that names
 * another run than the one it replayed (a pack can carry anything, and must not hide a run under
 * another). Both come from `classifyRun`, which every list classifies by, so the rule is written once.
 *
 * An attempt is bundled under the run it replayed while that run is in the store (a test's under the
 * attempt its golden's result shows, `filedTestAttempt`): an attempt whose run is gone has nowhere
 * else to show, so it is listed and counted like any run (`countAttempts`).
 *
 * No Node imports: the dashboard's browser bundle imports this module, as it does classify.ts.
 */
import { attemptBundles, classifyRun, type AttemptKind, type ClassifiableMeta, type ClassifiableRun } from './classify.js';
import type { RunMode } from './types.js';

export type { AttemptKind } from './classify.js';

const ATTEMPT_KINDS: ReadonlySet<string> = new Set<AttemptKind>(['repeat', 'probe', 'verify', 'test', 'chaos']);

/**
 * What the rule reads of a run: its record (a `RunRecord`, or the run a page read, has it all), or a
 * row of a list the server classified against the whole store (`attemptKind`, null for a run of its
 * own). A row's classification wins: only the whole store tells the fork blame rescued a run with,
 * and a test's attempt from a run that names one it isn't filed under.
 */
export interface RoleFacts {
  runId?: string | undefined;
  parentRunId?: string | null | undefined;
  mode?: string | undefined;
  meta?: ClassifiableMeta | null | undefined;
  attemptKind?: string | null | undefined;
}

export interface RoleContext {
  /** The run is the fork blame rescued a run with (the blamed run's `meta.blame.rescuedRunId`): a run of its own. */
  rescued?: boolean;
}

/** What made a run an attempt, by the rule above; null for a run of its own. */
export function attemptKindOf(run: RoleFacts, ctx: RoleContext = {}): AttemptKind | null {
  if (run.attemptKind !== undefined) return typeof run.attemptKind === 'string' && ATTEMPT_KINDS.has(run.attemptKind) ? (run.attemptKind as AttemptKind) : null;
  if (!run.meta) return null;
  // What made it an attempt depends on its record alone, not on how it ended or where it forked.
  const classifiable: ClassifiableRun = { runId: run.runId ?? '', parentRunId: run.parentRunId ?? null, mode: (run.mode === 'replay' ? 'replay' : 'record') satisfies RunMode, status: 'completed', divergence: null, meta: run.meta };
  return classifyRun(classifiable, ctx).attemptKind;
}

/** Whether a run is an attempt of another, by the rule above. */
export function isAttempt(run: RoleFacts, ctx: RoleContext = {}): boolean {
  return attemptKindOf(run, ctx) !== null;
}

/** The forks blame rescued runs with, among these runs: each is a run of its own, though blame made it as a probe. */
export function rescuedForks(runs: Iterable<{ meta?: ClassifiableMeta | null | undefined }>): Set<string> {
  const out = new Set<string>();
  for (const r of runs) {
    const id = r.meta?.blame?.rescuedRunId;
    if (typeof id === 'string' && id) out.add(id);
  }
  return out;
}

/**
 * Runs and attempts as every count says them: an attempt counts as one when it is bundled under a run
 * among these (`attemptBundles`), and as a run when its run is not among them. The status bar, Runs,
 * Settings → Project, the switcher and an exported copy's status bar all count this way.
 */
export function countAttempts(runs: readonly ClassifiableRun[]): { runs: number; attempts: number } {
  let attempts = 0;
  for (const ids of attemptBundles(runs).values()) attempts += ids.length;
  return { runs: runs.length - attempts, attempts };
}
