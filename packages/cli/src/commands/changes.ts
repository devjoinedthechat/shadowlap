import { resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { links } from '@shadowlap/dashboard';
import { byRule, commandIsImported, controlOpen, formatDecisions, hasRecordedCommand, judgeOpen, SPRT_DEFAULTS, unsettledReason, type DecisionsReport, type DecisionsVerify } from '@shadowlap/engine';
import { DECISIONS_SAMPLES, DecisionsError, commandProblem, decisionsCommand, resolveTargets, runDecisions, type DecisionsSettings, type DecisionTarget } from '../decisions.js';
import { verifySession } from '../decisions-verify.js';
import { goldenConsented } from '../golden-consent.js';
import { attemptRule, parseFields, readExpectJson } from './fix.js';
import { gateFlags } from '../fixes.js';
import { EXIT, inconclusiveStatus, interruptedStatus, stoppedBy } from '../exit-codes.js';
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

const repeat = (v: string, acc: string[]) => [...acc, v];

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
 * Why a decisions report settles nothing, or null: it stopped early, a run could not be asked, a run
 * it doesn't flag has a step that waits on a judge (judgeOpen: a text-only change a judge check reads
 * could not be judged, in any sample, and might be judged otherwise, which would flag it) or on its
 * control (controlOpen: a changed step the request as recorded got no answer for, for now), verify
 * didn't settle the runs it took.
 */
export function decisionsInconclusive(r: DecisionsReport): string | null {
  if (r.stopReason) return `it stopped before every step was asked: ${r.stopReason}`;
  // A run that could not be asked at all (a --from-code change that is more than a prompt, a model that refused every step) is no preview of it.
  const unasked = r.runs.filter((x) => x.refused || (x.steps > 0 && x.asked === 0 && x.counts.notAsked > 0));
  if (unasked.length) return `${unasked.length} run${unasked.length === 1 ? '' : 's'} could not be asked`;
  const unjudged = r.runs.filter((x) => !r.flagged.includes(x.runId) && x.decisions.some((s) => judgeOpen(s)));
  if (unjudged.length) return `${unjudged.length} run${unjudged.length === 1 ? ' has' : 's have'} a text-only change a judge check reads that could not be judged`;
  // A change the request as recorded got no answer to tell from the model's own variation (controlOpen) settles nothing.
  const unsettled = r.runs.filter((x) => !r.flagged.includes(x.runId) && x.decisions.some((s) => controlOpen(s)));
  if (unsettled.length) return `${unsettled.length} run${unsettled.length === 1 ? ' has' : 's have'} a changed step the request as recorded got no answer for, so it could not be told from the model's own variation`;
  if (r.verify?.verdict === 'incomplete') return 'verify did not settle every run it took';
  if (r.verify?.verdict === 'not-run' && r.verify.reasons.length) return `verify did not run: ${r.verify.reasons[0]!}`;
  return null;
}

