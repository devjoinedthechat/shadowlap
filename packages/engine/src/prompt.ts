import { canonicalize } from './canonical.js';
import { stripKeysDeep } from './normalize.js';

/**
 * `--prompt-from <call>`: test a changed system prompt or tool set from a later model call, not from
 * the first. Editing the prompt changes every request, so a plain replay forks at call 1 and re-runs
 * everything. With this, model calls before the chosen one are matched without their system prompt
 * and tool definitions, so they replay from the recording; the chosen call runs live, and from there
 * the model sees the new prompt with the recorded history before it. It answers "what if the prompt
 * had been this from step k", not "what if it had always been this": steps before k were answered
 * under the old prompt, and the report says so.
 *
 * The decision diff (`shadowlap decisions --from-code`) uses the same split the other way round: what
 * `withoutPrompt` leaves out of a request is its prompt (`promptOf`), and `withPrompt` puts another
 * one in its place, so a recorded request is asked again with only the prompt the code sends now.
 */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInstruction = (m: unknown) => isObject(m) && (m.role === 'system' || m.role === 'developer');

/**
 * The top-level fields that carry a request's prompt, in every provider's shape: Anthropic and Bedrock
 * Converse `system`, OpenAI Responses `instructions`, Gemini `systemInstruction` (`system_instruction`
 * over REST), and the tool definitions with Gemini's and Converse's tool config.
 */
const PROMPT_FIELDS = ['system', 'instructions', 'systemInstruction', 'system_instruction', 'tools', 'toolConfig', 'tool_config'] as const;

/** A request without what counts as its prompt: system instructions and tool definitions, in any provider's shape. */
export function withoutPrompt(body: unknown): unknown {
  if (!isObject(body)) return body;
  const out: Record<string, unknown> = { ...body };
  for (const key of PROMPT_FIELDS) delete out[key];
  // OpenAI Chat Completions and Responses carry instructions as messages.
  if (Array.isArray(out.messages)) out.messages = out.messages.filter((m) => !isInstruction(m));
  if (Array.isArray(out.input)) out.input = out.input.filter((m) => !isInstruction(m));
  return out;
}

// ---- the prompt itself: taken out of one request, put into another ----

/** What `withoutPrompt` takes out of a request, kept so it can be put into another one. */
export interface RequestPrompt {
  /** The prompt fields the request had (`system`, `tools`, …), as it had them. */
  fields: Record<string, unknown>;
  /** The system and developer messages a Chat Completions or Responses conversation starts with, in order. */
  leading: unknown[];
}

/** The list of turns that carries instruction messages: Chat Completions' `messages`, Responses' `input`. */
function turnsKey(body: Record<string, unknown>): 'messages' | 'input' | null {
  if (Array.isArray(body.messages)) return 'messages';
  if (Array.isArray(body.input)) return 'input';
  return null;
}

/** How many instruction messages a list of turns starts with. */
function leadingCount(turns: readonly unknown[]): number {
  let n = 0;
  while (n < turns.length && isInstruction(turns[n])) n++;
  return n;
}

/**
 * A request's prompt: its prompt fields, and the instruction messages its conversation starts with.
 * An instruction message later in the conversation (one `--inject` added, a reminder the agent
 * sends at step 9) is part of the conversation, not the prompt.
 */
export function promptOf(body: unknown): RequestPrompt {
  const prompt: RequestPrompt = { fields: {}, leading: [] };
  if (!isObject(body)) return prompt;
  for (const key of PROMPT_FIELDS) if (body[key] !== undefined) prompt.fields[key] = body[key];
  const key = turnsKey(body);
  if (key) {
    const turns = body[key] as unknown[];
    prompt.leading = turns.slice(0, leadingCount(turns));
  }
  return prompt;
}

/**
 * The request with `prompt` in place of its own: its prompt fields replaced by the ones `prompt` has
 * (a field `prompt` lacks is left out), and the instruction messages it starts with replaced by
 * `prompt`'s. Everything else, the conversation, the model and its settings, stays as it was, and so
 * do the cache breakpoints its messages carry.
 */
export function withPrompt(body: unknown, prompt: RequestPrompt): unknown {
  if (!isObject(body)) return body;
  const out: Record<string, unknown> = {};
  // The prompt fields go where the request had them, so the body reads as the agent wrote it.
  for (const [k, v] of Object.entries(body)) {
    if ((PROMPT_FIELDS as readonly string[]).includes(k)) {
      if (prompt.fields[k] !== undefined) out[k] = prompt.fields[k];
    } else out[k] = v;
  }
  for (const [k, v] of Object.entries(prompt.fields)) if (!(k in out)) out[k] = v;
  const key = turnsKey(out);
  if (key) {
    const turns = out[key] as unknown[];
    out[key] = [...prompt.leading, ...turns.slice(leadingCount(turns))];
  } else if (prompt.leading.length && typeof out.input === 'string') {
    // A Responses request whose input is one string: the instructions go before it, as messages.
    out.input = [...prompt.leading, { role: 'user', content: out.input }];
  }
  return out;
}

