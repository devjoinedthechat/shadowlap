import type { Refusal, ToolFailure } from './interventions.js';
import type { ReplayOptions } from './session.js';
import type { CallRecord } from './types.js';

/**
 * Error-path presets: the failures an agent meets in production that a recording of a healthy run
 * never holds, each played into a replay of the recording at one place, so the agent's own error
 * path runs. Not fuzzing: six presets, each a failure a tool or a provider really produces.
 *
 *   timeout     the tool times out (it doesn't run)
 *   empty       the tool answers with nothing: an empty list, object or text, as it recorded one
 *   malformed   the tool answers with JSON cut short, as a truncated response is
 *   oversized   the tool answers with far more than it ever did: its longest text, repeated
 *   429         the provider rate-limits the model call that reads the tool's answer
 *   500         the provider fails that model call with a server error
 *
 * Every preset changes what the agent gets at one call, so the replay forks there and runs live
 * from it, writes fenced, and is judged as a fork is: the agent exits 0 and passes its checks.
 */

export const CHAOS_PRESETS = ['timeout', 'empty', 'malformed', 'oversized', '429', '500'] as const;
export type ChaosPreset = (typeof CHAOS_PRESETS)[number];

/** Each preset as the report says it. */
export const PRESET_LABELS: Readonly<Record<ChaosPreset, string>> = {
  timeout: 'tool timeout',
  empty: 'empty result',
  malformed: 'malformed JSON',
  oversized: 'oversized result',
  '429': 'provider 429',
  '500': 'provider 500',
};

/** The length an oversized result grows to by default, in characters: past what a model's context takes. */
export const OVERSIZE_CHARS = 1_000_000;

/** Whether a preset hits a tool call or a model call. */
export function presetHits(p: ChaosPreset): 'tool' | 'model' {
  return p === '429' || p === '500' ? 'model' : 'tool';
}

export function isChaosPreset(v: unknown): v is ChaosPreset {
  return typeof v === 'string' && (CHAOS_PRESETS as readonly string[]).includes(v);
}

/** `timeout,429`, or `all`: the presets asked for, each once, in the order they are listed here. */
export function parsePresets(raw: string | readonly string[], where = '--presets'): ChaosPreset[] {
  const items = (typeof raw === 'string' ? raw.split(',') : raw).map((s) => s.trim()).filter(Boolean);
  if (!items.length) throw new Error(`${where}: name at least one preset (${CHAOS_PRESETS.join(', ')}), or all`);
  if (items.includes('all')) return [...CHAOS_PRESETS];
  const unknown = items.filter((s) => !isChaosPreset(s));
  if (unknown.length) throw new Error(`${where}: unknown preset${unknown.length === 1 ? '' : 's'} ${unknown.map((s) => `"${s}"`).join(', ')} (expected ${CHAOS_PRESETS.join(', ')}, or all)`);
  return CHAOS_PRESETS.filter((p) => items.includes(p));
}

// ---- where the presets hit ----

/** A call a preset hits, or why there is none. */
export type ChaosTarget = { callNo: number; name: string } | { none: string };

export interface ChaosTargets {
  /** The tool call the tool presets hit. */
  tool: ChaosTarget;
  /** The model call the provider presets hit: the one that reads the tool call's answer. */
  model: ChaosTarget;
}

const RESERVED_SCOPE = /^shadowlap:/;
const agentCall = (c: CallRecord) => !(typeof c.meta.scope === 'string' && RESERVED_SCOPE.test(c.meta.scope));

/**
 * Where the presets hit a recording. The tool presets hit the first tool call whose answer the agent
 * reads from the world (a `read`; else one whose effect nothing declares; else a write), or the
 * first call of the tool `tool` names; a pure tool is the agent's own code, which neither times out
 * nor answers malformed JSON. A call that failed when it was recorded is on an error path already,
 * and what a person typed is no tool's answer: neither is hit. The provider presets hit the model
 * call after that tool call, which reads its answer, or the first model call when no tool call is hit.
 */
