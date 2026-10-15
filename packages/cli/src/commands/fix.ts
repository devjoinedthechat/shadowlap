import { readFileSync } from 'node:fs';
import { Command, InvalidArgumentError } from 'commander';
import { commandIsImported, describeRescue, FIX_STATUSES, formatBlame, formatRepair, formatVerify, hasRecordedCommand, maxProbes, outcomeOf, resolveFix, setFixTitle, type BlameReport, type FixStatus, type ReadPolicy, type RunRecord, type Store, type StoredFix, type VerifyReport, type VerifyRole } from '@shadowlap/engine';
import { fixDetail, fixHref, fixList } from '@shadowlap/dashboard';
import { formatBudget } from '../attempts.js';
import { BlameError, inScope, runBlame, type BlameRun } from '../blame.js';
import { parseExpect } from '../checks.js';
import { ApplyError, applyFix } from '../fix-apply.js';
import { formatFixDetail, formatFixList, repairLine, shortFixId } from '../fix-format.js';
import { recordRepairFix, recordVerifyFix, repairCommand, verifyCommand } from '../fixes.js';
import { emitJobEvent } from '../job-events.js';
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
  return readExpectJson(raw).spec;
}

/** `--expect` parsed, and its JSON as given: Fixes groups failures by it and shows it in commands. */
export function readExpectJson(raw: string): { spec: ReturnType<typeof parseExpect>; json: unknown } {
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
  return { spec: parseExpect(parsed, '--expect'), json: parsed };
}

