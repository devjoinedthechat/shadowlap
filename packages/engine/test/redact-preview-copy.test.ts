import { describe, expect, it } from 'vitest';
import { encodeEventStreamFrame, eventStreamFrames } from '../src/eventstream.js';
import { loadApiRequest, storeApiRequest } from '../src/manifest.js';
import { compilePattern, normalizerApplies } from '../src/normalize.js';
import { clipChange, previewRedaction, redactRun } from '../src/redact.js';
import { Store } from '../src/store.js';
import type { CallKind, Normalizer, SerializedError } from '../src/types.js';

/**
 * The preview counts exactly what a copy changes. Over fixtures and generated JSON documents
 * (strings with addresses, cards and escapes of every kind; numbers as they were written, card-long
 * ones among them; nested objects and lists; keys; layouts with all sorts of whitespace) and
 * streamed responses, each rule's count and two samples are worked out again from what redactRun
 * wrote, read with a tokenizer of this file's own: the copy made with the rules up to that one,
 * against the copy made with the rules before it. What each rule matches that the copy leaves as
 * it is comes from the numbers and keys the copy still holds.
 */

const cmd = { argv: ['node', 'agent.js'], cwd: '/tmp' };

// ---- reading a copy back, by this file's own reader ----

interface Token {
  /** A string (`value` decoded, `key` when a colon follows), a number as written, true/false/null, or punctuation. */
  t: 's' | 'n' | 'l' | 'p';
  raw: string;
  value?: string;
  key?: boolean;
}

/** A JSON text's tokens. Outside its strings, valid JSON holds only these and whitespace. */
function tokens(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\]:,]/g)) {
    const raw = m[0];
    out.push(raw.startsWith('"') ? { t: 's', raw, value: JSON.parse(raw) as string } : /^[-\d]/.test(raw) ? { t: 'n', raw } : /^[a-z]/.test(raw) ? { t: 'l', raw } : { t: 'p', raw });
  }
  out.forEach((tok, i) => tok.t === 's' && out[i + 1]?.raw === ':' && (tok.key = true));
  return out;
}

/** The end of the value that starts at `i` (a container to its closing bracket). */
function valueEnd(toks: Token[], i: number): number {
  if (toks[i].raw !== '{' && toks[i].raw !== '[') return i + 1;
  let depth = 0;
  for (let j = i; j < toks.length; j++) {
    if (toks[j].raw === '{' || toks[j].raw === '[') depth++;
    else if (toks[j].raw === '}' || toks[j].raw === ']') depth--;
    if (depth === 0) return j + 1;
  }
  throw new Error('unbalanced');
}

/**
 * What changed from one JSON text to the other, in the order of the text: a string rewritten, or a
 * value put in place of another (a number, an object, a list) by a rule with a path.
 */
function changes(before: string, after: string): Array<{ before: unknown; after: unknown }> {
  const a = tokens(before);
  const b = tokens(after);
  const out: Array<{ before: unknown; after: unknown }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a[i];
    const y = b[j];
    if (x.raw === y.raw) {
      i++;
      j++;
      continue;
    }
    if (y.t !== 's') throw new Error(`a copy only ever writes a string where a value was: ${x.raw} became ${y.raw}`);
    const end = valueEnd(a, i);
    out.push({ before: x.t === 's' ? x.value : JSON.parse(a.slice(i, end).map((t) => t.raw).join('')), after: y.value });
    i = end;
    j++;
  }
  if (i !== a.length || j !== b.length) throw new Error('the copy has another shape');
  return out;
}