export function chaosTargets(calls: readonly CallRecord[], o: { tool?: string | null } = {}): ChaosTargets {
  const sorted = [...calls].sort((a, b) => a.callNo - b.callNo);
  const answered = sorted.filter((c) => c.kind === 'tool' && c.end?.outcome === 'ok' && c.meta.input !== true && agentCall(c));
  let tool: ChaosTarget;
  if (o.tool) {
    const named = sorted.filter((c) => c.kind === 'tool' && c.name === o.tool);
    const first = answered.find((c) => c.name === o.tool);
    tool = first ? { callNo: first.callNo, name: first.name } : { none: named.length ? `every call of ${o.tool} failed when it was recorded` : `the recording never calls ${o.tool}` };
  } else {
    const pick = answered.find((c) => c.effect === 'read') ?? answered.find((c) => c.effect === null) ?? answered.find((c) => c.effect === 'write');
    tool = pick
      ? { callNo: pick.callNo, name: pick.name }
      : { none: sorted.some((c) => c.kind === 'tool') ? 'the recording calls no tool that reads the world (only pure tools, or ones that failed)' : 'the recording makes no tool call' };
  }
  const models = sorted.filter((c) => c.kind === 'api' && agentCall(c));
  const after = 'callNo' in tool ? models.find((c) => c.callNo > tool.callNo) : undefined;
  const pick = after ?? models[0];
  const model: ChaosTarget = pick ? { callNo: pick.callNo, name: pick.name } : { none: 'the recording makes no model call' };
  return { tool, model };
}

// ---- what a preset answers ----

/** How a tool's recorded result is shaped: a value an SDK tool returned, an HTTP response, or an MCP tool's result. */
export type ResultShape = 'value' | 'http' | 'mcp';

/** The shape of a recorded tool call's result, from what the call was. */
export function resultShape(call: Pick<CallRecord, 'meta'>): ResultShape {
  if (typeof call.meta.http === 'string') return 'http';
  if (call.meta.mcp) return 'mcp';
  return 'value';
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Nothing, keeping the kind of value: an empty list for a list, an empty object, empty text, else null. */
function emptyOf(v: unknown): unknown {
  if (Array.isArray(v)) return [];
  if (isObject(v)) return {};
  if (typeof v === 'string') return '';
  return null;
}

/** The text a body or a value is read as. */
function jsonText(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v) ?? 'null';
}

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** JSON text cut short, as a response that stopped arriving is: three fifths of it, which never parses. */
export function cutJson(text: string): string {
  const cut = text.slice(0, Math.max(1, Math.floor(text.length * 0.6)));
  return parses(cut) ? `${cut.startsWith('{') ? '' : '{'}${cut}` : cut;
}

/** Text repeated, a line at a time, until it is at least `chars` long. */
function grownText(text: string, chars: number): string {
  const unit = text.length ? text : 'x';
  // n copies and the n − 1 line breaks between them.
  return Array.from({ length: Math.max(1, Math.ceil((chars + 1) / (unit.length + 1))) }, () => unit).join('\n');
}

/** The longest text in a value, by its path of keys. */
function longestText(v: unknown, at: Array<string | number> = []): { at: Array<string | number>; text: string } | null {
  if (typeof v === 'string') return { at, text: v };
  let best: { at: Array<string | number>; text: string } | null = null;
  const entries: Array<[string | number, unknown]> = Array.isArray(v) ? v.map((x, i) => [i, x]) : isObject(v) ? Object.entries(v) : [];
  for (const [k, x] of entries) {
    const found = longestText(x, [...at, k]);
    if (found && (!best || found.text.length > best.text.length)) best = found;
  }
  return best;
}

/** The longest list in a value that has something in it. */
function longestList(v: unknown, at: Array<string | number> = []): { at: Array<string | number>; list: unknown[] } | null {
  let best: { at: Array<string | number>; list: unknown[] } | null = Array.isArray(v) && v.length ? { at, list: v } : null;
  const entries: Array<[string | number, unknown]> = Array.isArray(v) ? v.map((x, i) => [i, x]) : isObject(v) ? Object.entries(v) : [];
  for (const [k, x] of entries) {
    const found = longestList(x, [...at, k]);
    if (found && (!best || found.list.length > best.list.length)) best = found;
  }
  return best;
}

function setAt(v: unknown, at: ReadonlyArray<string | number>, value: unknown): unknown {
  if (!at.length) return value;
  const [k, ...rest] = at;
  if (Array.isArray(v)) return v.map((x, i) => (i === k ? setAt(x, rest, value) : x));
  if (isObject(v)) return { ...v, [k as string]: setAt(v[k as string], rest, value) };
  return v;
}

/**
 * A value grown to at least `chars` characters of JSON: its longest text repeated, else its longest
 * list's items repeated. Null when it has neither (a number, an object of numbers).
 */
function grownValue(v: unknown, chars: number): unknown | null {
  const text = longestText(v);
  if (text && text.text.length) {
    const others = jsonText(v).length - text.text.length;
    return setAt(v, text.at, grownText(text.text, Math.max(1, chars - others)));
  }
  const list = longestList(v);
  if (list) {
    const each = Math.max(1, jsonText(list.list).length / list.list.length);
    const n = Math.ceil(chars / each);
    return setAt(v, list.at, Array.from({ length: n }, (_, i) => list.list[i % list.list.length]));
  }
  if (text) return setAt(v, text.at, grownText('', chars));
  return null;
}

