import { isObject } from './is-object.js';
/**
 * What a path into a model request points at, in words: a difference reads as `tool_result
 * lookup_policy` rather than `$.messages[14].content[0].content`. A message is named by its role,
 * a tool's call or result by the tool's name, then the system prompt and each tool's definition;
 * any other field by its own path (`temperature`, `metadata.user_id`). Below the thing named, what
 * the path still says is kept after a dot (`tool_call issue_refund · amount`), except the wrapper
 * that holds its content (a result's `content`, a call's `input`).
 *
 * Every request shape the recorder keeps: Anthropic Messages (on its API, Bedrock or Vertex AI),
 * OpenAI Chat Completions and Responses, Gemini's generateContent and Bedrock's Converse. Paths are
 * the structural diff's (`$`, `.key`, `[i]`).
 */

interface Place {
  path: string;
  what: string;
  /** The wrapper below `path` that holds the thing's content: said by `what` alone. */
  inner?: RegExp;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Ends a wrapper at a segment boundary: `.content` but not `.contents`. */
const wrapper = (source: string) => new RegExp(`^${source}(?=$|[.[])`);
const CONTENT = wrapper('\\.content(?:\\[\\d+\\]\\.text)?');
const TEXT = wrapper('\\.text');

/** A role as a message is named: `user message`, `assistant message`. */
function roleWord(role: unknown): string {
  if (role === 'model') return 'assistant';
  return str(role) ?? 'a';
}

/** The tool each call id names, across the conversation: a result carries only the id of the call it answers. */
function toolNames(messages: unknown[]): Map<string, string> {
  const out = new Map<string, string>();
  const add = (id: unknown, name: unknown) => {
    if (typeof id === 'string' && typeof name === 'string') out.set(id, name);
  };
  for (const m of messages) {
    if (!isObject(m)) continue;
    if (m.type === 'function_call') add(m.call_id, m.name);
    if (Array.isArray(m.tool_calls)) for (const t of m.tool_calls) if (isObject(t) && isObject(t.function)) add(t.id, t.function.name);
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!isObject(b)) continue;
      if (b.type === 'tool_use' || b.type === 'server_tool_use') add(b.id, b.name);
      if (isObject(b.toolUse)) add(b.toolUse.toolUseId, b.toolUse.name);
    }
  }
  return out;
}

const result = (name: string | null | undefined) => (name ? `tool_result ${name}` : 'tool_result');
const call = (name: string | null | undefined) => (name ? `tool_call ${name}` : 'tool_call');

/** A content block of a message (Anthropic's typed blocks, Converse's blocks keyed by kind, OpenAI's content parts). */
function blockPlace(path: string, b: unknown, role: string, names: Map<string, string>): Place {
  if (!isObject(b)) return { path, what: `${role} message` };
  switch (b.type) {
    case 'tool_result':
      return { path, what: result(names.get(String(b.tool_use_id))), inner: CONTENT };
    case 'tool_use':
    case 'server_tool_use':
      return { path, what: call(str(b.name)), inner: wrapper('\\.input') };
    case 'thinking':
    case 'redacted_thinking':
      return { path, what: 'thinking', inner: wrapper('\\.(?:thinking|data|signature)') };
    case 'image':
    case 'document':
    case 'input_image':
    case 'input_file':
      return { path, what: `${role} ${String(b.type).replace(/^input_/, '')}` };
    case undefined:
      break;
    default:
      return { path, what: `${role} message`, inner: TEXT };
  }
  // Bedrock Converse: blocks keyed by kind.
  if (isObject(b.toolResult)) return { path, what: result(names.get(String(b.toolResult.toolUseId))), inner: wrapper('\\.toolResult(?:\\.content(?:\\[\\d+\\]\\.(?:text|json))?)?') };
  if (isObject(b.toolUse)) return { path, what: call(str(b.toolUse.name)), inner: wrapper('\\.toolUse(?:\\.input)?') };
  if (isObject(b.reasoningContent)) return { path, what: 'thinking', inner: wrapper('\\.reasoningContent') };
  if (b.image || b.document || b.video) return { path, what: `${role} ${b.image ? 'image' : b.document ? 'document' : 'video'}` };
  return { path, what: `${role} message`, inner: TEXT };
}

