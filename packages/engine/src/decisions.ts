import { canonicalize } from './canonical.js';
import { maskClock, maskClockText, type ClockReference } from './clock.js';
import { CONTROL_MIN_SAMPLES } from './control-arm.js';
import type { Block } from './deltas.js';
import { applyNormalizers, rewriteText } from './normalize.js';
import { isReservedScope } from './judge-scope.js';
import { aboutUsd, formatUsd } from './prices.js';
import type { Palette } from './report.js';
import { plain } from './report.js';
import { normalizeResponse } from './responses.js';
import { safeLine, safeText } from './text.js';
import type { CallRecord, Effect, Normalizer } from './types.js';
import type { RetirementNotice } from './model-retirements.js';
import { isObject } from './is-object.js';

/**
 * The decision diff (`shadowlap decisions`): each recorded model call asked again with only what a
 * change touches swapped in (the model, a request field, the prompt and tools the code sends now),
 * and the new answer's decision compared with the recorded one. A decision is what the agent does
 * next because of an answer: the tools it calls, in order, with their arguments, and whether it stops
 * or hands over. Ranked by consequence, using the run's effects to tell a write from a read:
 *
 *   1  a write tool added, removed or called with other arguments
 *   2  when the agent stops or hands over, or a judge check reads its words otherwise
 *   3  a read tool added or removed
 *   4  other arguments to a read
 *   5  text only
 *
 * Text only means the same actions in other words. When a judge check of the run reads those words
 * (its final answer, or the run as a whole where the answer ends a conversation), the CLI asks the
 * judge about the recorded words and the new ones, and a check that comes out otherwise raises the
 * step to rank 2 (promoteByJudge): what the agent hands back passes or fails a check the project
 * wrote, as when it stops or hands over differently, but no write changed, and a judge's verdict is a
 * model's reading, which can be wrong.
 *
 * A tool no recording gives an effect ranks as a write: nothing says it doesn't act on the world.
 * Arguments and text are compared after the project's normalizers, so an id or a timestamp made anew
 * is no change. Everything here is a pure function of responses and calls; the CLI sends the
 * requests, and the dashboard reads what it kept.
 */

/** How a model ended its turn, whatever the provider calls it. */
export type DecisionStop = 'tools' | 'answer' | 'limit' | 'refused' | 'paused' | 'other';

export interface DecisionCall {
  name: string;
  /** After the project's normalizers. */
  args: unknown;
  /** What a tool the provider runs or defines itself does, by its kind (hostedToolEffect); left out for the agent's own tools, whose effect the runs say. */
  effect?: Effect;
}

/** What the agent does next because of one model answer. */
export interface ModelDecision {
  stop: DecisionStop;
  /** The provider's stop reason as it said it, or null. */
  stopReason: string | null;
  /** Tool calls in the order the answer lists them. */
  tools: DecisionCall[];
  /** Its text, after the project's normalizers. */
  text: string;
  /** The tool it hands the conversation over with (`transfer_to_billing`), or null. */
  handover: string | null;
}

export type DecisionRank = 1 | 2 | 3 | 4 | 5;

export type DecisionChangeKind = 'write-added' | 'write-removed' | 'write-arguments' | 'write-order' | 'stops' | 'handover' | 'judge' | 'read-added' | 'read-removed' | 'read-arguments' | 'text';

export interface DecisionChange {
  rank: DecisionRank;
  kind: DecisionChangeKind;
  /** The tool it is about, for a tool call's change. */
  tool: string | null;
  /** What the tool does, by the run's effects; `unknown` counts as a write. */
  effect: Effect | 'unknown' | null;
  /** The recorded side and the new one: arguments, a stop, a handover, the order of writes, text, a judge check's status. */
  before: unknown;
  after: unknown;
  /** The change in a few words: `send_email is no longer called`. */
  detail: string;
}

export interface DecisionComparison {
  /** The most consequential change, or null when the decision is the same. */
  rank: DecisionRank | null;
  changes: DecisionChange[];
}

/** What a rank means, as reports and pages say it. */
export const RANK_LABELS: Record<DecisionRank, string> = {
  1: 'a write changed',
  2: 'it stops, hands over or is judged differently',
  3: 'a read added or removed',
  4: 'a read asked differently',
  5: 'text only',
};

/**
 * The line every report carries: a step after the first changed decision is asked in the recorded
 * run's state, which the changed agent may never have reached.
 */
export const JUDGED_IN_RECORDED_STATE = "Later steps are judged in the recorded run's state: after the first changed decision, each step says what the change decides where the recorded run was, not where the changed run would have got to. shadowlap verify runs it end to end.";

/** Stop reasons by provider: Anthropic and Bedrock Converse, OpenAI Chat Completions and Responses, Gemini. */
const STOPS: Record<string, DecisionStop> = {
  // Anthropic Messages (also on Bedrock and Vertex AI), and Bedrock Converse
  tool_use: 'tools',
  end_turn: 'answer',
  stop_sequence: 'answer',
  max_tokens: 'limit',
  model_context_window_exceeded: 'limit',
  refusal: 'refused',
  pause_turn: 'paused',
  guardrail_intervened: 'refused',
  content_filtered: 'refused',
  // OpenAI Chat Completions
  tool_calls: 'tools',
  function_call: 'tools',
  stop: 'answer',
  length: 'limit',
  content_filter: 'refused',
  // OpenAI Responses: its status, or why it is incomplete
  completed: 'answer',
  incomplete: 'limit',
  max_output_tokens: 'limit',
  failed: 'other',
  // Gemini
  STOP: 'answer',
  MAX_TOKENS: 'limit',
  SAFETY: 'refused',
  RECITATION: 'refused',
  BLOCKLIST: 'refused',
  PROHIBITED_CONTENT: 'refused',
  SPII: 'refused',
  IMAGE_SAFETY: 'refused',
  LANGUAGE: 'refused',
  MALFORMED_FUNCTION_CALL: 'other',
  UNEXPECTED_TOOL_CALL: 'other',
  TOO_MANY_TOOL_CALLS: 'other',
  OTHER: 'other',
  FINISH_REASON_UNSPECIFIED: 'other',
};

/** What each stop means, in a few words. */
export const STOP_WORDS: Record<DecisionStop, string> = {
  tools: 'calls tools',
  answer: 'answers and stops',
  limit: 'is cut off at its output limit',
  refused: 'refuses',
  paused: 'pauses its turn',
  other: 'ends its turn',
};

/**
 * A tool that hands the conversation over to another agent or a person: the OpenAI Agents SDK names
 * its handoffs `transfer_to_<agent>`, and other frameworks `handoff_to_…` or `hand_off_to_…`.
 */
