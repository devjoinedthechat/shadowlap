import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { estimateCost } from '@shadowlap/engine';
import { buildCommand, guardAccept, loadConfig, upstreamOverrides } from '../src/config.js';

/** loadConfig's lists of rules: checked when a command first reads them, and otherwise plain properties. */
let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sl-config-load-'));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const write = (data: unknown) => writeFileSync(join(cwd, 'shadowlap.config.json'), JSON.stringify(data));

describe('loadConfig', () => {
  it('checks each list of rules when it is first read, naming a broken rule', () => {
    write({ normalize: [{ path: '$.a', replace: '<A>' }], redact: [{ pattern: 'emial', replace: 'x' }] });
    const config = loadConfig(cwd);
    expect(config.normalize).toEqual([{ path: '$.a', replace: '<A>' }]);
    expect(() => config.redact).toThrow(/shadowlap\.config\.json: redaction rule #1: unknown pattern "emial"/);
  });

  it('lets a command replace a list, to put rules in front of the project\'s', () => {
    write({ redact: [{ pattern: 'email', replace: '<EMAIL>' }] });
    const config = loadConfig(cwd);
    const org = { kind: 'tool' as const, path: '$.args.iban', replace: '<IBAN>' };
    config.redact = [org, ...config.redact];
    expect(config.redact).toEqual([org, { pattern: 'email', replace: '<EMAIL>' }]);
    config.normalize = [];
    expect(config.normalize).toEqual([]);
    // It copies and serializes as plain data.
    expect(JSON.parse(JSON.stringify(config))).toEqual({ normalize: [], redact: [org, { pattern: 'email', replace: '<EMAIL>' }] });
    expect({ ...config }.redact).toHaveLength(2);

    // Replacing a broken list never reads it.
    write({ redact: [{ pattern: 'emial', replace: 'x' }] });
    const broken = loadConfig(cwd);
    broken.redact = [org];
    expect(broken.redact).toEqual([org]);
  });

  it('takes guard.accept for the Claude Code CLI alone, and SHADOWLAP_GUARD_ACCEPT beside it', () => {
    expect(guardAccept(cwd, {})).toEqual([]);
    write({ guard: { accept: ['claude-code'] } });
    expect(loadConfig(cwd).guard).toEqual({ accept: ['claude-code'] });
    expect(guardAccept(cwd, {})).toEqual(['claude-code']);
    write({});
    expect(guardAccept(cwd, { SHADOWLAP_GUARD_ACCEPT: ' claude-code ,' })).toEqual(['claude-code']);
    // A Node or Python process keeps --guard block: nothing accepts it unwatched.
    write({ guard: { accept: ['claude-code', 'node'] } });
    expect(() => loadConfig(cwd)).toThrow('shadowlap.config.json: guard.accept takes "claude-code" alone, not "node": a Node or Python process whose guard is off still fails --guard block');
    expect(() => guardAccept(cwd, {})).toThrow(/guard\.accept takes "claude-code" alone, not "node"/);
    write({ guard: { allow: ['claude-code'] } });
    expect(() => loadConfig(cwd)).toThrow('shadowlap.config.json: guard has an unknown key "allow" (expected "accept")');
    write({ guard: { accept: 'claude-code' } });
    expect(() => loadConfig(cwd)).toThrow('shadowlap.config.json: guard.accept must be a list, e.g. ["claude-code"]');
    write({});
    expect(() => guardAccept(cwd, { SHADOWLAP_GUARD_ACCEPT: 'python' })).toThrow('SHADOWLAP_GUARD_ACCEPT takes "claude-code" alone, not "python"');
  });

  it('reads a price\'s second card for a long prompt, and refuses one without a whole number of tokens', () => {
    write({ prices: { 'my-model': { input: 1, output: 2, cacheRead: 0.1, above: { tokens: 200000, input: 3, output: 4, cacheWrite: 3.75 } }, 'claude-haiku-5-5': { input: 0.2, output: 1 } } });
    const { prices } = loadConfig(cwd);
    expect(prices).toEqual({ 'my-model': { input: 1, output: 2, cacheRead: 0.1, above: { tokens: 200000, input: 3, output: 4, cacheWrite: 3.75 } }, 'claude-haiku-5-5': { input: 0.2, output: 1 } });
    // Priced as the engine prices any call: by the card its whole prompt picks.
    expect(estimateCost('my-model', { inputTokens: 200001, outputTokens: 1 }, prices)).toBeCloseTo((200001 * 3 + 4) / 1e6, 12);
    expect(estimateCost('claude-haiku-5-5', { inputTokens: 200001, outputTokens: 1 }, prices)).toBeCloseTo((200001 * 0.2 + 1) / 1e6, 12);
    for (const above of [{ input: 3, output: 4 }, { tokens: 0, input: 3, output: 4 }, { tokens: 1.5, input: 3, output: 4 }, { tokens: 100, input: 3 }, 'long']) {
      write({ prices: { 'my-model': { input: 1, output: 2, above } } });
      expect(() => loadConfig(cwd), JSON.stringify(above)).toThrow('shadowlap.config.json: prices["my-model"].above needs a whole number of "tokens" (1 or more) and numeric "input" and "output"');
    }
  });

  it('reads a missing file as no rules', () => {
    expect(loadConfig(cwd)).toEqual({ normalize: [], redact: [] });
  });
});

describe('build', () => {
  it('reads the command that builds the agent, which a command runs where --build is not given, "" running none', () => {
    write({ build: 'npm run build' });
    const config = loadConfig(cwd);
    expect(config.build).toBe('npm run build');
    expect(buildCommand(undefined, () => config)).toEqual({ command: 'npm run build', note: 'build: npm run build, from shadowlap.config.json (--build "" for none)' });
    // A --build given wins, and the config isn't read for it; "" runs none.
    const unread = () => {
      throw new Error('read');
    };
    expect(buildCommand('npm ci && npm run build', unread)).toEqual({ command: 'npm ci && npm run build', note: null });
    expect(buildCommand('', unread)).toEqual({ command: null, note: null });
    expect(buildCommand(undefined, () => loadConfig(join(cwd, 'nowhere')))).toEqual({ command: null, note: null });
  });

  it('refuses a build that is no command on one line, naming the file', () => {
    for (const build of ['', 'npm run build\nnpm test', 7, ['npm', 'run', 'build']]) {
      write({ build });
      expect(() => loadConfig(cwd), JSON.stringify(build)).toThrow('shadowlap.config.json: build must be the command that builds the agent, on one line, such as "npm run build"');
    }
  });
});

describe('upstreamOverrides', () => {
  it('forwards to the base URLs set for the SDKs, each a root the API\'s paths go under', () => {
    // The official SDKs take ANTHROPIC_BASE_URL for the root; the Vercel AI SDK's provider for the root plus /v1.
    expect(upstreamOverrides({ ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic' })).toEqual({ anthropic: 'https://gateway.example/anthropic' });
    expect(upstreamOverrides({ ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic/v1/' })).toEqual({ anthropic: 'https://gateway.example/anthropic' });
    expect(upstreamOverrides({ OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1' })).toEqual({ openai: 'http://127.0.0.1:11434' });
    expect(upstreamOverrides({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000/t/0123456789abcdef0123456789abcdef/r/run/anthropic' })).toEqual({});
    expect(upstreamOverrides({ ANTHROPIC_BASE_URL: 'https://gateway.example/v1', SHADOWLAP_UPSTREAM_ANTHROPIC: 'http://127.0.0.1:9999' })).toEqual({ anthropic: 'http://127.0.0.1:9999' });
  });
});
