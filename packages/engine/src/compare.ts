import { describeBlocks } from './blame.js';
import { canonicalize } from './canonical.js';
import { describeChanges, type RunChanges } from './changes.js';
import { normalizeConversation } from './conversation.js';
import type { Block } from './deltas.js';
import { headerDiff, hintsFor, isHeaderEntry, queryDiff, structuralDiff } from './diff.js';
import { maskGeminiCallIds, queryPairs } from './fingerprint.js';
import { capturedHttp, withoutStoredCredentials, withSecretNames } from './http.js';
import { pathOf } from './repeat.js';
import { finalAnswer, normalizeResponse } from './responses.js';
import { sha256 } from './ids.js';
import { agentCallsOf } from './judge-scope.js';
import { parseJsonExact, reportable } from './json-exact.js';
import { loadApiRequest } from './manifest.js';
import type { Palette } from './report.js';
import { requestPathLabel } from './request-paths.js';
import { plain } from './report.js';
import { oneLine, runInterventions, type InterventionFlag } from './run-facts.js';
import { safeLine, safeText } from './text.js';
import type { StoreOf } from './store.js';
import type { CallKind, CallRecord, DiffEntry, Hint, RunRecord } from './types.js';
import { isObject } from './is-object.js';

/**
 * Two runs side by side, call by call: where their requests first differ, and where identical
 * requests got different answers (a live re-run's model output, a tool that returned something
 * else). Calls are aligned by position, so the comparison is sharpest for runs of the same agent.
 */
export interface CallDifference {
  callNo: number;
  kind: CallKind;
  name: string;
  /**
   * For a request difference: the structural diff of the two requests and normalizer hints. Each
   * entry also says what its path points at (`tool_result lookup_policy`), when the request names it.
   */
  diff?: Array<DiffEntry & { what?: string }>;
  hints?: Hint[];
  /** For a response difference: a one-line description. */
  detail?: string;
  /**
   * For a model call's response difference: the model answered the same (its text, tool calls and
   * thinking, and how it stopped), and only what each response carries anew differs (its id, token
   * counts). Two live runs of one agent get new responses every call, so the call isn't identical,
   * but nothing the model said changed.
   */
  sameAnswer?: true;
  /**
   * For the call the replay's flag answered (`intervention`): the flag. Its detail then says what
   * the call got instead of what it recorded, as the comparison leads with it.
   */
  by?: string;
}

export interface RunComparison {
  a: { runId: string; calls: number };
  b: { runId: string; calls: number };
  /** Leading calls with the same request and the same response. */
  identicalPrefix: number;
  /**
   * Those calls, so a reader can check the claim rather than take it. Capped: a long run's prefix is
   * evidence, not a transcript, and `identicalPrefix` still counts them all.
   */
  prefix: PairedCall[];
  firstRequestDifference: CallDifference | null;
  /** Before the first request difference: calls whose request was the same but whose response was not. */
  responseDifferences: CallDifference[];
  /**
   * From the first request difference on, calls are no longer paired: after a fork the runs take their
   * own paths, and pairing call 20 with call 20 would compare unrelated calls. Each run's course instead.
   */
  after: { a: RunCourse; b: RunCourse } | null;
  /** Runs that never differed in a request: calls beyond the other's end. */
  onlyInA: number;
  onlyInB: number;
  /** What differs between the runs as a whole: prompts, tool definitions, models and code version. */
  changes: RunChanges;
  /**
   * What made the fork, when one run is the other's replay and its flag changed an answer rather
   * than a request: no card above says it, so the comparison leads with it. Null otherwise.
   */
  intervention: ComparedIntervention | null;
}

/**
 * The flag that made one run of a pair from the other, when it changed what a call answered: a
 * failure injected in place of an answer (`--fail-at`), a tool's result or a person's answer given
 * instead of the recorded one (`--override`), an instruction planted in a tool's result
 * (`--inject-result`), or a model call asked again (`--diverge-at`). Said with what each run got
 * at that call: `#19 got HTTP 529 instead of an answer`.
 */
