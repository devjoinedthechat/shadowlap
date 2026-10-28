import { isObject } from '@shadowlap/engine';
import type { CallRecord } from '@shadowlap/engine';
import { sseDataObjects } from './providers.js';

/**
 * OpenAI's Responses API can keep a conversation on its side: a request continues one by naming the
 * response it follows (`previous_response_id`) or a conversation (`conversation`). A replay serves
 * the recorded responses, so after a fork the first live call names a response the recording made,
 * which the provider holds only for the key and organization that made it, only while it keeps it,
 * and never when it was made with `store: false`: the fork fails, or reads state another key left.
 * And a conversation holds every turn the recorded run took, those after the fork too, so a live
 * call that names one would have the model read what the agent hasn't done yet in the fork.
 *
 * So a live call that continues a recorded response is sent with the whole conversation it continues
 * instead, rebuilt from the recorded requests and their answers, as the stateless Responses pattern
 * sends one; and one that names a recorded conversation is refused.
 */

type Json = Record<string, unknown>;

/** What to do with a live Responses call. */
export type Continuation =
  /** Nothing of the recording's on the provider's side: send it as the agent wrote it. */
  | { send: 'as-is' }
  /**
   * It continues `previous`, a recorded response: send `body`, its whole conversation in its input,
   * rebuilt from the recorded calls `from`. A chain that began before the recording keeps naming the
   * response it began at, which the recording never made.
   */
  | { send: 'whole'; body: Json; from: number[]; previous: string }
  /** It names a recorded conversation (`param`): refused, and why, as a clause (`it continues conversation …`). */
  | { refuse: string; param: string };

interface RecordedResponse {
  callNo: number;
  request: Json;
  output: Json[];
}

/** A request's input as items: a string is one user message. */
const inputItems = (input: unknown): Json[] => (typeof input === 'string' ? [{ role: 'user', content: input }] : Array.isArray(input) ? input.filter(isObject) : []);

/** A conversation as a request names it: `"conv_…"` or `{ "id": "conv_…" }`. */
const conversationId = (v: unknown): string | null => (typeof v === 'string' ? v : isObject(v) && typeof v.id === 'string' ? v.id : null);

/**
 * An output item as the input of a later request, as the stateless pattern passes one back: a message
 * or a function call without the id and status the provider gave it, a reasoning item only with its
 * encrypted content (one without is readable only on the provider's side, so it is left out), and
 * anything else as it was.
 */
function asInput(item: Json): Json[] {
  switch (item.type) {
    case 'message':
      return [{ type: 'message', role: item.role ?? 'assistant', content: item.content }];
    case 'function_call':
      return [{ type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments }];
    case 'reasoning':
      return typeof item.encrypted_content === 'string' ? [item] : [];
    default:
      return [item];
  }
}

