import { rewriteJsonDocument } from './json-doc.js';
import { compilePattern, countMatches, rewriteText, type RewriteObserver, type UnmaskedAt } from './normalize.js';
import type { Normalizer } from './types.js';
import { isObject } from './is-object.js';

/**
 * Streamed model responses send their text in pieces: an address the model writes back arrives as
 * "Sent to ma", "ya@exam", "ple.com", and a rule that reads one piece at a time never sees it. So
 * before the rules apply to a stream as text, each run of pieces (a content block's text, a tool
 * call's arguments, a candidate's text) is masked as the whole text it adds up to, and the masked
 * text is spread back over the same events: a piece nothing matched keeps its text, and the
 * replacement goes into the piece where the change starts, the rest of the change taken out of the
 * pieces after it. The text each run adds up to is then exactly the masked text, so every reader of
 * the stream (an SDK, the dashboard, a replay of the copy) sees the masked text.
 */

/** One piece of streamed text: `holder[key]`, a string, is a piece of the run named `run`. */
export interface StreamPiece {
  run: string;
  holder: Record<string, unknown>;
  key: string;
  /** A piece of signed reasoning (signed.ts): Anthropic's thinking, Converse's reasoning text. */
  signed: boolean;
}

/**
 * The pieces of streamed text one event of a provider's stream carries, in order: Anthropic's
 * content block deltas (Claude on Bedrock and Vertex too), OpenAI Chat Completions chunks (Azure and
 * compatible servers too) and text completions chunks, Responses API `….delta` events, Gemini and Vertex chunks, Bedrock
 * ConverseStream deltas, and other models' native streams on Bedrock.
 */
export function streamPieces(event: unknown): StreamPiece[] {
  if (!isObject(event)) return [];
  const out: StreamPiece[] = [];
  const add = (run: string, holder: unknown, key: string, signed = false) => {
    if (isObject(holder) && typeof holder[key] === 'string') out.push({ run, holder, key, signed });
  };
  const at = (v: unknown, fallback: number) => (typeof v === 'number' ? v : fallback);

  if ((event.type === 'content_block_start' || event.type === 'content_block_delta') && (isObject(event.content_block) || isObject(event.delta))) {
    const block = `anthropic ${at(event.index, 0)}`;
    const holder = event.type === 'content_block_start' ? event.content_block : event.delta;
    add(`${block} text`, holder, 'text');
    add(`${block} thinking`, holder, 'thinking', true);
    add(`${block} json`, holder, 'partial_json');
    return out;
  }
  if (Array.isArray(event.choices)) {
    event.choices.forEach((choice, n) => {
      if (!isObject(choice)) return;
      // A text completion's chunk (`/v1/completions`, which OpenAI-compatible servers such as vLLM
      // serve) carries its text in the choice itself, with no delta.
      if (!isObject(choice.delta)) return add(`completion ${at(choice.index, n)}`, choice, 'text');
      const c = `chat ${at(choice.index, n)}`;
      for (const key of ['content', 'reasoning_content', 'reasoning', 'refusal']) add(`${c} ${key}`, choice.delta, key);
      if (Array.isArray(choice.delta.tool_calls)) {
        choice.delta.tool_calls.forEach((call, k) => {
          if (isObject(call)) add(`${c} tool ${at(call.index, k)}`, call.function, 'arguments');
        });
      }
    });
    return out;
  }
  // Every Responses event that adds text ends in `.delta`; `response.audio.delta` adds audio in base64.
  if (typeof event.type === 'string' && event.type.startsWith('response.') && event.type.endsWith('.delta') && event.type !== 'response.audio.delta') {
    add(`responses ${event.type} ${String(event.item_id ?? event.output_index ?? '')} ${String(event.content_index ?? '')} ${String(event.summary_index ?? '')}`, event, 'delta');
    return out;
  }
  if (Array.isArray(event.candidates)) {
    event.candidates.forEach((candidate, n) => {
      if (!isObject(candidate) || !isObject(candidate.content) || !Array.isArray(candidate.content.parts)) return;
      const c = `gemini ${at(candidate.index, n)}`;
      for (const part of candidate.content.parts) if (isObject(part)) add(`${c} ${part.thought === true ? 'thought' : 'text'}`, part, 'text');
    });
    return out;
  }
  if (typeof event.contentBlockIndex === 'number' && isObject(event.delta)) {
    const block = `converse ${event.contentBlockIndex}`;
    add(`${block} text`, event.delta, 'text');
    add(`${block} tool`, event.delta.toolUse, 'input');
    add(`${block} reasoning`, event.delta.reasoningContent, 'text', true);
    return out;
  }
  // Text completions (Claude's legacy API), Llama and Titan on Bedrock: each event the text that follows.
  for (const key of ['completion', 'generation', 'outputText']) add(`native ${key}`, event, key);
  return out;
}

