import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { regexProblem, validateRule } from '@shadowlap/engine';
import { CI_DEFAULTS, ciWorkflows } from '../src/ci-workflows.js';
import { splitCommandLine } from '../src/settings.js';
import { ONLY_PROJECT, provideProjectRemoval, useProjectRemoval, type ProjectRemoval } from '../ui/project-actions.js';
import { TeamStoreRow } from '../ui/pages/settings/CiTeamStore.js';
import { settingsTabLabel } from '../ui/pages/settings/tabs.js';
import {
  MCP_FORMS,
  SETTINGS_TABS,
  addServerNotes,
  bytesText,
  ciShown,
  copiedLineText,
  entryEnvFor,
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
  pasteFile,
  pasteWhere,
  previewChip,
  proposedCount,
  ruleFacts,
  redactionNotes,
  regexLiteral,
  ruleCommand,
  runListKey,
  ruleInput,
  ruleProblem,
  ruleWarning,
  serverNameFor,
  settingsTab,
  shareLinksLine,
  sizeNote,
  suggestedReplace,
  syncText,
  typedSecret,
  returnedLine,
  unmaskedLine,
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
  for (let i = 3; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1]!;
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
    expect(runListKey([{ runId: 'B', status: 'completed' }, runs[1]], 'support-agent')).not.toBe(key);
    expect(runListKey([{ runId: 'C', status: 'completed' }, ...runs], 'support-agent')).not.toBe(key);
    expect(runListKey(runs.slice(0, 1), 'support-agent')).not.toBe(key);
    expect(runListKey(runs, 'triage-bot')).not.toBe(key);
    expect(runListKey(null, 'support-agent')).not.toBe(key);
  });
});

