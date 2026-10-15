import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REDACTION_EXPORTS, Store, addRule, readConfigFile, removeRule, storeApiRequest, type Effect, type RunMeta } from '@shadowlap/engine';
import { agentsSection, codingAgentsSettings, hideSecrets, hideUrlSecrets, matchingSettings, mcpClientConfig, mcpServers, parseJsonc, projectSettings, redactionSettings, toolsSettings } from '../src/settings.js';

const repoDoc = (name: string) => readFileSync(fileURLToPath(new URL(`../../../docs/${name}`, import.meta.url)), 'utf8');

let cwd: string;
let store: Store;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sl-settings-'));
  store = Store.open(':memory:');
});
afterEach(() => {
  store.close();
  rmSync(cwd, { recursive: true, force: true });
});

const writeConfig = (data: unknown) => writeFileSync(join(cwd, 'shadowlap.config.json'), JSON.stringify(data, null, 2));
const put = (path: string, text: string) => {
  mkdirSync(join(cwd, path, '..'), { recursive: true });
  writeFileSync(join(cwd, path), text);
};

function recording(o: { at: number; status?: 'completed' | 'failed' | 'running'; mode?: 'record' | 'replay'; meta?: RunMeta } = { at: 1 }) {
  const run = store.createRun({ mode: o.mode ?? 'record', command: { argv: ['node', 'agent.js'], cwd }, startedAt: o.at, ...(o.meta ? { meta: o.meta } : {}) });
  if (o.status !== 'running') store.endRun(run.runId, o.status ?? 'completed', o.at + 1);
  return run;
}

function tool(runId: string, callNo: number, name: string, effect: Effect | null, at: number, args: unknown = {}) {
  const id = { kind: 'tool' as const, name, fingerprint: `${name}${callNo}`.padEnd(64, '0'), occurrence: 1 };
  store.appendCallStart({ runId, callNo, ...id, origin: 'live', effect, requestRef: store.putJson({ args }), meta: {}, at });
  store.appendCallEnd(id, { runId, callNo, attempt: 0, responseRef: store.putJson({ result: 'ok' }), outcome: 'ok', meta: {}, at });
}

