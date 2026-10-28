import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { estimateCost } from '@shadowlap/engine';
import { repairerMost } from '../src/repair.js';
import { askRepairer, CLAUDE_CODE_TURNS, claudeCodeArgs, REPAIRER_ANSWER_TOKENS } from '../src/repairer.js';

/**
 * A repair asks the repairer only when what is left of its budget covers the most asking it could
 * cost, which is its prompt and the longest answer it may give. That holds only if every repairer is
 * held to that answer, and every turn it may take is counted: Anthropic's request, an OpenAI-
 * compatible one, and the user's Claude Code, which may take two turns.
 */
const prompt = { system: 'You improve AI agents.', user: 'Rewrite the span.' };
const servers: Server[] = [];
const dirs: string[] = [];
const claudeWas = process.env.SHADOWLAP_CLAUDE;
const capWas = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (claudeWas === undefined) delete process.env.SHADOWLAP_CLAUDE;
  else process.env.SHADOWLAP_CLAUDE = claudeWas;
  if (capWas === undefined) delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
  else process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = capWas;
});

const ANSWER = { diagnosis: 'the prompt did not say what to do above the limit', candidates: [{ anchor: 1, replace: 'Escalate above the limit.', strategy: 'Escalate above the limit', why: 'it makes the rule clear' }] };

describe("the repairer's answer, held to the bound the budget counts on", () => {
  it('asks an OpenAI-compatible server for an answer of at most the bound', async () => {
    let body: Record<string, unknown> | null = null;
    const server = createServer((req, res) => {
      let text = '';
      req.on('data', (d: Buffer) => (text += d.toString()));
      req.on('end', () => {
        body = JSON.parse(text) as Record<string, unknown>;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: 'local-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(ANSWER) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    await askRepairer({ provider: 'openai', model: 'local-model', baseUrl: url }, prompt, undefined, { timeoutMs: 20_000 });
    expect(body).toMatchObject({ model: 'local-model', max_completion_tokens: REPAIRER_ANSWER_TOKENS });
  });

  it("runs Claude Code with the bound as its output limit, or a lower one already set, and the turns counted", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-repairer-spend-'));
    dirs.push(dir);
    const claude = join(dir, 'claude');
    const seen = join(dir, 'seen.json');
    // A stand-in for the user's Claude Code: it records the output limit it was given, then answers.
    writeFileSync(
      claude,
      `#!/usr/bin/env node
const fs = require('node:fs');
process.stdin.resume();
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ cap: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? null, argv: process.argv.slice(2) }));
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, structured_output: ${JSON.stringify(ANSWER)}, modelUsage: { 'claude-opus-5-5': {} }, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.002 }));
});
`,
    );
    chmodSync(claude, 0o755);
    process.env.SHADOWLAP_CLAUDE = claude;
    const read = () => JSON.parse(readFileSync(seen, 'utf8')) as { cap: string | null; argv: string[] };

    // Unset, or set higher: the bound.
    delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
    await askRepairer({ provider: 'claude-code', model: '' }, prompt, undefined, { timeoutMs: 20_000 });
    expect(read().cap).toBe(String(REPAIRER_ANSWER_TOKENS));
    process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '64000';
    await askRepairer({ provider: 'claude-code', model: '' }, prompt, undefined, { timeoutMs: 20_000 });
    expect(read().cap).toBe(String(REPAIRER_ANSWER_TOKENS));
    // Lower: kept.
    process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '8000';
    await askRepairer({ provider: 'claude-code', model: '' }, prompt, undefined, { timeoutMs: 20_000 });
    expect(read().cap).toBe('8000');
    // The turns it is started with are the ones counted.
    const argv = read().argv;
    expect(argv[argv.indexOf('--max-turns') + 1]).toBe(String(CLAUDE_CODE_TURNS));
    expect(claudeCodeArgs('/tmp/s.md', null)).toEqual(expect.arrayContaining(['--max-turns', String(CLAUDE_CODE_TURNS)]));
  }, 60_000);

  it("counts each of Claude Code's turns in the most asking it could cost, and one answer for the others", () => {
    const prices = { 'claude-opus-5-5': { input: 5, output: 25 } };
    const promptTokens = Math.ceil((prompt.system.length + prompt.user.length) / 3);
    expect(repairerMost({ provider: 'anthropic', model: 'claude-opus-5-5' }, prompt, prices)).toBe(estimateCost('claude-opus-5-5', { inputTokens: promptTokens, outputTokens: REPAIRER_ANSWER_TOKENS }, prices));
    // Two turns: the prompt twice, the first answer read again by the second, and two answers.
    expect(repairerMost({ provider: 'claude-code', model: '' }, prompt, prices)).toBe(estimateCost('claude-opus-5-5', { inputTokens: 2 * promptTokens + REPAIRER_ANSWER_TOKENS, outputTokens: 2 * REPAIRER_ANSWER_TOKENS }, prices));
    expect(repairerMost({ provider: 'claude-code', model: '' }, prompt, prices)!).toBeGreaterThan(2 * repairerMost({ provider: 'anthropic', model: 'claude-opus-5-5' }, prompt, prices)!);
  });
});
