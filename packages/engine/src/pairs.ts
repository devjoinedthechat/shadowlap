import { describeBlocks } from './blame.js';
import { canonicalize } from './canonical.js';
import { normalizeConversation, type Turn, type TurnBlock } from './conversation.js';
import { messagesOf, type DatasetMessage } from './dataset.js';
import type { Block } from './deltas.js';
import { sha256 } from './ids.js';
import { loadApiRequest } from './manifest.js';
import { applyNormalizers, compilePattern } from './normalize.js';
import { normalizeResponse } from './responses.js';
import type { Store } from './store.js';
import { openAITools } from './translate.js';
import type { CallRecord, Normalizer, RunRecord } from './types.js';

/**
 * Preference pairs, read from what blame, verify and `--repeat` already left in the store. A pair is
 * two answers to the same conversation: one that lost the run, one that went on to pass. Nothing is
 * collected for it; the attempts are runs like any other.
 *
 * - **High:** blame asked the blamed call again and the run passed. Each passing attempt's answer
 *   there is paired with the recorded one, which lost the run: that answer decided it.
 * - **Medium:** verify ran a recording several times and some attempts passed while others failed.
 *   A failing and a passing attempt are paired at the first model call where their answers differ.
 *   Nothing checked that this answer decided the run, only that the runs parted there. `--repeat`
 *   attempts carry nothing but their exit status, so they pair the same way, by exit status, when
 *   both outcomes exist.
 *
 * Identical answers count once, across every source: a verify that finds the two answers a blame
 * already paired adds nothing, and the pair stays high. Two answers only make a pair when they
 * answer the same conversation: attempts whose paths parted before their answers did (a live read
 * that returned something else) make none, and neither does an answer that also passed, from the
 * same point, in another attempt.
 */

export type PairConfidence = 'high' | 'medium';
export type PairSourceKind = 'blame' | 'verify' | 'repeat';

export interface PairAnswer {
  /** The run the answer was given in: the recording, for blame's rejected answer; otherwise an attempt. */
  runId: string;
  callNo: number;
  /** Where it came from: `the recording`, `blame attempt, passed`, `verify attempt, failed`. */
  what: string;
  /** The answer in one line: its text and its tool calls with their arguments. */
  text: string;
  /** The answer without thinking, which the model that wrote it is the only one able to read. */
  blocks: Block[];
}

export interface Pair {
  /** Stable for the same two answers to the same conversation, whichever source made them: `pr-` and 12 hex digits. */
  id: string;
  confidence: PairConfidence;
  /** The source's key (see PairSource). */
  source: string;
  sourceKind: PairSourceKind;
  /** The run the pair is about: the blamed run, or the run verify or `--repeat` replayed. */
  runId: string;
  /** The model call the answers answer, in the rejected answer's run. */
  callNo: number;
  /** The conversation at that call in one line: what was asked, and the last thing the model saw. */
  context: string;
  model: string | null;
  rejected: PairAnswer;
  chosen: PairAnswer;
  /** When the chosen answer was given. */
  at: number;
}

export interface PairSource {
  /** `blame:<run>`, `verify:<invocation>` or `repeat:<group>`. */
  key: string;
  kind: PairSourceKind;
  /** The blamed run, the first run verify replayed, or the run `--repeat` replayed. */
  runId: string;
  /** Every run the source replayed (verify replays several). */
  runIds: string[];
  /** `blame · refund-bug`, `verify · 370712a+dirty`, `replay --repeat 5 · 01K5CQ4N7G`. */
  label: string;
  confidence: PairConfidence;
  /** Pairs it made. */
  made: number;
  /** Attempts it ran that are still in the store. */
  attempts: number;
  /** For blame, the blamed call; otherwise the first call a pair came from, or null. */
  callNo: number | null;
  /** Why it made what it made, in a sentence or two. */
  why: string;
  at: number;
}

export interface PairsResult {
  pairs: Pair[];
  sources: PairSource[];
}

type ModelCall = CallRecord & { end: NonNullable<CallRecord['end']> };