describe('matchingSettings', () => {
  it('works for a project with no config and no runs', () => {
    const m = matchingSettings({ store, cwd });
    expect(m.config).toMatchObject({ file: 'shadowlap.config.json', exists: false, version: 'absent', error: null });
    expect(m.rules).toEqual([]);
    expect(m.clock).toEqual({ mode: 'auto', explicit: false, error: null });
    expect(m.calibrate).toEqual({ runId: null, source: null, label: 'Record a run first', command: null, argv: null, writeArgv: null });
    expect(m.form).toEqual({ kinds: ['api', 'tool', 'clock', 'random'], patterns: ['iso-datetime', 'iso-date', 'uuid', 'ulid', 'number', 'email'], defaultReplace: '<MASKED>' });
  });

  it('shows every rule the CLI can write, a broken one with its reason, the clock and the run calibrate takes', () => {
    writeConfig({
      clock: 'exact',
      normalize: [
        { kind: 'api', path: '$.metadata.trace_id', pattern: 'ulid', replace: '<ULID>' },
        { pattern: '/req_[a-z0-9]+/', replace: '<REQ>' },
        { kind: 'tool', name: 'create_ticket', path: '$.args.key', replace: '<ID>' },
        { name: 'POST /v1/messages', path: '$.metadata', replace: '<M>' },
        { pattern: 'uuidd', replace: '<U>' },
      ],
    });
    const setup = recording({ at: 1 });
    const newest = recording({ at: 2, status: 'failed' });
    recording({ at: 3, status: 'running' });
    const m = matchingSettings({ store, cwd });
    expect(m.config.version).toBe(readConfigFile(cwd).version);
    expect(m.rules.map((r) => [r.n, r.scope, r.path, r.pattern, r.patternType, r.replace, r.error])).toEqual([
      [1, 'api', '$.metadata.trace_id', 'ulid', 'named', '<ULID>', null],
      [2, 'every call', null, '/req_[a-z0-9]+/', 'regex', '<REQ>', null],
      [3, 'tool · create_ticket', '$.args.key', null, 'whole', '<ID>', null],
      [4, 'POST /v1/messages', '$.metadata', null, 'whole', '<M>', null],
      [5, 'every call', null, 'uuidd', 'named', '<U>', expect.stringContaining('unknown pattern "uuidd"')],
    ]);
    expect(m.rules[4]!.rule).toBeNull();
    expect(m.rules[2]!.remove).toEqual(['normalize', 'rm', '3']);
    expect(m.clock).toEqual({ mode: 'exact', explicit: true, error: null });
    expect(m.calibrate).toEqual({ runId: newest.runId, source: 'newest', label: `Calibrate ${newest.runId.slice(0, 10)}`, command: `shadowlap calibrate ${newest.runId.slice(0, 10)}`, argv: ['calibrate', newest.runId], writeArgv: ['calibrate', newest.runId, '--write'] });
    expect(matchingSettings({ store, cwd, setupRunId: setup.runId }).calibrate).toMatchObject({ runId: setup.runId, source: 'setup' });
  });

  it('reports a config it cannot read instead of failing the page, and a version that edits must match', () => {
    writeFileSync(join(cwd, 'shadowlap.config.json'), '{ "normalize": [');
    const broken = matchingSettings({ store, cwd });
    expect(broken.config).toMatchObject({ exists: true, version: null, error: expect.stringContaining('not valid JSON') });
    expect(broken.rules).toEqual([]);

    writeConfig({ normalize: { path: '$.a' }, clock: 'sometimes' });
    const odd = matchingSettings({ store, cwd });
    expect(odd.config.error).toBe('shadowlap.config.json: normalize must be a list of rules');
    expect(odd.clock).toEqual({ mode: 'auto', explicit: false, error: 'shadowlap.config.json: clock must be "auto" or "exact"' });

    writeConfig({});
    const seen = matchingSettings({ store, cwd }).config.version!;
    addRule(cwd, 'normalize', { path: '$.a', replace: '<A>' }, { expect: seen });
    expect(() => removeRule(cwd, 'normalize', 1, { expect: seen })).toThrow(/changed since it was read/);
    expect(matchingSettings({ store, cwd }).rules).toHaveLength(1);
  });
});

describe('redactionSettings', () => {
  function seeded() {
    const run = recording({ at: 10 });
    const api = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: 'a'.repeat(64), occurrence: 1 };
    store.appendCallStart({ runId: run.runId, callNo: 1, ...api, origin: 'live', effect: null, requestRef: storeApiRequest(store, { model: 'm', system: 'Owner: alice@example.com', messages: [] }), meta: {}, at: 11 });
    store.appendCallEnd(api, { runId: run.runId, callNo: 1, attempt: 0, responseRef: store.putBlob(Buffer.from('{"text":"ok"}')), outcome: 'ok', meta: {}, at: 12 });
    tool(run.runId, 2, 'send_email', 'write', 13, { api_key: 'sk-1', to: 'bob@example.com' });
    return run;
  }

  it('previews the newest finished run, path rules included, and says where the rules apply', () => {
    writeConfig({ redact: [{ pattern: 'email', replace: '<EMAIL>' }, { kind: 'tool', path: '$.args.api_key', pattern: '/.+/', replace: '<KEY>' }] });
    const old = recording({ at: 1 });
    const run = seeded();
    const live = recording({ at: 20, status: 'running' });
    const r = redactionSettings({ store, cwd });
    expect(r.where).toBe(REDACTION_EXPORTS);
    expect(r.form.kinds).toEqual(['api', 'tool']);
    expect(r.runs.map((x) => x.runId)).toEqual([run.runId, old.runId]);
    expect(r.runs[0]!.label).toBe(`${run.runId.slice(0, 10)} · node agent.js`);
    expect(r.previewError).toBeNull();
    expect(r.preview).toMatchObject({ runId: run.runId, total: 3, rules: [{ n: 1, count: 2 }, { n: 2, count: 1, reached: 1 }] });

    expect(redactionSettings({ store, cwd }, { runId: old.runId }).preview).toMatchObject({ total: 0, rules: [{ note: 'no matches in this run' }, { note: 'no tool call in this run' }] });
    expect(redactionSettings({ store, cwd }, { runId: live.runId })).toMatchObject({ preview: null, previewError: expect.stringContaining('is still recording') });
    expect(redactionSettings({ store, cwd }, { runId: 'NOPE' }).previewError).toBe('no run matches NOPE');
  });

  it('explains why there is no preview', () => {
    expect(redactionSettings({ store, cwd })).toMatchObject({ preview: null, previewError: 'Record a run first: the preview needs one to read.', rules: [], runs: [] });
    seeded();
    writeConfig({ redact: [{ pattern: 'email', replace: '<EMAIL>' }, { pattern: 'nope', replace: 'x' }] });
    expect(redactionSettings({ store, cwd }).previewError).toMatch(/^redaction rule #2: unknown pattern "nope"/);
    writeConfig({});
    expect(redactionSettings({ store, cwd }).preview).toMatchObject({ total: 0, rules: [] });
  });
});