/** Messages as Anthropic, OpenAI Chat Completions and Bedrock Converse send them. */
function messagePlaces(messages: unknown[], places: Place[]): void {
  const names = toolNames(messages);
  messages.forEach((m, i) => {
    const path = `$.messages[${i}]`;
    if (!isObject(m)) return;
    const role = m.role;
    if (role === 'tool' || role === 'function') {
      places.push({ path, what: result(names.get(String(m.tool_call_id)) ?? str(m.name)), inner: CONTENT });
      return;
    }
    if (role === 'system' || role === 'developer') {
      places.push({ path, what: 'system prompt', inner: CONTENT });
      return;
    }
    const word = roleWord(role);
    const blocks = Array.isArray(m.content) ? m.content.map((b, j) => blockPlace(`${path}.content[${j}]`, b, word, names)) : [];
    // A message of one block is that block: a user turn that only carries a tool's result is the result.
    places.push({ path, what: blocks.length === 1 && !Array.isArray(m.tool_calls) ? blocks[0]!.what : `${word} message`, inner: CONTENT });
    places.push(...blocks);
    if (Array.isArray(m.tool_calls))
      m.tool_calls.forEach((t, j) => places.push({ path: `${path}.tool_calls[${j}]`, what: call(isObject(t) && isObject(t.function) ? str(t.function.name) : null), inner: wrapper('\\.function\\.arguments') }));
  });
}

/** The Responses API's input items. */
function inputPlaces(input: unknown[], places: Place[]): void {
  const names = toolNames(input);
  input.forEach((it, i) => {
    const path = `$.input[${i}]`;
    if (!isObject(it)) return;
    if (it.type === 'function_call_output' || it.type === 'custom_tool_call_output') places.push({ path, what: result(names.get(String(it.call_id))), inner: wrapper('\\.output') });
    else if (it.type === 'function_call' || it.type === 'custom_tool_call') places.push({ path, what: call(str(it.name)), inner: wrapper('\\.(?:arguments|input)') });
    else if (it.type === 'reasoning') places.push({ path, what: 'thinking' });
    else if (it.role === 'system' || it.role === 'developer') places.push({ path, what: 'system prompt', inner: CONTENT });
    else if (it.type === 'message' || it.role !== undefined) places.push({ path, what: `${roleWord(it.role)} message`, inner: CONTENT });
    else places.push({ path, what: str(it.type) ?? 'input item' });
  });
}

/** Gemini's contents, each with its parts. */
function contentPlaces(contents: unknown[], places: Place[]): void {
  contents.forEach((c, i) => {
    const path = `$.contents[${i}]`;
    if (!isObject(c)) return;
    const role = roleWord(c.role ?? 'user');
    const parts: Place[] = (Array.isArray(c.parts) ? c.parts : []).map((p, j) => {
      const at = `${path}.parts[${j}]`;
      if (!isObject(p)) return { path: at, what: `${role} message` };
      if (isObject(p.functionResponse)) return { path: at, what: result(str(p.functionResponse.name)), inner: wrapper('\\.functionResponse(?:\\.response)?') };
      if (isObject(p.functionCall)) return { path: at, what: call(str(p.functionCall.name)), inner: wrapper('\\.functionCall(?:\\.args)?') };
      if (p.thought === true) return { path: at, what: 'thinking', inner: TEXT };
      if (p.inlineData || p.fileData) return { path: at, what: `${role} file` };
      return { path: at, what: `${role} message`, inner: TEXT };
    });
    places.push({ path, what: parts.length === 1 ? parts[0]!.what : `${role} message`, inner: wrapper('\\.parts(?:\\[\\d+\\]\\.text)?') }, ...parts);
  });
}