/** The text a model streamed in an SSE body, an array of chunks or an event stream: its pieces, joined. */
function streamedText(body: Buffer): string {
  const pieces: string[] = [];
  const take = (event: unknown) => {
    const e = event as Record<string, any>;
    if (typeof e?.delta?.text === 'string') pieces.push(e.delta.text);
    if (typeof e?.delta?.partial_json === 'string') pieces.push(e.delta.partial_json);
    for (const c of e?.choices ?? []) {
      if (typeof c?.delta?.content === 'string') pieces.push(c.delta.content);
      for (const call of c?.delta?.tool_calls ?? []) if (typeof call?.function?.arguments === 'string') pieces.push(call.function.arguments);
    }
    for (const c of e?.candidates ?? []) for (const part of c?.content?.parts ?? []) if (typeof part?.text === 'string') pieces.push(part.text);
    if (typeof e?.bytes === 'string') take(JSON.parse(Buffer.from(e.bytes, 'base64').toString('utf8')));
  };
  const frames = eventStreamFrames(body);
  if (frames) for (const f of frames) take(JSON.parse(f.payload.toString('utf8')));
  else {
    const text = body.toString('utf8');
    if (text.trimStart().startsWith('[')) for (const chunk of JSON.parse(text) as unknown[]) take(chunk);
    else for (const line of text.split('\n')) if (line.startsWith('data: ') && line !== 'data: [DONE]') take(JSON.parse(line.slice(6)));
  }
  return pieces.join('');
}

/** How often `marker` is in a streamed body as its readers read it: SSE or an array of chunks as text, an event stream's payloads, a base64 chunk decoded. */
function occurrences(body: Buffer, marker: string): number {
  const n = (s: string) => s.split(marker).length - 1;
  const frames = eventStreamFrames(body);
  if (!frames) return n(body.toString('utf8'));
  let total = 0;
  for (const f of frames) {
    const text = f.payload.toString('utf8');
    total += n(text);
    const e = JSON.parse(text) as { bytes?: unknown };
    if (typeof e.bytes === 'string') total += n(Buffer.from(e.bytes, 'base64').toString('utf8'));
  }
  return total;
}

// ---- the documents a run holds, as the copy writes them ----

interface Doc {
  callNo: number;
  kind: CallKind;
  name: string;
  in: 'request' | 'response' | 'error';
  /** The document's JSON text; empty when there is none, or the bytes are no JSON document. */
  text: string;
  /** A streamed response, counted by what replaced each match: its bytes. */
  stream: Buffer | null;
  /** A streamed response's events that are JSON, each as its text: an SSE event's data, an event stream frame's payload (and the event a base64 chunk holds). */
  events: string[];
}

/** The JSON text of each event of a stream, as a reader of the stream reads it. */
function eventTexts(body: Buffer): string[] {
  const out: string[] = [];
  const add = (text: string) => {
    try {
      const e = JSON.parse(text) as { bytes?: unknown };
      out.push(text);
      if (e && typeof e.bytes === 'string') add(Buffer.from(e.bytes, 'base64').toString('utf8'));
    } catch {
      // [DONE], or text that is no JSON
    }
  };
  const frames = eventStreamFrames(body);
  if (frames) for (const f of frames) add(f.payload.toString('utf8'));
  else for (const block of body.toString('utf8').split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, ''));
    if (data.length) add(data.join('\n'));
  }
  return out;
}

/** A streamed model response: an SSE body, an event stream, or Gemini's array of chunks (which is a JSON document too). */
function isStream(bytes: Buffer, text: string | null): boolean {
  if (text === null) return true;
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) && parsed.some((x) => typeof x === 'object' && x !== null && 'candidates' in x);
  } catch {
    return true;
  }
}

/** Every document a store holds for a run, in the order the preview reads them: each call's request, then each attempt's response and error. */
function docs(store: Store, runId: string): Doc[] {
  const out: Doc[] = [];
  for (const c of store.getCalls(runId)) {
    const at = { callNo: c.callNo, kind: c.kind, name: c.name };
    if (c.requestRef) out.push({ ...at, in: 'request', text: JSON.stringify(c.kind === 'api' ? loadApiRequest(store, c.requestRef) : store.getJson(c.requestRef)), stream: null, events: [] });
    for (const e of [...c.attempts, ...(c.end ? [c.end] : [])]) {
      const bytes = e.responseRef ? store.getBlob(e.responseRef)! : null;
      const utf8 = bytes && Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes) ? bytes.toString('utf8') : null;
      let json = utf8 !== null;
      try {
        if (utf8 !== null) JSON.parse(utf8);
      } catch {
        json = false;
      }
      const stream = bytes && isStream(bytes, utf8) ? bytes : null;
      out.push({ ...at, in: 'response', text: json ? utf8! : '', stream, events: stream && !json ? eventTexts(stream) : [] });
      out.push({ ...at, in: 'error', text: e.meta.error ? JSON.stringify(e.meta.error) : '', stream: null, events: [] });
    }
  }
  return out;
}

