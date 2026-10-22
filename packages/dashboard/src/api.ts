import { checksOf, cleanLabel, describeGate, displayOrigin, gateOf, ORIGIN_CODE, verdictLine, withLabels, withNote, type RunNote, compareRuns, estimateCost, loadApiRequest, shortModel, summarizeRun, type CallRecord, type Price, type RunComparison, type RunKind, type RunOutcome, type RunRecord, type RunSummary, type Store, type ToolTrust, normalizeConversation, normalizeResponse, type Conversation, type NormalizedResponse } from '@shadowlap/engine';
import { actionContext, actionMissing, buildActions, forkMenuTitle, notRun, type ActionContext } from '@shadowlap/tui/actions';
import { kindFacts, modelResolver, runLabel } from '@shadowlap/tui/data';
import { fixForRun, type FixForRun } from './fixes.js';
import { captureSource, loadRunIndex } from './run-index.js';
import { recentRuns, type RunRow } from './runs-list.js';
import { analyseRun, conversationSource, NO_FACTS, ownFacts, runPageFacts, runProvenance, runShowJson, type CallFacts, type ProvenanceOptions, type RunAnalysis, type RunPageFacts, type RunProvenance } from './run-page.js';
import { runCalls } from './run-calls.js';
// How a run stands, as the run list works it out: a run's page and its family read the same state.
import { runState, runStates, type RunState } from './runs-list.js';

export type { CallFacts, MaskCounter, ProvenanceOptions, RunBlame, RunCheck, RunPageFacts, RunProvenance } from './run-page.js';

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
}

export interface RunDetail extends RunPageFacts {
  run: RunRecord;
  label: string;
  /** Set for a run built from a capture, which has no command: where it came from. */
  source: string | null;
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
function row(store: Store, c: CallRecord, options: ReadOptions, facts: CallFacts = NO_FACTS, recording = false): CallRow {
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
  };
}

/**
 * The sidebar's Recent runs (`/api/runs`): the newest runs as a tree, each with its kind, outcome,
 * origins and the attempts bundled under it. Attempts are not rows unless asked for (`recentRuns`).
 */
export function listRuns(store: Store, options: ReadOptions & { includeAttempts?: boolean; ids?: readonly string[] } = {}): RunRow[] {
  return recentRuns(store, options);
}

/** A run by its full id or, as the CLI prints and accepts them, a unique prefix. */
export function lookupRun(store: Store, idOrPrefix: string): RunRecord | null {
  if (!/^[0-9A-Za-z]{1,26}$/.test(idOrPrefix)) return null;
  try {
    return store.findRun(idOrPrefix);
  } catch {
    return null; // ambiguous
  }
}

/**
 * Whether a run id prefix matches several runs and no run whole: `lookupRun` finds none for it, as
 * the CLI refuses it, and the dashboard says so rather than that there is no such run.
 */
export function ambiguousRunId(store: Store, idOrPrefix: string): boolean {
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
export function noSuchRun(store: Store, idOrPrefix: string): { status: number; message: string } {
  const id = idOrPrefix.slice(0, 40);
  return ambiguousRunId(store, idOrPrefix) ? { status: 409, message: `run id prefix ${id} matches several runs: use more of the id` } : { status: 404, message: `no run ${id}` };
}

/** A run's children for its page, each attempt marked as the run lists bundle it. */
function childRows(store: Store, runId: string): RunDetail['children'] {
  const index = loadRunIndex(store);
  return store.childRuns(runId).map((r) => {
    const listed = index.byId.get(r.runId);
    return { runId: r.runId, label: runLabel(r, kindFacts(store, r, store.countCalls(r.runId))), kind: listed?.kind ?? null, startedAt: r.startedAt, ...(listed?.bundled ? { attempt: true as const } : {}) };
  });
}

export function runDetail(store: Store, idOrPrefix: string, options: ReadOptions = {}, part: { after?: number } = {}): RunDetail | null {
  const run = lookupRun(store, idOrPrefix);
  if (!run) return null;
  const after = part.after;
  const runId = run.runId;
  const calls = runCalls(store, runId);
  const state = runState(store, runId);
  // Interrupted as the lists have it: a run its recorder left running is not recording any more,
  // and ended at its last call, as gc would end it.
  const shown = state && state.status !== run.status ? { ...run, status: state.status, endedAt: run.endedAt ?? state.endedAt } : run;
  // Read only: the calls are kept for the run's next look (run-calls.ts).
  const summary = summarizeRun(shown, calls as CallRecord[], [], [], { modelOf: modelResolver(store), ...(options.prices ? { prices: options.prices } : {}) });
  const parent = run.parentRunId ? store.getRun(run.parentRunId) : null;
  const analysis = analyseRun(store, run, calls);
  return {
    run: shown,
    label: runLabel(run, kindFacts(store, run, calls.length)),
    source: captureSource(run),
    summary,
    // A recording's page asks only for the calls after those it has: rows are read for those alone.
    calls: (after === undefined ? calls : calls.filter((c) => c.callNo > after)).map((c) => row(store, c, options, analysis.facts(c.callNo), shown.status === 'running')),
    parent: parent ? { runId: parent.runId, label: runLabel(parent, kindFacts(store, parent, store.countCalls(parent.runId))) } : null,
    children: childRows(store, runId),
    actions: actionsFor(run, undefined),
    ...runPageFacts(store, run, calls),
    fix: fixForRun(store, run.runId),
    state,
    attemptPlace: attemptPlace(store, run),
    ...(after === undefined ? {} : { after }),
  };
}

/**
 * An attempt's place among the attempts made with it, and how many those are (`RunDetail.attemptPlace`):
 * the runs of its parent that share its `repeat.group`, ordered by the attempt each says it is, then
 * by when it started. The fork blame rescued a run with is one of its probe's attempts, though the
 * lists show it as a fork of its own, so every run of the parent is read, not the run index's
 * bundles alone. Null for a run that names no group.
 */
export function attemptPlace(store: Store, run: Pick<RunRecord, 'runId' | 'parentRunId' | 'meta'>): { k: number; n: number } | null {
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
export function showRunJson(store: Store, idOrPrefix: string, options: ReadOptions & { tools?: ToolTrust } = {}): ReturnType<typeof runShowJson> | null {
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

export function callDetail(store: Store, idOrPrefix: string, callNo: number, options: ReadOptions = {}): CallDetail | null {
  const run = lookupRun(store, idOrPrefix);
  if (!run) return null;
  // Read once while the run stays the same: the inspector asks for its calls one by one.
  const calls = runCalls(store, run.runId);
  return callDetailFrom(store, run, calls, analyseRun(store, run, calls), callNo, options);
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
      request = { error: `could not load the stored request: ${err instanceof Error ? err.message : String(err)}` };
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
    prompt: a.prompt
      ? { label: a.prompt.label, ...(a.prompt.placeholder !== undefined ? { placeholder: a.prompt.placeholder } : {}), ...(a.prompt.initial !== undefined ? { initial: a.prompt.initial } : {}), ...(a.prompt.choices ? { choices: a.prompt.choices } : {}) }
      : null,
    disabled: a.disabled ?? null,
    flag: a.flag ?? null,
    group: a.group ?? null,
    hint: a.hint ?? null,
  }));
}

