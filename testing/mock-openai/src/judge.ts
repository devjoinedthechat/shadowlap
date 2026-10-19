import type { ChatRequest, Script, ScriptContext, ScriptResult, Turn } from './index.js';

/**
 * A scripted judge for Chat Completions: Shadowlap's judge checks send a system message with the
 * judge's instructions and one user message that holds a question and, between <material> tags,
 * what the judge reads. `withJudge` answers those with the verdict `decide` gives, as the JSON
 * object the request's schema asks for, and hands every other request to the agent's script.
 */

export interface JudgeQuestion {
  question: string;
  material: string;
  model: string;
  request: ChatRequest;
}

export interface JudgeDecision {
  verdict: 'yes' | 'no';
  reason: string;
}

const textOf = (content: unknown): string => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (typeof p === 'object' && p !== null && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('\n') : '');

/** The question and the material of a judge's request, or null for any other request. */
export function judgeQuestion(request: ChatRequest): JudgeQuestion | null {
  const [system, user, ...rest] = request.messages;
  if (rest.length || system?.role !== 'system' || user?.role !== 'user' || !/verdict/.test(textOf(system.content))) return null;
  const m = /^Question: ([\s\S]*?)\n\n[\s\S]*?<material>\n([\s\S]*)\n<\/material>$/.exec(textOf(user.content));
  return m ? { question: m[1]!, material: m[2]!, model: request.model, request } : null;
}

/** A judge's answer: the verdict as the JSON text the request asked for. */
export function judgeTurn(d: JudgeDecision): Turn {
  return { content: JSON.stringify(d), finish_reason: 'stop', usage: { prompt_tokens: 400, completion_tokens: 24 } };
}

/** A script that answers judge requests with `decide`'s verdict (or a status and body it returns) and every other request with `otherwise`. */
export function withJudge(decide: (q: JudgeQuestion, ctx: ScriptContext) => JudgeDecision | Exclude<ScriptResult, { turn: Turn }>, otherwise: Script): Script {
  return (ctx) => {
    const q = judgeQuestion(ctx.request);
    if (!q) return otherwise(ctx);
    const d = decide(q, ctx);
    return 'verdict' in d ? { turn: judgeTurn(d) } : d;
  };
}
