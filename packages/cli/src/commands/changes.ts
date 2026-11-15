import { resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { links } from '@shadowlap/dashboard';
import { ACTIONS, byRule, commandIsImported, decisionsUnsettled, fieldValue, GATE_MAX_ATTEMPTS, formatDecisions, hasRecordedCommand, migrateBreaks, migrateUnsettled, SPRT_DEFAULTS, tallyParts, unsettledReason, unsettledRun, verifyTallyLine, type DecisionsReport, type DecisionsVerify } from '@shadowlap/engine';
import { DECISIONS_SAMPLES, DecisionsError, commandProblem, decisionsCommand, resolveTargets, runDecisions, type DecisionsSettings, type DecisionTarget } from '../decisions.js';
import { formatDecisionsRead, readDecisions } from '../decisions-read.js';
import { keepDecisionsPart, testSessionFlag, testSessionKnown } from '../decisions-test-session.js';
import { verifySession } from '../decisions-verify.js';
import { goldenConsented } from '../golden-consent.js';
import { attemptRule, parseFields, readExpectJson } from './fix-flags.js';
import { gateFlags } from '../fixes.js';
import { EXIT, inconclusiveStatus, interruptedStatus, stoppedBy } from '../exit-codes.js';
import { emitJobEvent } from '../job-events.js';
import { formatMigrate, runMigrate, type MigrateReport } from '../migrate.js';
import { registerMigrateApply } from './migrate-apply.js';
import { type GuardMode } from '../run-agent.js';
import { collect, confirmImportedCommand, openStore, parseChoice, parseIntArg, parseUsd, type GlobalOpts } from '../shared.js';
import { palette as p, quoteArgv, shortId } from '../ui.js';

/**
 * Preview a change on recorded runs before it runs anywhere: `decisions` asks each recorded model
 * call again with only the change swapped in, and ranks what it decides differently; `migrate` does
 * that for a model switch, verifies what it flags, and writes the report a pull request needs.
 */

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

/**
 * The change `decisions` asks under, read from its flags: the model (`--set model=…` is the model, as
 * verify and blame read it; both at once is refused there), the request fields, and the models it
 * switches from, null when none is named (the one the runs use most).
 */
function decisionsChange(flags: { model?: string; fromCode?: boolean; set?: string[]; from?: string[] }): Pick<DecisionsSettings, 'model' | 'fields' | 'from'> {
  const { model: setModel, ...fields } = parseFields(flags.set, flags.model);
  const model = typeof setModel === 'string' ? setModel : null;
  if (!model && !flags.fromCode && !Object.keys(fields).length) throw new InvalidArgumentError('give the change: --model <model>, --set <key=value>, or --from-code for the prompt and tools in your working tree');
  if (flags.from?.length && !model && !Object.keys(fields).length) throw new InvalidArgumentError('--from names the model calls --model and --set change: give one of them');
  return { model, fields, from: flags.from?.length ? flags.from : null };
}

/**
 * Consent for every command someone else chose that the change may run (the offline replay of
 * --from-code, verify), asked before anything is spent: a run's from a pack or the team store, and a
 * golden's, named by its pack folder, as `shadowlap test` asks of one (goldenNeedsConsent).
 */
async function consent(targets: DecisionTarget[], argv: string[] | null, yes: boolean | undefined, runs: boolean, kind: 'decisions' | 'migrate' = 'decisions'): Promise<boolean> {
  if (!runs) return true;
  const cwd = process.cwd();
  for (const t of targets) {
    const problem = commandProblem(t, argv);
    if (problem) throw new DecisionsError(problem);
    if (argv || yes) continue;
    if (t.golden !== null) {
      if (!(await goldenConsented(t.run, resolve(cwd, t.golden), cwd, false, `shadowlap ${kind} ${t.golden} … --yes`))) return false;
    } else if (commandIsImported(t.run) && hasRecordedCommand(t.run) && !(await confirmImportedCommand(t.run, t.run.command.argv, `shadowlap ${kind} ${shortId(t.run.runId)} … -- <command>`))) return false;
  }
  return true;
}

/**
 * A refusal before anything ran (no credentials, no such run or session, a command that can't run),
 * as `--json` prints it: `{ kind, outcome: "error", error: { message } }`. Exit status 2.
 */
function failed(err: unknown, json: boolean | undefined, kind: 'decisions' | 'migrate'): void {
  if (!(err instanceof DecisionsError)) throw err;
  if (json) process.stdout.write(JSON.stringify({ kind, outcome: 'error', error: { message: err.message } }, null, 2) + '\n');
  else process.stderr.write(`${p.red('✗')} ${err.message}\n`);
  process.exitCode = EXIT.usage;
}

/**
 * Where a preview's drawer goes next: the preview it kept, on Changes; a preview that kept no session
 * leads to the runs it flagged, as a migration's decisions do.
 */
function emitPreview(report: DecisionsReport): void {
  if (report.decisionsId) emitJobEvent({ type: 'link', label: ACTIONS.openPreview.label, href: links.changeSession('decisions', report.decisionsId) });
  else emitDecisions(report);
}

/** Where a job's drawer goes next: the runs with a write, stop or judged change, the first of them its primary action. */
function emitDecisions(report: DecisionsReport): void {
  const flagged = report.flagged.slice(0, 3);
  flagged.forEach((runId, i) => emitJobEvent({ type: 'link', label: `Open ${runId.slice(0, 10)}`, href: links.run(runId), ...(i < flagged.length - 1 ? { secondary: true } : {}) }));
}

/**
 * The exit status for an inconclusive verdict: 3 with `--inconclusive fail` (the default), 0 with
 * `warn`, after a warning; a session a stop signal cut short ends with the signal's status.
 */
function inconclusiveExit(mode: 'fail' | 'warn', why: string | null): number {
  if (stoppedBy()) return interruptedStatus();
  if (!why) return EXIT.ok;
  if (mode === 'warn') process.stderr.write(`${p.yellow('!')} inconclusive, and --inconclusive warn lets it pass: ${why}\n`);
  return inconclusiveStatus(mode);
}

/**
 * Why a decisions report settles nothing, or null, by the engine's rule (decisionsUnsettled), the one
 * the dashboard reads a kept session by: it stopped early, a run could not be asked, a run it doesn't
 * flag has a step that waits on a judge or on its control, verify didn't settle the runs it took.
 */
export function decisionsInconclusive(r: DecisionsReport): string | null {
  return decisionsUnsettled({ stopReason: r.stopReason, flagged: r.flagged, toVerify: r.toVerify, runs: r.runs.map(unsettledRun), verify: r.verify });
}

/** The flags of `shadowlap decisions`, as commander gives them. */
interface DecisionsFlags {
  model?: string;
  fromCode?: boolean;
  set?: string[];
  from?: string[];
  samples: number;
  concurrency: number;
  scope?: string;
  thenVerify?: boolean;
  verify?: string;
  keptMax?: number;
  dryRun?: boolean;
  expect?: string;
  gate?: string;
  attempts?: number;
  passes?: number;
  writes: 'stub' | 'block';
  budget?: number;
  timeout?: number;
  strict?: boolean;
  inconclusive: 'fail' | 'warn';
  guard: GuardMode;
  yes?: boolean;
  json?: boolean;
  testSession?: string;
}

/** What `decisions` asks under: the change, how many samples and at once, and what stops it. */
function decisionsSettings(flags: DecisionsFlags, o: Pick<DecisionsSettings, 'model' | 'fields' | 'from' | 'timeoutMs' | 'argv' | 'thenVerify'>): DecisionsSettings {
  return { ...o, fromCode: !!flags.fromCode, samples: flags.samples, concurrency: flags.concurrency, budget: flags.budget ?? null, scope: flags.scope ?? null, remedies: false, guard: flags.guard };
}

/** `shadowlap decisions`: its options, and what it does with them (decisionsAction). */
function registerDecisions(program: Command): void {
  program
    .command('decisions')
    .description("Preview what a change decides differently, without running the agent: ask each recorded model call again with only the change swapped in (--model, --set, or the prompt and tools your code sends now), and rank what changed by consequence, writes first. No tool runs.")
    .argument('[runs...]', 'runs (ids, unique prefixes, label:<name>) or goldens (pack folders, such as goldens/*); after "--", the command to run for --from-code and --then-verify')
    .option('--model <model>', "the change is this model, at the agent's model calls: those made with the model --from names, else the one the runs use most")
    .option('--from-code', 'the change is the system prompt and tools your working tree sends now, read by replaying each run offline; nothing is sent to read them')
    .option('--set <key=value>', 'the change sets this request field, e.g. temperature=0 (repeatable)', collect)
    .option('--from <model>', 'the recorded model the change switches from: --model and --set change only the calls made with it (repeatable; default: the model the runs use most)', collect)
    .option('--samples <n>', "ask each model call this many times under the change and, from 3 on, as many times as recorded, and rank a change only when it decides otherwise beyond the model's own variation: at 3, six requests a step", parseIntArg, DECISIONS_SAMPLES)
    .option('--concurrency <n>', 'requests in flight at once', parseIntArg, 4)
    .option('--scope <name>', "ask only the model calls made in this scope, such as the agent's and not a simulated user's; none for those made in no scope")
    .option('--then-verify', 'then run shadowlap verify on the runs a preview can\'t clear, rank 1 or 2 changes among them (a write, when the agent stops, or words a judge check reads otherwise), and only on those')
    .option('--verify <session>', "ask nothing: verify the runs a kept session could not clear (its dc-… or mg-… id), or the runs named, each under its checks (its golden's, or for a run named by id those of the recording it comes from), and keep what verify finds in the session")
    .option('--kept-max <n>', "with --verify: the most pairs a good run takes against its baseline, as for verify (default: verify.max in shadowlap.config.json, else 200, or a --gate max off its default)", parseIntArg)
    .option('--dry-run', "with --from-code alone: read what your working tree sends each run, offline, print it and stop: nothing is asked and no session is kept")
    .option('--expect <json|@file>', "with --then-verify or --verify: what a passing run must do besides exiting 0 (default: each run's checks from shadowlap.config.json, its golden's, or for a run named by id those of the recording it comes from)")
    .option('--gate <json|@file>', `with --then-verify or --verify: the gate each run is decided by, as for verify (default '{"good":${SPRT_DEFAULTS.good},"bad":${SPRT_DEFAULTS.bad},"risk":${SPRT_DEFAULTS.risk},"max":${SPRT_DEFAULTS.max}}', verify's)`)
    .option('--attempts <n>', 'with --then-verify or --verify: a fixed count instead of the gate: attempts per run (5 with --passes alone)', parseIntArg)
    .option('--passes <n>', 'with --then-verify or --verify and a fixed count: attempts that must pass (default: 80%, rounded up: 4 of 5)', parseIntArg)
    .option('--writes <policy>', 'with --then-verify or --verify: what write tools do after a fork: stub or block', parseChoice(['stub', 'block'] as const), 'stub')
    .option('--budget <usd>', 'send no request (and start no verify attempt) once this much is spent', parseUsd)
    .option('--timeout <seconds>', 'stop a model request, or a verify attempt, after this long', parseIntArg)
    .option('--strict', 'exit 1 when a run has a rank 1 or 2 change (for CI)')
    .option('--inconclusive <mode>', 'what an inconclusive result does to the exit status: fail (3) or warn (0, with a warning)', parseChoice(['fail', 'warn'] as const), 'fail')
    .option('--guard <mode>', 'with --then-verify or --verify: network guard for connections that bypass shadowlap: warn | block | off', parseChoice<GuardMode>(['warn', 'block', 'off']), 'warn')
    .option('-y, --yes', "run the recorded command of runs imported from someone's pack, and of goldens from packs this repository doesn't track, without asking")
    .option('--test-session <id>', "with --from-code: keep the preview with this test session, as its pull request comment's decisions (the GitHub Action's decisions: true)")
    .option('--json', 'print the report as JSON, as the dashboard reads it (progress still goes to stderr)')
    .action((given: string[], flags: DecisionsFlags) => decisionsAction(program, given, flags));
}

/** What every way of `decisions` reads from its flags: verify's rule, the checks, the command after `--`, the timeout. */
function verifySettings(program: Command, given: string[], flags: DecisionsFlags) {
  const { specs, argv } = splitCommand(program, given);
  // Verify's own rule: its gate, unless a fixed count is given.
  const rule = attemptRule(flags, { defaults: SPRT_DEFAULTS, passes: (n) => Math.ceil(0.8 * n) });
  const expect = flags.expect !== undefined ? readExpectJson(flags.expect) : null;
  const timeoutMs = flags.timeout === undefined ? null : flags.timeout * 1000;
  const thenVerify = { attempts: rule.attempts, needed: rule.needed, gate: rule.gate, writes: flags.writes, expect, keptMax: flags.keptMax ?? null };
  return { specs, argv, rule, expect, timeoutMs, thenVerify };
}

/** `decisions --verify <session> [runs…]`, `decisions <runs> --from-code --dry-run`, or `decisions <runs>` and the change. */
async function decisionsAction(program: Command, given: string[], flags: DecisionsFlags): Promise<void> {
  const opts = program.opts<GlobalOpts>();
  const v = verifySettings(program, given, flags);
  const log = (line: string) => process.stderr.write(`${line}\n`);
  const keepIn = testSessionFlag(flags);
  if (flags.verify !== undefined) return verifyAction(opts, flags, { specs: v.specs, settings: { thenVerify: v.thenVerify, argv: v.argv, timeoutMs: v.timeoutMs, guard: flags.guard }, log });
  if (!v.specs.length) throw new InvalidArgumentError('name the runs or goldens to ask again: shadowlap decisions goldens/* --model <model>');
  const { model, fields, from } = decisionsChange(flags);
  refuseAskFlags(flags, { model, fields });
  const store = openStore(opts);
  let targets: DecisionTarget[];
  try {
    targets = resolveTargets(store, v.specs, process.cwd());
    testSessionKnown(store, keepIn);
  } catch (err) {
    store.close();
    return failed(err, flags.json, 'decisions');
  }
  store.close();
  try {
    if (!(await consent(targets, v.argv, flags.yes, !!flags.fromCode || !!flags.thenVerify))) {
      process.exitCode = EXIT.usage;
      return;
    }
    if (flags.dryRun) return await dryRun(opts, targets, { argv: v.argv, timeoutMs: v.timeoutMs, scope: flags.scope ?? null }, flags, log);
    const settings = decisionsSettings(flags, { model, fields, from, timeoutMs: v.timeoutMs, argv: v.argv, thenVerify: flags.thenVerify ? v.thenVerify : null });
    const command = decisionsCommand(v.specs, settings, { concurrency: flags.concurrency, budget: flags.budget ?? null, timeoutMs: v.timeoutMs, expect: v.expect?.json ?? null, attempts: flags.attempts, passes: flags.passes, gate: v.rule.gate, writes: flags.writes, guard: flags.guard, inconclusive: flags.inconclusive });
    for (const line of askingLines(targets.length, settings)) log(line);
    const report = await runDecisions({ opts, targets, settings, command, log });
    keepDecisionsPart(opts, keepIn, report);
    if (flags.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else process.stdout.write('\n' + formatDecisions(report, p) + '\n' + (report.verify ? verifyLines(report.verify, null) : ''));
    emitPreview(report);
    emitJobEvent({ type: 'result', data: report as unknown as Record<string, unknown> });
    const rejected = report.verify?.verdict === 'rejected';
    process.exitCode = rejected || (flags.strict && report.flagged.length) ? EXIT.failed : inconclusiveExit(flags.inconclusive, decisionsInconclusive(report));
  } catch (err) {
    failed(err, flags.json, 'decisions');
  }
}

/** The flags a preview refuses: those for a verify it doesn't run, and `--dry-run` with anything but `--from-code`. */
function refuseAskFlags(flags: DecisionsFlags, change: Pick<DecisionsSettings, 'model' | 'fields'>): void {
  if (flags.keptMax !== undefined) throw new InvalidArgumentError('--kept-max is for --verify, which verifies the runs a kept session could not clear');
  if (flags.dryRun && (!flags.fromCode || change.model || Object.keys(change.fields).length || flags.thenVerify || flags.testSession !== undefined)) throw new InvalidArgumentError('--dry-run reads what --from-code reads, and stops there: give it with --from-code alone');
  if (flags.samples > 20) throw new InvalidArgumentError('--samples is at most 20');
  if (!flags.thenVerify && (flags.expect !== undefined || flags.gate !== undefined || flags.attempts !== undefined || flags.passes !== undefined)) throw new InvalidArgumentError('--expect, --gate, --attempts and --passes are for --then-verify, which verifies the runs a change flags');
}

/** What the preview says before it asks: the change, and how it asks. */
function askingLines(runs: number, s: DecisionsSettings): string[] {
  const fields = Object.entries(s.fields).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  const under = [s.fromCode ? 'the prompt and tools in your working tree' : '', s.model ? `the model ${s.model}` : '', fields.join(', ')].filter(Boolean).join(' and ');
  return [`${p.yellow('⑂')} Asking the model calls of ${runs} run${runs === 1 ? '' : 's'} again under ${under}`, p.dim(`  ${s.samples} sample${s.samples === 1 ? '' : 's'} per call, ${s.concurrency} at once · no tool runs${s.budget ? ` · budget $${s.budget.toFixed(2)}` : ''}`)];
}

/** The runs a kept session could not clear, verified: nothing is asked again. */
async function verifyAction(opts: GlobalOpts, flags: DecisionsFlags, input: { specs: string[]; settings: Parameters<typeof verifySession>[0]['settings']; log: (line: string) => void }): Promise<void> {
  if (flags.model || flags.fromCode || flags.set?.length || flags.from?.length || flags.thenVerify || flags.dryRun) throw new InvalidArgumentError('--verify verifies the change a kept session asked: give no other change with it');
  if (flags.keptMax !== undefined && (flags.keptMax < 1 || flags.keptMax > GATE_MAX_ATTEMPTS)) throw new InvalidArgumentError(`--kept-max is a whole number from 1 to ${GATE_MAX_ATTEMPTS}`);
  // As verify refuses it: a fixed count keeps no good run against its baseline.
  if (flags.keptMax !== undefined && (flags.attempts !== undefined || flags.passes !== undefined)) throw new InvalidArgumentError('a fixed count (--attempts, --passes) judges every run on its own: --kept-max is for the gate, which keeps a good run against its baseline');
  try {
    const out = await verifySession({ opts, sessionId: flags.verify!, runs: input.specs, settings: input.settings, budget: flags.budget ?? null, yes: !!flags.yes, log: input.log });
    if (flags.json) process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    else process.stdout.write(`\n${verifyLines(out.verify, `${out.sessionId}, ${out.change}`)}`);
    emitJobEvent({ type: 'result', data: out as unknown as Record<string, unknown> });
    const v = out.verify;
    // Nothing was asked again, so only verify's part of the engine's rule can leave it open.
    const why = decisionsUnsettled({ stopReason: null, flagged: [], runs: [], verify: v });
    process.exitCode = v.verdict === 'rejected' ? EXIT.failed : inconclusiveExit(flags.inconclusive, why);
  } catch (err) {
    failed(err, flags.json, 'decisions');
  }
}

/** `--dry-run`: what the working tree sends each run, read offline and printed; nothing asked, no session kept. */
async function dryRun(opts: GlobalOpts, targets: DecisionTarget[], settings: Parameters<typeof readDecisions>[0]['settings'], flags: DecisionsFlags, log: (line: string) => void): Promise<void> {
  log(`${p.yellow('⑂')} Reading what your working tree sends ${targets.length} run${targets.length === 1 ? '' : 's'}, offline: nothing is sent`);
  const read = await readDecisions({ opts, targets, settings, log });
  if (flags.json) process.stdout.write(JSON.stringify(read, null, 2) + '\n');
  else process.stdout.write('\n' + formatDecisionsRead(read));
  emitJobEvent({ type: 'result', data: read as unknown as Record<string, unknown> });
  process.exitCode = stoppedBy() ? interruptedStatus() : EXIT.ok;
}

export function register(program: Command): void {
  program.commandsGroup('Preview a change:');

  registerDecisions(program);
  registerMigrateApply(registerMigrate(program), program);
}

/** The flags of `shadowlap migrate`, as commander gives them. */
interface MigrateFlags {
  to?: string;
  from?: string[];
  scope?: string;
  set?: string[];
  samples: number;
  concurrency: number;
  expect?: string;
  gate?: string;
  attempts?: number;
  passes?: number;
  writes: 'stub' | 'block';
  budget?: number;
  timeout?: number;
  inconclusive: 'fail' | 'warn';
  guard: GuardMode;
  yes?: boolean;
  json?: boolean;
}

/** `shadowlap migrate`: its options, and what it does with them (migrateAction). `--to` is refused in the action, so `migrate apply` under it takes none. */
function registerMigrate(program: Command): Command {
  return program
    .command('migrate')
    .description("Switch models with the evidence: ask your goldens' model calls again under the new model (with the fields it refuses changed to what it takes), run end to end every run that can't clear, and compare what a run costs. Ends in one report, what changes, what still passes, what it costs and what to set, with the change to your files and a pull request body.")
    .argument('[goldens...]', 'goldens (pack folders) or runs to migrate (default: goldens/*); after "--", the command to verify with. Apply a migration\'s config change with shadowlap migrate apply <id>')
    .option('--to <model>', 'the model to switch to (required)')
    .option('--from <model>', 'the recorded model to switch from (repeatable; default: the models the runs use that retire, else the one they use most)', collect)
    .option('--scope <name>', "only the model calls made in this scope, such as the agent's; none for those made in no scope")
    .option('--set <key=value>', 'a request field the switch sets as well (repeatable)', collect)
    .option('--samples <n>', 'ask each model call this many times', parseIntArg, 1)
    .option('--concurrency <n>', 'requests in flight at once', parseIntArg, 4)
    .option('--expect <json|@file>', "what a passing run must do besides exiting 0 (default: each run's checks from shadowlap.config.json, its golden's, or for a run named by id those of the recording it comes from)")
    .option('--gate <json|@file>', `verify: the gate each run is decided by, as for verify (default '{"good":${SPRT_DEFAULTS.good},"bad":${SPRT_DEFAULTS.bad},"risk":${SPRT_DEFAULTS.risk},"max":${SPRT_DEFAULTS.max}}', verify's)`)
    .option('--attempts <n>', 'verify: a fixed count instead of the gate: attempts per run (5 with --passes alone)', parseIntArg)
    .option('--passes <n>', 'verify, with a fixed count: attempts that must pass (default: 80%, rounded up: 4 of 5)', parseIntArg)
    .option('--writes <policy>', 'verify: what write tools do after a fork: stub or block', parseChoice(['stub', 'block'] as const), 'stub')
    .option('--budget <usd>', 'send no request and start no attempt once this much is spent', parseUsd)
    .option('--timeout <seconds>', 'stop a model request, or a verify attempt, after this long', parseIntArg)
    .option('--inconclusive <mode>', 'what an inconclusive result does to the exit status: fail (3) or warn (0, with a warning)', parseChoice(['fail', 'warn'] as const), 'fail')
    .option('--guard <mode>', 'verify: network guard for connections that bypass shadowlap: warn | block | off', parseChoice<GuardMode>(['warn', 'block', 'off']), 'warn')
    .option('-y, --yes', "run the recorded command of runs imported from someone's pack, and of goldens from packs this repository doesn't track, without asking")
    .option('--json', 'print the report as JSON, as the dashboard reads it (progress still goes to stderr)')
    .action((given: string[], flags: MigrateFlags, cmd: Command) => migrateAction(program, given, flags, cmd));
}

/** `shadowlap migrate --to <model> [goldens…]`: the switch checked, its report printed and kept. */
async function migrateAction(program: Command, given: string[], { from = [], ...flags }: MigrateFlags, cmd: Command): Promise<void> {
  // Not commander's requiredOption: commander would ask it of `migrate apply` too, as a subcommand's parent's.
  if (flags.to === undefined) return cmd.error("error: required option '--to <model>' not specified");
  const to = flags.to;
  const opts = program.opts<GlobalOpts>();
  const split = splitCommand(program, given);
  const specs = split.specs.length ? split.specs : ['goldens/*'];
  const fields = parseFields(flags.set, undefined);
  if ('model' in fields) throw new InvalidArgumentError('--to is the model to switch to; --set model=… would set it twice');
  if (flags.samples > 20) throw new InvalidArgumentError('--samples is at most 20');
  const rule = attemptRule(flags, { defaults: SPRT_DEFAULTS, passes: (n) => Math.ceil(0.8 * n) });
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
    if (!(await consent(targets, split.argv, flags.yes, true, 'migrate'))) {
      process.exitCode = EXIT.usage;
      return;
    }
    const timeoutMs = flags.timeout === undefined ? null : flags.timeout * 1000;
    const command = quoteArgv([
      'shadowlap',
      'migrate',
      '--to',
      to,
      ...specs,
      ...from.flatMap((m) => ['--from', m]),
      ...(flags.scope ? ['--scope', flags.scope] : []),
      ...Object.entries(fields).flatMap(([k, v]) => ['--set', `${k}=${fieldValue(v)}`]),
      ...(flags.samples !== 1 ? ['--samples', String(flags.samples)] : []),
      ...(flags.concurrency !== 4 ? ['--concurrency', String(flags.concurrency)] : []),
      ...(expect ? ['--expect', JSON.stringify(expect.json)] : []),
      ...gateFlags(rule.gate, SPRT_DEFAULTS, { attempts: rule.attempts, passes: flags.passes }),
      ...(flags.writes === 'block' ? ['--writes', 'block'] : []),
      ...(flags.budget !== undefined ? ['--budget', String(flags.budget)] : []),
      ...(flags.timeout !== undefined ? ['--timeout', String(flags.timeout)] : []),
      ...(flags.inconclusive === 'warn' ? ['--inconclusive', 'warn'] : []),
      ...(flags.guard !== 'warn' ? ['--guard', flags.guard] : []),
      ...(split.argv ? ['--', ...split.argv] : []),
    ]);
    log(`${p.yellow('⑂')} Migrating ${targets.length} run${targets.length === 1 ? '' : 's'} to ${to}: the agent's model calls asked again, then the runs that can't clear verified end to end`);
    const report = await runMigrate({
      opts,
      targets,
      settings: { to, from: from.length ? from : null, scope: flags.scope ?? null, fields, samples: flags.samples, concurrency: flags.concurrency, budget: flags.budget ?? null, timeoutMs, attempts: rule.attempts, needed: rule.needed, gate: rule.gate, writes: flags.writes, expect, guard: flags.guard, argv: split.argv },
      command,
      log,
    });
    if (flags.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else process.stdout.write('\n' + formatMigrate(report) + '\n');
    emitMigrate(report);
    if (report.files) {
      emitJobEvent({ type: 'file', path: report.files.pullRequest, label: 'Pull request body' });
      if (report.files.patch) emitJobEvent({ type: 'file', path: report.files.patch, label: 'The config change' });
    }
    emitJobEvent({ type: 'result', data: report as unknown as Record<string, unknown> });
    process.exitCode = migrateExit(report, flags.inconclusive);
  } catch (err) {
    failed(err, flags.json, 'migrate');
  }
}

/** Where a migration's drawer goes next: the migration's report on Changes, then the runs with a write, stop or judged change. */
function emitMigrate(report: MigrateReport): void {
  if (!report.migrateId) return emitDecisions(report.decisions);
  emitJobEvent({ type: 'link', label: ACTIONS.openMigrationReport.label, href: links.changeSession('migrate', report.migrateId) });
  for (const runId of report.decisions.flagged.slice(0, 3)) emitJobEvent({ type: 'link', label: `Open ${runId.slice(0, 10)}`, href: links.run(runId), secondary: true });
}

/**
 * By the engine's rules, the ones the dashboard reads a kept migration by: 1 when the switch breaks a
 * run verify took (migrateBreaks); when the report settles nothing (migrateUnsettled: it stopped early,
 * verify didn't settle a run it took, a run is inconclusive), 3 with `--inconclusive fail` and 0 with
 * `warn`; else 0.
 */
export function migrateExit(r: MigrateReport, inconclusive: 'fail' | 'warn' = 'fail'): number {
  if (migrateBreaks(r.passes)) return EXIT.failed;
  return inconclusiveExit(inconclusive, migrateUnsettled(r));
}

/** What verify found for a preview's or a migration's runs, as `decisions` prints it: each rule once, then each run's outcome and its tally in verify's words. */
export function verifyLines(v: DecisionsVerify, what: string | null): string {
  if (v.verdict === 'not-run') return v.reasons.length ? `${p.yellow('!')} Not verified: ${v.reasons.join('; ')}\n${v.commands.map((c) => p.dim(`  ${c}`)).join('\n')}\n` : '';
  const head = v.verdict === 'accepted' ? `${p.green('✓')} Verified` : v.verdict === 'rejected' ? `${p.red('✗')} Verify rejected the change` : `${p.yellow('!')} Verify did not finish`;
  const lines = [``, `${head}: ${v.runs.length} run${v.runs.length === 1 ? '' : 's'} end to end${what ? ` (${what})` : ''}`];
  // Each rule once, then the outcome of each run it decided and its tally in verify's words, an attempt it could not judge said apart.
  for (const g of byRule(v.runs, (x) => x.rule, v.rule ?? null)) {
    if (g.rule) lines.push(p.dim(`  ${g.rule}`));
    for (const x of g.runs) lines.push(`  ${x.runId.slice(0, 10)}  ${x.outcome}  ${p.dim(verifyTallyLine(tallyParts(x)))}`);
  }
  // What the change failed in red; a run verify could not settle, inconclusive or not settled, in amber.
  for (const reason of v.reasons) lines.push(`  ${unsettledReason(reason) ? p.yellow('·') : p.red('·')} ${reason}`);
  for (const w of v.warnings ?? []) lines.push(`  ${p.yellow('!')} ${w}`);
  for (const c of v.commands) lines.push(p.dim(`  ${c}`));
  return lines.join('\n') + '\n';
}
