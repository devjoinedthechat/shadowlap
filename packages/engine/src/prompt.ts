/**
 * `--prompt-from <call>`: test a changed system prompt or tool set from a later model call, not from
 * the first. Editing the prompt changes every request, so a plain replay forks at call 1 and re-runs
 * everything. With this, model calls before the chosen one are matched without their system prompt
 * and tool definitions, so they replay from the recording; the chosen call runs live, and from there
 * the model sees the new prompt with the recorded history before it. It answers "what if the prompt
 * had been this from step k", not "what if it had always been this": steps before k were answered
 * under the old prompt, and the report says so.
 */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInstruction = (m: unknown) => isObject(m) && (m.role === 'system' || m.role === 'developer');

/** A request without what counts as its prompt: system instructions and tool definitions, in any provider's shape. */
export function withoutPrompt(body: unknown): unknown {
  if (!isObject(body)) return body;
  const out: Record<string, unknown> = { ...body };
  // Anthropic and Bedrock Converse system, OpenAI Responses instructions, Gemini systemInstruction.
  for (const key of ['system', 'instructions', 'systemInstruction', 'system_instruction', 'tools', 'toolConfig', 'tool_config']) delete out[key];
  // OpenAI Chat Completions and Responses carry instructions as messages.
  if (Array.isArray(out.messages)) out.messages = out.messages.filter((m) => !isInstruction(m));
  if (Array.isArray(out.input)) out.input = out.input.filter((m) => !isInstruction(m));
  return out;
}