export function isHandover(tool: string): boolean {
  return /^(transfer_to_|handoff_to_|hand_off_to_)/i.test(tool) || /^hand_?off$/i.test(tool);
}

/** Tools a provider runs itself that only read: its web search and fetch, file search, tool search, and code it runs in its own sandbox, where nothing outside the sandbox changes. */
const HOSTED_READS = new Set(['web_search', 'web_fetch', 'file_search', 'code_execution', 'bash_code_execution', 'text_editor_code_execution', 'code_interpreter', 'tool_search_tool_regex', 'tool_search_tool_bm25']);

/**
 * What a tool the provider runs or defines itself does, as `normalizeResponse` names its calls
 * (Anthropic's server tools, the Responses API's built-in tools): its searches, fetches and sandboxed
 * code read; an image it makes is pure; a computer use action writes, but for a screenshot or a wait,
 * which read; the shell and a patch write. Null for a name that doesn't say, such as an MCP server's
 * tool, which the runs and the config's `mcp.effects` tell, or else counts as a write.
 */
export function hostedToolEffect(name: string): Effect | null {
  if (HOSTED_READS.has(name)) return 'read';
  if (name === 'image_generation') return 'pure';
  if (name.startsWith('computer.')) return name === 'computer.screenshot' || name === 'computer.wait' ? 'read' : 'write';
  if (name === 'local_shell' || name === 'shell' || name === 'apply_patch') return 'write';
  return null;
}

/** Scopes Shadowlap makes calls in itself, such as its judge's: none of their calls is the agent's decision. */
export { isReservedScope };

