import { askConsent, type CallRecord, checksOf, cleanLabel, compareRuns, type Conversation, describeGate, displayOrigin, estimateCost, gateOf, loadApiRequest, messageOf, normalizeConversation, type NormalizedResponse, normalizeResponse, ORIGIN_CODE, type Price, type RunAbout, type RunComparison, type RunKind, type RunNote, type RunOutcome, type RunRecord, type RunSummary, saidYes, shortModel, type Store, type StoreOf, summarizeRun, type ToolTrust, verdictLine, withLabels, withNote } from '@shadowlap/engine';
import { actionContext, actionMissing, buildActions, commandIsImported, forkMenuTitle, importedCommandSource, importedTrace, notRun, quoteArgv, type ActionContext, type ImportedTrace } from '@shadowlap/engine';
import { kindFacts, lookupRun, modelResolver, runLabel } from '@shadowlap/engine';
import { presetMarks, type PresetMark } from './chaos.js';
import { fixForRun, type FixForRun } from './fixes.js';
import { aboutOfRun, aboutsOf } from './run-about.js';
import { exitCodes } from './exit-codes.js';
import type { NextStep } from './next-step.js';
import type { RunJudged } from './run-outcome.js';
import { captureSource, loadRunIndex } from './run-index.js';
import { recentRuns, type RunRow } from './runs-list.js';
import { analysisFor, blameAt, conversationSource, modelName, NO_FACTS, ownFacts, partAnalysis, QUICK_FROM, READ_BEFORE, READ_PAST, runPageFacts, runProvenance, runShowJson, windowAnalysis, type CallFacts, type ProvenanceOptions, type RunAnalysis, type RunPageFacts, type RunProvenance } from './run-page.js';
import { keptCalls, runCalls } from './run-calls.js';
import { blameStep, runWholeFacts } from './run-summary.js';
// How a run stands, as the run list works it out: a run's page and its family read the same state.
import { bundleOf, runState, runStates, type RunState } from './runs-list.js';

export type { CallFacts, MaskCounter, ProvenanceOptions, RunBlame, RunCheck, RunPageFacts, RunProvenance } from './run-page.js';
export type { UnrecordedView, WebSocketView } from './run-unrecorded.js';

/**
 * The dashboard's read model: plain JSON built from the store, one function per endpoint, no HTTP.
 * Everything a browser needs to draw a view comes from one call.
 */

export interface RunListItem {
  runId: string;
  parentRunId: string | null;
  depth: number;
  mode: RunRecord['mode'];
  status: RunRecord['status'];
  label: string;
  divergence: { callNo: number; type: string } | null;
  command: string;
  /**
   * What the run was about, in one quiet line worked out from it (decision 10: the id is its name):
   * a test replay's golden, what a replay or a fork changed, an import's source, the first thing a
   * recording's user asked; where it comes from, and for a replay or a fork its change apart.
   */
  about: RunAbout;
  codeVersion: string | null;
  startedAt: number;
  endedAt: number | null;
  calls: number;
  spent: number;
  saved: number;
  /** What an imported run's calls cost whoever made them; not spent in this store. */
  captured: number;
  /** The run came from a pack or a capture rather than being recorded here. */
  imported: boolean;
  /** The call kinds a partial recording holds, or null for a complete one. */
  covers: string[] | null;
  /** For a run built from a capture, the file it came from: it has no command to show instead. */
  source: string | null;
  labels: string[];
}

export interface CallRow extends CallFacts {
  callNo: number;
  kind: CallRecord['kind'];
  name: string;
  /**
   * Where the answer came from. `injected` is a display origin: the store keeps such a call as live,
   * because it did not come from the recording, but it did not come from the provider either —
   * Shadowlap answered it with `--fail-at` — and every view that colours a call by origin says so.
   */
  origin: CallRecord['origin'] | 'injected';
  effect: CallRecord['effect'];
  outcome: 'ok' | 'error' | null;
  status: number | null;
  latencyMs: number | null;
  model: string | null;
  stopReason: string | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  cost: number | null;
  bytes: number | null;
  /** Tool arguments as one line, or the error message. */
  detail: string;
  attempts: number;
  replayedFrom: number | null;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
  /** Streamed model calls: milliseconds from the request to its first event. */
  ttftMs: number | null;
  /** The logical branch the call was made in (`scope()` in the SDKs). */
  scope: string | null;
  // ---- the run page (run-page.ts) ----
  /** What a replay matches the call on. */
  fingerprint: string;
  /** The stored request (a manifest for a model call) and response blobs, by hash; shared by every run that has them. */
  requestRef: string | null;
  responseRef: string | null;
  /**
   * A tool's result in one line of about 72 characters (`stubbed …`, `blocked`), shown under the call;
   * for a clock read or a random value, the value it gave, shown beside it; for a model call, what it
   * said (its text, about 200 characters at most), which Turns shows and Calls shows under a final
   * answer; null for one that said nothing or failed.
   */
  resultShort: string | null;
  /** A recorded user input: a person's answer the agent read, recorded like a read tool (`user_input`). */
  input?: true;
  /**
   * While its run records, a call answered with a failure the agent may retry (a 429, a 5xx, a
   * connection that broke): the retry answers it again under its number, also after calls made since
   * in another branch of the agent, so a page following the recording asks for it again.
   */
  retryable?: true;
  /**
   * A model call made to a host of another provider's format: one the config declares
   * (`openrouter.ai`, in `providers`) or one built in (`foundry`, Claude on Microsoft Foundry;
   * `bedrock-mantle`, OpenAI's API on Amazon Bedrock), as the call keeps it (`meta.via`). Its
   * `provider` is then the format it speaks.
   */
  via?: string;
  /**
   * A replay's plain read (a clock read, a random value, a pure tool's call) its recording held no
   * counterpart for: answered live while the replay went on replaying, never a fork (`meta.extraRead`).
   */
  extraRead?: true;
}

