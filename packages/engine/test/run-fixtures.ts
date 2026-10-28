import { storeApiRequest, type CallMeta, type Effect, type Origin, type RunRecord, type Store, type Usage } from '../src/index.js';

/**
 * Builds runs the way the sidecar stores them (request manifests, response blobs, end rows with
 * their usage and timing), so the run page's read model can be tested without starting an agent.
 */

export type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } | { type: 'thinking'; thinking: string; signature: string };

export const text = (t: string): Block => ({ type: 'text', text: t });
export const toolUse = (name: string, input: Record<string, unknown>, id: string): Block => ({ type: 'tool_use', id, name, input });
export const user = (content: unknown) => ({ role: 'user', content });
/** The session identifier Claude Code names in every model request's metadata, which tells a run from Claude Code (fromClaudeCode). */
export const CLAUDE_CODE_USER = JSON.stringify({ device_id: 'ab'.repeat(32), account_uuid: '', session_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7' });
export const assistant = (content: Block[]) => ({ role: 'assistant', content });
export const toolResult = (id: string, content: unknown) => ({ type: 'tool_result', tool_use_id: id, content: typeof content === 'string' ? content : JSON.stringify(content) });

/** Anthropic usage as the sidecar normalizes it: input is the uncached part. */
export const usage = (input: number, read = 0, write = 0, output = 40): Usage => ({ inputTokens: input, outputTokens: output, cacheReadInputTokens: read, cacheCreationInputTokens: write });

/** An Anthropic message response. */
export function message(content: Block[], id = `msg_${Math.random().toString(36).slice(2, 10)}`) {
  return { id, type: 'message', role: 'assistant', model: 'claude-sonnet-5', content, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
}

/** The same message as the stream the Messages API sends: tool-use ids only in content_block_start. */
export function messageStream(content: Block[]): string {
  const events: unknown[] = [{ type: 'message_start', message: { ...message([]), content: [] } }];
  content.forEach((b, index) => {
    if (b.type === 'tool_use') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    } else if (b.type === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn' } }, { type: 'message_stop' });
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

export interface ModelCallOptions {
  usage?: Usage;
  scope?: string;
  origin?: Origin;
  latencyMs?: number;
  replayedFrom?: number;
  /** The response as raw bytes with their content type, instead of a JSON message. */
  raw?: { body: string; contentType: string };
  name?: string;
  provider?: string;
  outcome?: 'ok' | 'error';
  status?: number;
  injected?: boolean;
  model?: string;
}

export interface ToolCallOptions {
  scope?: string;
  origin?: Origin;
  effect?: Effect;
  latencyMs?: number;
  replayedFrom?: number;
  error?: string;
  meta?: CallMeta;
  /** Calls the tool makes while it runs: recorded after its start and before its end. */
  during?: () => void;
}

export class RunBuilder {
  callNo = 0;
  at: number;
  constructor(
    readonly store: Store,
    readonly run: RunRecord,
  ) {
    this.at = run.startedAt;
  }

  static start(store: Store, opts: { parent?: string; startedAt?: number; argv?: string[]; meta?: RunRecord['meta'] } = {}): RunBuilder {
    const run = store.createRun({ mode: opts.parent ? 'replay' : 'record', parentRunId: opts.parent ?? null, command: { argv: opts.argv ?? ['python', 'agent.py'], cwd: '/work' }, codeVersion: 'abc1234', startedAt: opts.startedAt ?? 1_760_000_000_000, ...(opts.meta ? { meta: opts.meta } : {}) });
    return new RunBuilder(store, run);
  }

  get runId(): string {
    return this.run.runId;
  }

  model(body: Record<string, unknown>, content: Block[] | null, o: ModelCallOptions = {}): number {
    const callNo = ++this.callNo;
    const name = o.name ?? 'POST /v1/messages';
    const identity = { kind: 'api' as const, name, fingerprint: `fp-${callNo}`, occurrence: 1 };
    const started = (this.at += 10);
    this.store.appendCallStart({ runId: this.runId, callNo, ...identity, origin: o.origin ?? 'live', effect: null, requestRef: storeApiRequest(this.store, body), meta: { provider: o.provider ?? 'anthropic', ...(o.scope ? { scope: o.scope } : {}) }, at: started });
    const ok = content !== null || o.raw !== undefined;
    const bytes = o.raw ? o.raw.body : content ? JSON.stringify(message(content)) : JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
    const latency = o.latencyMs ?? 1000;
    this.at += o.origin === 'replayed' ? 1 : latency;
    this.store.appendCallEnd(identity, {
      runId: this.runId,
      callNo,
      attempt: 0,
      responseRef: this.store.putBlob(Buffer.from(bytes, 'utf8')),
      outcome: o.outcome ?? (ok ? 'ok' : 'error'),
      meta: {
        status: o.status ?? (ok ? 200 : 529),
        headers: { 'content-type': o.raw?.contentType ?? 'application/json' },
        provider: o.provider ?? 'anthropic',
        model: o.model ?? 'claude-sonnet-5',
        ...(o.usage ? { usage: o.usage } : {}),
        latencyMs: o.origin === 'replayed' ? 0 : latency,
        ...(o.replayedFrom !== undefined ? { replayedFrom: o.replayedFrom } : {}),
        ...(o.injected ? { injected: true } : {}),
      },
      at: this.at,
    });
    return callNo;
  }

  tool(name: string, args: unknown, result: unknown, o: ToolCallOptions = {}): number {
    const callNo = ++this.callNo;
    const identity = { kind: 'tool' as const, name, fingerprint: `fp-${callNo}`, occurrence: 1 };
    const started = (this.at += 5);
    this.store.appendCallStart({ runId: this.runId, callNo, ...identity, origin: o.origin ?? 'live', effect: o.effect ?? 'read', requestRef: this.store.putJson({ args }), meta: { ...(o.scope ? { scope: o.scope } : {}), ...(o.meta ?? {}) }, at: started });
    o.during?.();
    const latency = o.latencyMs ?? 100;
    this.at += latency;
    const error = o.error ?? (o.origin === 'blocked' ? 'write tool blocked after divergence' : undefined);
    this.store.appendCallEnd(identity, {
      runId: this.runId,
      callNo,
      attempt: 0,
      responseRef: this.store.putJson(error ? { error: { name: 'Error', message: error } } : { result }),
      outcome: error ? 'error' : 'ok',
      meta: { latencyMs: o.origin === 'replayed' || o.origin === 'blocked' ? 0 : latency, ...(o.replayedFrom !== undefined ? { replayedFrom: o.replayedFrom } : {}), ...(error ? { error: { name: 'Error', message: error } } : {}) },
      at: this.at,
    });
    return callNo;
  }

  end(status: 'completed' | 'failed' = 'completed'): string {
    this.store.endRun(this.runId, status, this.at + 1);
    return this.runId;
  }
}

export const SYSTEM = [{ type: 'text', text: 'You are a support agent for Northwind. Follow the refund policy.', cache_control: { type: 'ephemeral' } }];
export const TOOLS = [{ name: 'lookup_order', input_schema: { type: 'object' } }, { name: 'issue_refund', input_schema: { type: 'object' } }, { name: 'get_ticket', input_schema: { type: 'object' } }];

/** Prompt-cache numbers for the m-th model call of a conversation whose prefix is read back each time. */
export function cachedUsage(m: number, base = 6000, step = 800): Usage {
  const whole = base + step * (m - 1);
  const read = m > 1 ? base + step * (m - 2) : 0;
  return usage(10, read, whole - read - 10);
}

/**
 * An overnight batch: `tickets` tickets worked one after another in one process, each its own
 * conversation of three model calls, with the ticket fetched before the first.
 */
export function batchRun(store: Store, tickets: number, o: { broken?: { ticket: number; call: number }; stream?: boolean } = {}): { runId: string; byTicket: Map<number, number[]> } {
  const b = RunBuilder.start(store, { argv: ['python', 'refund_agent.py', '--batch', 'inbox.jsonl'] });
  const byTicket = new Map<number, number[]>();
  const mark = (t: number, n: number) => byTicket.set(t, [...(byTicket.get(t) ?? []), n]);
  const use = (t: number, m: number) => (o.broken?.ticket === t && o.broken.call === m ? usage(10, 0, cachedUsage(m).cacheCreationInputTokens! + cachedUsage(m).cacheReadInputTokens!) : cachedUsage(m));
  const reply = (content: Block[]) => (o.stream ? { raw: { body: messageStream(content), contentType: 'text/event-stream' } } : {});
  for (let t = 1; t <= tickets; t++) {
    const order = `A-${2000 + t}`;
    mark(t, b.tool('get_ticket', { ticket: `T-${9100 + t}` }, { ticket: `T-${9100 + t}`, order }));
    const first = [user(`Ticket T-${9100 + t}: order ${order} arrived damaged. The customer asks for a refund.`)];
    const a1 = [text('Let me look up the order.'), toolUse('lookup_order', { order_id: order }, `toolu_${t}_1`)];
    mark(t, b.model({ model: 'claude-sonnet-5', system: SYSTEM, tools: TOOLS, messages: first }, o.stream ? null : a1, { usage: use(t, 1), ...reply(a1) }));
    mark(t, b.tool('lookup_order', { order_id: order }, { order_id: order, amount: 40 + t }));
    const second = [...first, assistant(a1), user([toolResult(`toolu_${t}_1`, { order_id: order, amount: 40 + t })])];
    const a2 = [toolUse('issue_refund', { order_id: order, amount: 40 + t }, `toolu_${t}_2`)];
    mark(t, b.model({ model: 'claude-sonnet-5', system: SYSTEM, tools: TOOLS, messages: second }, o.stream ? null : a2, { usage: use(t, 2), ...reply(a2) }));
    mark(t, b.tool('issue_refund', { order_id: order, amount: 40 + t }, { refund_id: `R-${5400 + t}`, status: 'issued' }, { effect: 'write' }));
    const third = [...second, assistant(a2), user([toolResult(`toolu_${t}_2`, { refund_id: `R-${5400 + t}`, status: 'issued' })])];
    const a3 = [text(`Refunded order ${order}.`)];
    mark(t, b.model({ model: 'claude-sonnet-5', system: SYSTEM, tools: TOOLS, messages: third }, o.stream ? null : a3, { usage: use(t, 3), ...reply(a3) }));
  }
  return { runId: b.end(), byTicket };
}

/** A batch whose tickets each end on a tool call (closing the ticket), the next ticket fetched before its first model call. */
export function closingBatch(store: Store, tickets: number): { runId: string; byTicket: Map<number, { get: number; first: number; close: number; crm: number }> } {
  const b = RunBuilder.start(store);
  const byTicket = new Map<number, { get: number; first: number; close: number; crm: number }>();
  for (let t = 1; t <= tickets; t++) {
    const get = b.tool('get_ticket', { ticket: `T-${t}` }, { ticket: `T-${t}`, order: `A-${t}` });
    const q = [user(`Ticket T-${t}: order A-${t} arrived damaged.`)];
    const a1 = [toolUse('lookup_order', { order_id: `A-${t}` }, `toolu_${t}_1`)];
    const first = b.model({ messages: q }, a1);
    b.tool('lookup_order', { order_id: `A-${t}` }, { amount: 40 });
    const q2 = [...q, assistant(a1), user([toolResult(`toolu_${t}_1`, { amount: 40 })])];
    const a2 = [text('Refunding and closing.'), toolUse('close_ticket', { ticket: `T-${t}` }, `toolu_${t}_2`)];
    b.model({ messages: q2 }, a2);
    // Closing the ticket posts to the CRM over HTTP, a host no tool wraps on its own.
    let crm = 0;
    const close = b.tool('close_ticket', { ticket: `T-${t}` }, { closed: true }, { effect: 'write', during: () => (crm = b.tool('POST crm.example.com/tickets', { url: `https://crm.example.com/tickets/T-${t}` }, { status: 200 }, { meta: { http: 'crm.example.com' } })) });
    byTicket.set(t, { get, first, close, crm });
  }
  b.end();
  return { runId: b.runId, byTicket };
}