/** Tool definitions: Anthropic's, OpenAI's (`function`), the Responses API's, Gemini's declarations and Converse's specs. */
function toolPlaces(body: Record<string, unknown>, places: Place[]): void {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  tools.forEach((t, k) => {
    const path = `$.tools[${k}]`;
    if (!isObject(t)) return;
    if (Array.isArray(t.functionDeclarations)) {
      t.functionDeclarations.forEach((f, m) => places.push({ path: `${path}.functionDeclarations[${m}]`, what: `tool definition ${(isObject(f) && str(f.name)) || m}` }));
      return;
    }
    const name = isObject(t.function) ? str(t.function.name) : (str(t.name) ?? str(t.type));
    places.push({ path, what: name ? `tool definition ${name}` : 'tool definition', inner: wrapper('\\.function') });
  });
  const converse = isObject(body.toolConfig) && Array.isArray(body.toolConfig.tools) ? body.toolConfig.tools : [];
  converse.forEach((t, k) => {
    const name = isObject(t) && isObject(t.toolSpec) ? str(t.toolSpec.name) : null;
    places.push({ path: `$.toolConfig.tools[${k}]`, what: name ? `tool definition ${name}` : 'tool definition', inner: wrapper('\\.toolSpec') });
  });
}

/** Every place a request's paths can be named by, for one request body. */
function placesOf(body: unknown): Place[] {
  const places: Place[] = [];
  if (!isObject(body)) return places;
  if (body.system !== undefined) places.push({ path: '$.system', what: 'system prompt', inner: wrapper('(?:\\[\\d+\\])?(?:\\.text)?') });
  if (body.instructions !== undefined) places.push({ path: '$.instructions', what: 'system prompt' });
  for (const key of ['systemInstruction', 'system_instruction']) if (body[key] !== undefined) places.push({ path: `$.${key}`, what: 'system prompt', inner: wrapper('\\.parts(?:\\[\\d+\\])?(?:\\.text)?') });
  if (Array.isArray(body.messages)) messagePlaces(body.messages, places);
  if (typeof body.input === 'string') places.push({ path: '$.input', what: 'user message' });
  else if (Array.isArray(body.input)) inputPlaces(body.input, places);
  if (Array.isArray(body.contents)) contentPlaces(body.contents, places);
  toolPlaces(body, places);
  // Longest first: a block's place wins over its message's.
  return places.sort((a, b) => b.path.length - a.path.length);
}

const known = new WeakMap<object, Place[]>();

/**
 * What `path` points at in the request `body`, in words; null for the whole request (`$`), which a
 * difference of kind or name stands for. A path the shapes above don't name is said by its own
 * path without the `$.`.
 */
export function requestPathLabel(body: unknown, path: string): string | null {
  if (path === '$' || !path.startsWith('$')) return null;
  let places = isObject(body) ? known.get(body) : undefined;
  if (!places) {
    places = placesOf(body);
    if (isObject(body)) known.set(body, places);
  }
  const at = places.find((p) => path === p.path || path.startsWith(`${p.path}.`) || path.startsWith(`${p.path}[`));
  if (!at) return path.replace(/^\$\.?/, '') || null;
  const rest = path.slice(at.path.length).replace(at.inner ?? /^$/, '').replace(/^\./, '');
  return rest ? `${at.what} · ${rest}` : at.what;
}

/** What every request of a run sends as its code or its config set it: the system prompt, the tools and the model. */
const SET_BY_CODE = /^\$\.(?:system|instructions|systemInstruction|system_instruction|model|tools|toolConfig|tool_choice)(?=$|[.[])/;

/**
 * Whether a path into a model request points at what a patch or a config change changes, and goes
 * into every request: the system prompt, a tool's definition, the model. Read from the path alone, as
 * a divergence keeps no body: Chat Completions keeps its system prompt as its first message (`name`,
 * the call's `POST /v1/chat/completions`), where Anthropic's first message is the user's.
 */
export function pathSetByCode(path: string, name = ''): boolean {
  return SET_BY_CODE.test(path) || (name.includes('chat/completions') && /^\$\.messages\[0\](?=$|[.[])/.test(path));
}