/** A recorded Response's id and output, from its JSON or from its stream's events; null when it holds neither. */
export function recordedResponse(bytes: Buffer | null, contentType: string | undefined): { id: string; output: Json[]; conversation: string | null } | null {
  if (!bytes || bytes.length === 0) return null;
  let response: Json | null = null;
  if (contentType?.includes('text/event-stream')) {
    let id: string | null = null;
    const items: Json[] = [];
    for (const e of sseDataObjects(bytes.toString('utf8'))) {
      if ((e.type === 'response.completed' || e.type === 'response.incomplete') && isObject(e.response)) response = e.response;
      else if (e.type === 'response.created' && isObject(e.response) && typeof e.response.id === 'string') id = e.response.id;
      else if (e.type === 'response.output_item.done' && isObject(e.item)) items[typeof e.output_index === 'number' ? e.output_index : items.length] = e.item;
    }
    // A stream cut before it completed still names its response and the items it finished.
    if (!response && id !== null) response = { id, output: items.filter(isObject) };
  } else {
    try {
      const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
      response = isObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  if (!response || typeof response.id !== 'string') return null;
  return { id: response.id, output: Array.isArray(response.output) ? response.output.filter(isObject) : [], conversation: conversationId(response.conversation) };
}

/** Whether a model call is a Responses API create: `POST …/responses`, in OpenAI's format. */
export function isResponsesCreate(method: string, path: string, format: string): boolean {
  return method === 'POST' && (format === 'openai' || format === 'azure') && /\/responses$/.test(path.split('?')[0] ?? '');
}

export class ResponsesState {
  private index: { responses: Map<string, RecordedResponse>; conversations: Map<string, number | null> } | null = null;

  /**
   * `calls`: the recording's calls. `read` reads a recorded call's request and its answer (its bytes
   * and content type). Nothing is read until a live call continues something.
   */
  constructor(
    private readonly calls: readonly CallRecord[],
    private readonly read: { request: (rec: CallRecord) => unknown; response: (rec: CallRecord) => { bytes: Buffer | null; contentType: string | undefined } },
  ) {}

  /** The recording's Responses calls by the id of the response each got, and its conversations, with the call that made each. */
  private recorded(): NonNullable<ResponsesState['index']> {
    if (this.index) return this.index;
    const responses = new Map<string, RecordedResponse>();
    const conversations = new Map<string, number | null>();
    for (const c of [...this.calls].sort((a, b) => a.callNo - b.callNo)) {
      if (c.kind !== 'api' || c.end?.outcome !== 'ok' || !c.requestRef) continue;
      const [method = 'POST', path = ''] = c.name.split(' ');
      const conversationsCreate = method === 'POST' && /\/conversations$/.test(path);
      if (!conversationsCreate && !/\/responses$/.test(path)) continue;
      try {
        const { bytes, contentType } = this.read.response(c);
        if (conversationsCreate) {
          const made = bytes ? (JSON.parse(bytes.toString('utf8')) as unknown) : null;
          if (isObject(made) && typeof made.id === 'string' && !conversations.has(made.id)) conversations.set(made.id, c.callNo);
          continue;
        }
        const request = this.read.request(c);
        if (!isObject(request)) continue;
        const named = conversationId(request.conversation);
        if (named !== null && !conversations.has(named)) conversations.set(named, null);
        const answer = recordedResponse(bytes, contentType);
        if (!answer) continue;
        if (answer.conversation !== null && !conversations.has(answer.conversation)) conversations.set(answer.conversation, null);
        responses.set(answer.id, { callNo: c.callNo, request, output: answer.output });
      } catch {
        // A call whose request or answer doesn't read is no state this replay can rebuild.
      }
    }
    return (this.index = { responses, conversations });
  }

  /** What to do with a live Responses API create `body` (`isResponsesCreate`). */
  continuation(body: unknown): Continuation {
    if (!isObject(body)) return { send: 'as-is' };
    const conversation = conversationId(body.conversation);
    const previous = typeof body.previous_response_id === 'string' ? body.previous_response_id : null;
    if (conversation === null && previous === null) return { send: 'as-is' };
    const { responses, conversations } = this.recorded();

    if (conversation !== null && conversations.has(conversation)) {
      const madeAt = conversations.get(conversation);
      return {
        param: 'conversation',
        refuse: `it continues conversation ${conversation}, which OpenAI keeps with every turn of the recorded run, those after this point of the fork too, so the model would read what the agent has not done yet. ${madeAt != null ? `Fork from call #${madeAt}, which made the conversation (--diverge-at ${madeAt}), so the fork makes its own; or` : 'Start a conversation of its own in the fork, or'} send each request's whole input, or continue with previous_response_id, which a fork can rebuild.`,
      };
    }
    if (previous === null || !responses.has(previous)) return { send: 'as-is' };

    // The chain of recorded responses the call continues, from the first: each one's input, then its output.
    const items: Json[] = [];
    const from: number[] = [];
    const byId = new Map<string, Json>();
    let at: string | null = previous;
    const seen = new Set<string>();
    while (at !== null && responses.has(at) && !seen.has(at)) {
      seen.add(at);
      const r: RecordedResponse = responses.get(at)!;
      for (const item of [...inputItems(r.request.input), ...r.output]) if (typeof item.id === 'string') byId.set(item.id, item);
      items.unshift(...inputItems(r.request.input), ...r.output.flatMap(asInput));
      from.unshift(r.callNo);
      at = typeof r.request.previous_response_id === 'string' ? r.request.previous_response_id : null;
    }
    // An item the call refers to by id, which the provider keeps only for the run that made it: the item itself.
    const resolved = (item: Json): Json[] => (item.type === 'item_reference' && typeof item.id === 'string' && byId.has(item.id) ? asInput(byId.get(item.id)!) : [item]);
    const { previous_response_id: _continued, ...rest } = body;
    return {
      send: 'whole',
      body: { ...rest, input: [...items, ...inputItems(body.input)].flatMap(resolved), ...(at !== null ? { previous_response_id: at } : {}) },
      from,
      previous,
    };
  }
}
