import { openAITools, type ChatCompletion, type TranslatedRequest, type ToOpenAIOptions } from './translate.js';
import { isObject } from './is-object.js';

/**
 * Gemini's generateContent at a takeover (E8), from the Gemini API or Vertex AI: a recorded call
 * translated into the OpenAI chat shape for the model under test, and its answer translated back into
 * a GenerateContentResponse, streamed as the client asked (server-sent events with `alt=sse`, else a
 * JSON array).
 *
 * What carries over: the system instruction, every turn, inline images, function declarations,
 * function calls and their responses, the function calling mode, `maxOutputTokens`, temperature,
 * `topP` and stop sequences. Gemini may leave a call without an id; each gets one for the other API,
 * and a response is matched to its call by id, else by name in order. What doesn't: thought parts
 * (only the model that wrote them can read them), files by URI, built-in tools such as Google Search,
 * `topK`, a response schema and the thinking setting.
 */

type Json = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v));

function toolId(raw: unknown, fallback: () => string): string {
  const id = typeof raw === 'string' ? raw.replace(/[^A-Za-z0-9_-]/g, '_') : '';
  return id || fallback();
}

/** A system instruction's text: a string, or content with text parts. */
function instructionText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (isObject(v) && Array.isArray(v.parts)) return v.parts.flatMap((p) => (isObject(p) && typeof p.text === 'string' && p.thought !== true ? [p.text] : [])).join('\n');
  return '';
}

/** A function response as the tool message's text: its `output` or `result` when that is all it holds, else the whole response as JSON. */
function responseText(response: unknown): string {
  if (typeof response === 'string') return response;
  if (isObject(response)) {
    const keys = Object.keys(response);
    if (keys.length === 1 && typeof response[keys[0]!] === 'string' && (keys[0] === 'output' || keys[0] === 'result' || keys[0] === 'content')) return response[keys[0]] as string;
    if (keys.length === 1 && keys[0] === 'error') return `Error: ${str(response.error)}`;
  }
  return JSON.stringify(response ?? {});
}

