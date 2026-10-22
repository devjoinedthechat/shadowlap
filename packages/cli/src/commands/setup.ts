import { basename } from 'node:path';
import { Command } from 'commander';
import { CONFIG_FILE, RULE_KINDS, addRule, describeRule, hasRecordedCommand, previewRedaction, readConfigFile, readRules, removeRule, ruleNoun, type Normalizer, type RedactionPreview, type RedactionUnmasked, type RuleList, type RunRecord } from '@shadowlap/engine';
import { recordActivity } from '../activity.js';
import { configPath, loadConfig } from '../config.js';
import { formatDoctor, runDoctor } from '../doctor.js';
import { formatInit, formatInitJob, initJson, inspectProject, noteInspected, writeInitialConfig } from '../init.js';
import { installedGlobally } from '../installed.js';
import { emitJobEvent, inDashboardJob } from '../job-events.js';
import { openStoreIfExists, parseChoice, recordEvents, requireRun, VERSION, type GlobalOpts } from '../shared.js';
import { palette as p, quoteArgv, safe, shortId, table } from '../ui.js';

/** Project setup and the rules in shadowlap.config.json. */

export function register(program: Command): void {
  program.commandsGroup('Set up:');

  program
    .command('init')
    .description('Set up Shadowlap in this project: detects your model SDKs, framework, agent command and tools, and prints the steps to your first recording')
    .option('--json', 'machine-readable output: the findings, each tool flagged when it isn\'t wrapped, and the code that wraps it')
    .action((flags: { json?: boolean }) => {
      const report = inspectProject(process.cwd());
      const wrote = report.languages.length ? writeInitialConfig(report) : false;
      if (wrote) recordActivity(program.opts<GlobalOpts>(), { kind: 'project.setup', ref: basename(process.cwd()), data: { name: basename(process.cwd()), config: 'created', languages: report.languages } });
      // A project in the dashboard has its first setup step done first, then a dashboard job hears the findings, and whether the step took them.
      const json = initJson(report, wrote);
      const result = { ...json, project: noteInspected(process.cwd(), json) };
      // As a dashboard job, what it found and nothing else: the setup's own buttons are the next steps there.
      process.stdout.write((flags.json ? JSON.stringify(result, null, 2) : inDashboardJob() ? formatInitJob(json, p) : formatInit(report, p, wrote, { globalCli: installedGlobally() })) + '\n');
      if (!flags.json && result.project.id && !result.project.noted) process.stderr.write(`${p.yellow('!')} The dashboard’s setup of ${result.project.id} didn’t take this in: ${result.project.why}\n`);
      emitJobEvent({ type: 'result', data: result });
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
    what: 'Manage redaction rules in shadowlap.config.json: what is masked in the copy of a run that leaves this machine (pack and every export)',
    add: 'Add a redaction rule. A pattern masks what it matches in every string of every stored request and response (only at --path, with one); --path alone replaces the whole value there, numbers included. A path reaches requests in every copy, and what a call got back only in a copy that is read (export html, har, dataset): a pack keeps it for its replay',
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
    .option('--path <jsonpath>', list === 'normalize' ? "where in the request, e.g. '$.metadata.user_id' (tool arguments are under $.args)" : "where in a request, e.g. '$.args.api_key' (a tool's arguments are under $.args); in a copy that is read, also in a response or tool result that is JSON (its result is under $.result)")
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
      recordEvents(program.opts<GlobalOpts>(), r.event ? [r.event] : []);
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
      recordEvents(program.opts<GlobalOpts>(), [r.event]);
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
      // A list of rules that is not a list is a mistake every other command stops on: say so here too.
      const raw = file.data[list];
      const error = raw !== undefined && raw !== null && !Array.isArray(raw) ? `${CONFIG_FILE}: ${list} must be a list of rules` : null;
      if (error) process.exitCode = 1;
      if (flags.json) {
        const out = rules.map((r, i) => (r.error === null ? { n: i + 1, ...r.rule } : { n: i + 1, error: r.error, rule: r.rule }));
        process.stdout.write(JSON.stringify({ file: file.path, exists: file.exists, version: file.version, error, rules: out }, null, 2) + '\n');
        return;
      }
      if (error) {
        process.stderr.write(`${p.red('✗')} ${error}, such as [{ "pattern": "uuid", "replace": "<UUID>" }]\n`);
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
    .description('Show what the redaction rules would mask in a run (default: the newest that has ended), counted and with samples, exactly as pack applies them, and what they match that a pack leaves as it is (a number), with the path rule that masks it or why none can. Nothing is written')
    .argument('[run]', 'run id or unique prefix')
    .option('--json', 'machine-readable output')
    .action((runArg: string | undefined, flags: { json?: boolean }) => {
      const rules = loadConfig(process.cwd()).redact;
      const noRun = 'no run to preview: record one with shadowlap run -- <command>';
      // Nothing recorded yet: say so without creating a store.
      const store = openStoreIfExists(program.opts<GlobalOpts>());
      if (!store) throw new Error(noRun);
      try {
        const recording = new Set(store.recordingRuns().live.map((r) => r.run.runId));
        const run = runArg ? requireRun(store, runArg) : (store.listRuns(200).find((r) => !recording.has(r.runId)) ?? null);
        if (!run) throw new Error(noRun);
        const preview = previewRedaction(store, run.runId, rules);
        emitJobEvent({ type: 'result', data: preview });
        if (flags.json) {
          process.stdout.write(JSON.stringify(preview, null, 2) + '\n');
          return;
        }
        process.stdout.write(formatPreview(preview, describedRun(run)));
      } finally {
        store.close();
      }
    });
}

/** A run as the preview names it: its command line, or for an import the file it came from. */
function describedRun(run: RunRecord): string {
  if (hasRecordedCommand(run)) return quoteArgv(run.command.argv);
  return run.meta?.imported?.from ? `imported from ${run.meta.imported.from}` : 'a capture';
}

/** What only the copies that are read mask, where a pack keeps what calls got back. */
const READ_COPIES = 'export html, har and dataset';

function formatPreview(preview: RedactionPreview, what: string): string {
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
  const total = `${preview.total} ${plural(preview.total, 'value', 'values')} would be masked${preview.unmasked ? `, ${preview.unmasked} left as ${plural(preview.unmasked, 'it is', 'they are')}` : ''}${preview.returned ? `; ${READ_COPIES} mask ${preview.returned} more in what calls got back` : ''}`;
  const lines = [`${shortId(preview.runId)} (${safe(what)}): ${preview.rules.length ? total : 'no redaction rules in shadowlap.config.json, so nothing would be masked'}`];
  for (const r of preview.rules) {
    lines.push(`  #${r.n}  ${safe(describeRule(r.rule))}  ${r.count ? p.bold(String(r.count)) : p.dim('0')}${r.note ? p.dim(`  ${safe(r.note)}`) : ''}`);
    for (const s of r.samples) lines.push(`        ${p.red('-')} ${safe(s.before)}`, `        ${p.green('+')} ${safe(s.after)}`);
    if (r.returned.count) {
      lines.push(`        ${READ_COPIES} mask ${p.bold(String(r.returned.count))} in what calls got back:`);
      for (const s of r.returned.samples) lines.push(`        ${p.red('-')} ${safe(s.before)}`, `        ${p.green('+')} ${safe(s.after)}`);
    }
    lines.push(...unmaskedLines(r.unmasked));
  }
  const d = preview.details;
  if (d.count) {
    const rules = d.rules.map((n) => `#${n}`).join(', ');
    lines.push(`  the run's command line, labels and notes: ${p.bold(String(d.count))} (${rules})${p.dim('  masked by export html, dataset and otel; pack copies them as recorded, since a replay runs the command')}`);
    for (const s of d.samples) lines.push(`        ${p.red('-')} ${safe(s.before)}`, `        ${p.green('+')} ${safe(s.after)}`);
  }
  if (preview.unreadable) lines.push(p.yellow(`  ${preview.unreadable} call${preview.unreadable === 1 ? '' : 's'} could not be read and ${preview.unreadable === 1 ? 'is' : 'are'} not counted`));
  return lines.join('\n') + '\n';
}

/** Why some values a rule leaves get no path rule, in words. */
const REASON_WORDS: Record<RedactionUnmasked['reasons'][number], string> = {
  replay: 'a clock or random read stays as recorded: a replay needs it',
  stream: "in a streamed response's events it stays as recorded: no path reaches into a stream",
  whole: "no path names it apart from the whole request or response: only a rule on all of it would mask it",
  key: "it is under a key a path can't name (one with a ]): no path rule reaches it",
};

/**
 * What a rule matches that a pack leaves as it is, under its samples: how many, up to two of them
 * with where each is, then what masks them, ready to run: the path rules for requests, which mask
 * them in every copy; those for what a call got back, which only the copies that are read apply,
 * since a pack's replay hands those values to the agent (or the rules that already do); and why the
 * rest get none.
 */
function unmaskedLines(u: RedactionUnmasked): string[] {
  if (!u.count) return [];
  const lines = [`        ${p.yellow(`${u.count} left as ${u.count === 1 ? 'it is' : 'they are'}`)}:`];
  // `call 2 tool lookup_card, response $.result.card`; a model call by its kind alone; a stream's event by its number.
  for (const s of u.samples) lines.push(`        ${p.yellow('=')} ${safe(s.value)}  ${p.dim(`call ${s.callNo} ${s.kind}${s.kind === 'api' ? '' : ` ${safe(s.name)}`}, ${s.in}${s.event === null ? '' : ` event ${s.event}`}${s.key ? ' key' : ''} ${safe(s.path)}`)}`);
  const all = u.remedies.filter((r) => r.copies === 'all');
  const read = u.remedies.filter((r) => r.copies === 'read');
  if (all.length) {
    lines.push(p.dim(all.some((r) => r.rule.pattern !== undefined) ? '        a path rule masks each where it is, in every copy:' : '        a path rule masks the whole value at its path, numbers included:'));
    for (const r of all) lines.push(`          ${safe(r.command)}`);
  }
  if (read.length || u.covered.length) {
    const by = u.covered.length ? ` (${u.covered.map((n) => `#${n}`).join(', ')} already ${u.covered.length === 1 ? 'does' : 'do'})` : '';
    lines.push(p.dim(`        a pack keeps what a call got back, since its replay hands it to the agent; ${READ_COPIES} mask it${by}${read.length ? ' with:' : ''}`));
    for (const r of read) lines.push(`          ${safe(r.command)}`);
  }
  if (u.places > u.remedies.length) lines.push(p.dim(`        and ${u.places - u.remedies.length} more ${u.places - u.remedies.length === 1 ? 'place' : 'places'}: add these, then preview again`));
  for (const reason of u.reasons) lines.push(p.dim(`        ${REASON_WORDS[reason]}`));
  return lines;
}
