import { isObject } from '@shadowlap/engine';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The model `shadowlap demo` runs against: a small scripted server on 127.0.0.1, not a real model.
 * It answers the demo's refund agent in Anthropic's Messages API (JSON, or the SSE stream when
 * asked), and the repairer in OpenAI's Chat Completions, the API `--repairer openai:<model>` speaks,
 * so the demo needs no key and nothing leaves the machine. Every answer is decided from the request alone
 * (the system prompt, the tool descriptions, the conversation so far) and from how often a decision
 * was asked before, so the same steps make the same story:
 *
 * - Under the agent's first prompt, the model refunds an order above the $100 limit the first time
 *   it decides on it, and escalates every other time it is asked again: the rescue blame looks for.
 * - Under a prompt that says to escalate every refund above the limit, it escalates 19 times in 20,
 *   as a prompt makes a model likelier to do something, not certain to.
 * - The repairer proposes three rewrites: one that names the case (set aside before anything runs),
 *   one in the refund tool's description that doesn't help, and the prompt fix.
 */

export const SCRIPTED_MODEL = 'scripted-model';
export const SCRIPTED_REPAIRER = 'scripted-repairer';

type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

interface Message {
  role: string;
  content: unknown;
}

const textOf = (content: unknown): string => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b) => isObject(b) && b.type === 'text').map((b) => String((b as { text?: unknown }).text ?? '')).join('\n') : '');
const systemOf = (system: unknown): string => (typeof system === 'string' ? system : Array.isArray(system) ? system.map((b) => (isObject(b) ? String(b.text ?? '') : '')).join('\n') : '');

/** The tool calls an Anthropic conversation holds so far, each with its result. */
function toolCalls(messages: readonly Message[]): Array<{ name: string; input: Record<string, unknown>; result: string }> {
  const calls: Array<{ id: string; name: string; input: Record<string, unknown>; result: string }> = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!isObject(b)) continue;
      if (b.type === 'tool_use') calls.push({ id: String(b.id), name: String(b.name), input: isObject(b.input) ? b.input : {}, result: '' });
      else if (b.type === 'tool_result') {
        const call = calls.find((c) => c.id === b.tool_use_id);
        if (call) call.result = typeof b.content === 'string' ? b.content : textOf(b.content);
      }
    }
  }
  return calls;
}

const tokens = (value: unknown) => Math.max(1, Math.ceil((typeof value === 'string' ? value : JSON.stringify(value ?? '')).length / 4));

export interface ScriptedModel {
  url: string;
  /** Model requests answered: the agent's and the repairer's. */
  requests: number;
  close(): Promise<void>;
}