const squash = (s: string) => s.trim().replace(/\s+/g, ' ');
const short = (id: string) => id.slice(0, 10);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A run as a source names it: its first label, or its short id. */
function runName(run: RunRecord): string {
  return run.meta?.labels?.[0] ?? short(run.runId);
}

/** The same conversation whatever ids, whitespace and reasoning the attempts carried. */
function conversationKey(turns: Turn[], tools: string[]): string {
  const reduced = turns
    .map((t) => ({
      r: t.role,
      b: t.blocks.flatMap((b: TurnBlock): unknown[] => {
        if (b.type === 'thinking') return [];
        if (b.type === 'text') return squash(b.text) ? [{ t: squash(b.text) }] : [];
        if (b.type === 'tool_call') return [{ c: b.name, i: b.input ?? {} }];
        if (b.type === 'tool_result') return [{ res: squash(b.content), e: b.isError === true }];
        return [{ o: b.label }];
      }),
    }))
    .filter((t) => t.b.length);
  return sha256(canonicalize({ turns: reduced, tools }));
}

/** The same answer whatever ids, whitespace and reasoning came with it; '' for one with nothing to say. */
function answerKey(blocks: readonly Block[]): string {
  const parts = blocks.flatMap((b): unknown[] => (b.type === 'text' ? (squash(b.text) ? [{ t: squash(b.text) }] : []) : b.type === 'tool_call' ? [{ c: b.name, i: b.input ?? {} }] : []));
  return parts.length ? canonicalize(parts) : '';
}