export interface RunDetail extends RunPageFacts {
  run: RunRecord;
  label: string;
  /** How many calls the run has: `calls` holds the first page of them (`CALLS_PAGE`), the rest come a page at a time (`runCallsPage`). */
  callsTotal: number;
  /** The call the next page starts at (`GET /api/runs/:id/calls?from=`), or null when `calls` reaches the run's end. */
  callsNext: number | null;
  /**
   * One character per call of the whole run, in call order, as the run list encodes them (r replayed,
   * l live, o overridden, i injected, f failed, b blocked, s stubbed): the origin strip draws every call
   * from it before their pages have come. Absent when `calls` holds every call.
   */
  origins?: string;
  /**
   * Set while the run is too long to analyse whole for a first answer and the whole of it is being
   * analysed beside the server: what the page reads of its conversations, the prompt cache and the
   * time not waited covers its first `done` calls of `total`, and a call near their end may read
   * differently once it is done. Asked again, the answer has the whole run.
   */
  warming?: { done: number; total: number };
  /** What the run was about, as the lists say it (run-about.ts); null for a run the index doesn't have yet. */
  about: RunAbout | null;
  /** Set for a run built from a capture, which has no command: where it came from. */
  source: string | null;
  /** For a run imported from a trace store: the trace, with its page there (`importedTrace`); absent otherwise. */
  trace?: ImportedTrace;
  summary: RunSummary;
  calls: CallRow[];
  parent: { runId: string; label: string } | null;
  /**
   * The runs made from it, oldest first, each with its kind as the run list classifies it (`fork`,
   * `clean`, `test`…). `attempt` marks one bundled under it as the lists bundle it (a blame probe, a
   * verify or `--repeat` attempt, a model's scoring attempt): Compare on a recording opens its first
   * fork or replay, never one of those, and Compare given only this run pairs it with its newest fork.
   */
  children: Array<{ runId: string; label: string; kind: RunKind | null; startedAt: number; attempt?: true }>;
  /**
   * How many attempts are bundled under it, at any depth (a `--repeat` of one of blame's probes too),
   * as Runs counts them: what deleting it takes with it, which its Delete names.
   */
  attempts: number;
  /** Actions that need no selected call: replay, stub writes, add the suggested normalizer, pack. */
  actions: ActionItem[];
  /** The fix the run takes part in, and how (Fixes' fixForRun): the banner's fix, blame and Run blame. */
  fix: FixForRun | null;
  /**
   * How the run stands, worked out as the run list works it out (runs-list.ts `runState`), so its
   * page says what Runs, the sidebar and the Overview say: its kind, its outcome, whether it failed,
   * and whether it was interrupted. `run.status` is that state's: a run its recorder left `running`
   * reads `crashed`, ended at its last call (`run.endedAt`), as gc would end it.
   */
  state: RunState | null;
  /**
   * For an attempt made with others (`meta.repeat`: a blame probe's, a verify's, a `--repeat`'s), its
   * place among them and how many were made: the runs under the same parent that share its group, in
   * the order they were made. The record's `repeat.of` is the most that could be made (a gate's
   * limit, `--attempts`, the count `--repeat` asked for), which a probe or a verify that settles
   * early never reaches. Null for any other run.
   */
  attemptPlace: { k: number; n: number } | null;
  /**
   * Set on an answer to `?after=<n>`, a recording's page following it: `calls` holds only the calls
   * numbered after `n`, and the page keeps the ones it has up to there. Everything else is the whole run's.
   */
  after?: number;
  /**
   * Its outcome by checks, each check with it (run-outcome.ts): its own, a capture's by the rules on
   * calls, or its family's goldens' judged from its recording; null when no check judges it. Absent on
   * a long run's first answer, until its analysis has judged it.
   */
  judged?: RunJudged | null;
  /** For a test replay its agent's exit failed: the code, as its test result keeps it (run-outcome.ts `exitCodes`). */
  exitCode?: number;
  /** For a failed test replay whose golden passed when it ran again since: the run that passed, which its status names (runs-filter.ts `fixedByOf`). */
  fixedBy?: string;
  /**
   * Its next step, what its header's lime button leads with (next-step.ts), with what it bills; a long
   * run's first answer leaves that out, until its calls are read. An exported copy holds only a
   * comparison with a run it holds, since it runs nothing and holds no fix.
   */
  next?: NextStep;
  /** Replay as its header keeps it beside the next step: on a clean or a test replay, the recording it came from. Not in an exported copy. */
  replay?: NextStep;
}

export interface CallDetail {
  call: CallRow & { fingerprint: string; occurrence: number; startedAt: number; endedAt: number | null; implHash: string | null; headers: Record<string, string>; provider: string | null };
  /**
   * The conversation the model saw at this call. A tool call shows its own conversation's latest
   * request before it (or the first after it, for a call made before its conversation's first
   * model call), never another scope's or conversation's; `n` is that conversation's number.
   */
  conversation: (Conversation & { fromCallNo: number; n: number | null }) | null;
  request: unknown;
  response: NormalizedResponse | null;
  /** Tool calls: the recorded result or error. */
  result: unknown;
  /** Notes people left on this call. */
  notes: RunNote[];
  actions: ActionItem[];
  /** The fork menu's header for this call: `At #19 · search_web · read tool`. */
  forkTitle: string;
  /** As a page of calls has it (`CallsPage.around`): details of a call deep in a long run, answered from the calls around it while the run is analysed; the conversation's number comes with `whole=1`. */
  around?: { from: number; to: number };
}

export interface ActionItem {
  key: string;
  label: string;
  opensRun: boolean;
  /**
   * `choices`: answers to offer as a list (a tool error's kinds); any other answer is accepted too. A
   * choice with `text` needs a few words more: show a field labelled `text` and send the choice's value
   * followed by what was typed (`error:` + `connection reset`).
   */
  prompt: { label: string; placeholder?: string; initial?: string; choices?: Array<{ value: string; label: string; text?: string }> } | null;
  /** Why the action cannot run on this run, shown in its place; null when it can. */
  disabled: string | null;
  /** The flag, shown on the right of the action's line: `--fail-at 19=429`. */
  flag: string | null;
  /** `call`: the fork menu at the selected call; `run`: its "The whole run" part; null: offered elsewhere (Replay, Pack, a normalizer). */
  group: 'call' | 'run' | null;
  /** One line on what the action does and why, for its dialog. */
  hint: string | null;
  /** Set when it asks before it starts with nothing to fill in: a fork's Repeat 5 times, whose attempts run live from the fork; a write forced live. */
  asksFirst?: true;
  /** The command an action with nothing to fill in runs. */
  command?: string;
  /** The model at this call, where it takes no system message mid-conversation. */
  noSystemMessage?: string;
  /** What it does for real, as its dialog's red line: a write forced live. */
  warns?: string;
}

