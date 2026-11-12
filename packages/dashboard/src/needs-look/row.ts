import type { RunAbout, Store } from '@shadowlap/engine';
import type { FixLead } from '../fix-lead.js';
import type { NeedsLookItem } from '../fix-summary.js';
import type { PatchCheck, RewriteCheck } from '../fix-shared.js';
import type { NextStep, NextStepWork, StepReads } from '../next-step.js';
import type { StoreNote } from '../overview.js';
import type { RunIndex } from '../run-index.js';
import type { FailingTest, GoldenList, MoreAttempts } from '../tests.js';
import type { LookGroup } from './groups.js';

/**
 * A row's one step, small and plain at its end, as plain data: a link (Continue setup, Open fix,
 * Open proof, Open passing run), a run's next step as its page leads with it (with no estimate: a
 * list carries none, and the step asks for its own when pressed), a fix's lead (fix-lead.ts), a
 * golden's Run more attempts, Update golden or Re-run test, Push local runs, Migrate to a model, or
 * Pack as golden for a behaviour no golden covers. None: the row says `Open →`.
 */
export type LookStep =
  /** `attempt`: it opens an attempt (Open proof), which no list the page holds has, so it waits while the server is out of reach. */
  | { of: 'link'; label: string; href: string; title?: string; attempt?: true }
  | { of: 'run'; runId: string; step: NextStep }
  | { of: 'fix'; fixId: string; lead: FixLead }
  | { of: 'more'; golden: string; label: string; more: MoreAttempts }
  | { of: 'update'; golden: string; label: string; command: string }
  | { of: 'rerun'; golden: string; label: string; sub: string; command: string }
  | { of: 'push'; label: string; command: string }
  | { of: 'migrate'; label: string; from: string[]; to: string; goldens: string[]; command: string }
  /** Pack a behaviour no golden covers (`coverage-pack` with its key): `fork` once the agent no longer does it, which asks for checks. */
  | { of: 'pack'; key: string; label: string; fork: boolean };

/**
 * What makes a row advice (advice.ts): its key, the same for as long as it is the same advice (never
 * the row's key, which may follow what it names); the facts it states now, each once, sorted; when
 * it comes back once put away, Dismiss's hover; and whether it is put away (the engine's
 * stillDismissed, dismissals.ts). Only advice has one: a failure is never advice.
 */
export interface LookAdvice {
  key: string;
  facts: string[];
  until: string;
  dismissed: boolean;
}

/** One row of Needs a look. */
export interface NeedsLookRow {
  /** Unique on the list, and the same from one look to the next: `attn:<what>:<what its step acts on>`. */
  key: string;
  group: LookGroup;
  /** What it is about; `injection`, `presets`, `decisions` and `coverage` are the upgrades' results (looks.ts). */
  kind: 'store-setup' | 'broken' | 'test' | 'injection' | 'presets' | 'open' | 'unblamed' | 'decisions' | 'ready' | 'coverage' | 'local' | 'retire';
  /** The icon: a setting, a failure, an inconclusive test, a blame, a fix that holds, a recording, a model that retires, or a capture. */
  icon: 'setting' | 'fail' | 'warn' | 'blame' | 'fixok' | 'rec' | 'retire' | 'cap';
  title: string;
  /** Kept whole, as every page says it. */
  detail: string;
  step: LookStep | null;
  /** Where the row opens: the whole row is its link. */
  href: string;
  runId: string | null;
  fixId: string | null;
  at: number;
  /** For the line that stands for the rest of its source: how many it stands for. */
  more?: number;
  /** A gate decided it: its rule, for the line's hover (decision 9: the line says the verdict, the tally and the bound). */
  rule?: string | null;
  /** The about line of the run the row names (decision 10), for its hover. */
  about?: RunAbout | null;
  /** A golden's name, as Tests says it, which its rule's hover is headed with. */
  name?: string;
  /** A golden's report on Tests (`report-<name>`), which its row scrolls to. */
  report?: string;
  /** The failed runs nobody has blamed: the issue on Runs › Failed of the newest, which the row opens (issues.ts); null where Failed doesn't count it. */
  issue?: string | null;
  /** Advice, which its owner may put away (Dismiss); none on a failure. */
  advice?: LookAdvice;
}

export interface NeedsLook {
  /** Every row, by group, then by its source's order: advice put away stays in its place, so the page can fold it. */
  items: NeedsLookRow[];
  /**
   * What is left to look at, the panel's count: a row each, a line for the rest of a source as many
   * as it stands for, and none for advice put away.
   */
  total: number;
  /**
   * The store's dismissals counter as it stood before the dismissals were read: a page that put
   * advice away holds its own view until a list at or past its write's counter arrives.
   */
  dismissals: number;
}

/** A golden an open fix holds: its failure is that fix's, so the fix's row names it and it has none of its own. */
export interface HeldGolden {
  golden: string;
  name: string;
  runId: string;
  /** Its run's step: the fix's, or a crash's Find breaking commit, which then leads on the fix's row. */
  step: NextStep;
}

/** What every source reads, each read made once for all of them. */
export interface LookWork {
  store: Store;
  goldens: GoldenList;
  teamStore: StoreNote | null;
  patchInTree?: PatchCheck | undefined;
  /** Why `fix apply` refuses a pulled patch in this working tree (patch-in-tree.ts), as the fix's page reads it. */
  rewriteHere?: RewriteCheck | undefined;
  /** The configured repairer, which Run repair's card names. */
  repairer?: string | null;
  budget?: number | undefined;
  next: NextStepWork | null;
  now: number;
  /** This week: its window and its first and last day, as Runs' filter takes them. */
  week: { from: number; to: number; first: string; last: string };
  index: RunIndex;
  /** What several rows' steps read, read once when a source first asks. */
  readonly reads: StepReads;
  /** Fixes' own list of what needs a look (`needsLookFixes`). */
  fixes: NeedsLookItem[];
  /** Goldens failing now, newest first (`failingTests`). */
  failing: FailingTest[];
  /** The step of each failing golden's kept run, by its path: undefined where its record can't be read. */
  steps: Map<string, NextStep | null | undefined>;
  /** The goldens each open fix holds, by fix id. */
  held: Map<string, HeldGolden[]>;
}

/** A place rows come from: later slices add one in a file of their own and a line in `SOURCES`. */
export interface LookSource {
  /** Unique: a second source with the same id throws as the module loads. */
  id: string;
  group: LookGroup;
  /** Within its group, in tens, so a later source slots between. */
  order: number;
  rows(w: LookWork): NeedsLookRow[];
  /** The line standing for the rows past the cap. */
  rest?: (n: number, rows: readonly NeedsLookRow[]) => Pick<NeedsLookRow, 'icon' | 'title' | 'detail' | 'href'>;
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** A golden's name, as Tests says it: its path without `./` and the goldens folder. */
export const goldenName = (path: string): string => path.replace(/^\.\//, '').replace(/^goldens\//, '');