const cut = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 1)}…` : s);

/**
 * A conversation in one line: what it was about (the first thing the user said) and the last thing
 * the model saw before answering (a tool's result, or what the user said last).
 */
export function contextLine(turns: readonly Turn[], width = 140): string {
  const texts = (t: Turn) => t.blocks.flatMap((b) => (b.type === 'text' && squash(b.text) ? [squash(b.text)] : []));
  const users = turns.filter((t) => t.role === 'user' && texts(t).length);
  const first = users[0] ? texts(users[0]).join(' ') : '';
  const names = new Map<string, string>();
  for (const t of turns) for (const b of t.blocks) if (b.type === 'tool_call' && b.id) names.set(b.id, b.name);
  let last = '';
  for (let i = turns.length - 1; i >= 0 && !last; i--) {
    const t = turns[i]!;
    if (t.role === 'assistant' || t.role === 'system') continue;
    const results = t.blocks.filter((b): b is Extract<TurnBlock, { type: 'tool_result' }> => b.type === 'tool_result');
    const r = results.at(-1);
    if (r) {
      const name = r.name ?? (r.id ? names.get(r.id) : undefined) ?? 'a tool';
      last = `${name} returned ${squash(r.content) || '(nothing)'}`;
    } else if (t !== users[0] && texts(t).length) last = `then: ${texts(t).join(' ')}`;
  }
  if (!first && !last) return '(an empty conversation)';
  const head = cut(first || '(no user message)', last ? Math.max(40, Math.floor(width * 0.45)) : width);
  return last ? cut(`${head} · ${last}`, width) : head;
}

/** Reads what pairs need from the store once: calls, conversations and answers. */
class Reader {
  private readonly calls = new Map<string, CallRecord[]>();
  private readonly prompts = new Map<string, { key: string; turns: Turn[] } | null>();
  private readonly answers = new Map<string, Block[]>();
  constructor(readonly store: Store) {}

  callsOf(runId: string): CallRecord[] {
    let calls = this.calls.get(runId);
    if (!calls) this.calls.set(runId, (calls = this.store.getCalls(runId)));
    return calls;
  }

  /** The run's model calls that were answered, in order. */
  modelCalls(runId: string): ModelCall[] {
    return this.callsOf(runId).filter((c): c is ModelCall => c.kind === 'api' && !!c.requestRef && c.end !== null && c.end.outcome === 'ok' && !!c.end.responseRef);
  }

  modelCall(runId: string, callNo: number): ModelCall | null {
    return this.modelCalls(runId).find((c) => c.callNo === callNo) ?? null;
  }

  prompt(call: ModelCall): { key: string; turns: Turn[] } | null {
    const ref = call.requestRef!;
    if (!this.prompts.has(ref)) {
      let value: { key: string; turns: Turn[] } | null = null;
      try {
        const conv = normalizeConversation(loadApiRequest(this.store, ref));
        if (conv) value = { key: conversationKey(conv.turns, conv.tools), turns: conv.turns };
      } catch {
        value = null;
      }
      this.prompts.set(ref, value);
    }
    return this.prompts.get(ref) ?? null;
  }

  answer(call: ModelCall): Block[] {
    const ref = call.end.responseRef!;
    const provider = call.end.meta.provider ?? call.meta.provider;
    const key = `${ref}:${typeof provider === 'string' ? provider : ''}`;
    let blocks = this.answers.get(key);
    if (!blocks) {
      try {
        blocks = normalizeResponse(this.store.getBlob(ref), call.end.meta.headers?.['content-type'], call.end.meta.chunks ?? [], typeof provider === 'string' ? provider : undefined).blocks.filter((b) => b.type !== 'thinking');
      } catch {
        blocks = [];
      }
      this.answers.set(key, blocks);
    }
    return blocks;
  }

  modelOf(call: ModelCall): string | null {
    const m = call.end.meta.model ?? call.meta.model;
    return typeof m === 'string' ? m : null;
  }
}

interface Candidate {
  rejected: { run: RunRecord; call: ModelCall; what: string };
  chosen: { run: RunRecord; call: ModelCall; what: string };
}

/** The first model call where two attempts answered the same conversation differently. */
function firstDifference(r: Reader, a: RunRecord, b: RunRecord): { kind: 'pair'; i: number; ca: ModelCall; cb: ModelCall } | { kind: 'same' } | { kind: 'paths'; at: number } {
  const ma = r.modelCalls(a.runId);
  const mb = r.modelCalls(b.runId);
  for (let i = 0; i < Math.min(ma.length, mb.length); i++) {
    const ca = ma[i]!;
    const cb = mb[i]!;
    const pa = r.prompt(ca);
    const pb = r.prompt(cb);
    if (!pa || !pb || pa.key !== pb.key) return { kind: 'paths', at: ca.callNo };
    if (answerKey(r.answer(ca)) !== answerKey(r.answer(cb))) return { kind: 'pair', i, ca, cb };
  }
  return { kind: 'same' };
}

function answerOf(r: Reader, run: RunRecord, call: ModelCall, what: string): PairAnswer {
  const blocks = r.answer(call);
  return { runId: run.runId, callNo: call.callNo, what, text: describeBlocks(blocks, 160), blocks };
}

function makePair(r: Reader, source: PairSource, about: RunRecord, c: Candidate): Pair | null {
  const prompt = r.prompt(c.rejected.call);
  if (!prompt) return null;
  const rejected = answerOf(r, c.rejected.run, c.rejected.call, c.rejected.what);
  const chosen = answerOf(r, c.chosen.run, c.chosen.call, c.chosen.what);
  const rk = answerKey(rejected.blocks);
  const ck = answerKey(chosen.blocks);
  return {
    // Without the source: the same two answers to the same conversation are one pair, however many found them.
    id: `pr-${sha256(`${prompt.key}|${rk}|${ck}`).slice(0, 12)}`,
    confidence: source.confidence,
    source: source.key,
    sourceKind: source.kind,
    runId: about.runId,
    callNo: c.rejected.call.callNo,
    context: contextLine(prompt.turns),
    model: r.modelOf(c.rejected.call),
    rejected,
    chosen,
    at: c.chosen.run.startedAt,
  };
}

/**
 * Pairs between the failing and passing attempts of one run (verify) or one `--repeat` invocation.
 * Each failing attempt meets each passing one at the first model call where their answers differ;
 * the pair is kept unless the "rejected" answer also passed from the same point in another attempt,
 * or the "chosen" one also failed from it.
 */
function contrast(r: Reader, failing: RunRecord[], passing: RunRecord[], whatFailed: (run: RunRecord) => string, whatPassed: (run: RunRecord) => string) {
  const answersAt = (runs: RunRecord[]) => {
    const seen = new Map<string, Set<string>>();
    for (const run of runs) {
      for (const call of r.modelCalls(run.runId)) {
        const p = r.prompt(call);
        if (!p) continue;
        let set = seen.get(p.key);
        if (!set) seen.set(p.key, (set = new Set()));
        set.add(answerKey(r.answer(call)));
      }
    }
    return seen;
  };
  const passed = answersAt(passing);
  const failed = answersAt(failing);
  const out: Candidate[] = [];
  let same = 0;
  let paths = 0;
  let ambiguous = 0;
  for (const f of failing) {
    for (const p of passing) {
      const d = firstDifference(r, f, p);
      if (d.kind === 'same') {
        same++;
        continue;
      }
      if (d.kind === 'paths') {
        paths++;
        continue;
      }
      const prompt = r.prompt(d.ca)!.key;
      const rk = answerKey(r.answer(d.ca));
      const ck = answerKey(r.answer(d.cb));
      if (!rk || !ck || passed.get(prompt)?.has(rk) || failed.get(prompt)?.has(ck)) {
        ambiguous++;
        continue;
      }
      out.push({ rejected: { run: f, call: d.ca, what: whatFailed(f) }, chosen: { run: p, call: d.cb, what: whatPassed(p) } });
    }
  }
  return { candidates: out, same, paths, ambiguous };
}

/**
 * Adds candidates as pairs, counting identical ones once across every source: the first source to
 * find a pair keeps it (blame before verify before --repeat, so a pair blame proved stays high).
 * Returns how many were new, and how many another source had already made.
 */
function addPairs(r: Reader, pairs: Pair[], seen: Map<string, PairSource>, source: PairSource, about: RunRecord, candidates: Candidate[]): { made: number; elsewhere: number } {
  let made = 0;
  let elsewhere = 0;
  for (const c of candidates) {
    const pair = makePair(r, source, about, c);
    if (!pair) continue;
    const owner = seen.get(pair.id);
    if (owner) {
      if (owner !== source) elsewhere++;
      continue;
    }
    seen.set(pair.id, source);
    pairs.push(pair);
    made++;
  }
  return { made, elsewhere };
}

const already = (n: number) => `${n === 1 ? 'One pair was' : `${n} pairs were`} already made by another source, so ${n === 1 ? 'it counts' : 'they count'} once.`;

/** The invocation a verify attempt belongs to: its group, without the run id verify appends per run. */
function verifyInvocation(run: RunRecord): string {
  const group = run.meta?.repeat?.group;
  const parent = run.parentRunId ?? '';
  if (!group) return `${parent}:${run.codeVersion ?? ''}`;
  return group.endsWith(`-${parent}`) ? group.slice(0, -(parent.length + 1)) : group;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

/** Every pair the attempts in the store make, and every source read, including those that made none. */
export function findPairs(store: Store, options: { runs?: RunRecord[] } = {}): PairsResult {
  const runs = options.runs ?? store.allRuns();
  const byId = new Map(runs.map((x) => [x.runId, x]));
  const r = new Reader(store);
  const pairs: Pair[] = [];
  const sources: PairSource[] = [];
  const seen = new Map<string, PairSource>();
  const byStart = (a: RunRecord, b: RunRecord) => a.startedAt - b.startedAt || a.runId.localeCompare(b.runId);

  // ---- blame: high ----
  const probes = new Map<string, RunRecord[]>();
  for (const run of runs) {
    const of = run.meta?.probe?.of;
    if (of) probes.set(of, [...(probes.get(of) ?? []), run]);
  }
  for (const run of runs) {
    const blame = run.meta?.blame;
    if (!blame) continue;
    const attempts = (probes.get(run.runId) ?? []).sort(byStart);
    const source: PairSource = { key: `blame:${run.runId}`, kind: 'blame', runId: run.runId, runIds: [run.runId], label: `blame · ${runName(run)}`, confidence: 'high', made: 0, attempts: attempts.length, callNo: blame.callNo, why: '', at: blame.at };
    sources.push(source);
    if (blame.outcome !== 'blamed' || blame.callNo === null) {
      source.why = blame.outcome === 'unrescuable' ? 'Not rescued from any model call: no answer made the run pass, so there is none to prefer.' : 'The search stopped before it settled, so no call was blamed.';
      continue;
    }
    const k = blame.callNo;
    const recorded = r.modelCall(run.runId, k);
    const prompt = recorded && r.prompt(recorded);
    if (!recorded || !prompt) {
      source.why = `The recording's answer at #${k} can't be read, so there is nothing to pair it with.`;
      continue;
    }
    const rejectedKey = answerKey(r.answer(recorded));
    const passing = attempts.filter((a) => a.meta?.probe?.callNo === k && a.meta.probe.passed);
    let same = 0;
    let parted = 0;
    const candidates: Candidate[] = [];
    for (const a of passing) {
      const call = r.modelCall(a.runId, k);
      const p = call && r.prompt(call);
      if (!call || !p || p.key !== prompt.key) {
        parted++;
        continue;
      }
      const key = answerKey(r.answer(call));
      if (!key || key === rejectedKey) {
        same++;
        continue;
      }
      candidates.push({ rejected: { run, call: recorded, what: 'the recording' }, chosen: { run: a, call, what: 'blame attempt, passed' } });
    }
    if (!rejectedKey) {
      source.why = `The recording's answer at #${k} has no text or tool call, so there is nothing to pair it with.`;
      continue;
    }
    const added = addPairs(r, pairs, seen, source, run, candidates);
    source.made = added.made;
    const differing = candidates.length;
    if (source.made) {
      const dup = differing - source.made - added.elsewhere;
      source.why = `Probe #${k} rescued the run: ${plural(differing, 'attempt')} passed after a different answer at #${k}.${dup ? ` ${dup === 1 ? 'One' : dup} answered like another, so ${dup === 1 ? 'it counts' : 'they count'} once.` : ''}${added.elsewhere ? ` ${already(added.elsewhere)}` : ''}${same ? ` ${plural(same, 'attempt')} that passed answered as the recording did.` : ''}`;
    } else if (added.elsewhere) {
      source.why = `Probe #${k} rescued the run, but another source had already made ${added.elsewhere === 1 ? 'the pair' : `all ${added.elsewhere} pairs`} its attempts make: identical answers count once.`;
    } else if (!passing.length) {
      source.why = `No attempt that passed at #${k} is in the store any more.`;
    } else if (parted === passing.length) {
      source.why = `The attempts that passed at #${k} saw another conversation than the recording, so their answers don't answer the same question.`;
    } else {
      source.why = `Every attempt that passed at #${k} answered as the recording did, so there is nothing to contrast.`;
    }
  }

  // ---- verify: medium ----
  const invocations = new Map<string, RunRecord[]>();
  for (const run of runs) {
    if (!run.meta?.verify || !run.parentRunId) continue;
    const key = verifyInvocation(run);
    invocations.set(key, [...(invocations.get(key) ?? []), run]);
  }
  for (const [key, attempts] of invocations) {
    attempts.sort(byStart);
    const byRun = new Map<string, RunRecord[]>();
    for (const a of attempts) byRun.set(a.parentRunId!, [...(byRun.get(a.parentRunId!) ?? []), a]);
    const first = attempts[0]!;
    const versions = [...new Set(attempts.map((a) => a.codeVersion).filter((v): v is string => !!v))];
    const source: PairSource = { key: `verify:${key}`, kind: 'verify', runId: first.parentRunId!, runIds: [...byRun.keys()], label: `verify · ${versions[0] ?? day(first.startedAt)}`, confidence: 'medium', made: 0, attempts: attempts.length, callNo: null, why: '', at: first.startedAt };
    sources.push(source);
    const mixed: string[] = [];
    let same = 0;
    let paths = 0;
    let ambiguous = 0;
    let elsewhere = 0;
    for (const [runId, list] of byRun) {
      const failing = list.filter((a) => a.meta?.verify?.passed === false);
      const passing = list.filter((a) => a.meta?.verify?.passed === true);
      if (!failing.length || !passing.length) continue;
      const role = list[0]!.meta?.verify?.role ?? 'target';
      mixed.push(`${role === 'holdout' ? 'held-out' : role} ${short(runId)} failed ${failing.length} of ${list.length}`);
      const c = contrast(r, failing, passing, () => 'verify attempt, failed', () => 'verify attempt, passed');
      same += c.same;
      paths += c.paths;
      ambiguous += c.ambiguous;
      const about = byId.get(runId) ?? store.getRun(runId);
      if (!about) continue;
      const before = pairs.length;
      const added = addPairs(r, pairs, seen, source, about, c.candidates);
      source.made += added.made;
      elsewhere += added.elsewhere;
      if (source.callNo === null && pairs.length > before) source.callNo = pairs[before]!.callNo;
    }
    source.why = whyContrast(mixed, { same, paths, ambiguous, elsewhere }, source.made, 'No run both passed and failed: each passed every attempt or none.');
  }

  // ---- --repeat: medium, by exit status ----
  const groups = new Map<string, RunRecord[]>();
  for (const run of runs) {
    const m = run.meta;
    if (!m?.repeat || m.probe || m.verify || m.task || m.test) continue;
    groups.set(m.repeat.group, [...(groups.get(m.repeat.group) ?? []), run]);
  }
  for (const [group, attempts] of groups) {
    attempts.sort(byStart);
    const first = attempts[0]!;
    const parentId = first.parentRunId ?? first.runId;
    const finished = attempts.filter((a) => a.status === 'completed' || a.status === 'failed');
    const passing = finished.filter((a) => a.status === 'completed');
    const failing = finished.filter((a) => a.status === 'failed');
    const of = first.meta?.repeat?.of ?? attempts.length;
    const source: PairSource = { key: `repeat:${group}`, kind: 'repeat', runId: parentId, runIds: [parentId], label: `replay --repeat ${of} · ${short(parentId)}`, confidence: 'medium', made: 0, attempts: attempts.length, callNo: null, why: '', at: first.startedAt };
    sources.push(source);
    if (!failing.length || !passing.length) {
      source.why = !finished.length ? 'No attempt finished, so there is nothing to contrast.' : !failing.length ? `${finished.length === 1 ? 'The attempt' : `All ${finished.length} attempts`} exited 0, so there is nothing to contrast.` : `${finished.length === 1 ? 'The attempt' : `All ${finished.length} attempts`} exited with an error, so there is nothing to contrast.`;
      continue;
    }
    const c = contrast(r, failing, passing, (a) => `attempt, ${a.status === 'failed' ? 'exited with an error' : 'failed'}`, () => 'attempt, exited 0');
    const about = byId.get(parentId) ?? store.getRun(parentId) ?? first;
    const before = pairs.length;
    const added = addPairs(r, pairs, seen, source, about, c.candidates);
    source.made = added.made;
    if (pairs.length > before) source.callNo = pairs[before]!.callNo;
    source.why = whyContrast([`${failing.length} of ${finished.length} attempts exited with an error`], { same: c.same, paths: c.paths, ambiguous: c.ambiguous, elsewhere: added.elsewhere }, source.made, '');
  }

  const kindOrder: Record<PairSourceKind, number> = { blame: 0, verify: 1, repeat: 2 };
  sources.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || b.at - a.at);
  const order = new Map(sources.map((s, i) => [s.key, i]));
  pairs.sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === 'high' ? -1 : 1) || order.get(a.source)! - order.get(b.source)! || a.callNo - b.callNo || a.at - b.at);
  return { pairs, sources };
}

