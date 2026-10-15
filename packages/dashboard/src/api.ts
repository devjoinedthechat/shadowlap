import { basename } from 'node:path';
import { checksOf, cleanLabel, withLabels, withNote, type RunNote, compareRuns, estimateCost, hasRecordedCommand, loadApiRequest, shortModel, summarizeRun, type CallRecord, type Price, type RunComparison, type RunRecord, type RunSummary, type Store, normalizeConversation, normalizeResponse, type Conversation, type NormalizedResponse } from '@shadowlap/engine';
import { buildActions, notRun } from '@shadowlap/tui/actions';
import { kindFacts, modelResolver, runLabel } from '@shadowlap/tui/data';
import { recentRuns, type RunRow } from './runs-list.js';

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

export interface CallRow {
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
}

export interface RunDetail {
  run: RunRecord;
  label: string;
  /** Set for a run built from a capture, which has no command: where it came from. */
  source: string | null;
  summary: RunSummary;
  calls: CallRow[];
  parent: { runId: string; label: string } | null;
  children: Array<{ runId: string; label: string; startedAt: number }>;
  /** Actions that need no selected call: replay, stub writes, add the suggested normalizer, pack. */
  actions: ActionItem[];
}

export interface CallDetail {
  call: CallRow & { fingerprint: string; occurrence: number; startedAt: number; endedAt: number | null; implHash: string | null; headers: Record<string, string>; provider: string | null };
  /** The conversation the model saw at this call (a tool call shows the latest model request before it). */
  conversation: (Conversation & { fromCallNo: number }) | null;
  request: unknown;
  response: NormalizedResponse | null;
  /** Tool calls: the recorded result or error. */
  result: unknown;
  /** Notes people left on this call. */
  notes: RunNote[];
  actions: ActionItem[];
}

export interface ActionItem {
  key: string;
  label: string;
  opensRun: boolean;
  prompt: { label: string; placeholder?: string; initial?: string } | null;
  /** Why the action cannot run on this run, shown in its place; null when it can. */
  disabled: string | null;
}

export interface ReadOptions {
  prices?: Record<string, Price>;
}

const ONE_LINE = 240;

function oneLine(v: unknown): string {
  const s = typeof v === 'string' ? v : (JSON.stringify(v) ?? '');
  return s.length > ONE_LINE ? `${s.slice(0, ONE_LINE - 1)}…` : s;
}

function row(store: Store, c: CallRecord, options: ReadOptions): CallRow {
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
  };
}

/**
 * The sidebar's Recent runs (`/api/runs`): the newest runs as a tree, each with its kind, outcome,
 * origins and the attempts bundled under it. Attempts are not rows unless asked for (`recentRuns`).
 */
export function listRuns(store: Store, options: ReadOptions & { includeAttempts?: boolean; ids?: readonly string[] } = {}): RunRow[] {
  return recentRuns(store, options);
}

