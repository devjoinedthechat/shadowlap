import { hasRecordedCommand } from '../pack.js';
import type { Price } from '../prices.js';
import { summarizeRun } from '../report.js';
import type { Store, StoredEvent } from '../store.js';
import type { Effect, RunRecord, RunStatus } from '../types.js';

/**
 * Setting a project up: four steps, each a CLI command (inspect with `init`, record with `run`, make
 * the replay clean with `calibrate`, keep it as a test with `pack` and `test`). The project list
 * remembers how far a project got, so the switcher can say "setting up" and the setup resumes; the
 * store says what it can by itself (a recording made in a terminal counts), so a step done outside
 * the dashboard still shows as done.
 */

export const SETUP_STAGES = ['added', 'inspected', 'recorded', 'clean', 'tested', 'done'] as const;
export type SetupStage = (typeof SETUP_STAGES)[number];

export function isSetupStage(value: unknown): value is SetupStage {
  return typeof value === 'string' && (SETUP_STAGES as readonly string[]).includes(value);
}

/** True when `stage` is `than` or past it. */
export function stageAtLeast(stage: SetupStage, than: SetupStage): boolean {
  return SETUP_STAGES.indexOf(stage) >= SETUP_STAGES.indexOf(than);
}

/** The further of two stages: a stage never goes back. */
export function laterStage(a: SetupStage, b: SetupStage): SetupStage {
  return stageAtLeast(a, b) ? a : b;
}

export function earlierStage(a: SetupStage, b: SetupStage): SetupStage {
  return stageAtLeast(a, b) ? b : a;
}

/** One tool `init` found, as the setup shows it. */
export interface SetupTool {
  name: string;
  /** The effect it declares, or the one suggested for it when it isn't wrapped. */
  effect: Effect;
  /** Wrapped with the SDK or an adapter, with its effect declared: its calls are recorded. */
  wrapped: boolean;
  /** Why that effect was suggested ("declared" for a wrapped tool). */
  why: string;
  file: string;
  line: number;
}

/** Code that wraps unwrapped tools, for one language. */
export interface WrapSnippet {
  language: 'python' | 'typescript' | 'javascript';
  tools: string[];
  code: string;
}

/** What `shadowlap init` found in a project, as its setup's first step shows it (from `init --json`). */
export interface SetupFindings {
  at: number;
  /** `Python 3.12 · uv`, `Node 22 · TypeScript · pnpm`; null when nothing was recognised. */
  language: string | null;
  /** The project files it went by. */
  files: string[];
  /** Model SDKs with their versions: `anthropic 0.69.0`; null when none was found. */
  sdk: string | null;
  framework: string | null;
  /** The command that starts the agent, as arguments; null when none could be read. */
  command: string[] | null;
  /** Where the command came from: `package.json scripts.agent: tsx src/agent.ts`, `agent.py`. */
  commandFrom: string | null;
  config: { file: string; created: boolean; existed: boolean };
  tools: SetupTool[];
  /** Code to wrap the tools that aren't, per language; empty when every tool is wrapped. */
  wrap: WrapSnippet[];
}

/** Tools found but not wrapped: a replay runs them for real, since their calls aren't recorded. */
export function unwrappedTools(findings: SetupFindings | null): SetupTool[] {
  return findings ? findings.tools.filter((t) => !t.wrapped) : [];
}

// ---------------------------------------------------------------------------------------------
// What the store says

/** A run, as far as the setup needs it. */
export interface RunFact {
  runId: string;
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  /**
   * Being recorded right now: marked running, and started within the last hour. One marked running
   * that started earlier was left so by a process that died.
   */
  live: boolean;
}

export interface StoreFacts {
  /** Runs, attempts left out, as the status bar counts them. */
  runs: number;
  /** Attempts: one of `replay --repeat`, or of a `blame` or `verify`. */
  attempts: number;
  /** Runs recorded in the folder with `shadowlap run`, newest first: not imported, not a replay, not an attempt. */
  recordings: RunFact[];
  /** A run is being recorded or replayed right now (one that started in the last hour). */
  live: boolean;
  /** The newest `project.setup` event: the setup was finished. */
  setupEvent: StoredEvent | null;
  /** A `project.added` event: the folder was a project in this dashboard before. */
  addedBefore: boolean;
}

/** An attempt rather than a run of its own: `replay --repeat`, a blame probe, a verify attempt. */
export function isAttempt(run: RunRecord): boolean {
  return Boolean(run.meta?.repeat || run.meta?.probe || run.meta?.verify);
}

/** A recording made in the folder: what the setup's second step makes. */
export function isRecording(run: RunRecord): boolean {
  return run.mode === 'record' && run.parentRunId === null && !run.meta?.imported && hasRecordedCommand(run) && !isAttempt(run);
}

const LIVE_WINDOW_MS = 60 * 60 * 1000;

export function emptyStoreFacts(): StoreFacts {
  return { runs: 0, attempts: 0, recordings: [], live: false, setupEvent: null, addedBefore: false };
}

