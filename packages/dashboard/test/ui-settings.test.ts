import { describe, expect, it } from 'vitest';
import { validateRule } from '@shadowlap/engine';
import { alertsYaml, fixOnFailureYaml } from '../src/ci-yaml.js';
import { splitCommandLine } from '../src/settings.js';
import { settingsApi } from '../ui/settings-api.js';
import {
  CI_DEFAULTS,
  SETTINGS_TABS,
  bytesText,
  emptyRuleForm,
  gcDeleteCommand,
  gcDryRun,
  localCiWorkflows,
  maskedLine,
  mcpEntryText,
  mcpRows,
  mcpShortName,
  orList,
  previewChip,
  proposedCount,
  regexLiteral,
  ruleCommand,
  ruleInput,
  ruleProblem,
  settingsTab,
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

describe('the Settings tabs', () => {
  it('opens Matching without a tab, keeps CI at its old address, and knows no other tab', () => {
    expect(SETTINGS_TABS.map((t) => t.label)).toEqual(['Matching', 'Redaction', 'CI', 'Coding agents', 'Tools', 'Project', 'Store']);
    expect(settingsTab(null)).toBe('matching');
    expect(settingsTab('alerts')).toBe('alerts');
    expect(settingsTab('ci')).toBe('alerts');
    expect(settingsTab('store')).toBe('store');
    expect(settingsTab('plan')).toBeNull();
    expect(settingsTab('members')).toBeNull();
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

describe('the preview', () => {
  it('names a rule by its path, else what a regex puts in place, else its pattern', () => {
    expect(previewChip({ path: '$.args.api_key', pattern: '/.+/', replace: '<KEY>' })).toBe('$.args.api_key');
    expect(previewChip({ pattern: '/\\b(?:\\d[ -]?){13,16}\\b/', replace: '<CARD>' })).toBe('<CARD>');
    expect(previewChip({ pattern: 'email', replace: '<EMAIL>' })).toBe('email');
    expect(maskedLine(1)).toBe('1 value would be masked');
    expect(maskedLine(1200)).toBe('1,200 values would be masked');
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
    expect(gcDryRun({ done: true, code: 0, result: { ...report, count: 0 } })).toBeNull();
    expect(gcDryRun({ done: true, code: 0, result: { ...report, dryRun: false } })).toBeNull();
    expect(gcDryRun({ done: true, code: 1, result: report })).toBeNull();
    expect(gcDryRun({ done: false, code: null, result: report })).toBeNull();
  });
});

describe('MCP servers', () => {
  it('lists the configured servers, then those recorded that no config here lists, each with what records it', () => {
    const rows = mcpRows({
      servers: [
        { name: 'filesystem', file: '.mcp.json', transport: 'stdio', target: 'npx -y @modelcontextprotocol/server-filesystem /srv/notes', viaShadowlap: false, line: 'shadowlap mcp -- npx -y @modelcontextprotocol/server-filesystem /srv/notes', recorded: null },
        { name: 'stripe', file: '.mcp.json', transport: 'http', target: 'https://mcp.stripe.com', viaShadowlap: true, line: 'shadowlap mcp --url https://mcp.stripe.com', recorded: { tools: 18, writes: 6 } },
      ],
      recorded: [
        { transport: 'http', server: 'mcp.stripe.com', tools: 18, writes: 6, inConfig: true },
        { transport: 'stdio', server: 'npx @modelcontextprotocol/server-github@1.2.0', tools: 9, writes: 3, inConfig: false },
      ],
    });
    expect(rows.map((r) => [r.name, r.tools, r.writes, r.line !== null, r.note])).toEqual([
      ['filesystem', null, 0, true, 'not recorded · .mcp.json starts it directly'],
      ['stripe', 18, 6, false, null],
      ['server-github', 9, 3, false, 'recorded · in no config in this project'],
    ]);
    expect(mcpShortName('http', 'mcp.linear.app')).toBe('mcp.linear.app');
    expect(mcpShortName('stdio', 'uvx mcp-server-git')).toBe('mcp-server-git');
  });

  it('writes a client entry to paste under mcpServers', () => {
    expect(mcpEntryText('linear', { command: 'shadowlap', args: ['mcp', '--url', 'https://mcp.linear.app/mcp'] })).toBe('"linear": {\n  "command": "shadowlap",\n  "args": ["mcp", "--url", "https://mcp.linear.app/mcp"]\n}');
    expect(JSON.parse(`{${mcpEntryText('a "b"', { command: 'shadowlap', args: ['mcp', '--', 'x'] })}}`)).toEqual({ 'a "b"': { command: 'shadowlap', args: ['mcp', '--', 'x'] } });
  });
});

describe('the CI tab', () => {
  it('asks the tests feature for its panels, and writes them itself where the server has none', async () => {
    const asked: string[] = [];
    const served = settingsApi(<T,>(path: string) => {
      asked.push(path);
      return Promise.resolve({ file: '.github/workflows/agent.yml' } as T);
    });
    expect(await served.ciWorkflows({ ...CI_DEFAULTS, fix: true, repairer: 'openai:gpt-5', secret: 'ALERTS_HOOK' })).toMatchObject({ file: '.github/workflows/agent.yml' });
    expect(asked).toEqual(['ci/workflows?fix=on&budget=2.00&repairer=openai%3Agpt-5&onlyMain=on&secret=ALERTS_HOOK']);
    const older = settingsApi(() => Promise.reject(Object.assign(new Error('no endpoint GET /api/ci/workflows'), { status: 404 })));
    expect(await older.ciWorkflows(CI_DEFAULTS)).toBeNull();
    // Anything else the server says is the tab's to show.
    const refusing = settingsApi(() => Promise.reject(Object.assign(new Error('budget is an amount in dollars, such as 2.00'), { status: 400 })));
    await expect(refusing.ciWorkflows(CI_DEFAULTS)).rejects.toThrow(/budget/);
  });

  it('writes both panels as the endpoint does for a project with nothing to fill in', () => {
    const view = localCiWorkflows({ ...CI_DEFAULTS, budget: '5.00', onlyMain: false, secret: 'ALERTS_HOOK' });
    expect(view.fixOnFailure.yaml).toBe(fixOnFailureYaml({ budget: '5.00', repairer: 'claude-code', recordings: 'goldens/*' }));
    expect(view.fixOnFailure.needs.map((r) => r.value)).toContain('ANTHROPIC_API_KEY');
    expect(view.fixOnFailure.never.find((r) => r.label === 'spends past the budget')?.value).toBe('$5.00');
    expect(view.fixOnFailure.preview).toMatchObject({ example: true, fixId: null, spent: '≈$0.84 of $5.00' });
    expect(view.fixOnFailure.budgets.map((b) => b.label)).toEqual(['$1', '$2', '$5']);
    expect(view.alerts.yaml).toBe(alertsYaml({ onlyMain: false, secret: 'ALERTS_HOOK', recordings: 'goldens/*' }));
    expect(view.alerts.yaml).not.toContain('refs/heads/main');
    expect(view.alerts.needs.map((r) => r.value)).toContain('ALERTS_HOOK');
    expect(view.alerts.message.text).toBe('Shadowlap: 1 golden(s) failed on your-branch.');
    expect(localCiWorkflows({ ...CI_DEFAULTS, repairer: 'openai:gpt-5' }).fixOnFailure.needs.map((r) => r.value)).toContain('OPENAI_API_KEY');
  });

  it('keeps only what a secret name can hold, as it is typed', () => {
    expect(typedSecret('ALERTS-hook 1')).toBe('ALERTShook1');
    expect(typedSecret('')).toBe('');
  });
});