describe('codingAgentsSettings', () => {
  it('finds the agent files, whether each mentions Shadowlap, and the section to paste from docs/agents.md', () => {
    put('CLAUDE.md', '# Project\n\nUse shadowlap replay to check a fix.\n');
    put('AGENTS.md', '# Agents\n');
    put('.cursor/rules/general.mdc', 'Be brief.');
    put('.cursor/rules/nested/debug.mdc', 'Record runs with Shadowlap.');
    const s = codingAgentsSettings({ cwd });
    expect(s.files).toEqual([
      { path: 'CLAUDE.md', agents: 'Claude Code', found: true, type: 'file', mentions: true },
      { path: 'AGENTS.md', agents: 'Codex, Cursor and others', found: true, type: 'file', mentions: false },
      { path: '.cursor/rules', agents: 'Cursor', found: true, type: 'folder', mentions: true },
      { path: '.github/copilot-instructions.md', agents: 'GitHub Copilot', found: false, type: null, mentions: false },
    ]);
    // Read from the docs when asked, so the page and the docs can't disagree: the block as docs/agents.md has it.
    expect(s.section).toBeTruthy();
    expect(repoDoc('agents.md')).toContain(`\n${s.section}\n\`\`\``);
    expect(s.section).toMatch(/shadowlap/i);
    expect(s.section).not.toContain('```');
    expect(codingAgentsSettings({ cwd }, { agentsDoc: null }).section).toBeNull();
  });

  it('reads .cursor/rules as one file too', () => {
    put('.cursor/rules', 'nothing about it');
    expect(codingAgentsSettings({ cwd }).files[2]).toMatchObject({ found: true, type: 'file', mentions: false });
  });

  it('takes the fenced block under its heading', () => {
    expect(agentsSection('# Coding agents\n\n```md\nnot this\n```\n\n## Instructions to give it\n\nPaste:\n\n```md\n## Debugging\n\n1. `shadowlap ls`\n```\n')).toBe('## Debugging\n\n1. `shadowlap ls`');
    expect(agentsSection('no block here')).toBeNull();
  });
});