export function register(program: Command): void {
  program.commandsGroup('Preview a change:');

  program
    .command('decisions')
    .description("Preview what a change decides differently, without running the agent: ask each recorded model call again with only the change swapped in (--model, --set, or the prompt and tools your code sends now), and rank what changed by consequence, writes first. No tool runs.")
    .argument('[runs...]', 'runs (ids, unique prefixes, label:<name>) or goldens (pack folders, such as goldens/*); after "--", the command to run for --from-code and --then-verify')
    .option('--model <model>', "the change is this model, at the agent's model calls: those made with the model --from names, else the one the runs use most")
    .option('--from-code', 'the change is the system prompt and tools your working tree sends now, read by replaying each run offline; nothing is sent to read them')
    .option('--set <key=value>', 'the change sets this request field, e.g. temperature=0 (repeatable)', repeat, [] as string[])
    .option('--from <model>', 'the recorded model the change switches from: --model and --set change only the calls made with it (repeatable; default: the model the runs use most)', repeat, [] as string[])
    .option('--samples <n>', "ask each model call this many times under the change and, from 3 on, as many times as recorded, and rank a change only when it decides otherwise beyond the model's own variation: at 3, six requests a step", parseIntArg, DECISIONS_SAMPLES)
    .option('--concurrency <n>', 'requests in flight at once', parseIntArg, 4)
    .option('--scope <name>', "ask only the model calls made in this scope, such as the agent's and not a simulated user's; none for those made in no scope")
    .option('--then-verify', 'then run shadowlap verify on the runs with a rank 1 or 2 change (a write, when the agent stops, or words a judge check reads otherwise), and only on those')
    .option('--verify <session>', "ask nothing: verify the runs a kept session flagged (its dc-… or mg-… id), or the runs named, each under its checks (its golden's, or for a run named by id those of the recording it comes from), and keep what verify finds in the session")
    .option('--expect <json|@file>', "with --then-verify or --verify: what a passing run must do besides exiting 0 (default: each run's checks from shadowlap.config.json, its golden's, or for a run named by id those of the recording it comes from)")
    .option('--gate <json|@file>', `with --then-verify or --verify: the gate each run is decided by, as for verify (default '{"good":${SPRT_DEFAULTS.good},"bad":${SPRT_DEFAULTS.bad},"risk":${SPRT_DEFAULTS.risk},"max":${SPRT_DEFAULTS.max}}', verify's)`)
    .option('--attempts <n>', 'with --then-verify or --verify: a fixed count instead of the gate: attempts per run (5 with --passes alone)', parseIntArg)
    .option('--passes <n>', 'with --then-verify or --verify and a fixed count: attempts that must pass (default: 80%, rounded up: 4 of 5)', parseIntArg)
    .option('--writes <policy>', 'with --then-verify or --verify: what write tools do after a fork: stub or block', parseChoice(['stub', 'block'] as const), 'stub')
    .option('--budget <usd>', 'send no request (and start no verify attempt) once this much is spent', parseUsd)
    .option('--timeout <seconds>', 'stop a model request, or a verify attempt, after this long', parseIntArg)
    .option('--strict', 'exit 1 when a run has a rank 1 or 2 change (for CI)')
    .option('--inconclusive <mode>', 'what an inconclusive result does to the exit status: fail (1) or warn (0, with a warning)', parseChoice(['fail', 'warn'] as const), 'fail')
    .option('--guard <mode>', 'with --then-verify or --verify: network guard for connections that bypass Shadowlap: warn | block | off', parseChoice<GuardMode>(['warn', 'block', 'off']), 'warn')
    .option('-y, --yes', "run the recorded command of runs imported from someone's pack, and of goldens from packs this repository doesn't track, without asking")
    .option('--json', 'print the report as JSON, as the dashboard reads it (progress still goes to stderr)')
    .action(async (given: string[], flags: { model?: string; fromCode?: boolean; set: string[]; from: string[]; samples: number; concurrency: number; scope?: string; thenVerify?: boolean; verify?: string; expect?: string; gate?: string; attempts?: number; passes?: number; writes: 'stub' | 'block'; budget?: number; timeout?: number; strict?: boolean; inconclusive: 'fail' | 'warn'; guard: GuardMode; yes?: boolean; json?: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      const { specs, argv } = splitCommand(program, given);
      // Verify's own rule: its gate, unless a fixed count is given.
      const rule = attemptRule(flags, { defaults: SPRT_DEFAULTS, passes: (n) => Math.ceil(0.8 * n) });
      const expect = flags.expect !== undefined ? readExpectJson(flags.expect) : null;
      const log = (line: string) => process.stderr.write(`${line}\n`);
      const timeoutMs = flags.timeout === undefined ? null : flags.timeout * 1000;
      const thenVerify = { attempts: rule.attempts, needed: rule.needed, gate: rule.gate, writes: flags.writes, expect };

      if (flags.verify !== undefined) {
        // A kept session's flagged runs, verified: nothing is asked again.
        if (flags.model || flags.fromCode || flags.set.length || flags.from.length || flags.thenVerify) throw new InvalidArgumentError('--verify verifies the change a kept session asked: give no other change with it');
        try {
          const out = await verifySession({ opts, sessionId: flags.verify, runs: specs, settings: { thenVerify, argv, timeoutMs, guard: flags.guard }, budget: flags.budget ?? null, yes: !!flags.yes, log });
          if (flags.json) process.stdout.write(JSON.stringify(out, null, 2) + '\n');
          else process.stdout.write(`\n${verifyLines(out.verify, `${out.sessionId}, ${out.change}`)}`);
          emitJobEvent({ type: 'result', data: out as unknown as Record<string, unknown> });
          const v = out.verify;
          const why = v.verdict === 'incomplete' ? 'verify did not settle every run it took' : v.verdict === 'not-run' && v.reasons.length ? `verify did not run: ${v.reasons[0]!}` : null;
          process.exitCode = v.verdict === 'rejected' ? EXIT.failed : inconclusiveExit(flags.inconclusive, why);
        } catch (err) {
          failed(err, flags.json, 'decisions');
        }
        return;
      }

      if (!specs.length) throw new InvalidArgumentError('name the runs or goldens to ask again: shadowlap decisions goldens/* --model <model>');
      // `--set model=…` is the model, as verify and blame read it; both at once is refused there.
      const { model: setModel, ...fields } = parseFields(flags.set, flags.model);
      const model = typeof setModel === 'string' ? setModel : null;
      if (!model && !flags.fromCode && !Object.keys(fields).length) throw new InvalidArgumentError('give the change: --model <model>, --set <key=value>, or --from-code for the prompt and tools in your working tree');
      if (flags.from.length && !model && !Object.keys(fields).length) throw new InvalidArgumentError('--from names the model calls --model and --set change: give one of them');
      if (flags.samples > 20) throw new InvalidArgumentError('--samples is at most 20');
      if (!flags.thenVerify && (flags.expect !== undefined || flags.gate !== undefined || flags.attempts !== undefined || flags.passes !== undefined)) throw new InvalidArgumentError('--expect, --gate, --attempts and --passes are for --then-verify, which verifies the runs a change flags');
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
          process.exitCode = EXIT.usage;
          return;
        }
        const settings: DecisionsSettings = {
          model,
          fields,
          from: flags.from.length ? flags.from : null,
          fromCode: !!flags.fromCode,
          samples: flags.samples,
          concurrency: flags.concurrency,
          budget: flags.budget ?? null,
          timeoutMs,
          scope: flags.scope ?? null,
          remedies: false,
          guard: flags.guard,
          argv,
          thenVerify: flags.thenVerify ? thenVerify : null,
        };
        const command = decisionsCommand(specs, settings, { concurrency: flags.concurrency, budget: flags.budget ?? null, timeoutMs, expect: expect?.json ?? null, attempts: flags.attempts, passes: flags.passes, gate: rule.gate, writes: flags.writes, guard: flags.guard, inconclusive: flags.inconclusive });
        log(`${p.yellow('⑂')} Asking the model calls of ${targets.length} run${targets.length === 1 ? '' : 's'} again under ${[flags.fromCode ? 'the prompt and tools in your working tree' : '', model ? `the model ${model}` : '', Object.keys(fields).length ? Object.entries(fields).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ') : ''].filter(Boolean).join(' and ')}`);
        log(p.dim(`  ${flags.samples} sample${flags.samples === 1 ? '' : 's'} per call, ${flags.concurrency} at once · no tool runs${flags.budget ? ` · budget $${flags.budget.toFixed(2)}` : ''}`));
        const report = await runDecisions({ opts, targets, settings, command, log });
        if (flags.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        else process.stdout.write('\n' + formatDecisions(report, p) + '\n' + (report.verify ? verifyLines(report.verify, null) : ''));
        emitDecisions(report);
        emitJobEvent({ type: 'result', data: report as unknown as Record<string, unknown> });
        const rejected = report.verify?.verdict === 'rejected';
        process.exitCode = rejected || (flags.strict && report.flagged.length) ? EXIT.failed : inconclusiveExit(flags.inconclusive, decisionsInconclusive(report));
      } catch (err) {
        failed(err, flags.json, 'decisions');
      }
    });

  program
    .command('migrate')
    .description("Switch models with the evidence: ask your goldens' model calls again under the new model (with the fields it refuses changed to what it takes), verify the runs with a write, stop or judged change, and compare what a run costs. Ends in one report, what changes, what still passes, what it costs and what to set, with the change to your files and a pull request body.")
    .argument('[goldens...]', 'goldens (pack folders) or runs to migrate (default: goldens/*); after "--", the command to verify with')
    .requiredOption('--to <model>', 'the model to switch to')
    .option('--from <model>', 'the recorded model to switch from (repeatable; default: the models the runs use that retire, else the one they use most)', repeat, [] as string[])
    .option('--scope <name>', "only the model calls made in this scope, such as the agent's; none for those made in no scope")
    .option('--set <key=value>', 'a request field the switch sets as well (repeatable)', repeat, [] as string[])
    .option('--samples <n>', 'ask each model call this many times', parseIntArg, 1)
    .option('--concurrency <n>', 'requests in flight at once', parseIntArg, 4)
    .option('--expect <json|@file>', "what a passing run must do besides exiting 0 (default: each run's checks from shadowlap.config.json, its golden's, or for a run named by id those of the recording it comes from)")
    .option('--gate <json|@file>', `verify: the gate each run is decided by, as for verify (default '{"good":${SPRT_DEFAULTS.good},"bad":${SPRT_DEFAULTS.bad},"risk":${SPRT_DEFAULTS.risk},"max":${SPRT_DEFAULTS.max}}', verify's)`)
    .option('--attempts <n>', 'verify: a fixed count instead of the gate: attempts per run (5 with --passes alone)', parseIntArg)
    .option('--passes <n>', 'verify, with a fixed count: attempts that must pass (default: 80%, rounded up: 4 of 5)', parseIntArg)
    .option('--writes <policy>', 'verify: what write tools do after a fork: stub or block', parseChoice(['stub', 'block'] as const), 'stub')
    .option('--budget <usd>', 'send no request and start no attempt once this much is spent', parseUsd)
    .option('--timeout <seconds>', 'stop a model request, or a verify attempt, after this long', parseIntArg)
    .option('--inconclusive <mode>', 'what an inconclusive result does to the exit status: fail (1) or warn (0, with a warning)', parseChoice(['fail', 'warn'] as const), 'fail')
    .option('--guard <mode>', 'verify: network guard for connections that bypass Shadowlap: warn | block | off', parseChoice<GuardMode>(['warn', 'block', 'off']), 'warn')
    .option('-y, --yes', "run the recorded command of runs imported from someone's pack, and of goldens from packs this repository doesn't track, without asking")
    .option('--json', 'print the report as JSON, as the dashboard reads it (progress still goes to stderr)')
    .action(async (given: string[], flags: { to: string; from: string[]; scope?: string; set: string[]; samples: number; concurrency: number; expect?: string; gate?: string; attempts?: number; passes?: number; writes: 'stub' | 'block'; budget?: number; timeout?: number; inconclusive: 'fail' | 'warn'; guard: GuardMode; yes?: boolean; json?: boolean }) => {
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
          flags.to,
          ...specs,
          ...flags.from.flatMap((m) => ['--from', m]),
          ...(flags.scope ? ['--scope', flags.scope] : []),
          ...Object.entries(fields).flatMap(([k, v]) => ['--set', `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`]),
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
        log(`${p.yellow('⑂')} Migrating ${targets.length} run${targets.length === 1 ? '' : 's'} to ${flags.to}: the agent's model calls asked again, then the runs with a write, stop or judged change verified`);
        const report = await runMigrate({
          opts,
          targets,
          settings: { to: flags.to, from: flags.from.length ? flags.from : null, scope: flags.scope ?? null, fields, samples: flags.samples, concurrency: flags.concurrency, budget: flags.budget ?? null, timeoutMs, attempts: rule.attempts, needed: rule.needed, gate: rule.gate, writes: flags.writes, expect, guard: flags.guard, argv: split.argv },
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
        process.exitCode = migrateExit(report, flags.inconclusive);
      } catch (err) {
        failed(err, flags.json, 'migrate');
      }
    });
}

/**
 * 1 when a run verify took breaks under the new model; when the report settles nothing (it stopped
 * early, a step got no answer, a flagged run went unverified, a text-only change a judge check reads
 * could not be judged), 3 with `--inconclusive fail` and 0 with `warn`; else 0.
 */
export function migrateExit(r: MigrateReport, inconclusive: 'fail' | 'warn' = 'fail'): number {
  if (r.passes.verdict === 'rejected' || r.passes.runs.some((x) => x.verified && x.verdict === 'failed')) return EXIT.failed;
  const open = r.passes.runs.filter((x) => x.verdict === 'inconclusive').length;
  const unsettled = r.stopReason ? `it stopped before every step was asked: ${r.stopReason}` : r.passes.verdict === 'incomplete' ? 'verify did not settle every run it took' : open ? `${open} run${open === 1 ? ' is' : 's are'} inconclusive` : null;
  return inconclusiveExit(inconclusive, unsettled);
}

function verifyLines(v: DecisionsVerify, what: string | null): string {
  if (v.verdict === 'not-run') return v.reasons.length ? `${p.yellow('!')} Not verified: ${v.reasons.join('; ')}\n${v.commands.map((c) => p.dim(`  ${c}`)).join('\n')}\n` : '';
  const head = v.verdict === 'accepted' ? `${p.green('✓')} Verified` : v.verdict === 'rejected' ? `${p.red('✗')} Verify rejected the change` : `${p.yellow('!')} Verify did not finish`;
  const lines = [``, `${head}: ${v.runs.length} run${v.runs.length === 1 ? '' : 's'} with a write, stop or judged change${what ? ` (${what})` : ''}`];
  // The last attempt of a run it could not judge stopped it: neither passed nor failed, so said apart.
  const tally = (x: DecisionsVerify['runs'][number]) => (x.undecided ? `${x.attempts > 1 ? `${x.passes} of ${x.attempts - 1} passed, ` : ''}attempt ${x.attempts} not judged` : `${x.passes} of ${x.attempts} passed${x.baseline ? `, baseline ${x.baseline.passes} of ${x.baseline.attempts}` : ''}`);
  // Each rule once, then the outcome of each run it decided, its tally and under a gate the Wilson bound.
  for (const g of byRule(v.runs, (x) => x.rule, v.rule ?? null)) {
    if (g.rule) lines.push(p.dim(`  ${g.rule}`));
    for (const x of g.runs) lines.push(`  ${x.runId.slice(0, 10)}  ${x.outcome}  ${p.dim(`${tally(x)}${x.bound ? ` · ${x.bound}` : ''}`)}`);
  }
  // What the change failed in red; a run verify could not settle, inconclusive or not settled, in amber.
  for (const reason of v.reasons) lines.push(`  ${unsettledReason(reason) ? p.yellow('·') : p.red('·')} ${reason}`);
  for (const c of v.commands) lines.push(p.dim(`  ${c}`));
  return lines.join('\n') + '\n';
}