export interface ComparedIntervention {
  /** The run the flag made: `b`, a replay of `a`, or `a` when the pair is the other way round. */
  run: 'a' | 'b';
  kind: 'fail' | 'override' | 'answer' | 'plant' | 'resample';
  /** The flag as the run keeps it: `--fail-at 19=529`, `--override 16=@policy.json`. */
  flag: string;
  callNo: number;
  /** The call it acted on: `POST /v1/messages`, `lookup_policy`. */
  name: string;
  /** What the run it was made from got at that call, and what it got, each in a line (`an answer`, `HTTP 529`); null where a model was asked again. */
  before: string | null;
  after: string | null;
  /** Both, as a sentence: `#19 got HTTP 529 instead of an answer`, `#16 lookup_policy returned … instead of …`. */
  words: string;
}

/** A call that paired cleanly: same request, same answer, in both runs. */
export interface PairedCall {
  callNo: number;
  kind: string;
  name: string;
}

/** What a run did from a point on. */
export interface RunCourse {
  calls: number;
  modelCalls: number;
  /** Tool calls in order, with what happened to each when it was not plain live (sorted within a model turn). */
  path: string[];
  /** The text of its last model response. */
  answer: string | null;
}

interface RunShape {
  systems: Set<string>;
  tools: Map<string, string>;
  models: Set<string>;
}

/** Tool definitions by name, in each provider's shape: Anthropic, OpenAI Chat and Responses, Gemini, Bedrock Converse. */
export function toolDefinitions(body: Record<string, unknown>): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const add = (name: unknown, def: unknown) => {
    if (typeof name === 'string') out.set(name, def);
  };
  const list = Array.isArray(body.tools) ? body.tools : isObject(body.toolConfig) && Array.isArray(body.toolConfig.tools) ? body.toolConfig.tools : [];
  for (const t of list) {
    if (!isObject(t)) continue;
    if (Array.isArray(t.functionDeclarations)) for (const f of t.functionDeclarations) add(isObject(f) ? f.name : undefined, f);
    else if (isObject(t.function)) add(t.function.name, t.function);
    else if (isObject(t.toolSpec)) add(t.toolSpec.name, t.toolSpec);
    else add(t.name, t);
  }
  return out;
}

/** The prompts, tool definitions and models a run's model calls used. */
function shapeOf(store: StoreOf<'recording'>, calls: CallRecord[]): RunShape {
  const shape: RunShape = { systems: new Set(), tools: new Map(), models: new Set() };
  for (const c of calls) {
    if (c.kind !== 'api' || !c.requestRef) continue;
    try {
      const body = loadApiRequest(store, c.requestRef) as Record<string, unknown>;
      const conv = normalizeConversation(body);
      if (!conv) continue;
      // The system prompt is the instructions a conversation starts with; a system message added later
      // (an injected instruction) is part of the conversation, and the call diff shows it.
      const firstOther = conv.turns.findIndex((t) => t.role !== 'system');
      const leading = firstOther === -1 ? conv.turns : conv.turns.slice(0, firstOther);
      const system = leading.map((t) => canonicalize(t.blocks)).join('\n');
      if (system) shape.systems.add(sha256(system));
      const model = c.end?.meta.model ?? conv.model;
      if (model) shape.models.add(model);
      for (const [name, def] of toolDefinitions(body)) shape.tools.set(name, sha256(canonicalize(def)));
    } catch {
      // an unreadable request tells nothing
    }
  }
  return shape;
}

