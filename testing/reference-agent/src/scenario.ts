import { message, text, toolUse, type MockMessage, type ScriptContext, type ScriptResult } from '@shadowlap-testing/mock-anthropic';
import { decisionRules } from './decision-rules.js';

/**
 * The deterministic conversation the mock API plays for the reference agent, keyed by how many
 * assistant turns the request already contains. It exercises parallel tool calls (including two
 * calls of the same tool in one turn), repeated identical calls (occurrences), every effect class
 * and a final `write`. Together with the agent's own clock/uuid reads it makes 30 calls.
 */
export const TURNS: MockMessage[] = [
  message([text('Starting research.'), toolUse('search_web', { query: 'shadowlap replay' }), toolUse('read_file', { path: 'notes.md' })]),
  message([toolUse('fetch_page', { url: 'https://example.com/a' }), toolUse('fetch_page', { url: 'https://example.com/b' })]),
  message([toolUse('search_web', { query: 'agent determinism' })]),
  message([toolUse('read_file', { path: 'notes.md' }), toolUse('read_file', { path: 'config.json' })]),
  message([toolUse('fetch_page', { url: 'https://example.com/c' }), toolUse('read_file', { path: 'config.json' })]),
  message([toolUse('search_web', { query: 'side effects' }), toolUse('search_web', { query: 'vector clocks' })]),
  message([toolUse('read_file', { path: 'notes.md' })]),
  message([toolUse('fetch_page', { url: 'https://example.com/d' }), toolUse('read_file', { path: 'data.csv' })]),
  message([toolUse('search_web', { query: 'final check' }), toolUse('fetch_page', { url: 'https://example.com/e' })]),
  message([text('Sending the summary.'), toolUse('send_email', { to: 'team@example.com', subject: 'Research summary', body: 'Replay works.' })]),
  message([text('Done. Summary: recorded runs replay deterministically; forks fence writes.')], { stop_reason: 'end_turn' }),
];

export const EXPECTED_MODEL_CALLS = TURNS.length; // 11
export const EXPECTED_TOOL_CALLS = TURNS.reduce((n, m) => n + m.content.filter((b) => b.type === 'tool_use').length, 0); // 17
export const EXPECTED_MISC_CALLS = 2; // now() + uuid()
export const EXPECTED_TOTAL_CALLS = EXPECTED_MODEL_CALLS + EXPECTED_TOOL_CALLS + EXPECTED_MISC_CALLS; // 30

/** The mock script: play the scripted turn for the conversation's position. */
export function referenceScript(ctx: ScriptContext): ScriptResult {
  // How the model answers a changed prompt or another model, for the decision diff (decision-rules.ts).
  const changed = decisionRules(ctx, TURNS);
  if (changed) return changed;
  const turn = TURNS[ctx.assistantTurns];
  if (!turn) return { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: `mock: no scripted turn ${ctx.assistantTurns}` } } };
  // Fresh ids per request keep the recording honest: tool_use ids are part of the next request.
  return { message: { ...turn, id: `${turn.id}_r${ctx.requestNo}`, usage: { ...turn.usage } } };
}