/** A copy of the run made with `rules`, read back: a pack's, or with `read` a copy that is only read (export html). */
function copyWith(src: Store, runId: string, rules: Normalizer[], read = false): { docs: Doc[]; store: Store } {
  const dst = Store.open(':memory:');
  redactRun(src, runId, rules, dst, { read });
  return { docs: docs(dst, runId), store: dst };
}

const shown = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

/**
 * What the preview should say, worked out from the copies: for rule k, the changes between the pack
 * made with the rules before it and the pack made with it too, each value once in the order read,
 * counted as its matches (or 1 for a value a path rule puts in place of another), with the first
 * two as samples. The streams are counted by the replacements in the copy, which each rule here
 * makes unique. A rule's `returned` is worked out the same way from the copies that are read (export
 * html), in what calls got back: what the pack leaves there. Then what each rule without a path
 * matches in the numbers the last pack holds, and in the keys of its requests and errors.
 */
function expected(src: Store, runId: string, rules: Normalizer[]) {
  const copies = [{ docs: docs(src, runId), store: null as Store | null }, ...rules.map((_, k) => copyWith(src, runId, rules.slice(0, k + 1)))];
  const read = [copies[0], ...rules.map((_, k) => copyWith(src, runId, rules.slice(0, k + 1), true))];
  const changed = (rule: Normalizer, before: Doc[], after: Doc[], only: (doc: Doc) => boolean) => {
    const seen = new Set<string>();
    let count = 0;
    const samples: Array<{ before: string; after: string }> = [];
    const regex = rule.pattern === undefined ? null : compilePattern(rule.pattern);
    before.forEach((doc, d) => {
      if (!only(doc)) return;
      const next = after[d];
      if (doc.stream) {
        // Each replacement leaves the rule's own replacement in the stream, once.
        count += occurrences(next.stream!, rule.replace) - occurrences(doc.stream, rule.replace);
        return;
      }
      if (!doc.text) return;
      for (const c of changes(doc.text, next.text)) {
        const key = shown(c.before);
        if (seen.has(key)) continue;
        seen.add(key);
        regex && (regex.lastIndex = 0);
        count += regex ? (shown(c.before).match(regex)?.length ?? 0) : 1;
        if (samples.length < 2) samples.push(clipChange(shown(c.before), shown(c.after)));
      }
    });
    return { count, samples };
  };
  const out = rules.map((rule, k) => ({
    ...changed(rule, copies[k].docs, copies[k + 1].docs, () => true),
    returned: rule.path === undefined ? { count: 0, samples: [] } : changed(rule, read[k].docs, read[k + 1].docs, (doc) => doc.in !== 'request'),
  }));
  const last = copies[copies.length - 1];
  const unmasked = rules.map((rule) => {
    const values = new Map<string, number>();
    if (rule.path !== undefined || rule.pattern === undefined) return { count: 0, values: [] as string[] };
    const regex = compilePattern(rule.pattern);
    for (const doc of last.docs) {
      // A rule without a path reads a request only in its scope; every response and error, and every event of a stream.
      if (doc.in === 'request' && !normalizerApplies(rule, doc.kind, doc.name)) continue;
      for (const tok of [doc.text, ...doc.events].flatMap((t) => (t ? tokens(t) : []))) {
        const key = tok.t === 's' && tok.key && doc.in !== 'response';
        if (tok.t !== 'n' && !key) continue;
        const text = key ? tok.value! : tok.raw;
        const n = text.match(regex)?.length ?? 0;
        const id = `${key ? 'k' : 'v'}${text}`;
        if (n && !values.has(id)) values.set(id, n);
      }
    }
    return { count: [...values.values()].reduce((s, n) => s + n, 0), values: [...values.keys()].map((v) => v.slice(1)) };
  });
  for (const c of [...copies, ...read]) c.store?.close();
  return { rules: out, unmasked };
}

// ---- generated documents ----

