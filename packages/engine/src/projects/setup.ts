import { hasRecordedCommand } from '../pack.js';
import type { Price } from '../prices.js';
import { summarizeRun } from '../report.js';
import type { Store, StoredEvent } from '../store.js';
import type { Effect, RunRecord, RunStatus } from '../types.js';
import type { ModelServer } from './record.js';

/**
 * Setting a project up: four steps, each a CLI command (inspect with `init`, record with `run`, make
 * the replay clean with `calibrate`, keep it as a test with `pack` and `test`). The project list
 * remembers how far a project got, so the switcher can say "setting up" and the setup resumes. The
 * store and the repository say the rest, so the same commands typed in a terminal move the setup on
 * too: `init` writes its findings to the list, a recording counts once it holds calls, a clean
 * replay of it (`shadowlap replay <run>`) completes step 3, and a pack of it under `goldens/`
 * completes step 4. `calibrate --write` in a terminal leaves no trace of its own (it deletes its
 * replays), so after it the setup's Calibrate finds the replay clean as it is, or a replay shows it.
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
  /**
   * The model server the project points at (Ollama, vLLM, a proxy), when it has its own: recording
   * forwards there (`SHADOWLAP_UPSTREAM_OPENAI`). Absent in findings an older version kept.
   */
  modelServer?: ModelServer | null;
}

/** Tools found but not wrapped: a replay runs them for real, since their calls aren't recorded. */
export function unwrappedTools(findings: SetupFindings | null): SetupTool[] {
  return findings ? findings.tools.filter((t) => !t.wrapped) : [];
}

/** One `init` in the folder: when it ran, and which tools weren't wrapped then. */
export interface Inspection {
  at: number;
  unwrapped: string[];
}

// ---------------------------------------------------------------------------------------------
// What the store says

/**
 * A run marked running that started longer ago than this was left so by a process that died; one
 * being recorded or replayed now started within it. The setup and deleting a project's recordings
 * go by the same rule.
 */
export const LIVE_RUN_MS = 60 * 60 * 1000;

/** Being recorded or replayed right now, as far as the store can tell: see {@link LIVE_RUN_MS}. */
export function isLiveRun(run: { status: RunStatus; startedAt: number }, now: number): boolean {
  return run.status === 'running' && now - run.startedAt < LIVE_RUN_MS;
}

