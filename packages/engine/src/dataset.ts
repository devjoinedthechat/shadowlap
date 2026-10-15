/**
 * Recordings as an eval or fine-tuning dataset. Shadowlap doesn't score model output; eval tools do.
 * What it has is every conversation exactly as the model saw it and what the model said back, with
 * what people know about the run (labels, notes, check results). Exported rows carry all of that in
 * the shapes eval tools import.
 */
import { normalizeConversation, type Turn, type TurnBlock } from './conversation.js';
import { loadApiRequest } from './manifest.js';
import { compilePattern } from './normalize.js';
import { normalizeResponse } from './responses.js';
import type { Store } from './store.js';
import type { CallRecord, Normalizer, RunRecord } from './types.js';

export type DatasetFormat = 'jsonl' | 'openai-chat' | 'braintrust' | 'langfuse';
export const DATASET_FORMATS: DatasetFormat[] = ['jsonl', 'openai-chat', 'braintrust', 'langfuse'];

export interface DatasetOptions {
  /** `final`: each run's last model call. `model`: every model call. */
  calls: 'final' | 'model';
  format: DatasetFormat;
  /** Pattern rules without a path, applied to every string of every row. */
  redact?: Normalizer[];
}

export interface DatasetMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ id: string; name: string; arguments: unknown }>;
  tool_call_id?: string;
}

export interface DatasetExample {
  input: { messages: DatasetMessage[]; tools: string[] };
  output: { text: string; tool_calls: Array<{ name: string; arguments: unknown }> };
  metadata: {
    run_id: string;
    call_no: number;
    model: string | null;
    labels: string[];
    notes: string[];
    checks: { passed: number; total: number } | null;
    command: string;
    code_version: string | null;
    forked_at: number | null;
    recorded_at: string;
  };
}

function text(blocks: TurnBlock[]): string {
  return blocks
    .map((b) => (b.type === 'text' ? b.text : b.type === 'other' ? `[${b.label}]` : ''))
    .filter(Boolean)
    .join('\n');
}

/** A provider's conversation as plain chat messages: text, tool calls with ids, tool results that answer them. */
export function messagesOf(turns: Turn[]): DatasetMessage[] {
  const out: DatasetMessage[] = [];
  let n = 0;
  for (const t of turns) {
    if (t.role === 'assistant') {
      const calls = t.blocks.filter((b): b is Extract<TurnBlock, { type: 'tool_call' }> => b.type === 'tool_call');
      out.push({ role: 'assistant', content: text(t.blocks), ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id ?? `call_${++n}`, name: c.name, arguments: c.input })) } : {}) });
      continue;
    }
    // Tool results travel inside user turns for Anthropic and Gemini, and as their own turns for OpenAI.
    const results = t.blocks.filter((b): b is Extract<TurnBlock, { type: 'tool_result' }> => b.type === 'tool_result');
    for (const r of results) out.push({ role: 'tool', content: r.content, ...(r.id ? { tool_call_id: r.id } : {}) });
    const rest = text(t.blocks);
    if (rest || !results.length) out.push({ role: t.role === 'tool' ? 'tool' : t.role, content: rest });
  }
  return out;
}

function example(store: Store, run: RunRecord, call: CallRecord): DatasetExample | null {
  if (!call.requestRef || !call.end?.responseRef) return null;
  const conv = normalizeConversation(loadApiRequest(store, call.requestRef));
  if (!conv) return null;
  const provider = call.end.meta.provider ?? call.meta.provider;
  const response = normalizeResponse(store.getBlob(call.end.responseRef), call.end.meta.headers?.['content-type'], call.end.meta.chunks ?? [], typeof provider === 'string' ? provider : undefined);
  const checks = run.meta?.checks;
  return {
    input: { messages: messagesOf(conv.turns), tools: conv.tools },
    output: {
      text: response.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n'),
      tool_calls: response.blocks.flatMap((b) => (b.type === 'tool_call' ? [{ name: b.name, arguments: b.input }] : [])),
    },
    metadata: {
      run_id: run.runId,
      call_no: call.callNo,
      model: call.end.meta.model ?? conv.model ?? null,
      labels: run.meta?.labels ?? [],
      notes: (run.meta?.notes ?? []).filter((x) => x.callNo === null || x.callNo === call.callNo).map((x) => x.text),
      checks: checks?.length ? { passed: checks.filter((c) => c.ok).length, total: checks.length } : null,
      command: run.command.argv.join(' '),
      code_version: run.codeVersion,
      forked_at: run.divergence?.callNo ?? null,
      recorded_at: new Date(run.startedAt).toISOString(),
    },
  };
}

function redactDeep(value: unknown, rules: Array<{ re: RegExp; replace: string }>): unknown {
  if (typeof value === 'string') return rules.reduce((s, r) => ((r.re.lastIndex = 0), s.replace(r.re, r.replace)), value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, rules));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, rules)]));
  return value;
}

/** One row in the requested format. */
function shape(e: DatasetExample, format: DatasetFormat): unknown {
  switch (format) {
    case 'braintrust':
      return { input: e.input, expected: e.output, metadata: e.metadata };
    case 'langfuse':
      return { input: e.input, expectedOutput: e.output, metadata: e.metadata };
    case 'openai-chat': {
      const chat = (m: DatasetMessage) => ({
        role: m.role,
        content: m.content,
        ...(m.tool_calls ? { tool_calls: m.tool_calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      });
      const answer: DatasetMessage = { role: 'assistant', content: e.output.text, ...(e.output.tool_calls.length ? { tool_calls: e.output.tool_calls.map((c, i) => ({ id: `answer_${i + 1}`, ...c })) } : {}) };
      return { messages: [...e.input.messages, answer].map(chat) };
    }
    default:
      return e;
  }
}

export function datasetRows(store: Store, runs: RunRecord[], opts: DatasetOptions): unknown[] {
  const rules = (opts.redact ?? []).filter((r) => r.path === undefined && r.pattern !== undefined).map((r) => ({ re: compilePattern(r.pattern!), replace: r.replace }));
  const rows: unknown[] = [];
  for (const run of runs) {
    const models = store.getCalls(run.runId).filter((c) => c.kind === 'api' && c.end?.outcome === 'ok');
    const chosen = opts.calls === 'final' ? models.slice(-1) : models;
    for (const call of chosen) {
      let e: DatasetExample | null = null;
      try {
        e = example(store, run, call);
      } catch {
        e = null; // an unreadable request or response is left out
      }
      if (e) rows.push(shape(rules.length ? (redactDeep(e, rules) as DatasetExample) : e, opts.format));
    }
  }
  return rows;
}
