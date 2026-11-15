import type { MessagesRequest, MockMessage, Script, ScriptContext, ScriptResult } from './index.js';

/**
 * A scripted judge. shadowlap's judge checks send a request of their own: one user message that
 * holds a question and, between <material> tags, what the judge reads, and asks for a JSON object
 * `{"verdict": "yes" | "no", "reason": "…"}`. `withJudge` answers those with the verdict `decide`
 * gives and hands every other request to the agent's script, so one mock plays both the agent's
 * model and its judge. `judgeRequests` counts what the judge was asked.
 */

export interface JudgeQuestion {
  question: string;
  /** What the judge was given to read, between the <material> tags. */
  material: string;
  model: string;
  request: MessagesRequest;
}

export interface JudgeDecision {
  verdict: 'yes' | 'no';
  reason: string;
}

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((b) => (typeof b === 'object' && b !== null && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n')
      : '';

/** The question and the material of a judge's request, or null for any other request. */
export function judgeQuestion(request: MessagesRequest): JudgeQuestion | null {
  if (request.messages.length !== 1 || request.messages[0]!.role !== 'user') return null;
  const prompt = textOf(request.messages[0]!.content);
  const m = /^Question: ([\s\S]*?)\n\n[\s\S]*?<material>\n([\s\S]*)\n<\/material>$/.exec(prompt);
  if (!m || !/verdict/.test(textOf(request.system))) return null;
  return { question: m[1]!, material: m[2]!, model: request.model, request };
}

let n = 0;

/** A judge's answer: the verdict as the JSON text the request asked for. */
export function judgeAnswer(d: JudgeDecision, model = 'claude-haiku-4-5'): MockMessage {
  n++;
  return {
    id: `msg_judge_${String(n).padStart(4, '0')}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: JSON.stringify(d) }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 400 + Math.ceil(JSON.stringify(d).length / 4), output_tokens: 24, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

/**
 * A script that answers judge requests with `decide`'s verdict (or a status and body it returns,
 * to play a judge that fails) and every other request with `otherwise`.
 */
export function withJudge(decide: (q: JudgeQuestion, ctx: ScriptContext) => JudgeDecision | Exclude<ScriptResult, { message: MockMessage }>, otherwise: Script): Script {
  return (ctx) => {
    const q = judgeQuestion(ctx.request);
    if (!q) return otherwise(ctx);
    const d = decide(q, ctx);
    return 'verdict' in d ? { message: judgeAnswer(d, q.model) } : d;
  };
}

/** The judge requests a mock server saw, with what each asked. */
export function judgeRequests(requests: ReadonlyArray<{ body: MessagesRequest }>): JudgeQuestion[] {
  return requests.flatMap((r) => {
    const q = judgeQuestion(r.body);
    return q ? [q] : [];
  });
}
