// The smallest agent that exercises what Shadowlap parses, against one real provider: a call that must
// use a tool (so tool-call parsing is tested), then a streamed call (so stream parsing and timing are).
// Prints one JSON line. Usage: node agent.mjs <provider>
const provider = process.argv[2];
const WEATHER = { name: 'get_weather', description: 'Current weather for a city.', schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } };
const ASK_TOOL = 'What is the weather in Paris? Use the tool.';
const ASK_TEXT = 'Reply with exactly one word: ready';
const out = {};

if (provider === 'anthropic') {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ maxRetries: 2 });
  const model = process.env.LIVE_ANTHROPIC_MODEL || 'claude-haiku-4-5';
  const a = await client.messages.create({ model, max_tokens: 128, tools: [{ name: WEATHER.name, description: WEATHER.description, input_schema: WEATHER.schema }], tool_choice: { type: 'tool', name: WEATHER.name }, messages: [{ role: 'user', content: ASK_TOOL }] });
  const use = a.content.find((b) => b.type === 'tool_use');
  out.tool = use ? { name: use.name, input: use.input } : null;
  const b = await client.messages.stream({ model, max_tokens: 16, messages: [{ role: 'user', content: ASK_TEXT }] }).finalMessage();
  out.text = b.content.filter((x) => x.type === 'text').map((x) => x.text).join('');
} else if (provider === 'openai' || provider === 'azure') {
  const openai = await import('openai');
  const azure = provider === 'azure';
  const client = azure ? new openai.AzureOpenAI({ endpoint: process.env.AZURE_OPENAI_ENDPOINT, apiVersion: process.env.LIVE_AZURE_API_VERSION || '2024-10-21', deployment: process.env.LIVE_AZURE_DEPLOYMENT, maxRetries: 2 }) : new openai.default({ maxRetries: 2 });
  const model = azure ? process.env.LIVE_AZURE_DEPLOYMENT : (process.env.LIVE_OPENAI_MODEL || 'gpt-4.1-mini');
  const a = await client.chat.completions.create({ model, max_tokens: 128, tools: [{ type: 'function', function: { name: WEATHER.name, description: WEATHER.description, parameters: WEATHER.schema } }], tool_choice: { type: 'function', function: { name: WEATHER.name } }, messages: [{ role: 'user', content: ASK_TOOL }] });
  const call = a.choices[0]?.message.tool_calls?.[0];
  out.tool = call ? { name: call.function.name, input: JSON.parse(call.function.arguments) } : null;
  const stream = await client.chat.completions.create({ model, max_tokens: 16, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: ASK_TEXT }] });
  let text = '';
  for await (const chunk of stream) text += chunk.choices[0]?.delta?.content ?? '';
  out.text = text;
  if (!azure && !process.env.LIVE_SELFTEST) {
    // The Responses API has its own request and stream shapes.
    const r = await client.responses.create({ model, input: ASK_TEXT, max_output_tokens: 16 });
    out.responses = r.output_text;
  }
} else if (provider === 'gemini' || provider === 'vertex') {
  const { GoogleGenAI } = await import('@google/genai');
  const vertex = provider === 'vertex';
  const ai = vertex ? new GoogleGenAI({ vertexai: true, project: process.env.LIVE_VERTEX_PROJECT, location: process.env.LIVE_VERTEX_LOCATION || 'us-central1' }) : new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const model = (vertex ? process.env.LIVE_VERTEX_MODEL : process.env.LIVE_GEMINI_MODEL) || 'gemini-2.5-flash';
  const a = await ai.models.generateContent({ model, contents: ASK_TOOL, config: { maxOutputTokens: 256, tools: [{ functionDeclarations: [{ name: WEATHER.name, description: WEATHER.description, parametersJsonSchema: WEATHER.schema }] }], toolConfig: { functionCallingConfig: { mode: 'ANY' } } } });
  const call = a.functionCalls?.[0];
  out.tool = call ? { name: call.name, input: call.args } : null;
  let text = '';
  for await (const chunk of await ai.models.generateContentStream({ model, contents: ASK_TEXT, config: { maxOutputTokens: 64 } })) text += chunk.text ?? '';
  out.text = text;
} else if (provider === 'bedrock') {
  const { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand } = await import('@aws-sdk/client-bedrock-runtime');
  const client = new BedrockRuntimeClient({});
  const modelId = process.env.LIVE_BEDROCK_MODEL;
  const a = await client.send(new ConverseCommand({ modelId, inferenceConfig: { maxTokens: 128 }, toolConfig: { tools: [{ toolSpec: { name: WEATHER.name, description: WEATHER.description, inputSchema: { json: WEATHER.schema } } }], toolChoice: { tool: { name: WEATHER.name } } }, messages: [{ role: 'user', content: [{ text: ASK_TOOL }] }] }));
  const use = a.output?.message?.content?.find((b) => b.toolUse)?.toolUse;
  out.tool = use ? { name: use.name, input: use.input } : null;
  const b = await client.send(new ConverseStreamCommand({ modelId, inferenceConfig: { maxTokens: 16 }, messages: [{ role: 'user', content: [{ text: ASK_TEXT }] }] }));
  let text = '';
  for await (const event of b.stream) text += event.contentBlockDelta?.delta?.text ?? '';
  out.text = text;
} else {
  throw new Error(`unknown provider ${provider}`);
}
console.log(JSON.stringify(out));