export interface ReadOptions {
  prices?: Record<string, Price>;
}

const ONE_LINE = 240;

function oneLine(v: unknown): string {
  const s = typeof v === 'string' ? v : (JSON.stringify(v) ?? '');
  return s.length > ONE_LINE ? `${s.slice(0, ONE_LINE - 1)}…` : s;
}

/** A call's row; `recording` while its run records, when a failure the agent may retry is marked so. */
function row(store: StoreOf<'recording'>, c: CallRecord, options: ReadOptions, facts: CallFacts = NO_FACTS, recording = false): CallRow {
  const end = c.end;
  const u = end?.meta.usage;
  const model = end?.meta.model ?? c.meta.model ?? (c.kind === 'api' ? modelResolver(store)(c) : null) ?? null;
  let detail = '';
  if (c.kind === 'tool' && c.requestRef) detail = oneLine(store.getJson<{ args?: unknown }>(c.requestRef)?.args ?? null);
  else if ((c.kind === 'clock' || c.kind === 'random') && c.requestRef) detail = oneLine(store.getJson<{ label?: string }>(c.requestRef)?.label ?? '');
  return {
    callNo: c.callNo,
    kind: c.kind,
    name: c.name,
    origin: end?.meta.injected ? 'injected' : c.origin,
    effect: c.effect,
    outcome: end ? end.outcome : null,
    status: typeof end?.meta.status === 'number' ? end.meta.status : null,
    latencyMs: typeof end?.meta.latencyMs === 'number' ? end.meta.latencyMs : null,
    model: model ? shortModel(model) : null,
    stopReason: end?.meta.stopReason ?? null,
    usage: u ? { input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadInputTokens ?? 0, cacheWrite: u.cacheCreationInputTokens ?? 0 } : null,
    cost: c.kind === 'api' ? estimateCost(model, u, options.prices) : null,
    bytes: typeof end?.meta.bytes === 'number' ? end.meta.bytes : null,
    detail,
    attempts: c.attempts.length,
    replayedFrom: typeof end?.meta.replayedFrom === 'number' ? end.meta.replayedFrom : null,
    error: end?.meta.error ? `${end.meta.error.name}: ${end.meta.error.message}` : null,
    startedAt: c.at,
    endedAt: end?.at ?? null,
    ttftMs: c.kind === 'api' && end?.meta.chunks?.length && (end.meta.replayedFrom === undefined) ? (end.meta.chunks[0]?.[1] ?? null) : null,
    scope: typeof c.meta.scope === 'string' ? c.meta.scope : null,
    ...ownFacts(store, c),
    ...facts,
    ...(recording && end?.outcome === 'error' && end.meta.retryable === true ? { retryable: true as const } : {}),
    ...(c.kind === 'api' && typeof c.meta.via === 'string' && c.meta.via ? { via: c.meta.via.slice(0, 200) } : {}),
    ...(c.meta.extraRead === true ? { extraRead: true as const } : {}),
  };
}

/**
 * The sidebar's Recent runs (`/api/runs`): the newest runs as a tree, each with its kind, outcome,
 * origins and the attempts bundled under it. Attempts are not rows unless asked for (`recentRuns`).
 */
export function listRuns(store: Store, options: ReadOptions & { includeAttempts?: boolean; ids?: readonly string[]; known?: boolean } = {}): RunRow[] {
  return recentRuns(store, options);
}

/** A run by its full id or a unique prefix: the engine's, which the routes and the read models here ask. */
export { lookupRun };

/**
 * Whether a run id prefix matches several runs and no run whole: `lookupRun` finds none for it, as
 * the CLI refuses it, and the dashboard says so rather than that there is no such run.
 */
export function ambiguousRunId(store: StoreOf<'readModels'>, idOrPrefix: string): boolean {
  if (!/^[0-9A-Za-z]{1,26}$/.test(idOrPrefix)) return false;
  const want = idOrPrefix.toUpperCase();
  let n = 0;
  for (const r of loadRunIndex(store).runs) {
    if (r.runId === want) return false;
    if (r.runId.startsWith(want)) n++;
  }
  return n > 1;
}

/** The error for a run id that names no single run: several runs (409), or none (404). */
export function noSuchRun(store: StoreOf<'readModels'>, idOrPrefix: string): { status: number; message: string } {
  const id = idOrPrefix.slice(0, 40);
  return ambiguousRunId(store, idOrPrefix) ? { status: 409, message: `run id prefix ${id} matches several runs: use more of the id` } : { status: 404, message: `no run ${id}` };
}

/** A run's children for its page, each attempt marked as the run lists bundle it. */
function childRows(store: StoreOf<'recording' | 'readModels'>, runId: string): RunDetail['children'] {
  const index = loadRunIndex(store);
  return store.childRuns(runId).map((r) => {
    const listed = index.byId.get(r.runId);
    return { runId: r.runId, label: runLabel(r, kindFacts(store, r, store.countCalls(r.runId))), kind: listed?.kind ?? null, startedAt: r.startedAt, ...(listed?.bundled ? { attempt: true as const } : {}) };
  });
}

/** The most calls one answer holds: a run's first page, and each page after (contract 8). */
export const CALLS_PAGE = 500;
/**
 * The first page of a long run that ended and that this thread hasn't read: a screen's worth and
 * more, as the page shows a window of rows and asks for the page of any call it moves to; fewer
 * calls read and analysed for the first answer.
 */
export const LONG_RUN_FIRST_PAGE = 200;

/** The calls of a page: those after `after` (or from `from` on), at most `limit`, and where the next page starts. */
function pageOf(calls: readonly CallRecord[], at: { after?: number; from?: number }, limit: number): { page: readonly CallRecord[]; next: number | null } {
  let start = 0;
  while (start < calls.length && (at.after !== undefined ? calls[start]!.callNo <= at.after : at.from !== undefined && calls[start]!.callNo < at.from)) start++;
  const page = calls.slice(start, start + limit);
  return { page, next: calls[start + limit]?.callNo ?? null };
}

