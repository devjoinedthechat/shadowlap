#!/usr/bin/env node
import Anthropic from '@anthropic-ai/sdk';
import { runAgent } from './agent.js';

/**
 * Runs the reference agent as a normal process. Point it at the real API or at the mock with
 * ANTHROPIC_BASE_URL (set by `shadowlap run` automatically).
 *
 *   AGENT_DATE=2026-09-16          adds "Today is …" to the system prompt
 *   AGENT_SYSTEM_SUFFIX="…"        appends to the system prompt (forks at call 1)
 *   AGENT_LATE_CHANGE=1            adds an instruction before the 6th model call (forks late)
 *   REFERENCE_AGENT_OUTBOX=path    file the write tool appends to
 *   AGENT_FAIL_AFTER_CALL=5        crash after the 5th model call
 *   AGENT_PAUSE_MS=300             wait before every model call
 *   AGENT_MODEL=claude-sonnet-4-6  the model to ask (default claude-opus-5)
 *   AGENT_THINKING_BUDGET=1024     think before each answer, with this budget_tokens
 *   AGENT_EMAIL_DOMAIN=example.com send email only to that domain (refused in the agent's code otherwise)
 */
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? 'shadowlap-placeholder-key' });
const result = await runAgent({
  client,
  ...(process.env.AGENT_MODEL ? { model: process.env.AGENT_MODEL } : {}),
  ...(process.env.AGENT_DATE ? { date: process.env.AGENT_DATE } : {}),
  ...(process.env.AGENT_SYSTEM_SUFFIX ? { systemSuffix: process.env.AGENT_SYSTEM_SUFFIX } : {}),
  ...(process.env.AGENT_LATE_CHANGE ? { lateChange: true } : {}),
  ...(process.env.REFERENCE_AGENT_OUTBOX ? { outbox: process.env.REFERENCE_AGENT_OUTBOX } : {}),
  ...(process.env.AGENT_FAIL_AFTER_CALL ? { failAfterModelCall: Number(process.env.AGENT_FAIL_AFTER_CALL) } : {}),
  ...(process.env.AGENT_PAUSE_MS ? { pauseMs: Number(process.env.AGENT_PAUSE_MS) } : {}),
  ...(process.env.AGENT_THINKING_BUDGET ? { thinkingBudget: Number(process.env.AGENT_THINKING_BUDGET) } : {}),
  ...(process.env.AGENT_EMAIL_DOMAIN ? { emailDomain: process.env.AGENT_EMAIL_DOMAIN } : {}),
  log: (line) => process.stderr.write(`[agent] ${line}\n`),
});
process.stdout.write(JSON.stringify(result) + '\n');