export function geminiToOpenAIChat(input: unknown, options: ToOpenAIOptions = {}): TranslatedRequest {
  if (!isObject(input) || !Array.isArray(input.contents)) throw new Error('not a Gemini generateContent request: it has no contents');
  const dropped = new Set<string>();
  const messages: Json[] = [];
  let n = 0;
  const nextId = () => `call_shadowlap_${++n}`;
  const system = instructionText(input.systemInstruction ?? input.system_instruction);
  if (system) messages.push({ role: 'system', content: system });
  // The calls the model made and no response answered yet, by name, oldest first.
  const open = new Map<string, string[]>();

  for (const c of input.contents) {
    if (!isObject(c) || !Array.isArray(c.parts)) continue;
    if (c.role === 'model') {
      const text: string[] = [];
      const calls: Json[] = [];
      for (const p of c.parts) {
        if (!isObject(p)) continue;
        if (p.thought === true) {
          dropped.add('thought parts');
          continue;
        }
        if (typeof p.text === 'string') text.push(p.text);
        else if (isObject(p.functionCall)) {
          const name = str(p.functionCall.name);
          const id = toolId(p.functionCall.id, nextId);
          open.set(name, [...(open.get(name) ?? []), id]);
          calls.push({ id, type: 'function', function: { name, arguments: JSON.stringify(p.functionCall.args ?? {}) } });
        } else if (p.executableCode !== undefined || p.codeExecutionResult !== undefined) dropped.add('code execution parts');
        else dropped.add(`${Object.keys(p).find((k) => k !== 'thoughtSignature') ?? 'unknown'} parts`);
      }
      const content = text.join('');
      if (!content && !calls.length) continue;
      messages.push({ role: 'assistant', content: content || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // A user turn (or the old `function` role): function responses become tool messages, which go first.
    const parts: Json[] = [];
    for (const p of c.parts) {
      if (!isObject(p)) continue;
      if (isObject(p.functionResponse)) {
        const name = str(p.functionResponse.name);
        const waiting = open.get(name) ?? [];
        const given = typeof p.functionResponse.id === 'string' ? toolId(p.functionResponse.id, nextId) : null;
        const id = given ?? waiting[0] ?? nextId();
        open.set(
          name,
          waiting.filter((x) => x !== id),
        );
        messages.push({ role: 'tool', tool_call_id: id, content: responseText(p.functionResponse.response) });
      } else if (typeof p.text === 'string') parts.push({ type: 'text', text: p.text });
      else if (isObject(p.inlineData) && typeof p.inlineData.data === 'string') {
        const mime = str(p.inlineData.mimeType ?? p.inlineData.mime_type) || 'application/octet-stream';
        if (mime.startsWith('image/')) parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${p.inlineData.data}` } });
        else dropped.add(`${mime} data`);
      } else if (p.fileData !== undefined) dropped.add('files by URI');
      else dropped.add(`${Object.keys(p)[0] ?? 'unknown'} parts`);
    }
    if (!parts.length) continue;
    messages.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => p.text as string).join('\n') : parts });
  }

  const out: Json = { model: options.model ?? null, messages };
  const tools = openAITools(input);
  if (tools.length) out.tools = tools;
  for (const t of Array.isArray(input.tools) ? input.tools : []) {
    if (!isObject(t)) continue;
    for (const k of Object.keys(t)) if (k !== 'functionDeclarations' && k !== 'function_declarations') dropped.add(`the ${k} tool`);
  }
  const config = isObject(input.toolConfig) && isObject(input.toolConfig.functionCallingConfig) ? input.toolConfig.functionCallingConfig : null;
  if (config && tools.length) {
    const allowed = Array.isArray(config.allowedFunctionNames) ? config.allowedFunctionNames.filter((x): x is string => typeof x === 'string') : [];
    if (config.mode === 'NONE') out.tool_choice = 'none';
    else if (config.mode === 'ANY' && allowed.length === 1) out.tool_choice = { type: 'function', function: { name: allowed[0] } };
    else if (config.mode === 'ANY') out.tool_choice = 'required';
    else if (config.mode === 'AUTO') out.tool_choice = 'auto';
  }
  const gen = isObject(input.generationConfig) ? input.generationConfig : {};
  if (typeof gen.maxOutputTokens === 'number') out[options.maxTokensField ?? 'max_tokens'] = gen.maxOutputTokens;
  if (typeof gen.temperature === 'number') out.temperature = gen.temperature;
  if (typeof gen.topP === 'number') out.top_p = gen.topP;
  if (Array.isArray(gen.stopSequences) && gen.stopSequences.length) out.stop = gen.stopSequences.filter((s) => typeof s === 'string');
  if (gen.topK !== undefined) dropped.add('topK');
  if (gen.responseSchema !== undefined || gen.responseJsonSchema !== undefined) dropped.add('the response schema');
  if (gen.thinkingConfig !== undefined) dropped.add('the thinking setting');
  if (typeof gen.candidateCount === 'number' && gen.candidateCount > 1) dropped.add('candidateCount');
  return { body: out, dropped: [...dropped] };
}

// ---- the answer: a chat completion as a GenerateContentResponse ----

export interface GeminiResponse {
  candidates: Array<{ content: { role: 'model'; parts: Array<{ text: string } | { functionCall: { name: string; args: unknown; id?: string } }> }; finishReason: 'STOP' | 'MAX_TOKENS' | 'SAFETY'; index: 0 }>;
  usageMetadata: { promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number; cachedContentTokenCount?: number };
  modelVersion: string;
}

const THINK = /^\s*<think>[\s\S]*?<\/think>\s*/;

function parseArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isObject(parsed) ? parsed : { value: parsed };
  } catch {
    return { arguments: raw };
  }
}

/**
 * A chat completion as the GenerateContentResponse Gemini clients parse. Gemini stops with `STOP`
 * after a function call too. `ids`: give each function call an id, as when the conversation's had them.
 */
export function chatCompletionToGemini(c: ChatCompletion, options: { model: string; ids?: boolean }): GeminiResponse {
  const choice = c.choices[0];
  const parts: GeminiResponse['candidates'][0]['content']['parts'] = [];
  const text = (choice?.message.content ?? '').replace(THINK, '');
  if (text.trim()) parts.push({ text });
  for (const tc of choice?.message.tool_calls ?? []) parts.push({ functionCall: { name: tc.function.name, args: parseArgs(tc.function.arguments), ...(options.ids ? { id: tc.id } : {}) } });
  const finish = choice?.finish_reason;
  const cached = c.usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: finish === 'length' ? 'MAX_TOKENS' : finish === 'content_filter' ? 'SAFETY' : 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: c.usage.prompt_tokens, candidatesTokenCount: c.usage.completion_tokens, totalTokenCount: c.usage.prompt_tokens + c.usage.completion_tokens, ...(cached ? { cachedContentTokenCount: cached } : {}) },
    modelVersion: options.model,
  };
}

/** Whether a Gemini conversation gave its function calls ids: the answer's then carry them too. */
export function geminiUsesIds(input: unknown): boolean {
  if (!isObject(input) || !Array.isArray(input.contents)) return false;
  return input.contents.some((c) => isObject(c) && Array.isArray(c.parts) && c.parts.some((p) => isObject(p) && ((isObject(p.functionCall) && typeof p.functionCall.id === 'string') || (isObject(p.functionResponse) && typeof p.functionResponse.id === 'string'))));
}

/** A response as `streamGenerateContent` sends it: server-sent events with `alt=sse`, else a JSON array, one chunk either way. */
export function geminiStreamBody(r: GeminiResponse, sse: boolean): string {
  return sse ? `data: ${JSON.stringify(r)}\r\n\r\n` : `[${JSON.stringify(r)}]`;
}