/**
 * `texts` (the pieces of one run, in order) with the pathless rules applied to the text they add up
 * to, spread back over the pieces; null when no rule matched. The observer hears each rule's change
 * to the whole text, as rewriteText reports one.
 */
export function maskAcross(texts: string[], rules: Normalizer[], observer?: RewriteObserver): string[] | null {
  let current = texts;
  rules.forEach((rule, i) => {
    if (rule.path !== undefined || rule.pattern === undefined) return;
    const before = current.join('');
    const after = rewriteText(before, [rule], observer?.changed ? { changed: (_, b, a, n) => observer.changed!(i, b, a, n) } : undefined);
    if (after !== before) current = spread(current, before, after);
  });
  return current === texts ? null : current;
}

const highSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const lowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/**
 * The pieces whose text adds up to `before`, changed so they add up to `after`: the part that
 * differs (between the longest common prefix and suffix) goes into the piece it starts in, and the
 * pieces it covered keep only what lies outside it.
 */
function spread(texts: string[], before: string, after: string): string[] {
  const max = Math.min(before.length, after.length);
  let p = 0;
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  // Never between the two halves of a character outside the Basic Multilingual Plane.
  if (p > 0 && highSurrogate(before.charCodeAt(p - 1))) p--;
  let s = 0;
  while (s < max - p && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) s++;
  if (s > 0 && lowSurrogate(before.charCodeAt(before.length - s))) s--;
  const end = before.length - s;
  const middle = after.slice(p, after.length - s);
  let into = texts.length - 1;
  for (let i = 0, b = 0; i < texts.length; i++) {
    b += texts[i]!.length;
    if (b > p) {
      into = i;
      break;
    }
  }
  const out: string[] = [];
  let a = 0;
  texts.forEach((text, i) => {
    const b = a + text.length;
    out.push((a < p ? before.slice(a, Math.min(b, p)) : '') + (i === into ? middle : '') + (b > end ? before.slice(Math.max(a, end), b) : ''));
    a = b;
  });
  return out;
}

/**
 * Masks the streamed text of `events` (parsed events of one response, in order) across events, in
 * place. Returns the indexes of the events it changed. `keepSigned`, for a copy that can be
 * replayed: a run of signed reasoning (a thinking block's text) stays as recorded, and the observer
 * hears what the rules without a path match in the text it adds up to (`signed`), in the event its
 * first piece is in.
 */
export function maskStreamed(events: unknown[], rules: Normalizer[], observer?: RewriteObserver, keepSigned = false): Set<number> {
  const runs = new Map<string, Array<{ event: number; piece: StreamPiece }>>();
  events.forEach((e, event) => {
    for (const piece of streamPieces(e)) {
      const pieces = runs.get(piece.run) ?? [];
      pieces.push({ event, piece });
      runs.set(piece.run, pieces);
    }
  });
  const changed = new Set<number>();
  for (const pieces of runs.values()) {
    if (keepSigned && pieces[0]!.piece.signed) {
      tellSigned(pieces.map(({ piece }) => piece.holder[piece.key] as string).join(''), rules, observer, pieces[0]!.event + 1);
      continue;
    }
    if (pieces.length < 2) continue; // one piece is masked as text with the rest of the stream
    const texts = pieces.map(({ piece }) => piece.holder[piece.key] as string);
    const masked = maskAcross(texts, rules, observer);
    if (!masked) continue;
    masked.forEach((text, k) => {
      if (text === texts[k]) return;
      const { event, piece } = pieces[k]!;
      piece.holder[piece.key] = text;
      changed.add(event);
    });
  }
  return changed;
}

/** What the rules without a path match in a text of signed reasoning a copy keeps, told to the observer. */
function tellSigned(text: string, rules: readonly Normalizer[], observer: RewriteObserver | undefined, event: number): void {
  if (!observer?.signed) return;
  rules.forEach((rule, i) => {
    if (rule.path !== undefined || rule.pattern === undefined) return;
    const count = countMatches(text, compilePattern(rule.pattern));
    if (count) observer.signed!(i, text, { what: 'string', path: [], event, signed: true }, count);
  });
}

/** A line of an SSE body: a field (`data:`, `event:`, `id:`, `retry:`) or a comment. */
const FIELD = /^(?:data|event|id|retry):|^:/;

/**
 * The observer for one event of a stream: what the rules leave in it is told with the event it is
 * in (from 1), since no path rule reaches into a stream's events.
 */
export function inEvent(observer: RewriteObserver | undefined, event: number): RewriteObserver | undefined {
  if (!observer?.unmasked && !observer?.signed) return observer;
  const { unmasked, signed } = observer;
  return {
    ...observer,
    ...(unmasked ? { unmasked: (rule: number, text: string, at: UnmaskedAt, count: number) => unmasked.call(observer, rule, text, { ...at, event }, count) } : {}),
    ...(signed ? { signed: (rule: number, text: string, at: UnmaskedAt, count: number) => signed.call(observer, rule, text, { ...at, event }, count) } : {}),
  };
}