/** The report as `--json` prints it: stable field names for scripts and coding agents. */
export function blameJson(r: BlameReport & Partial<Pick<BlameRun, 'fix'>>): Record<string, unknown> {
  const probe = (x: NonNullable<BlameReport['blamed']>) => ({ callNo: x.callNo, step: x.step, passes: x.passes, attempts: x.attempts.length });
  return {
    runId: r.runId,
    fix: r.fix ? { fixId: r.fix.fixId, title: r.fix.title, status: r.fix.status, opened: r.fix.opened } : null,
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

/** The report as `verify --json` prints it, with the verdict's id and the fixes it was kept with. */
export function verifyJson(r: VerifyReport, kept?: { verifyId: string; fixes: Array<Pick<StoredFix, 'fixId' | 'title' | 'status'>> } | null): Record<string, unknown> {
  const count = (role: VerifyRole) => {
    const of = r.runs.filter((x) => x.role === role);
    return { passed: of.filter((x) => x.verdict === 'pass').length, total: of.length };
  };
  return {
    verdict: r.verdict,
    verifyId: kept?.verifyId ?? null,
    fixes: (kept?.fixes ?? []).map((f) => ({ fixId: f.fixId, title: f.title, status: f.status })),
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

/** The fix a command reported to, in one dim line after its report: `fix fx-01K… · title · opened`. */
function fixLine(fix: { fixId: string; title: string }, what: string): string {
  return p.dim(`  fix ${shortFixId(fix.fixId)} · ${safe(fix.title)} · ${what} · shadowlap fix show ${shortFixId(fix.fixId)}`) + '\n';
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
      const expect = flags.expect !== undefined ? readExpectJson(flags.expect) : null;
      const spec = expect?.spec ?? null;
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
          settings: { attempts: flags.attempts, needed: passes, concurrency: flags.concurrency, scan: flags.scan, scope: flags.scope ?? null, writes: flags.writes, reads: flags.reads, liveTools: [], fields, spec, expect: expect?.json ?? null, budget: flags.budget ?? null, timeoutMs: flags.timeout === undefined ? null : flags.timeout * 1000, guard: flags.guard },
          log,
        });
        if (flags.json) process.stdout.write(JSON.stringify(blameJson(report), null, 2) + '\n');
        else process.stdout.write('\n' + formatBlame(report, p) + '\n' + (report.fix ? fixLine(report.fix, report.fix.opened ? 'opened' : 'joined') : ''));
        if (report.contrast) emitJobEvent({ type: 'run', runId: report.contrast.rescuedRunId, role: 'passing' });
        if (report.fix) emitJobEvent({ type: 'link', label: 'Open the fix', href: fixHref(report.fix.fixId, 'blame') });
        emitJobEvent({ type: 'result', data: blameJson(report) });
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
      const expect = flags.expect !== undefined ? readExpectJson(flags.expect) : null;
      const spec = expect?.spec ?? null;
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
        settings: { attempts: flags.attempts, needed: passes, concurrency: flags.concurrency, fields, failFast: !!flags.failFast, spec, expect: expect?.json ?? null, writes: flags.writes, reads: flags.reads, liveTools: flags.liveTool, budget: flags.budget ?? null, timeoutMs: flags.timeout === undefined ? null : flags.timeout * 1000, guard: flags.guard },
        log,
      });
      // The verdict is kept whatever it is, and turns the fix of its failing runs verified when it accepts.
      const line = verifyCommand({ fixes: flags.fixes, holdout: flags.holdout, keeps: flags.keeps }, { expect: expect?.json ?? null, attempts: flags.attempts, ...(flags.passes !== undefined ? { passes: flags.passes } : {}), fields, liveTools: flags.liveTool });
      const kept = recordVerifyFix(opts, report, { expect: expect?.json ?? null, command: line });
      const json = verifyJson(report, kept ? { verifyId: kept.verdict.verifyId, fixes: kept.fixes } : null);
      if (flags.json) process.stdout.write(JSON.stringify(json, null, 2) + '\n');
      else process.stdout.write('\n' + formatVerify(report, p) + '\n' + (kept?.fixes ?? []).map((f) => fixLine(f, report.verdict === 'accepted' ? f.status : `${report.verdict} verdict kept`)).join(''));
      for (const f of kept?.fixes ?? []) emitJobEvent({ type: 'link', label: 'Open the fix', href: fixHref(f.fixId, 'verify', kept!.verdict.verifyId) });
      emitJobEvent({ type: 'result', data: json });
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
      const expect = flags.expect !== undefined ? readExpectJson(flags.expect) : null;
      const spec = expect?.spec ?? null;
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

      const settings = { attempts: flags.attempts, needed: passes, concurrency: flags.concurrency, candidates: flags.candidates, stronger: flags.stronger ?? null, scope: flags.scope ?? null, rescueFields: parseFields(flags.set, undefined), maxGrowth: flags.maxGrowth, build: flags.build ?? null, repairer: repairer ?? { provider: 'anthropic' as const, model: '' }, spec, expect: expect?.json ?? null, writes: flags.writes, reads: flags.reads, liveTools: [], budget: flags.budget ?? null, timeoutMs: flags.timeout === undefined ? null : flags.timeout * 1000, guard: flags.guard };
      const outputs = { apply: !!flags.apply, branch: flags.branch ?? null, pr: !!flags.pr, goldens: flags.goldens ?? null };
      try {
        let report = await runRepair({ opts, targets, holdout: held, good, heldOutAutomatically, settings: { ...settings, repairerConfigured: repairer !== null }, outputs, log });
        report = handOver(report, { opts, outputs, settings, log });
        // Kept with the fix its blames opened or joined: accepted, it turns the fix verified; empty, the
        // fix stays open with every candidate tried and why each was dropped.
        const line = repairCommand({ fixes: flags.fixes, holdout: flags.holdout, keeps: flags.keeps }, { expect: expect?.json ?? null, ...(repairerSpec ? { repairer: repairerSpec } : {}), ...(flags.stronger ? { stronger: flags.stronger } : {}), ...(flags.scope ? { scope: flags.scope } : {}), attempts: flags.attempts, ...(flags.passes !== undefined ? { passes: flags.passes } : {}) });
        const kept = recordRepairFix(opts, report, { expect: expect?.json ?? null, command: line });
        const json = { ...report, repairId: kept?.repair.repairId ?? null, verifyId: kept?.verdict?.verifyId ?? null, fixes: (kept?.fixes ?? []).map((f) => ({ fixId: f.fixId, title: f.title, status: f.status })) };
        if (flags.json) process.stdout.write(JSON.stringify(json, null, 2) + '\n');
        else process.stdout.write('\n' + formatRepair(report, p) + '\n' + (kept?.fixes ?? []).map((f) => fixLine(f, kept!.repair.accepted ? f.status : 'still open, with the candidates tried')).join(''));
        for (const f of kept?.fixes ?? []) emitJobEvent({ type: 'link', label: 'Open the fix', href: fixHref(f.fixId, 'repair') });
        if (report.output.patch) emitJobEvent({ type: 'file', path: report.output.patch, label: 'fix.patch' });
        emitJobEvent({ type: 'result', data: json });
        process.exitCode = report.outcome === 'fixed' ? 0 : 1;
      } catch (err) {
        if (!(err instanceof RepairError)) throw err;
        if (flags.json) process.stdout.write(JSON.stringify({ outcome: 'error', error: { message: err.message } }, null, 2) + '\n');
        else process.stderr.write(`\n${p.red('✗')} ${err.message}\n`);
        process.exitCode = 1;
      }
    });

  registerFixes(program);
}

/** The repairer shadowlap.config.json names, if it names one and can be read. */
function configuredRepairer(): string | null {
  try {
    return loadConfig(process.cwd()).repair?.repairer ?? null;
  } catch {
    return null;
  }
}

/** A fix by its id or a unique prefix, or an error that says where to find one. */
function requireFix(store: Store, idOrPrefix: string): StoredFix {
  const fix = resolveFix(store, idOrPrefix);
  if (!fix) throw new Error(`no fix matches "${idOrPrefix}" (see: shadowlap fix ls)`);
  return fix;
}

