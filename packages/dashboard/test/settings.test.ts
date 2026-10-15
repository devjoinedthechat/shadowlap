import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REDACTION_EXPORTS, Store, addRule, addRules, readConfigFile, recordEvent, removeRule, storeApiRequest, type CallMeta, type Effect, type RunMeta } from '@shadowlap/engine';
import { agentsSection, cleanupArgv, codingAgentsSettings, githubRepo, hideSecrets, hideUrlSecrets, matchingSettings, mcpClientConfig, mcpServerFor, mcpServers, parseJsonc, projectSettings, proposedRules, redactionSettings, shownPath, splitCommandLine, stdioServerName, toolsSettings } from '../src/settings.js';

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
    expect(m.calibrate).toEqual({ runId: null, source: null, label: 'Record a run first', command: null, argv: null });
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
    // Removing names the version the row was read from, so a stale page can't remove the wrong rule.
    expect(m.rules[2]!.remove).toEqual(['normalize', 'rm', '3', '--expect', m.config.version]);
    expect(m.clock).toEqual({ mode: 'exact', explicit: true, error: null });
    expect(m.calibrate).toEqual({ runId: newest.runId, source: 'newest', label: `Calibrate ${newest.runId.slice(0, 10)}`, command: `shadowlap calibrate ${newest.runId.slice(0, 10)}`, argv: ['calibrate', newest.runId] });
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

  it('adds what a calibrate job proposed, exactly those, without replaying again', () => {
    const run = recording({ at: 1 });
    writeConfig({ normalize: [{ kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' }] });
    const tab = matchingSettings({ store, cwd });
    // The job's result event, as `calibrate --json` prints it: each normalizer says why it was proposed.
    const result = {
      runId: run.runId,
      normalizers: [
        { kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>', why: 'a new id on every run' },
        { kind: 'tool', name: 'save_report', path: '$.args.path', pattern: '/\\/tmp\\/agent-[A-Za-z0-9_]+/', replace: '<VAR>', why: 'a temporary path' },
      ],
    };
    expect(proposedRules(result)).toEqual(result.normalizers.map(({ why: _why, ...rule }) => rule));
    expect(proposedRules({ normalizers: 'no' })).toEqual([]);
    const added = addRules(cwd, 'normalize', proposedRules(result), { expect: tab.config.version! });
    expect(added.rules.map((r) => [r.n, r.added])).toEqual([[1, false], [2, true]]);
    for (const event of added.events) recordEvent(store, { ...event, runId: result.runId, data: { ...event.data, via: 'calibrate' }, actor: 'dana' });
    expect(store.listEvents().map((e) => [e.kind, e.runId, e.ref, e.data?.via])).toEqual([['normalizer.added', run.runId, '$.args.path', 'calibrate']]);
    expect(matchingSettings({ store, cwd }).rules.map((r) => r.scope)).toEqual(['api', 'tool · save_report']);
    // A page that read the config before this edit can't add on top of what it didn't see.
    expect(() => addRules(cwd, 'normalize', [{ path: '$.x', replace: '<X>' }], { expect: tab.config.version! })).toThrow(/changed since it was read/);
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

  it('lists the runs a preview can be made for, each with its job, and says where the rules apply', () => {
    writeConfig({ redact: [{ pattern: 'email', replace: '<EMAIL>' }, { kind: 'tool', path: '$.args.api_key', pattern: '/.+/', replace: '<KEY>' }] });
    const old = recording({ at: 1 });
    const run = seeded();
    const live = recording({ at: 20, status: 'running' });
    const r = redactionSettings({ store, cwd });
    expect(r.where).toBe(REDACTION_EXPORTS);
    // Decision 6: html, pack and HAR apply every rule; html masks the command line and notes too, which pack keeps.
    expect(r.where.find((e) => e.id === 'har')).toMatchObject({ applies: 'all' });
    expect(r.where.find((e) => e.id === 'html')).toMatchObject({ applies: 'all', details: 'masked' });
    expect(r.where.find((e) => e.id === 'pack')).toMatchObject({ applies: 'all', details: 'kept' });
    expect(r.where.map((e) => e.id)).toContain('pairs');
    expect(r.form.kinds).toEqual(['api', 'tool']);
    expect(r.runs.map((x) => x.runId)).toEqual([run.runId, old.runId]);
    expect(r.runs[0]).toEqual({ runId: run.runId, label: `${run.runId.slice(0, 10)} · node agent.js`, preview: ['redact', 'preview', run.runId, '--json'] });
    expect(r).toMatchObject({ previewRunId: run.runId, previewError: null });
    expect(r.rules.map((x) => x.remove)).toEqual([1, 2].map((n) => ['redact', 'rm', String(n), '--expect', r.config.version]));

    expect(redactionSettings({ store, cwd }, { runId: old.runId.slice(0, 12) })).toMatchObject({ previewRunId: old.runId, previewError: null });
    expect(redactionSettings({ store, cwd }, { runId: live.runId })).toMatchObject({ previewRunId: null, previewError: `${live.runId.slice(0, 10)} is still recording; preview it once it has ended` });
    expect(redactionSettings({ store, cwd }, { runId: 'NOPE' })).toMatchObject({ previewRunId: null, previewError: 'no run matches NOPE' });
  });

  it('reads no run\'s calls, however long the run: the preview is a job', () => {
    seeded();
    const guarded = new Proxy(store, {
      get(target, key) {
        if (key === 'getCalls' || key === 'getBlob' || key === 'getJson') throw new Error(`the Redaction tab read ${String(key)}`);
        const value = Reflect.get(target, key) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    expect(redactionSettings({ store: guarded, cwd }).previewRunId).not.toBeNull();
  });

  it('explains why there is no preview to run', () => {
    expect(redactionSettings({ store, cwd })).toMatchObject({ previewRunId: null, previewError: 'Record a run first: the preview needs one to read.', rules: [], runs: [] });
    seeded();
    writeConfig({ redact: [{ pattern: 'email', replace: '<EMAIL>' }, { pattern: 'nope', replace: 'x' }] });
    expect(redactionSettings({ store, cwd }).previewError).toMatch(/^redaction rule #2: unknown pattern "nope"/);
    writeConfig({});
    expect(redactionSettings({ store, cwd })).toMatchObject({ previewError: null, rules: [] });
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

  it('does not look through a rules folder that links outside the project, and stops early in a huge one', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'sl-elsewhere-'));
    try {
      writeFileSync(join(elsewhere, 'notes.mdc'), 'Record runs with Shadowlap.');
      mkdirSync(join(cwd, '.cursor'), { recursive: true });
      symlinkSync(elsewhere, join(cwd, '.cursor', 'rules'));
      expect(codingAgentsSettings({ cwd }).files[2]).toEqual({ path: '.cursor/rules', agents: 'Cursor', found: true, type: 'folder', mentions: false });
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
    rmSync(join(cwd, '.cursor', 'rules'));
    // Deeper than any rules folder goes: not looked at. A folder of hundreds of folders is looked through only in part.
    put('.cursor/rules/a/b/c/d/e/f/mention.mdc', 'shadowlap');
    expect(codingAgentsSettings({ cwd }).files[2]).toMatchObject({ found: true, type: 'folder', mentions: false });
    for (let i = 0; i < 300; i++) put(`.cursor/rules/many/d${String(i).padStart(3, '0')}/x.mdc`, 'nothing here');
    const started = Date.now();
    expect(codingAgentsSettings({ cwd }).files[2]).toMatchObject({ found: true, type: 'folder', mentions: false });
    expect(Date.now() - started).toBeLessThan(2000);
    // A link inside the project is followed.
    rmSync(join(cwd, '.cursor', 'rules'), { recursive: true });
    put('shared-rules/a.mdc', 'Use shadowlap replay.');
    symlinkSync(join(cwd, 'shared-rules'), join(cwd, '.cursor', 'rules'));
    expect(codingAgentsSettings({ cwd }).files[2]).toMatchObject({ found: true, type: 'folder', mentions: true });
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
        recordedAs: { transport: 'stdio', server: 'npx @modelcontextprotocol/server-filesystem' },
      },
      {
        name: 'github', file: '.mcp.json', transport: 'stdio', target: 'docker run -i --rm -e GITHUB_TOKEN ghcr.io/github/github-mcp-server --token •••', viaShadowlap: false,
        line: 'shadowlap mcp -- docker run -i --rm -e GITHUB_TOKEN ghcr.io/github/github-mcp-server --token •••', entry: { command: 'shadowlap', args: ['mcp', '--', 'docker', 'run', '-i', '--rm', '-e', 'GITHUB_TOKEN', 'ghcr.io/github/github-mcp-server', '--token', '•••'] }, hidden: true,
        recordedAs: { transport: 'stdio', server: 'docker' },
      },
      { name: 'notes', file: '.mcp.json', transport: 'stdio', target: 'node notes-server.js', viaShadowlap: true, line: 'shadowlap mcp --effect search=read -- node notes-server.js', entry: { command: 'shadowlap', args: ['mcp', '--effect', 'search=read', '--', 'node', 'notes-server.js'] }, hidden: false, recordedAs: { transport: 'stdio', server: 'node' } },
      { name: 'stripe', file: '.vscode/mcp.json', transport: 'http', target: 'https://mcp.stripe.com/?key=•••', viaShadowlap: false, line: "shadowlap mcp --url 'https://mcp.stripe.com/?key=•••'", entry: { command: 'shadowlap', args: ['mcp', '--url', 'https://mcp.stripe.com/?key=•••'] }, hidden: true, recordedAs: { transport: 'http', server: 'mcp.stripe.com' } },
      { name: 'linear', file: '.vscode/mcp.json', transport: 'http', target: 'https://mcp.linear.app/mcp', viaShadowlap: true, line: 'npx -y shadowlap mcp --url https://mcp.linear.app/mcp', entry: { command: 'npx', args: ['-y', 'shadowlap', 'mcp', '--url', 'https://mcp.linear.app/mcp'] }, hidden: false, recordedAs: { transport: 'http', server: 'mcp.linear.app' } },
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

  it('hides every credential the reviewer found, in the target, the line and the entry', () => {
    put('.mcp.json', JSON.stringify({
      mcpServers: {
        zapier: { url: 'https://actions.zapier.com/mcp/sk-ak-SECRET1/sse' },
        zapier2: { command: 'shadowlap', args: ['mcp', '--url=https://mcp.zapier.com/api/mcp/s/SECRET2abcdef0123456789/mcp'] },
        envflag: { command: 'docker', args: ['run', '--env=GITHUB_TOKEN=ghp_SECRET3', 'img'] },
        via: { command: 'shadowlap', args: ['mcp', '--', 'docker', 'run', '--env=GITHUB_TOKEN=SECRET4', 'img'] },
        header: { command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.example.com/sse', '--header=Authorization: Bearer SECRET5'] },
        db: { command: 'node', args: ['server.js', '--connection-string', 'Server=x;Password=SECRET6;'] },
      },
    }));
    const { servers } = mcpServers(cwd);
    expect(JSON.stringify(servers)).not.toMatch(/SECRET/);
    expect(servers.every((s) => s.hidden)).toBe(true);
    expect(servers.find((s) => s.name === 'via')).toMatchObject({ viaShadowlap: true, target: 'docker run --env=GITHUB_TOKEN=••• img' });
  });

  it('does not read a client config that is too large to be one', () => {
    put('.mcp.json', `{"mcpServers": {}, "pad": "${'x'.repeat(1024 * 1024)}"}`);
    expect(mcpServers(cwd).files[0]).toEqual({ path: '.mcp.json', found: true, error: 'larger than 1 MB, so it was not read' });
  });

  it('counts the tools and writes of each server the recordings came through, matched to the client configs', () => {
    put('.mcp.json', JSON.stringify({
      mcpServers: {
        filesystem: { command: 'shadowlap', args: ['mcp', '--', 'npx', '-y', '@modelcontextprotocol/server-filesystem', '/srv/notes'] },
        issues: { command: 'shadowlap', args: ['mcp', '--url', 'https://mcp.example.com/mcp/k3y7abc9', '--header', 'Authorization: Bearer x'] },
        search: { command: 'node', args: ['search-server.js'] },
      },
    }));
    const run = recording({ at: 1 });
    const via = (callNo: number, name: string, effect: Effect, mcp: NonNullable<CallMeta['mcp']>) =>
      store.appendCallStart({ runId: run.runId, callNo, kind: 'tool', name, fingerprint: `${name}${callNo}`.padEnd(64, '0'), occurrence: 1, origin: 'live', effect, requestRef: null, meta: { mcp }, at: 100 + callNo });
    const fs = { transport: 'stdio' as const, server: 'npx @modelcontextprotocol/server-filesystem' };
    via(1, 'read_file', 'read', { ...fs, tools: [{ name: 'read_file', effect: 'read' }, { name: 'write_file', effect: 'write' }, { name: 'move_file', effect: 'write' }] });
    via(2, 'write_file', 'write', fs);
    via(3, 'create_issue', 'write', { transport: 'http', server: 'mcp.example.com' });
    via(4, 'list_issues', 'read', { transport: 'http', server: 'mcp.example.com' });
    // A server the project's configs don't list: the user's own client config elsewhere.
    via(5, 'query', 'read', { transport: 'stdio', server: 'uvx mcp-server-sqlite' });
    const t = toolsSettings({ store, cwd }, { mcpDoc: null });
    expect(t.mcp.servers.map((r) => [r.name, r.recorded && { tools: r.recorded.tools, writes: r.recorded.writes, listed: r.recorded.listed, calls: r.recorded.calls }])).toEqual([
      ['filesystem', { tools: 3, writes: 2, listed: true, calls: 2 }],
      // No call listed its tools: the tools called through it.
      ['issues', { tools: 2, writes: 1, listed: false, calls: 2 }],
      ['search', null],
    ]);
    expect(t.mcp.recorded.map((r) => [r.server, r.inConfig])).toEqual([
      ['mcp.example.com', true],
      ['npx @modelcontextprotocol/server-filesystem', true],
      ['uvx mcp-server-sqlite', false],
    ]);
    // The name matches what the CLI records: the command and the package a runner starts, never the rest.
    expect(stdioServerName('C:\\tools\\npx.cmd', ['--yes', '@acme/mcp-server@1.2.0', '--token', 'x'])).toBe('npx @acme/mcp-server@1.2.0');
    expect(stdioServerName('npx', ['-y', '/srv/server.js'])).toBe('npx');
    expect(stdioServerName('/usr/bin/python3', ['server.py'])).toBe('python3');
  });

  it('finds nothing in a project with no MCP config', () => {
    expect(mcpServers(cwd)).toEqual({ servers: [], files: [{ path: '.mcp.json', found: false, error: null }, { path: '.cursor/mcp.json', found: false, error: null }, { path: '.vscode/mcp.json', found: false, error: null }] });
  });
});

describe('mcpServerFor', () => {
  it('gives the shadowlap mcp line and entry for a command or URL typed into Add a server', () => {
    expect(mcpServerFor({ command: 'npx -y @modelcontextprotocol/server-filesystem "/srv/my notes"' })).toEqual({
      transport: 'stdio', target: "npx -y @modelcontextprotocol/server-filesystem '/srv/my notes'", viaShadowlap: false,
      line: "shadowlap mcp -- npx -y @modelcontextprotocol/server-filesystem '/srv/my notes'", entry: { command: 'shadowlap', args: ['mcp', '--', 'npx', '-y', '@modelcontextprotocol/server-filesystem', '/srv/my notes'] }, hidden: false,
      recordedAs: { transport: 'stdio', server: 'npx @modelcontextprotocol/server-filesystem' },
    });
    expect(mcpServerFor({ url: ' https://mcp.linear.app/mcp ' })).toMatchObject({ transport: 'http', line: 'shadowlap mcp --url https://mcp.linear.app/mcp', entry: { command: 'shadowlap', args: ['mcp', '--url', 'https://mcp.linear.app/mcp'] }, hidden: false });
    expect(mcpServerFor({ url: 'https://mcp.example.com/mcp?key=sk_live_1' })).toMatchObject({ target: 'https://mcp.example.com/mcp?key=•••', hidden: true });
    expect(mcpServerFor({ command: 'docker run -e GITHUB_TOKEN=ghp_x img' })).toMatchObject({ target: 'docker run -e GITHUB_TOKEN=••• img', hidden: true });
    // Already behind shadowlap mcp: said so, not wrapped twice.
    expect(mcpServerFor({ command: 'shadowlap mcp -- node notes.js' })).toMatchObject({ viaShadowlap: true, target: 'node notes.js', line: 'shadowlap mcp -- node notes.js' });
    expect(() => mcpServerFor({ command: '   ' })).toThrow(/type the command that starts the server/);
    expect(() => mcpServerFor({ url: 'mcp.example.com' })).toThrow(/starts with http:\/\/ or https:\/\//);
    expect(() => mcpServerFor({ command: 'node "server.js' })).toThrow(/a quote is not closed/);
  });

  it('splits a command line as a shell does', () => {
    expect(splitCommandLine(`node 'a b' "c \\"d\\" $e" f\\ g  ''`)).toEqual(['node', 'a b', 'c "d" $e', 'f g', '']);
    expect(splitCommandLine('')).toEqual([]);
  });
});

describe('secrets in commands and URLs', () => {
  it('hides a flag value, a --flag=value and a token by its shape', () => {
    expect(hideSecrets(['server', '--api-key', 'abc', '--name', 'x', '--token=t0k', 'sk-ant-123', 'xoxb-1-2', 'plain'])).toEqual(['server', '--api-key', '•••', '--name', 'x', '--token=•••', '•••', '•••', 'plain']);
    expect(hideSecrets(['docker', 'run', '-e', 'GITHUB_TOKEN=abc', '-e', 'LOG_LEVEL=debug', '--header', 'Authorization: Basic eHl6', 'C:\\notes', 'https://x.io/a'])).toEqual(['docker', 'run', '-e', 'GITHUB_TOKEN=•••', '-e', 'LOG_LEVEL=debug', '--header', 'Authorization: •••', 'C:\\notes', 'https://x.io/a']);
    expect(hideUrlSecrets('https://user:pw@mcp.example.com/mcp?token=abc&x=1')).toBe('https://mcp.example.com/mcp?token=•••&x=•••');
    expect(hideUrlSecrets('https://mcp.example.com')).toBe('https://mcp.example.com');
  });

  it('hides a credential inside a --flag=value, a connection string, a short flag name, and a URL path', () => {
    const cases: Array<[string[], string[]]> = [
      [['docker', 'run', '--env=GITHUB_TOKEN=ghp_SECRET', 'img'], ['docker', 'run', '--env=GITHUB_TOKEN=•••', 'img']],
      [['--header=Authorization: Bearer abc'], ['--header=Authorization: •••']],
      [['--connection-string', 'Server=x;Password=SECRETPW;Database=app'], ['--connection-string', 'Server=x;Password=•••;Database=app']],
      [['--pat', 'SECRETPAT', '--path', '/srv/notes', '--author', 'dana'], ['--pat', '•••', '--path', '/srv/notes', '--author', 'dana']],
      [['--api-key', '-starts-with-a-dash'], ['--api-key', '•••']],
      [['--dsn', 'mysql://root:SECRETPW@db/app'], ['--dsn', '•••']],
      [['DefaultEndpointsProtocol=https;AccountName=x;AccountKey=SECRETKEY'], ['DefaultEndpointsProtocol=https;AccountName=x;AccountKey=•••']],
      [['https://actions.zapier.com/mcp/sk-ak-SECRETPATH/sse'], ['https://actions.zapier.com/mcp/•••/sse']],
      [['https://mcp.zapier.com/api/mcp/s/NmE5ZDEzNjctYTFhZC00ODk0LWI3ZjMtZDE2MjZjZTY0YjA0/mcp'], ['https://mcp.zapier.com/api/mcp/s/•••/mcp']],
      [['https://mcp.zapier.com/api/mcp/s/SECRETPATH/mcp'], ['https://mcp.zapier.com/api/mcp/s/•••/mcp']],
      [['https://mcp.composio.dev/partner/composio/github/mcp', 'https://mcp.example.com/v1/sse', '--keyboard', 'us'], ['https://mcp.composio.dev/partner/composio/github/mcp', 'https://mcp.example.com/v1/sse', '--keyboard', 'us']],
      // A key after a one-letter flag, which says nothing of what follows it; a port, a path and a name with a version stay.
      [['node', 'server.js', '-k', 'xyzzy-plain-key-42', '-p', '8080', '-f', './config-v2.json', '-n', 'server-v2'], ['node', 'server.js', '-k', '•••', '-p', '8080', '-f', './config-v2.json', '-n', 'server-v2']],
      // A short run of letters and digits in a URL path, as a key in a hosted server's URL.
      [['https://mcp.example.com/u/a1b2c3d4/mcp', 'https://mcp.example.com/api-v2/mcp'], ['https://mcp.example.com/u/•••/mcp', 'https://mcp.example.com/api-v2/mcp']],
    ];
    for (const [argv, shown] of cases) expect(hideSecrets(argv), argv.join(' ')).toEqual(shown);
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
  it('names the project and its store, counts runs and attempts, and gives the clean-up job', () => {
    const dbPath = join(cwd, '.shadowlap', 'shadowlap.db');
    const disk = Store.open(dbPath);
    const rec = disk.createRun({ mode: 'record', command: { argv: ['x'], cwd } });
    disk.endRun(rec.runId, 'completed');
    // A blame probe of that recording: an attempt, bundled under it as the Runs page bundles it.
    const probe = disk.createRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['x'], cwd }, meta: { probe: { of: rec.runId, callNo: 2, passed: false } } });
    disk.endRun(probe.runId, 'failed');
    disk.createRun({ mode: 'record', command: { argv: ['x'], cwd } }); // still recording
    const p = projectSettings({ store: disk, cwd, dbPath, address: '127.0.0.1:4777' });
    expect(p).toMatchObject({ name: cwd.split(/[\\/]/).pop(), folder: cwd, store: { path: dbPath }, runs: 2, attempts: 1, running: 1, abandoned: 0, address: '127.0.0.1:4777' });
    // The database's own count of its pages, not the files on disk, which a write-ahead log makes jump.
    expect(p.store.bytes).toBe(disk.size().bytes);
    expect(p.store.bytes).toBeGreaterThan(0);
    disk.close();
    expect(p.cleanup).toEqual({ olderThanDays: 30, dryRun: ['gc', '--older-than', '30', '--dry-run'] });
    expect(projectSettings({ store, cwd, name: 'support-agent' })).toMatchObject({ name: 'support-agent', store: { path: null }, runs: 0, address: null });
  });

  it('deletes exactly what the dry run listed: its cutoff, and the runs the dialog promised', () => {
    const dryRun = { dryRun: true, olderThanDays: 30, keep: null, cutoff: 1_757_000_000_000, total: 9, count: 2, runs: [{ runId: 'A' }, { runId: 'B' }], expect: '2-0123456789abcdef', blobs: 3, bytes: 1000 };
    expect(cleanupArgv(dryRun)).toEqual(['gc', '--before', '1757000000000', '--expect', '2-0123456789abcdef']);
    expect(cleanupArgv({ cutoff: null, keep: 200, expect: '0-e3b0c44298fc1c14' })).toEqual(['gc', '--keep', '200', '--expect', '0-e3b0c44298fc1c14']);
    expect(() => cleanupArgv({ cutoff: null, keep: null, expect: '0-e3b0c44298fc1c14' })).toThrow(/picked no runs/);
    expect(() => cleanupArgv({ cutoff: 1, keep: null, expect: '2' })).toThrow(/no "expect"/);
  });

  it('tells a recording from a run its process left running', () => {
    const dbPath = join(cwd, 'store.db');
    const disk = Store.open(dbPath);
    disk.createRun({ mode: 'record', command: { argv: ['x'], cwd } });
    // A run imported while it was still recording somewhere, a day and more ago: nobody records it here.
    disk.importRun({ runId: '01ABANDONED000000000000000', parentRunId: null, mode: 'record', status: 'running', divergence: null, command: { argv: ['x'], cwd }, codeVersion: null, startedAt: Date.now() - 2 * 86_400_000, endedAt: null });
    expect(projectSettings({ store: disk, cwd, dbPath })).toMatchObject({ running: 1, abandoned: 1 });
    disk.close();
  });
});

describe('what the CI and Project tabs fill in', () => {
  it("reads a GitHub repository from origin's address, in any of its forms", () => {
    expect(githubRepo('git@github.com:devjoinedthechat/shadowlap.git')).toBe('devjoinedthechat/shadowlap');
    expect(githubRepo('https://github.com/acme/support-agent')).toBe('acme/support-agent');
    expect(githubRepo('https://github.com/acme/support.agent.git/')).toBe('acme/support.agent');
    expect(githubRepo('ssh://git@github.com/acme/x.git')).toBe('acme/x');
    expect(githubRepo('https://gitlab.com/acme/x.git')).toBeNull();
    expect(githubRepo(null)).toBeNull();
  });

  it('shows paths inside the home folder from ~', () => {
    expect(shownPath(join(cwd, 'agent', '.shadowlap', 'shadowlap.db'), cwd)).toBe('~/agent/.shadowlap/shadowlap.db');
    expect(shownPath(cwd, cwd)).toBe('~');
    expect(shownPath('/elsewhere/x.db', cwd)).toBe('/elsewhere/x.db');
  });
});
