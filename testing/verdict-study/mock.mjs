// A stand-in model for a dry run of the study (study.mjs --mock): it plays the subject's model from
// what the request says, so the study's plumbing can be checked with nothing spent. It reads the
// policy when the prompt mentions one, follows the limit it then read, and obeys a prompt that tells
// it to always or never refund. One answer in thirty decides the other way, as a model's sampling does.
import { message, startMockAnthropic, text, toolUse } from '@shadowlap-testing/mock-anthropic';

const said = (request) => JSON.stringify(request.messages);
const results = (request, name) => {
  const ids = request.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_use' && b.name === name).map((b) => b.id);
  return request.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result' && ids.includes(b.tool_use_id)).map((b) => String(b.content));
};

function script(ctx) {
  const { request } = ctx;
  const system = JSON.stringify(request.system ?? '');
  const has = (name) => (request.tools ?? []).some((t) => t.name === name);
  const id = (name) => `toolu_${name}_${ctx.requestNo}`;
  const order = /order ([A-Z]-\d+)/.exec(said(request))?.[1] ?? 'A-1042';
  const looked = results(request, 'lookup_order')[0];
  if (!looked) return { message: message([toolUse('lookup_order', { order_id: order }, id('lookup'))]) };
  const policy = results(request, 'read_policy')[0];
  if (!policy && /policy/i.test(system) && has('read_policy')) return { message: message([toolUse('read_policy', {}, id('policy'))]) };
  if (said(request).includes('"name":"issue_refund"') || said(request).includes('"name":"escalate"')) return { message: message([text('Done.')], { stop_reason: 'end_turn' }) };
  const amount = Number(/"amount\\?":(\d+)/.exec(looked)?.[1] ?? 0);
  const limit = Number(/above \$(\d+)/.exec(`${policy ?? ''} ${system}`)?.[1] ?? Infinity);
  let escalates = amount > limit;
  if (/always issue the refund/.test(system)) escalates = false;
  if (/Never issue a refund/.test(system)) escalates = true;
  if (Math.random() < 1 / 30) escalates = !escalates;
  if (escalates && has('escalate')) return { message: message([toolUse('escalate', { reason: `a refund of $${amount} needs a manager` }, id('decide'))]) };
  return { message: message([toolUse('issue_refund', { order_id: order, amount }, id('decide'))]) };
}

/** Starts the stand-in and returns it: `url` to send the subject's requests to, `close` to stop it. */
export const startStandIn = () => startMockAnthropic({ script, eventDelayMs: () => 0 });