/** The same prompt, cache breakpoints aside: a `cache_control` marker says nothing to the model. */
export function samePrompt(a: RequestPrompt, b: RequestPrompt): boolean {
  const key = (p: RequestPrompt) => canonicalize(stripKeysDeep({ fields: p.fields, leading: p.leading }, ['cache_control']));
  return key(a) === key(b);
}

/** A prompt's instructions as text, and its tools by name, for a report to say what changed. */
export function promptParts(prompt: RequestPrompt): { instructions: string; tools: string[] } {
  const texts: string[] = [];
  const text = (v: unknown): void => {
    if (typeof v === 'string') texts.push(v);
    else if (Array.isArray(v)) v.forEach(text);
    else if (isObject(v)) {
      if (typeof v.text === 'string') texts.push(v.text);
      else if (v.content !== undefined) text(v.content);
      else if (Array.isArray(v.parts)) text(v.parts);
    }
  };
  for (const k of ['system', 'instructions', 'systemInstruction', 'system_instruction'] as const) text(prompt.fields[k]);
  for (const m of prompt.leading) text(m);
  const tools: string[] = [];
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : isObject(v) && Array.isArray(v.tools) ? v.tools : []);
  for (const t of [...list(prompt.fields.tools), ...list(prompt.fields.toolConfig)]) {
    if (!isObject(t)) continue;
    if (Array.isArray(t.functionDeclarations)) {
      for (const f of t.functionDeclarations) if (isObject(f) && typeof f.name === 'string') tools.push(f.name);
    } else if (isObject(t.function) && typeof t.function.name === 'string') tools.push(t.function.name);
    else if (isObject(t.toolSpec) && typeof t.toolSpec.name === 'string') tools.push(t.toolSpec.name);
    else if (typeof t.name === 'string') tools.push(t.name);
  }
  return { instructions: texts.join('\n\n'), tools };
}

// ---- thinking from earlier turns ----

/**
 * The request without the reasoning its earlier turns carry, for asking it under another prompt or
 * another model: providers tie a turn's reasoning to the model that produced it and to the prompt it
 * was produced under (how-it-works, "Thinking blocks"), so a recorded turn's reasoning would be
 * refused, or read by the new model as its own. Taken out: Anthropic's `thinking` and
 * `redacted_thinking` blocks, Bedrock Converse's `reasoningContent`, a Responses conversation's
 * `reasoning` items, Chat Completions' `reasoning_content`, and Gemini's thought parts
 * (`thought: true`). A Gemini part's `thoughtSignature` stays: Gemini asks for the signatures of its
 * own function calls back. An assistant turn that held nothing but reasoning keeps it, since a turn
 * can't be empty. `removed` counts what was taken out.
 */
export function withoutEarlierThinking(body: unknown): { body: unknown; removed: number } {
  if (!isObject(body)) return { body, removed: 0 };
  let removed = 0;
  const out: Record<string, unknown> = { ...body };
  const keep = <T,>(list: T[], drop: (x: T) => boolean): T[] => {
    const kept = list.filter((x) => !drop(x));
    if (!kept.length || kept.length === list.length) return list;
    removed += list.length - kept.length;
    return kept;
  };
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((m: unknown) => {
      if (!isObject(m) || m.role !== 'assistant') return m;
      let next: Record<string, unknown> = m;
      if (Array.isArray(m.content)) {
        const content = keep(m.content as unknown[], (b) => isObject(b) && (b.type === 'thinking' || b.type === 'redacted_thinking' || b.reasoningContent !== undefined));
        if (content !== m.content) next = { ...next, content };
      }
      for (const k of ['reasoning_content', 'reasoning'] as const) {
        if (next[k] !== undefined && (typeof next.content === 'string' ? next.content !== '' : next.content != null || next.tool_calls !== undefined)) {
          const { [k]: _gone, ...rest } = next;
          next = rest;
          removed++;
        }
      }
      return next;
    });
  }
  if (Array.isArray(out.input)) out.input = keep(out.input as unknown[], (i) => isObject(i) && i.type === 'reasoning');
  if (Array.isArray(out.contents)) {
    out.contents = (out.contents as unknown[]).map((c) => {
      if (!isObject(c) || c.role !== 'model' || !Array.isArray(c.parts)) return c;
      const parts = keep(c.parts as unknown[], (p) => isObject(p) && p.thought === true);
      return parts === c.parts ? c : { ...c, parts };
    });
  }
  return { body: removed ? out : body, removed };
}