/** mulberry32: the same documents on every run of the test. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Esc = 'json' | 'unicode' | 'slash';
type Str = { s: string; esc: Esc };
type J = Str | { n: string } | { l: 'true' | 'false' | 'null' } | { a: J[] } | { o: Array<[Str, J]> };
interface Layout {
  indent: string;
  colon: string;
  comma: string;
  eol: string;
  pad: string;
}
const LAYOUTS: Layout[] = [
  { indent: '', colon: ':', comma: ',', eol: '\n', pad: '' },
  { indent: '  ', colon: ': ', comma: ',', eol: '\n', pad: '' },
  { indent: '\t', colon: ' : ', comma: ' ,', eol: '\r\n', pad: ' ' },
  { indent: '', colon: ' :  ', comma: ' , ', eol: '\n', pad: '  ' },
];

/** A string as JSON writes it, every character past letters, digits and spaces as \u escapes, or with its slashes escaped. */
function writeString(s: string, esc: Esc): string {
  if (esc === 'json') return JSON.stringify(s);
  if (esc === 'slash') return JSON.stringify(s).replace(/\//g, '\\/');
  let out = '"';
  for (let i = 0; i < s.length; i++) out += /[A-Za-z0-9 ]/.test(s[i]) ? s[i] : `\\u${s.charCodeAt(i).toString(16).padStart(4, '0')}`;
  return `${out}"`;
}

function write(j: J, l: Layout, depth = 0): string {
  if ('s' in j) return writeString(j.s, j.esc);
  if ('n' in j) return j.n;
  if ('l' in j) return j.l;
  const at = (d: number) => (l.indent ? l.eol + l.indent.repeat(d) : l.pad);
  const items = 'a' in j ? j.a.map((x) => write(x, l, depth + 1)) : j.o.map(([k, v]) => writeString(k.s, k.esc) + l.colon + write(v, l, depth + 1));
  const [open, close] = 'a' in j ? ['[', ']'] : ['{', '}'];
  return items.length ? `${open}${items.map((x) => at(depth + 1) + x).join(l.comma)}${at(depth)}${close}` : `${open}${l.pad}${close}`;
}

/** The value a document's reader gets: what an agent stores as a request. */
function value(j: J): unknown {
  if ('s' in j) return j.s;
  if ('n' in j || 'l' in j) return JSON.parse('n' in j ? j.n : j.l);
  if ('a' in j) return j.a.map(value);
  return Object.fromEntries(j.o.map(([k, v]) => [k.s, value(v)]));
}

function generator(seed: number) {
  const r = random(seed);
  const int = (n: number) => Math.floor(r() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)];
  let unique = 0;
  const WORDS = ['refund', 'order', 'the policy', 'customer', 'café', 'naïve', '😀', 'line\nbreak', 'tab\there', 'a "quote"', 'back\\slash', 'slash/ed', ' ', 'ctl\u0001'];
  const secret = () =>
    pick([
      () => `user${unique++}@example.com`,
      () => `4111 1111 1111 ${1000 + int(9000)}`,
      () => `order ${100 + int(900)}`,
      () => `at ${1_700_000_000_000 + int(1e11)}`,
      () => `acct-${int(1e6)}`,
    ])();
  const text = () => Array.from({ length: 1 + int(5) }, () => (r() < 0.45 ? secret() : pick(WORDS))).join(pick([' ', ', ', ': ', '']));
  const number = () =>
    pick([
      () => String(4_000_000_000_000_000 + int(1e15)),
      () => String(1_700_000_000_000 + int(1e11)),
      () => String(int(1000)),
      () => `-${int(100)}.${int(100)}`,
      () => `${1 + int(9)}.${int(10)}e${int(5)}`,
      () => `${1 + int(9)}E-${int(9)}`,
      () => '12345678901234567890',
      () => '-0',
    ])();
  const KEYS = ['id', 'amount', 'note', 'card', 'owner', 'items', '4111111111111111', 'bob@example.com', 'order 417', 'a"b', 'x\\y', '', 'é', 'acct-7'];
  const esc = (): Esc => pick(['json', 'json', 'unicode', 'slash'] as const);
  const str = (s: string): Str => ({ s, esc: esc() });
  const node = (depth: number): J => {
    const roll = r();
    if (depth > 3 || roll < 0.35) return r() < 0.55 ? str(text()) : r() < 0.85 ? { n: number() } : { l: pick(['true', 'false', 'null'] as const) };
    if (roll < 0.6) return { a: Array.from({ length: int(4) }, () => node(depth + 1)) };
    return { o: Array.from({ length: int(5) }, (): [Str, J] => [str(r() < 0.7 ? pick(KEYS) : text()), node(depth + 1)]) };
  };
  return { r, int, pick, text, number, node, str, layout: () => pick(LAYOUTS) };
}