function whyContrast(mixed: string[], n: { same: number; paths: number; ambiguous: number; elsewhere: number }, made: number, none: string): string {
  if (!mixed.length) return none;
  const lines = [`${mixed.join('; ')}.`.replace(/^./, (c) => c.toUpperCase())];
  if (made) lines.push(`Pairs come from the first model call where a failing and a passing attempt answered differently.`);
  if (n.same) lines.push(`${n.same === 1 ? 'Once' : `${n.same} times`} a failing attempt answered every model call as a passing one did: its failure wasn't an answer.`);
  if (n.paths) lines.push(`${n.paths === 1 ? 'Once' : `${n.paths} times`} the attempts saw different conversations before their answers differed, as when a live read returns something else.`);
  if (n.ambiguous) lines.push(`${plural(n.ambiguous, 'answer')} left out: the same answer, from the same point, also passed (or failed) elsewhere.`);
  if (n.elsewhere) lines.push(already(n.elsewhere));
  return lines.join(' ');
}

/** How many pairs there are at each confidence. */
export function countPairs(pairs: readonly Pair[]): { all: number; high: number; medium: number } {
  const high = pairs.filter((p) => p.confidence === 'high').length;
  return { all: pairs.length, high, medium: pairs.length - high };
}

// ---- export ----

