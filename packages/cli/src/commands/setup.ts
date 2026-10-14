import { basename } from 'node:path';
import { Command } from 'commander';
import { recordActivity } from '../activity.js';
import { configPath, loadConfig, saveConfig } from '../config.js';
import { formatDoctor, runDoctor } from '../doctor.js';
import { formatInit, inspectProject, writeInitialConfig } from '../init.js';
import { emitJobEvent } from '../job-events.js';
import { parseChoice, VERSION, type GlobalOpts } from '../shared.js';
import { palette as p, table } from '../ui.js';

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
      const data = { ...report, config: { ...report.config, created: wrote } };
      if (wrote) recordActivity(program.opts<GlobalOpts>(), { kind: 'project.setup', ref: basename(process.cwd()), data: { name: basename(process.cwd()), config: 'created', languages: report.languages } });
      emitJobEvent({ type: 'result', data });
      process.stdout.write((flags.json ? JSON.stringify(data, null, 2) : formatInit(report, p, wrote)) + '\n');
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

  const normalize = program.command('normalize').description('Manage normalizers (shadowlap.config.json)');
  normalize
    .command('add')
    .description('Add a normalizer: values at <path> are masked before fingerprinting')
    .requiredOption('--path <jsonpath>', "e.g. '$.system[0].text'")
    .option('--pattern <pattern>', 'iso-date | iso-datetime | uuid | ulid | number | /regex/flags (omit to replace the whole value)')
    .option('--replace <text>', 'replacement text', '<MASKED>')
    .option('--kind <kind>', 'api | tool | clock | random', parseChoice(['api', 'tool', 'clock', 'random'] as const))
    .option('--name <name>', 'tool name, or e.g. "POST /v1/messages"')
    .action((flags: { path: string; pattern?: string; replace: string; kind?: 'api' | 'tool' | 'clock' | 'random'; name?: string }) => {
      const cwd = process.cwd();
      const config = loadConfig(cwd);
      config.normalize.push({
        ...(flags.kind ? { kind: flags.kind } : {}),
        ...(flags.name ? { name: flags.name } : {}),
        path: flags.path,
        ...(flags.pattern ? { pattern: flags.pattern } : {}),
        replace: flags.replace,
      });
      saveConfig(cwd, config);
      const added = config.normalize.at(-1)!;
      recordActivity(program.opts<GlobalOpts>(), { kind: 'normalizer.added', ref: added.path ?? null, data: { ...added } });
      process.stdout.write(`added normalizer #${config.normalize.length} to ${configPath(cwd)}\n`);
    });
  normalize
    .command('ls')
    .description('List normalizers')
    .action(() => {
      const config = loadConfig(process.cwd());
      if (config.normalize.length === 0) process.stdout.write(p.dim('no normalizers\n'));
      else process.stdout.write(table(config.normalize.map((n, i) => [`#${i + 1}`, n.kind ?? '*', n.name ?? '*', n.path ?? '(all strings)', n.pattern ?? '(whole value)', `→ ${n.replace}`])) + '\n');
    });

  const redact = program.command('redact').description('Manage redaction rules applied by shadowlap pack (shadowlap.config.json)');
  redact
    .command('add')
    .description('Add a redaction rule: a pattern masked in every stored request and response on export')
    .requiredOption('--pattern <pattern>', 'email | uuid | iso-datetime | … | /regex/flags')
    .option('--replace <text>', 'replacement text; must not match the pattern itself', '<REDACTED>')
    .option('--path <jsonpath>', 'restrict to a request path, e.g. \'$.messages[*].content\' (responses are always matched by pattern only)')
    .option('--kind <kind>', 'api | tool', parseChoice(['api', 'tool'] as const))
    .option('--name <name>', 'tool name, or e.g. "POST /v1/messages"')
    .action((flags: { pattern: string; replace: string; path?: string; kind?: 'api' | 'tool'; name?: string }) => {
      const cwd = process.cwd();
      const config = loadConfig(cwd);
      config.redact.push({
        ...(flags.kind ? { kind: flags.kind } : {}),
        ...(flags.name ? { name: flags.name } : {}),
        ...(flags.path ? { path: flags.path } : {}),
        pattern: flags.pattern,
        replace: flags.replace,
      });
      saveConfig(cwd, config);
      const added = config.redact.at(-1)!;
      recordActivity(program.opts<GlobalOpts>(), { kind: 'redaction.added', ref: added.pattern ?? null, data: { ...added } });
      process.stdout.write(`added redaction rule #${config.redact.length} to ${configPath(cwd)}\n`);
    });
  redact
    .command('ls')
    .description('List redaction rules')
    .action(() => {
      const config = loadConfig(process.cwd());
      if (config.redact.length === 0) process.stdout.write(p.dim('no redaction rules\n'));
      else process.stdout.write(table(config.redact.map((n, i) => [`#${i + 1}`, n.kind ?? '*', n.name ?? '*', n.path ?? '(all strings)', n.pattern ?? '', `→ ${n.replace}`])) + '\n');
    });

}
