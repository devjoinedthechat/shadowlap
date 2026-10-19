import type { GeminiRequest, Script, ScriptContext, ScriptResult, Turn } from './index.js';

/**
 * A scripted judge for Gemini: Shadowlap's judge checks send the judge's instructions as the system
 * instruction and one user turn that holds a question and, between <material> tags, what the judge
 * reads. `withJudge` answers those with the verdict `decide` gives, as the JSON the request's schema
 * asks for, and hands every other request to the agent's script.
 */

export interface JudgeQuestion {
  question: string;
  material: string;
  request: GeminiRequest;
}

export interface JudgeDecision {
  verdict: 'yes' | 'no';
  reason: string;
}

const partsText = (v: unknown): string => {
  const parts = typeof v === 'object' && v !== null && Array.isArray((v as { parts?: unknown }).parts) ? (v as { parts: unknown[] }).parts : [];
  return parts.map((p) => (typeof p === 'object' && p !== null && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('\n');
};

/** The question and the material of a judge's request, or null for any other request. */
export function judgeQuestion(request: GeminiRequest): JudgeQuestion | null {
  if (request.contents.length !== 1 || (request.contents[0]!.role ?? 'user') !== 'user' || !/verdict/.test(partsText(request.systemInstruction))) return null;
  const m = /^Question: ([\s\S]*?)\n\n[\s\S]*?<material>\n([\s\S]*)\n<\/material>$/.exec(partsText(request.contents[0]));
  return m ? { question: m[1]!, material: m[2]!, request } : null;
}

/** A judge's answer: the verdict as the JSON text the request asked for. */
export function judgeTurn(d: JudgeDecision): Turn {
  return { text: JSON.stringify(d), finishReason: 'STOP', usage: { promptTokenCount: 400, candidatesTokenCount: 24 } };
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