export function runChanges(store: StoreOf<'recording'>, a: RunRecord, aCalls: CallRecord[], b: RunRecord, bCalls: CallRecord[]): RunChanges {
  // What the agent sends: a judge check's model and prompt are none of it.
  const x = shapeOf(store, agentCallsOf(aCalls));
  const y = shapeOf(store, agentCallsOf(bCalls));
  const same = (p: Set<string>, q: Set<string>) => p.size === q.size && [...p].every((v) => q.has(v));
  return {
    systemPrompt: !same(x.systems, y.systems),
    systems: { a: [...x.systems].sort(), b: [...y.systems].sort() },
    tools: {
      added: [...y.tools.keys()].filter((t) => !x.tools.has(t)).sort(),
      removed: [...x.tools.keys()].filter((t) => !y.tools.has(t)).sort(),
      redefined: [...x.tools].some(([name, hash]) => y.tools.has(name) && y.tools.get(name) !== hash),
    },
    models: { a: [...x.models].sort(), b: [...y.models].sort() },
    code: { a: a.codeVersion, b: b.codeVersion },
  };
}

/**
 * A call's request as Compare reads it, as a divergence report shows it (reportable): each number as
 * it was sent, an integer past 2^53 by its digits, so two ids a double rounds alike show as the change
 * they are. A model call of a run made before requests kept their numbers (`rounded`,
 * RunMeta.exactNumbers) has every number read as the double it was stored as, on both sides, as
 * matching reads it; a captured call of a run made before a secret's name was kept (`secretNames`
 * false, RunMeta.secretNames) has every such name masked, on both sides, as a replay of it matches.
 * A Gemini conversation's made-up call ids are numbered as matching numbers them (maskGeminiCallIds).
 */
function request(store: StoreOf<'recording'>, c: CallRecord, rounded: boolean, secretNames: boolean): unknown {
  if (!c.requestRef) return null;
  if (c.kind === 'api') return maskGeminiCallIds(reportable(loadApiRequest(store, c.requestRef, { exact: !rounded })));
  const bytes = store.getBlob(c.requestRef);
  const req = bytes === null ? null : reportable(parseJsonExact(bytes.toString('utf8')));
  return !secretNames && capturedHttp(c) && isObject(req) ? { ...req, args: withSecretNames(false, () => withoutStoredCredentials(req.args)) } : req;
}

/** A model call's answer as the provider's response says it, or null when it can't be read (an error, nothing stored). */
function answerOf(store: StoreOf<'recording'>, c: CallRecord): { blocks: Block[]; stop: string | null } | null {
  const ref = c.end?.responseRef;
  if (!ref || c.end?.outcome !== 'ok') return null;
  try {
    const provider = c.end.meta.provider ?? c.meta.provider;
    const r = normalizeResponse(store.getBlob(ref), c.end.meta.headers?.['content-type'], c.end.meta.chunks ?? [], typeof provider === 'string' ? provider : undefined);
    return r.blocks.length ? { blocks: r.blocks, stop: r.stopReason } : null;
  } catch {
    return null;
  }
}

/** What an answer says (its text, tool calls and thinking), without what each response carries anew: ids, token counts. */
function saidIn(blocks: readonly Block[], thinking: boolean): string {
  return canonicalize(blocks.flatMap((b): unknown[] => (b.type === 'tool_call' ? [{ c: b.name, i: b.input ?? {} }] : b.type === 'text' || thinking ? [{ [b.type]: b.text.trim().replace(/\s+/g, ' ') }] : [])));
}

/** How long each answer is shown in the detail. */
const ANSWER_SHOWN = 90;

