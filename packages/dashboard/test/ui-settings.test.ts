import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { validateRule } from '@shadowlap/engine';
import { CI_DEFAULTS, ciWorkflows } from '../src/ci-workflows.js';
import { splitCommandLine } from '../src/settings.js';
import { ONLY_PROJECT, provideProjectRemoval, useProjectRemoval, type ProjectRemoval } from '../ui/project-actions.js';
import { settingsTabLabel } from '../ui/pages/settings/tabs.js';
import { settingsApi } from '../ui/settings-api.js';
import {
  MCP_FORMS,
  SETTINGS_TABS,
  bytesText,
  ciShown,
  copiedLineText,
  emptyRuleForm,
  gcDeleteCommand,
  gcDryRun,
  gcGivesBack,
  maskedLine,
  mcpEntryText,
  mcpRows,
  mcpShortName,
  orList,
  partialLine,
  pasteWhere,
  previewChip,
  proposedCount,
  regexLiteral,
  ruleCommand,
  runListKey,
  ruleInput,
  ruleProblem,
  serverNameFor,
  settingsTab,
  shellWords,
  suggestedReplace,
  syncText,
  typedSecret,
  type RuleFormState,
} from '../ui/pages/settings/logic.js';

/** The Settings page's logic, without a browser: tabs, the Add dialog's rule and command, the preview's names, the drawer's offers. */

const PATTERNS = ['iso-datetime', 'iso-date', 'uuid', 'ulid', 'number', 'email'];
const form = (patch: Partial<RuleFormState>, list: 'normalize' | 'redact' = 'normalize'): RuleFormState => ({ ...emptyRuleForm(list, PATTERNS), ...patch });

/** The rule a `shadowlap normalize|redact add …` command line adds, read back from its flags as the CLI reads them. */
function ruleFromCommand(command: string): Record<string, string> {
  const argv = splitCommandLine(command);
  expect(argv.slice(0, 3)).toEqual(['shadowlap', argv[1], 'add']);
  const out: Record<string, string> = {};
  for (let i = 3; i < argv.length; i += 2) out[argv[i]!.replace(/^--/, '')] = argv[i + 1]!;
  return out;
}

describe('when a tab reads again', () => {
  it('follows the runs there are and which still record, not the calls a recording adds', () => {
    const runs = [
      { runId: 'B', status: 'running' },
      { runId: 'A', status: 'completed' },
    ];
    const key = runListKey(runs, 'support-agent');
    // The same runs, reloaded while B records: nothing to read again.
    expect(runListKey(runs.map((r) => ({ ...r })), 'support-agent')).toBe(key);
    expect(runListKey([{ runId: 'B', status: 'completed' }, runs[1]!], 'support-agent')).not.toBe(key);
    expect(runListKey([{ runId: 'C', status: 'completed' }, ...runs], 'support-agent')).not.toBe(key);
    expect(runListKey(runs.slice(0, 1), 'support-agent')).not.toBe(key);
    expect(runListKey(runs, 'triage-bot')).not.toBe(key);
    expect(runListKey(null, 'support-agent')).not.toBe(key);
  });
});

describe('the Settings tabs', () => {
  it('opens Matching without a tab, keeps CI at its old address, and knows no other tab', () => {
    expect(SETTINGS_TABS.map((t) => t.label)).toEqual(['Matching', 'Redaction', 'CI', 'Coding agents', 'Tools', 'Project', 'Store']);
    expect(settingsTab(null)).toBe('matching');
    expect(settingsTab('alerts')).toBe('alerts');
    expect(settingsTab('ci')).toBe('alerts');
    expect(settingsTab('store')).toBe('store');
    expect(settingsTab('plan')).toBeNull();
    expect(settingsTab('members')).toBeNull();
    // The breadcrumb names the tab shown, whatever the address said.
    expect(['alerts', 'ci', null, 'tools', 'plan'].map(settingsTabLabel)).toEqual(['CI', 'CI', 'Matching', 'Tools', 'Matching']);
  });
});

