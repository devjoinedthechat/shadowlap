import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { askRepairer, cannotAsk, CLAUDE_CODE_MIN, claudeCodeArgs, managedMcpPath, parseRepairer } from '../src/repairer.js';

/**
 * The only input a repair's Claude Code sees is injectable content: a recorded agent's prompts and
 * tool output. So it is run restricted, with no tool, no MCP server, no hook, no project or user
 * settings and nothing kept on disk. The flags it is started with are checked here against the
 * current Claude Code CLI reference (https://code.claude.com/docs/en/cli-reference): the ones that
 * turn each of those off, a model name that can't become a flag or a command, the oldest Claude Code
 * that has a restricted mode, and what an organization's managed-mcp.json does to a run with no MCP
 * server. The versions here are made up for the test.
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
    // Restricted: only managed settings and --settings (none), so no hook, permission rule or plugin
    // from user, project or local settings runs; and its session isn't kept on disk.
    expect(args).toContain('--restricted');
    expect(args).toContain('--no-session-persistence');
    expect(args).not.toContain('--setting-sources');
    expect(args).not.toContain('--settings');
    // The answer, and where the system prompt comes from.
    expect(flag('--system-prompt-file')).toBe('/tmp/system.md');
    expect(flag('--json-schema')).toContain('"candidates"');
    // No flag that would let it act: no permission bypass, no MCP permission-prompt tool, no hooks.
    expect(args.join(' ')).not.toMatch(/dangerously|bypassPermissions|permission-prompt-tool|--mcp-config|--hooks|--add-dir|--plugin-dir/);
    // The model, when one is asked for, as its own flag.
    expect(claudeCodeArgs('/tmp/s.md', 'claude-opus-5-5').slice(-2)).toEqual(['--model', 'claude-opus-5-5']);
  });

  it('is refused before a repair spends anything on a Claude Code too old to run restricted, or under a managed MCP config', async () => {
    const nothing = join(tmpdir(), `sl-no-managed-mcp-${process.pid}.json`);
    const claude = parseRepairer('claude-code');
    const says = (said: string) => () => Promise.resolve(said);
    expect(CLAUDE_CODE_MIN).toBe('2.1.248');
    expect((await cannotAsk(claude, { managedMcp: nothing, version: says('2.1.247 (Claude Code)') }))?.what).toBe("Claude Code 2.1.247 can't run a repair restricted");
    expect((await cannotAsk(claude, { managedMcp: nothing, version: says('2.0.999 (Claude Code)') }))?.message).toMatch(/needs Claude Code 2\.1\.248 or later: claude update$/);
    for (const ok of ['2.1.248 (Claude Code)', '2.2.0 (Claude Code)', '3.0.1\n']) expect(await cannotAsk(claude, { managedMcp: nothing, version: says(ok) }), ok).toBeNull();
    // One that doesn't say its version is left for the run: a Claude Code with no restricted mode
    // rejects --restricted with an unknown-option error, and is never run unrestricted.
    for (const said of ['hello\n', '2.1\n', null]) expect(await cannotAsk(claude, { managedMcp: nothing, version: () => Promise.resolve(said) }), String(said)).toBeNull();
    // An organization's managed-mcp.json: Claude Code exits at startup with --strict-mcp-config, so a repair says so first.
    const dir = mkdtempSync(join(tmpdir(), 'sl-managed-mcp-'));
    try {
      const managed = join(dir, 'managed-mcp.json');
      writeFileSync(managed, '{"mcpServers":{}}');
      const refused = await cannotAsk(claude, { managedMcp: managed, version: says('2.4.0 (Claude Code)') });
      expect(refused?.what).toBe(`Claude Code won't start a repair while your organization's ${managed} is deployed`);
      expect(refused?.message).toMatch(/exits at startup when asked to load none of them \(--strict-mcp-config\)/);
      // One it can't parse, which Claude Code doesn't apply either, stops nothing.
      writeFileSync(managed, '{"mcpServers":');
      expect(await cannotAsk(claude, { managedMcp: managed, version: says('2.4.0 (Claude Code)') })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(managedMcpPath('darwin')).toBe('/Library/Application Support/ClaudeCode/managed-mcp.json');
    expect(managedMcpPath('linux')).toBe('/etc/claude-code/managed-mcp.json');
    expect(managedMcpPath('win32')).toBe('C:\\Program Files\\ClaudeCode\\managed-mcp.json');
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
if (process.argv[2] === '--version') {
  process.stdout.write(process.env.STAND_IN_VERSION ?? '2.1.248 (Claude Code)\\n');
  process.exit(process.env.STAND_IN_VERSION_EXIT ? Number(process.env.STAND_IN_VERSION_EXIT) : 0);
}
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
    expect(seen.argv).toEqual(expect.arrayContaining(['--tools', '--disallowed-tools', 'mcp__*', '--strict-mcp-config', '--restricted', '--no-session-persistence', '--model', 'claude-opus-5-5']));
    expect(seen.stdinHasPrompt).toBe(true);
    expect(seen.cwdEmpty).toBe(true);
  }, 30_000);

  it('asks claude --version as a repair starts it, refuses one too old, and leaves one that says nothing to the run', async () => {
    const claudeCode = parseRepairer('claude-code');
    const nothing = join(dir, 'no-managed-mcp.json');
    expect(await cannotAsk(claudeCode, { managedMcp: nothing })).toBeNull();
    for (const [version, exit, what] of [
      ['2.1.247 (Claude Code)\n', '0', "Claude Code 2.1.247 can't run a repair restricted"],
      ['', '0', null],
      ['2.1.100 (Claude Code)\n', '1', null],
    ] as const) {
      process.env.STAND_IN_VERSION = version;
      process.env.STAND_IN_VERSION_EXIT = exit;
      try {
        expect((await cannotAsk(claudeCode, { managedMcp: nothing }))?.what ?? null, `${version} ${exit}`).toBe(what);
      } finally {
        delete process.env.STAND_IN_VERSION;
        delete process.env.STAND_IN_VERSION_EXIT;
      }
    }
    // Not there at all: asking it says so, once blame has run, as before.
    process.env.SHADOWLAP_CLAUDE = join(dir, 'not-here');
    expect(await cannotAsk(claudeCode, { managedMcp: nothing })).toBeNull();
    // Stopped by the repair's signal, it says nothing: the repair stops.
    process.env.SHADOWLAP_CLAUDE = claude;
    process.env.STAND_IN_VERSION = '2.1.247 (Claude Code)\n';
    const stop = new AbortController();
    stop.abort();
    try {
      expect(await cannotAsk(claudeCode, { managedMcp: nothing, signal: stop.signal })).toBeNull();
    } finally {
      delete process.env.STAND_IN_VERSION;
    }
  }, 30_000);

  it('names an older Claude Code that rejects --restricted as plainly, when it says no version first', async () => {
    // As Claude Code's errors reference says of one from before v2.1.248: it rejects the flag itself.
    writeFileSync(claude, `#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on('end', () => { process.stderr.write("error: unknown option '--restricted'\\n"); process.exit(1); });\n`);
    chmodSync(claude, 0o755);
    const refused = askRepairer({ provider: 'claude-code', model: '' }, { system: 's', user: 'u' }, undefined, { timeoutMs: 20_000 });
    await expect(refused).rejects.toThrow('this Claude Code has no restricted mode: a repair runs it with --restricted, which needs Claude Code 2.1.248 or later: claude update');
  }, 30_000);

  it('says plainly when an organization’s managed MCP config stops Claude Code at startup', async () => {
    // As Claude Code's managed-mcp documentation words it for servers a session is given.
    writeFileSync(claude, `#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on('end', () => { process.stderr.write('You cannot dynamically configure MCP servers when an enterprise MCP config is present\\n'); process.exit(1); });\n`);
    chmodSync(claude, 0o755);
    await expect(askRepairer({ provider: 'claude-code', model: '' }, { system: 's', user: 'u' }, undefined, { timeoutMs: 20_000 })).rejects.toThrow(/won't start a repair while your organization's managed-mcp\.json is deployed/);
  }, 30_000);
});
