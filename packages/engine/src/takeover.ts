import { awsEvent, chatCompletionToConverse, converseStreamBody, converseToOpenAIChat } from './translate-converse.js';
import { chatCompletionToGemini, geminiStreamBody, geminiToOpenAIChat, geminiUsesIds } from './translate-gemini.js';
import { chatCompletionToResponse, responseEvents, responsesToOpenAIChat } from './translate-responses.js';
import { anthropicEventList, anthropicMessageEvents, anthropicToOpenAIChat, awsErrorType, chatCompletionChunks, chatShapeOf, errorBody, openAIChatToAnthropicMessage, untranslatable, type ChatCompletion, type ChatShape, type TranslatedRequest } from './translate.js';

/**
 * How a recorded model call reaches a model under test at a task's takeover (E8), and how its answer
 * goes back in the recording's own API: what `shadowlap tasks score` and `tasks serve` run, and what
 * the dashboard's Score a model asks before it offers a model. No I/O here: the CLI's takeover
 * upstream sends the requests.
 *
 * A model is asked one of three ways: the recording's own provider for another model (`same`), an
 * OpenAI-compatible endpoint (`openai-chat`: Ollama, vLLM, the OpenAI API, your training server), or
 * Anthropic's API (`anthropic`). The recording's call may be Anthropic's messages (on Anthropic, or
 * Claude on Vertex AI or Bedrock), OpenAI's chat completions (on OpenAI, Azure OpenAI, or Vertex AI's
 * and Gemini's OpenAI-compatible endpoints), Bedrock's Converse API, or Gemini's generateContent (on
 * the Gemini API or Vertex AI).
 */

export type TargetRoute = 'same' | 'openai-chat' | 'anthropic';

/** What a takeover needs to know of the model under test: how it is asked, and at which endpoint (null: the provider's own API). */
export interface TakeoverTarget {
  route: TargetRoute;
  scoreBase: string | null;
}

/**
 * How a recorded model call reaches the target:
 * - `same`: the recording's own provider and API, asked for another model, with the agent's own key;
 * - `endpoint`: an OpenAI chat recording (OpenAI, Azure, an OpenAI-compatible cloud endpoint), asked at another OpenAI-compatible endpoint;
 * - `to-openai`: an Anthropic, Responses API, Converse or Gemini recording, translated for an OpenAI-compatible endpoint's chat completions and back;
 * - `to-anthropic`: an OpenAI chat, Responses API, Converse or Gemini recording, translated for Anthropic's API and back;
 * - `anthropic-api`: Claude on Vertex AI or Bedrock, asked of Anthropic's API in the same shape.
 */
export type TakeoverMode = 'same' | 'endpoint' | 'to-openai' | 'to-anthropic' | 'anthropic-api';

export function takeoverMode(provider: string | null, shape: ChatShape | null, target: TakeoverTarget): TakeoverMode | null {
  if (target.route === 'same') return 'same';
  if (target.route === 'anthropic') {
    if (provider === 'anthropic') return 'same';
    if (shape === 'anthropic') return 'anthropic-api';
    return shape === 'openai-chat' || shape === 'openai-responses' || shape === 'converse' || shape === 'gemini' ? 'to-anthropic' : null;
  }
  if (provider === 'openai' && target.scoreBase === null) return 'same';
  if (shape === 'openai-chat') return 'endpoint';
  return shape === 'anthropic' || shape === 'openai-responses' || shape === 'converse' || shape === 'gemini' ? 'to-openai' : null;
}

/**
 * A model call of the recording's own provider, sent to ask `model` instead: the same path with the
 * request's `model` field changed (Anthropic, OpenAI's chat completions, completions and Responses
 * API), or the path with the model in it changed (Gemini). Null for a request that isn't a model call
 * of that provider, which goes on unchanged.
 */
export function switchTakeoverModel(provider: string, method: string, path: string, model: string): { path: string; field: boolean } | null {
  if (method.toUpperCase() !== 'POST') return null;
  if (provider === 'anthropic') return /\/messages$/.test(path) ? { path, field: true } : null;
  if (provider === 'openai') return /\/(chat\/completions|completions|responses)$/.test(path) ? { path, field: true } : null;
  if (provider === 'gemini') {
    const m = /^(.*\/)(?:models|tunedModels)\/[^/:]+(:(?:stream)?generateContent)$/i.exec(path);
    return m ? { path: `${m[1]}${model.includes('/') ? model : `models/${model}`}${m[2]}`, field: false } : null;
  }
  return null;
}

