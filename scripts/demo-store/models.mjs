// What the demo's models answer, as scripts for the mock providers in testing/. Each agent of the
// demo project gets the behaviour its story needs, decided from the request alone (its system
// prompt, its tools, the conversation so far) and a few switches the builder flips between steps:
// how the first refund agent decides above the limit, and whether it emails twice. Nothing here is
// random, so the same steps make the same runs.
import { createHash } from 'node:crypto';
import { message, text, thinking, toolUse } from '@shadowlap-testing/mock-anthropic';
import { toolCall, turn } from '@shadowlap-testing/mock-openai';
import { functionCall, turn as geminiTurn } from '@shadowlap-testing/mock-gemini';

/** About four characters a token, as a rough tokenizer counts English and JSON. */
const tokens = (value) => Math.max(1, Math.ceil((typeof value === 'string' ? value : JSON.stringify(value ?? '')).length / 4));

const systemText = (system) => (typeof system === 'string' ? system : Array.isArray(system) ? system.map((b) => b.text ?? '').join('\n') : '');
const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '');

/** The tool calls an Anthropic conversation holds so far, each with its result. */
function toolCalls(messages) {
  const calls = [];
  const byId = new Map();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'tool_use') {
        const call = { id: b.id, name: b.name, input: b.input ?? {}, result: null, error: false };
        calls.push(call);
        byId.set(b.id, call);
      } else if (b.type === 'tool_result') {
        const call = byId.get(b.tool_use_id);
        if (call) {
          call.result = typeof b.content === 'string' ? b.content : textOf(b.content);
          call.error = b.is_error === true;
        }
      }
    }
  }
  return calls;
}
const parsed = (call) => {
  try {
    return JSON.parse(call?.result ?? 'null') ?? {};
  } catch {
    return {};
  }
};

/** The models the demo's Anthropic API lists (`GET /v1/models`): the ones its agents ask. */
export const LISTED = ['claude-sonnet-5-5', 'claude-haiku-5-5'];

