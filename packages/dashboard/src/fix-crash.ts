import type { Store, StoredBlame } from '@shadowlap/engine';
import { servedFound, type FoundServing } from './found-here.js';
import { crashStepOf, type CrashStep, type NextStepWork, type StepReads } from './next-step.js';
import { liveReasons } from './tests-live.js';
import type { FoundCommit } from './tests-bisect.js';

/**
 * A fix's crash path: where the blame a fix shows found no call that rescues the run, and that run is
 * a test replay whose agent exited with an error, the run's own next step is the fix's way on, as its
 * page leads with it (next-step.ts `crashStepOf`, whose rule is never copied here): Find breaking
 * commit, then Revert once that named the commit. The fix leads with it before a stronger model
 * (fix-lead.ts), and its Blame step shows the commit named.
 */
export interface FixCrash {
  runId: string;
  step: CrashStep;
  /** The first bad commit Find breaking commit named, served as every route serves one (found-here.ts); null before it named one. */
  commit: FoundCommit | null;
  /** Its golden replays offline, nothing of it live (tests-live.ts `liveReasons`): only then is its search "offline and free". */
  offline: boolean;
}

/** What working out a fix's crash path reads: the project as the next step reads it, the store's reads once for every fix of an answer, and how its found commit is served (none for a list, which shows none). */
export interface CrashReads {
  work: NextStepWork | null;
  reads: StepReads;
  serving?: FoundServing | null;
}

/** The crash path of the blame a fix shows (`shownBlame`), or null where it rescued the run, found its call, or the run didn't crash. */
export function fixCrash(store: Store, b: StoredBlame | null, o: CrashReads): FixCrash | null {
  if (b?.outcome !== 'unrescuable') return null;
  const step = crashStepOf(store, b.runId, o.work, o.reads);
  if (!step) return null;
  const found = step.key === 'revert' && o.serving ? (o.reads.standing(step.golden)?.found ?? null) : null;
  const source = o.work?.goldens.find((g) => g.path === step.golden);
  return { runId: b.runId, step, commit: found && o.serving ? servedFound(found, o.serving) : null, offline: !!source && liveReasons(source).length === 0 };
}
