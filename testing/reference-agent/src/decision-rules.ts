import { message, text, thinking, toolUse, type MockMessage, type ScriptContext, type ScriptResult } from '@shadowlap-testing/mock-anthropic';

/**
 * How the reference scenario's model answers a change, for the decision diff (`shadowlap decisions`,
 * `migrate`): the same conversation asked under another prompt or another model decides differently
 * at known steps, so a test can say which step changes and how.
 *
 * - A system prompt that says "Do not email the summary." ends the turn that would have emailed with
 *   an answer instead: a write removed, rank 1. (Other tests play "Never send email." themselves.)
 * - A system prompt that says "Keep the final answer short." words the final answer in fewer words,
 *   which no longer say that forks fence writes: a text-only change.
 * - `claude-haiku-4-5` searches differently at the third turn (a read asked differently, rank 4), skips
 *   the page it fetched at the fifth (a read removed, rank 3) and words the email's body its own way
 *   (a write with other arguments, rank 1).
 * - `mock-small` takes no more than 512 output tokens and says so as the Messages API does, with the
 *   other answers as `claude-haiku-4-5` gives them.
 * - Claude 4.7 and later refuse a non-default temperature, top_p or top_k with a 400, as Anthropic's
 *   deprecation page says they do, and a manual thinking budget (`thinking.type: "enabled"`) as its
 *   extended thinking page says, in the words that page quotes.
 * - A request that asks to think gets a thinking block before each answer, the same one for the same
 *   turn, so a recording carries reasoning in its history.
 * - `mock-coin` words the email its own way once in every three times it is asked at that turn, and
 *   plays the rest as recorded: a model's own variation, which `--samples` tells from a change.
 * - `mock-terse` and `mock-wordy` word the final answer their own way and play every other turn as
 *   recorded: a text-only change. The terse answer no longer says that forks fence writes; the wordy
 *   one still does, in other words.
 * - `mock-mixed` words the final answer as `mock-terse` does the first time it is asked, as
 *   `mock-wordy` does the next, and so on in turn: samples whose words a judge reads both ways.
 *
 * Every other request plays the scenario as recorded.
 */

/** How many times `mock-coin` was asked at each turn. */
const coinAsked = new Map<number, number>();
/** How many times `mock-mixed` was asked for the final answer. */
let mixedAsked = 0;

const NO_EMAIL = /\bDo not email the summary\b/;
const SHORT_ANSWER = /\bKeep the final answer short\b/;
const CLAUDE_4_7_AND_LATER = /^claude-(opus-4-[78]|opus-5|sonnet-5|haiku-5|fable-5|mythos-5)/;
const DEPRECATED_SAMPLING = /^claude-(opus-4-[78]|opus-5|sonnet-5|haiku-5|fable-5|mythos-5|mythos-preview)/;
const DEFAULTS: Record<string, unknown> = { temperature: 1 };

const systemText = (system: unknown): string => {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map((b) => (typeof b === 'object' && b !== null && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n');
  return '';
};

const refusal = (message: string): ScriptResult => ({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message } } });

/** The thinking mode a request asks for: `enabled` (a budget) or `adaptive`, or null. */
const thinkingMode = (body: Record<string, unknown>): string | null => {
  const t = body.thinking as { type?: unknown } | undefined;
  return typeof t?.type === 'string' && t.type !== 'disabled' ? t.type : null;
};

/** The answer a change gets at this turn, or null to play the scenario as recorded. */
export function decisionRules(ctx: ScriptContext, turns: readonly MockMessage[]): ScriptResult | null {
  const model = ctx.request.model;
  const body = ctx.request as unknown as Record<string, unknown>;
  if (DEPRECATED_SAMPLING.test(model)) {
    for (const field of ['temperature', 'top_p', 'top_k']) {
      if (body[field] !== undefined && body[field] !== DEFAULTS[field]) return refusal(`${field}: ${model} accepts only the default value; omit it and use prompting to guide the model`);
    }
  }
  if (CLAUDE_4_7_AND_LATER.test(model) && thinkingMode(body) === 'enabled') return refusal('"thinking.type.enabled" is not supported for this model');
  if (model === 'mock-small' && ctx.request.max_tokens > 512) return refusal(`max_tokens: ${ctx.request.max_tokens} > 512, which is the maximum allowed number of output tokens for mock-small`);
  const turn = turns[ctx.assistantTurns];
  if (!turn) return null;
  const thinks = thinkingMode(body) !== null;
  const emails = turn.content.some((b) => b.type === 'tool_use' && b.name === 'send_email');
  const answer = (m: MockMessage): ScriptResult => {
    const reasoning = thinks ? [thinking(`Turn ${ctx.assistantTurns + 1}: what the results so far call for.`, Buffer.from(`mock-thinking-${ctx.assistantTurns + 1}`).toString('base64'))] : [];
    return { message: { ...m, content: [...reasoning, ...m.content], id: `${m.id}_r${ctx.requestNo}`, model, usage: { ...m.usage } } };
  };
  if (ctx.assistantTurns === turns.length - 1 && SHORT_ANSWER.test(systemText(ctx.request.system))) {
    return answer(message([text('Done. Recorded runs replay deterministically.')], { stop_reason: 'end_turn', input_tokens: turn.usage.input_tokens, output_tokens: turn.usage.output_tokens - 8 }));
  }
  if (emails && NO_EMAIL.test(systemText(ctx.request.system))) {
    return answer(message([text('Summary: recorded runs replay deterministically, and forks fence writes. Not sent by email, as instructed.')], { stop_reason: 'end_turn', input_tokens: turn.usage.input_tokens, output_tokens: 32 }));
  }
  if (model === 'mock-coin') {
    const n = (coinAsked.get(ctx.assistantTurns) ?? 0) + 1;
    coinAsked.set(ctx.assistantTurns, n);
    if (emails && n % 3 === 1) return answer(message([text('Sending the summary.'), toolUse('send_email', { to: 'team@example.com', subject: 'Research summary', body: 'Replay works; forks fence writes.' }, 'toolu_coin_email')], { input_tokens: turn.usage.input_tokens, output_tokens: turn.usage.output_tokens }));
    return answer({ ...turn });
  }
  if (model === 'mock-terse' || model === 'mock-wordy' || model === 'mock-mixed') {
    if (ctx.assistantTurns !== turns.length - 1) return answer({ ...turn });
    const terse = model === 'mock-terse' || (model === 'mock-mixed' && ++mixedAsked % 2 === 1);
    const said = terse ? 'Done. Recorded runs replay deterministically.' : 'All done. In short: recorded runs replay deterministically, and forks fence writes.';
    return answer(message([text(said)], { stop_reason: 'end_turn', input_tokens: turn.usage.input_tokens, output_tokens: turn.usage.output_tokens }));
  }
  if (model === 'claude-haiku-4-5' || model === 'mock-small') {
    const same = { input_tokens: turn.usage.input_tokens, output_tokens: turn.usage.output_tokens };
    if (ctx.assistantTurns === 2) return answer(message([toolUse('search_web', { query: 'determinism in agents' }, 'toolu_haiku_search')], same));
    if (ctx.assistantTurns === 4) return answer(message([toolUse('read_file', { path: 'config.json' }, 'toolu_haiku_read')], same));
    if (emails) return answer(message([text('Sending the summary.'), toolUse('send_email', { to: 'team@example.com', subject: 'Research summary', body: 'Replay works; forks fence writes.' }, 'toolu_haiku_email')], same));
    return answer({ ...turn });
  }
  return thinks ? answer({ ...turn }) : null;
}
