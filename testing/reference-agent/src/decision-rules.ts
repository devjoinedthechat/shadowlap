import { message, text, toolUse, type MockMessage, type ScriptContext, type ScriptResult } from '@shadowlap-testing/mock-anthropic';

/**
 * How the reference scenario's model answers a change, for the decision diff (`shadowlap decisions`,
 * `migrate`): the same conversation asked under another prompt or another model decides differently
 * at known steps, so a test can say which step changes and how.
 *
 * - A system prompt that says "Do not email the summary." ends the turn that would have emailed with
 *   an answer instead: a write removed, rank 1. (Other tests play "Never send email." themselves.)
 * - `claude-haiku-4-5` searches differently at the third turn (a read asked differently, rank 4), skips
 *   the page it fetched at the fifth (a read removed, rank 3) and words the email's body its own way
 *   (a write with other arguments, rank 1).
 * - `mock-small` takes no more than 512 output tokens and says so as the Messages API does, with the
 *   other answers as `claude-haiku-4-5` gives them.
 * - Claude 4.7 and later refuse a non-default temperature, top_p or top_k with a 400, as Anthropic's
 *   deprecation page says they do.
 *
 * Every other request plays the scenario as recorded.
 */

const NO_EMAIL = /\bDo not email the summary\b/;
const DEPRECATED_SAMPLING = /^claude-(opus-4-[78]|opus-5|sonnet-5|haiku-5|fable-5|mythos-5|mythos-preview)/;
const DEFAULTS: Record<string, unknown> = { temperature: 1 };

const systemText = (system: unknown): string => {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map((b) => (typeof b === 'object' && b !== null && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n');
  return '';
};

const refusal = (message: string): ScriptResult => ({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message } } });

/** The answer a change gets at this turn, or null to play the scenario as recorded. */
export function decisionRules(ctx: ScriptContext, turns: readonly MockMessage[]): ScriptResult | null {
  const model = ctx.request.model;
  const body = ctx.request as unknown as Record<string, unknown>;
  if (DEPRECATED_SAMPLING.test(model)) {
    for (const field of ['temperature', 'top_p', 'top_k']) {
      if (body[field] !== undefined && body[field] !== DEFAULTS[field]) return refusal(`${field}: ${model} accepts only the default value; omit it and use prompting to guide the model`);
    }
  }
  if (model === 'mock-small' && ctx.request.max_tokens > 512) return refusal(`max_tokens: ${ctx.request.max_tokens} > 512, which is the maximum allowed number of output tokens for mock-small`);
  const turn = turns[ctx.assistantTurns];
  if (!turn) return null;
  const emails = turn.content.some((b) => b.type === 'tool_use' && b.name === 'send_email');
  const answer = (m: MockMessage): ScriptResult => ({ message: { ...m, id: `${m.id}_r${ctx.requestNo}`, model, usage: { ...m.usage } } });
  if (emails && NO_EMAIL.test(systemText(ctx.request.system))) {
    return answer(message([text('Summary: recorded runs replay deterministically, and forks fence writes. Not sent by email, as instructed.')], { stop_reason: 'end_turn', input_tokens: turn.usage.input_tokens, output_tokens: 32 }));
  }
  if (model === 'claude-haiku-4-5' || model === 'mock-small') {
    const same = { input_tokens: turn.usage.input_tokens, output_tokens: turn.usage.output_tokens };
    if (ctx.assistantTurns === 2) return answer(message([toolUse('search_web', { query: 'determinism in agents' }, 'toolu_haiku_search')], same));
    if (ctx.assistantTurns === 4) return answer(message([toolUse('read_file', { path: 'config.json' }, 'toolu_haiku_read')], same));
    if (emails) return answer(message([text('Sending the summary.'), toolUse('send_email', { to: 'team@example.com', subject: 'Research summary', body: 'Replay works; forks fence writes.' }, 'toolu_haiku_email')], same));
    return answer({ ...turn });
  }
  return null;
}