/** A model id as its own family names it: Bedrock's ARN, Region prefix, `anthropic.` and version suffix, Vertex AI's publisher path and `@version`, Gemini's `models/` left out. */
export function bareModel(model: string): string {
  return model
    .trim()
    .replace(/^arn:aws[\w-]*:bedrock:[^:]*:[^:]*:[\w-]+\//, '')
    .replace(/^(?:projects\/[^/]+\/locations\/[^/]+\/)?publishers\/[^/]+\/models\//, '')
    .replace(/^models\//, '')
    .replace(/^(us|eu|apac|jp|au|ca|us-gov|global)\./, '')
    .replace(/^(anthropic|openai|amazon|meta|mistral|cohere|ai21|deepseek|qwen|google)\./, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/@[^@]*$/, '')
    .toLowerCase();
}

/** Whose model a name is: a Claude model, OpenAI's, Gemini's; null when the name doesn't say (a deployment, a local model). */
export function modelFamily(model: string | null | undefined): 'claude' | 'openai' | 'gemini' | null {
  if (!model) return null;
  const m = bareModel(model);
  if (m.startsWith('claude-')) return 'claude';
  if (/^(gpt-|chatgpt-|codex-|computer-use-|o\d(-|$))/.test(m)) return 'openai';
  if (/^(gemini-|gemma-)/.test(m)) return 'gemini';
  return null;
}

/**
 * Whether a recorded model is the one a person names: the same id, the same model on Bedrock or
 * Vertex AI, or an undated name (an alias) for one of its dated snapshots (`claude-sonnet-4-5` for
 * `claude-sonnet-4-5-20250929`, `gpt-4o` for `gpt-4o-2024-08-06`). Two snapshots are two models.
 */
export function sameModel(recorded: string | null | undefined, given: string): boolean {
  if (!recorded) return false;
  if (recorded === given) return true;
  const a = bareModel(recorded);
  const b = bareModel(given);
  if (a === b) return true;
  // A dated snapshot: Anthropic's `-20250929`, OpenAI's `-2024-08-06`, a Gemini stable version's `-001`.
  const dated = /-(\d{8}|\d{4}-\d{2}-\d{2}|\d{3})$/;
  const base = (m: string) => m.replace(/-(latest|0)$/, '').replace(dated, '');
  return base(a) === base(b) && (!dated.test(a) || !dated.test(b));
}

export interface DecisionOptions {
  /** The project's normalizers (and a redacted recording's rules): what they mask is no change. */
  normalizers?: readonly Normalizer[];
  /** Dates and timestamps near these times are masked, as a replay under `"clock": "auto"` masks them. */
  clock?: ClockReference;
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/** A tool call's arguments as matching reads them: masked by the normalizers for that tool, and the clock. */
export function normalizedArgs(tool: string, input: unknown, o: DecisionOptions = {}): unknown {
  const masked = o.clock === undefined ? input : maskClock(input, o.clock);
  // Paths are relative to a tool call as it is stored, `{ args }`, as normalizers and redaction rules read it.
  return (applyNormalizers({ args: masked }, [...(o.normalizers ?? [])], 'tool', tool) as { args: unknown }).args;
}

/** The decision in a model's answer, read as `normalizeResponse` reads any provider's: its blocks and stop reason. */
export function decisionOf(response: { blocks: readonly Block[]; stopReason: string | null }, o: DecisionOptions = {}): ModelDecision {
  const tools: DecisionCall[] = [];
  const texts: string[] = [];
  for (const b of response.blocks) {
    if (b.type === 'tool_call') {
      const effect = b.hosted ? hostedToolEffect(b.name) : null;
      tools.push({ name: b.name, args: normalizedArgs(b.name, b.input, o), ...(effect ? { effect } : {}) });
    } else if (b.type === 'text') texts.push(b.text);
  }
  let text = texts.join('');
  if (o.clock !== undefined) text = maskClockText(text, o.clock);
  text = collapse(rewriteText(text, [...(o.normalizers ?? [])]));
  const said = response.stopReason ? (STOPS[response.stopReason] ?? STOPS[response.stopReason.toLowerCase()] ?? 'other') : null;
  // An answer that asks for tools is a tool turn whatever the provider's word for it (a Gemini STOP,
  // a Responses `completed`), unless it was cut off part way through one.
  const stop: DecisionStop = tools.length ? (said === 'limit' ? 'limit' : 'tools') : said === 'tools' || said === null ? 'answer' : said;
  return { stop, stopReason: response.stopReason, tools, text, handover: tools.find((t) => isHandover(t.name))?.name ?? null };
}

/** The decision in a stored or received response body, in any provider's wire format. */
export function decisionOfResponse(bytes: Buffer | null, contentType: string | undefined, provider: string | undefined, o: DecisionOptions = {}, chunks: Array<[number, number]> = []): ModelDecision {
  return decisionOf(normalizeResponse(bytes, contentType, chunks, provider), o);
}

/** What a tool does, by name; null when no recording says. */
export type EffectOf = (tool: string) => Effect | null;

/** The effect of every tool a run's calls name, the most consequential when calls disagree. */
export function effectsOf(calls: Iterable<Pick<CallRecord, 'kind' | 'name' | 'effect'>>, into: Map<string, Effect> = new Map()): Map<string, Effect> {
  const weight: Record<Effect, number> = { pure: 0, read: 1, write: 2 };
  for (const c of calls) {
    if (c.kind !== 'tool' || !c.effect) continue;
    const had = into.get(c.name);
    if (!had || weight[c.effect] > weight[had]) into.set(c.name, c.effect);
  }
  return into;
}

const keyOf = (c: DecisionCall) => `${c.name}\u0000${canonicalize(c.args ?? null)}`;

/** Pairs two lists of calls: the same call first, then the same tool asked differently; the rest are added or removed. */
function pairCalls(before: DecisionCall[], after: DecisionCall[]): { changed: Array<[DecisionCall, DecisionCall]>; removed: DecisionCall[]; added: DecisionCall[] } {
  const left = [...before];
  const right = [...after];
  for (let i = left.length - 1; i >= 0; i--) {
    const j = right.findIndex((c) => keyOf(c) === keyOf(left[i]!));
    if (j >= 0) {
      right.splice(j, 1);
      left.splice(i, 1);
    }
  }
  const changed: Array<[DecisionCall, DecisionCall]> = [];
  for (let i = 0; i < left.length; ) {
    const j = right.findIndex((c) => c.name === left[i]!.name);
    if (j < 0) {
      i++;
      continue;
    }
    changed.push([left[i]!, right[j]!]);
    left.splice(i, 1);
    right.splice(j, 1);
  }
  return { changed, removed: left, added: right };
}

/**
 * How the new decision differs from the recorded one, every change with its rank. `effectOf` says
 * what each tool does; one it can't name counts as a write.
 */
export function compareDecisions(recorded: ModelDecision, now: ModelDecision, effectOf: EffectOf): DecisionComparison {
  const changes: DecisionChange[] = [];
  // A tool the provider runs itself is what its kind says; any other, what the runs say.
  const effect = (c: DecisionCall): Effect | 'unknown' => c.effect ?? effectOf(c.name) ?? 'unknown';
  const writes = (d: ModelDecision) => d.tools.filter((t) => !isHandover(t.name) && (effect(t) === 'write' || effect(t) === 'unknown'));
  const reads = (d: ModelDecision) => d.tools.filter((t) => !isHandover(t.name) && (effect(t) === 'read' || effect(t) === 'pure'));
  const add = (c: Omit<DecisionChange, 'tool' | 'effect'> & { call?: DecisionCall; tool?: string | undefined }) => {
    const { call, tool, ...rest } = c;
    changes.push({ ...rest, tool: call?.name ?? tool ?? null, effect: call ? effect(call) : tool ? (effectOf(tool) ?? 'unknown') : null });
  };

  // 1: writes, as calls that act on the world, in the order they are asked for.
  const w = pairCalls(writes(recorded), writes(now));
  for (const [b, a] of w.changed) add({ rank: 1, kind: 'write-arguments', call: b, before: b.args, after: a.args, detail: `${b.name} is called with other arguments` });
  for (const b of w.removed) add({ rank: 1, kind: 'write-removed', call: b, before: b.args, after: null, detail: `${b.name} is no longer called` });
  for (const a of w.added) add({ rank: 1, kind: 'write-added', call: a, before: null, after: a.args, detail: `${a.name} is called${effect(a) === 'unknown' ? ', a tool no recording gives an effect, so it counts as a write' : ''}` });
  const order = (d: ModelDecision) => writes(d).map(keyOf).join('\u0001');
  if (!changes.length && order(recorded) !== order(now)) {
    add({ rank: 1, kind: 'write-order', before: writes(recorded).map((t) => t.name), after: writes(now).map((t) => t.name), detail: 'the same writes, in another order' });
  }

  // 2: whether it stops, and whom it hands over to.
  if (recorded.stop !== now.stop) add({ rank: 2, kind: 'stops', before: recorded.stop, after: now.stop, detail: `it ${STOP_WORDS[now.stop]}, where the recording ${STOP_WORDS[recorded.stop]}` });
  if (recorded.handover !== now.handover) {
    add({
      rank: 2,
      kind: 'handover',
      tool: now.handover ?? recorded.handover ?? undefined,
      before: recorded.handover,
      after: now.handover,
      detail: now.handover ? (recorded.handover ? `it hands over with ${now.handover}, not ${recorded.handover}` : `it hands over with ${now.handover}`) : `it no longer hands over with ${recorded.handover!}`,
    });
  }

  // 3 and 4: reads, as a set: asked in another order within a turn is the same decision.
  const r = pairCalls(reads(recorded), reads(now));
  for (const b of r.removed) add({ rank: 3, kind: 'read-removed', call: b, before: b.args, after: null, detail: `${b.name} is no longer called` });
  for (const a of r.added) add({ rank: 3, kind: 'read-added', call: a, before: null, after: a.args, detail: `${a.name} is called` });
  for (const [b, a] of r.changed) add({ rank: 4, kind: 'read-arguments', call: b, before: b.args, after: a.args, detail: `${b.name} is asked differently` });

  // 5: what it says.
  if (recorded.text !== now.text) add({ rank: 5, kind: 'text', before: clipText(recorded.text), after: clipText(now.text), detail: recorded.text && now.text ? 'it says something else' : now.text ? 'it says something, where the recording said nothing' : 'it says nothing, where the recording did' });

  changes.sort((a, b) => a.rank - b.rank);
  return { rank: changes[0]?.rank ?? null, changes };
}

// ---- reports: what `shadowlap decisions` prints, keeps and the dashboard reads ----

export interface TokenCount {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const NO_TOKENS: TokenCount = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * What a report keeps of a model's text: enough to read what it says, so a suite's report stays
 * small. The recording holds all of it.
 */
export function clipText(text: string, max = 2000): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (${text.length - max} more characters)`;
}

/** A decision as a report shows it: each tool call with what it does. */
export interface DecisionView {
  stop: DecisionStop;
  stopReason: string | null;
  tools: Array<{ name: string; args: unknown; effect: Effect | 'unknown' | 'handover' }>;
  text: string;
}

export function decisionView(d: ModelDecision, effectOf: EffectOf): DecisionView {
  return { stop: d.stop, stopReason: d.stopReason, tools: d.tools.map((t) => ({ name: t.name, args: t.args, effect: isHandover(t.name) ? 'handover' : (t.effect ?? effectOf(t.name) ?? 'unknown') })), text: clipText(d.text) };
}

/**
 * The rank more than half of a step's samples show, each sample's rank given (0: it decided as
 * recorded): the most consequential rank that more than half of them reach. Null when half or more
 * decided as recorded. With one sample, that sample's rank.
 */
export function majorityRank(ranks: readonly number[]): DecisionRank | null {
  if (!ranks.length) return null;
  const sorted = ranks.map((r) => (r >= 1 && r <= 5 ? r : 6)).sort((a, b) => a - b);
  const r = sorted[Math.floor(sorted.length / 2)]!;
  return r <= 5 ? (r as DecisionRank) : null;
}

/**
 * What a step's new answer would use in a run like the recorded one: its whole input (`input`,
 * cache reads and writes included) split between plain input, cache reads and cache writes as the
 * recorded call split its own, since a run's steps follow one another and each reads what the step
 * before it cached, and its output. Asking the steps again caches differently (several at once write
 * the cache, a second sample reads all of it), so what asking spent is no measure of a run.
 */
export function estimatedTokens(recorded: TokenCount | null, input: number, output: number): TokenCount {
  const whole = recorded ? recorded.input + recorded.cacheRead + recorded.cacheWrite : 0;
  if (!recorded || whole <= 0) return { input, output, cacheRead: 0, cacheWrite: 0 };
  const cacheRead = Math.round((input * recorded.cacheRead) / whole);
  const cacheWrite = Math.min(input - cacheRead, Math.round((input * recorded.cacheWrite) / whole));
  return { input: input - cacheRead - cacheWrite, output, cacheRead, cacheWrite };
}

/** One recorded model call, asked again. */
export interface DecisionStep {
  /** The call's number in the recording. */
  callNo: number;
  /** Its place among the run's model calls, from 1. */
  step: number;
  scope: string | null;
  /** The most consequential change any sample showed, or null when none changed (or it wasn't asked). */
  rank: DecisionRank | null;
  /**
   * The change more than half of its samples show (majorityRank), or null when half or more decided
   * as recorded: with one sample, `rank`. A rank 1 or 2 here flags the run; a change fewer samples
   * show is listed, not flagged, since a model's answers vary.
   */
  majority: DecisionRank | null;
  /** The changes of the sample that showed it. */
  changes: DecisionChange[];
  recorded: DecisionView;
  /**
   * The new decision: the sample with the most consequential change, or the first; among text-only
   * ones, one whose words a judge check could not judge. Null when no answer came.
   */
  now: DecisionView | null;
  /**
   * How often it changed: samples asked, answered, and how many of those decided differently, with
   * each one's rank (0: the same); and `unjudged`, the text-only samples whose words a judge check
   * reads but could not judge (judgeOpen), absent from sessions kept before judges read them.
   */
  samples: { asked: number; answered: number; changed: number; ranks: number[]; unjudged?: number };
  /**
   * The control arm: the request asked as recorded, as many times as the change's (control-arm.ts),
   * and how often it decided otherwise than the recording, each sample's rank (0: the same). With it,
   * `rank` and `majority` are the rank the change earns beyond that variation, or null. Absent when the
   * control wasn't asked (fewer than 3 samples), and from sessions kept before it was.
   */
  control?: { asked: number; answered: number; changed: number; ranks: number[]; error?: string | null } | null;
  /** With `control`: the exact one-sided p-value that the change's decisions run more consequential than the control's. */
  noise?: { p: number } | null;
  /** With `control`: the most consequential change any sample of the change showed, ranked or not. */
  sampled?: DecisionRank | null;
  model: { recorded: string | null; asked: string | null };
  /**
   * As recorded, and the new answer's in a run like the recorded one (estimatedTokens): its input
   * split between cache reads, cache writes and plain input as the recorded call's was, and its
   * output, the mean of the samples answered.
   */
  tokens: { before: TokenCount | null; after: TokenCount | null };
  /** USD, null without a price for the model: as recorded, and `after` for those tokens; `spent` is what asking it cost, every sample. */
  cost: { before: number | null; after: number | null; spent: number };
  /** Reasoning blocks from earlier turns left out of this request. */
  thinkingStripped: number;
  /** Why it was not asked, or why no sample was answered; null when one was. */
  error: string | null;
  /**
   * The judge checks that read its words, for a text-only change (`now`'s): each one's verdict on the
   * recorded words and on the new ones. Null when no check read them: another change, no judge check
   * that reads this answer, or a session kept before judges read text-only steps.
   */
  judge?: DecisionJudge[] | null;
}

/** A judge check's verdict on one side of a text-only step: the words as recorded, or the new ones. */
export interface DecisionJudgeSide {
  /** passed or failed by the judge's verdict; inconclusive when it got none, which never passes. */
  status: 'passed' | 'failed' | 'inconclusive';
  verdict: 'yes' | 'no' | null;
  /** The judge's sentence for its verdict, or why it is inconclusive (`not judged: …`). */
  reason: string;
  /**
   * Where the verdict came from: the recording's own judge call for the very request (`recording`),
   * an earlier ask of it that was kept (`kept`), or the judge, asked now (`live`); null when not judged.
   */
  source: 'recording' | 'kept' | 'live' | null;
  /** USD it cost now: 0 when free, null for a judge model with no price. */
  cost: number | null;
  /** A digest of the judge's request, by which the very same request is answered again from this verdict, free; null when none was made. */
  request: string | null;
}

/** A judge check that reads a text-only step's words: its verdict on the recorded words and on the new ones. */
export interface DecisionJudge {
  name: string;
  /** What it reads: the final answer, or the run as recorded with this answer in place of the recorded one. */
  of: 'answer' | 'run';
  model: string;
  /** The answer that passes. */
  pass: 'yes' | 'no';
  recorded: DecisionJudgeSide;
  now: DecisionJudgeSide;
  /** Whether the check comes out otherwise for the new words: null when either side is inconclusive. */
  changed: boolean | null;
}

/**
 * What judging the text-only steps came to over a report, and what it cost, apart from asking. Its
 * steps fall in three parts: those that wait on a judge, those a check came out otherwise for, and
 * those every check came out as recorded for.
 */
export interface DecisionsJudged {
  /** Steps with a text-only change a judge check reads. */
  steps: number;
  /** Of those, the steps a check came out otherwise for (raised to rank 2) that wait on no judge. */
  changed: number;
  /** Of those, the steps that wait on a judge (judgeOpen): a sample's words could not be judged, why in the warnings. */
  inconclusive: number;
  /** What the judge's calls made now cost, and their upstream requests; models with no price. */
  spent: number;
  upstreamRequests: number;
  unknownModels: string[];
}

/**
 * A text-only comparison with what its judge checks found: a check that comes out otherwise (passed
 * as recorded, failed now, or the other way) is a change of rank 2, ahead of the text, and the step
 * takes it. Any other comparison, and one no check came out otherwise for, as it is.
 */
export function promoteByJudge(c: DecisionComparison, judges: readonly DecisionJudge[]): DecisionComparison {
  if (c.rank !== 5) return c;
  const changed = judges.filter((j) => j.changed);
  if (!changed.length) return c;
  const promoted: DecisionChange[] = changed.map((j) => ({
    rank: 2,
    kind: 'judge',
    tool: null,
    effect: null,
    before: j.recorded.status,
    after: j.now.status,
    detail: `judge "${j.name}" ${j.now.status === 'failed' ? 'fails' : 'passes'} what it says now, which ${j.recorded.status} as recorded`,
  }));
  return { rank: 2, changes: [...promoted, ...c.changes].sort((a, b) => a.rank - b.rank) };
}

/**
 * A text-only sample whose words a judge check reads but could not judge: none of its checks came out
 * otherwise, and one got no verdict, so what it would make of them is open.
 */
export function unjudgedSample(judged: readonly DecisionJudge[] | null | undefined): boolean {
  return !!judged?.length && !judged.some((j) => j.changed) && judged.some((j) => j.changed === null);
}

/**
 * The sample a step shows, by its place among those answered: the first with the most consequential
 * change (each sample's rank after its judge checks, promoteByJudge); of text-only ones, the first
 * whose words a judge could not judge, so a step never reads as judged while a sample of it was not.
 * -1 when none was answered.
 */
export function shownSample(samples: ReadonlyArray<{ rank: DecisionRank | null; judge: readonly DecisionJudge[] | null }>): number {
  let shown = -1;
  samples.forEach((s, i) => {
    const a = samples[shown];
    if (!a || (s.rank ?? 9) - (a.rank ?? 9) < 0 || ((s.rank ?? 9) === (a.rank ?? 9) && unjudgedSample(s.judge) && !unjudgedSample(a.judge))) shown = i;
  });
  return shown;
}

/**
 * Whether a step waits on a judge: a judge check reads the words of a text-only sample of it that it
 * could not judge (no key for its provider, the budget spent), and the step's samples don't flag it
 * without them. A verdict it never got might read the words otherwise and flag the run, so a run
 * nothing else flags settles nothing while one of its steps waits.
 */
export function judgeOpen(step: Pick<DecisionStep, 'majority' | 'samples'>): boolean {
  return (step.samples.unjudged ?? 0) > 0 && !(step.majority !== null && step.majority <= 2);
}

/**
 * Whether a step waits on its control: its samples decided otherwise, and either side got fewer than
 * CONTROL_MIN_SAMPLES answers, for now (an overload, a rate limit, a 5xx, a dropped connection), so
 * no split of their scores can reach the control's risk (3 against 2 comes out no rarer than 1 in
 * 10), nothing told the change from the model's own variation, and the step is not ranked. A run
 * nothing else flags settles nothing while one of its steps waits. A control the provider will never
 * answer again (a model that retired) leaves the change's samples to rank the step instead, and the
 * warnings say so.
 */
export function controlOpen(step: Pick<DecisionStep, 'rank' | 'control' | 'sampled' | 'samples'>): boolean {
  if (!step.control || step.control.asked === 0 || step.rank !== null || step.sampled === null || step.sampled === undefined) return false;
  return step.control.answered < CONTROL_MIN_SAMPLES || step.samples.answered < CONTROL_MIN_SAMPLES;
}

/**
 * How a step's judge checks came out, for a cell: it waits on a judge (judgeOpen), else a check came
 * out otherwise for the new words, else every one came out as recorded; null when none read it.
 */
export function judgedOutcome(step: Pick<DecisionStep, 'judge' | 'majority' | 'samples'>): 'changed' | 'inconclusive' | 'unchanged' | null {
  if (judgeOpen(step)) return 'inconclusive';
  const judges = step.judge ?? null;
  if (!judges?.length) return null;
  if (judges.some((j) => j.changed)) return 'changed';
  // A step kept before its samples counted the words not judged: its own checks say.
  if (judges.some((j) => j.changed === null)) return 'inconclusive';
  return 'unchanged';
}

/**
 * Steps by what came of them: by rank; `same` (asked, and decided as recorded); `untouched` (the change
 * leaves the request as it was, as a prompt the working tree sends unchanged, so it isn't asked);
 * `notAsked` (skipped, or no answer came).
 */
export type DecisionCounts = Record<'1' | '2' | '3' | '4' | '5' | 'same' | 'untouched' | 'notAsked', number> & {
  /** Steps whose samples decided otherwise, but no more than the control's did: within the model's own variation. Absent from sessions kept before the control. */
  noise?: number;
};

export const emptyCounts = (): DecisionCounts => ({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, same: 0, untouched: 0, notAsked: 0, noise: 0 });

/** One run's model calls asked again. */
export interface DecisionRun {
  runId: string;
  /** The golden it came from, as `shadowlap test` names it, or null for a run. */
  golden: string | null;
  /** Model calls the recording holds, and how many were asked again. */
  steps: number;
  asked: number;
  /** Its most consequential change, in any sample. */
  rank: DecisionRank | null;
  /** The most consequential change most samples of a step show: a 1 or 2 flags the run (`flagged`). */
  majority: DecisionRank | null;
  counts: DecisionCounts;
  /** The run's model calls as recorded, and under the change: what it costs per run before and after; and what asking them spent. */
  cost: { before: number | null; after: number | null; spent: number };
  tokens: { before: TokenCount; after: TokenCount };
  thinkingStripped: number;
  /** Why none of its model calls could be asked (`--from-code` on a change that is more than a prompt), or null. */
  refused: string | null;
  /** Every model call: the changed ones first, most consequential first, then the same, then those not asked. */
  decisions: DecisionStep[];
  warnings: string[];
}

/** What the change is. */
export interface DecisionsChange {
  model: string | null;
  fields: Record<string, unknown>;
  /** The recorded models the model and the fields change at (`--from`, else the one the runs use most); null when they change at every model call. */
  from: string[] | null;
  /** `--from-code`: what the working tree sends, against the recording. */
  fromCode: FromCodeChange | null;
  /** In words: `the model claude-haiku-4-5`, `the prompt and tools in the working tree`. */
  text: string;
}

export interface FromCodeChange {
  /** The model calls whose prompt the working tree changes. */
  calls: number;
  /** The instructions as recorded and as the code sends them, the first time they differ; null when only the tools changed. */
  instructions: { before: string; after: string } | null;
  tools: { added: string[]; removed: string[]; changed: string[] };
  /** The code version the prompt was read from. */
  codeVersion: string | null;
}

/** `--then-verify` and `migrate`: verify's verdict on the runs with a rank 1 or 2 change. */
export interface DecisionsVerify {
  verdict: 'accepted' | 'rejected' | 'incomplete' | 'not-run';
  /** The verdicts kept (one per check the runs are judged by). */
  verifyIds: string[];
  /**
   * Each run verified: its role, how it came out (fixed, not-fixed, kept, broken, inconclusive,
   * unsettled), passes and attempts, under a gate the Wilson bound of its pass rate (`rate >= 0.76
   * (95%)`; null for a clean replay or a fixed count, absent from sessions kept before it was), and
   * the `rule` it was decided by (absent from sessions kept before runs carried it: `rule` below).
   * `undecided` says why its last attempt could not be judged (a judge that could not answer, a
   * condition it could not read), which stopped it, inconclusive: that attempt, among `attempts`,
   * neither passed nor failed, and there is no bound. Null otherwise, absent from sessions kept
   * before it was. A good run kept against its own baseline has the baseline's tally (`baseline`),
   * its bound is the drop's (`drop <= 0.07 (95%)`), and its rule the baseline test's.
   */
  runs: Array<{ runId: string; role: string; outcome: string; passes: number; attempts: number; bound?: string | null; undecided?: string | null; rule?: string | null; baseline?: { passes: number; attempts: number } }>;
  /**
   * The rule its runs were decided by, said once: `gate: tells 90%+ from 70%- at <= 5% risk, up to
   * 80 attempts`, or a fixed count's `4 of 5 attempts must pass`. Null when a session's runs were
   * decided by different rules (verified again later under other figures): each run's own says which.
   * Absent from sessions kept before it was.
   */
  rule?: string | null;
  /** The command that verifies them again. */
  commands: string[];
  spent: number;
  upstreamRequests: number;
  reasons: string[];
}

/**
 * Runs by the rule that decided them, in the order they first come, so a report states each rule
 * once over its own runs: a run with no rule of its own (kept before runs carried theirs) takes
 * `fallback`, the rule its verify stated.
 */
export function byRule<T>(runs: readonly T[], ruleOf: (run: T) => string | null | undefined, fallback: string | null = null): Array<{ rule: string | null; runs: T[] }> {
  const groups = new Map<string | null, T[]>();
  for (const run of runs) {
    const rule = ruleOf(run) ?? fallback;
    const group = groups.get(rule);
    if (group) group.push(run);
    else groups.set(rule, [run]);
  }
  return [...groups].map(([rule, of]) => ({ rule, runs: of }));
}

/**
 * A field `migrate` changed so the new model takes the recorded requests: set to a value it accepts,
 * left out (`leftOut`), or sent under another name (`renamedTo`), with why and where that comes from
 * (a provider page, or its own answer).
 */
export interface DecisionRemedy {
  field: string;
  /** The value the requests were sent with in its place, which verify sends too; null when it was left out of them. */
  value: unknown;
  /** Your agent's requests should leave it out (the page says to omit it), whatever value the requests were sent with meanwhile. */
  leftOut: boolean;
  /** The name it goes under instead, with the value the request had (`max_completion_tokens` for `max_tokens`); null otherwise. */
  renamedTo: string | null;
  why: string;
  /** The provider page that says so, or null when the provider's own refusal did. */
  source: string | null;
  /** Steps the change was needed for. */
  steps: number;
}

export interface DecisionsReport {
  /** The session's id in the store, `dc-…`; null when it could not be kept. */
  decisionsId: string | null;
  kind: 'decisions';
  at: number;
  change: DecisionsChange;
  /** The command that asks again the same way. */
  command: string;
  samples: number;
  runs: DecisionRun[];
  counts: DecisionCounts;
  /** Runs with a rank 1 or 2 change: what `--then-verify` verifies. */
  flagged: string[];
  /** Per run (the mean over the runs asked), as recorded and asked again; and what asking cost. USD. */
  cost: { before: number | null; after: number | null; spent: number; upstreamRequests: number; unknownModels: string[] };
  tokens: { before: TokenCount; after: TokenCount };
  /** Models the runs use, or the change switches to, that a provider retires. */
  retirements: RetirementNotice[];
  notes: string[];
  warnings: string[];
  verify: DecisionsVerify | null;
  /** What the judge checks that read text-only steps found, and what judging cost; null when no check read a step. */
  judge: DecisionsJudged | null;
  /** What `migrate` changed so the new model takes the requests; empty for `decisions`, which sends the change as given. */
  remedies: DecisionRemedy[];
  /** Why it stopped before every step was asked (the budget, Ctrl-C), or null. */
  stopReason: string | null;
}

export const DECISIONS_ID = /^dc-[0-9A-HJKMNP-TV-Z]{26}$/;
export const MIGRATE_ID = /^mg-[0-9A-HJKMNP-TV-Z]{26}$/;

/** Steps in the order a report lists them: changed first, most consequential first; then the same; then those not asked. */
export function byConsequence(a: Pick<DecisionStep, 'rank' | 'error' | 'callNo' | 'samples'>, b: Pick<DecisionStep, 'rank' | 'error' | 'callNo' | 'samples'>): number {
  const place = (s: Pick<DecisionStep, 'rank' | 'error' | 'samples'>) => (s.rank !== null ? s.rank : s.samples.answered ? 6 : 7);
  return place(a) - place(b) || b.samples.changed / Math.max(1, b.samples.answered) - a.samples.changed / Math.max(1, a.samples.answered) || a.callNo - b.callNo;
}

/** A tool call in one line: `send_email({"to":"team@example.com",…})`, its arguments cut short. */
export function callLine(name: string, args: unknown, width = 72): string {
  const json = args === null || args === undefined ? '' : typeof args === 'string' ? JSON.stringify(args) : JSON.stringify(args);
  const shown = json.length > width ? `${json.slice(0, width - 1)}…` : json;
  return safeLine(`${name}(${shown === '{}' ? '' : shown})`);
}

/**
 * What differs between two tool calls' arguments, field by field: `body: "Replay works." → "Replay
 * works; forks fence writes."`, each side cut short. Empty when they are not both objects.
 */
export function argsDelta(before: unknown, after: unknown, width = 60): string[] {
  if (!isObject(before) || !isObject(after)) return [];
  const clip = (v: unknown) => {
    const t = v === undefined ? '—' : JSON.stringify(v);
    return t.length > width ? `${t.slice(0, width - 1)}…` : t;
  };
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys.filter((k) => canonicalize(before[k] ?? null) !== canonicalize(after[k] ?? null) || (k in before) !== (k in after)).map((k) => safeLine(`${k}: ${clip(before[k])} → ${clip(after[k])}`));
}

/** A decision in one line: its tool calls, or how it ended. */
export function decisionLine(d: DecisionView | null, width = 72): string {
  if (!d) return 'no answer';
  if (d.tools.length) return d.tools.map((t) => callLine(t.name, t.args, Math.max(24, Math.floor(width / d.tools.length)))).join(' + ');
  const said = d.text ? `: "${safeLine(d.text.length > width ? `${d.text.slice(0, width - 1)}…` : d.text)}"` : '';
  return `${STOP_WORDS[d.stop]}${said}`;
}

const pct = (a: number, b: number) => {
  if (a === 0) return b === 0 ? 'the same' : 'new';
  const n = Math.round((Math.abs(b - a) / a) * 100);
  return n === 0 ? 'about the same' : `${b >= a ? '+' : '−'}${n}%`;
};
const tokenTotal = (t: TokenCount | null) => (t ? t.input + t.cacheRead + t.cacheWrite : 0);
const thousands = (n: number) => Math.round(n).toLocaleString('en-US');

/** The difference one step makes to tokens and cost, as a report line ends: `+120 tokens · +$0.002`. */
export function stepDelta(s: Pick<DecisionStep, 'tokens' | 'cost'>): string {
  const parts: string[] = [];
  if (s.tokens.before && s.tokens.after) {
    const d = tokenTotal(s.tokens.after) + s.tokens.after.output - (tokenTotal(s.tokens.before) + s.tokens.before.output);
    parts.push(`${d >= 0 ? '+' : '−'}${thousands(Math.abs(d))} tokens`);
  }
  if (s.cost.before !== null && s.cost.after !== null) {
    const d = s.cost.after - s.cost.before;
    parts.push(`${d >= 0 ? '+' : '−'}${formatUsd(Math.abs(d))}`);
  }
  return parts.join(' · ');
}

/** The report as the terminal shows it. */
export function formatDecisions(r: DecisionsReport, p: Palette = plain): string {
  const lines: string[] = [];
  const changed = r.counts[1] + r.counts[2] + r.counts[3] + r.counts[4] + r.counts[5];
  const asked = changed + r.counts.same;
  // A run refused whole (a --from-code change that is more than its prompt and tools) counts no
  // step, so it is named apart: no headline may read as if it had nothing to ask.
  const refused = r.runs.filter((x) => x.refused).length;
  const unasked = `${refused} of ${r.runs.length} run${r.runs.length === 1 ? '' : 's'} could not be asked`;
  const head = !asked
    ? refused
      ? `${p.yellow('!')} ${p.bold(unasked)}`
      : r.counts.notAsked
        ? `${p.yellow('!')} ${p.bold('No step was answered')} (the warnings say why)`
        : r.counts.untouched
          ? `${p.green('✓')} ${p.bold('Nothing to ask')}: the change leaves every request as recorded`
          : `${p.green('✓')} ${p.bold('Nothing to ask')}: the runs hold no model call`
    : r.flagged.length ? `${p.red('✗')} ${p.bold(`${r.flagged.length} of ${r.runs.length} run${r.runs.length === 1 ? '' : 's'}`)} ${flaggedFor(r)}` : changed ? `${p.yellow('!')} ${p.bold('No write and no stop changes')}: ${changed} decision${changed === 1 ? '' : 's'} differ in reads or text` : `${refused ? p.yellow('!') : p.green('✓')} ${p.bold('The same decisions')} at every step asked`;
  const why = !refused ? '' : asked ? `; ${unasked} (why below)` : ' (why below)';
  lines.push(`${head}, under ${safeLine(r.change.text)}${why}`);
  const ranks = ([1, 2, 3, 4, 5] as const).filter((k) => r.counts[k]).map((k) => `${r.counts[k]} rank ${k}`);
  // With the control arm, each step was also asked as recorded, as often: what it decided otherwise is the model's own variation.
  const controlled = r.runs.some((x) => x.decisions.some((d) => d.control));
  const noise = r.counts.noise ?? 0;
  const each = r.samples > 1 ? `, ${r.samples} samples each${controlled ? ' and as many as recorded' : ''}` : '';
  lines.push(p.dim(`  ${asked + noise} step${asked + noise === 1 ? '' : 's'} asked${each}: ${ranks.length ? `${ranks.join(', ')}, ` : ''}${noise ? `${noise} within the model's own variation, ` : ''}${r.counts.same} the same${r.counts.untouched ? `, ${r.counts.untouched} the change leaves as recorded` : ''}${r.counts.notAsked ? `, ${r.counts.notAsked} not asked` : ''} · no tool ran`));
  for (const run of r.runs) {
    lines.push('');
    const name = run.golden ? `${safeLine(run.golden)} ${p.dim(run.runId.slice(0, 10))}` : run.runId.slice(0, 10);
    const summary = run.rank !== null ? `${run.decisions.filter((s) => s.rank !== null).length} changed, most: rank ${run.rank} (${RANK_LABELS[run.rank]})` : run.asked ? 'the same decisions' : run.counts.untouched === run.steps && run.steps ? 'the change leaves its requests as recorded' : 'nothing asked';
    if (run.refused) {
      // A refusal of several lines (an unrecorded write's, with what to do) keeps its line breaks, each line under the run's.
      const [first = '', ...more] = safeText(run.refused).split('\n');
      lines.push(`${p.bold(name)}  ${p.yellow('not asked')}: ${first}`, ...more.map((l) => `  ${l}`));
      continue;
    }
    lines.push(`${p.bold(name)}  ${p.dim(`${run.asked} of ${run.steps} model call${run.steps === 1 ? '' : 's'} asked`)} · ${run.majority !== null && run.majority <= 2 ? p.red(summary) : run.rank !== null ? p.yellow(summary) : summary}`);
    for (const s of run.decisions) {
      // A change the request as recorded got no answer to tell from the model's own variation: not ranked, not settled.
      if (controlOpen(s)) {
        const asRecorded = s.control!.answered ? `${s.control!.answered} of ${s.control!.asked} answered as recorded` : 'as recorded, no answer';
        lines.push(`  #${String(s.callNo).padEnd(4)} ${p.dim(`step ${s.step}`)}  ${p.yellow('not settled')}  ${safeLine(s.changes[0]?.detail ?? RANK_LABELS[s.sampled!])}${p.dim(` · in ${s.samples.changed} of ${s.samples.answered} samples; ${asRecorded}${s.control!.error ? ` (${safeLine(s.control!.error)})` : ''}: too few to tell from the model's own variation`)}`);
        continue;
      }
      // A change no more frequent than the control's: listed with both arms' counts, not ranked.
      if (s.rank === null && s.control && s.sampled) {
        lines.push(`  #${String(s.callNo).padEnd(4)} ${p.dim(`step ${s.step}`)}  ${p.dim('within the model\'s own variation')}  ${safeLine(s.changes[0]?.detail ?? RANK_LABELS[s.sampled])}${p.dim(` · in ${s.samples.changed} of ${s.samples.answered} samples, ${s.control.changed} of ${s.control.answered} as recorded`)}`);
        continue;
      }
      if (s.rank === null && !s.error) continue;
      if (s.rank === null) {
        lines.push(`  #${String(s.callNo).padEnd(4)} ${p.dim(`step ${s.step}`)}  ${p.yellow('not asked')}  ${p.dim(safeLine(s.error ?? ''))}`);
        continue;
      }
      const colour = s.rank <= 1 ? p.red : s.rank === 2 ? p.yellow : (x: string) => x;
      // A write or stop change most samples don't show is the model's own variation until shown otherwise.
      const minority = s.rank <= 2 && (s.majority === null || s.majority > 2);
      // With samples, how many of them a judge could not judge: the sample shown need not be one.
      const unjudged = s.samples.unjudged ?? 0;
      const notJudged = r.samples > 1 && unjudged ? `, ${unjudged} of them not judged` : '';
      const control = s.control ? `, ${s.control.changed} of ${s.control.answered} as recorded` : '';
      const often = r.samples > 1 ? p.dim(` · in ${s.samples.changed} of ${s.samples.answered} samples${control}${minority ? ', fewer than half: not flagged' : ''}${notJudged}`) : '';
      lines.push(`  #${String(s.callNo).padEnd(4)} ${p.dim(`step ${s.step}`)}  ${colour(`rank ${s.rank}`)}  ${safeLine(s.changes[0]?.detail ?? RANK_LABELS[s.rank])}${often}`);
      lines.push(`         ${p.dim('recorded')} ${decisionLine(s.recorded)}`);
      lines.push(`         ${p.dim('now     ')} ${decisionLine(s.now)}${stepDelta(s) ? p.dim(`  ${stepDelta(s)}`) : ''}`);
      for (const c of s.changes.filter((x) => x.kind === 'write-arguments' || x.kind === 'read-arguments')) for (const d of argsDelta(c.before, c.after)) lines.push(`         ${p.dim(`${c.tool!}.`)}${d}`);
      for (const j of s.judge ?? []) lines.push(`         ${p.dim(`judge "${safeLine(j.name)}"`)} ${judgeWords(j, p)}`);
    }
    if (run.cost.before !== null || run.cost.after !== null) {
      const tokens = `${thousands(tokenTotal(run.tokens.before))} → ${thousands(tokenTotal(run.tokens.after))} input tokens`;
      const cost = run.cost.before !== null && run.cost.after !== null ? ` · ≈${formatUsd(run.cost.before)} → ≈${formatUsd(run.cost.after)} (${pct(run.cost.before, run.cost.after)})` : '';
      lines.push(p.dim(`  the steps asked, as recorded and now: ${tokens}${cost}`));
    }
    for (const w of run.warnings) lines.push(`  ${p.yellow('!')} ${safeLine(w)}`);
  }
  if (r.retirements.length) {
    lines.push('');
    for (const n of r.retirements) lines.push(`${p.yellow('!')} ${safeLine(n.text)}`);
  }
  if (r.warnings.length) {
    lines.push('');
    for (const w of r.warnings) lines.push(`${p.yellow('!')} ${safeLine(w)}`);
  }
  lines.push('');
  for (const n of r.notes) lines.push(p.dim(`  ${safeLine(n)}`));
  const unpriced = r.cost.unknownModels.length ? ` (no price for ${r.cost.unknownModels.map(safeLine).join(', ')})` : '';
  const perRun = r.cost.before !== null && r.cost.after !== null ? ` · per run ≈${formatUsd(r.cost.before)} → ≈${formatUsd(r.cost.after)} (${pct(r.cost.before, r.cost.after)})` : '';
  lines.push(p.dim(`  asking: ${r.cost.upstreamRequests} upstream request${r.cost.upstreamRequests === 1 ? '' : 's'} · ≈${formatUsd(r.cost.spent)} spent${unpriced}${perRun}${r.stopReason ? ` · stopped: ${safeLine(r.stopReason)}` : ''}`));
  // The judge's calls apart from the agent's: free only when none went upstream, as a judge with no price is no free call.
  const j = r.judge;
  if (j) lines.push(p.dim(`  judging: ${j.upstreamRequests} upstream request${j.upstreamRequests === 1 ? '' : 's'} · ${j.upstreamRequests ? `${aboutUsd(j.spent)} spent${j.unknownModels.length ? ` (no price for ${j.unknownModels.map(safeLine).join(', ')})` : ''}` : 'free'}`));
  return lines.join('\n');
}

/**
 * What the flagged runs do, for the headline: decide a write or when to stop differently, are judged
 * otherwise (a judge check comes out otherwise for what a text-only step says), or both.
 */
function flaggedFor(r: Pick<DecisionsReport, 'runs' | 'flagged'>): string {
  const flagging = r.runs.filter((x) => r.flagged.includes(x.runId)).flatMap((x) => x.decisions.filter((s) => s.majority !== null && s.majority <= 2));
  const judged = flagging.some((s) => s.changes.some((c) => c.kind === 'judge'));
  const acted = flagging.some((s) => s.changes.some((c) => c.rank <= 2 && c.kind !== 'judge')) || !judged;
  const one = r.flagged.length === 1;
  const otherwise = `${one ? 'is' : 'are'} judged otherwise`;
  return acted ? `decide${one ? 's' : ''} a write or when to stop differently${judged ? `, or ${otherwise}` : ''}` : otherwise;
}

/** Where a judge's verdict came from, and what it cost. */
function sourceWords(side: DecisionJudgeSide): string {
  if (side.source === 'recording') return 'from the recording, free';
  if (side.source === 'kept') return 'asked before and kept, free';
  return `judged live, ${side.cost === null ? 'no price for its model' : aboutUsd(side.cost)}`;
}

/** A judge check on a text-only step, after its name: `passed → failed · its reason (judged live, ≈$0.0004)`. */
function judgeWords(j: DecisionJudge, p: Palette): string {
  if (j.changed === null) {
    const why = j.now.status === 'inconclusive' ? safeLine(j.now.reason) : `the recorded words: ${safeLine(j.recorded.reason)}`;
    return `${p.yellow('inconclusive')} ${p.dim(`· ${why}`)}`;
  }
  const status = (s: DecisionJudgeSide['status']) => (s === 'passed' ? p.green(s) : p.red(s));
  const said = `${j.now.reason ? ` · ${safeLine(j.now.reason)}` : ''} (${sourceWords(j.now)})`;
  return j.changed ? `${status(j.recorded.status)} → ${status(j.now.status)}${p.dim(said)}` : `${status(j.now.status)}, as recorded${p.dim(said)}`;
}