/** Text grown to `chars`: JSON text stays JSON, its document grown; other text is repeated. */
function grownJsonText(text: string, chars: number): string {
  if (parses(text)) {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      const grown = grownValue(parsed, chars);
      if (grown !== null) return JSON.stringify(grown);
    }
  }
  return grownText(text, chars);
}

interface HttpLike {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  encoding?: 'json' | 'text' | 'base64';
}

const isHttp = (v: unknown): v is HttpLike => isObject(v) && typeof v.status === 'number';
const refuse = (why: string): Refusal => ({ refused: why });

/** The text blocks of an MCP tool's result. */
const mcpTexts = (v: Record<string, unknown>) => (Array.isArray(v.content) ? v.content : []).map((b, i) => ({ b, i })).filter((x): x is { b: { type: 'text'; text: string }; i: number } => isObject(x.b) && x.b.type === 'text' && typeof x.b.text === 'string');

/** The result a tool preset serves in place of the recorded one, or why it can't. */
export function presetResult(preset: Exclude<ChaosPreset, 'timeout' | '429' | '500'>, recorded: unknown, shape: ResultShape, o: { oversize?: number } = {}): { result: unknown } | Refusal {
  const chars = o.oversize ?? OVERSIZE_CHARS;
  if (shape === 'http') {
    if (!isHttp(recorded)) return refuse('its recorded response is missing');
    if (recorded.encoding === 'base64') return refuse('its recorded response is binary');
    const body = recorded.body;
    const json = recorded.encoding === 'json' || recorded.encoding === undefined;
    if (preset === 'empty') return { result: { ...recorded, body: json ? emptyOf(body) : '', encoding: json ? 'json' : 'text' } };
    if (preset === 'malformed') {
      const text = jsonText(body ?? '');
      if (!json && !parses(text)) return refuse('its recorded response is text, not JSON');
      return { result: { ...recorded, body: cutJson(text), encoding: 'text' } };
    }
    if (json) {
      const grown = grownValue(body, chars);
      return grown === null ? refuse('its recorded response has no text or list to grow') : { result: { ...recorded, body: grown, encoding: 'json' } };
    }
    return { result: { ...recorded, body: grownJsonText(String(body ?? ''), chars), encoding: 'text' } };
  }
  if (shape === 'mcp' && isObject(recorded) && Array.isArray(recorded.content)) {
    const texts = mcpTexts(recorded);
    const content = [...recorded.content];
    if (preset === 'empty') return { result: { ...recorded, content: [], ...('structuredContent' in recorded ? { structuredContent: emptyOf(recorded.structuredContent) } : {}) } };
    if (preset === 'malformed') {
      const json = texts.filter((x) => parses(x.b.text));
      if (!json.length) return refuse('its recorded result holds no JSON text');
      for (const x of json) content[x.i] = { ...x.b, text: cutJson(x.b.text) };
      return { result: { ...recorded, content } };
    }
    const longest = texts.sort((a, b) => b.b.text.length - a.b.text.length)[0];
    if (!longest) return refuse('its recorded result holds no text to grow');
    content[longest.i] = { ...longest.b, text: grownJsonText(longest.b.text, chars) };
    return { result: { ...recorded, content } };
  }
  if (preset === 'empty') return { result: emptyOf(recorded) };
  if (preset === 'malformed') {
    // A tool that returned text hands it on as it is; one that returned data gets its JSON text, cut.
    const text = jsonText(recorded);
    if (typeof recorded === 'string' && !parses(text)) return refuse('it returned text, not JSON');
    return { result: cutJson(text) };
  }
  if (typeof recorded === 'string') return { result: grownJsonText(recorded, chars) };
  const grown = grownValue(recorded, chars);
  return grown === null ? refuse('its recorded result has no text or list to grow') : { result: grown };
}

/**
 * The replay options that play a preset in at its target: a tool failure, a result in place of the
 * recorded one, or a model call answered with an HTTP failure.
 */
export function presetReplay(preset: ChaosPreset, target: { callNo: number }, served?: { result: unknown }): Partial<ReplayOptions> {
  if (preset === 'timeout') return { toolFailures: new Map<number, ToolFailure>([[target.callNo, { kind: 'timeout' }]]) };
  if (preset === '429' || preset === '500') return { failAt: new Map([[target.callNo, Number(preset)]]) };
  if (!served) throw new Error(`the ${PRESET_LABELS[preset]} preset needs the result to serve`);
  return { overrides: new Map([[target.callNo, served.result]]) };
}
