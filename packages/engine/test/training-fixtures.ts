import { sha256 } from '../src/ids.js';
import { storeApiRequest } from '../src/manifest.js';
import type { Store } from '../src/store.js';
import type { Effect, RunMeta, RunRecord, RunStatus, Usage } from '../src/types.js';

/**
 * Runs of a small support agent, written straight into a store: the agent asks the model, runs the
 * tools it calls, and asks again with the results, as the support agent the CLI tests drive does.
 * Each model answer is given; the requests follow from them, so two runs with the same answers up to
 * a call send the same conversation there, whatever tool-use ids each carried.
 */

export interface Step {
  text?: string;
  tools?: Array<{ name: string; input: Record<string, unknown> }>;
  /** Thinking the model wrote before answering: never part of what an answer is. */
  thinking?: string;
}

export const TOOLS = [
  { name: 'lookup_order', description: 'Look an order up.', input_schema: { type: 'object', properties: { order_id: { type: 'string' } } } },
  { name: 'read_policy', description: 'Read the refund policy.', input_schema: { type: 'object', properties: {} } },
  { name: 'issue_refund', description: 'Refund an order.', input_schema: { type: 'object', properties: { order_id: { type: 'string' }, amount: { type: 'number' } } } },
  { name: 'escalate', description: 'Hand the case to a manager.', input_schema: { type: 'object', properties: { reason: { type: 'string' } } } },
];

export const EFFECTS: Record<string, Effect> = { lookup_order: 'read', read_policy: 'pure', issue_refund: 'write', escalate: 'write', user_input: 'read' };

export function defaultResult(name: string, input: Record<string, unknown>): unknown {
  if (name === 'lookup_order') return { order_id: input.order_id, amount: 240, email: 'dana@example.com' };
  if (name === 'read_policy') return { text: 'Refunds above $100 need a manager: escalate them.' };
  if (name === 'issue_refund') return { refunded: true, ...input };
  if (name === 'escalate') return { ticket: 'T-1' };
  return { ok: true };
}

export interface RecordOptions {
  runId?: string;
  parentRunId?: string | null;
  status?: Exclude<RunStatus, 'running'>;
  meta?: RunMeta;
  startedAt?: number;
  codeVersion?: string | null;
  system?: string;
  user?: string;
  model?: string;
  /** Tool-use ids carry this, so runs differ in ids as real ones do. */
  ids?: string;
  results?: (name: string, input: Record<string, unknown>) => unknown;
  /** Calls before the model's first one, such as a recorded user input. */
  before?: Array<{ name: string; result: unknown }>;
  usage?: Usage;
  /** The scope each model call is made in, by its place among them (`scope()` in the SDKs). */
  scopes?: (i: number) => string | undefined;
  /** The command the run was recorded with. */
  argv?: string[];
}

let seq = 0;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A run id that sorts by creation, readable in a failure: `01TEST…`. */
export function testRunId(): string {
  const n = String(++seq);
  let tail = '';
  for (const ch of n.padStart(20, '0')) tail += CROCKFORD[Number(ch)];
  return `01TEST${tail}`;
}