describe('the Add dialog', () => {
  it('starts as the mock does: a UUID for a normalizer, an email for a redaction rule', () => {
    expect(emptyRuleForm('normalize', PATTERNS)).toMatchObject({ kind: '', mode: 'named', named: 'uuid', replace: '<UUID>' });
    expect(emptyRuleForm('redact', PATTERNS)).toMatchObject({ named: 'email', replace: '<EMAIL>' });
    expect(suggestedReplace('normalize', 'named', 'iso-date')).toBe('<DATE>');
    expect(suggestedReplace('normalize', 'regex', 'uuid')).toBe('<MASKED>');
    expect(suggestedReplace('redact', 'whole', 'uuid')).toBe('<REDACTED>');
  });

  it('sends only what was given, as the CLI leaves out a flag', () => {
    expect(ruleInput(form({ kind: 'api', path: ' $.metadata.user_id ' }))).toEqual({ kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' });
    // A name scopes a rule only with a kind; the whole value has no pattern; an empty replacement is the default's to fill.
    expect(ruleInput(form({ name: 'send_email', path: '$.args.to', mode: 'whole', replace: '' }))).toEqual({ path: '$.args.to' });
    expect(ruleInput(form({ kind: 'tool', name: 'create_ticket', path: '$.args.idempotency_key', mode: 'whole', replace: '<ID>' }))).toEqual({ kind: 'tool', name: 'create_ticket', path: '$.args.idempotency_key', replace: '<ID>' });
    expect(ruleInput(form({ mode: 'regex', regex: 'req_[a-z0-9]+', replace: '<REQ>' }))).toEqual({ pattern: '/req_[a-z0-9]+/', replace: '<REQ>' });
  });

  it('writes a regex as /…/flags', () => {
    expect(regexLiteral('req_\\d+')).toBe('/req_\\d+/');
    expect(regexLiteral(' /req_\\d+/i ')).toBe('/req_\\d+/i');
    expect(regexLiteral('a/b')).toBe('/a/b/');
    expect(regexLiteral('/')).toBe('///');
    expect(regexLiteral('  ')).toBe('');
  });

  it('says what is missing before asking the server', () => {
    expect(ruleProblem(form({}))).toBeNull();
    expect(ruleProblem(form({ mode: 'regex' }))).toMatch(/regex/);
    expect(ruleProblem(form({ mode: 'whole' }))).toMatch(/path/);
    expect(ruleProblem(form({ path: 'metadata.user_id' }))).toMatch(/starts with \$/);
  });

  it('shows the command that adds the very same rule, quoted for a shell', () => {
    const cases: Array<['normalize' | 'redact', RuleFormState]> = [
      ['normalize', form({ kind: 'api', path: '$.metadata.user_id' })],
      ['normalize', form({ kind: 'tool', name: "o'brien tool", path: '$.args.path', mode: 'whole', replace: '<PATH>' })],
      ['redact', form({ mode: 'regex', regex: '(?<=key=)\\w+', replace: '<KEY>' }, 'redact')],
      ['redact', form({ path: "$.messages[0]['content']", replace: '<$$>' }, 'redact')],
    ];
    for (const [list, f] of cases) {
      const command = ruleCommand(list, f);
      expect(command.startsWith(`shadowlap ${list} add`)).toBe(true);
      expect(validateRule(list, ruleFromCommand(command))).toEqual(validateRule(list, ruleInput(f)));
    }
    expect(ruleCommand('normalize', form({ kind: 'api', path: '$.metadata.user_id' }))).toBe("shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'");
  });
});

describe('a command line on the page', () => {
  it('wraps between the words a shell splits, never inside a quoted value or a flag', () => {
    expect(shellWords("shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'")).toEqual(['shadowlap', 'normalize', 'add', '--kind', 'api', '--path', "'$.metadata.user_id'", '--pattern', 'uuid', '--replace', "'<UUID>'"]);
    expect(shellWords("shadowlap mcp --url 'https://mcp.stripe.com/?key=•••' --header 'Authorization: •••'")).toEqual(['shadowlap', 'mcp', '--url', "'https://mcp.stripe.com/?key=•••'", '--header', "'Authorization: •••'"]);
    expect(shellWords(`shadowlap redact add --name "o'brien  tool"  x`)).toEqual(['shadowlap', 'redact', 'add', '--name', `"o'brien  tool"`, 'x']);
    expect(shellWords('shadowlap gc --before 1757000000000 --expect 3-0123456789abcdef')).toEqual(['shadowlap', 'gc', '--before', '1757000000000', '--expect', '3-0123456789abcdef']);
    // A quote escaped between two quoted parts stays in its word; joined again, the words are the command.
    const line = "shadowlap normalize add --kind tool --name 'o'\\''brien tool' --path '$.args.path'";
    expect(shellWords(line)).toEqual(['shadowlap', 'normalize', 'add', '--kind', 'tool', '--name', "'o'\\''brien tool'", '--path', "'$.args.path'"]);
    expect(shellWords(line).join(' ')).toBe(line);
  });
});

describe('the preview', () => {
  it('names a rule by its path, else what a regex puts in place, else its pattern', () => {
    expect(previewChip({ path: '$.args.api_key', pattern: '/.+/', replace: '<KEY>' })).toBe('$.args.api_key');
    expect(previewChip({ pattern: '/\\b(?:\\d[ -]?){13,16}\\b/', replace: '<CARD>' })).toBe('<CARD>');
    expect(previewChip({ pattern: 'email', replace: '<EMAIL>' })).toBe('email');
    expect(maskedLine(1)).toBe('1 value would be masked');
    expect(maskedLine(1200)).toBe('1,200 values would be masked');
  });

  it('says how far a long run was read, and which limit stopped it', () => {
    expect(partialLine({ read: 2000, of: 5312, stopped: 'calls' })).toBe('Read the first 2,000 of 5,312 calls.');
    expect(partialLine({ read: 812, of: 2000, stopped: 'bytes' })).toBe('Read the first 812 of 2,000 calls, as much as a preview reads.');
    expect(partialLine({ read: 40, of: 2000, stopped: 'time' })).toBe('Read the first 40 of 2,000 calls in the time a preview takes.');
  });
});

describe('sizes, times and lists', () => {
  it('writes sizes as the Project tab shows them', () => {
    expect(bytesText(512)).toBe('512 B');
    expect(bytesText(392 * 1024)).toBe('392 kB');
    expect(bytesText(18.4 * 1024 * 1024)).toBe('18.4 MB');
    expect(bytesText(3 * 1024 ** 3)).toBe('3.0 GB');
  });

  it('writes the last sync as a time today, a day before, or never', () => {
    const now = new Date(2026, 9, 1, 15, 0).getTime();
    expect(syncText(null, now)).toBe('never');
    expect(syncText(new Date(2026, 9, 1, 10, 14).getTime(), now)).toBe('10:14');
    expect(syncText(new Date(2026, 8, 30, 9, 0).getTime(), now)).toBe('Sep 30');
    expect(syncText(new Date(2025, 8, 30, 9, 0).getTime(), now)).toBe('Sep 30, 2025');
  });

  it('joins with "or"', () => {
    expect(orList([])).toBe('');
    expect(orList(['CLAUDE.md'])).toBe('CLAUDE.md');
    expect(orList(['CLAUDE.md', 'AGENTS.md'])).toBe('CLAUDE.md or AGENTS.md');
    expect(orList(['a', 'b', 'c'])).toBe('a, b or c');
  });
});

describe('what the drawer offers', () => {
  it('offers to add what a finished calibration proposed and did not write', () => {
    const normalizers = [{ path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>', why: 'a UUID' }];
    expect(proposedCount({ done: true, result: { normalizers, written: false } })).toBe(1);
    expect(proposedCount({ done: false, result: { normalizers, written: false } })).toBe(0);
    expect(proposedCount({ done: true, result: { normalizers, written: true } })).toBe(0);
    expect(proposedCount({ done: true, result: { normalizers: [], written: false } })).toBe(0);
    expect(proposedCount({ done: true, result: null })).toBe(0);
  });

  it('offers to delete what a finished dry run found, by the command the server builds', () => {
    const report = { dryRun: true, count: 3, cutoff: 1_757_000_000_000, keep: null, olderThanDays: 30, bytes: 2048, expect: '3-0123456789abcdef' };
    const dry = gcDryRun({ done: true, code: 0, result: report });
    expect(dry).toMatchObject({ count: 3, olderThanDays: 30 });
    expect(gcDeleteCommand(dry!)).toBe('shadowlap gc --before 1757000000000 --expect 3-0123456789abcdef');
    expect(gcDeleteCommand({ ...dry!, cutoff: null, keep: 200 })).toBe('shadowlap gc --keep 200 --expect 3-0123456789abcdef');
    // No run old enough: what deleted runs left (blobs nothing uses, unused space past 1 MB) by a plain gc, unless a run records.
    const none = { ...report, count: 0, expect: '0-e3b0c44298fc1c14' };
    expect(gcDryRun({ done: true, code: 0, result: none })).toMatchObject({ count: 0, bytes: 2048, free: 0 });
    expect(gcDeleteCommand(gcDryRun({ done: true, code: 0, result: none })!)).toBe('shadowlap gc');
    const unused = gcDryRun({ done: true, code: 0, result: { ...none, bytes: 0, store: { free: 50 * 1024 * 1024 } } });
    expect(unused).toMatchObject({ free: 50 * 1024 * 1024 });
    expect(gcGivesBack(unused!)).toBe(50 * 1024 * 1024);
    expect(gcDryRun({ done: true, code: 0, result: { ...none, bytes: 0, store: { free: 4096 } } })).toBeNull();
    expect(gcDryRun({ done: true, code: 0, result: { ...none, recordingCount: 1 } })).toBeNull();
    expect(gcDryRun({ done: true, code: 0, result: { ...report, dryRun: false } })).toBeNull();
    expect(gcDryRun({ done: true, code: 1, result: report })).toBeNull();
    expect(gcDryRun({ done: false, code: null, result: report })).toBeNull();
  });
});

describe('MCP servers', () => {
  it('lists the configured servers, then those recorded that no config here lists, each with what records it', () => {
    const rows = mcpRows({
      servers: [
        { name: 'filesystem', file: '.mcp.json', transport: 'stdio', target: 'npx -y @modelcontextprotocol/server-filesystem /srv/notes', viaShadowlap: false, line: 'shadowlap mcp -- npx -y @modelcontextprotocol/server-filesystem /srv/notes', putBack: ['FS_ROOT'], recorded: null },
        { name: 'stripe', file: '.mcp.json', transport: 'http', target: 'https://mcp.stripe.com', viaShadowlap: true, line: 'shadowlap mcp --url https://mcp.stripe.com', putBack: [], recorded: { tools: 18, writes: 6 } },
      ],
      recorded: [
        { transport: 'http', server: 'mcp.stripe.com', tools: 18, writes: 6, inConfig: true },
        { transport: 'stdio', server: 'npx @modelcontextprotocol/server-github@1.2.0', tools: 9, writes: 3, inConfig: false },
      ],
    });
    expect(rows.map((r) => [r.name, r.tools, r.writes, r.line !== null, r.note, r.putBack])).toEqual([
      ['filesystem', null, 0, true, 'not recorded · .mcp.json starts it directly', ['FS_ROOT']],
      ['stripe', 18, 6, false, null, []],
      ['server-github', 9, 3, false, 'recorded · in no config in this project', []],
    ]);
    expect(mcpShortName('http', 'mcp.linear.app')).toBe('mcp.linear.app');
    expect(mcpShortName('stdio', 'uvx mcp-server-git')).toBe('mcp-server-git');
  });

  it('names a server from what was typed, and says where its entry goes', () => {
    expect(serverNameFor('http', 'https://mcp.linear.app/mcp')).toBe('linear');
    expect(serverNameFor('http', 'https://mcp.stripe.com')).toBe('stripe');
    expect(serverNameFor('http', 'https://api.githubcopilot.com/mcp/')).toBe('githubcopilot');
    expect(serverNameFor('http', 'not a url')).toBe('server');
    expect(serverNameFor('stdio', 'npx -y @modelcontextprotocol/server-github')).toBe('github');
    expect(serverNameFor('stdio', 'uvx mcp-server-fetch')).toBe('fetch');
    expect(serverNameFor('stdio', '/usr/local/bin/github-mcp --stdio')).toBe('github');
    expect(serverNameFor('stdio', 'node ./build/index.js')).toBe('server');
    expect(serverNameFor('stdio', '')).toBe('server');
    expect(pasteWhere([{ path: '.mcp.json', found: false }, { path: '.vscode/mcp.json', found: true }])).toBe('under servers in .vscode/mcp.json');
    expect(pasteWhere([{ path: '.mcp.json', found: true }, { path: '.vscode/mcp.json', found: true }])).toBe('under mcpServers in .mcp.json');
    expect(pasteWhere([])).toBe('under mcpServers in your client’s config (servers in VS Code’s)');
    // The form a project's servers don't use, as the line that records one.
    expect(splitCommandLine(MCP_FORMS.http.line)).toEqual(['shadowlap', 'mcp', '--url', 'https://mcp.example.com/mcp', '--header', 'Authorization: Bearer ${TOKEN}']);
    expect(splitCommandLine(MCP_FORMS.stdio.line).slice(0, 3)).toEqual(['shadowlap', 'mcp', '--']);
  });

  it('says what a copied line needs, and nothing about the entry’s own environment', () => {
    expect(copiedLineText({ name: 'github', file: '.mcp.json', line: 'shadowlap mcp -- npx -y @modelcontextprotocol/server-github' })).toBe('Copied the line for github · put it in front of the server in .mcp.json');
    expect(copiedLineText({ name: 'db', file: '.mcp.json', line: "shadowlap mcp -- npx -y server-postgres 'postgresql://•••@db/prod'" })).toBe('Copied the line for db · put it in front of the server in .mcp.json, then put back the ••• in it');
    expect(copiedLineText({ name: 'stripe', file: '.cursor/mcp.json', line: "shadowlap mcp --url https://mcp.stripe.com --header 'Authorization: Bearer ${STRIPE_TOKEN}'" })).toBe('Copied the line for stripe · put it in front of the server in .cursor/mcp.json, then set STRIPE_TOKEN in its env');
  });

  it('writes a client entry to paste under mcpServers', () => {
    expect(mcpEntryText('linear', { command: 'shadowlap', args: ['mcp', '--url', 'https://mcp.linear.app/mcp'] })).toBe('"linear": {\n  "command": "shadowlap",\n  "args": ["mcp", "--url", "https://mcp.linear.app/mcp"]\n}');
    expect(JSON.parse(`{${mcpEntryText('a "b"', { command: 'shadowlap', args: ['mcp', '--', 'x'] })}}`)).toEqual({ 'a "b"': { command: 'shadowlap', args: ['mcp', '--', 'x'] } });
    // With the variable a URL's user and password became.
    expect(JSON.parse(`{${mcpEntryText('linear', { command: 'shadowlap', args: ['mcp', '--url', 'https://mcp.linear.app/mcp', '--header', 'Authorization: Basic ${LINEAR_AUTH}'] }, [{ name: 'LINEAR_AUTH', value: '…' }])}}`)).toEqual({ linear: { command: 'shadowlap', args: ['mcp', '--url', 'https://mcp.linear.app/mcp', '--header', 'Authorization: Basic ${LINEAR_AUTH}'], env: { LINEAR_AUTH: '…' } } });
  });
});

describe('the CI tab', () => {
  it('shows what was changed on it, else what the server answered with', () => {
    const view = ciWorkflows(CI_DEFAULTS, { preview: null, failing: 0, at: null, repository: null, branch: null, defaultBranch: 'master' });
    expect(ciShown({}, view)).toEqual(CI_DEFAULTS);
    expect(ciShown({ fix: true, secret: 'ALERTS_HOOK' }, view)).toEqual({ ...CI_DEFAULTS, fix: true, secret: 'ALERTS_HOOK' });
    // The branch "only for the main branch" means is the repository's default, in the switch's words and the YAML.
    expect(view.alerts.branch).toBe('master');
    expect(view.alerts.yaml).toContain("github.ref == 'refs/heads/master'");
    expect(view.alerts.message.text).toBe('Shadowlap: 1 golden(s) failed on master.');
    expect(view.fixOnFailure.preview).toMatchObject({ example: true, base: 'master' });
  });

  it('keeps only what a secret name can hold, as it is typed', () => {
    expect(typedSecret('ALERTS-hook 1')).toBe('ALERTShook1');
    expect(typedSecret('')).toBe('');
  });
});

describe('Remove from dashboard', () => {
  /** What the Project tab reads: the current project the projects feature provides, and why it can't be removed. */
  function shown(): string {
    function Probe() {
      const removal = useProjectRemoval();
      const current = removal?.current() ?? null;
      return createElement('span', null, current ? `${current.id}:${current.blocked ?? 'removable'}` : ONLY_PROJECT);
    }
    return renderToStaticMarkup(createElement(Probe));
  }
  const Dialog = () => null;

  it('opens the dialog the projects feature provides, and only while it provides one', () => {
    expect(shown()).toContain('The only project can’t be removed');
    const one: ProjectRemoval = { current: () => ({ id: 'p1', blocked: ONLY_PROJECT }), Dialog };
    const two: ProjectRemoval = { current: () => ({ id: 'p2', blocked: null }), Dialog };
    const undoOne = provideProjectRemoval(one);
    expect(shown()).toContain('p1:The only project');
    const undoTwo = provideProjectRemoval(two);
    // Taking back what it no longer provides leaves the newer one.
    undoOne();
    expect(shown()).toContain('p2:removable');
    undoTwo();
    expect(shown()).toContain('The only project can’t be removed');
  });
});