describe('toolsSettings', () => {
  it('lists every tool across runs by what happens after a fork, with the config hosts and MCP effects', () => {
    writeConfig({ http: { '*.pinecone.io': 'read', 'hooks.slack.com': 'write', 'bad.example.com': 'sometimes' }, mcp: { effects: { search_docs: 'read', write_file: 'write' } } });
    const a = recording({ at: 1 });
    const b = recording({ at: 2, mode: 'replay' });
    tool(a.runId, 1, 'lookup_order', 'read', 100);
    tool(a.runId, 2, 'issue_refund', 'read', 110);
    tool(a.runId, 3, 'format_money', 'pure', 120);
    tool(a.runId, 4, 'legacy_tool', null, 130);
    tool(a.runId, 5, 'POST idx-1.svc.pinecone.io/query', 'read', 140);
    tool(a.runId, 6, 'POST idx-2.svc.pinecone.io/query', 'read', 150);
    tool(a.runId, 7, 'GET internal.example.com:8080/items/42', 'read', 160);
    tool(b.runId, 1, 'lookup_order', 'read', 200);
    tool(b.runId, 2, 'issue_refund', 'write', 210);
    tool(b.runId, 3, 'search_docs', 'read', 220);
    const t = toolsSettings({ store, cwd }, { mcpDoc: null });
    expect(t.live.map((x) => [x.name, x.effect, x.calls, x.runs, x.changed, x.mcp])).toEqual([
      ['format_money', 'pure', 1, 1, false, false],
      ['legacy_tool', null, 1, 1, false, false],
      ['lookup_order', 'read', 2, 2, false, false],
      ['search_docs', 'read', 1, 1, false, true],
    ]);
    // Its declaration changed from read to write: the latest call decides the group.
    expect(t.fenced).toEqual([{ name: 'issue_refund', effect: 'write', calls: 2, runs: 2, lastAt: 210, changed: true, mcp: false }]);
    expect(t.http).toEqual([
      { host: '*.pinecone.io', effect: 'read', declared: true, calls: 2, lastAt: 150, error: null },
      { host: 'hooks.slack.com', effect: 'write', declared: true, calls: 0, lastAt: null, error: null },
      { host: 'bad.example.com', effect: null, declared: true, calls: 0, lastAt: null, error: 'bad.example.com must map to pure, read or write' },
      { host: 'internal.example.com:8080', effect: 'read', declared: false, calls: 1, lastAt: 160, error: null },
    ]);
    expect(t.mcp.effects).toEqual([
      { tool: 'search_docs', effect: 'read', seen: true, error: null },
      { tool: 'write_file', effect: 'write', seen: false, error: null },
    ]);
    expect(t.mcp.servers).toEqual([]);
    expect(t.mcp.clientConfig).toBeNull();
  });

  it('takes the client config example from docs/mcp.md', () => {
    const t = toolsSettings({ store, cwd });
    const servers = Object.values((JSON.parse(t.mcp.clientConfig!) as { mcpServers: Record<string, { command: string; args: string[] }> }).mcpServers);
    expect(servers.length).toBeGreaterThan(0);
    for (const server of servers) expect([server.command, server.args[0]]).toEqual(['shadowlap', 'mcp']);
    expect(repoDoc('mcp.md')).toContain(t.mcp.clientConfig!);
    // The first JSON block that lists servers, not an example of something else before it.
    expect(mcpClientConfig('```json\n{ "mcp": { "effects": {} } }\n```\n\n```json\n{ "mcpServers": {} }\n```\n')).toBe('{ "mcpServers": {} }');
    expect(mcpClientConfig('no blocks')).toBeNull();
  });
});

