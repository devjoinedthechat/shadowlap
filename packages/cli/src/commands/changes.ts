import { Command, InvalidArgumentError } from 'commander';
import { commandIsImported, formatDecisions, hasRecordedCommand, type DecisionsReport } from '@shadowlap/engine';
import { DecisionsError, commandProblem, decisionsCommand, resolveTargets, runDecisions, type DecisionsSettings, type DecisionTarget } from '../decisions.js';
import { parseFields, readExpectJson } from './fix.js';
import { emitJobEvent } from '../job-events.js';
import { formatMigrate, runMigrate, type MigrateReport } from '../migrate.js';
import { type GuardMode } from '../run-agent.js';
import { confirmImportedCommand, openStore, parseChoice, parseIntArg, type GlobalOpts } from '../shared.js';
import { palette as p, quoteArgv, shortId } from '../ui.js';

/**
 * Preview a change on recorded runs before it runs anywhere: `decisions` asks each recorded model
 * call again with only the change swapped in, and ranks what it decides differently; `migrate` does
 * that for a model switch, verifies what it flags, and writes the report a pull request needs.
 */

function parseUsd(value: string): number {
  const n = Number(value.replace(/^\$/, ''));
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('must be an amount in USD, such as 0.50');
  return n;
}

/** The command given after `--`, out of the arguments commander collected with the runs. */
function splitCommand(program: Command, given: string[]): { specs: string[]; argv: string[] | null } {
  // commander keeps the arguments it parsed (`rawArgs`), which its typings leave out.
  const raw = (program as unknown as { rawArgs?: string[] }).rawArgs ?? process.argv;
  const at = raw.lastIndexOf('--');
  if (at < 0) return { specs: given, argv: null };
  const after = raw.length - at - 1;
  if (after <= 0 || after > given.length) return { specs: given, argv: null };
  return { specs: given.slice(0, given.length - after), argv: given.slice(given.length - after) };
}

/** Consent for every imported command the change may run (the offline replay of --from-code, verify), asked before anything is spent. */
async function consent(targets: DecisionTarget[], argv: string[] | null, yes: boolean | undefined, runs: boolean): Promise<boolean> {
  if (!runs) return true;
  for (const t of targets) {
    const problem = commandProblem(t, argv);
    if (problem) throw new DecisionsError(problem);
    if (!argv && commandIsImported(t.run) && hasRecordedCommand(t.run) && !yes && !(await confirmImportedCommand(t.run, t.run.command.argv, `shadowlap decisions ${shortId(t.run.runId)} … -- <command>`))) return false;
  }
  return true;
}

function failed(err: unknown, json: boolean | undefined, kind: 'decisions' | 'migrate'): void {
  if (!(err instanceof DecisionsError)) throw err;
  if (json) process.stdout.write(JSON.stringify({ kind, outcome: 'error', error: { message: err.message } }, null, 2) + '\n');
  else process.stderr.write(`${p.red('✗')} ${err.message}\n`);
  process.exitCode = 1;
}

/** Where a job's drawer goes next: the runs whose writes or stops changed, the first of them its primary action. */
function emitDecisions(report: DecisionsReport): void {
  const flagged = report.flagged.slice(0, 3);
  flagged.forEach((runId, i) => emitJobEvent({ type: 'link', label: `Open ${runId.slice(0, 10)}`, href: `#/run/${runId}`, ...(i < flagged.length - 1 ? { secondary: true } : {}) }));
}