/** One character per call, as the run list encodes them (run-stats.ts `codes`). */
function originCodes(calls: readonly CallRecord[]): string {
  return calls.map((c) => ORIGIN_CODE[displayOrigin(c.origin, c.end ? { outcome: c.end.outcome, injected: c.end.meta.injected } : null)]).join('');
}

/**
 * What a page of a run's calls (or one call's details) is drawn from: the calls it shows (from `at`,
 * at most `limit`), where the next page starts, and the analysis of the run that gives their facts,
 * whole or of a part of the run (`whole`, `done`). A page of a long run that has ended, and that this
 * thread has not read lately, reads a part of the run rather than the whole of it, which is read and
 * analysed beside the server meanwhile: a page near the start the calls up to it and a few past it;
 * a page deeper in (past `PREFIX_MAX`) the calls around it alone (`around`), so its cost grows with
 * the page, not with how deep in the run it is. `whole` reads and analyses the whole run.
 */
interface PageRead {
  page: readonly CallRecord[];
  next: number | null;
  analysis: RunAnalysis;
  whole: boolean;
  done: number;
  /** Every call of the run, as read: null when only a part of it was. */
  calls: readonly CallRecord[] | null;
  /** The calls a page deep in the run was read with, when they are what its facts come from (`windowAnalysis`). */
  around: { from: number; to: number } | null;
}

/** The furthest call a page is read up to from the run's first call; past it, only the calls around the page are. */
export const PREFIX_MAX = 2000;

function readPage(store: Store, run: RunRecord, at: { after?: number; from?: number }, limit: number, o: { whole?: boolean } = {}): PageRead {
  const held = keptCalls(store, run.runId);
  const first = at.from ?? (at.after ?? 0) + 1;
  if (!held && !o.whole && run.status !== 'running') {
    const total = store.countCalls(run.runId);
    const upTo = first - 1 + limit + READ_PAST;
    if (total >= QUICK_FROM && upTo <= PREFIX_MAX && upTo * 2 < total) {
      // The run's calls from its first up to the page and a few past it: what the page's facts come from.
      const part = store.getCalls(run.runId, { after: 0, limit: upTo });
      const { page, next } = pageOf(part, at, limit);
      return { page, next, analysis: partAnalysis(store, run, part), whole: false, done: part.length, calls: null, around: null };
    }
    if (total >= QUICK_FROM && upTo > PREFIX_MAX) {
      // The calls around the page: a few hundred before it, and a hundred after.
      const after = Math.max(0, first - 1 - READ_BEFORE);
      const part = store.getCalls(run.runId, { after, limit: first - 1 - after + limit + READ_PAST });
      // Read with a hundred calls past it: the page after starts among them, unless the run ends with it.
      const { page, next } = pageOf(part, at, limit);
      return { page, next, analysis: windowAnalysis(store, run, part), whole: false, done: part.length, calls: null, around: { from: part[0]?.callNo ?? first, to: part.at(-1)?.callNo ?? first } };
    }
  }
  const calls = held ?? runCalls(store, run.runId);
  const { page, next } = pageOf(calls, at, limit);
  const { analysis, whole, done } = analysisFor(store, run, calls, page.at(-1)?.callNo ?? 0);
  return { page, next, analysis, whole, done, calls, around: null };
}

/** The calls a replay's flags are read from (run-facts.ts `runInterventions`): its overridden ones, those injected with a failure, and one it stubbed. */
const FLAG_CALLS_SQL = `
SELECT s.call_no AS n FROM call_events s WHERE s.run_id = ? AND s.phase = 'start' AND (s.origin = 'overridden' OR (s.kind = 'api' AND EXISTS (
  SELECT 1 FROM call_events e WHERE e.run_id = s.run_id AND e.call_no = s.call_no AND e.phase = 'end' AND json_type(e.meta, '$.injected') IN ('true', 'integer', 'real', 'text', 'object', 'array'))))
UNION SELECT n FROM (SELECT call_no AS n FROM call_events WHERE run_id = ? AND phase = 'start' AND origin = 'stubbed' LIMIT 1)`;

/**
 * The first page of a long run that ended, which this thread has not read lately: the calls it shows
 * and a few after, whole, their facts from the analysis of those calls, and what the page says of the
 * whole run (its summary, the origin strip, its models, blame's step) worked out in SQL rather than
 * from every call read whole (run-summary.ts). The whole run is read and analysed beside the server
 * once this is answered (`warming`).
 */
function firstPageOfLongRun(store: Store, run: RunRecord, shown: RunRecord, state: RunState | null, options: ReadOptions, limit: number): RunDetail {
  const runId = run.runId;
  const head = store.getCalls(runId, { after: 0, limit: limit + READ_PAST });
  const page = head.slice(0, limit);
  const whole = runWholeFacts(store, shown, { ...(options.prices ? { prices: options.prices } : {}), modelOf: modelResolver(store), name: modelName });
  const analysis = partAnalysis(store, run, head);
  const at = blameAt(run);
  const flagCalls = run.mode === 'replay' ? store.getCalls(runId, { only: store.query(FLAG_CALLS_SQL, runId, runId).map((r) => Number(r.n)) }) : [];
  const parent = run.parentRunId ? store.getRun(run.parentRunId) : null;
  return {
    run: shown,
    label: runLabel(run, kindFacts(store, run, whole.calls)),
    about: aboutOfRun(store, loadRunIndex(store), runId, { calls: head }),
    source: captureSource(run),
    ...traceOf(run),
    summary: whole.summary,
    calls: page.map((c) => row(store, c, options, analysis.facts(c.callNo), false)),
    callsTotal: whole.calls,
    callsNext: head[limit]?.callNo ?? null,
    origins: whole.origins,
    parent: parent ? { runId: parent.runId, label: runLabel(parent, kindFacts(store, parent, store.countCalls(parent.runId))) } : null,
    children: childRows(store, runId),
    attempts: bundleOf(loadRunIndex(store), runId).length,
    actions: actionsFor(run, undefined),
    ...runPageFacts(store, run, flagCalls, analysis, { models: whole.models, blameStep: at?.callNo != null ? blameStep(store, runId, at.callNo, at.scope) : null }),
    fix: fixForRun(store, run.runId),
    state,
    attemptPlace: attemptPlace(store, run),
    warming: { done: head.length, total: whole.calls },
    ...exitOf(store, shown),
  };
}