describe('mcpServers', () => {
  it('reads the servers from each client config, stdio or HTTP, and whether they go through shadowlap mcp', () => {
    put('.mcp.json', JSON.stringify({
      mcpServers: {
        filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/srv/notes'] },
        github: { command: 'docker', args: ['run', '-i', '--rm', '-e', 'GITHUB_TOKEN', 'ghcr.io/github/github-mcp-server', '--token', 'ghp_abc123'], env: { GITHUB_TOKEN: 'ghp_never_shown' } },
        notes: { command: 'shadowlap', args: ['mcp', '--effect', 'search=read', '--', 'node', 'notes-server.js'] },
      },
    }));
    put('.vscode/mcp.json', '{\n  // servers for this workspace\n  "servers": {\n    "stripe": { "type": "http", "url": "https://mcp.stripe.com/?key=sk_live_123", "headers": { "Authorization": "Bearer x" } },\n    "linear": { "command": "npx", "args": ["-y", "shadowlap", "mcp", "--url", "https://mcp.linear.app/mcp"], },\n  },\n}\n');
    put('.cursor/mcp.json', '{ not json');
    const { servers, files } = mcpServers(cwd);
    expect(files).toEqual([
      { path: '.mcp.json', found: true, error: null },
      { path: '.cursor/mcp.json', found: true, error: expect.stringContaining('not valid JSON') },
      { path: '.vscode/mcp.json', found: true, error: null },
    ]);
    expect(servers).toEqual([
      {
        name: 'filesystem', file: '.mcp.json', transport: 'stdio', target: 'npx -y @modelcontextprotocol/server-filesystem /srv/notes', viaShadowlap: false,
        line: 'shadowlap mcp -- npx -y @modelcontextprotocol/server-filesystem /srv/notes', entry: { command: 'shadowlap', args: ['mcp', '--', 'npx', '-y', '@modelcontextprotocol/server-filesystem', '/srv/notes'] }, hidden: false,
      },
      {
        name: 'github', file: '.mcp.json', transport: 'stdio', target: 'docker run -i --rm -e GITHUB_TOKEN ghcr.io/github/github-mcp-server --token •••', viaShadowlap: false,
        line: 'shadowlap mcp -- docker run -i --rm -e GITHUB_TOKEN ghcr.io/github/github-mcp-server --token •••', entry: { command: 'shadowlap', args: ['mcp', '--', 'docker', 'run', '-i', '--rm', '-e', 'GITHUB_TOKEN', 'ghcr.io/github/github-mcp-server', '--token', '•••'] }, hidden: true,
      },
      { name: 'notes', file: '.mcp.json', transport: 'stdio', target: 'node notes-server.js', viaShadowlap: true, line: 'shadowlap mcp --effect search=read -- node notes-server.js', entry: { command: 'shadowlap', args: ['mcp', '--effect', 'search=read', '--', 'node', 'notes-server.js'] }, hidden: false },
      { name: 'stripe', file: '.vscode/mcp.json', transport: 'http', target: 'https://mcp.stripe.com/?key=•••', viaShadowlap: false, line: "shadowlap mcp --url 'https://mcp.stripe.com/?key=•••'", entry: { command: 'shadowlap', args: ['mcp', '--url', 'https://mcp.stripe.com/?key=•••'] }, hidden: true },
      { name: 'linear', file: '.vscode/mcp.json', transport: 'http', target: 'https://mcp.linear.app/mcp', viaShadowlap: true, line: 'npx -y shadowlap mcp --url https://mcp.linear.app/mcp', entry: { command: 'npx', args: ['-y', 'shadowlap', 'mcp', '--url', 'https://mcp.linear.app/mcp'] }, hidden: false },
    ]);
    // Nothing from an entry's environment or headers reaches the page.
    expect(JSON.stringify(servers)).not.toMatch(/ghp_|never_shown|Bearer|sk_live/);
  });

  it('hides a credential in a URL wherever it appears: the target, the shadowlap mcp line and the entry', () => {
    put('.mcp.json', JSON.stringify({
      mcpServers: {
        remote: { command: 'shadowlap', args: ['mcp', '--url', 'https://mcp.example.com/mcp?api_key=SECRET1'] },
        bridge: { command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.example.com/sse?token=SECRET2'] },
        db: { command: 'node', args: ['server.js', '--endpoint=https://u:SECRET3@db.example.com/x', 'https://x.example.com/#access_token=SECRET4'] },
      },
    }));
    const { servers } = mcpServers(cwd);
    expect(JSON.stringify(servers)).not.toMatch(/SECRET/);
    expect(servers.map((s) => [s.name, s.hidden])).toEqual([['remote', true], ['bridge', true], ['db', true]]);
    expect(servers[0]).toMatchObject({ target: 'https://mcp.example.com/mcp?api_key=•••', line: "shadowlap mcp --url 'https://mcp.example.com/mcp?api_key=•••'", viaShadowlap: true });
    expect(servers[1]!.entry.args).toEqual(['mcp', '--', 'npx', '-y', 'mcp-remote', 'https://mcp.example.com/sse?token=•••']);
    expect(servers[2]!.target).toBe("node server.js --endpoint=https://db.example.com/x 'https://x.example.com/#•••'");
  });

  it('knows shadowlap mcp behind a package runner, and reads a config file through a link', () => {
    put('shared/mcp.json', JSON.stringify({
      mcpServers: {
        a: { command: 'pnpm', args: ['dlx', 'shadowlap@0.2.0', 'mcp', '--', 'node', 'a.js'] },
        b: { command: 'npm', args: ['exec', '--yes', '--', 'shadowlap', 'mcp', '--url', 'https://b.example.com/mcp'] },
        c: { command: 'bunx', args: ['shadowlap', 'mcp', 'node', 'c.js'] },
        d: { command: 'npx', args: ['-y', 'some-server', 'shadowlap', 'mcp'] },
      },
    }));
    symlinkSync(join(cwd, 'shared', 'mcp.json'), join(cwd, '.mcp.json'));
    const { servers } = mcpServers(cwd);
    expect(servers.map((s) => [s.name, s.viaShadowlap, s.transport, s.target])).toEqual([
      ['a', true, 'stdio', 'node a.js'],
      ['b', true, 'http', 'https://b.example.com/mcp'],
      ['c', true, 'stdio', 'node c.js'],
      ['d', false, 'stdio', 'npx -y some-server shadowlap mcp'],
    ]);
  });

  it('does not read a client config that is too large to be one', () => {
    put('.mcp.json', `{"mcpServers": {}, "pad": "${'x'.repeat(1024 * 1024)}"}`);
    expect(mcpServers(cwd).files[0]).toEqual({ path: '.mcp.json', found: true, error: 'larger than 1 MB, so it was not read' });
  });

  it('finds nothing in a project with no MCP config', () => {
    expect(mcpServers(cwd)).toEqual({ servers: [], files: [{ path: '.mcp.json', found: false, error: null }, { path: '.cursor/mcp.json', found: false, error: null }, { path: '.vscode/mcp.json', found: false, error: null }] });
  });
});

describe('secrets in commands and URLs', () => {
  it('hides a flag value, a --flag=value and a token by its shape', () => {
    expect(hideSecrets(['server', '--api-key', 'abc', '--name', 'x', '--token=t0k', 'sk-ant-123', 'xoxb-1-2', 'plain'])).toEqual(['server', '--api-key', '•••', '--name', 'x', '--token=•••', '•••', '•••', 'plain']);
    expect(hideSecrets(['docker', 'run', '-e', 'GITHUB_TOKEN=abc', '-e', 'LOG_LEVEL=debug', '--header', 'Authorization: Basic eHl6', 'C:\\notes', 'https://x.io/a'])).toEqual(['docker', 'run', '-e', 'GITHUB_TOKEN=•••', '-e', 'LOG_LEVEL=debug', '--header', 'Authorization: •••', 'C:\\notes', 'https://x.io/a']);
    expect(hideUrlSecrets('https://user:pw@mcp.example.com/mcp?token=abc&x=1')).toBe('https://mcp.example.com/mcp?token=•••&x=•••');
    expect(hideUrlSecrets('https://mcp.example.com')).toBe('https://mcp.example.com');
  });

  it('reads VS Code config files: comments and trailing commas, strings left alone', () => {
    expect(parseJsonc('{\n // a comment\n "a": "http://x//y", /* block */ "b": [1, 2,],\n}')).toEqual({ a: 'http://x//y', b: [1, 2] });
    // A comma and a bracket inside a string are text, not a trailing comma.
    expect(parseJsonc('{ "args": ["a, }", "b,]", "c \\" ,}"], }')).toEqual({ args: ['a, }', 'b,]', 'c " ,}'] });
    expect(parseJsonc('[1, /* two */ 2 /* , */ ]')).toEqual([1, 2]);
    expect(() => parseJsonc('{ "a": 1,, }')).toThrow();
  });
});

describe('projectSettings', () => {
  it('names the project and its store, counts runs and attempts, and gives the clean-up commands', () => {
    const dbPath = join(cwd, '.shadowlap', 'shadowlap.db');
    const disk = Store.open(dbPath);
    disk.createRun({ mode: 'record', command: { argv: ['x'], cwd } });
    disk.endRun(disk.allRuns()[0]!.runId, 'completed');
    const probe = disk.createRun({ mode: 'replay', command: { argv: ['x'], cwd }, meta: { probe: { of: 'r', callNo: 2, passed: false } } });
    disk.endRun(probe.runId, 'failed');
    disk.createRun({ mode: 'record', command: { argv: ['x'], cwd } }); // still recording
    const p = projectSettings({ store: disk, cwd, dbPath, address: '127.0.0.1:4777' });
    disk.close();
    expect(p).toMatchObject({ name: cwd.split(/[\\/]/).pop(), folder: cwd, store: { path: dbPath }, runs: 2, attempts: 1, running: 1, address: '127.0.0.1:4777' });
    expect(p.store.bytes).toBeGreaterThan(0);
    expect(p.cleanup).toEqual({ olderThanDays: 30, dryRun: ['gc', '--older-than', '30', '--dry-run'], run: ['gc', '--older-than', '30'] });
    expect(projectSettings({ store, cwd, name: 'support-agent' })).toMatchObject({ name: 'support-agent', store: { path: null, bytes: null }, runs: 0, address: null });
  });
});