describe('the Settings tabs', () => {
  it('opens Matching without a tab, CI at ci and its older name alerts, Project at plan, and knows no other tab', () => {
    expect(SETTINGS_TABS.map((t) => t.label)).toEqual(['Matching', 'Redaction', 'CI', 'Coding agents', 'Tools', 'Project', 'Store']);
    expect(SETTINGS_TABS.map((t) => t.key)).toEqual(['matching', 'redaction', 'ci', 'agents', 'tools', 'project', 'store']);
    expect(settingsTab(null)).toBe('matching');
    expect(settingsTab('ci')).toBe('ci');
    expect(settingsTab('alerts')).toBe('ci');
    expect(settingsTab('plan')).toBe('project');
    expect(settingsTab('store')).toBe('store');
    expect(settingsTab('members')).toBeNull();
    expect(settingsTab('toString')).toBeNull();
    // The breadcrumb names the tab shown, whatever the address said.
    expect(['alerts', 'ci', null, 'tools', 'plan', 'members'].map(settingsTabLabel)).toEqual(['CI', 'CI', 'Matching', 'Tools', 'Project', 'Matching']);
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

  it('warns, in the engine’s words, about a regex its pattern check refuses, and only about one', () => {
    expect(ruleWarning(form({ mode: 'regex', regex: '(a+)+$' }))).toBe(`The CLI refuses it: ${regexProblem('(a+)+$', '')}.`);
    expect(ruleWarning(form({ mode: 'regex', regex: '/(\\w*\\s?)*/i' }))).toMatch(/^The CLI refuses it: matching it could take too long: /);
    expect(ruleWarning(form({ mode: 'regex', regex: '(a' }))).toMatch(/^The CLI refuses it: it isn't a regular expression: /);
    expect(ruleProblem(form({ mode: 'regex', regex: '(a+)+$' }))).toBeNull();
    // A repeated group that ends at a character it can't take is safe: (?:[\w-]+\.)+ reads a host name once.
    for (const regex of ['req_[a-z0-9]+', '(?<=key=)\\w+', '\\b(?:\\d[ -]?){13,16}\\b', '(?:[\\w-]+\\.)+', '']) expect(ruleWarning(form({ mode: 'regex', regex })), regex).toBeNull();
    expect(ruleWarning(form({}))).toBeNull();
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

describe('what leaves the machine', () => {
  // Push uploaded a run's email address unmasked while Redaction said the rules applied whenever a
  // run leaves the machine, and "API keys are never stored at all" while the demo needs a rule for
  // a key a tool is handed.
  it('says the rules apply to every export, pack and share link, and that push copies runs as recorded', () => {
    expect(redactionNotes(false)).toBe('The local store is never modified. A model call’s key and authorization headers, and a captured HTTP call’s credentials, are never stored at all.');
    expect(redactionNotes(true)).toContain('Push copies runs to your team store as recorded, so teammates can replay them.');
    expect(redactionNotes(true)).not.toMatch(/API keys .* never stored|whenever a run leaves/);
    expect(ruleFacts('redact', false)).toEqual([{ label: 'Packs', value: 'still replay', quiet: 'the rule applies to them as a normalizer' }]);
    expect(ruleFacts('redact', true)[1]).toEqual({ label: 'Push', value: 'copies runs as recorded', quiet: 'to your team store' });
    expect(ruleFacts('normalize', true)).toEqual([{ label: 'Matches', value: 'older recordings too', quiet: 'their fingerprints are worked out again' }]);
  });

  it('counts the rules a share link applies on Store, and warns when there are none or they can’t be read', () => {
    expect(shareLinksLine(3)).toEqual({ text: 'A report in the bucket with 3 redaction rules applied, behind a link that expires after 7 days. Anyone with the link can open it, without an account.', warn: null });
    expect(shareLinksLine(1).text).toContain('with 1 redaction rule applied');
    // None: no claim of a redacted report, and a warning instead.
    expect(shareLinksLine(0).text).not.toContain('redact');
    expect(shareLinksLine(0).warn).toBe('No redaction rules: the report holds the prompts and tool data as recorded. Add rules before you share a run.');
    expect(shareLinksLine(null).warn).toContain('can’t be read');
  });
});

describe('the preview', () => {
  it('names a rule by its path, else what a regex puts in place, else its pattern', () => {
    expect(previewChip({ path: '$.args.api_key', pattern: '/.+/', replace: '<KEY>' })).toBe('$.args.api_key');
    expect(previewChip({ pattern: '/\\b(?:\\d[ -]?){13,16}\\b/', replace: '<CARD>' })).toBe('<CARD>');
    expect(previewChip({ pattern: 'email', replace: '<EMAIL>' })).toBe('email');
    expect(maskedLine(1)).toBe('1 value would be masked');
    expect(maskedLine(1200)).toBe('1,200 values would be masked');
    expect(maskedLine(7, 1)).toBe('7 values would be masked, 1 left as it is');
    expect(maskedLine(0, 40)).toBe('0 values would be masked, 40 left as they are');
    // What only the copies that are read mask, in what calls got back.
    expect(maskedLine(7, 2, 1)).toBe('7 values would be masked, 2 left as they are, 1 more in HTML, HAR and dataset copies');
  });

  it('says under a rule what it matches that a pack leaves as it is, and what masks it, tersely', () => {
    const sample = (value: string, kind: string, name: string, path: string, key = false) => ({ value, key, callNo: 6, kind, name, in: 'response', path, event: null });
    const remedy = (path: string, copies: 'all' | 'read') => ({ rule: { path }, command: `shadowlap redact add --kind tool --name lookup_order --path '${path}' --replace '<AMOUNT>'`, copies });
    const none = { places: 0, remedies: [], covered: [], reasons: [] };
    expect(unmaskedLine({ count: 0, samples: [], ...none }, 3)).toBeNull();
    // After the values it masks, "more"; the first place's rule by its path, the command behind Copy, and how many places have one besides.
    expect(unmaskedLine({ count: 1, samples: [sample('240', 'tool', 'lookup_order', '$.result.amount')], places: 3, remedies: [remedy('$.args.amount', 'all'), remedy('$.result.amount', 'read')], covered: [], reasons: [] }, 6)).toEqual({
      text: '1 more left as it is · a path rule masks it',
      path: '$.args.amount',
      command: "shadowlap redact add --kind tool --name lookup_order --path '$.args.amount' --replace '<AMOUNT>'",
      more: 2,
      after: '',
      rows: [{ label: '240', value: 'call 6 tool lookup_order, response $.result.amount' }],
    });
    // In what a call got back the rule masks it only in the copies that are read; a pack keeps it.
    expect(unmaskedLine({ count: 2, samples: [], places: 1, remedies: [remedy('$.result.amount', 'read')], covered: [], reasons: ['replay'] }, 0)).toMatchObject({
      text: '2 left as they are · a pack keeps what calls got back; HTML, HAR and dataset copies mask them with a path rule',
      path: '$.result.amount',
      more: 0,
      after: 'none for clock or random reads, which a replay needs as recorded',
    });
    // A rule already masks them there.
    expect(unmaskedLine({ count: 1, samples: [], places: 0, remedies: [], covered: [3], reasons: [] }, 1)).toMatchObject({ text: '1 more left as it is · a pack keeps what calls got back; #3 masks it in HTML, HAR and dataset copies', path: null, command: null });
    // A clock read's time has no rule to add: a replay needs it; nor has a stream's event.
    expect(unmaskedLine({ count: 40, samples: [sample('1792177709735', 'clock', 'now', '$.result'), sample('1792177709821', 'clock', 'now', '$.result')], ...none, reasons: ['replay'] }, 0)).toMatchObject({
      text: '40 left as they are, in clock or random reads, which a replay needs as recorded.',
      command: null,
      rows: [{ label: '1792177709735', value: 'call 6 clock now, response $.result' }, { label: '1792177709821', value: 'call 6 clock now, response $.result' }],
    });
    expect(unmaskedLine({ count: 1, samples: [{ ...sample('1792177709735', 'api', 'POST /v1/messages', '$.message.usage.input_tokens'), event: 1 }], ...none, reasons: ['stream'] }, 0)).toMatchObject({
      text: '1 left as it is, in a stream’s events, which no path reaches.',
      rows: [{ label: '1792177709735', value: 'call 6 api, response event 1 $.message.usage.input_tokens' }],
    });
    // A key, and a model call named by its kind alone; a key at the top of a request gets no rule, and says why.
    expect(unmaskedLine({ count: 1, samples: [{ ...sample('bob@example.com', 'api', 'POST /v1/messages', '$["bob@example.com"]', true), in: 'request' }], ...none, reasons: ['whole'] }, 0)).toEqual({
      text: '1 left as it is, in the top of a request or response, which no path names alone.',
      path: null,
      command: null,
      more: 0,
      after: '',
      rows: [{ label: 'bob@example.com', value: 'call 6 api, request key $["bob@example.com"]' }],
    });
  });

  it('says what a path rule masks only in the copies that are read', () => {
    expect(returnedLine({ count: 0, samples: [] })).toBeNull();
    expect(returnedLine({ count: 2, samples: [{ before: '4111111111111111', after: '<CARD>' }] })).toEqual({
      text: '2 in what calls got back, masked in HTML, HAR and dataset copies; a pack keeps them for its replay',
      rows: [{ label: '4111111111111111', value: '→ <CARD>' }],
    });
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

  it('says what Clean up gives back on the Size row, once no run is recording when one is', () => {
    expect(sizeNote(0, 0)).toBe('blobs shared between runs');
    expect(sizeNote(512 * 1024, 1)).toBe('blobs shared between runs');
    expect(sizeNote(4.9 * 1024 * 1024, 0)).toBe('blobs shared between runs · 4.9 MB unused, which Clean up old runs gives back');
    expect(sizeNote(4.9 * 1024 * 1024, 1)).toBe('blobs shared between runs · 4.9 MB unused, which Clean up old runs gives back once no run is recording');
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
    expect(dry).toMatchObject({ count: 3, attempts: 0, olderThanDays: 30 });
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
    expect(splitCommandLine(MCP_FORMS.http.line)).toEqual(['shadowlap', 'mcp', '--url', 'https://mcp.example.com/mcp', '--header', 'Authorization: Bearer $TOKEN']);
    expect(splitCommandLine(MCP_FORMS.stdio.line).slice(0, 3)).toEqual(['shadowlap', 'mcp', '--']);
  });

  it('says what a copied line needs, and nothing about the entry’s own environment', () => {
    expect(copiedLineText({ name: 'github', file: '.mcp.json', line: 'shadowlap mcp -- npx -y @modelcontextprotocol/server-github' })).toBe('Copied the line for github · put it in front of the server in .mcp.json');
    expect(copiedLineText({ name: 'db', file: '.mcp.json', line: "shadowlap mcp -- npx -y server-postgres 'postgresql://•••@db/prod'" })).toBe('Copied the line for db · put it in front of the server in .mcp.json, then put back the ••• in it');
    expect(copiedLineText({ name: 'stripe', file: '.cursor/mcp.json', line: "shadowlap mcp --url https://mcp.stripe.com --header 'Authorization: Bearer ${STRIPE_TOKEN}'" })).toBe('Copied the line for stripe · put it in front of the server in .cursor/mcp.json, then set STRIPE_TOKEN in its env');
    // Claude Code fills in ${…} in .mcp.json from the environment it starts from, and won't start the server without it.
    expect(copiedLineText({ name: 'stripe', file: '.mcp.json', line: "shadowlap mcp --url https://mcp.stripe.com --header 'Authorization: Bearer ${STRIPE_TOKEN}'" })).toBe('Copied the line for stripe · put it in front of the server in .mcp.json, then set STRIPE_TOKEN in the environment Claude Code starts from');
  });

  it('says what Add MCP server hid, what it copies as typed, and where a Basic header’s variable is set', () => {
    const files = (...found: string[]) => ['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json'].map((path) => ({ path, found: found.includes(path) }));
    expect(pasteFile(files())).toBeNull();
    expect(pasteFile(files('.vscode/mcp.json', '.mcp.json'))).toBe('.mcp.json');
    expect(pasteFile(files('.cursor/mcp.json'))).toBe('.cursor/mcp.json');
    // Nothing hidden: nothing to say.
    expect(addServerNotes({ line: 'shadowlap mcp --url https://mcp.linear.app/mcp', hidden: false, basic: null, copy: { args: ['mcp', '--url', 'https://mcp.linear.app/mcp'] } }, null)).toBeNull();
    // A query shown hidden is copied as typed: said so, and nothing about a user and password that aren't there.
    const query = addServerNotes({ line: "shadowlap mcp --url 'https://mcp.example.com/mcp?transport=•••&profile=•••'", hidden: true, basic: null, copy: { args: ['mcp', '--url', 'https://mcp.example.com/mcp?transport=sse&profile=work'] } }, '.mcp.json');
    expect(query).toEqual({ basic: null, inCopy: false, asTyped: true });
    // A user and password: the variable, set where the file's client reads it.
    const basic = { line: "shadowlap mcp --url https://mcp.linear.app/mcp --header 'Authorization: Basic $LINEAR_AUTH'", hidden: true, basic: 'LINEAR_AUTH', copy: { args: ['mcp', '--url', 'https://mcp.linear.app/mcp', '--header', 'Authorization: Basic $LINEAR_AUTH'] } };
    expect(addServerNotes(basic, '.mcp.json')).toEqual({ basic: { name: 'LINEAR_AUTH', where: 'claude-code' }, inCopy: false, asTyped: false });
    expect(addServerNotes(basic, '.cursor/mcp.json')!.basic).toEqual({ name: 'LINEAR_AUTH', where: 'env' });
    expect(addServerNotes(basic, null)!.basic).toEqual({ name: 'LINEAR_AUTH', where: 'either' });
    // A command with a URL's user and password (••• in the copy too) and a token (copied as typed).
    expect(addServerNotes({ line: "shadowlap mcp -- node s.js --api-key ••• 'postgresql://•••@db/prod'", hidden: true, basic: null, copy: { args: ['mcp', '--', 'node', 's.js', '--api-key', 'sk-1', 'postgresql://•••@db/prod'] } }, null)).toEqual({ basic: null, inCopy: true, asTyped: true });
    // In .mcp.json the variable is a reference Claude Code fills in; elsewhere "…", for its value.
    const env = [{ name: 'LINEAR_AUTH', value: '…' }];
    expect(entryEnvFor(env, 'LINEAR_AUTH', '.mcp.json')).toEqual([{ name: 'LINEAR_AUTH', value: '${LINEAR_AUTH}' }]);
    expect(entryEnvFor(env, 'LINEAR_AUTH', '.vscode/mcp.json')).toEqual(env);
    expect(entryEnvFor(env, 'LINEAR_AUTH', null)).toEqual(env);
  });

  it('writes a client entry to paste under mcpServers', () => {
    expect(mcpEntryText('linear', { command: 'shadowlap', args: ['mcp', '--url', 'https://mcp.linear.app/mcp'] })).toBe('"linear": {\n  "command": "shadowlap",\n  "args": ["mcp", "--url", "https://mcp.linear.app/mcp"]\n}');
    expect(JSON.parse(`{${mcpEntryText('a "b"', { command: 'shadowlap', args: ['mcp', '--', 'x'] })}}`)).toEqual({ 'a "b"': { command: 'shadowlap', args: ['mcp', '--', 'x'] } });
    // With the variable a URL's user and password became.
    expect(JSON.parse(`{${mcpEntryText('linear', { command: 'shadowlap', args: ['mcp', '--url', 'https://mcp.linear.app/mcp', '--header', 'Authorization: Basic $LINEAR_AUTH'] }, [{ name: 'LINEAR_AUTH', value: '…' }])}}`)).toEqual({ linear: { command: 'shadowlap', args: ['mcp', '--url', 'https://mcp.linear.app/mcp', '--header', 'Authorization: Basic $LINEAR_AUTH'], env: { LINEAR_AUTH: '…' } } });
  });
});

describe('the CI tab', () => {
  it('shows what was changed on it, else what the server answered with', () => {
    const view = ciWorkflows(CI_DEFAULTS, { preview: null, failing: 0, at: null, repository: null, branch: null, defaultBranch: 'master' });
    // What an inconclusive golden does shows too: fail, the server's default, until it is changed here.
    expect(ciShown({}, view)).toEqual({ ...CI_DEFAULTS, inconclusive: 'fail' });
    expect(ciShown({ fix: true, secret: 'ALERTS_HOOK', inconclusive: 'warn' }, view)).toEqual({ ...CI_DEFAULTS, fix: true, secret: 'ALERTS_HOOK', inconclusive: 'warn' });
    // The pull request comment is on until it is turned off here; the server's answer says it.
    expect(ciShown({ comment: false }, view).comment).toBe(false);
    expect(ciShown({}, ciWorkflows({ ...CI_DEFAULTS, comment: false }, { preview: null, failing: 0, at: null, repository: null, branch: null })).comment).toBe(false);
    // The branch "only for the main branch" means is the repository's default, in the switch's words and the YAML.
    expect(view.alerts.branch).toBe('master');
    expect(view.workflow.text).toContain("github.ref == 'refs/heads/master'");
    expect(view.alerts.message.text).toBe('Shadowlap: 1 golden(s) failed on master.');
    expect(view.fixOnFailure.preview).toMatchObject({ example: true, base: 'master' });
  });

  it('keeps only what a secret name can hold, as it is typed', () => {
    expect(typedSecret('ALERTS-hook 1')).toBe('ALERTShook1');
    expect(typedSecret('')).toBe('');
  });

  it('says Fix on failure follows Push from CI, and leads to Settings → Store rather than switching it', () => {
    const row = (teamStore: { store: string | null; ciPush?: boolean }) =>
      renderToStaticMarkup(createElement(TeamStoreRow, { store: ciWorkflows(CI_DEFAULTS, { preview: null, failing: 0, at: null, repository: null, branch: null, teamStore }).fixOnFailure.teamStore }));
    const on = row({ store: 's3://northwind-agent-runs/support-agent' });
    expect([on.includes('<b>Team store</b><span>'), on.replace(/<[^>]+>/g, '').replace(/\u00a0/g, ' ')]).toEqual([true, expect.stringContaining('Team storeFollows Push from CI: on, so the test runs, and fixes from your branches, go there too.Settings')]);
    expect(on).toContain('href="#/settings/store"');
    expect(on).toContain('title="Push from CI is set in Settings → Store, for northwind-agent-runs/support-agent"');
    // No switch of its own: Push from CI is set in one place.
    expect(on).not.toMatch(/<button|<select|<input|role="switch"|aria-pressed/);
    expect(row({ store: 's3://northwind-agent-runs/support-agent', ciPush: false }).replace(/<[^>]+>/g, '').replace(/\u00a0/g, ' ')).toContain('Follows Push from CI: off, so test runs and fixes stay in GitHub.');
    // With none, the link leads to setting one up, which the row says there isn't yet.
    const none = row({ store: null });
    expect(none.replace(/<[^>]+>/g, '').replace(/\u00a0/g, ' ')).toContain('None yet, so test runs and fixes stay in GitHub. With one, this follows Push from CI.');
    expect(none).toContain('title="Set up a team store in Settings → Store"');
  });
});

describe('Remove project…', () => {
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