/** `shadowlap fix`: each failure, from the blame that reproduced it to a change that held. */
function registerFixes(program: Command): void {
  const fix = program
    .command('fix')
    .description('Fixes: each failure, from the blame that reproduced it to a fix verify accepted. A blame opens one; repair and verify report to it; fix apply hands it over.');

  fix
    .command('ls')
    .description('List fixes, the most recently opened first: status, title, failing runs, and how far blame, repair and verify got')
    .option('--status <status>', 'only fixes that are open, verified (applied ones too) or applied', parseChoice<FixStatus>(FIX_STATUSES))
    .option('--json', 'print the list as JSON, as the dashboard reads it')
    .action((flags: { status?: FixStatus; json?: boolean }) => {
      const store = openStore(program.opts<GlobalOpts>());
      try {
        const list = fixList(store, flags.status ? { status: flags.status } : {});
        process.stdout.write((flags.json ? JSON.stringify(list, null, 2) : formatFixList(list, p)) + '\n');
      } finally {
        store.close();
      }
    });

  fix
    .command('show')
    .description('A fix and its three steps: where the run was lost, the change proposed for it, and every verdict on it')
    .argument('<fix>', 'a fix id or a unique prefix of it, such as fx-01K5CQ2E8M')
    .option('--json', 'print the fix as JSON, as the dashboard reads it')
    .action((arg: string, flags: { json?: boolean }) => {
      const store = openStore(program.opts<GlobalOpts>());
      try {
        const detail = fixDetail(store, requireFix(store, arg).fixId)!;
        process.stdout.write((flags.json ? JSON.stringify(detail, null, 2) : formatFixDetail(detail, p, { repairer: configuredRepairer() })) + '\n');
      } finally {
        store.close();
      }
    });

  fix
    .command('title')
    .description("Give a fix a title of your own, in place of the one derived from its check")
    .argument('<fix>', 'a fix id or a unique prefix of it')
    .argument('<title...>', 'the new title')
    .action((arg: string, words: string[]) => {
      const store = openStore(program.opts<GlobalOpts>());
      try {
        const updated = setFixTitle(store, requireFix(store, arg).fixId, words.join(' '));
        process.stdout.write(`${shortFixId(updated.fixId)} · ${safe(updated.title)}\n`);
      } finally {
        store.close();
      }
    });

  fix
    .command('apply')
    .description("Apply a verified fix: git apply its repair's patch, copy the recordings the fixed code made into the goldens folder, run shadowlap test on them, and mark the fix applied")
    .argument('<fix>', 'a fix id or a unique prefix of it')
    .option('--goldens <dir>', "the project's goldens folder, where the repair's recordings go", 'goldens')
    .option('--no-test', 'copy the recordings without running shadowlap test on them')
    .option('--build <command>', 'rebuild the agent after the patch is applied, before the test')
    .option('--json', 'print what was done as JSON (progress still goes to stderr)')
    .action(async (arg: string, flags: { goldens: string; test: boolean; build?: string; json?: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      const store = openStore(opts);
      const log = (line: string) => process.stderr.write(`${line}\n`);
      try {
        const found = requireFix(store, arg);
        if (found.status === 'open') {
          const next = fixDetail(store, found.fixId)?.actions.repair?.argv;
          throw new ApplyError(`${shortFixId(found.fixId)} is open: no change has been verified for it yet, so there is nothing to apply.${next ? ` Repair it first:\n  ${repairLine(next, configuredRepairer())}` : ''}`);
        }
        if (found.status !== 'applied') log(`${p.yellow('⑂')} Applying ${shortFixId(found.fixId)} · ${safe(found.title)}`);
        const result = await applyFix(store, found, { cwd: process.cwd(), goldens: flags.goldens, test: flags.test, build: flags.build ?? null, db: opts.db, log });
        if (flags.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        else if (result.status === 'already-applied') process.stdout.write(`${p.green('✓')} ${shortFixId(found.fixId)} is already applied${found.appliedAt ? ` (${new Date(found.appliedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC)` : ''}\n`);
        else {
          const what = [
            result.patch === 'applied' ? 'the patch is in the working tree' : result.patch === 'already' ? 'the patch was already in the working tree' : 'verified on the working tree, no patch to apply',
            ...(result.goldens.length ? [`${result.goldens.filter((g) => g.copied).length} of ${result.goldens.length} golden${result.goldens.length === 1 ? '' : 's'} copied to ${flags.goldens}`] : []),
            ...(result.tests !== 'skipped' ? [`shadowlap test ${result.tests}`] : []),
          ];
          process.stdout.write(`${result.tests === 'failed' ? p.red('✗') : p.green('✓')} ${shortFixId(found.fixId)} applied: ${what.join(', ')}\n`);
        }
        emitJobEvent({ type: 'link', label: 'Open the fix', href: fixHref(found.fixId) });
        emitJobEvent({ type: 'result', data: result });
        process.exitCode = result.tests === 'failed' ? 1 : 0;
      } catch (err) {
        if (!(err instanceof ApplyError)) throw err;
        if (flags.json) process.stdout.write(JSON.stringify({ fixId: arg, status: 'error', error: { message: err.message } }, null, 2) + '\n');
        else process.stderr.write(`${p.red('✗')} ${err.message}\n`);
        process.exitCode = 1;
      } finally {
        store.close();
      }
    });
}