/** What does work for a cloud whose own models can't be switched, for a refusal that says so (`tasks score`'s). */
export const CLOUD_ADVICE = "score Anthropic's or OpenAI's API, or a model at your own endpoint, instead";

/** The clouds whose own models a takeover can't switch: their recordings are scored with another provider's model. */
export const CLOUDS = new Set(['bedrock', 'vertex', 'azure']);

/**
 * Why a model call of the recording's own provider can't be sent to another of its models, or null
 * when it can: Bedrock signs the URL its model is in, Vertex AI is reached at the agent's own regional
 * address, and an Azure deployment picks its model.
 */
export function modelUnswitchable(provider: string | null, callName: string): string | null {
  if (provider === 'bedrock') return 'its takeover call goes through Amazon Bedrock, whose request signature covers the model in its URL';
  if (provider === 'vertex') return "its takeover call goes through Vertex AI, at the agent's own regional address";
  if (provider === 'azure') return 'its takeover call goes through Azure OpenAI, where the deployment in the URL picks the model';
  const m = /^([A-Z]+)\s+(\S+)/.exec(callName);
  const path = (m?.[2] ?? callName).split('?')[0] ?? '';
  if (!provider || !switchTakeoverModel(provider, m?.[1] ?? 'POST', path, 'm')) return `scoring can't change the model of ${provider ? `${/^[aeiou]/i.test(provider) ? 'an' : 'a'} ${provider}` : 'this'} request (${path})`;
  return null;
}

/**
 * Why the target can't answer a recorded model call (its provider and `METHOD path`), or null when
 * it can: the reason `tasks score` refuses a task with, and the dashboard leaves a model out with.
 */
export function takeoverRefusal(provider: string | null, callName: string, target: TakeoverTarget): string | null {
  if (!provider) return "its recording doesn't say which provider the takeover call went to";
  const shape = chatShapeOf(provider, callName);
  const mode = takeoverMode(provider, shape, target);
  if (!mode) return `${untranslatable(provider, callName)}, which only another model of its own provider can answer`;
  if (mode === 'same') return modelUnswitchable(provider, callName);
  return null;
}

/** The path of the recorded API's model call: the one request the model under test answers; anything else goes to the provider as it is. */
export function isTakeoverCall(provider: string, shape: ChatShape, method: string, path: string): boolean {
  return method.toUpperCase() === 'POST' && chatShapeOf(provider, `POST ${path}`) === shape;
}

type Json = Record<string, unknown>;

/** Whether a request to the recorded API asks for its answer streamed: a field in the body, or an endpoint of its own (Bedrock, Gemini). */
export function wantsStream(provider: string, shape: ChatShape, path: string, body: Json): boolean {
  if (shape === 'converse') return /\/converse-stream$/.test(path);
  if (shape === 'gemini') return /:streamGenerateContent$/i.test(path);
  if (provider === 'bedrock') return /\/invoke-with-response-stream$/.test(path);
  return body.stream === true;
}

/** The recorded request as the model under test's API takes it: OpenAI's chat for `to-openai`, Anthropic's messages for `anthropic-api`. */
export function requestFor(mode: 'to-openai' | 'anthropic-api', shape: ChatShape, body: Json, options: { model: string; maxTokensField?: 'max_tokens' | 'max_completion_tokens' }): TranslatedRequest {
  if (mode === 'anthropic-api') {
    // Claude on a cloud, asked of Anthropic's API: the same messages, the model named, the cloud's version field gone.
    const dropped = new Set<string>();
    const { anthropic_version: _v, stream: _s, thinking, ...rest } = body;
    if (thinking !== undefined) dropped.add('the thinking setting');
    const messages = Array.isArray(rest.messages)
      ? (rest.messages as unknown[]).map((m) => {
          if (typeof m !== 'object' || m === null || !Array.isArray((m as Json).content)) return m;
          // Thinking is bound to the model that wrote it: another model's API refuses it.
          const content = ((m as Json).content as unknown[]).filter((b) => {
            const t = typeof b === 'object' && b !== null ? (b as Json).type : null;
            if (t === 'thinking' || t === 'redacted_thinking') dropped.add('thinking blocks');
            return t !== 'thinking' && t !== 'redacted_thinking';
          });
          return { ...(m as Json), content };
        })
      : rest.messages;
    return { body: { ...rest, messages, model: options.model, stream: false }, dropped: [...dropped] };
  }
  const opts = { model: options.model, ...(options.maxTokensField ? { maxTokensField: options.maxTokensField } : {}) };
  if (shape === 'openai-responses') return responsesToOpenAIChat(body, opts);
  if (shape === 'converse') return converseToOpenAIChat(body, opts);
  if (shape === 'gemini') return geminiToOpenAIChat(body, opts);
  if (shape === 'anthropic') return anthropicToOpenAIChat(body, opts);
  return { body: { ...body, model: options.model }, dropped: [] };
}