/**
 * A run's page: the run, the first page of its calls (`CALLS_PAGE`, or `limit`: an exported copy
 * holds every call), `callsTotal` and `callsNext`, and what the page shows about it. `after` answers
 * with the page of calls after the n the page has, for a recording it follows. A long run that ended
 * is answered from the calls its first page shows (`firstPageOfLongRun`), and says so (`warming`);
 * any other from every call, read once and kept for the pages after.
 */
export function runDetail(store: Store, idOrPrefix: string, options: ReadOptions = {}, part: { after?: number; limit?: number } = {}): RunDetail | null {
  const run = lookupRun(store, idOrPrefix);
  if (!run) return null;
  const after = part.after;
  const runId = run.runId;
  const state = runState(store, runId);
  // Interrupted as the lists have it: a run its recorder left running is not recording any more,
  // and ended at its last call, as gc would end it.
  const shown = state && state.status !== run.status ? { ...run, status: state.status, endedAt: run.endedAt ?? state.endedAt } : run;
  const limit = Math.max(1, part.limit ?? CALLS_PAGE);
  if (after === undefined && limit <= CALLS_PAGE && run.status !== 'running' && !keptCalls(store, runId) && store.countCalls(runId) >= QUICK_FROM) return firstPageOfLongRun(store, run, shown, state, options, Math.min(limit, LONG_RUN_FIRST_PAGE));
  const read = readPage(store, run, after === undefined ? {} : { after }, limit, { whole: true });
  const { page, next, analysis, whole, done } = read;
  const calls = read.calls!;
  const summary = summarizeRun(shown, calls as CallRecord[], [], [], { modelOf: modelResolver(store), ...(options.prices ? { prices: options.prices } : {}) });
  const parent = run.parentRunId ? store.getRun(run.parentRunId) : null;
  return {
    run: shown,
    label: runLabel(run, kindFacts(store, run, calls.length)),
    about: aboutOfRun(store, loadRunIndex(store), runId, { calls }),
    source: captureSource(run),
    ...traceOf(run),
    summary,
    calls: page.map((c) => row(store, c, options, analysis.facts(c.callNo), shown.status === 'running')),
    callsTotal: calls.length,
    callsNext: next,
    ...(next !== null ? { origins: originCodes(calls) } : {}),
    parent: parent ? { runId: parent.runId, label: runLabel(parent, kindFacts(store, parent, store.countCalls(parent.runId))) } : null,
    children: childRows(store, runId),
    attempts: bundleOf(loadRunIndex(store), runId).length,
    actions: actionsFor(run, undefined),
    ...runPageFacts(store, run, calls, analysis),
    fix: fixForRun(store, run.runId),
    state,
    attemptPlace: attemptPlace(store, run),
    ...(after === undefined ? {} : { after }),
    ...(whole ? {} : { warming: { done, total: calls.length } }),
    ...exitOf(store, shown),
  };
}

/** The trace an imported run was read from, with its page in the trace store, where the import kept one. */
function traceOf(run: RunRecord): Pick<RunDetail, 'trace'> {
  const trace = importedTrace(run);
  return trace ? { trace } : {};
}

/** A test replay's agent exit code, where its exit failed it and its test result kept the code. */
function exitOf(store: Store, run: RunRecord): Pick<RunDetail, 'exitCode'> {
  const code = exitCodes(store, [{ runId: run.runId, status: run.status, test: run.meta?.test ?? null }]).get(run.runId);
  return code === undefined ? {} : { exitCode: code };
}

/** A page of a run's calls (`GET /api/runs/:id/calls?from=&limit=`, contract 8). */
export interface CallsPage {
  runId: string;
  /** The calls from `from` on, at most `limit` (`CALLS_PAGE`). */
  calls: CallRow[];
  callsTotal: number;
  /** Where the page after starts, or null at the run's end. */
  callsNext: number | null;
  /** As on the run's page (`RunDetail.warming`): the facts of these calls come from `done` of the run's calls, and may change once the whole run is analysed. */
  warming?: { done: number; total: number };
  /**
   * For a page deep in a long run answered while the run is analysed: the calls its facts come from,
   * those around it, from `from` to `to`. Each call's conversation number is left out (null), and a
   * fact a call before them would decide (the model call that asked for a tool call) may come later:
   * asked again with `whole=1`, the page waits for the whole run's analysis.
   */
  around?: { from: number; to: number };
}

/**
 * The calls of a run from call `from` on, at most `limit`, as the run's page shows them; null for a
 * run that isn't there. `whole` waits for the whole run's analysis rather than answer from a part.
 */
export function runCallsPage(store: Store, idOrPrefix: string, at: { from: number; limit?: number }, options: ReadOptions = {}, o: { whole?: boolean } = {}): CallsPage | null {
  const run = lookupRun(store, idOrPrefix);
  if (!run) return null;
  const state = runState(store, run.runId);
  const read = readPage(store, run, { from: at.from }, Math.max(1, Math.min(CALLS_PAGE, at.limit ?? CALLS_PAGE)), o.whole ? { whole: true } : {});
  const recording = (state?.status ?? run.status) === 'running';
  const total = read.calls?.length ?? store.countCalls(run.runId);
  return {
    runId: run.runId,
    calls: read.page.map((c) => row(store, c, options, read.analysis.facts(c.callNo), recording)),
    callsTotal: total,
    callsNext: read.next,
    ...(read.whole ? {} : { warming: { done: read.done, total } }),
    ...(read.around ? { around: read.around } : {}),
  };
}

/**
 * An attempt's place among the attempts made with it, and how many those are (`RunDetail.attemptPlace`):
 * the runs of its parent that share its `repeat.group`, ordered by the attempt each says it is, then
 * by when it started. The fork blame rescued a run with is one of its probe's attempts, though the
 * lists show it as a fork of its own, so every run of the parent is read, not the run index's
 * bundles alone. Null for a run that names no group.
 */