/** What a run with no command came from, shown where its command would be: the capture's file name. */
function captureSource(run: RunRecord): string | null {
  return hasRecordedCommand(run) ? null : basename(run.meta?.imported?.from ?? '') || 'a capture';
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

export function runDetail(store: Store, idOrPrefix: string, options: ReadOptions = {}): RunDetail | null {
  const run = lookupRun(store, idOrPrefix);
  if (!run) return null;
  const runId = run.runId;
  const calls = store.getCalls(runId);
  const summary = summarizeRun(run, calls, [], [], { modelOf: modelResolver(store), ...(options.prices ? { prices: options.prices } : {}) });
  const parent = run.parentRunId ? store.getRun(run.parentRunId) : null;
  return {
    run,
    label: runLabel(run, kindFacts(store, run, calls.length)),
    source: captureSource(run),
    summary,
    calls: calls.map((c) => row(store, c, options)),
    parent: parent ? { runId: parent.runId, label: runLabel(parent, kindFacts(store, parent, store.countCalls(parent.runId))) } : null,
    children: store.childRuns(runId).map((r) => ({ runId: r.runId, label: runLabel(r, kindFacts(store, r, store.countCalls(r.runId))), startedAt: r.startedAt })),
    actions: actionsFor(run, undefined),
  };
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
  const calls = store.getCalls(run.runId);
  const index = calls.findIndex((c) => c.callNo === callNo);
  if (index < 0) return null;
  const c = calls[index]!;
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
  // The conversation at this call: its own request for a model call, else the latest model request before it.
  for (let i = index; i >= 0; i--) {
    const prev = calls[i]!;
    if (prev.kind !== 'api' || !prev.requestRef) continue;
    try {
      const body = prev === c ? request : loadApiRequest(store, prev.requestRef);
      const conv = normalizeConversation(body, modelInPath(prev.name));
      if (conv) conversation = { ...conv, fromCallNo: prev.callNo };
    } catch {
      // an unreadable request leaves the conversation empty
    }
    break;
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
      ...row(store, c, options),
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
    actions: actionsFor(run, c),
  };
}

export function actionsFor(run: RunRecord, call: CallRecord | undefined): ActionItem[] {
  return buildActions(run, call).map((a) => ({
    key: a.key,
    label: a.label,
    opensRun: a.opensRun,
    prompt: a.prompt ? { label: a.prompt.label, ...(a.prompt.placeholder !== undefined ? { placeholder: a.prompt.placeholder } : {}), ...(a.prompt.initial !== undefined ? { initial: a.prompt.initial } : {}) } : null,
    disabled: a.disabled ?? null,
  }));
}

/** The CLI arguments for an action, rebuilt on the server from the run and call: the browser never sends a command line. */
export function actionArgs(store: Store, idOrPrefix: string, callNo: number | null, key: string, value: string | undefined): { args: string[]; opensRun: boolean } | { error: string } {
  const run = lookupRun(store, idOrPrefix);
  if (!run) return { error: `unknown run ${idOrPrefix}` };
  const call = callNo === null ? undefined : store.getCalls(run.runId).find((c) => c.callNo === callNo);
  if (callNo !== null && !call) return { error: `no call #${callNo} in run ${run.runId}` };
  const action = buildActions(run, call).find((a) => a.key === key);
  if (!action) return { error: `no action "${key}" here` };
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
  status: RunRecord['status'];
  label: string;
  divergence: { callNo: number; type: string } | null;
  calls: number;
  spent: number;
  saved: number;
  startedAt: number;
  repeat: { group: string; attempt: number; of: number } | null;
  checks: { passed: number; total: number } | null;
}

/** Every run in the family of a run: its root recording and all that descends from it, depth first, oldest first. */
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
  const out: LineageNode[] = [];
  const walk = (r: RunRecord, depth: number) => {
    if (out.length >= 1000) return;
    const calls = store.getCalls(r.runId);
    const s = summarizeRun(r, calls, [], [], { modelOf, ...(options.prices ? { prices: options.prices } : {}) });
    out.push({
      runId: r.runId,
      parentRunId: r.parentRunId,
      depth,
      mode: r.mode,
      status: r.status,
      label: runLabel(r, kindFacts(store, r, calls.length)),
      divergence: r.divergence ? { callNo: r.divergence.callNo, type: r.divergence.type } : null,
      calls: calls.length,
      spent: s.cost.spent,
      saved: s.cost.saved,
      startedAt: r.startedAt,
      repeat: r.meta?.repeat ?? null,
      checks: checksOf(r),
    });
    for (const child of store.childRuns(r.runId).sort((a, b) => a.startedAt - b.startedAt)) walk(child, depth + 1);
  };
  walk(root, 0);
  return out;
}

export function compare(store: Store, a: string, b: string): RunComparison | null {
  const ra = lookupRun(store, a);
  const rb = lookupRun(store, b);
  if (!ra || !rb) return null;
  return compareRuns(store, ra, store.getCalls(ra.runId), rb, store.getCalls(rb.runId));
}
