import { Command } from 'commander';
import { RULE_KINDS, addRule, describeRule, previewRedaction, readConfigFile, readRules, removeRule, ruleNoun, type Normalizer, type RedactionPreview, type RuleList } from '@shadowlap/engine';
import { configPath, loadConfig } from '../config.js';
import { formatDoctor, runDoctor } from '../doctor.js';
import { formatInit, inspectProject, writeInitialConfig } from '../init.js';
import { emitJobEvent } from '../job-events.js';
import { openStore, parseChoice, recordActivity, requireRun, VERSION, type GlobalOpts } from '../shared.js';
import { palette as p, quoteArgv, safe, shortId, table } from '../ui.js';

/** Project setup and the rules in shadowlap.config.json. */

export function register(program: Command): void {
  program.commandsGroup('Set up:');

  program
    .command('init')
    .description('Set up Shadowlap in this project: detects your model SDKs, framework, agent command and tools, and prints the steps to your first recording')
    .option('--json', 'machine-readable output')
    .action((flags: { json?: boolean }) => {
      const report = inspectProject(process.cwd());
      const wrote = report.languages.length ? writeInitialConfig(report) : false;
      process.stdout.write((flags.json ? JSON.stringify({ ...report, config: { ...report.config, created: wrote } }, null, 2) : formatInit(report, p, wrote)) + '\n');
    });

  program
    .command('doctor')
    .description('Check the environment, the store and the configuration; explains anything that would get in the way')
    .option('--json', 'machine-readable output')
    .action((flags: { json?: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      const checks = runDoctor({ version: VERSION, ...(opts.db ? { dbPath: opts.db } : {}) });
      process.stdout.write((flags.json ? JSON.stringify(checks, null, 2) : formatDoctor(checks, p)) + '\n');
      process.exitCode = checks.some((c) => c.verdict === 'fail') ? 1 : 0;
    });

  for (const list of ['normalize', 'redact'] as const) registerRules(program, list);
}

interface RuleFlags {
  path?: string;
  pattern?: string;
  replace: string;
  kind?: string;
  name?: string;
  expect?: string;
}

const EXPECT_HELP = 'edit only if shadowlap.config.json is still this version (ls --json prints it)';

const HOW: Record<RuleList, { what: string; add: string; listed: string }> = {
  normalize: {
    what: 'Manage normalizers in shadowlap.config.json: values masked before matching, so a value made anew on every run does not fork a replay',
    add: 'Add a normalizer. A pattern masks what it matches (at --path, or in every string without one); --path alone replaces the whole value there',
    listed: 'no normalizers',
  },
  redact: {
    what: 'Manage redaction rules in shadowlap.config.json: what is masked in the copy of a run that leaves this machine (pack, export html and the other exports)',
    add: 'Add a redaction rule. A pattern masks what it matches in every stored request and response (only at --path in requests, with one); --path alone replaces the whole value there',
    listed: 'no redaction rules',
  },
};

/** `normalize` and `redact`: the same verbs over the two lists of rules, sharing the dashboard's checks and writer. */
function registerRules(program: Command, list: RuleList): void {
  const noun = ruleNoun(list);
  const cmd = program.command(list).description(HOW[list].what);

  cmd
    .command('add')
    .description(HOW[list].add)
    .option('--path <jsonpath>', `where in the request, e.g. '${list === 'normalize' ? '$.metadata.user_id' : '$.args.api_key'}' (tool arguments are under $.args)`)
    .option('--pattern <pattern>', 'uuid | ulid | iso-date | iso-datetime | number | email | /regex/flags')
    .option('--replace <text>', list === 'redact' ? 'replacement text; the pattern must leave it as it is' : 'replacement text', list === 'redact' ? '<REDACTED>' : '<MASKED>')
    .option('--kind <kind>', `only calls of this kind: ${RULE_KINDS[list].join(' | ')}`, parseChoice(RULE_KINDS[list]))
    .option('--name <name>', 'only calls with this name: a tool name, or e.g. "POST /v1/messages"')
    .option('--expect <version>', EXPECT_HELP)
    .action((flags: RuleFlags) => {
      const cwd = process.cwd();
      const r = addRule(cwd, list, { kind: flags.kind, name: flags.name, path: flags.path, pattern: flags.pattern, replace: flags.replace }, flags.expect ? { expect: flags.expect } : {});
      if (!r.added) {
        process.stdout.write(`${noun} #${r.n} in ${configPath(cwd)} is already this rule; nothing changed\n`);
        return;
      }
      recordActivity(program.opts<GlobalOpts>(), r.event ? [r.event] : []);
      process.stdout.write(`added ${noun} #${r.n} to ${configPath(cwd)}\n`);
    });

  cmd
    .command('rm')
    .description(`Remove a ${noun}, by its number in \`${list} ls\` or by its name, path or pattern`)
    .argument('<rule>', `its number (2 or #2), or the tool name, path or pattern of exactly one ${noun}`)
    .option('--expect <version>', EXPECT_HELP)
    .action((which: string, flags: { expect?: string }) => {
      const cwd = process.cwd();
      const r = removeRule(cwd, list, which, flags.expect ? { expect: flags.expect } : {});
      recordActivity(program.opts<GlobalOpts>(), [r.event]);
      const rule = typeof r.rule === 'object' && r.rule !== null ? describeRule(r.rule as Normalizer) : JSON.stringify(r.rule);
      process.stdout.write(`removed ${noun} #${r.n} (${safe(rule)}) from ${configPath(cwd)}\n`);
      const left = readRules(r.file, list).length;
      if (left && r.n <= left) process.stdout.write(p.dim(`  the ${ruleNoun(list, true)} after it moved up one: shadowlap ${list} ls\n`));
    });

  cmd
    .command('ls')
    .description(`List ${ruleNoun(list, true)}, numbered as rm takes them`)
    .option('--json', 'machine-readable output: the file, its version and every rule with its number')
    .action((flags: { json?: boolean }) => {
      const file = readConfigFile(process.cwd());
      const rules = readRules(file, list);
      if (flags.json) {
        const out = rules.map((r, i) => (r.error === null ? { n: i + 1, ...r.rule } : { n: i + 1, error: r.error, rule: r.rule }));
        process.stdout.write(JSON.stringify({ file: file.path, exists: file.exists, version: file.version, rules: out }, null, 2) + '\n');
        return;
      }
      if (rules.length === 0) {
        process.stdout.write(p.dim(`${HOW[list].listed}\n`));
        return;
      }
      const rows = rules.map((r, i) => {
        if (r.error !== null) return [`#${i + 1}`, p.red(`✗ ${r.error}`)];
        const n = r.rule;
        return [`#${i + 1}`, n.kind ?? '*', n.name ?? '*', n.path ?? '(all strings)', n.pattern ?? '(whole value)', `→ ${n.replace}`].map(safe);
      });
      process.stdout.write(table(rows) + '\n');
    });

  if (list === 'redact') registerPreview(program, cmd);
}

/** `redact preview`: what the rules would mask in one run, before it leaves the machine. */
function registerPreview(program: Command, cmd: Command): void {
  cmd
    .command('preview')
    .description('Show what the redaction rules would mask in a run (default: the newest that has ended), counted and with samples, exactly as pack applies them. Nothing is written')
    .argument('[run]', 'run id or unique prefix')
    .option('--json', 'machine-readable output')
    .action((runArg: string | undefined, flags: { json?: boolean }) => {
      const rules = loadConfig(process.cwd()).redact;
      const store = openStore(program.opts<GlobalOpts>());
      try {
        const run = runArg ? requireRun(store, runArg) : (store.listRuns(200).find((r) => r.status !== 'running') ?? null);
        if (!run) throw new Error('no run to preview: record one with shadowlap run -- <command>');
        const preview = previewRedaction(store, run.runId, rules);
        emitJobEvent({ type: 'result', data: preview });
        if (flags.json) {
          process.stdout.write(JSON.stringify(preview, null, 2) + '\n');
          return;
        }
        process.stdout.write(formatPreview(preview, quoteArgv(run.command.argv)));
      } finally {
        store.close();
      }
    });
}

function formatPreview(preview: RedactionPreview, command: string): string {
  const total = `${preview.total} value${preview.total === 1 ? '' : 's'} would be masked`;
  const lines = [`${shortId(preview.runId)} (${safe(command)}): ${preview.rules.length ? total : 'no redaction rules in shadowlap.config.json, so nothing would be masked'}`];
  for (const r of preview.rules) {
    lines.push(`  #${r.n}  ${safe(describeRule(r.rule))}  ${r.count ? p.bold(String(r.count)) : p.dim('0')}${r.note ? p.dim(`  ${safe(r.note)}`) : ''}`);
    for (const s of r.samples) lines.push(`        ${p.red('-')} ${safe(s.before)}`, `        ${p.green('+')} ${safe(s.after)}`);
  }
  if (preview.unreadable) lines.push(p.yellow(`  ${preview.unreadable} call${preview.unreadable === 1 ? '' : 's'} could not be read and ${preview.unreadable === 1 ? 'is' : 'are'} not counted`));
  return lines.join('\n') + '\n';
}
