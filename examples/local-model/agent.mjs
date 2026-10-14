// An on-call triage agent: it reads last night's alert logs, decides which ones are real incidents,
// and opens a ticket for each. The OpenAI Agents SDK runs the loop; the model is a local one served
// by Ollama, so nothing here needs an API key.
//
//   node agent.mjs                                  talks to Ollama directly
//   shadowlap run -- node agent.mjs                 records the run (see README.md)
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, OpenAIChatCompletionsModel, run, setTracingDisabled, tool } from '@openai/agents';
import { withEffect } from '@shadowlap/adapters/openai-agents';
import OpenAI from 'openai';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
const ALERTS = join(here, 'alerts');
const TICKETS = join(here, 'tickets');

// Under `shadowlap run`, OPENAI_BASE_URL points at the recording sidecar, which forwards to Ollama.
const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL ?? 'http://127.0.0.1:11434/v1',
  apiKey: process.env.OPENAI_API_KEY ?? 'ollama',
});
const model = new OpenAIChatCompletionsModel(client, process.env.MODEL ?? 'qwen2.5:7b');
// The SDK would otherwise upload traces to OpenAI.
setTracingDisabled(true);

// Effects tell Shadowlap what a tool does: `read` tools can run again after a fork, `write` tools
// are blocked, so exploring a different prompt never opens real tickets twice.
const listAlerts = tool(
  withEffect(
    {
      name: 'list_alert_logs',
      description: 'List the alert log files from last night.',
      parameters: z.object({}),
      execute: async () => readdirSync(ALERTS).filter((f) => f.endsWith('.log')).sort().join('\n'),
    },
    'read',
  ),
);

const readAlerts = tool(
  withEffect(
    {
      name: 'read_alert_log',
      description: 'Read one alert log file.',
      parameters: z.object({ file: z.string().describe('A file name from list_alert_logs') }),
      execute: async ({ file }) => {
        if (!/^[\w.-]+\.log$/.test(file)) return `No such log: ${file}`;
        try {
          return readFileSync(join(ALERTS, file), 'utf8');
        } catch {
          return `No such log: ${file}`;
        }
      },
    },
    'read',
  ),
);

const openTicket = tool(
  withEffect(
    {
      name: 'open_ticket',
      description: 'Open an incident ticket for the on-call team.',
      parameters: z.object({
        title: z.string(),
        severity: z.enum(['sev1', 'sev2', 'sev3']),
        service: z.string(),
        summary: z.string().describe('What happened, the evidence, and the next step'),
      }),
      execute: async (ticket) => {
        mkdirSync(TICKETS, { recursive: true });
        const id = `INC-${1000 + readdirSync(TICKETS).length + 1}`;
        writeFileSync(join(TICKETS, `${id}.json`), JSON.stringify({ id, ...ticket }, null, 2) + '\n');
        return `Opened ${id}`;
      },
    },
    // Under `shadowlap replay --writes stub`, the model gets this instead and no file is written.
    { effect: 'write', onFork: (ticket) => `Opened INC-DRYRUN (${ticket.severity}, not filed: a Shadowlap replay)` },
  ),
);

const triage = new Agent({
  name: 'On-call triage',
  model,
  instructions: [
    'You are the on-call engineer reviewing alert logs from last night.',
    'List the logs, read every one, and decide which describe real incidents that need follow-up.',
    'Open exactly one ticket per real incident. Routine noise that recovered on its own gets no ticket.',
    'When you are done, reply with a short summary: one line per log and what you did about it.',
  ].join('\n'),
  tools: [listAlerts, readAlerts, openTicket],
  modelSettings: { temperature: 0.2 },
});

const result = await run(triage, 'Triage last night\'s alerts.', { stream: true, maxTurns: 20 });
for await (const event of result) {
  if (event.type === 'raw_model_stream_event' && event.data.type === 'output_text_delta') {
    process.stdout.write(event.data.delta);
  } else if (event.type === 'run_item_stream_event' && event.name === 'tool_called') {
    const call = event.item.rawItem;
    process.stdout.write(`→ ${call.name} ${call.arguments && call.arguments !== '{}' ? call.arguments : ''}\n`);
  } else if (event.type === 'run_item_stream_event' && event.name === 'tool_output') {
    const output = String(event.item.output ?? '');
    process.stdout.write(`  ${output.split('\n')[0].slice(0, 100)}${output.includes('\n') ? ' …' : ''}\n`);
  }
}
await result.completed;
process.stdout.write('\n');
