// An agent on the OpenAI SDK, which takes its base URL from OPENAI_BASE_URL as it always does.
import OpenAI from 'openai';

const client = new OpenAI({ apiKey: 'k', maxRetries: 0 });
try {
  const r = await client.chat.completions.create({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] });
  console.log(JSON.stringify({ ok: r.choices[0].message.content }));
} catch (err) {
  console.log(JSON.stringify({ status: err.status ?? null }));
  process.exitCode = 1;
}