export function recordRun(store: Store, steps: Step[], o: RecordOptions = {}): { run: RunRecord; models: number[] } {
  const startedAt = o.startedAt ?? 1_760_000_000_000 + seq * 1000;
  const run = store.createRun({ runId: o.runId ?? testRunId(), parentRunId: o.parentRunId ?? null, mode: o.parentRunId ? 'replay' : 'record', command: { argv: o.argv ?? ['node', 'agent.mjs'], cwd: '/work' }, codeVersion: o.codeVersion ?? null, startedAt, ...(o.meta ? { meta: o.meta } : {}) });
  const ids = o.ids ?? run.runId.slice(-4);
  const model = o.model ?? 'claude-sonnet-5';
  const messages: unknown[] = [{ role: 'user', content: o.user ?? 'The customer asks for a refund on order A-1042.' }];
  let callNo = 0;
  const models: number[] = [];
  const at = () => startedAt + callNo;
  for (const b of o.before ?? []) {
    callNo++;
    store.appendCallStart({ runId: run.runId, callNo, kind: 'tool', name: b.name, fingerprint: sha256(`${b.name}${callNo}`), occurrence: 1, origin: 'live', effect: EFFECTS[b.name] ?? 'read', requestRef: store.putJson({ args: {} }), meta: {}, at: at() });
    store.appendCallEnd({ kind: 'tool', name: b.name, fingerprint: sha256(`${b.name}${callNo}`), occurrence: 1 }, { runId: run.runId, callNo, attempt: 0, responseRef: store.putJson({ result: b.result }), outcome: 'ok', meta: {}, at: at() });
  }
  steps.forEach((step, i) => {
    callNo++;
    models.push(callNo);
    const body = { model, max_tokens: 256, system: o.system ?? 'You are a support agent. Follow the refund policy.', tools: TOOLS, messages: structuredClone(messages) };
    const content: unknown[] = [];
    if (step.thinking) content.push({ type: 'thinking', thinking: step.thinking, signature: 'sig' });
    if (step.text) content.push({ type: 'text', text: step.text });
    const uses = (step.tools ?? []).map((t, j) => ({ type: 'tool_use', id: `toolu_${ids}_${i}_${j}`, name: t.name, input: t.input }));
    content.push(...uses);
    const usage = o.usage ?? { inputTokens: 1000 + i * 100, outputTokens: 40 };
    const response = { id: `msg_${ids}_${i}`, type: 'message', role: 'assistant', model, content, stop_reason: uses.length ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens } };
    const fingerprint = sha256(JSON.stringify(body.messages.length) + i);
    const scope = o.scopes?.(i);
    store.appendCallStart({ runId: run.runId, callNo, kind: 'api', name: 'POST /v1/messages', fingerprint, occurrence: 1, origin: o.parentRunId ? 'replayed' : 'live', effect: null, requestRef: storeApiRequest(store, body), meta: { provider: 'anthropic', ...(scope ? { scope } : {}) }, at: at() });
    store.appendCallEnd({ kind: 'api', name: 'POST /v1/messages', fingerprint, occurrence: 1 }, { runId: run.runId, callNo, attempt: 0, responseRef: store.putJson(response), outcome: 'ok', meta: { status: 200, headers: { 'content-type': 'application/json' }, provider: 'anthropic', model, usage, stopReason: response.stop_reason, ...(scope ? { scope } : {}) }, at: at() });
    messages.push({ role: 'assistant', content });
    if (!uses.length) return;
    const results: unknown[] = [];
    for (const u of uses) {
      callNo++;
      const result = (o.results ?? defaultResult)(u.name, u.input);
      const fp = sha256(`${u.name}${JSON.stringify(u.input)}`);
      store.appendCallStart({ runId: run.runId, callNo, kind: 'tool', name: u.name, fingerprint: fp, occurrence: 1, origin: 'live', effect: EFFECTS[u.name] ?? 'read', requestRef: store.putJson({ args: u.input }), meta: {}, at: at() });
      store.appendCallEnd({ kind: 'tool', name: u.name, fingerprint: fp, occurrence: 1 }, { runId: run.runId, callNo, attempt: 0, responseRef: store.putJson({ result }), outcome: 'ok', meta: {}, at: at() });
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(result) });
    }
    messages.push({ role: 'user', content: results });
  });
  store.endRun(run.runId, o.status ?? 'completed', startedAt + callNo + 1);
  return { run: store.getRun(run.runId)!, models };
}

/** The support agent's run up to its decision: look the order up, read the policy, then decide. */
export const LOOKUP: Step = { text: 'Looking the order up.', tools: [{ name: 'lookup_order', input: { order_id: 'A-1042' } }] };
export const POLICY: Step = { tools: [{ name: 'read_policy', input: {} }] };
export const REFUND: Step = { text: 'Issuing the refund.', tools: [{ name: 'issue_refund', input: { order_id: 'A-1042', amount: 240 } }] };
export const ESCALATE: Step = { text: 'Above the limit.', tools: [{ name: 'escalate', input: { reason: 'refund of $240 is above $100' } }] };
export const ESCALATE_2: Step = { text: '$240 is over the $100 limit, so this needs approval.', tools: [{ name: 'escalate', input: { reason: 'above the refund limit' } }] };
export const DONE: Step = { text: 'Done.' };