export type PairFormat = 'openai-preference' | 'trl';
export const PAIR_FORMATS: PairFormat[] = ['openai-preference', 'trl'];

/** Each format's row, in one line, for the command that writes it. */
export const PAIR_SHAPES: Record<PairFormat, string> = {
  'openai-preference': '{ input: { messages, tools }, preferred_output, non_preferred_output }',
  trl: '{ prompt, chosen, rejected }, as chat messages (with tools when the conversation had them)',
};

export interface PairRowsOptions {
  format: PairFormat;
  /** The project's redaction rules (see redactConversation). */
  redact?: Normalizer[];
}

type Rule = Normalizer & { path: string };

/**
 * Redaction for rows that keep only messages (decision 6): rules without a path apply to every
 * string; rules with a path apply to the message fields kept. A model-call rule's path is a path into
 * the request, so it is applied to the request before its messages are read; a tool rule's
 * `$.args…` path applies to each call of that tool in the conversation and the answers, and its
 * `$.result…` path to the tool's results that are JSON.
 */
function pathRules(rules: readonly Normalizer[]): { api: Rule[]; args: Rule[]; result: Rule[] } {
  const withPath = rules.filter((x): x is Rule => typeof x.path === 'string');
  return {
    api: withPath.filter((x) => x.kind === undefined || x.kind === 'api'),
    args: withPath.filter((x) => x.kind === 'tool' && /^\$\.args(\.|\[|$)/.test(x.path)),
    result: withPath.filter((x) => x.kind === 'tool' && /^\$\.result(\.|\[|$)/.test(x.path)),
  };
}

function redactArgs(name: string, input: unknown, rules: Rule[]): unknown {
  return rules.length ? (applyNormalizers({ args: input }, rules, 'tool', name) as { args: unknown }).args : input;
}

function redactResult(name: string, content: string, rules: Rule[]): string {
  if (!rules.length) return content;
  try {
    const parsed = JSON.parse(content) as unknown;
    return JSON.stringify((applyNormalizers({ result: parsed }, rules, 'tool', name) as { result: unknown }).result);
  } catch {
    return content; // not JSON: a path can't point into it
  }
}

function redactTurns(turns: Turn[], rules: ReturnType<typeof pathRules>): Turn[] {
  if (!rules.args.length && !rules.result.length) return turns;
  const names = new Map<string, string>();
  return turns.map((t) => ({
    ...t,
    blocks: t.blocks.map((b): TurnBlock => {
      if (b.type === 'tool_call') {
        if (b.id) names.set(b.id, b.name);
        return { ...b, input: redactArgs(b.name, b.input, rules.args) };
      }
      if (b.type === 'tool_result') {
        const name = b.name ?? (b.id ? names.get(b.id) : undefined);
        return name ? { ...b, content: redactResult(name, b.content, rules.result) } : b;
      }
      return b;
    }),
  }));
}

function redactDeep(value: unknown, rules: Array<{ re: RegExp; replace: string }>): unknown {
  if (typeof value === 'string') return rules.reduce((s, x) => ((x.re.lastIndex = 0), s.replace(x.re, x.replace)), value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, rules));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, rules)]));
  return value;
}

