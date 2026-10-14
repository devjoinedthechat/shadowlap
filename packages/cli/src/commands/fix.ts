import { readFileSync } from 'node:fs';
import { Command, InvalidArgumentError } from 'commander';
import { commandIsImported, describeRescue, formatBlame, formatRepair, formatVerify, hasRecordedCommand, maxProbes, outcomeOf, type BlameReport, type ReadPolicy, type RunRecord, type Store, type VerifyReport, type VerifyRole } from '@shadowlap/engine';
import { formatBudget } from '../attempts.js';
import { BlameError, inScope, runBlame } from '../blame.js';
import { parseExpect } from '../checks.js';
import { type GuardMode } from '../run-agent.js';
import { confirmImportedCommand, openStore, parseChoice, parseIntArg, requireRun, type GlobalOpts } from '../shared.js';
import { palette as p, quoteArgv, safe, shortId } from '../ui.js';
import { runVerify } from '../verify.js';
import { handOver, RepairError, runRepair, splitHoldout } from '../repair.js';
import { parseRepairer, type Repairer } from '../repairer.js';
import { loadConfig } from '../config.js';

/** Finding where a failed run went wrong (blame), and checking that a change fixes it (verify). */

function parseCount(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError('must be a whole number, 0 or more');
  return n;
}

function parseUsd(value: string): number {
  const n = Number(value.replace(/^\$/, ''));
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('must be an amount in USD, such as 0.50');
  return n;
}

/** `--set temperature=1`: a request field for the probed call on; the value is JSON or a string. */
export function parseFields(specs: string[], model: string | undefined): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const spec of specs) {
    const m = /^([A-Za-z_][\w.]*)=([\s\S]*)$/.exec(spec);
    if (!m) throw new InvalidArgumentError(`--set expects <key>=<value>, such as temperature=1, got "${spec}"`);
    let value: unknown = m[2]!;
    try {
      value = JSON.parse(m[2]!);
    } catch {
      // a bare string
    }
    fields[m[1]!] = value;
  }
  if (model !== undefined) {
    if ('model' in fields) throw new InvalidArgumentError('--model and --set model=… both set the model; use one');
    fields.model = model;
  }
  return fields;
}