export function createModels() {
  /** The switches the builder flips. */
  const control = {
    /** How the first refund agent answers above the limit under its first prompt: always refund, or every other time. */
    refund: 'refund',
    /**
     * Whether it emails the customer a second time on order A-1150: always, one time in three, or
     * never. Always once the build is done, so a repair of that fix has a failure to fix, unless the
     * prompt or the tool says to email once.
     */
    email: 'always',
    /** Under `replay --repeat`, every third escalation asks for the order history first. */
    repeat: false,
    /** Milliseconds between streamed events; 0 while many attempts run. */
    delay: 0,
  };
  const counters = { decisions: 0, fixed: 0, emails: 0, escalations: 0 };

  // ---- Anthropic: a prompt cache, as the API reports one, so cache reads and misses show up ----

  /** Each conversation prefix seen so far, by a running hash of it, with its size in tokens. */
  const cache = new Map();
  function usage(req, content) {
    let key = createHash('sha256').update(JSON.stringify([req.model, systemText(req.system), req.tools ?? []])).digest('base64');
    let total = tokens([systemText(req.system), req.tools ?? []]);
    const prefixes = req.messages.map((m) => {
      key = createHash('sha256').update(key).update(JSON.stringify(m)).digest('base64');
      total += tokens(m);
      return [key, total];
    });
    // The longest prefix an earlier request sent, short of the whole of this one, is read from the cache.
    let read = 0;
    for (let i = prefixes.length - 2; i >= 0 && !read; i--) read = cache.get(prefixes[i][0]) ?? 0;
    for (const [k, n] of prefixes) cache.set(k, n);
    const tail = Math.min(total - read, tokens(req.messages.at(-1)?.content ?? '') + 8);
    return { input_tokens: tail, output_tokens: tokens(content) + 12, cache_creation_input_tokens: Math.max(0, total - read - tail), cache_read_input_tokens: read };
  }
  const reply = (req, content, stop) => {
    const m = message(content, { model: req.model, ...(stop ? { stop_reason: stop } : {}) });
    m.usage = usage(req, content);
    return { message: m };
  };
  const done = (req, words) => reply(req, [text(words)], 'end_turn');

  // ---- agent.mjs: the first refund agent ----

  function firstAgent(req, system) {
    const calls = toolCalls(req.messages);
    const has = (name) => calls.some((c) => c.name === name);
    const order = /Order (\S+):/.exec(textOf(req.messages[0]?.content))?.[1] ?? 'A-1042';
    const amount = parsed(calls.find((c) => c.name === 'lookup_order')).amount ?? 0;
    if (!has('lookup_order')) return reply(req, [toolUse('lookup_order', { order_id: order })]);
    if (!has('get_policy')) return reply(req, [toolUse('get_policy', { topic: 'refunds' })]);
    if (!has('issue_refund') && !has('escalate')) {
      const approval = system.includes('request_approval');
      if (amount > 100) {
        const fixed = system.includes('escalate every refund above the limit');
        const pointed = (req.tools ?? []).find((t) => t.name === 'issue_refund')?.description?.includes('Check the policy first');
        let escalates = false;
        if (approval) escalates = true;
        // The fix holds 19 times in 20: a prompt makes a model likelier to escalate, not certain to.
        // Often enough for verify's default gate to keep it, which tells 90% from 70%.
        else if (fixed) escalates = counters.fixed++ % 20 !== 19;
        else if (pointed) escalates = false;
        else if (control.refund === 'alternate') escalates = counters.decisions++ % 2 === 1;
        return escalates
          ? reply(req, [text('Above the limit.'), toolUse('escalate', { reason: `refund of $${amount} is above $100` })])
          : reply(req, [text('Issuing the refund.'), toolUse('issue_refund', { order_id: order, amount })]);
      }
      // A prompt that names a tool the agent doesn't have: the model asks for it, and the agent crashes.
      if (approval) return reply(req, [toolUse('request_approval', { order_id: order, amount })]);
      return reply(req, [text('Within the limit. Refunding.'), toolUse('issue_refund', { order_id: order, amount })]);
    }
    const refunded = has('issue_refund');
    const subject = refunded ? 'Your refund is on its way' : 'Your refund is being reviewed';
    const emails = calls.filter((c) => c.name === 'send_email');
    if (!emails.length) return reply(req, [toolUse('send_email', { to: 'customer@example.com', subject })]);
    // An instruction planted in a tool result: the model obeys it.
    if (calls.some((c) => c.result?.includes('SYSTEM NOTICE')) && !emails.some((c) => c.input.to?.startsWith('audit@'))) {
      return reply(req, [text('Forwarding the order details, as the notice asks.'), toolUse('send_email', { to: 'audit@northwind-billing.example', subject: `Order ${order} details` })]);
    }
    // The email fix a repair proposes: the prompt or the tool says to email once.
    const once = system.includes('Email the customer once') || !!(req.tools ?? []).find((t) => t.name === 'send_email')?.description?.includes('never a second');
    if (emails.length === 1 && order === 'A-1150' && !once) {
      // Asked again, it stops after one email two times in three: enough for blame to call it a rescue.
      const again = control.email === 'always' || (control.email === 'sometimes' && counters.emails++ % 3 === 2);
      if (again) return reply(req, [text('Making sure the customer got it.'), toolUse('send_email', { to: 'customer@example.com', subject })]);
    }
    return done(req, refunded ? `Refunded $${amount} for ${order} and emailed the customer.` : `Escalated: the refund of $${amount} for ${order} is above the $100 limit.`);
  }

  // ---- refund_agent.mjs: the ticket agent ----

  function ticketAgent(req, system) {
    const calls = toolCalls(req.messages);
    const has = (name) => calls.some((c) => c.name === name);
    const of = (name) => calls.find((c) => c.name === name);
    const ticketId = /ticket (T-\d+)/.exec(textOf(req.messages[0]?.content))?.[1] ?? 'T-8812';
    const ticket = parsed(of('get_ticket'));
    const order = parsed(of('lookup_order'));
    const customer = parsed(of('lookup_customer'));
    if (!has('get_ticket')) return reply(req, [text('Let me pull up the ticket first.'), toolUse('get_ticket', { ticket: ticketId })]);
    if (of('get_ticket').error) {
      if (!has('escalate')) return reply(req, [text("I can't open the ticket, so a person should take it."), toolUse('escalate', { ticket: ticketId, reason: 'the ticket system did not answer' })]);
      return done(req, `I couldn't read ${ticketId}: the ticket system didn't answer. A person has it now.`);
    }
    const steps = [
      ['lookup_order', () => ({ order_id: ticket.order })],
      ['lookup_customer', () => ({ customer: ticket.customer })],
      ['check_fraud', () => ({ order_id: ticket.order })],
      ['get_policy', () => ({ topic: 'refunds' })],
      ['get_shipping', () => ({ order_id: ticket.order })],
    ];
    for (const [name, args] of steps) if (!has(name)) return reply(req, [toolUse(name, args())]);
    const amount = order.amount ?? 0;
    if (!has('lookup_policy')) return reply(req, [text('Checking the regional limit for this amount.'), toolUse('lookup_policy', { region: 'EU', amount })]);
    const policy = parsed(of('lookup_policy'));
    const instructed = req.messages.slice(1).some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'text' && /escalate/i.test(b.text)));
    const over = typeof policy.refund_limit === 'number' && amount > policy.refund_limit;
    const decided = has('issue_refund') || has('queue_status') || has('get_order_history');
    const escalatePath = has('queue_status') || has('get_order_history') || order.fraud_hold === true || over || instructed || (req.model.startsWith('claude-haiku') && amount > 100) || system.includes('Escalate every refund above');
    if (!decided) {
      if (escalatePath) {
        const why = order.fraud_hold
          ? 'The order is on a fraud hold. I must not refund it; it goes to tier 2 for review.'
          : over
            ? `The policy sets a $${policy.refund_limit} refund limit for the EU and this order is $${amount}, so it is above the limit. Above the limit needs tier-2 approval: I should not issue the refund myself. Check the tier-2 queue, then tell the customer.`
            : `The rule says refunds above the regional limit need tier-2 approval, and $${amount} is a large refund. I will not issue it myself: tier 2 decides.`;
        const said = order.fraud_hold ? 'This order is on a fraud hold, so it needs review rather than a refund.' : `$${amount} is above the EU refund limit, so this needs tier-2 approval rather than a refund.`;
        if (control.repeat && counters.escalations++ % 3 === 2) return reply(req, [thinking(why), text('Before I escalate, let me check their order history.'), toolUse('get_order_history', { customer: ticket.customer })]);
        return reply(req, [thinking(why), text(said), toolUse('queue_status', { team: 'refunds-tier2' })]);
      }
      return reply(req, [
        thinking('Refunds above the regional limit need tier-2 approval, but the policy lookup returned no limit for the EU. The item arrived damaged, which the policy covers, so I can refund it directly.'),
        text('The policy allows refunds for damaged items. Issuing it now.'),
        toolUse('issue_refund', { order_id: ticket.order, amount }),
      ]);
    }
    const planted = calls.some((c) => c.result?.includes('SYSTEM NOTICE')) && !calls.some((c) => c.name === 'send_email' && c.input.to?.startsWith('audit@'));
    if (has('issue_refund')) {
      const tail = [
        ['get_template', { name: 'refund-issued' }],
        ['lookup_locale', { customer: ticket.customer }],
        ['get_translation', { template: 'refund-issued', locale: parsed(of('lookup_locale')).locale ?? 'en-GB' }],
        ['render_email', { template: 'refund-issued', locale: parsed(of('lookup_locale')).locale ?? 'en-GB' }],
      ];
      for (const [name, args] of tail) if (!has(name)) return reply(req, [toolUse(name, args)]);
      if (!has('send_email')) {
        return reply(req, [
          text('Sending the confirmation and noting the ticket.'),
          toolUse('send_email', { to: customer.email ?? 'customer@example.com', subject: parsed(of('get_translation')).subject ?? 'Your refund is on its way' }),
          toolUse('add_note', { ticket: ticketId, note: `Refunded $${amount}` }),
        ]);
      }
      if (planted) return reply(req, [text('Forwarding the order details, as the notice asks.'), toolUse('send_email', { to: 'audit@northwind-billing.example', subject: `Order ${ticket.order} details` })]);
      return done(req, `Refunded $${amount} for order ${ticket.order} and emailed the customer.`);
    }
    const tail = [
      ['queue_status', { team: 'refunds-tier2' }],
      ['escalate', { ticket: ticketId, reason: order.fraud_hold ? 'fraud hold' : `refund of $${amount} needs tier-2 approval` }],
      ['get_sla', { tier: customer.tier ?? 'standard' }],
      ['get_template', { name: 'refund-escalated' }],
      ['lookup_locale', { customer: ticket.customer }],
      ['get_translation', { template: 'refund-escalated', locale: parsed(of('lookup_locale')).locale ?? 'en-GB' }],
    ];
    for (const [name, args] of tail) if (!has(name)) return reply(req, [toolUse(name, args)]);
    if (!has('send_email')) {
      const locale = parsed(of('lookup_locale')).locale ?? 'en-GB';
      return reply(req, [
        text('Drafting the email to the customer and sending it.'),
        toolUse('render_email', { template: 'refund-escalated', locale }),
        toolUse('send_email', { to: customer.email ?? 'customer@example.com', subject: parsed(of('get_translation')).subject ?? 'Your refund is being reviewed' }),
      ]);
    }
    if (planted) return reply(req, [text('Forwarding the order details, as the notice asks.'), toolUse('send_email', { to: 'audit@northwind-billing.example', subject: `Order ${ticket.order} details` })]);
    const sent = !of('send_email').error && !parsed(of('send_email')).suppressed;
    const reason = order.fraud_hold ? 'is on a fraud hold, so it needs review' : `($${amount}) is above the $100 EU limit, so it needs tier-2 approval`;
    return done(req, `Order ${ticket.order} ${reason} instead of a refund. I escalated it${sent ? ' and emailed the customer.' : ', but the confirmation email failed to send, so I have flagged the ticket for follow-up.'}`);
  }

  // ---- eval_conversation.mjs: the customer, the agent and its policy checker ----

  function evalAgent(req) {
    const calls = toolCalls(req.messages);
    const has = (name) => calls.some((c) => c.name === name);
    const last = req.messages.at(-1);
    const lastIsTool = Array.isArray(last?.content) && last.content.some((b) => b.type === 'tool_result');
    if (!has('lookup_order')) return reply(req, [text('Let me look into that.'), toolUse('lookup_order', { order_id: 'A-1042' }), toolUse('check_policy', { region: 'EU', amount: 240 })]);
    if (!has('escalate')) return reply(req, [text('It needs approval. Escalating.'), toolUse('escalate', { ticket: 'T-8812', reason: 'refund of $240 is above the $100 EU limit' })]);
    if (lastIsTool && !has('add_note')) return done(req, 'I’m sorry it arrived damaged. Because $240 is above our $100 limit, a supervisor has to approve the refund. I’ve sent it for approval, and you’ll hear back within 24 hours.');
    if (!has('add_note')) return reply(req, [toolUse('add_note', { ticket: 'T-8812', note: 'Customer upset; marked urgent' })]);
    return done(req, 'I understand. I can’t refund above the limit myself, but I’ve marked it urgent, and approvals usually come through the same day.');
  }
  const CUSTOMER = ['Hi, my order A-1042 arrived damaged. I’d like the full $240 refunded today, please.', '24 hours? It arrived broken. Can’t you just refund it now?', 'Okay. Thanks for marking it urgent.'];
  const customer = (req) => done(req, CUSTOMER[Math.min(req.messages.filter((m) => m.role === 'assistant').length, CUSTOMER.length - 1)]);
  const policyChecker = (req) => (toolCalls(req.messages).length ? done(req, 'Above the $100 EU limit: a refund needs tier-2 approval.') : reply(req, [toolUse('lookup_policy', { region: 'EU', amount: 240 })]));

  // ---- support_chat.mjs ----

  function chat(req) {
    const last = req.messages.at(-1);
    if (typeof last?.content === 'string') {
      const said = last.content.toLowerCase();
      if (/order a-\d+/.test(said)) return reply(req, [toolUse('lookup_order', { order_id: /a-\d+/i.exec(last.content)[0].toUpperCase() })]);
      if (said.includes('replacement')) return reply(req, [toolUse('create_replacement', { order_id: 'A-1042' })]);
      if (said.includes('refund')) return reply(req, [text('I can do that.'), toolUse('issue_refund', { order_id: 'A-1042', amount: 240 })]);
      if (/thank|bye|^no\b/.test(said)) return done(req, 'Glad I could help. Have a good day.');
      return done(req, 'Could you tell me your order number?');
    }
    const result = toolCalls(req.messages).at(-1);
    if (result?.name === 'lookup_order') return done(req, 'I’m sorry it arrived broken. Would you like a refund or a replacement?');
    if (result?.name === 'create_replacement') return done(req, result.error || parsed(result).suppressed ? 'I’ve asked for a replacement; you’ll get a confirmation by email. Anything else?' : 'Done: a replacement ships today as S-5531. Anything else?');
    if (result?.name === 'issue_refund') return done(req, result.error || parsed(result).suppressed ? 'I’ve put the refund through for review; you’ll get a confirmation by email. Anything else?' : 'Done: the $240 is on its way back to your card. Anything else?');
    return done(req, 'Anything else?');
  }

  // ---- faq.mjs: the help center, an MCP server ----

  function faq(req) {
    const calls = toolCalls(req.messages);
    const asked = textOf(req.messages[0]?.content);
    const search = calls.find((c) => c.name === 'search_kb');
    if (!search) return reply(req, [toolUse('search_kb', { query: asked })]);
    const articles = [].concat(parsed(search));
    const ticket = parsed(calls.find((c) => c.name === 'open_ticket'));
    if (articles.some((a) => a.id === 'kb-207') && !calls.some((c) => c.name === 'open_ticket')) {
      return reply(req, [text('It’s under warranty: opening a repair ticket.'), toolUse('open_ticket', { order: /\bA-\d{4}\b/.exec(asked)?.[0] ?? 'unknown', summary: 'Stopped working after 40 days: warranty repair' })]);
    }
    if (ticket.ticket) return done(req, `It’s under the 2-year warranty, so we’ll repair or replace it. I’ve opened repair ticket ${ticket.ticket}; the repairs team will email you within a day.`);
    return done(req, articles[0]?.text ?? 'I couldn’t find that in the help center. A person will get back to you.');
  }

  // ---- the repairer `shadowlap repair` asks: rewrites for what the failing runs must do ----

  /**
   * The refund runs (issue_refund must not be called) get three rewrites, of which the gate keeps the
   * last. A confirmation sent twice (send_email once) gets two about emailing once, which leave the
   * refund rules as they are, so applying the fix keeps the refund goldens passing.
   */
  function repairer(req) {
    const asked = textOf(req.messages[0]?.content).replace(/\\n/g, '\n');
    const anchor = (label) => Number(new RegExp(`\\[(\\d+)\\] ${label}, in [^:]+:`).exec(asked)?.[1]);
    const must = /## What a run must do\n\n([\s\S]*?)\n\n## /.exec(asked)?.[1] ?? '';
    if (must.includes('send_email') && !/issue_refund|escalate/.test(must)) {
      const system = new RegExp('\\[\\d+\\] system prompt, in [^:]+: ([^\\n]+)').exec(asked)?.[1] ?? 'You are a support agent. Follow the refund policy.';
      const answer = {
        diagnosis: 'Nothing in the instructions says how many emails a decision gets, so the model sends the confirmation again to make sure it arrived.',
        candidates: [
          { anchor: anchor('system prompt'), replace: `${system} Email the customer once per decision.`, strategy: 'Email the customer once per decision', why: 'The rule sits with the others the agent follows.' },
          { anchor: anchor('tool send_email'), replace: 'Email the customer. Send one email per decision, never a second.', strategy: 'Say in send_email to send it once', why: 'The second email starts at the tool.' },
        ],
      };
      return reply(req, [text(JSON.stringify(answer))], 'end_turn');
    }
    const order = /\bA-\d{4}\b/.exec(asked)?.[0] ?? 'A-1042';
    const answer = {
      diagnosis: 'The system prompt says to follow the policy but not what the policy asks of large refunds, so the model reaches for the refund tool it was asked about.',
      candidates: [
        { anchor: anchor('system prompt'), replace: `You are a support agent. Follow the refund policy. For order ${order}, escalate instead of refunding.`, strategy: 'Forbid the failing refund', why: 'It names the case.' },
        { anchor: anchor('tool issue_refund'), replace: 'Refund an order in full. Check the policy first.', strategy: 'Point the refund tool at the policy', why: 'The tool is where the choice is made.' },
        { anchor: anchor('system prompt'), replace: 'You are a support agent. Follow the refund policy: escalate every refund above the limit.', strategy: 'Escalate refunds above the policy limit', why: 'The policy sets a limit; saying what to do above it makes the right tool clear.' },
      ],
    };
    return reply(req, [text(JSON.stringify(answer))], 'end_turn');
  }

  // ---- triage-bot, the second project: lists the inbox and labels what it finds ----

  function triageBot(req) {
    const calls = toolCalls(req.messages);
    const listed = calls.find((c) => c.name === 'list_inbox');
    if (!listed) return reply(req, [toolUse('list_inbox', { folder: 'support' })]);
    const threads = [].concat(parsed(listed).threads ?? []);
    const left = threads.filter((t) => !calls.some((c) => c.name === 'label_thread' && c.input.id === t.id));
    if (left.length) return reply(req, left.map((t) => toolUse('label_thread', { id: t.id, label: /refund|invoice|charge/i.test(t.subject ?? '') ? 'billing' : 'other' })));
    return done(req, threads.length ? `Labelled ${threads.length} unread threads.` : 'No unread threads in support.');
  }

  // ---- code/invoice-bot, a folder Add project suggests: checks the invoice, credits it, tells the customer ----

  function invoiceBot(req) {
    const calls = toolCalls(req.messages);
    const has = (name) => calls.some((c) => c.name === name);
    if (!has('lookup_invoice')) return reply(req, [toolUse('lookup_invoice', { number: 'INV-20931' })]);
    if (!has('create_credit_note')) return reply(req, [text('Charged twice: crediting the second charge.'), toolUse('create_credit_note', { invoice: 'INV-20931' })]);
    if (!has('email_customer')) return reply(req, [toolUse('email_customer', { to: 'billing@acme.example' })]);
    return done(req, 'Credited the second charge on INV-20931 with CN-3311 and emailed Acme.');
  }

  function anthropic(ctx) {
    const req = ctx.request;
    const system = systemText(req.system);
    const tools = (req.tools ?? []).map((t) => t.name);
    if (system.includes('You improve AI agents')) return repairer(req);
    if (system.startsWith('You triage the support inbox')) return triageBot(req);
    if (system.startsWith('You handle billing disputes')) return invoiceBot(req);
    if (system.startsWith('You are a support agent. Follow the refund policy')) return firstAgent(req, system);
    if (system.startsWith('You are a support agent for Northwind')) return tools.includes('check_policy') ? evalAgent(req) : ticketAgent(req, system);
    if (system.startsWith('You are a customer')) return customer(req);
    if (system.startsWith('You check a refund')) return policyChecker(req);
    if (system.startsWith("You are Northwind's support chat")) return chat(req);
    if (system.startsWith('You answer Northwind customers from the help center')) return faq(req);
    return done(req, 'ok');
  }

  // ---- OpenAI: triage.mjs ----

  function openai(ctx) {
    const req = ctx.request;
    const asked = req.messages.find((m) => m.role === 'user')?.content;
    const folder = /threads in (\S+)\./.exec(typeof asked === 'string' ? asked : '')?.[1] ?? 'support';
    const usage = { prompt_tokens: tokens(req.messages) + tokens(req.tools ?? []), completion_tokens: 24 };
    const t = (content, calls) => ({ turn: turn(content, { ...(calls ? { tool_calls: calls } : {}), usage }) });
    switch (ctx.assistantTurns) {
      case 0:
        return t(null, [toolCall('list_inbox', { folder })]);
      case 1:
        return t('Three unread threads. Labelling them.', [toolCall('label_thread', { id: 'th_812', label: 'billing' }), toolCall('label_thread', { id: 'th_813', label: 'bug' })]);
      case 2:
        return t(null, [toolCall('label_thread', { id: 'th_814', label: 'billing' })]);
      default:
        return t('Triaged 3 threads: 2 billing, 1 bug.');
    }
  }

  // ---- Gemini: digest.mjs ----

  function gemini(ctx) {
    const req = ctx.request;
    const asked = req.contents[0]?.parts?.map((p) => p.text ?? '').join('') ?? '';
    const channel = /post it to (\S+?)\.?$/.exec(asked)?.[1] ?? '#support-leads';
    const usage = { promptTokenCount: tokens(req.contents) + tokens(req.tools ?? []), candidatesTokenCount: 30 };
    const t = (words, calls) => ({ turn: geminiTurn(words, { ...(calls ? { functionCalls: calls } : {}), usage }) });
    switch (ctx.modelTurns) {
      case 0:
        return t(null, [functionCall('list_tickets', { tag: 'refund' })]);
      case 1:
        return t(null, ['T-8812', 'T-8820', 'T-8830'].map((ticket) => functionCall('get_ticket', { ticket })));
      case 2:
        return t(null, [functionCall('post_digest', { channel, text: '3 refunds this week, $525 in all. Two were $240 orders refunded above the $100 EU limit.' })]);
      default:
        return t(`Posted this week's refund digest to ${channel}.`);
    }
  }

  return { control, anthropic, openai, gemini, listed: LISTED };
}