export function attemptPlace(store: StoreOf<'readModels'>, run: Pick<RunRecord, 'runId' | 'parentRunId' | 'meta'>): { k: number; n: number } | null {
  const group: unknown = run.meta?.repeat?.group;
  if (typeof group !== 'string' || !group || !run.parentRunId) return null;
  const same = loadRunIndex(store).runs.filter((r) => r.parentRunId === run.parentRunId && r.meta.repeat?.group === group);
  same.sort((a, b) => a.meta.repeat!.attempt - b.meta.repeat!.attempt || a.startedAt - b.startedAt || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  const k = same.findIndex((r) => r.runId === run.runId) + 1;
  return k > 0 ? { k, n: same.length } : null;
}

/** The run's record for the Provenance tab: command, code version, times in UTC, models, providers, lineage, and what a copy would mask. */
export function provenance(store: Store, idOrPrefix: string, options: ReadOptions & ProvenanceOptions = {}): RunProvenance | null {
  const run = lookupRun(store, idOrPrefix);
  return run ? runProvenance(store, run, options) : null;
}

/** `shadowlap show <run> --json` as the CLI prints it, for Copy show --json. */
export function showRunJson(store: StoreOf<'recording'>, idOrPrefix: string, options: ReadOptions & { tools?: ToolTrust } = {}): ReturnType<typeof runShowJson> | null {
  const run = lookupRun(store, idOrPrefix);
  return run ? runShowJson(store, run, options) : null;
}

/** The model named in a call's path: Gemini and Vertex `models/<model>:…`, Bedrock `/model/<id>/…`. */
function modelInPath(name: string): string | null {
  const gemini = /models\/([^:/?]+):/.exec(name)?.[1];
  if (gemini) return gemini;
  const bedrock = /\/model\/([^/]+)\//.exec(name)?.[1];
  return bedrock ? decodeURIComponent(bedrock) : null;
}

export function callDetail(store: Store, idOrPrefix: string, callNo: number, options: ReadOptions = {}, o: { whole?: boolean } = {}): CallDetail | null {
  const run = lookupRun(store, idOrPrefix);
  if (!run) return null;
  // Read once while the run stays the same: the inspector asks for its calls one by one. Of a long
  // run not read here lately, the calls up to this one (and a few past it) are, or deep in the run
  // those around it.
  const read = readPage(store, run, { from: callNo }, 1, o.whole ? { whole: true } : {});
  const d = callDetailFrom(store, run, read.calls ?? [], read.analysis, callNo, options);
  return d && read.around ? { ...d, around: read.around } : d;
}

/**
 * Keeps the conversation shown at the call before, for an export going through a run's calls in
 * order: a tool call shows the conversation of the model call before it, read and normalized once.
 */
export interface ConversationMemo {
  last?: { callNo: number; conversation: CallDetail['conversation'] };
}

/**
 * A call's details from its run's calls and their analysis, already read: what `callDetail` answers.
 * An export works out every call of a run from one read of it, so its time grows with the run's
 * length, not with its square.
 */
export function callDetailFrom(store: Store, run: RunRecord, calls: readonly CallRecord[], analysis: RunAnalysis, callNo: number, options: ReadOptions = {}, memo?: ConversationMemo): CallDetail | null {
  const c = analysis.byNo.get(callNo);
  if (!c) return null;
  const end = c.end;
  const provider = typeof (end?.meta.provider ?? c.meta.provider) === 'string' ? String(end?.meta.provider ?? c.meta.provider) : null;

  let request: unknown = null;
  let conversation: CallDetail['conversation'] = null;
  if (c.requestRef) {
    try {
      request = c.kind === 'api' ? loadApiRequest(store, c.requestRef) : store.getJson(c.requestRef);
    } catch (err) {
      request = { error: `could not load the stored request: ${messageOf(err)}` };
    }
  }
  // The conversation at this call: its own request for a model call, else its conversation's
  // latest request, which in a batch or a multi-agent run is not simply the latest one before it.
  const source = conversationSource(store, run, calls, callNo, analysis);
  if (source?.call.requestRef && memo?.last?.callNo === source.call.callNo) conversation = memo.last.conversation;
  else if (source?.call.requestRef) {
    try {
      const body = source.call === c ? request : loadApiRequest(store, source.call.requestRef);
      const conv = normalizeConversation(body, modelInPath(source.call.name));
      if (conv) conversation = { ...conv, fromCallNo: source.call.callNo, n: source.n };
    } catch {
      // an unreadable request leaves the conversation empty
    }
    if (memo) memo.last = { callNo: source.call.callNo, conversation };
  }

  let response: NormalizedResponse | null = null;
  let result: unknown = null;
  const bytes = end?.responseRef ? store.getBlob(end.responseRef) : null;
  if (c.kind === 'api') response = normalizeResponse(bytes, end?.meta.headers?.['content-type'], end?.meta.chunks ?? [], provider ?? undefined);
  else if (bytes) {
    try {
      result = JSON.parse(bytes.toString('utf8'));
    } catch {
      result = bytes.toString('utf8');
    }
  }

  return {
    call: {
      ...row(store, c, options, analysis.facts(c.callNo)),
      fingerprint: c.fingerprint,
      occurrence: c.occurrence,
      startedAt: c.at,
      endedAt: end?.at ?? null,
      implHash: typeof c.meta.implHash === 'string' ? c.meta.implHash : null,
      headers: end?.meta.headers ?? {},
      provider,
    },
    conversation,
    request,
    response,
    result,
    notes: (run.meta?.notes ?? []).filter((n) => n.callNo === c.callNo),
    actions: actionsFor(run, c, actionContext(store, c)),
    forkTitle: forkMenuTitle(c),
  };
}

export function actionsFor(run: RunRecord, call: CallRecord | undefined, context: ActionContext = {}): ActionItem[] {
  return buildActions(run, call, context).map((a) => ({
    key: a.key,
    label: a.label,
    opensRun: a.opensRun,
    // A replay of someone else's command that asks only for a yes asks nothing here: the page confirms the command (importedConsent).
    prompt:
      a.prompt && a.imported !== 'confirm'
        ? { label: a.prompt.label, ...(a.prompt.placeholder !== undefined ? { placeholder: a.prompt.placeholder } : {}), ...(a.prompt.initial !== undefined ? { initial: a.prompt.initial } : {}), ...(a.prompt.choices ? { choices: a.prompt.choices } : {}) }
        : null,
    disabled: a.disabled ?? null,
    flag: a.flag ?? null,
    group: a.group ?? null,
    hint: a.hint ?? null,
    ...(a.asksFirst ? { asksFirst: true as const } : {}),
    ...(a.args ? { command: quoteArgv(['shadowlap', ...a.args]) } : {}),
    ...(a.noSystemMessage ? { noSystemMessage: a.noSystemMessage } : {}),
    ...(a.warns ? { warns: a.warns } : {}),
  }));
}

/**
 * A replay of a run whose command came from someone else's pack, or from the team store, runs that
 * command: only once the request says yes to it itself, whatever the action asked before (a number
 * of attempts, an instruction, an edited result). Refused, it says both commands, as a fix's jobs
 * do, and the yes the page sends from the step that shows them is to those lines (consent.ts).
 */
export function importedConsent(run: RunRecord, args: readonly string[], yes: unknown): { error: string; status: number; confirm: string } | null {
  if (!commandIsImported(run)) return null;
  // The command as the page shows it, without the --yes the action adds for the CLI.
  const shown = [...args];
  const at = shown.indexOf('--yes');
  if (at >= 0) shown.splice(at, 1);
  const lines = [run.command.argv, ['shadowlap', ...shown]];
  if (saidYes(yes, lines)) return null;
  return askConsent(`${run.runId.slice(0, 10)} came from ${importedCommandSource(run)}: this runs the command it was recorded with (${quoteArgv(run.command.argv)}), under ${quoteArgv(['shadowlap', ...shown])}. Confirm it to run it`, lines);
}

/** The CLI arguments for an action, rebuilt on the server from the run and call: the browser never sends a command line. */
export function actionArgs(store: StoreOf<'recording'>, idOrPrefix: string, callNo: number | null, key: string, value: string | undefined, o: { yes?: unknown } = {}): { args: string[]; opensRun: boolean } | { error: string; status?: number; confirm?: string } {
  const run = lookupRun(store, idOrPrefix);
  if (!run) return { error: `unknown run ${idOrPrefix}` };
  const call = callNo === null ? undefined : store.getCalls(run.runId, { only: [callNo] })[0];
  if (callNo !== null && !call) return { error: `no call #${callNo} in run ${run.runId}` };
  const action = buildActions(run, call, actionContext(store, call)).find((a) => a.key === key);
  if (!action) return { error: actionMissing(run, key) };
  // The menu shows a disabled action greyed out; the server refuses it too, whatever a request says.
  if (action.disabled) return { error: action.disabled };
  if (action.args) return { args: action.args, opensRun: action.opensRun };
  if (!action.prompt) return { error: `action "${key}" has nothing to run` };
  // One that asks only for a yes to someone else's command takes it from the request (importedConsent).
  const v = action.imported === 'confirm' ? 'yes' : (value ?? '').trim();
  if (!v) return { error: `${action.prompt.label} is required` };
  const args = action.prompt.build(v);
  if (!args.length) return { error: notRun(run) };
  const refused = action.imported ? importedConsent(run, args, o.yes) : null;
  if (refused) return refused;
  return { args, opensRun: action.opensRun };
}

/** Adds and removes labels on a run: the labels it has now, or why they could not be changed. */
export function changeLabels(store: StoreOf<'recording'>, idOrPrefix: string, add: unknown, remove: unknown): { labels: string[] } | { error: string; status: number } {
  const run = lookupRun(store, idOrPrefix);
  if (!run) return { error: `no run ${idOrPrefix}`, status: 404 };
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const cleaned: string[] = [];
  for (const raw of list(add)) {
    const c = cleanLabel(raw);
    if ('error' in c) return { error: c.error, status: 400 };
    cleaned.push(c.label);
  }
  try {
    const labels = withLabels(run.meta?.labels, cleaned, list(remove));
    store.updateRunMeta(run.runId, { labels });
    return { labels };
  } catch (err) {
    return { error: messageOf(err), status: 400 };
  }
}

/** Adds a note to a run or one of its calls: the call's (or run's) notes now. */
export function addNote(store: StoreOf<'recording'>, idOrPrefix: string, callNo: unknown, text: unknown): { notes: RunNote[] } | { error: string; status: number } {
  const run = lookupRun(store, idOrPrefix);
  if (!run) return { error: `no run ${idOrPrefix}`, status: 404 };
  const n = typeof callNo === 'number' && Number.isInteger(callNo) ? callNo : null;
  if (n !== null && !store.getCalls(run.runId, { only: [n] }).length) return { error: `no call #${n} in run ${run.runId}`, status: 404 };
  if (typeof text !== 'string') return { error: 'text is required', status: 400 };
  try {
    const notes = withNote(run.meta?.notes, { callNo: n, text, at: Date.now() });
    store.updateRunMeta(run.runId, { notes });
    return { notes: notes.filter((x) => x.callNo === n) };
  } catch (err) {
    return { error: messageOf(err), status: 400 };
  }
}

export interface LineageNode {
  runId: string;
  parentRunId: string | null;
  depth: number;
  mode: RunRecord['mode'];
  /** As the lists have it (runs-list.ts `runState`): a run its recorder left running reads `crashed`. */
  status: RunRecord['status'];
  label: string;
  divergence: { callNo: number; type: string } | null;
  calls: number;
  spent: number;
  saved: number;
  startedAt: number;
  repeat: { group: string; attempt: number; of: number } | null;
  checks: { passed: number; total: number } | null;
  /**
   * One character per call, as the run list encodes them (r replayed, l live, o overridden, i
   * injected, f failed, b blocked, s stubbed): an attempt the list leaves out says what it did too.
   */
  origins: string;
  /**
   * A replay made by `shadowlap test`: its golden and session, and which of the golden's attempts in
   * the session it is. For a golden replayed more than once in the session, `gate` is what its gate
   * made of those attempts, as Tests says it: the verdict word, the tally and the Wilson bound, and
   * the rule, stated once; null when the golden has no gate, or it decided nothing.
   */
  test: { golden: string; session: string; attempt: number | null; gate?: { verdict: string; rule: string | null } | null } | null;
  /** What the run was about (run-about.ts): under a parent, what it changed. */
  about: RunAbout | null;
  /** How the run stands as the run list says it: its kind, how it came out, and whether that failed. */
  kind?: RunKind;
  outcome?: RunOutcome;
  failed?: boolean;
  /**
   * An error-path preset's attempt: the preset and how it came out by the preset's verdict, from the
   * session that decided it (chaos.ts `presetMarks`), since the run alone reads as a healthy fork.
   */
  preset?: PresetMark;
}

/**
 * Every run in the family of a run: its root recording and all that descends from it, depth first,
 * oldest first, each standing as the run list says (an attempt or fork its recorder left is
 * interrupted here as there), a preset's attempt with its preset's verdict.
 */
export function lineage(store: Store, idOrPrefix: string, options: ReadOptions = {}): LineageNode[] | null {
  const run = lookupRun(store, idOrPrefix);
  if (!run) return null;
  let root = run;
  const seen = new Set<string>();
  while (root.parentRunId && !seen.has(root.runId)) {
    seen.add(root.runId);
    const parent = store.getRun(root.parentRunId);
    if (!parent) break;
    root = parent;
  }
  const modelOf = modelResolver(store);
  const stateOf = runStates(store);
  // Each golden's gate in a session, read once however many of its attempts the family holds.
  const gates = new Map<string, { verdict: string; rule: string | null } | null>();
  const sessionGateOf = (t: NonNullable<LineageNode['test']>) => {
    const key = `${t.session}\n${t.golden}`;
    if (!gates.has(key)) gates.set(key, sessionGate(store, t.session, t.golden));
    return gates.get(key)!;
  };
  const index = loadRunIndex(store);
  const out: LineageNode[] = [];
  const attempts: RunRecord[] = [];
  const walk = (r: RunRecord, depth: number) => {
    if (out.length >= 1000) return;
    if (r.meta?.chaos) attempts.push(r);
    // The run asked about is the page's own: its calls as the page last read them (run-calls.ts),
    // so its Forks view, asked again as runs move, doesn't read a long run again.
    const calls = r.runId === run.runId ? runCalls(store, r.runId) : store.getCalls(r.runId);
    const s = summarizeRun(r, calls as CallRecord[], [], [], { modelOf, ...(options.prices ? { prices: options.prices } : {}) });
    const state = stateOf(r.runId);
    out.push({
      runId: r.runId,
      parentRunId: r.parentRunId,
      depth,
      mode: r.mode,
      status: state?.status ?? r.status,
      ...(state ? { kind: state.kind, outcome: state.outcome, failed: state.failed } : {}),
      label: runLabel(r, kindFacts(store, r, calls.length)),
      divergence: r.divergence ? { callNo: r.divergence.callNo, type: r.divergence.type } : null,
      calls: calls.length,
      spent: s.cost.spent,
      saved: s.cost.saved,
      startedAt: r.startedAt,
      repeat: r.meta?.repeat ?? null,
      checks: checksOf(r),
      origins: calls.map((c) => ORIGIN_CODE[displayOrigin(c.origin, c.end ? { outcome: c.end.outcome, injected: c.end.meta.injected } : null)]).join(''),
      test: withGate(testOf(r), sessionGateOf),
      about: null,
    });
    for (const child of store.childRuns(r.runId).sort((a, b) => a.startedAt - b.startedAt)) walk(child, depth + 1);
  };
  walk(root, 0);
  // Every node's about line at once: a recording's first request is read once, and kept.
  const abouts = aboutsOf(store, index, out.map((n) => index.byId.get(n.runId)).filter((r) => r !== undefined));
  for (const n of out) n.about = abouts.get(n.runId) ?? null;
  // Each preset's attempt by the session that decided it, an earlier session's as much as the newest's.
  const marks = attempts.length ? presetMarks(store, attempts) : null;
  for (const n of out) {
    const mark = marks?.get(n.runId);
    if (mark) n.preset = mark;
  }
  return out;
}

/** A golden's attempt in a test session that replayed it more than once, with its gate's verdict on them; any other test as it is. */
function withGate(t: LineageNode['test'], gateFor: (t: NonNullable<LineageNode['test']>) => { verdict: string; rule: string | null } | null): LineageNode['test'] {
  return t && t.attempt !== null ? { ...t, gate: gateFor(t) } : t;
}

/**
 * What a golden's gate made of its attempts in one test session, as Tests says it: the
 * verdict word, the tally and the Wilson bound, and the rule apart, to be stated once. A clean
 * replay's one attempt settles it, with no rule to state. Null when the golden has no gate, the gate
 * decided nothing (stopped by a check it couldn't judge, or by a signal), or what was kept can't be read.
 */
function sessionGate(store: StoreOf<'tests'>, session: string, golden: string): { verdict: string; rule: string | null } | null {
  try {
    const g = store.listTestResults({ sessionId: session, golden, limit: 1 })[0]?.data?.gate;
    if (!g || g.decision === 'continue') return null;
    return g.clean ? { verdict: `${verdictLine(g)}, so its one attempt settles it`, rule: null } : { verdict: verdictLine(g), rule: `gate: ${describeGate(gateOf(g))}` };
  } catch {
    return null;
  }
}

/** A test replay's golden, session and attempt, as its record keeps them; checked, since a run can come from someone else's pack. */
function testOf(r: RunRecord): LineageNode['test'] {
  const t: unknown = r.meta?.test;
  if (typeof t !== 'object' || t === null) return null;
  const { golden, session, attempt } = t as Record<string, unknown>;
  if (typeof golden !== 'string' || typeof session !== 'string') return null;
  return { golden, session, attempt: Number.isInteger(attempt) ? (attempt as number) : null };
}

export function compare(store: StoreOf<'recording'>, a: string, b: string): RunComparison | null {
  const ra = lookupRun(store, a);
  const rb = lookupRun(store, b);
  if (!ra || !rb) return null;
  return compareRuns(store, ra, store.getCalls(ra.runId), rb, store.getCalls(rb.runId));
}

// The rest of the API's shapes (jobs, meta, activity, changes, uploads), for the browser code.
export type { ActivityIcon, ActivityItem, ActivityPage, ChangesView, JobFile, JobLink, JobListItem, JobView, LiveRun, MetaView, ProjectView, UploadView } from './views.js';