/** A run, as far as the setup needs it. */
export interface RunFact {
  runId: string;
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  /** Being recorded right now ({@link isLiveRun}). */
  live: boolean;
  /**
   * The calls it holds. A recording that ended without one recorded nothing: its command didn't
   * start (a typo), or the agent stopped before its first model call.
   */
  calls: number;
  /** A replay of it ended as it did, without a divergence and with calls replayed: the replay is clean. */
  replayedClean: boolean;
  /**
   * The tools it called, listed for the newest recording with calls and the setup's own: a tool
   * whose calls it holds was wrapped when it was recorded, whatever `init` said before.
   */
  tools?: string[];
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

/** What {@link storeFacts} reads: a `Store`, or a read-only view of one (`readStoreFacts`). */
export interface FactsSource {
  allRuns(): RunRecord[];
  countCalls(runId: string): number;
  listEvents(options: { kinds?: string[]; limit?: number }): StoredEvent[];
  /** The names of the tools a run called; a `Store` answers from its calls. */
  calledTools?(runId: string): string[];
}

function calledTools(store: FactsSource, runId: string): string[] {
  if (store.calledTools) return store.calledTools(runId);
  const calls = (store as { getCalls?: (id: string) => Array<{ kind: string; name: string }> }).getCalls?.(runId) ?? [];
  return [...new Set(calls.filter((c) => c.kind === 'tool').map((c) => c.name))];
}

/** An attempt rather than a run of its own: `replay --repeat`, a blame probe, a verify attempt. */
export function isAttempt(run: RunRecord): boolean {
  return Boolean(run.meta?.repeat || run.meta?.probe || run.meta?.verify);
}

/** A recording made in the folder: what the setup's second step makes. */
export function isRecording(run: RunRecord): boolean {
  return run.mode === 'record' && run.parentRunId === null && !run.meta?.imported && hasRecordedCommand(run) && !isAttempt(run);
}

export function emptyStoreFacts(): StoreFacts {
  return { runs: 0, attempts: 0, recordings: [], live: false, setupEvent: null, addedBefore: false };
}

/** Recordings listed at most, newest first; the setup's own is always among them. */
const MAX_RECORDINGS = 50;
/** Clean replays looked into per recording at most. */
const MAX_REPLAYS_CHECKED = 5;

/**
 * What a project's store says about its setup: runs counted, its recordings with their calls and
 * whether a replay of one ran clean, and two event kinds. `keep` is the setup's recording, listed
 * however many newer ones there are.
 */
export function storeFacts(store: FactsSource, now: number = Date.now(), options: { keep?: string | null } = {}): StoreFacts {
  const facts = emptyStoreFacts();
  // Replays that ended without a divergence, by the run they replay, with how they ended.
  const replays = new Map<string, Array<{ runId: string; status: RunStatus }>>();
  for (const run of store.allRuns()) {
    if (isAttempt(run)) facts.attempts++;
    else facts.runs++;
    const live = isLiveRun(run, now);
    if (live) facts.live = true;
    if (run.mode === 'replay' && run.parentRunId && !run.divergence && (run.status === 'completed' || run.status === 'failed') && !isAttempt(run)) {
      const list = replays.get(run.parentRunId) ?? [];
      list.push({ runId: run.runId, status: run.status });
      replays.set(run.parentRunId, list);
    }
    if (isRecording(run) && (facts.recordings.length < MAX_RECORDINGS || run.runId === options.keep)) {
      facts.recordings.push({ runId: run.runId, status: run.status, startedAt: run.startedAt, endedAt: run.endedAt, live, calls: store.countCalls(run.runId), replayedClean: false });
    }
  }
  for (const r of facts.recordings) {
    // Clean: it ended as the recording did (an agent that exits with an error does so again), and replayed calls.
    const same = (replays.get(r.runId) ?? []).filter((x) => x.status === r.status).slice(0, MAX_REPLAYS_CHECKED);
    r.replayedClean = r.calls > 0 && same.some((x) => store.countCalls(x.runId) > 0);
  }
  // The two recordings the setup may take: which tools each called.
  const newest = facts.recordings.find((r) => !r.live && usable(r));
  for (const r of facts.recordings) if (r.calls > 0 && (r === newest || r.runId === options.keep)) r.tools = calledTools(store, r.runId);
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

/** The part of a project's entry the setup reads (`ProjectSetup` has all of it). */
export interface SetupState {
  stage: SetupStage;
  /** The recording the list names: the one the setup recorded, calibrated or packed. */
  runId: string | null;
  /** What `init` found last. */
  findings?: SetupFindings | null;
  /** Each `init` in the folder, to tell which tools weren't wrapped when a recording was made. */
  inspections?: readonly Inspection[];
  /** Tools not wrapped when the named recording was made, as noted when it started (lists written before `inspections`). */
  unwrappedAtRecord?: readonly string[];
  /** What calibrate added for the named recording. */
  calibration?: { added: ReadonlyArray<{ path: string; why: string | null }> } | null;
  /** The golden kept from the named recording. */
  golden?: string | null;
}

/** A pack in the project's repository, with the runs it holds (`listPacks`). */
export interface PackFact {
  /** Relative to the project's folder: `goldens/triage-inbox`. */
  path: string;
  runIds: readonly string[];
}

export interface EffectiveSetup {
  /** The furthest step done, `done` once the setup was finished. */
  stage: SetupStage;
  /**
   * The setup's recording. Until its replay is made clean, the newest recording that holds calls:
   * recording again (after wrapping tools, or after one that recorded nothing) replaces the first.
   * From then on, the one the project list names, which its calibration and golden belong to.
   */
  run: RunFact | null;
  /** That recording is still being made. */
  live: boolean;
  /**
   * Where the dashboard shows the setup: on every page but Settings while the project has no runs,
   * on the Overview while it is being set up, nowhere once it is.
   */
  shows: 'everywhere' | 'overview' | 'none';
  /** Which steps are done for that recording: what the list says it made for it, or what the store and the repository show. */
  steps: { recorded: boolean; clean: boolean; tested: boolean };
  /** The recording is the one the list names, so the calibration the list keeps is its own. */
  own: boolean;
  /** Tools that weren't wrapped when the recording was made, as far as `init` said then: their calls aren't in it. */
  unwrappedAtRecord: string[];
  /** The newest recording, when it ended without a call after the setup's own (or with none to fall back on): nothing was recorded. */
  empty: RunFact | null;
  /** The golden kept from the recording: the one the list names, or a pack of it found in the repository. */
  golden: string | null;
  /** How the golden was kept: packed and tested from the setup (`noteTested`), or found packed in the repository. */
  goldenFrom: 'tested' | 'packed' | null;
}

/**
 * A recording can be the setup's when it holds calls and ended (completed, or failed: the agent
 * exited with an error, and that is what it does), or is being made now. One that was interrupted,
 * or left marked running by a process that died, holds only part of a run; one that ended with no
 * calls recorded nothing.
 */
function usable(r: RunFact): boolean {
  return r.live || ((r.status === 'completed' || r.status === 'failed') && r.calls > 0);
}

/**
 * Which tools weren't wrapped when `run` was recorded: what the last `init` before it said, less
 * any tool the run called (its calls are in it, so it was wrapped by then).
 */
function unwrappedWhen(state: SetupState, run: RunFact, own: boolean): string[] {
  const known: Inspection[] = [...(state.inspections ?? [])];
  if (state.findings) known.push({ at: state.findings.at, unwrapped: unwrappedTools(state.findings).map((t) => t.name) });
  let last: Inspection | null = null;
  for (const i of known) if (i.at <= run.startedAt && (!last || i.at >= last.at)) last = i;
  const said = last ? last.unwrapped : own && state.unwrappedAtRecord ? state.unwrappedAtRecord : [];
  return said.filter((name) => !run.tools?.includes(name));
}

/**
 * Where a project's setup is, from what the project list remembers, what its store holds and the
 * packs in its repository. Without a recording that holds calls the setup is at most inspected (the
 * recording may have been deleted, still be running, or have recorded nothing); one made in a
 * terminal counts. The list's own progress (calibrated, tested) counts only for the recording it
 * names. A project finished with no runs left shows the steps from the start again.
 */
export function deriveSetup(state: SetupState, facts: StoreFacts, repo: { packs?: readonly PackFact[] } = {}): EffectiveSetup {
  const hasRuns = facts.runs > 0;
  const shows = (stage: SetupStage): EffectiveSetup['shows'] => (!hasRuns ? 'everywhere' : stage === 'done' ? 'none' : 'overview');
  const finished = state.stage === 'done';
  const named = state.runId ? (facts.recordings.find((r) => r.runId === state.runId && usable(r)) ?? null) : null;
  const newest = facts.recordings.find(usable) ?? null;
  const run = ((finished || stageAtLeast(state.stage, 'clean')) && named) || newest;
  const own = !!run && run.runId === state.runId;
  const latest = facts.recordings[0] ?? null;
  const empty = latest && !latest.live && latest.calls === 0 && (!run || latest.startedAt > run.startedAt) ? latest : null;
  const base = { run, own, unwrappedAtRecord: run ? unwrappedWhen(state, run, own) : [], empty };

  const ownGolden = own && state.golden ? state.golden : null;
  const packed = run ? (repo.packs?.find((p) => p.runIds.includes(run.runId))?.path ?? null) : null;
  const kept = (tested: boolean): Pick<EffectiveSetup, 'golden' | 'goldenFrom'> => (!tested ? { golden: null, goldenFrom: null } : ownGolden ? { golden: ownGolden, goldenFrom: 'tested' } : { golden: packed, goldenFrom: 'packed' });

  if (finished && hasRuns) {
    const recorded = !!run && !run.live;
    const clean = recorded && ((own && state.calibration != null) || run.replayedClean);
    const tested = recorded && (!!ownGolden || !!packed);
    return { ...base, stage: 'done', live: !!run?.live, shows: 'none', steps: { recorded, clean, tested }, ...kept(tested) };
  }
  if (!run || run.live) {
    const stage = earlierStage(state.stage, 'inspected');
    return { ...base, stage, live: !!run, shows: shows(stage), steps: { recorded: false, clean: false, tested: false }, ...kept(false) };
  }
  const listed = own ? state.stage : 'recorded';
  const tested = (stageAtLeast(listed, 'tested') && !!ownGolden) || !!packed;
  const clean = stageAtLeast(listed, 'clean') || run.replayedClean;
  const stage: SetupStage = tested ? 'tested' : clean ? 'clean' : 'recorded';
  return { ...base, stage, live: false, shows: shows(stage), steps: { recorded: true, clean, tested }, ...kept(tested) };
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
  if (goldens > 0 && facts.recordings.some((r) => !r.live && usable(r))) return { stage: 'done', runId: null, golden: null };
  return { stage: 'added', runId: null, golden: null };
}

// ---------------------------------------------------------------------------------------------
// What a step's job means for the setup

/** What calibrate's result means for the setup's third step. */
export interface CalibrationOutcome {
  /** The replay is clean with what the config holds now: the step is done. */
  done: boolean;
  /** Normalizers calibrate added to the config, for `ProjectRegistry.noteCalibrated`. */
  added: Array<{ path: string; why: string | null }>;
  /** Normalizers it proposed without adding them: offer to add them (`calibrate <run> --write`). */
  proposed: Array<{ path: string; why: string | null }>;
  /** Why it stopped short of a clean replay. */
  stopped: string | null;
}

/**
 * Reads calibrate's result (the object `calibrate --json` prints, and a dashboard job hears as its
 * `result` event) for the setup: a recording that replays clean as it is completes the step on its
 * own; one made clean by normalizers completes it once they are written to the config, and until
 * then offers them. Null for anything else.
 */
export function calibrationOutcome(result: unknown): CalibrationOutcome | null {
  if (typeof result !== 'object' || result === null) return null;
  const r = result as Record<string, unknown>;
  if (typeof r.clean !== 'boolean' || !Array.isArray(r.normalizers)) return null;
  const rules = r.normalizers
    .filter((n): n is Record<string, unknown> => typeof n === 'object' && n !== null)
    .map((n) => ({ path: typeof n.path === 'string' && n.path ? n.path : '(every string)', why: typeof n.why === 'string' && n.why ? n.why : null }));
  const written = r.written === true;
  const stopped = typeof r.stopped === 'object' && r.stopped !== null && typeof (r.stopped as Record<string, unknown>).why === 'string' ? ((r.stopped as Record<string, unknown>).why as string) : null;
  if (!r.clean) return { done: false, added: written ? rules : [], proposed: written ? [] : rules, stopped: stopped ?? 'the replay isn’t clean yet' };
  if (written || !rules.length) return { done: true, added: written ? rules : [], proposed: [], stopped: null };
  return { done: false, added: [], proposed: rules, stopped: null };
}