/**
 * One event's data with the rules without a path applied: data that is JSON as a JSON document (its
 * strings, its numbers and layout kept), any other data (`[DONE]`) as text. `keepSigned` keeps its
 * signed reasoning as recorded (rewriteJsonDocument).
 */
export function maskEventData(data: string, rules: Normalizer[], observer: RewriteObserver | undefined, event: number, keepSigned = false): string {
  return rewriteJsonDocument(data, rules, null, inEvent(observer, event), keepSigned ? { stream: true } : undefined) ?? rewriteText(data, rules, observer);
}

/**
 * A server-sent events body with the rules without a path applied, or null when it is not one.
 * Strict on purpose: every line must be an SSE field, so no other text is taken for a stream. First
 * the streamed text is masked across events (maskStreamed), and an event whose pieces changed has
 * its data written again as one `data:` line of JSON. Then each event's data is masked as
 * maskEventData masks it, a JSON document by its strings, so a number in an event (a token count, a
 * time) stays as recorded and the event stays JSON; the other lines are masked as text. Every other
 * byte stays as it was, line endings included.
 */
export function maskSseStream(text: string, rules: Normalizer[], observer?: RewriteObserver, keepSigned = false): string | null {
  // A body whose first line is no field is no stream: said without reading the rest.
  const first = /^[^\r\n]*/.exec(text)![0];
  if (first !== '' && !FIELD.test(first)) return null;
  const blocks: Array<{ body: string; sep: string; data: unknown }> = [];
  const boundary = /\r\n\r\n|\n\n|\r\r/g;
  let from = 0;
  const take = (body: string, sep: string): boolean => {
    const lines = body.split(/\r\n|\r|\n/);
    if (!lines.every((l) => l === '' || FIELD.test(l))) return false;
    const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, ''));
    let parsed: unknown;
    if (data.length) {
      try {
        parsed = JSON.parse(data.join('\n'));
      } catch {
        parsed = undefined;
      }
    }
    blocks.push({ body, sep, data: parsed });
    return true;
  };
  for (let m = boundary.exec(text); m; m = boundary.exec(text)) {
    if (!take(text.slice(from, m.index), m[0])) return null;
    from = m.index + m[0].length;
  }
  // A stream cut short ends without its blank line.
  if (from < text.length && !take(text.slice(from), '')) return null;
  if (!blocks.some((b) => b.data !== undefined)) return null;
  const across = maskStreamed(
    blocks.map((b) => b.data),
    rules,
    observer,
    keepSigned,
  );
  const isData = (line: string) => line.startsWith('data:');
  const prefix = (line: string) => (line.startsWith('data: ') ? 'data: ' : 'data:');
  return blocks
    .map((b, i) => {
      // Lines and the line endings between them, as they were: [line, eol, line, eol, …, line].
      const parts = b.body.split(/(\r\n|\r|\n)/);
      const lines = parts.filter((_, k) => k % 2 === 0);
      const data = lines.filter(isData);
      const other = (line: string) => rewriteText(line, rules, observer);
      let payload: string[] | null = null;
      if (across.has(i)) payload = [maskEventData(JSON.stringify(b.data), rules, observer, i + 1, keepSigned)];
      else if (data.length) {
        const joined = data.map((l) => l.slice(prefix(l).length)).join('\n');
        const masked = maskEventData(joined, rules, observer, i + 1, keepSigned);
        if (masked !== joined) payload = masked.split('\n');
      }
      if (!payload || (!across.has(i) && payload.length === data.length)) {
        // The same lines: each keeps its prefix and its line ending.
        let d = 0;
        for (let k = 0; k < parts.length; k += 2) parts[k] = isData(parts[k]!) ? (payload ? prefix(parts[k]!) + payload[d++]! : parts[k]!) : other(parts[k]!);
        return parts.join('') + b.sep;
      }
      // The data written again where its first line was (one line of JSON), the other fields where they were.
      const eol = b.body.includes('\r\n') ? '\r\n' : b.body.includes('\r') ? '\r' : '\n';
      const out: string[] = [];
      let written = false;
      for (const line of lines) {
        if (!isData(line)) out.push(other(line));
        else if (!written) {
          out.push(...payload.map((piece) => `data: ${piece}`));
          written = true;
        }
      }
      return out.join(eol) + b.sep;
    })
    .join('');
}

/**
 * A streamed response sent as one JSON array of chunks (Gemini's and Vertex's streamGenerateContent
 * without `alt=sse`), masked across its chunks; null when it is not one or nothing changed.
 */
export function maskJsonChunks(text: string, rules: Normalizer[], observer?: RewriteObserver, keepSigned = false): string | null {
  if (!text.trimStart().startsWith('[')) return null;
  let chunks: unknown;
  try {
    chunks = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(chunks) || !chunks.every(isObject)) return null;
  return maskStreamed(chunks, rules, observer, keepSigned).size ? JSON.stringify(chunks) : null;
}
