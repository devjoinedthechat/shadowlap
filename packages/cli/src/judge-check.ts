import { judgeTarget } from '@shadowlap/engine';

/**
 * The `judge` entries of an `expect` object: `JudgeCheck` and `parseJudge`, as the checks grammar in
 * checks.ts defines them. This is the narrowest parse of them, kept in a file of its own so that
 * the grammar's own `parseJudge` takes its place: everything else imports the type from here.
 *
 *   "judge": [{ "name": "explains-escalation", "question": "Does the reply say why?", "of": "answer", "model": "claude-haiku-4-5", "pass": "yes" }]
 */

export interface JudgeCheck {
  /** Unique within its `expect`: what the verdicts are keyed by, and how a run's judge call names its check. */
  name: string;
  question: string;
  /** What the judge reads: the last model response's text (default), what the agent printed, or the run. */
  of: 'answer' | 'output' | 'run';
  model: string;
  /** The answer that passes (default `yes`). */
  pass: 'yes' | 'no';
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const KEYS = ['name', 'question', 'of', 'model', 'pass'];

/** A list of judge checks, each `{ name, question, of?, model, pass? }`. `where` names it in errors. */
export function parseJudge(raw: unknown, where: string): JudgeCheck[] {
  if (!Array.isArray(raw)) throw new Error(`${where} must be a list of judge checks, each with "name", "question" and "model"`);
  const names = new Set<string>();
  return raw.map((item, i) => {
    const at = `${where}[${i}]`;
    if (!isObject(item)) throw new Error(`${at} must be an object with "name", "question" and "model"`);
    for (const key of Object.keys(item)) if (!KEYS.includes(key)) throw new Error(`${at} has an unknown key "${key}" (expected ${KEYS.map((k) => `"${k}"`).join(', ')})`);
    const text = (key: string, max: number): string => {
      const v = item[key];
      if (typeof v !== 'string' || !v.trim()) throw new Error(`${at}.${key} must be a non-empty string`);
      if (v.length > max) throw new Error(`${at}.${key} is longer than ${max} characters`);
      return v.trim();
    };
    const name = text('name', 100);
    if (names.has(name)) throw new Error(`${at}.name "${name}" is used twice: each judge check needs a name of its own`);
    names.add(name);
    const question = text('question', 2000);
    const model = text('model', 200);
    if (!judgeTarget(model)) throw new Error(`${at}.model "${model}" names no model Shadowlap can ask: a Claude, OpenAI or Gemini model (claude-…, gpt-…, o3…, gemini-…), or one with its provider before it (openai:<model>)`);
    const of = item.of ?? 'answer';
    if (of !== 'answer' && of !== 'output' && of !== 'run') throw new Error(`${at}.of must be "answer", "output" or "run"`);
    const pass = item.pass ?? 'yes';
    if (pass !== 'yes' && pass !== 'no') throw new Error(`${at}.pass must be "yes" or "no"`);
    return { name, question, of, model, pass };
  });
}
