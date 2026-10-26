import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { askRepairer, claudeCodeArgs, parseRepairer } from '../src/repairer.js';

/**
 * The only input a repair's Claude Code sees is injectable content: a recorded agent's prompts and
 * tool output. So it is run with no tool, no MCP server, no hook and no project or user settings. The
 * flags it is started with are checked here against the current Claude Code CLI
 * (https://code.claude.com/docs): the ones that turn each of those off, and a model name that can't
 * become a flag or a command.
 */

describe('the flags Claude Code is run with for a repair', () => {
  it('turns off every tool, MCP server, hook and project or user setting, and holds the answer to the schema', () => {
    const args = claudeCodeArgs('/tmp/system.md', null);
    // Print mode, with the answer held to a JSON schema and the system prompt replaced from a file.
    expect(args.slice(0, 3)).toEqual(['-p', '--output-format', 'json']);
    const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
    // No built-in tool, and no MCP tool.
    expect(flag('--tools')).toBe('');
    expect(flag('--disallowed-tools')).toBe('mcp__*');
    // No MCP server: ignore every MCP config, and none is given.
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('--mcp-config');
    // No user, project or local settings: no hook, permission rule or plugin one of them carries runs.
    expect(args.indexOf('--setting-sources') >= 0 && args[args.indexOf('--setting-sources') + 1]).toBe('');
    // The answer, and where the system prompt comes from.
    expect(flag('--system-prompt-file')).toBe('/tmp/system.md');
    expect(flag('--json-schema')).toContain('"candidates"');
    // No flag that would let it act: no permission bypass, no MCP permission-prompt tool, no hooks.
    expect(args.join(' ')).not.toMatch(/dangerously|bypassPermissions|permission-prompt-tool|--mcp-config|--hooks|--add-dir|--plugin-dir/);
    // The model, when one is asked for, as its own flag.
    expect(claudeCodeArgs('/tmp/s.md', 'claude-opus-5-5').slice(-2)).toEqual(['--model', 'claude-opus-5-5']);
  });

  it('holds a repairer’s model to a model name, so it can’t slip a flag or a command into claude --model', () => {
    expect(parseRepairer('claude-code').model).toBe('');
    expect(parseRepairer('claude-code:claude-opus-5-5').model).toBe('claude-opus-5-5');
    expect(parseRepairer('anthropic:us.anthropic.claude-opus-4-5:0').model).toBe('us.anthropic.claude-opus-4-5:0');
    expect(parseRepairer('openai:openai/gpt-4o').model).toBe('openai/gpt-4o');
    for (const bad of ['claude-code:--dangerously-skip-permissions', 'claude-code:-x', 'claude-code:a b', 'claude-code:a";calc', 'claude-code:a$(id)', 'openai:a|b', 'claude-code:a\nb']) {
      // Rejected before it can reach claude --model: by the model-name check, or the provider:model shape.
      expect(() => parseRepairer(bad), bad).toThrow(/model name|repairer is provider:model/);
    }
  });
});

describe('asking the user’s own Claude Code, end to end', () => {
  let dir: string;
  let claude: string;
  let argvOut: string;
  const claudeWas = process.env.SHADOWLAP_CLAUDE;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sl-repairer-cc-'));
    claude = join(dir, 'claude');
    argvOut = join(dir, 'argv.json');
    // A stand-in for the user's Claude Code: it records the argv it was started with and whether it
    // was given a prompt on stdin, then answers with a Claude Code JSON report, as the real one does.
    writeFileSync(
      claude,
      `#!/usr/bin/env node
const fs = require('node:fs');
let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(argvOut)}, JSON.stringify({ argv: process.argv.slice(2), stdinHasPrompt: stdin.includes('Rewrite the span'), cwdEmpty: fs.readdirSync(process.cwd()).length === 0 }));
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, structured_output: { diagnosis: 'the prompt did not say what to do above the limit', candidates: [{ anchor: 1, replace: 'Escalate above the limit.', strategy: 'Escalate above the limit', why: 'it makes the rule clear' }] }, modelUsage: { 'claude-opus-5-5': {} }, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.002 }));
  process.exit(0);
});
`,
    );
    chmodSync(claude, 0o755);
    process.env.SHADOWLAP_CLAUDE = claude;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (claudeWas === undefined) delete process.env.SHADOWLAP_CLAUDE;
    else process.env.SHADOWLAP_CLAUDE = claudeWas;
  });

  it('starts it with the hardening flags, the prompt on stdin, in an empty directory, and reads its answer', async () => {
    const prompt = { system: 'You improve AI agents.', user: 'Rewrite the span.' };
    const answer = await askRepairer({ provider: 'claude-code', model: 'claude-opus-5-5' }, prompt, undefined, { timeoutMs: 20_000 });
    expect(answer.edits).toEqual([{ anchor: 1, replace: 'Escalate above the limit.', strategy: 'Escalate above the limit', why: 'it makes the rule clear' }]);
    expect(answer.served).toBe('claude-opus-5-5');
    expect(answer.cost).toBe(0.002);
    const seen = JSON.parse(readFileSync(argvOut, 'utf8')) as { argv: string[]; stdinHasPrompt: boolean; cwdEmpty: boolean };
    // The same hardening flags reach the process, not only claudeCodeArgs.
    expect(seen.argv).toEqual(expect.arrayContaining(['--tools', '--disallowed-tools', 'mcp__*', '--strict-mcp-config', '--setting-sources', '--model', 'claude-opus-5-5']));
    expect(seen.stdinHasPrompt).toBe(true);
    expect(seen.cwdEmpty).toBe(true);
  }, 30_000);
});