/** A run of generated calls: a conversation whose answers are JSON documents, tools with results and errors of every shape, a clock and a random read. */
function generatedRun(store: Store, seed: number): string {
  const g = generator(seed);
  const run = store.createRun({ mode: 'record', command: cmd });
  let callNo = 0;
  const add = (kind: CallKind, name: string, request: unknown, ends: Array<{ body: string; error?: SerializedError }>) => {
    callNo++;
    const id = { kind, name, fingerprint: `${seed}-${callNo}`.padStart(64, '0'), occurrence: 1 };
    store.appendCallStart({ runId: run.runId, callNo, ...id, origin: 'live', effect: kind === 'tool' ? 'read' : null, requestRef: kind === 'api' ? storeApiRequest(store, request) : store.putJson(request), meta: {}, at: callNo });
    ends.forEach((e, attempt) => store.appendCallEnd(id, { runId: run.runId, callNo, attempt, responseRef: store.putBlob(Buffer.from(e.body)), outcome: e.error ? 'error' : 'ok', meta: e.error ? { error: e.error } : {}, at: callNo }));
  };
  const messages: unknown[] = [];
  for (let i = 0; i < 4; i++) {
    messages.push({ role: 'user', content: g.text() });
    const user = `${(seed * 7919 + i).toString(16).padStart(8, '0').slice(-8)}-3b7d-4bad-9bdd-2b0d7b3dcb6${i}`;
    const answer: J = {
      o: [
        [g.str('id'), g.str(`msg_${seed}_${i}`)],
        [g.str('content'), { a: [{ o: [[g.str('type'), g.str('text')], [g.str('text'), g.str(g.text())]] }] }],
        [g.str('usage'), { o: [[g.str('input_tokens'), { n: g.number() }]] }],
        [g.str('extra'), g.node(1)],
      ],
    };
    add('api', 'POST /v1/messages', { model: 'm', max_tokens: 1024, metadata: { user_id: user, n: JSON.parse(g.number()) as number }, system: g.text(), messages: [...messages] }, [{ body: write(answer, g.layout()) }]);
    messages.push({ role: 'assistant', content: (value(answer) as { content: unknown }).content });
  }
  for (let i = 0; i < 5; i++) {
    const ends: Array<{ body: string; error?: SerializedError }> = [];
    if (g.r() < 0.4) {
      const error = { name: 'Error', message: g.text(), data: value(g.node(1)) };
      ends.push({ body: JSON.stringify({ error }), error });
    }
    const result: J = { o: [[g.str('result'), g.r() < 0.5 ? { o: [[g.str('card'), g.r() < 0.5 ? { n: g.number() } : g.node(2)], [g.str('note'), g.str(g.text())]] } : g.node(0)]] };
    ends.push({ body: `${g.r() < 0.3 ? ' \n' : ''}${write(result, g.layout())}${g.r() < 0.3 ? '\n' : ''}` });
    add('tool', g.pick(['lookup', 'charge', 'notify']), { args: value(g.node(0)) }, ends);
  }
  add('clock', 'now', { label: 'now' }, [{ body: `{"result":${1_700_000_000_000 + g.int(1e11)}}` }]);
  add('random', 'uuid', { label: 'uuid' }, [{ body: '{"result":"9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"}' }]);
  store.endRun(run.runId, 'completed');
  return run.runId;
}