type ChatMessage = Record<string, unknown>;

/** Dataset messages as OpenAI chat messages: tool call arguments as JSON text. */
function openAIMessage(m: DatasetMessage): ChatMessage {
  if (m.role === 'assistant' && m.tool_calls?.length) {
    return { role: 'assistant', ...(m.content ? { content: m.content } : {}), tool_calls: m.tool_calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } })) };
  }
  if (m.role === 'tool') return { role: 'tool', content: m.content, ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}) };
  return { role: m.role, content: m.content };
}

/** Dataset messages as Hugging Face chat messages, which TRL's chat templates read: arguments as objects, tool results named. */
function hfMessage(m: DatasetMessage, names: Map<string, string>): ChatMessage {
  if (m.role === 'assistant' && m.tool_calls?.length) {
    for (const c of m.tool_calls) names.set(c.id, c.name);
    return { role: 'assistant', content: m.content, tool_calls: m.tool_calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments ?? {} } })) };
  }
  if (m.role === 'tool') {
    const name = m.tool_call_id ? names.get(m.tool_call_id) : undefined;
    return { role: 'tool', content: m.content, ...(name ? { name } : {}), ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}) };
  }
  return { role: m.role, content: m.content };
}

function answerMessage(answer: PairAnswer, rules: ReturnType<typeof pathRules>): DatasetMessage {
  const text = answer.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
  const calls = answer.blocks.flatMap((b, i) => (b.type === 'tool_call' ? [{ id: b.id ?? `answer_${i + 1}`, name: b.name, arguments: redactArgs(b.name, b.input, rules.args) }] : []));
  return { role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}) };
}