/** A response difference: what it says, and for a model call whether the model answered the same. */
function responseDifference(store: StoreOf<'recording'>, x: CallRecord, y: CallRecord): { detail: string; sameAnswer?: true } {
  if (x.kind === 'api') {
    const parts: string[] = [];
    // What the model answered each time, as the pairs in Training show answers. A response is new
    // bytes on every live call (its id, its token counts), so the same answer can come back as another
    // response: that is said, rather than counted as bytes.
    const ax = answerOf(store, x);
    const ay = answerOf(store, y);
    let same = false;
    if (ax && ay) {
      const shown = (a: { blocks: Block[] }) => a.blocks.filter((b) => b.type !== 'thinking');
      if (saidIn(ax.blocks, false) !== saidIn(ay.blocks, false)) {
        const dx = describeBlocks(shown(ax), ANSWER_SHOWN);
        const dy = describeBlocks(shown(ay), ANSWER_SHOWN);
        parts.push(dx !== dy ? `${dx} → ${dy}` : `${dx} → an answer that starts the same and goes on differently`);
      } else if (saidIn(ax.blocks, true) !== saidIn(ay.blocks, true)) parts.push('the same answer, after other thinking');
      else if (ax.stop !== ay.stop) parts.push('the same words and tool calls');
      else {
        same = true;
        parts.push('the same answer (its id or token counts differ)');
      }
      if (ax.stop !== ay.stop) parts.push(`stop ${ax.stop ?? '?'} → ${ay.stop ?? '?'}`);
    } else {
      const bx = x.end?.meta.bytes ?? store.getBlob(x.end?.responseRef ?? '')?.length ?? 0;
      const by = y.end?.meta.bytes ?? store.getBlob(y.end?.responseRef ?? '')?.length ?? 0;
      parts.push(`${bx} → ${by} bytes`);
      if (x.end?.meta.stopReason !== y.end?.meta.stopReason) parts.push(`stop ${x.end?.meta.stopReason ?? '?'} → ${y.end?.meta.stopReason ?? '?'}`);
      const ox = x.end?.meta.usage?.outputTokens;
      const oy = y.end?.meta.usage?.outputTokens;
      if (ox !== undefined && oy !== undefined && ox !== oy) parts.push(`${ox} → ${oy} output tokens`);
    }
    if (x.end?.outcome !== y.end?.outcome) parts.push(`${x.end?.outcome ?? 'pending'} → ${y.end?.outcome ?? 'pending'}`);
    return { detail: parts.join(', '), ...(same ? { sameAnswer: true as const } : {}) };
  }
  const rx = x.end?.responseRef ? store.getJson(x.end.responseRef) : null;
  const ry = y.end?.responseRef ? store.getJson(y.end.responseRef) : null;
  const d = structuralDiff(rx, ry);
  return { detail: d.length ? `${d.length} difference${d.length === 1 ? '' : 's'}, first at ${d[0]!.path}` : 'different bytes, same value' };
}

/**
 * A request diff's entries, each with what its path points at: in a model request, as the request
 * names it (`tool_result lookup_policy`), found in the request that has it (a removal: the first's);
 * in a tool's input, the tool and the field (`issue_refund · amount`).
 */
function labelled(diff: DiffEntry[], call: CallRecord, a: unknown, b: unknown): Array<DiffEntry & { what?: string }> {
  return diff.map((e) => {
    const field = e.path.replace(/^\$\.?/, '');
    const what = call.kind === 'api' ? requestPathLabel(e.op === 'removed' ? a : b, e.path) : call.kind === 'tool' ? (field ? `${call.name} · ${field}` : call.name) : null;
    return what ? { ...e, what } : e;
  });
}

function courseOf(store: StoreOf<'recording'>, calls: CallRecord[], from: number): RunCourse {
  const rest = calls.slice(from);
  return { calls: rest.length, modelCalls: rest.filter((c) => c.kind === 'api').length, path: pathOf(rest, null), answer: finalAnswer(store, rest) || null };
}

/** The flags that change what a call answered rather than what was asked, and so show in no request. */
const ANSWERING_FLAGS = new Set(['--fail-at', '--override', '--inject-result', '--diverge-at']);

/** How much of each value the comparison quotes. */
const VALUE_SHOWN = 80;

/** A tool call's result as it came back, as JSON in a line (a string in quotes); null when nothing was stored. */
function resultLine(store: StoreOf<'recording'>, c: CallRecord): string | null {
  if (!c.end?.responseRef) return null;
  try {
    const payload = store.getJson<{ result?: unknown }>(c.end.responseRef);
    return payload && 'result' in payload ? oneLine(JSON.stringify(payload.result) ?? 'null', VALUE_SHOWN) : null;
  } catch {
    return null;
  }
}