const RULES: Normalizer[] = [
  { pattern: 'email', replace: '<EMAIL>' },
  { pattern: '/\\b(?:\\d[ -]?){13,16}\\b/', replace: '<CARD>' },
  // Scoped: a tool's requests, and every response and error, as a rule without a path always reads them.
  { kind: 'tool', pattern: '/\\border \\d{3}\\b/', replace: '<ORDER>' },
  { pattern: '/acct-\\d+/', replace: '<ACCT>' },
  { kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' },
  // Whole values at a path in what calls got back, numbers and objects included.
  { kind: 'tool', name: 'lookup', path: '$.result.card', replace: '<CARDNO>' },
  { kind: 'api', path: '$.usage.input_tokens', replace: '<TOKENS>' },
];

/** The preview of the run against what the copies say it should be. Samples from a stream are checked apart. */
function compare(store: Store, runId: string, rules: Normalizer[], o: { samples?: boolean } = {}) {
  const preview = previewRedaction(store, runId, rules);
  const want = expected(store, runId, rules);
  preview.rules.forEach((r, k) => {
    expect({ rule: k + 1, count: r.count }).toEqual({ rule: k + 1, count: want.rules[k].count });
    if (o.samples !== false) expect({ rule: k + 1, samples: r.samples }).toEqual({ rule: k + 1, samples: want.rules[k].samples });
    expect({ rule: k + 1, unmasked: r.unmasked.count, values: r.unmasked.samples.map((s) => s.value) }).toEqual({ rule: k + 1, unmasked: want.unmasked[k].count, values: want.unmasked[k].values.slice(0, 2) });
    expect({ rule: k + 1, returned: r.returned }).toEqual({ rule: k + 1, returned: want.rules[k].returned });
  });
  expect(preview.total).toBe(want.rules.reduce((s, r) => s + r.count, 0));
  expect(preview.returned).toBe(want.rules.reduce((s, r) => s + r.returned.count, 0));
  return preview;
}

describe('the preview, against the copy', () => {
  it('counts and samples what the copy changes in generated documents, every rule alone and all together', () => {
    let changed = 0;
    let returned = 0;
    let unmasked = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const store = Store.open(':memory:');
      const runId = generatedRun(store, seed);
      for (const rule of RULES) compare(store, runId, [rule]);
      const all = compare(store, runId, RULES);
      changed += all.total;
      returned += all.returned;
      unmasked += all.unmasked;
      store.close();
    }
    // The documents did hold what the rules are about, numbers they match, and values at the paths
    // that only a copy that is read masks.
    expect(changed).toBeGreaterThan(300);
    expect(returned).toBeGreaterThan(30);
    expect(unmasked).toBeGreaterThan(30);
  });

  it('counts what the copy changes in streamed responses: an SSE stream, chat chunks, an array of chunks and a Bedrock event stream', () => {
    const store = Store.open(':memory:');
    const run = store.createRun({ mode: 'record', command: cmd });
    const sse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
    const text = (t: string) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });
    const frame = (payload: unknown) => {
      const name = Buffer.from(':event-type');
      const value = Buffer.from('chunk');
      const header = Buffer.concat([Buffer.from([name.length]), name, Buffer.from([7, 0, value.length]), value]);
      return encodeEventStreamFrame(header, Buffer.from(JSON.stringify(payload)));
    };
    const bodies = [
      // Anthropic: an address and a card split across deltas, a time in one piece, an order in a tool
      // call's JSON; and a count in an event that a card pattern matches, which stays a number.
      sse([{ type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 1792155242518 } } }, text('Mail ma'), text('ya@exam'), text('ple.com about card 4111 11'), text('11 1111 2222 at 1792155242516.'), { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"note":"order 4' } }, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '17 for acct-99"}' } }]),
      // OpenAI chat chunks: the content and a tool call's arguments in pieces.
      sse([{ choices: [{ index: 0, delta: { content: 'Write to lee@exa' } }] }, { choices: [{ index: 0, delta: { content: 'mple.com now' } }] }, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"to":"kim@' } }] } }] }, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'example.com"}' } }] } }] }]) + 'data: [DONE]\n\n',
      // Gemini's array of chunks.
      JSON.stringify([{ candidates: [{ content: { parts: [{ text: 'Card 5500 0000 ' }] } }] }, { candidates: [{ content: { parts: [{ text: '0000 0004 for joe@example.com' }] } }], usageMetadata: { totalTokenCount: 1792155242517 } }]),
    ];
    bodies.forEach((body, i) => {
      const id = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: String(i).padStart(64, 'e'), occurrence: 1 };
      store.appendCallStart({ runId: run.runId, callNo: i + 1, ...id, origin: 'live', effect: null, requestRef: storeApiRequest(store, { model: 'm', messages: [{ role: 'user', content: `Go ${i}.` }] }), meta: {}, at: i });
      store.appendCallEnd(id, { runId: run.runId, callNo: i + 1, attempt: 0, responseRef: store.putBlob(Buffer.from(body)), outcome: 'ok', meta: {}, at: i });
    });
    // Bedrock: InvokeModelWithResponseStream's base64 chunks, and ConverseStream's events as they are.
    const bedrock = Buffer.concat([
      frame({ bytes: Buffer.from(JSON.stringify(text('Paid by ann@exa'))).toString('base64') }),
      frame({ bytes: Buffer.from(JSON.stringify(text('mple.com, acct-12'))).toString('base64') }),
      frame({ contentBlockIndex: 0, delta: { text: 'order 512 for bea@example.com' } }),
      // ConverseStream's metadata, and a chunk's own usage: numbers a card pattern matches.
      frame({ metadata: { usage: { inputTokens: 12 }, metrics: { latencyMs: 1792155242519 } } }),
      frame({ bytes: Buffer.from(JSON.stringify({ type: 'message_delta', usage: { output_tokens: 1792155242520 } })).toString('base64') }),
    ]);
    const id = { kind: 'api' as const, name: 'POST /model/x/invoke-with-response-stream', fingerprint: 'b'.repeat(64), occurrence: 1 };
    store.appendCallStart({ runId: run.runId, callNo: 4, ...id, origin: 'live', effect: null, requestRef: storeApiRequest(store, { messages: [{ role: 'user', content: 'Go.' }] }), meta: {}, at: 4 });
    store.appendCallEnd(id, { runId: run.runId, callNo: 4, attempt: 0, responseRef: store.putBlob(bedrock), outcome: 'ok', meta: {}, at: 4 });
    store.endRun(run.runId, 'completed');

    const rules = RULES.filter((r) => r.path === undefined);
    const preview = compare(store, run.runId, rules, { samples: false });
    // Each value a stream splits counts once, as the copy masks it. Addresses: maya, lee and kim,
    // joe, ann and bea. Cards: two in the first stream (its time is text there), one in the chunks.
    expect(preview.rules.map((r) => r.count)).toEqual([6, 3, 2, 2]);
    // The numbers the events carry as numbers stay, and the preview says so, with the event each is
    // in (the array of chunks is one JSON document, its first position the chunk).
    const card = preview.rules[1].unmasked;
    expect(card.count).toBe(4);
    expect(card.samples).toEqual([
      { value: '1792155242518', key: false, callNo: 1, kind: 'api', name: 'POST /v1/messages', in: 'response', path: '$.message.usage.input_tokens', event: 1 },
      { value: '1792155242517', key: false, callNo: 3, kind: 'api', name: 'POST /v1/messages', in: 'response', path: '$[1].usageMetadata.totalTokenCount', event: null },
    ]);
    expect(card.reasons).toEqual(['stream']);
    // The copy holds none of what was matched in text, and every event is JSON still.
    const copy = copyWith(store, run.runId, rules);
    const all = copy.docs.map((d) => (d.stream ? streamedText(d.stream) : d.text)).join('\n');
    expect(all).not.toMatch(/@example|4111|5500|acct-\d|order \d|1792155242516/);
    const events = copy.docs.flatMap((d) => d.events);
    expect(events.length).toBeGreaterThan(10);
    expect(events.join('\n')).toContain('"input_tokens":1792155242518');
    expect(events.join('\n')).toContain('"latencyMs":1792155242519');
    expect(events.join('\n')).toContain('"output_tokens":1792155242520');
    for (const d of copy.docs.filter((x) => x.stream)) {
      const frames = eventStreamFrames(d.stream!);
      if (frames) for (const f of frames) expect(() => JSON.parse(f.payload.toString('utf8'))).not.toThrow();
      else for (const line of d.stream!.toString('utf8').split('\n')) if (line.startsWith('data: ') && line !== 'data: [DONE]') expect(() => JSON.parse(line.slice(6)), line).not.toThrow();
    }
    copy.store.close();
    // A sample is the text the model streamed, as it adds up, before and after the rule.
    const streamed = 'Mail maya@example.com about card 4111 1111 1111 2222 at 1792155242516.';
    expect(preview.rules[0].samples[0]).toEqual(clipChange(streamed, streamed.replace('maya@example.com', '<EMAIL>')));
    store.close();
  });
});