export interface EncodedAnswer {
  status: number;
  contentType: string;
  body: Buffer;
  headers: Record<string, string>;
}

const SSE = 'text/event-stream; charset=utf-8';
const EVENTSTREAM = 'application/vnd.amazon.eventstream';
const JSON_TYPE = 'application/json';

const encoded = (contentType: string, body: string | Buffer, headers: Record<string, string> = {}, status = 200): EncodedAnswer => ({ status, contentType, body: typeof body === 'string' ? Buffer.from(body, 'utf8') : body, headers });

/**
 * An Anthropic message in the API a Claude recording spoke: Anthropic's own, or Claude on Vertex AI
 * (the same body and events) or on Bedrock (the same body, its events base64 in an AWS event stream).
 */
export function anthropicAnswer(provider: string, message: { content: unknown[]; usage?: unknown; stop_reason?: unknown }, stream: boolean): EncodedAnswer {
  if (!stream) return encoded(JSON_TYPE, JSON.stringify(message));
  if (provider === 'bedrock') return encoded(EVENTSTREAM, Buffer.concat(anthropicEventList(message).map(([, data]) => awsEvent('chunk', { bytes: Buffer.from(JSON.stringify(data), 'utf8').toString('base64') }))));
  return encoded(SSE, anthropicMessageEvents(message));
}

export interface AnswerOptions {
  /** The model under test, named in the answer. */
  model: string;
  stream: boolean;
  /** The request's query: Gemini streams as server-sent events with `alt=sse`, else as a JSON array. */
  search?: string;
  /** The recorded request: whether Gemini's function calls carry ids, and whether an OpenAI client asked for usage in its stream. */
  request?: Json;
}

/** The model under test's answer, as a chat completion, in the recording's own API, streamed as its client asked. */
export function answerAs(provider: string, shape: ChatShape, completion: ChatCompletion, o: AnswerOptions): EncodedAnswer {
  if (shape === 'anthropic') return anthropicAnswer(provider, openAIChatToAnthropicMessage(completion, { model: o.model }), o.stream);
  if (shape === 'openai-responses') {
    const r = chatCompletionToResponse(completion, { model: o.model, ...(o.request ? { request: o.request } : {}) });
    return o.stream ? encoded(SSE, responseEvents(r)) : encoded(JSON_TYPE, JSON.stringify(r));
  }
  if (shape === 'converse') {
    const r = chatCompletionToConverse(completion);
    return o.stream ? encoded(EVENTSTREAM, converseStreamBody(r)) : encoded(JSON_TYPE, JSON.stringify(r));
  }
  if (shape === 'gemini') {
    const r = chatCompletionToGemini(completion, { model: o.model, ids: geminiUsesIds(o.request) });
    if (!o.stream) return encoded(JSON_TYPE, JSON.stringify(r));
    const sse = /(^|[?&])alt=sse(&|$)/.test(o.search ?? '');
    return encoded(sse ? SSE : JSON_TYPE, geminiStreamBody(r, sse));
  }
  if (!o.stream) return encoded(JSON_TYPE, JSON.stringify(completion));
  const options = o.request?.stream_options;
  const includeUsage = typeof options === 'object' && options !== null && (options as Json).include_usage === true;
  return encoded(SSE, chatCompletionChunks(completion, { includeUsage }));
}

/** An error in the recording's own API, so the agent's SDK raises its usual error: AWS's carry their type in a header. */
export function errorAs(provider: string, shape: ChatShape, status: number, message: string): EncodedAnswer {
  const aws = provider === 'bedrock';
  return encoded(JSON_TYPE, JSON.stringify(errorBody(aws ? 'aws' : shape, status, message)), aws ? { 'x-amzn-errortype': awsErrorType(status) } : {}, status);
}