export function register(program: Command): void {
  program.commandsGroup('Preview a change:');

  program
    .command('decisions')
    .description("Preview what a change decides differently, without running the agent: ask each recorded model call again with only the change swapped in (--model, --set, or the prompt and tools your code sends now), and rank what changed by consequence, writes first. No tool runs.")
    .argument('<runs...>', 'runs (ids, unique prefixes, label:<name>) or goldens (pack folders, such as goldens/*); after "--", the command to run for --from-code and --then-verify')
    .option('--model <model>', 'the change is this model, at every model call')
    .option('--from-code', 'the change is the system prompt and tools your working tree sends now, read by replaying each run offline; nothing is sent to read them')
    .option('--set <key=value>', 'the change sets this request field at every model call, e.g. temperature=0 (repeatable)', (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option('--samples <n>', 'ask each model call this many times, and say how often its decision changed', parseIntArg, 1)
    .option('--concurrency <n>', 'requests in flight at once', parseIntArg, 4)
    .option('--scope <name>', "ask only the model calls made in this scope, such as the agent's and not a simulated user's")
    .option('--then-verify', 'then run shadowlap verify on the runs with a rank 1 or 2 change (a write, or when the agent stops), and only on those')
    .option('--expect <json|@file>', 'with --then-verify: what a passing run must do besides exiting 0 (default: each golden\'s checks from shadowlap.config.json)')
    .option('--attempts <n>', 'with --then-verify: attempts per run', parseIntArg, 5)
    .option('--passes <n>', 'with --then-verify: attempts that must pass (default: 80%, rounded up)', parseIntArg)
    .option('--writes <policy>', 'with --then-verify: what write tools do after a fork: stub or block', parseChoice(['stub', 'block'] as const), 'stub')
    .option('--budget <usd>', 'send no request (and start no verify attempt) once this much is spent', parseUsd)
    .option('--timeout <seconds>', 'stop a model request, or a verify attempt, after this long', parseIntArg)
    .option('--strict', 'exit 1 when a run has a rank 1 or 2 change (for CI)')
    .option('--guard <mode>', 'with --then-verify: network guard for connections that bypass Shadowlap: warn | block | off', parseChoice<GuardMode>(['warn', 'block', 'off']), 'warn')
    .option('-y, --yes', 'run the recorded command of imported runs and goldens without asking')
    .option('--json', 'print the report as JSON, as the dashboard reads it (progress still goes to stderr)')
    .action(async (given: string[], flags: { model?: string; fromCode?: boolean; set: string[]; samples: number; concurrency: number; scope?: string; thenVerify?: boolean; expect?: string; attempts: number; passes?: number; writes: 'stub' | 'block'; budget?: number; timeout?: number; strict?: boolean; guard: GuardMode; yes?: boolean; json?: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      const { specs, argv } = splitCommand(program, given);
      if (!specs.length) throw new InvalidArgumentError('name the runs or goldens to ask again: shadowlap decisions goldens/* --model <model>');
      // `--set model=…` is the model, as verify and blame read it; both at once is refused there.
      const { model: setModel, ...fields } = parseFields(flags.set, flags.model);
      const model = typeof setModel === 'string' ? setModel : null;
      if (!model && !flags.fromCode && !Object.keys(fields).length) throw new InvalidArgumentError('give the change: --model <model>, --set <key=value>, or --from-code for the prompt and tools in your working tree');
      if (flags.samples > 20) throw new InvalidArgumentError('--samples is at most 20');
      if (flags.attempts > 100) throw new InvalidArgumentError('--attempts is at most 100');
      const passes = flags.passes ?? Math.ceil(0.8 * flags.attempts);
      if (passes > flags.attempts) throw new InvalidArgumentError(`--passes (${passes}) can't be more than --attempts (${flags.attempts})`);
      if (!flags.thenVerify && (flags.expect !== undefined || flags.passes !== undefined)) throw new InvalidArgumentError('--expect and --passes are for --then-verify, which verifies the runs a change flags');
      const expect = flags.expect !== undefined ? readExpectJson(flags.expect) : null;
      const log = (line: string) => process.stderr.write(`${line}\n`);
      const store = openStore(opts);
      let targets: DecisionTarget[];
      try {
        targets = resolveTargets(store, specs, process.cwd());
      } catch (err) {
        store.close();
        return failed(err, flags.json, 'decisions');
      }
      store.close();
      try {
        if (!(await consent(targets, argv, flags.yes, !!flags.fromCode || !!flags.thenVerify))) {
          process.exitCode = 1;
          return;
        }
        const settings: DecisionsSettings = {
          model,
          fields,
          fromCode: !!flags.fromCode,
          samples: flags.samples,
          concurrency: flags.concurrency,
          budget: flags.budget ?? null,
          timeoutMs: flags.timeout === undefined ? null : flags.timeout * 1000,
          scope: flags.scope ?? null,
          remedies: false,
          guard: flags.guard,
          argv,
          thenVerify: flags.thenVerify ? { attempts: flags.attempts, needed: passes, writes: flags.writes, expect } : null,
        };
        const command = decisionsCommand(specs, settings);
        log(`${p.yellow('⑂')} Asking the model calls of ${targets.length} run${targets.length === 1 ? '' : 's'} again under ${[flags.fromCode ? 'the prompt and tools in your working tree' : '', model ? `the model ${model}` : '', Object.keys(fields).length ? Object.entries(fields).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ') : ''].filter(Boolean).join(' and ')}`);
        log(p.dim(`  ${flags.samples} sample${flags.samples === 1 ? '' : 's'} per call, ${flags.concurrency} at once · no tool runs${flags.budget ? ` · budget $${flags.budget.toFixed(2)}` : ''}`));
        const report = await runDecisions({ opts, targets, settings, command, log });
        if (flags.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        else process.stdout.write('\n' + formatDecisions(report, p) + '\n' + (report.verify ? verifyLines(report) : ''));
        emitDecisions(report);
        emitJobEvent({ type: 'result', data: report as unknown as Record<string, unknown> });
        const rejected = report.verify && report.verify.verdict !== 'accepted' && report.verify.verdict !== 'not-run';
        // A run that could not be asked at all (a --from-code change that is more than a prompt) is no preview of it.
        process.exitCode = rejected || (flags.strict && report.flagged.length) || report.stopReason || report.runs.some((r) => r.refused) ? 1 : 0;
      } catch (err) {
        failed(err, flags.json, 'decisions');
      }
    });

  program
    .command('migrate')
    .description("Switch models with the evidence: ask every model call of your goldens again under the new model (with the fields it refuses changed to what it takes), verify the runs whose writes or stops change, and compare what a run costs. Ends in one report, what changes, what still passes, what it costs and what to set, with the change to your files and a pull request body.")
    .argument('[goldens...]', 'goldens (pack folders) or runs to migrate (default: goldens/*); after "--", the command to verify with')
    .requiredOption('--to <model>', 'the model to switch to')
    .option('--set <key=value>', 'a request field the switch sets as well (repeatable)', (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option('--samples <n>', 'ask each model call this many times', parseIntArg, 1)
    .option('--concurrency <n>', 'requests in flight at once', parseIntArg, 4)
    .option('--expect <json|@file>', "what a passing run must do besides exiting 0 (default: each golden's checks from shadowlap.config.json)")
    .option('--attempts <n>', 'verify: attempts per run', parseIntArg, 5)
    .option('--passes <n>', 'verify: attempts that must pass (default: 80%, rounded up)', parseIntArg)
    .option('--writes <policy>', 'verify: what write tools do after a fork: stub or block', parseChoice(['stub', 'block'] as const), 'stub')
    .option('--budget <usd>', 'send no request and start no attempt once this much is spent', parseUsd)
    .option('--timeout <seconds>', 'stop a model request, or a verify attempt, after this long', parseIntArg)
    .option('--guard <mode>', 'verify: network guard for connections that bypass Shadowlap: warn | block | off', parseChoice<GuardMode>(['warn', 'block', 'off']), 'warn')
    .option('-y, --yes', 'run the recorded command of imported goldens without asking')
    .option('--json', 'print the report as JSON, as the dashboard reads it (progress still goes to stderr)')
    .action(async (given: string[], flags: { to: string; set: string[]; samples: number; concurrency: number; expect?: string; attempts: number; passes?: number; writes: 'stub' | 'block'; budget?: number; timeout?: number; guard: GuardMode; yes?: boolean; json?: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      const split = splitCommand(program, given);
      const specs = split.specs.length ? split.specs : ['goldens/*'];
      const fields = parseFields(flags.set, undefined);
      if ('model' in fields) throw new InvalidArgumentError('--to is the model to switch to; --set model=… would set it twice');
      if (flags.samples > 20) throw new InvalidArgumentError('--samples is at most 20');
      if (flags.attempts > 100) throw new InvalidArgumentError('--attempts is at most 100');
      const passes = flags.passes ?? Math.ceil(0.8 * flags.attempts);
      if (passes > flags.attempts) throw new InvalidArgumentError(`--passes (${passes}) can't be more than --attempts (${flags.attempts})`);
      const expect = flags.expect !== undefined ? readExpectJson(flags.expect) : null;
      const log = (line: string) => process.stderr.write(`${line}\n`);
      const store = openStore(opts);
      let targets: DecisionTarget[];
      try {
        targets = resolveTargets(store, specs, process.cwd());
        if (!targets.length) throw new DecisionsError('no goldens to migrate: pack a run into goldens/ first (shadowlap pack <run> goldens/<name>), or name the runs');
      } catch (err) {
        store.close();
        return failed(err, flags.json, 'migrate');
      }
      store.close();
      try {
        if (!(await consent(targets, split.argv, flags.yes, true))) {
          process.exitCode = 1;
          return;
        }
        const command = quoteArgv(['shadowlap', 'migrate', '--to', flags.to, ...specs, ...Object.entries(fields).flatMap(([k, v]) => ['--set', `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`]), ...(split.argv ? ['--', ...split.argv] : [])]);
        log(`${p.yellow('⑂')} Migrating ${targets.length} run${targets.length === 1 ? '' : 's'} to ${flags.to}: every model call asked again, then the runs whose writes or stops change verified`);
        const report = await runMigrate({
          opts,
          targets,
          settings: { to: flags.to, fields, samples: flags.samples, concurrency: flags.concurrency, budget: flags.budget ?? null, timeoutMs: flags.timeout === undefined ? null : flags.timeout * 1000, attempts: flags.attempts, needed: passes, writes: flags.writes, expect, guard: flags.guard, argv: split.argv },
          command,
          log,
        });
        if (flags.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        else process.stdout.write('\n' + formatMigrate(report) + '\n');
        emitDecisions(report.decisions);
        if (report.files) {
          emitJobEvent({ type: 'file', path: report.files.pullRequest, label: 'Pull request body' });
          if (report.files.patch) emitJobEvent({ type: 'file', path: report.files.patch, label: 'The config change' });
        }
        emitJobEvent({ type: 'result', data: report as unknown as Record<string, unknown> });
        process.exitCode = migrateExit(report);
      } catch (err) {
        failed(err, flags.json, 'migrate');
      }
    });
}

/** 0 when what was verified passes and every step was asked; 1 otherwise. */
export function migrateExit(r: MigrateReport): number {
  if (r.stopReason) return 1;
  if (r.passes.verdict === 'rejected' || r.passes.verdict === 'incomplete') return 1;
  return r.passes.runs.some((x) => x.outcome === 'not-asked') ? 1 : 0;
}

function verifyLines(r: DecisionsReport): string {
  const v = r.verify!;
  if (v.verdict === 'not-run') return '';
  const head = v.verdict === 'accepted' ? `${p.green('✓')} Verified` : v.verdict === 'rejected' ? `${p.red('✗')} Verify rejected the change` : `${p.yellow('!')} Verify did not finish`;
  const lines = [``, `${head}: ${v.runs.length} run${v.runs.length === 1 ? '' : 's'} with a write or stop change`];
  for (const x of v.runs) lines.push(`  ${x.runId.slice(0, 10)}  ${x.outcome}  ${p.dim(`${x.passes} of ${x.attempts} passed`)}`);
  for (const reason of v.reasons) lines.push(`  ${p.red('·')} ${reason}`);
  for (const c of v.commands) lines.push(p.dim(`  ${c}`));
  return lines.join('\n') + '\n';
}
