import { rewriteText, type RewriteObserver } from './normalize.js';
import type { Normalizer } from './types.js';

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

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One piece of streamed text: `holder[key]`, a string, is a piece of the run named `run`. */
export interface StreamPiece {
  run: string;
  holder: Record<string, unknown>;
  key: string;
}

/**
 * The pieces of streamed text one event of a provider's stream carries, in order: Anthropic's
 * content block deltas (Claude on Bedrock and Vertex too), OpenAI Chat Completions chunks (Azure and
 * compatible servers too), Responses API `….delta` events, Gemini and Vertex chunks, Bedrock
 * ConverseStream deltas, and other models' native streams on Bedrock.
 */
export function streamPieces(event: unknown): StreamPiece[] {
  if (!isObject(event)) return [];
  const out: StreamPiece[] = [];
  const add = (run: string, holder: unknown, key: string) => {
    if (isObject(holder) && typeof holder[key] === 'string') out.push({ run, holder, key });
  };
  const at = (v: unknown, fallback: number) => (typeof v === 'number' ? v : fallback);

  if ((event.type === 'content_block_start' || event.type === 'content_block_delta') && (isObject(event.content_block) || isObject(event.delta))) {
    const block = `anthropic ${at(event.index, 0)}`;
    const holder = event.type === 'content_block_start' ? event.content_block : event.delta;
    add(`${block} text`, holder, 'text');
    add(`${block} thinking`, holder, 'thinking');
    add(`${block} json`, holder, 'partial_json');
    return out;
  }
  if (Array.isArray(event.choices)) {
    event.choices.forEach((choice, n) => {
      if (!isObject(choice) || !isObject(choice.delta)) return;
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
    add(`${block} reasoning`, event.delta.reasoningContent, 'text');
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
 * place. Returns the indexes of the events it changed.
 */
export function maskStreamed(events: unknown[], rules: Normalizer[], observer?: RewriteObserver): Set<number> {
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

/** A line of an SSE body: a field (`data:`, `event:`, `id:`, `retry:`) or a comment. */
const FIELD = /^(?:data|event|id|retry):|^:/;

/**
 * A server-sent events body with its streamed text masked across events, or null when it is not one
 * or nothing changed. Strict on purpose: every line must be an SSE field, so no other text is taken
 * for a stream. Only the events whose pieces changed are written again (one `data:` line of JSON);
 * every other byte stays as it was, line endings included.
 */
export function maskSseStream(text: string, rules: Normalizer[], observer?: RewriteObserver): string | null {
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
  const changed = maskStreamed(
    blocks.map((b) => b.data),
    rules,
    observer,
  );
  if (!changed.size) return null;
  return blocks
    .map((b, i) => {
      if (!changed.has(i)) return b.body + b.sep;
      const eol = b.body.includes('\r\n') ? '\r\n' : b.body.includes('\r') ? '\r' : '\n';
      // The event's other fields stay where they were; its data becomes one line where the first was.
      const lines: string[] = [];
      let written = false;
      for (const line of b.body.split(/\r\n|\r|\n/)) {
        if (!line.startsWith('data:')) lines.push(line);
        else if (!written) {
          lines.push(`data: ${JSON.stringify(b.data)}`);
          written = true;
        }
      }
      return lines.join(eol) + b.sep;
    })
    .join('');
}

/**
 * A streamed response sent as one JSON array of chunks (Gemini's and Vertex's streamGenerateContent
 * without `alt=sse`), masked across its chunks; null when it is not one or nothing changed.
 */
export function maskJsonChunks(text: string, rules: Normalizer[], observer?: RewriteObserver): string | null {
  if (!text.trimStart().startsWith('[')) return null;
  let chunks: unknown;
  try {
    chunks = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(chunks) || !chunks.every(isObject)) return null;
  return maskStreamed(chunks, rules, observer).size ? JSON.stringify(chunks) : null;
}