/** Starts the scripted model on a free port of 127.0.0.1. */
export async function startScriptedModel(): Promise<ScriptedModel> {
  let ids = 0;
  let requests = 0;
  /** How often each order's refund decision was asked under the agent's first prompt, and under the fixed one. */
  const asked = new Map<string, number>();
  let fixedAsks = 0;

  const toolUse = (name: string, input: Record<string, unknown>): Block => ({ type: 'tool_use', id: `toolu_scripted_${++ids}`, name, input });
  const say = (text: string): Block => ({ type: 'text', text });

  function agent(body: Record<string, unknown>): { content: Block[]; stop: 'tool_use' | 'end_turn' } {
    const system = systemOf(body.system);
    const messages = (Array.isArray(body.messages) ? body.messages : []) as Message[];
    const tools = (Array.isArray(body.tools) ? body.tools : []).filter(isObject);
    const calls = toolCalls(messages);
    const has = (name: string) => calls.some((c) => c.name === name);
    const order = /Order (\S+):/.exec(textOf(messages[0]?.content))?.[1] ?? 'A-1042';
    const amount = Number((() => {
      try {
        return (JSON.parse(calls.find((c) => c.name === 'lookup_order')?.result ?? '{}') as { amount?: unknown }).amount ?? 0;
      } catch {
        return 0;
      }
    })());
    const tool = (content: Block[]) => ({ content, stop: 'tool_use' as const });
    if (!has('lookup_order')) return tool([toolUse('lookup_order', { order_id: order })]);
    if (!has('get_policy')) return tool([toolUse('get_policy', { topic: 'refunds' })]);
    if (!has('issue_refund') && !has('escalate')) {
      if (amount > 100) {
        const fixed = system.includes('escalate every refund above the limit');
        const pointed = tools.some((t) => t.name === 'issue_refund' && String(t.description ?? '').includes('Check the policy first'));
        let escalates: boolean;
        if (fixed) escalates = fixedAsks++ % 20 !== 19;
        else if (pointed) escalates = false;
        else {
          // The first decision on an order refunds; asked again, it escalates every other time.
          const n = asked.get(order) ?? 0;
          asked.set(order, n + 1);
          escalates = n > 0 && n % 2 === 1;
        }
        return escalates ? tool([say('Above the limit.'), toolUse('escalate', { reason: `refund of $${amount} is above $100` })]) : tool([say('Issuing the refund.'), toolUse('issue_refund', { order_id: order, amount })]);
      }
      return tool([say('Within the limit. Refunding.'), toolUse('issue_refund', { order_id: order, amount })]);
    }
    const refunded = has('issue_refund');
    if (!has('send_email')) return tool([toolUse('send_email', { to: 'customer@example.com', subject: refunded ? 'Your refund is on its way' : 'Your refund is being reviewed' })]);
    return { content: [say(refunded ? `Refunded $${amount} for ${order} and emailed the customer.` : `Escalated: the refund of $${amount} for ${order} is above the $100 limit.`)], stop: 'end_turn' };
  }

  function repairer(body: Record<string, unknown>): string {
    const messages = (Array.isArray(body.messages) ? body.messages : []) as Message[];
    const asked = messages.map((m) => (typeof m.content === 'string' ? m.content : textOf(m.content))).join('\n');
    const anchor = (label: string) => Number(new RegExp(`\\[(\\d+)\\] ${label}, in [^:]+:`).exec(asked)?.[1]);
    const order = /\bA-\d{4}\b/.exec(asked)?.[0] ?? 'A-1042';
    return JSON.stringify({
      diagnosis: 'The system prompt says to follow the policy but not what the policy asks of large refunds, so the model reaches for the refund tool it was asked about.',
      candidates: [
        { anchor: anchor('system prompt'), replace: `You are a support agent. Follow the refund policy. For order ${order}, escalate instead of refunding.`, strategy: 'Forbid the failing refund', why: 'It names the case.' },
        { anchor: anchor('tool issue_refund'), replace: 'Refund an order in full. Check the policy first.', strategy: 'Point the refund tool at the policy', why: 'The tool is where the choice is made.' },
        { anchor: anchor('system prompt'), replace: 'You are a support agent. Follow the refund policy: escalate every refund above the limit.', strategy: 'Escalate refunds above the policy limit', why: 'The policy sets a limit; saying what to do above it makes the right tool clear.' },
      ],
    });
  }

  const server: Server = createServer((req, res) => {
    void read(req)
      .then((raw) => {
        const url = new URL(req.url ?? '/', 'http://scripted');
        const send = (status: number, value: unknown) => {
          const bytes = Buffer.from(JSON.stringify(value));
          res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(bytes.length) });
          res.end(bytes);
        };
        let body: Record<string, unknown> = {};
        try {
          const parsed: unknown = raw.length ? JSON.parse(raw.toString('utf8')) : {};
          if (isObject(parsed)) body = parsed;
        } catch {
          return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'the body is not JSON' } });
        }
        if (req.method === 'POST' && url.pathname === '/v1/messages') {
          requests++;
          const { content, stop } = agent(body);
          const model = typeof body.model === 'string' ? body.model : SCRIPTED_MODEL;
          const message = { id: `msg_scripted_${++ids}`, type: 'message', role: 'assistant', model, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: tokens(body.messages) + tokens(body.system), output_tokens: tokens(content), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
          if (body.stream !== true) return send(200, message);
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
          for (const [event, data] of streamOf(message)) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          return res.end();
        }
        if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
          requests++;
          const content = repairer(body);
          return send(200, { id: `chatcmpl-scripted-${++ids}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: typeof body.model === 'string' ? body.model : SCRIPTED_REPAIRER, choices: [{ index: 0, message: { role: 'assistant', content, refusal: null }, finish_reason: 'stop' }], usage: { prompt_tokens: tokens(body.messages), completion_tokens: tokens(content), total_tokens: tokens(body.messages) + tokens(content) } });
        }
        return send(404, { type: 'error', error: { type: 'not_found_error', message: `the scripted model has no ${req.method!} ${url.pathname}` } });
      })
      .catch(() => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"type":"error","error":{"type":"api_error","message":"the scripted model failed"}}');
      });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    get requests() {
      return requests;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

function read(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** A message as the Messages API streams it: start, each block's start, delta and stop, then the stop reason. */
function streamOf(m: { content: Block[]; stop_reason: string; usage: { output_tokens: number } } & Record<string, unknown>): Array<[string, unknown]> {
  const events: Array<[string, unknown]> = [['message_start', { type: 'message_start', message: { ...m, content: [], stop_reason: null } }]];
  m.content.forEach((block, index) => {
    if (block.type === 'text') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }]);
    } else {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }]);
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: m.stop_reason, stop_sequence: null }, usage: { output_tokens: m.usage.output_tokens } }]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return events;
}
