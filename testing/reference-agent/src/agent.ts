import Anthropic from '@anthropic-ai/sdk';
import { appendFileSync } from 'node:fs';
import { now, serializeError, tool, uuid } from '@shadowlap/sdk';

/**
 * The reference agent: a hand-rolled loop over the official SDK with streaming, parallel tool
 * execution and the four effect classes. It is deliberately ordinary agent code; nothing in it
 * exists to make replay easier except the `tool()` wrappers and the clock/uuid helpers.
 */

export interface AgentOptions {
  client: Anthropic;
  model?: string;
  /** Adds "Today is <date>." to the system prompt: the classic ambient-drift source. */
  date?: string;
  /** Extra system text: changes every request, so a replay forks at the first model call. */
  systemSuffix?: string;
  /** Adds a user instruction before the 6th model call: changes late requests only (class 2). */
  lateChange?: boolean;
  /** File the `send_email` write tool appends to, so tests can prove a fork didn't send. */
  outbox?: string;
  /** Throw after this many model calls (a crashing agent). */
  failAfterModelCall?: number;
  /** Wait this long before every model call (room for an interrupt). */
  pauseMs?: number;
  /** Think before each answer with this budget: extended thinking in manual mode (`budget_tokens`). */
  thinkingBudget?: number;
  /**
   * Send email only to this domain: an email to anyone else is refused in the agent's own code,
   * before the tool runs, and the model is told why. The code fix an injection test can apply.
   */
  emailDomain?: string;
  log?: (line: string) => void;
}

export interface AgentResult {
  finalText: string;
  modelCalls: number;
  toolCalls: number;
  toolErrors: string[];
  startedAt: number;
  requestId: string;
}

const FILES: Record<string, string> = {
  'notes.md': '# Notes\nshadowlap records and replays agent runs.',
  'config.json': '{"model":"claude-opus-5","max_tokens":1024}',
  'data.csv': 'id,value\n1,10\n2,20',
};

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const searchWeb = tool('search_web', { effect: 'read' }, async ({ query }: { query: string }) => {
  await delay(2 + Math.floor(Math.random() * 6));
  return { results: [1, 2, 3].map((i) => ({ title: `${query} #${i}`, url: `https://example.com/${encodeURIComponent(query)}/${i}` })) };
});

export const readFile = tool('read_file', { effect: 'pure' }, async ({ path }: { path: string }) => {
  const content = FILES[path];
  if (content === undefined) throw Object.assign(new Error(`no such file: ${path}`), { code: 'ENOENT' });
  return { path, content };
});

export const fetchPage = tool('fetch_page', { effect: 'read' }, async ({ url }: { url: string }) => {
  await delay(1 + Math.floor(Math.random() * 8));
  return { url, title: `Page ${url.slice(-1)}`, text: `Content of ${url}` };
});

export function makeSendEmail(outbox: string | undefined) {
  return tool(
    'send_email',
    {
      effect: 'write',
      onFork: (args: { to: string; subject: string; body: string }) => ({ sent: false, suppressed: true, to: args.to }),
    },
    async (args: { to: string; subject: string; body: string }) => {
      if (outbox) appendFileSync(outbox, JSON.stringify({ ...args, at: Date.now() }) + '\n');
      return { sent: true, to: args.to };
    },
  );
}

export const TOOLS: Anthropic.Tool[] = [
  { name: 'search_web', description: 'Search the web.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'read_file', description: 'Read a project file.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'fetch_page', description: 'Fetch a web page.', input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  {
    name: 'send_email',
    description: 'Send an email.',
    input_schema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] },
  },
];

export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  const log = opts.log ?? (() => {});
  const sendEmail = makeSendEmail(opts.outbox);
  const impls: Record<string, (args: never) => Promise<unknown>> = {
    search_web: searchWeb,
    read_file: readFile,
    fetch_page: fetchPage,
    send_email: sendEmail,
  };

  const startedAt = await now('start');
  const requestId = await uuid('request');
  let system = 'You are a research agent. Use the tools, then email a summary.';
  if (opts.date) system += ` Today is ${opts.date}.`;
  if (opts.systemSuffix) system += ` ${opts.systemSuffix}`;

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: `Research request ${requestId}: investigate replay for agents and report back.` }];
  let modelCalls = 0;
  let toolCalls = 0;
  const toolErrors: string[] = [];
  let finalText = '';

  for (let turn = 0; turn < 40; turn++) {
    if (opts.lateChange && modelCalls === 5) messages.push({ role: 'user', content: 'Focus on recent sources only.' });
    if (opts.failAfterModelCall !== undefined && modelCalls >= opts.failAfterModelCall) throw new Error(`agent crashed after model call ${modelCalls}`);
    if (opts.pauseMs) await delay(opts.pauseMs);
    // With a thinking budget, the answer's limit leaves room for the answer after it.
    const thinking = opts.thinkingBudget ? { thinking: { type: 'enabled' as const, budget_tokens: opts.thinkingBudget } } : {};
    const stream = opts.client.messages.stream({ model: opts.model ?? 'claude-opus-5', max_tokens: 1024 + (opts.thinkingBudget ?? 0), system, tools: TOOLS, messages, ...thinking });
    const response = await stream.finalMessage();
    modelCalls++;
    messages.push({ role: 'assistant', content: response.content });
    log(`model call ${modelCalls}: stop_reason=${String(response.stop_reason)}`);

    const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || uses.length === 0) {
      finalText = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      break;
    }

    // Parallel tool execution; all results go back in one user message.
    const results = await Promise.all(
      uses.map(async (use): Promise<Anthropic.ToolResultBlockParam> => {
        toolCalls++;
        const impl = impls[use.name];
        try {
          if (!impl) throw new Error(`unknown tool ${use.name}`);
          const to = (use.input as { to?: unknown }).to;
          if (use.name === 'send_email' && opts.emailDomain && !(typeof to === 'string' && to.toLowerCase().endsWith(`@${opts.emailDomain.toLowerCase()}`))) {
            throw new Error(`refused: ${String(to)} is not an address at ${opts.emailDomain}`);
          }
          const result = await impl(use.input as never);
          return { type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(result) };
        } catch (err) {
          const e = serializeError(err);
          toolErrors.push(`${use.name}: ${e.name}: ${e.message}`);
          log(`tool ${use.name} failed: ${e.name}: ${e.message}`);
          return { type: 'tool_result', tool_use_id: use.id, content: `${e.name}: ${e.message}`, is_error: true };
        }
      }),
    );
    messages.push({ role: 'user', content: results });
  }

  return { finalText, modelCalls, toolCalls, toolErrors, startedAt, requestId };
}