/** The CLI arguments for an action, rebuilt on the server from the run and call: the browser never sends a command line. */
export function actionArgs(store: Store, idOrPrefix: string, callNo: number | null, key: string, value: string | undefined): { args: string[]; opensRun: boolean } | { error: string } {
  const run = lookupRun(store, idOrPrefix);
  if (!run) return { error: `unknown run ${idOrPrefix}` };
  const call = callNo === null ? undefined : store.getCalls(run.runId).find((c) => c.callNo === callNo);
  if (callNo !== null && !call) return { error: `no call #${callNo} in run ${run.runId}` };
  const action = buildActions(run, call, actionContext(store, call)).find((a) => a.key === key);
  if (!action) return { error: actionMissing(run, key) };
  // The menu shows a disabled action greyed out; the server refuses it too, whatever a request says.
  if (action.disabled) return { error: action.disabled };
  if (action.args) return { args: action.args, opensRun: action.opensRun };
  if (!action.prompt) return { error: `action "${key}" has nothing to run` };
  const v = (value ?? '').trim();
  if (!v) return { error: `${action.prompt.label} is required` };
  const args = action.prompt.build(v);
  if (!args.length) return { error: notRun(run) };
  return { args, opensRun: action.opensRun };
}

/** Adds and removes labels on a run: the labels it has now, or why they could not be changed. */
export function changeLabels(store: Store, idOrPrefix: string, add: unknown, remove: unknown): { labels: string[] } | { error: string; status: number } {
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
    return { error: err instanceof Error ? err.message : String(err), status: 400 };
  }
}

/** Adds a note to a run or one of its calls: the call's (or run's) notes now. */
export function addNote(store: Store, idOrPrefix: string, callNo: unknown, text: unknown): { notes: RunNote[] } | { error: string; status: number } {
  const run = lookupRun(store, idOrPrefix);
  if (!run) return { error: `no run ${idOrPrefix}`, status: 404 };
  const n = typeof callNo === 'number' && Number.isInteger(callNo) ? callNo : null;
  if (n !== null && !store.getCalls(run.runId).some((c) => c.callNo === n)) return { error: `no call #${n} in run ${run.runId}`, status: 404 };
  if (typeof text !== 'string') return { error: 'text is required', status: 400 };
  try {
    const notes = withNote(run.meta?.notes, { callNo: n, text, at: Date.now() });
    store.updateRunMeta(run.runId, { notes });
    return { notes: notes.filter((x) => x.callNo === n) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), status: 400 };
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
  /** How the run stands as the run list says it: its kind, how it came out, and whether that failed. */
  kind?: RunKind;
  outcome?: RunOutcome;
  failed?: boolean;
}

/**
 * Every run in the family of a run: its root recording and all that descends from it, depth first,
 * oldest first, each standing as the run list says (an attempt or fork its recorder left is
 * interrupted here as there).
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
  const out: LineageNode[] = [];
  const walk = (r: RunRecord, depth: number) => {
    if (out.length >= 1000) return;
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
    });
    for (const child of store.childRuns(r.runId).sort((a, b) => a.startedAt - b.startedAt)) walk(child, depth + 1);
  };
  walk(root, 0);
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
function sessionGate(store: Store, session: string, golden: string): { verdict: string; rule: string | null } | null {
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

export function compare(store: Store, a: string, b: string): RunComparison | null {
  const ra = lookupRun(store, a);
  const rb = lookupRun(store, b);
  if (!ra || !rb) return null;
  return compareRuns(store, ra, store.getCalls(ra.runId), rb, store.getCalls(rb.runId));
}

// The rest of the API's shapes (jobs, meta, activity, changes, uploads), for the browser code.
export type { ActivityIcon, ActivityItem, ActivityPage, ChangesView, JobFile, JobLink, JobListItem, JobView, LiveRun, MetaView, ProjectView, UploadView } from './views.js';