export function readExpect(raw: string): ReturnType<typeof parseExpect> {
  let text = raw;
  if (raw.startsWith('@')) {
    try {
      text = readFileSync(raw.slice(1), 'utf8');
    } catch (err) {
      throw new InvalidArgumentError(`--expect: cannot read ${raw.slice(1)}: ${(err as Error).message}`);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InvalidArgumentError(`--expect takes JSON or @file.json, such as '{"tools":{"send_email":0}}'`);
  }
  return parseExpect(parsed, '--expect');
}

/** The report as `--json` prints it: stable field names for scripts and coding agents. */
export function blameJson(r: BlameReport): Record<string, unknown> {
  const probe = (x: NonNullable<BlameReport['blamed']>) => ({ callNo: x.callNo, step: x.step, passes: x.passes, attempts: x.attempts.length });
  return {
    runId: r.runId,
    outcome: r.outcome,
    confidence: r.confidence,
    blamed: r.blamed ? probe(r.blamed) : null,
    lost: r.lost ? probe(r.lost) : null,
    modelCalls: r.steps,
    attemptsPerProbe: r.attemptsPerProbe,
    passesNeeded: r.needed,
    rescue: r.rescue,
    oracle: r.oracle,
    recordedFailures: r.recordedFailures,
    contrast: r.contrast,
    probes: r.probes.map((x) => ({ ...probe(x), rescued: x.rescued, runs: x.attempts })),
    nonMonotone: r.nonMonotone,
    cost: { attempts: r.attempts, spent: r.spent, upstreamRequests: r.upstreamRequests, unknownModels: r.unknownModels },
    stopReason: r.stopReason,
    warnings: r.warnings,
  };
}

/**
 * The runs `--fixes`, `--holdout` and `--keeps` name: run ids or unique prefixes, and `label:<name>`
 * for every run with that label.
 */
export function selectRuns(store: Store, specs: readonly string[], flag: string): RunRecord[] {
  const out: RunRecord[] = [];
  for (const spec of specs) {
    if (spec.startsWith('label:')) {
      const label = spec.slice('label:'.length);
      const labelled = store.allRuns().filter((r) => r.meta?.labels?.includes(label));
      if (!labelled.length) throw new InvalidArgumentError(`${flag} ${spec}: no run has the label "${label}" (see shadowlap ls --label ${label})`);
      out.push(...labelled);
    } else {
      out.push(requireRun(store, spec));
    }
  }
  return out;
}

/** The report as `verify --json` prints it. */
export function verifyJson(r: VerifyReport): Record<string, unknown> {
  const count = (role: VerifyRole) => {
    const of = r.runs.filter((x) => x.role === role);
    return { passed: of.filter((x) => x.verdict === 'pass').length, total: of.length };
  };
  return {
    verdict: r.verdict,
    reasons: r.reasons,
    warnings: [...r.warnings, ...r.replayWarnings],
    codeVersion: r.codeVersion,
    oracle: r.oracle,
    attemptsPerRun: r.attemptsPerRun,
    passesNeeded: r.needed,
    change: { fields: r.fields },
    summary: { targets: count('target'), holdout: count('holdout'), good: count('good') },
    runs: r.runs.map((x) => ({ runId: x.runId, role: x.role, outcome: outcomeOf(x).replace(' ', '-'), passes: x.passes, attempts: x.attempts.length, deterministic: x.deterministic, recorded: x.recorded, runs: x.attempts })),
    cost: { attempts: r.attempts, spent: r.spent, upstreamRequests: r.upstreamRequests, unknownModels: r.unknownModels },
    stopReason: r.stopReason,
  };
}

function parsePercent(value: string): number {
  const n = Number(value.replace(/%$/, ''));
  if (!Number.isFinite(n) || n < 0) throw new InvalidArgumentError('must be a percentage, such as 25');
  return n / 100;
}

/** Runs to replay under their own recorded commands, or under the one after `--`; imported commands need consent. */
async function targetsOf(runs: RunRecord[], command: string[], yes: boolean | undefined, verb: string): Promise<Array<{ parent: RunRecord; argv: string[]; commandFromImport: boolean }> | null> {
  const out: Array<{ parent: RunRecord; argv: string[]; commandFromImport: boolean }> = [];
  for (const run of runs) {
    if (!command.length && !hasRecordedCommand(run)) {
      throw new InvalidArgumentError(`${shortId(run.runId)} was imported from a capture and has no command to re-run. Give yours after --:\n  shadowlap ${verb} … -- python agent.py`);
    }
    const argv = command.length ? command : run.command.argv;
    const commandFromImport = !command.length && commandIsImported(run);
    if (commandFromImport && !yes && !(await confirmImportedCommand(run.runId, argv))) return null;
    out.push({ parent: run, argv, commandFromImport });
  }
  return out;
}

export function register(program: Command): void {
  program.commandsGroup('Find and fix:');

  program
    .command('blame')
    .description('Find the model call where a failed run was lost: the last one whose answer, asked again, lets the run pass. Probes it with forks that replay everything before it for free.')
    .argument('<run>', 'the failed run: id or unique prefix')
    .argument('[command...]', 'override the recorded command (after "--")')
    .option('--expect <json|@file>', 'what a passing run must do besides exiting 0, as under "expect" in shadowlap.config.json tests: \'{"tools":{"send_email":0}}\'')
    .option('--attempts <n>', 'attempts per probed model call', parseIntArg, 5)
    .option('--passes <n>', 'passing attempts that make a probe a rescue (default: 2, or 1 with one attempt)', parseIntArg)
    .option('--model <model>', 'rescue with this model from the probed call on, instead of asking the recorded one again')
    .option('--set <key=value>', 'set a request field from the probed call on, e.g. temperature=1 (repeatable)', (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option('--scope <name>', 'probe only model calls made in this scope, such as the agent\'s and not a simulated user\'s (see scope() in the SDKs)')
    .option('--scan <n>', 'model calls past the boundary to probe as well, in case rescue works again after it', parseCount, 2)
    .option('--writes <policy>', 'what write tools do after the fork: stub (the agent carries on as if the write succeeded) or block', parseChoice(['stub', 'block'] as const), 'stub')
    .option('--reads <policy>', 'what read tools do after the fork: live | replay', parseChoice<ReadPolicy>(['live', 'replay']), 'live')
    .option('--concurrency <n>', 'attempts of one probe running at once', parseIntArg, 1)
    .option('--budget <usd>', 'start no attempt once this much is spent on live model calls', parseUsd)
    .option('--timeout <seconds>', 'stop an attempt after this long and count it as failed', parseIntArg)
    .option('--guard <mode>', 'network guard for connections that bypass Shadowlap: warn | block | off', parseChoice<GuardMode>(['warn', 'block', 'off']), 'warn')
    .option('-y, --yes', 'run the recorded command of an imported run without asking')
    .option('--json', 'print the report as JSON (progress still goes to stderr)')
    .action(async (runArg: string, command: string[], flags: { expect?: string; attempts: number; passes?: number; model?: string; set: string[]; scope?: string; scan: number; writes: 'stub' | 'block'; reads: ReadPolicy; concurrency: number; budget?: number; timeout?: number; guard: GuardMode; yes?: boolean; json?: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      if (flags.attempts > 100) throw new InvalidArgumentError('--attempts is at most 100');
      const passes = flags.passes ?? Math.min(2, flags.attempts);
      if (passes > flags.attempts) throw new InvalidArgumentError(`--passes (${passes}) can't be more than --attempts (${flags.attempts})`);
      const spec = flags.expect !== undefined ? readExpect(flags.expect) : null;
      const fields = parseFields(flags.set, flags.model);

      const store = openStore(opts);
      const parent = requireRun(store, runArg);
      const steps = store.getCalls(parent.runId).filter((c) => c.kind === 'api' && c.end && inScope(c.meta.scope, flags.scope)).length;
      store.close();
      if (!command.length && !hasRecordedCommand(parent)) {
        throw new InvalidArgumentError(`${shortId(parent.runId)} was imported from a capture and has no command to re-run. Give yours after --:\n  shadowlap blame ${shortId(parent.runId)} -- python agent.py`);
      }
      const argv = command.length ? command : parent.command.argv;
      const commandFromImport = !command.length && commandIsImported(parent);
      if (commandFromImport && !flags.yes && !(await confirmImportedCommand(parent.runId, argv))) {
        process.exitCode = 1;
        return;
      }

      const log = (line: string) => process.stderr.write(`${line}\n`);
      const most = maxProbes(steps, flags.scan);
      log(`${p.yellow('⑂')} Blaming ${shortId(parent.runId)} ${p.dim(`(${safe(quoteArgv(argv))})`)}: ${steps} model call${steps === 1 ? '' : 's'}${flags.scope ? ` in scope ${safe(flags.scope)}` : ''}`);
      log(
        p.dim(
          `  each probe: ${describeRescue(fields)}, ${flags.attempts} attempts, a rescue at ${passes} passing · writes ${flags.writes === 'stub' ? 'stubbed' : 'blocked'}${flags.budget ? ` · budget ${formatBudget(flags.budget)}` : ''}\n  at most ${most} probe${most === 1 ? '' : 's'} and ${most * flags.attempts} attempts; every call before a probe replays from the recording for free`,
        ),
      );

      try {
        const report = await runBlame({
          opts,
          parent,
          argv,
          commandFromImport,
          settings: { attempts: flags.attempts, needed: passes, concurrency: flags.concurrency, scan: flags.scan, scope: flags.scope ?? null, writes: flags.writes, reads: flags.reads, liveTools: [], fields, spec, budget: flags.budget ?? null, timeoutMs: flags.timeout === undefined ? null : flags.timeout * 1000, guard: flags.guard },
          log,
        });
        if (flags.json) process.stdout.write(JSON.stringify(blameJson(report), null, 2) + '\n');
        else process.stdout.write('\n' + formatBlame(report, p) + '\n');
        process.exitCode = report.outcome === 'stopped' ? 1 : 0;
      } catch (err) {
        if (!(err instanceof BlameError)) throw err;
        if (flags.json) process.stdout.write(JSON.stringify({ runId: parent.runId, outcome: 'error', error: { reason: err.reason, message: err.message } }, null, 2) + '\n');
        else process.stderr.write(`\n${p.red('✗')} ${err.message}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command('verify')
    .description('Check a change before it ships: replay failing runs, which it must now fix, and good runs, which it must not break, under the code as it is now. Exits 1 unless the change is accepted.')
    .argument('[command...]', 'run this command instead of each run\'s recorded one (after "--")')
    .option('--fixes <run...>', 'failing runs the change was written to fix: run ids, or label:<name>')
    .option('--holdout <run...>', 'failing runs of the same kind that the change was not written against')
    .option('--keeps <run...>', 'passing runs the change must not break, e.g. label:good')
    .option('--expect <json|@file>', 'what a passing run must do besides exiting 0, as under "expect" in shadowlap.config.json tests')
    .option('--attempts <n>', 'attempts per run, where the replay forks', parseIntArg, 5)
    .option('--passes <n>', 'attempts that must pass for a run to pass (default: 80%, rounded up: 4 of 5)', parseIntArg)
    .option('--model <model>', 'the change is this model, from each run\'s first model call')
    .option('--set <key=value>', 'the change sets this request field from each run\'s first model call (repeatable)', (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option('--live-tool <name>', 'the change is in this tool: run its first call live instead of from the recording (repeatable)', (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option('--writes <policy>', 'what write tools do after a fork: stub (the agent carries on as if the write succeeded) or block', parseChoice(['stub', 'block'] as const), 'stub')
    .option('--reads <policy>', 'what read tools do after a fork: live | replay', parseChoice<ReadPolicy>(['live', 'replay']), 'live')
    .option('--concurrency <n>', 'runs verified at once', parseIntArg, 1)
    .option('--budget <usd>', 'start no attempt once this much is spent on live model calls', parseUsd)
    .option('--timeout <seconds>', 'stop an attempt after this long and count it as failed', parseIntArg)
    .option('--fail-fast', 'start nothing new once a run has failed')
    .option('--guard <mode>', 'network guard for connections that bypass Shadowlap: warn | block | off', parseChoice<GuardMode>(['warn', 'block', 'off']), 'warn')
    .option('-y, --yes', 'run the recorded command of imported runs without asking')
    .option('--json', 'print the report as JSON (progress still goes to stderr)')
    .action(async (command: string[], flags: { fixes?: string[]; holdout?: string[]; keeps?: string[]; expect?: string; attempts: number; passes?: number; model?: string; set: string[]; liveTool: string[]; writes: 'stub' | 'block'; reads: ReadPolicy; concurrency: number; budget?: number; timeout?: number; failFast?: boolean; guard: GuardMode; yes?: boolean; json?: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      if (flags.attempts > 100) throw new InvalidArgumentError('--attempts is at most 100');
      const passes = flags.passes ?? Math.ceil(0.8 * flags.attempts);
      if (passes > flags.attempts) throw new InvalidArgumentError(`--passes (${passes}) can't be more than --attempts (${flags.attempts})`);
      const spec = flags.expect !== undefined ? readExpect(flags.expect) : null;
      const fields = parseFields(flags.set, flags.model);

      const store = openStore(opts);
      const roles: Array<[VerifyRole, string, string[] | undefined]> = [
        ['target', '--fixes', flags.fixes],
        ['holdout', '--holdout', flags.holdout],
        ['good', '--keeps', flags.keeps],
      ];
      const chosen = new Map<string, { run: RunRecord; role: VerifyRole; flag: string }>();
      try {
        for (const [role, flag, specs] of roles) {
          for (const run of selectRuns(store, specs ?? [], flag)) {
            const seen = chosen.get(run.runId);
            if (seen && seen.role !== role) throw new InvalidArgumentError(`${shortId(run.runId)} is given to both ${seen.flag} and ${flag}; a run has one role`);
            chosen.set(run.runId, { run, role, flag });
          }
        }
      } finally {
        store.close();
      }
      if (!chosen.size) throw new InvalidArgumentError('give the runs to verify: --fixes <runs> for failing runs the change fixes, --keeps label:good for runs it must not break');

      const resolved = await targetsOf([...chosen.values()].map((x) => x.run), command, flags.yes, 'verify');
      if (!resolved) {
        process.exitCode = 1;
        return;
      }
      const runs: Parameters<typeof runVerify>[0]['runs'] = resolved.map((t) => ({ ...t, role: chosen.get(t.parent.runId)!.role }));

      const log = (line: string) => process.stderr.write(`${line}\n`);
      const n = (role: VerifyRole) => runs.filter((r) => r.role === role).length;
      const counts = [n('target') ? `${n('target')} to fix` : '', n('holdout') ? `${n('holdout')} held out` : '', n('good') ? `${n('good')} to keep` : ''].filter(Boolean).join(', ');
      log(`${p.yellow('⑂')} Verifying the code as it is now against ${runs.length} run${runs.length === 1 ? '' : 's'} (${counts})`);
      log(p.dim(`  a run passes at ${passes} of ${flags.attempts} attempts; one that replays clean is settled by its first · writes ${flags.writes === 'stub' ? 'stubbed' : 'blocked'}${flags.budget ? ` · budget ${formatBudget(flags.budget)}` : ''}`));

      const report = await runVerify({
        opts,
        runs,
        settings: { attempts: flags.attempts, needed: passes, concurrency: flags.concurrency, fields, failFast: !!flags.failFast, spec, writes: flags.writes, reads: flags.reads, liveTools: flags.liveTool, budget: flags.budget ?? null, timeoutMs: flags.timeout === undefined ? null : flags.timeout * 1000, guard: flags.guard },
        log,
      });
      if (flags.json) process.stdout.write(JSON.stringify(verifyJson(report), null, 2) + '\n');
      else process.stdout.write('\n' + formatVerify(report, p) + '\n');
      process.exitCode = report.verdict === 'accepted' ? 0 : 1;
    });

  program
    .command('repair')
    .description('Fix failing runs: find where each was lost, ask a model you choose to rewrite the prompt or tool descriptions, and keep the smallest fix shadowlap verify accepts. Writes a patch; --apply, --branch and --pr hand it over.')
    .argument('[command...]', 'run this command instead of each run\'s recorded one (after "--")')
    .option('--fixes <run...>', 'the failing runs to repair: run ids, or label:<name>')
    .option('--holdout <run...>', 'failing runs of the same kind to keep from the repairer (default: every other --fixes run, when there are two or more)')
    .option('--keeps <run...>', 'runs that pass and must keep passing, e.g. label:good')
    .option('--expect <json|@file>', 'what a passing run must do besides exiting 0, as under "expect" in shadowlap.config.json tests')
    .option('--repairer <provider:model>', 'the model that proposes fixes: anthropic (claude-opus-5-5), anthropic:<model>, openai:<model>, or claude-code[:<model>] to run your own Claude Code (default: repair.repairer in shadowlap.config.json)')
    .option('--candidates <n>', 'fixes to ask the repairer for', parseIntArg, 3)
    .option('--stronger <model>', 'when asking the recorded model again rescues nothing, rescue with this one, and try switching to it')
    .option('--scope <name>', 'blame only model calls made in this scope, such as the agent\'s and not a simulated user\'s')
    .option('--set <key=value>', 'blame\'s probes set this request field from the probed call on, e.g. temperature=1 for an agent recorded at 0 (repeatable)', (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option('--attempts <n>', 'the gate: attempts per run, where the replay forks', parseIntArg, 5)
    .option('--passes <n>', 'the gate: attempts that must pass (default: 80%, rounded up)', parseIntArg)
    .option('--max-growth <percent>', 'reject a fix that grows the input tokens per run by more than this', parsePercent, 0.25)
    .option('--build <command>', 'rebuild the agent after its source changes, e.g. "npm run build"')
    .option('--apply', 'leave the accepted fix in the working tree')
    .option('--branch <name>', 'commit the accepted fix to a new branch, without checking it out')
    .option('--pr', 'with --branch: push it and open a pull request with gh')
    .option('--goldens <dir>', 'with --apply or --branch: also put recordings of the fixed runs in this directory, for shadowlap test')
    .option('--writes <policy>', 'what write tools do after a fork: stub or block', parseChoice(['stub', 'block'] as const), 'stub')
    .option('--reads <policy>', 'what read tools do after a fork: live | replay', parseChoice<ReadPolicy>(['live', 'replay']), 'live')
    .option('--concurrency <n>', 'runs verified at once', parseIntArg, 1)
    .option('--budget <usd>', 'stop once this much is spent on live model calls and the repairer', parseUsd)
    .option('--timeout <seconds>', 'stop an attempt after this long and count it as failed', parseIntArg)
    .option('--guard <mode>', 'network guard for connections that bypass Shadowlap: warn | block | off', parseChoice<GuardMode>(['warn', 'block', 'off']), 'warn')
    .option('-y, --yes', 'run the recorded command of imported runs without asking')
    .option('--json', 'print the report as JSON (progress still goes to stderr)')
    .action(async (command: string[], flags: { fixes?: string[]; holdout?: string[]; keeps?: string[]; expect?: string; repairer?: string; candidates: number; stronger?: string; scope?: string; set: string[]; attempts: number; passes?: number; maxGrowth: number; build?: string; apply?: boolean; branch?: string; pr?: boolean; goldens?: string; writes: 'stub' | 'block'; reads: ReadPolicy; concurrency: number; budget?: number; timeout?: number; guard: GuardMode; yes?: boolean; json?: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      if (!flags.fixes?.length) throw new InvalidArgumentError('give the failing runs to repair: --fixes <runs>');
      if (flags.pr && !flags.branch) throw new InvalidArgumentError('--pr opens a pull request from the branch --branch <name> makes; give both');
      if (flags.goldens && !flags.apply && !flags.branch) throw new InvalidArgumentError('--goldens puts recordings into the project, which happens with --apply or --branch');
      if (flags.attempts > 100) throw new InvalidArgumentError('--attempts is at most 100');
      const passes = flags.passes ?? Math.ceil(0.8 * flags.attempts);
      if (passes > flags.attempts) throw new InvalidArgumentError(`--passes (${passes}) can't be more than --attempts (${flags.attempts})`);
      const spec = flags.expect !== undefined ? readExpect(flags.expect) : null;
      const config = loadConfig(process.cwd());
      const repairerSpec = flags.repairer ?? config.repair?.repairer;
      let repairer: Repairer | null = null;
      try {
        repairer = repairerSpec ? parseRepairer(repairerSpec) : null;
      } catch (err) {
        throw new InvalidArgumentError((err as Error).message);
      }

      const store = openStore(opts);
      let fixes: RunRecord[];
      let holdout: RunRecord[];
      let keeps: RunRecord[];
      try {
        fixes = selectRuns(store, flags.fixes, '--fixes');
        holdout = selectRuns(store, flags.holdout ?? [], '--holdout');
        keeps = selectRuns(store, flags.keeps ?? [], '--keeps');
      } finally {
        store.close();
      }
      const seen = new Map<string, string>();
      for (const [flag, list] of [['--fixes', fixes], ['--holdout', holdout], ['--keeps', keeps]] as const) {
        for (const r of list) {
          const other = seen.get(r.runId);
          if (other && other !== flag) throw new InvalidArgumentError(`${shortId(r.runId)} is given to both ${other} and ${flag}; a run has one role`);
          seen.set(r.runId, flag);
        }
      }
      const dedupe = (list: RunRecord[]) => [...new Map(list.map((r) => [r.runId, r])).values()];
      const all = await targetsOf(dedupe([...fixes, ...holdout, ...keeps]), command, flags.yes, 'repair');
      if (!all) {
        process.exitCode = 1;
        return;
      }
      const pick = (list: RunRecord[]) => all.filter((t) => list.some((r) => r.runId === t.parent.runId));
      let targets = pick(dedupe(fixes));
      let held = pick(dedupe(holdout));
      const heldOutAutomatically = !flags.holdout?.length && targets.length >= 2;
      if (heldOutAutomatically) ({ targets, holdout: held } = splitHoldout(targets));
      const good = pick(dedupe(keeps));

      const log = (line: string) => process.stderr.write(`${line}\n`);
      log(`${p.yellow('⑂')} Repairing ${targets.length} failing run${targets.length === 1 ? '' : 's'}${held.length ? `, with ${held.length} held out from the repairer${heldOutAutomatically ? ' (every other one)' : ''}` : ''}${good.length ? `, keeping ${good.length} good run${good.length === 1 ? '' : 's'}` : ''}`);
      log(p.dim(`  repairer: ${repairer ? (repairer.model ? `${repairer.provider}:${repairer.model}` : `${repairer.provider}, with its own default model`) : 'none (--repairer)'} · the gate: ${passes} of ${flags.attempts} attempts per run · writes ${flags.writes === 'stub' ? 'stubbed' : 'blocked'}${flags.budget ? ` · budget ${formatBudget(flags.budget)}` : ''}`));

      const settings = { attempts: flags.attempts, needed: passes, concurrency: flags.concurrency, candidates: flags.candidates, stronger: flags.stronger ?? null, scope: flags.scope ?? null, rescueFields: parseFields(flags.set, undefined), maxGrowth: flags.maxGrowth, build: flags.build ?? null, repairer: repairer ?? { provider: 'anthropic' as const, model: '' }, spec, writes: flags.writes, reads: flags.reads, liveTools: [], budget: flags.budget ?? null, timeoutMs: flags.timeout === undefined ? null : flags.timeout * 1000, guard: flags.guard };
      const outputs = { apply: !!flags.apply, branch: flags.branch ?? null, pr: !!flags.pr, goldens: flags.goldens ?? null };
      try {
        let report = await runRepair({ opts, targets, holdout: held, good, heldOutAutomatically, settings: { ...settings, repairerConfigured: repairer !== null }, outputs, log });
        report = handOver(report, { opts, outputs, settings, log });
        if (flags.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        else process.stdout.write('\n' + formatRepair(report, p) + '\n');
        process.exitCode = report.outcome === 'fixed' ? 0 : 1;
      } catch (err) {
        if (!(err instanceof RepairError)) throw err;
        if (flags.json) process.stdout.write(JSON.stringify({ outcome: 'error', error: { message: err.message } }, null, 2) + '\n');
        else process.stderr.write(`\n${p.red('✗')} ${err.message}\n`);
        process.exitCode = 1;
      }
    });
}