/** Recordings listed at most, newest first; the setup's own is always among them. */
const MAX_RECORDINGS = 50;

/**
 * What a project's store says about its setup. Reads run rows and two event kinds; no calls.
 * `keep` is the setup's recording, listed however many newer ones there are.
 */
export function storeFacts(store: Store, now: number = Date.now(), options: { keep?: string | null } = {}): StoreFacts {
  const facts = emptyStoreFacts();
  for (const run of store.allRuns()) {
    if (isAttempt(run)) facts.attempts++;
    else facts.runs++;
    const live = run.status === 'running' && now - run.startedAt < LIVE_WINDOW_MS;
    if (live) facts.live = true;
    if (isRecording(run) && (facts.recordings.length < MAX_RECORDINGS || run.runId === options.keep)) facts.recordings.push({ runId: run.runId, status: run.status, startedAt: run.startedAt, endedAt: run.endedAt, live });
  }
  facts.setupEvent = store.listEvents({ kinds: ['project.setup'], limit: 1 })[0] ?? null;
  facts.addedBefore = store.listEvents({ kinds: ['project.added'], limit: 1 }).length > 0;
  return facts;
}

/** A run's calls, cost and duration, for the setup's "Recorded … · 12 calls · $0.041 · 38.2s". */
export interface RunTotals {
  runId: string;
  status: RunStatus;
  calls: number;
  spent: number;
  durationMs: number | null;
}

export function runTotals(store: Store, runId: string, prices?: Record<string, Price>): RunTotals | null {
  const run = store.getRun(runId);
  if (!run) return null;
  const summary = summarizeRun(run, store.getCalls(runId), [], [], prices ? { prices } : {});
  return { runId, status: run.status, calls: summary.total, spent: summary.cost.spent, durationMs: summary.durationMs };
}

// ---------------------------------------------------------------------------------------------
// Where a project's setup is

/** The part of a project's entry the setup reads. */
export interface SetupState {
  stage: SetupStage;
  runId: string | null;
}

export interface EffectiveSetup {
  stage: SetupStage;
  /** The setup's recording: the one the project list names, else the newest recording in the store. */
  run: RunFact | null;
  /** That recording is still being made. */
  live: boolean;
  /**
   * Where the dashboard shows the setup: on every page but Settings while the project has no runs,
   * on the Overview while it is being set up, nowhere once it is.
   */
  shows: 'everywhere' | 'overview' | 'none';
}

/**
 * Where a project's setup is, from what the project list remembers and what its store holds. A
 * stage never goes back, except where the store says otherwise: without a finished recording the
 * setup is at most inspected (the recording may have been deleted, or still be running), and a
 * finished one counts even when it was made in a terminal. A project finished with no runs left
 * shows the steps from the start again.
 */
export function deriveSetup(state: SetupState, facts: StoreFacts): EffectiveSetup {
  const shows = (stage: SetupStage): EffectiveSetup['shows'] => (facts.runs === 0 ? 'everywhere' : stage === 'done' ? 'none' : 'overview');
  // A recording can be the setup's when it ended (completed, or failed: the agent exited with an
  // error, and that is what it does) or is being made now; one that was interrupted, or left
  // marked running by a process that died, holds only part of a run.
  const usable = (r: RunFact) => r.live || r.status === 'completed' || r.status === 'failed';
  const named = state.runId ? (facts.recordings.find((r) => r.runId === state.runId && usable(r)) ?? null) : null;
  const run = named ?? facts.recordings.find(usable) ?? null;
  if (state.stage === 'done' && facts.runs > 0) return { stage: 'done', run, live: !!run?.live, shows: 'none' };
  if (!run || run.live) {
    const stage = earlierStage(state.stage, 'inspected');
    return { stage, run, live: !!run, shows: shows(stage) };
  }
  const stage = laterStage(state.stage, 'recorded');
  return { stage, run, live: false, shows: shows(stage) };
}

/**
 * Where a folder's setup starts when it is added, from its store: finished when the store says the
 * setup was (a folder removed and added again), or when it already has recordings and goldens (set up
 * in a terminal); otherwise at the start, which {@link deriveSetup} moves on past any recording.
 * `inUse` is for the folder a dashboard starts in: any runs there mean Shadowlap is already in use,
 * and the Overview shouldn't turn into a setup.
 */
export function initialSetup(facts: StoreFacts, goldens: number, options: { inUse?: boolean } = {}): { stage: SetupStage; runId: string | null; golden: string | null } {
  const event = facts.setupEvent;
  if (event) {
    const golden = typeof event.data?.golden === 'string' ? event.data.golden : null;
    return { stage: 'done', runId: event.runId, golden };
  }
  if (options.inUse && facts.runs > 0) return { stage: 'done', runId: null, golden: null };
  if (goldens > 0 && facts.recordings.some((r) => r.status === 'completed' || r.status === 'failed')) return { stage: 'done', runId: null, golden: null };
  return { stage: 'added', runId: null, golden: null };
}
