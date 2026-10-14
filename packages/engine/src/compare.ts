import { canonicalize } from './canonical.js';
import { describeChanges, type RunChanges } from './changes.js';
import { normalizeConversation } from './conversation.js';
import { hintsFor, structuralDiff } from './diff.js';
import { pathOf } from './repeat.js';
import { finalAnswer } from './responses.js';
import { sha256 } from './ids.js';
import { loadApiRequest } from './manifest.js';
import type { Palette } from './report.js';
import { plain } from './report.js';
import { safeLine, safeText } from './text.js';
import type { Store } from './store.js';
import type { CallKind, CallRecord, DiffEntry, Hint, RunRecord } from './types.js';

/**
 * Two runs side by side, call by call: where their requests first differ, and where identical
 * requests got different answers (a live re-run's model output, a tool that returned something
 * else). Calls are aligned by position, so the comparison is sharpest for runs of the same agent.
 */
export interface CallDifference {
  callNo: number;
  kind: CallKind;
  name: string;
  /** For a request difference: the structural diff of the two requests and normalizer hints. */
  diff?: DiffEntry[];
  hints?: Hint[];
  /** For a response difference: a one-line description. */
  detail?: string;
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

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

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
function shapeOf(store: Store, calls: CallRecord[]): RunShape {
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

export function runChanges(store: Store, a: RunRecord, aCalls: CallRecord[], b: RunRecord, bCalls: CallRecord[]): RunChanges {
  const x = shapeOf(store, aCalls);
  const y = shapeOf(store, bCalls);
  const same = (p: Set<string>, q: Set<string>) => p.size === q.size && [...p].every((v) => q.has(v));
  return {
    systemPrompt: !same(x.systems, y.systems),
    tools: {
      added: [...y.tools.keys()].filter((t) => !x.tools.has(t)).sort(),
      removed: [...x.tools.keys()].filter((t) => !y.tools.has(t)).sort(),
      redefined: [...x.tools].some(([name, hash]) => y.tools.has(name) && y.tools.get(name) !== hash),
    },
    models: { a: [...x.models].sort(), b: [...y.models].sort() },
    code: { a: a.codeVersion, b: b.codeVersion },
  };
}


function request(store: Store, c: CallRecord): unknown {
  if (!c.requestRef) return null;
  return c.kind === 'api' ? loadApiRequest(store, c.requestRef) : store.getJson(c.requestRef);
}

function responseDetail(store: Store, x: CallRecord, y: CallRecord): string {
  if (x.kind === 'api') {
    const parts: string[] = [];
    const bx = x.end?.meta.bytes ?? store.getBlob(x.end?.responseRef ?? '')?.length ?? 0;
    const by = y.end?.meta.bytes ?? store.getBlob(y.end?.responseRef ?? '')?.length ?? 0;
    parts.push(`${bx} → ${by} bytes`);
    if (x.end?.meta.stopReason !== y.end?.meta.stopReason) parts.push(`stop ${x.end?.meta.stopReason ?? '?'} → ${y.end?.meta.stopReason ?? '?'}`);
    const ox = x.end?.meta.usage?.outputTokens;
    const oy = y.end?.meta.usage?.outputTokens;
    if (ox !== undefined && oy !== undefined && ox !== oy) parts.push(`${ox} → ${oy} output tokens`);
    if (x.end?.outcome !== y.end?.outcome) parts.push(`${x.end?.outcome ?? 'pending'} → ${y.end?.outcome ?? 'pending'}`);
    return parts.join(', ');
  }
  const rx = x.end?.responseRef ? store.getJson(x.end.responseRef) : null;
  const ry = y.end?.responseRef ? store.getJson(y.end.responseRef) : null;
  const d = structuralDiff(rx, ry);
  return d.length ? `${d.length} difference${d.length === 1 ? '' : 's'}, first at ${d[0]!.path}` : 'different bytes, same value';
}

function courseOf(store: Store, calls: CallRecord[], from: number): RunCourse {
  const rest = calls.slice(from);
  return { calls: rest.length, modelCalls: rest.filter((c) => c.kind === 'api').length, path: pathOf(rest, null), answer: finalAnswer(store, rest) || null };
}

export function compareRuns(store: Store, a: RunRecord, aCalls: CallRecord[], b: RunRecord, bCalls: CallRecord[]): RunComparison {
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
    const sameRequest = x.kind === y.kind && x.name === y.name && x.fingerprint === y.fingerprint;
    if (!sameRequest) {
      const diff = x.kind === y.kind && x.name === y.name ? structuralDiff(request(store, x), request(store, y)) : [{ path: '$', op: 'changed' as const, before: `${x.kind} ${x.name}`, after: `${y.kind} ${y.name}` }];
      const hints = diff.flatMap((e) => hintsFor(e, y.kind, y.name)).slice(0, 3);
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
      responseDifferences.push({ callNo: y.callNo, kind: y.kind, name: y.name, detail: responseDetail(store, x, y) });
    }
  }
  return {
    a: { runId: a.runId, calls: aCalls.length },
    b: { runId: b.runId, calls: bCalls.length },
    identicalPrefix,
    prefix,
    firstRequestDifference,
    responseDifferences,
    after,
    onlyInA: after ? 0 : Math.max(0, aCalls.length - n),
    onlyInB: after ? 0 : Math.max(0, bCalls.length - n),
    changes: runChanges(store, a, aCalls, b, bCalls),
  };
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
  if (c.responseDifferences.length) {
    lines.push(`  ${p.yellow('≠')} ${c.responseDifferences.length} call${c.responseDifferences.length === 1 ? '' : 's'} with the same request but a different response:`);
    for (const r of c.responseDifferences.slice(0, 12)) lines.push(`    #${r.callNo} ${r.kind} ${safeLine(r.name)}: ${safeLine(r.detail ?? '')}`);
    if (c.responseDifferences.length > 12) lines.push(p.dim(`    … ${c.responseDifferences.length - 12} more`));
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
