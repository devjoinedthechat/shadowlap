// The model behind support_chat.py: the repository's mock of the Anthropic Messages API with a
// scripted support conversation, so the example runs without an API key or a model server.
//
//   node mock_model.mjs     prints the address to give SHADOWLAP_UPSTREAM_ANTHROPIC
//
// It reads the conversation like a model would: it looks the order up, asks whether the customer
// wants a refund or a replacement, does what they answered, and says goodbye when they are done.
import { pathToFileURL } from 'node:url';
import { message, startMockAnthropic, text, toolUse } from '@shadowlap-testing/mock-anthropic';

const lastText = (messages) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return { text: m.content, toolResult: null };
    const result = m.content.find((b) => b.type === 'tool_result');
    if (result) return { text: null, toolResult: result };
    return { text: m.content.filter((b) => b.type === 'text').map((b) => b.text).join(''), toolResult: null };
  }
  return { text: '', toolResult: null };
};

/** The scripted model: what it answers, given the conversation so far. */
export function supportScript({ request }) {
  const answer = (content) => ({ message: message(content, { model: request.model }) });
  const { text: said, toolResult } = lastText(request.messages);
  const asked = request.messages.filter((m) => m.role === 'assistant').flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_use');
  const order = (JSON.stringify(request.messages).match(/[A-Z]-\d+/) ?? ['A-1042'])[0];
  if (toolResult) {
    const last = asked[asked.length - 1];
    const result = JSON.parse(typeof toolResult.content === 'string' ? toolResult.content : '{}');
    if (last?.name === 'lookup_order') return answer([text(`I'm sorry it arrived broken. Would you like a refund or a replacement?`)]);
    if (last?.name === 'create_replacement') return answer([text(result.ok ? `Done: a replacement ships today as ${result.shipment}. Anything else?` : `I could not ship the replacement (${result.error ?? 'not sent'}). Anything else?`)]);
    if (last?.name === 'issue_refund') return answer([text(result.refunded ? `Refunded $${result.amount}. Anything else?` : `I could not issue the refund (${result.error ?? 'not sent'}). Anything else?`)]);
  }
  const lower = (said ?? '').toLowerCase();
  if (/refund/.test(lower)) return answer([toolUse('issue_refund', { order_id: order, amount: 240 })]);
  if (/replace/.test(lower)) return answer([toolUse('create_replacement', { order_id: order })]);
  if (/\bno\b|thank|bye/.test(lower) && asked.length) return answer([text('Glad I could help. Have a good day.')]);
  if (/[A-Z]-\d+/.test(said ?? '')) return answer([toolUse('lookup_order', { order_id: order })]);
  return answer([text('Which order is it about?')]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mock = await startMockAnthropic({ script: supportScript, eventDelayMs: () => 0 });
  console.log(mock.url);
  process.on('SIGINT', () => void mock.close().then(() => process.exit(0)));
}