/** What a person typed, as a `user_input` call's result keeps it (`{ text }`); null when it can't be read. */
function inputText(store: StoreOf<'recording'>, c: CallRecord): string | null {
  if (!c.end?.responseRef) return null;
  try {
    const r = store.getJson<{ result?: unknown }>(c.end.responseRef)?.result;
    return typeof r === 'object' && r !== null && typeof (r as { text?: unknown }).text === 'string' ? oneLine((r as { text: string }).text, VALUE_SHOWN) : null;
  } catch {
    return null;
  }
}

/** A failure `--fail-at` gives a tool, in words: `a timeout`, `an error`, `HTTP 503`. */
function toolFailure(what: string): string {
  if (/^timeout$/i.test(what)) return 'a timeout';
  if (/^\d{3}$/.test(what)) return `HTTP ${what}`;
  return 'an error';
}

const quoted = (s: string | null) => (s === null ? 'nothing' : JSON.stringify(s));

/** What the call got, as its row of response differences says it, beside its number and name: `got HTTP 529 instead of an answer`. */
function whatItGot(iv: ComparedIntervention): string {
  const said = iv.words.replace(/^#\d+ /, '');
  return said.startsWith(`${iv.name} `) ? said.slice(iv.name.length + 1) : said;
}

/**
 * What made `child` from `parent`, when its flag changed what a call answered, with what each got
 * there. Null when no such flag made it, and when the replay left its recording before that call
 * (a request changed first), so the call no longer pairs with the recording's.
 */
function interventionOf(store: StoreOf<'recording'>, side: 'a' | 'b', parent: CallRecord[], child: RunRecord, childCalls: CallRecord[], answers: readonly CallDifference[]): ComparedIntervention | null {
  if (child.mode !== 'replay') return null;
  const iv: InterventionFlag | undefined = runInterventions(store, child, childCalls).find((f) => ANSWERING_FLAGS.has(f.flag) && f.callNo !== null);
  if (!iv || iv.callNo === null) return null;
  const n = iv.callNo;
  if (child.divergence && child.divergence.callNo < n) return null;
  const was = parent.find((c) => c.callNo === n);
  const now = childCalls.find((c) => c.callNo === n);
  if (!was || !now || was.kind !== now.kind || was.name !== now.name) return null;
  // A failure, an override or a plant that left the call answered as recorded changed nothing there.
  if (iv.flag !== '--diverge-at' && was.end?.responseRef && was.end.responseRef === now.end?.responseRef && was.end.outcome === now.end.outcome) return null;
  const flag = iv.value ? `${iv.flag} ${iv.value}` : iv.flag;
  const value = (iv.value ?? '').replace(/^\d+[=:]/, '');
  const base = { run: side, flag, callNo: n, name: now.name };
  switch (iv.flag) {
    case '--fail-at': {
      if (now.kind === 'api') {
        const status = typeof now.end?.meta.status === 'number' ? now.end.meta.status : /^\d{3}$/.test(value) ? Number(value) : null;
        const after = status !== null ? `HTTP ${status}` : 'a failure';
        const before = was.end?.outcome === 'ok' ? 'an answer' : 'its recorded failure';
        return { ...base, kind: 'fail', before, after, words: `#${n} got ${after} instead of ${before}` };
      }
      const before = resultLine(store, was);
      const after = toolFailure(value);
      return { ...base, kind: 'fail', before, after, words: `#${n} ${now.name} got ${after} instead of ${before ?? 'its result'}` };
    }
    case '--override': {
      if (now.kind === 'tool' && now.meta.input === true) {
        const before = inputText(store, was);
        const after = inputText(store, now);
        return { ...base, kind: 'answer', before, after, words: `#${n} the user answered ${quoted(after)} instead of ${quoted(before)}` };
      }
      const before = resultLine(store, was);
      const after = resultLine(store, now);
      return { ...base, kind: 'override', before, after, words: `#${n} ${now.name} returned ${after ?? 'nothing'} instead of ${before ?? 'nothing'}` };
    }
    case '--inject-result': {
      const before = resultLine(store, was);
      return { ...base, kind: 'plant', before, after: value, words: `#${n} ${now.name} returned ${before ?? 'its result'} with ${quoted(value)} planted in it` };
    }
    default: {
      // Asked again with the request as recorded: how it answered is the response difference's to show.
      const answered = answers.find((r) => r.callNo === n);
      return { ...base, kind: 'resample', before: null, after: null, words: `#${n} was asked again and answered ${answered && !answered.sameAnswer ? 'differently' : 'the same'}` };
    }
  }
}

export function compareRuns(store: StoreOf<'recording'>, a: RunRecord, allA: CallRecord[], b: RunRecord, allB: CallRecord[]): RunComparison {
  // The agents' calls: a run whose judge was asked differs in no call of the agent's.
  const aCalls = agentCallsOf(allA);
  const bCalls = agentCallsOf(allB);
  const n = Math.min(aCalls.length, bCalls.length);
  let identicalPrefix = 0;
  let prefixIntact = true;
  let firstRequestDifference: CallDifference | null = null;
  let after: RunComparison['after'] = null;
  const responseDifferences: CallDifference[] = [];
  const prefix: PairedCall[] = [];
  const PREFIX_CAP = 500;
  for (let i = 0; i < n; i++) {
    const x = aCalls[i]!;
    const y = bCalls[i]!;
    const diff = requestDifference(store, a, x, b, y);
    if (diff) {
      const hints = diff.flatMap((e) => (isHeaderEntry(e) ? [] : hintsFor(e, y.kind, y.name))).slice(0, 3);
      firstRequestDifference = { callNo: y.callNo, kind: y.kind, name: y.name, diff, ...(hints.length ? { hints } : {}) };
      after = { a: courseOf(store, aCalls, i), b: courseOf(store, bCalls, i) };
      break;
    }
    const rx = x.end?.responseRef ?? null;
    const ry = y.end?.responseRef ?? null;
    const sameResponse = rx === ry && x.end?.outcome === y.end?.outcome;
    if (sameResponse) {
      if (prefixIntact) {
        identicalPrefix++;
        if (prefix.length < PREFIX_CAP) prefix.push({ callNo: y.callNo, kind: y.kind, name: y.name });
      }
    } else {
      prefixIntact = false;
      responseDifferences.push({ callNo: y.callNo, kind: y.kind, name: y.name, ...responseDifference(store, x, y) });
    }
  }
  // A replay of the other run: the flag that made it, when it changed an answer, which no request shows.
  const intervention = b.parentRunId === a.runId ? interventionOf(store, 'b', allA, b, allB, responseDifferences) : a.parentRunId === b.runId ? interventionOf(store, 'a', allB, a, allA, responseDifferences) : null;
  // The call it answered got something else because of the flag: its difference says by which flag,
  // and what it got instead (a model asked again: how it answered each time, as any answer does).
  const answers = intervention
    ? responseDifferences.map((r) => (r.callNo !== intervention.callNo ? r : intervention.kind === 'resample' ? { ...r, by: intervention.flag } : { ...r, detail: whatItGot(intervention), by: intervention.flag }))
    : responseDifferences;
  return {
    a: { runId: a.runId, calls: aCalls.length },
    b: { runId: b.runId, calls: bCalls.length },
    identicalPrefix,
    prefix,
    firstRequestDifference,
    responseDifferences: answers,
    after,
    onlyInA: after ? 0 : Math.max(0, aCalls.length - n),
    onlyInB: after ? 0 : Math.max(0, bCalls.length - n),
    changes: runChanges(store, a, aCalls, b, bCalls),
    intervention,
  };
}

/**
 * How `y`, run `b`'s call, asks other than `x`, run `a`'s call at the same place; null when it makes
 * the same request. A replay keeps the recorded call it served each call from (`replayedFrom`, or
 * `overriddenFrom` for a result a flag changed): that call's request is the same. Two calls whose
 * stored fingerprints are equal make it too. Fingerprints alone can't tell the rest, since two runs'
 * are alike only when both made them the same way (one fingerprint version, the same normalizers,
 * dates masked against each run's own start): calls whose fingerprints differ are compared by what
 * each sent, its kind and name, its fingerprint headers, query and body, and are the same request
 * when nothing of that differs.
 */
function requestDifference(store: StoreOf<'recording'>, a: RunRecord, x: CallRecord, b: RunRecord, y: CallRecord): Array<DiffEntry & { what?: string }> | null {
  if (x.kind !== y.kind || x.name !== y.name) return [{ path: '$', op: 'changed', before: `${x.kind} ${x.name}`, after: `${y.kind} ${y.name}`, what: 'call' }];
  if (x.fingerprint === y.fingerprint || servedFrom(b, y, a, x) || servedFrom(a, x, b, y)) return null;
  const rounded = a.meta?.exactNumbers !== true || b.meta?.exactNumbers !== true;
  const secretNames = a.meta?.secretNames === true && b.meta?.secretNames === true;
  const qx = request(store, x, rounded, secretNames);
  const qy = request(store, y, rounded, secretNames);
  const diff = [
    ...(x.kind === 'api' ? headerDiff(identityHeaders(x), identityHeaders(y)) : []),
    ...(x.kind === 'api' ? queryDiff(queryPairs(storedQuery(x)), queryPairs(storedQuery(y))) : []),
    ...labelled(structuralDiff(qx, qy), y, qx, qy),
  ];
  return diff.length ? diff : null;
}

/** Whether `c`, a call of `child`, was served from `p`, the call of `parent` it replays. */
function servedFrom(child: RunRecord, c: CallRecord, parent: RunRecord, p: CallRecord): boolean {
  if (child.parentRunId !== parent.runId) return false;
  const meta = c.end?.meta;
  return meta?.replayedFrom === p.callNo || meta?.overriddenFrom === p.callNo;
}

/** A model call's query as it kept it; none when it kept none. */
function storedQuery(c: CallRecord): string | undefined {
  return typeof c.meta.query === 'string' ? c.meta.query : undefined;
}

/**
 * A model call's fingerprint headers as they make it the call it is: `anthropic-beta` without the
 * betas that only say how it signed in (`oauth-…`), as the recording format's identity reads them.
 */
function identityHeaders(c: CallRecord): Record<string, string> {
  const headers = { ...((c.meta.fingerprintHeaders as Record<string, string> | undefined) ?? {}) };
  const beta = headers['anthropic-beta'];
  if (beta === undefined) return headers;
  const kept = beta.split(',').map((b) => b.trim()).filter((b) => b && !/^oauth-/i.test(b));
  if (kept.length) headers['anthropic-beta'] = kept.join(',');
  else delete headers['anthropic-beta'];
  return headers;
}

/** Whether two runs differ at all: a request, a response, or length. */
export function runsDiffer(c: RunComparison): boolean {
  return !!c.firstRequestDifference || c.responseDifferences.length > 0 || c.onlyInA > 0 || c.onlyInB > 0;
}

function short(id: string): string {
  return id.slice(0, 10);
}

function fmtValue(v: unknown): string {
  const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  return s.length > 160 ? s.slice(0, 159) + '…' : s;
}

export function formatComparison(c: RunComparison, p: Palette = plain): string {
  const lines: string[] = [];
  lines.push(`${p.bold(short(c.a.runId))} (${c.a.calls} calls) vs ${p.bold(short(c.b.runId))} (${c.b.calls} calls)`);
  const changed = describeChanges(c.changes);
  lines.push(changed.length ? `  ${p.yellow('Δ')} ${safeLine(changed.join(' · '))}` : p.dim('  same system prompt, tools, models and code'));
  if (!runsDiffer(c)) {
    lines.push(`  ${p.green('=')} identical: every request and every response`);
    return lines.join('\n');
  }
  if (c.identicalPrefix) lines.push(`  ${p.green('=')} calls 1–${c.identicalPrefix}: same requests, same responses`);
  // What made the fork, when no request shows it: the flag that changed an answer, with both answers, as Compare leads with it.
  const iv = c.intervention;
  if (iv) lines.push(`  ${p.yellow('⑂')} ${safeLine(iv.words)}${iv.run === 'a' ? ` in ${short(c.a.runId)}` : ''}, by ${safeLine(iv.flag)}`);
  // A model that answered the same way in a new response (its own id, its token counts) is said apart, as the dashboard says it.
  const changedAnswers = c.responseDifferences.filter((r) => !r.sameAnswer);
  const again = c.responseDifferences.length - changedAnswers.length;
  if (again) lines.push(`  ${p.green('=')} ${again} call${again === 1 ? '' : 's'} with the same request got the same answer in ${again === 1 ? 'a new response' : 'new responses'} (only ids or token counts differ)`);
  if (changedAnswers.length) {
    lines.push(`  ${p.yellow('≠')} ${changedAnswers.length} call${changedAnswers.length === 1 ? '' : 's'} with the same request but a different response:`);
    for (const r of changedAnswers.slice(0, 12)) lines.push(`    #${r.callNo} ${r.kind} ${safeLine(r.name)}: ${safeLine(r.detail ?? '')}${r.by ? p.dim(` (${safeLine(r.by)})`) : ''}`);
    if (changedAnswers.length > 12) lines.push(p.dim(`    … ${changedAnswers.length - 12} more`));
  }
  const f = c.firstRequestDifference;
  if (f && c.after) {
    lines.push(`  ${p.red('~')} call ${f.callNo} (${f.kind} ${safeLine(f.name)}): first request that differs`);
    for (const e of (f.diff ?? []).slice(0, 6)) {
      const mark = e.op === 'added' ? p.green('+') : e.op === 'removed' ? p.red('-') : p.yellow('~');
      lines.push(`    ${mark} ${safeLine(e.path)}`);
      if (e.op !== 'added') lines.push(p.red(`        - ${safeText(fmtValue(e.before))}`));
      if (e.op !== 'removed') lines.push(p.green(`        + ${safeText(fmtValue(e.after))}`));
    }
    if ((f.diff?.length ?? 0) > 6) lines.push(p.dim(`    … ${f.diff!.length - 6} more`));
    for (const h of f.hints ?? []) lines.push(p.dim(`    hint: ${safeLine(h.message)}`));
    const samePath = c.after.a.path.join('\n') === c.after.b.path.join('\n');
    lines.push(`  From there each run goes its own way${samePath ? ', through the same tools' : ''}:`);
    for (const [id, course] of [[c.a.runId, c.after.a], [c.b.runId, c.after.b]] as const) {
      const path = course.path.length ? course.path.map((x) => safeLine(x)).join(' → ') : p.dim('no tool calls');
      lines.push(`    ${p.bold(short(id))}  ${course.calls} calls, ${course.modelCalls} to the model · ${path}`);
      if (course.answer) lines.push(p.dim(`      answer: ${safeLine(course.answer.length > 200 ? `${course.answer.slice(0, 199)}…` : course.answer)}`));
    }
  }
  if (c.onlyInA) lines.push(`  ${p.dim('>')} ${short(c.a.runId)} continues for ${c.onlyInA} more call${c.onlyInA === 1 ? '' : 's'}`);
  if (c.onlyInB) lines.push(`  ${p.dim('>')} ${short(c.b.runId)} continues for ${c.onlyInB} more call${c.onlyInB === 1 ? '' : 's'}`);
  return lines.join('\n');
}