/**
 * Pairs as rows to train on: the conversation as the model saw it at the call, in the provider-
 * neutral messages `export dataset` writes, and the two answers. Rows whose request can't be read
 * are left out.
 */
export function pairRows(store: Store, pairs: readonly Pair[], options: PairRowsOptions): unknown[] {
  const rules = options.redact ?? [];
  const paths = pathRules(rules);
  const pathless = rules.filter((x) => x.path === undefined && x.pattern !== undefined).map((x) => ({ re: compilePattern(x.pattern!), replace: x.replace }));
  const rows: unknown[] = [];
  const calls = new Map<string, CallRecord[]>();
  for (const pair of pairs) {
    let runCalls = calls.get(pair.rejected.runId);
    if (!runCalls) calls.set(pair.rejected.runId, (runCalls = store.getCalls(pair.rejected.runId)));
    const call = runCalls.find((c) => c.callNo === pair.rejected.callNo);
    if (!call?.requestRef) continue;
    let body: unknown;
    try {
      body = loadApiRequest(store, call.requestRef);
    } catch {
      continue;
    }
    if (paths.api.length) body = applyNormalizers(body, paths.api, 'api', call.name);
    const conv = normalizeConversation(body);
    if (!conv) continue;
    const messages = messagesOf(redactTurns(conv.turns, paths));
    const tools = openAITools(body);
    const chosen = answerMessage(pair.chosen, paths);
    const rejected = answerMessage(pair.rejected, paths);
    let row: unknown;
    if (options.format === 'trl') {
      const names = new Map<string, string>();
      const prompt = messages.map((m) => hfMessage(m, names));
      row = { prompt, chosen: [hfMessage(chosen, new Map(names))], rejected: [hfMessage(rejected, new Map(names))], ...(tools.length ? { tools } : {}) };
    } else {
      row = { input: { messages: messages.map(openAIMessage), ...(tools.length ? { tools } : {}) }, preferred_output: [openAIMessage(chosen)], non_preferred_output: [openAIMessage(rejected)] };
    }
    rows.push(pathless.length ? redactDeep(row, pathless) : row);
  }
  return rows;
}
