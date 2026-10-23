import { existsSync, readFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { Command, InvalidArgumentError, Option } from 'commander';
import { applyLeft, BLAME_DEFAULTS, commandIsImported, describeBaselineRule, dropBound, KEPT_DEFAULTS, percent, probeGate, describeGate, describeRescue, FIX_STATUSES, FixIdError, fixRecords, formatBlame, formatRepair, formatVerify, hasRecordedCommand, maxProbes, outcomeOf, parseGate, prNumber, probeFinding, rescueRule, resolveFix, setFixTitle, SPRT_DEFAULTS, type BlameReport, type FixStatus, type ReadPolicy, type RepairReport, type RunRecord, type SprtGate, type Store, type StoredFix, type VerdictStanding, type VerifyOutcome, type VerifyReport, type VerifyRole } from '@shadowlap/engine';
import { fieldChange, fixDetail, fixHref, fixList, ghReader, patchesInTree, patchesToCheck, prHost, readableHosts, repairerProblem, type PrRead } from '@shadowlap/dashboard';
import { formatBudget, undecidableRefusal } from '../attempts.js';
import { BlameError, inScope, runBlame, type BlameRun } from '../blame.js';
import { parseExpect } from '../checks.js';
import { acceptedRepair, ApplyError, applyFix } from '../fix-apply.js';
import { formatFixDetail, formatFixList, repairLine, shortFixId } from '../fix-format.js';
import { blameCommand, recordRepairFix, recordVerifyFix, repairCommand, verifyCommand } from '../fixes.js';
import { emitJobEvent } from '../job-events.js';
import { AGENT_NODE_TOO_OLD } from '../agent-node.js';
import { EXIT, interruptedStatus, stoppedBy } from '../exit-codes.js';
import { type GuardMode } from '../run-agent.js';
import { confirmImportedCommand, missingStoreNote, parseChoice, parseIntArg, readStore, requireRun, withoutCommand, type GlobalOpts } from '../shared.js';
import { ago, clauses, folder, palette as p, quoteArgv, safe, shortId } from '../ui.js';
import { runVerify, type VerifyBaseline } from '../verify.js';
import { resolveBase } from '../verify-base.js';
import { HandOverError, RepairError, runRepair, splitHoldout } from '../repair.js';
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

/** `--gate`: a gate between two pass rates, as JSON or @file.json; the figures left out are `defaults`. */
export function readGate(raw: string, defaults: Omit<SprtGate, 'kind'>): SprtGate {
  let text = raw;
  if (raw.startsWith('@')) {
    try {
      text = readFileSync(raw.slice(1), 'utf8');
    } catch (err) {
      throw new InvalidArgumentError(`--gate: cannot read ${raw.slice(1)}: ${(err as Error).message}`);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InvalidArgumentError(`--gate takes JSON or @file.json, such as '{"good":${defaults.good},"bad":${defaults.bad},"risk":${defaults.risk},"max":${defaults.max}}'`);
  }
  let gate;
  try {
    gate = parseGate(parsed, '--gate', defaults);
  } catch (err) {
    throw new InvalidArgumentError((err as Error).message);
  }
  if (gate.kind !== 'sprt') throw new InvalidArgumentError('--gate takes a gate between two pass rates here ({ "good", "bad", "risk", "max" }); a gate against history belongs to a golden, under "tests" in shadowlap.config.json');
  return gate;
}

/**
 * What decides a run's or a probe's attempts: the gate (`--gate`, else the command's defaults), or a
 * fixed count when `--attempts` or `--passes` is given, as it was before gates (`passes` defaulting
 * from the attempts).
 */
export function attemptRule(flags: { attempts?: number | undefined; passes?: number | undefined; gate?: string | undefined }, o: { defaults: Omit<SprtGate, 'kind'>; passes: (attempts: number) => number }): { gate: SprtGate | null; attempts: number; needed: number } {
  const counted = flags.attempts !== undefined || flags.passes !== undefined;
  if (counted && flags.gate !== undefined) throw new InvalidArgumentError('give a gate (--gate) or a fixed count (--attempts, --passes), not both');
  if (!counted) {
    const gate = flags.gate !== undefined ? readGate(flags.gate, o.defaults) : ({ kind: 'sprt', ...o.defaults } as SprtGate);
    return { gate, attempts: gate.max, needed: 0 };
  }
  const attempts = flags.attempts ?? 5;
  if (attempts > 100) throw new InvalidArgumentError('--attempts is at most 100');
  const needed = flags.passes ?? o.passes(attempts);
  if (needed > attempts) throw new InvalidArgumentError(`--passes (${needed}) can't be more than --attempts (${attempts})`);
  return { gate: null, attempts, needed };
}

/** A gate's result as `--json` prints it beside a run or a probe: its decision, the pass rate's interval and its sentence. */
const gateJson = (g: { decision: string; interval: unknown; sentence: string } | null | undefined) => (g ? { decision: g.decision, interval: g.interval, sentence: g.sentence } : null);

/** A good run kept against its baseline, as `--json` prints its verdict: the decision, the drop's interval and the sentence, rule included. */
function keptJson(x: VerifyReport['runs'][number], r: VerifyReport): { decision: string; drop: unknown; sentence: string } {
  const bound = x.drop ? dropBound(x.drop, x.decision) : null;
  const rule = r.kept ? ` · ${describeBaselineRule({ ...r.kept, revision: r.kept.label ?? r.kept.revision ?? null })}` : '';
  const tally = `${x.passes} of ${x.attempts.length} passed, baseline ${x.baseline!.passes} of ${x.baseline!.attempts}`;
  return { decision: x.decision ?? 'continue', drop: x.drop ?? null, sentence: `${outcomeOf(x)} · ${tally}${bound ? ` · ${bound}` : ''}${rule}` };
}

/** `--margin`: a drop between 0 and 1, as a share (0.1 is 10 points). */
function parseMargin(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) throw new InvalidArgumentError('must be a share between 0 and 1, such as 0.1 (a drop of 10 points)');
  return n;
}

/** The report as `--json` prints it: stable field names for scripts and coding agents. */
export function blameJson(r: BlameReport & Partial<Pick<BlameRun, 'fix'>>): Record<string, unknown> {
  const probe = (x: NonNullable<BlameReport['blamed']>) => ({ callNo: x.callNo, step: x.step, passes: x.passes, attempts: x.attempts.length });
  return {
    runId: r.runId,
    fix: r.fix ? { fixId: r.fix.fixId, title: r.fix.title, status: r.fix.status, opened: r.fix.opened } : null,
    outcome: r.outcome,
    confidence: r.confidence,
    // The calls the run was lost between (one when pinned), and the most that, or a finding that no call
    // rescues it, may be wrong: the risks of the probes that decided, summed. Null when nothing bounds it.
    range: r.range ? { from: r.range.from, to: r.range.to } : null,
    errorBound: r.errorBound ?? null,
    blamed: r.blamed ? probe(r.blamed) : null,
    lost: r.lost ? probe(r.lost) : null,
    modelCalls: r.steps,
    attemptsPerProbe: r.attemptsPerProbe,
    passesNeeded: r.needed,
    gate: r.gate ?? null,
    // The search's risk is spent across up to probeBudget probes: each ran under probeGate, at its share.
    probeBudget: r.probeBudget ?? null,
    probeGate: r.gate && r.probeBudget ? probeGate(r.gate, r.probeBudget) : null,
    rescue: r.rescue,
    oracle: r.oracle,
    recordedFailures: r.recordedFailures,
    contrast: r.contrast,
    sameAnswer: r.sameAnswer ?? null,
    failedWrite: r.failedWrite ?? null,
    // A probe's sentence in blame's words, as its report says it: rescued or lost, the tally, the Wilson bound and the rule.
    probes: r.probes.map((x) => ({ ...probe(x), rescued: x.rescued, decision: x.decision ?? null, rate: x.gate && !x.undecided ? { ...gateJson(x.gate)!, sentence: `${probeFinding(x, r.gate ?? null)} · ${rescueRule(r)}` } : null, undecided: x.undecided ?? null, risk: x.risk ?? null, runs: x.attempts })),
    // The probes' rescue rates fitted non-increasing, in call order.
    fit: r.fit ?? [],
    nonMonotone: r.nonMonotone,
    cost: { attempts: r.attempts, spent: r.spent, upstreamRequests: r.upstreamRequests, unknownModels: r.unknownModels },
    // Judge checks' calls, apart from the agent's: what they sent upstream and spent. Null when no judge was asked live.
    judge: r.judge ?? null,
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
export function verifyJson(r: VerifyReport, kept?: { verifyId: string; fixes: Array<{ fix: Pick<StoredFix, 'fixId' | 'title' | 'status'>; standing: VerdictStanding | null }> } | null): Record<string, unknown> {
  const count = (role: VerifyRole) => {
    const of = r.runs.filter((x) => x.role === role);
    // A run that is inconclusive (its gate ran out between its bounds, or an attempt could not be judged) is counted apart, never as one that failed.
    return { passed: of.filter((x) => x.verdict === 'pass').length, inconclusive: of.filter((x) => outcomeOf(x) === 'inconclusive').length, total: of.length };
  };
  return {
    verdict: r.verdict,
    verifyId: kept?.verifyId ?? null,
    fixes: keptFixes(kept?.fixes ?? []),
    reasons: r.reasons,
    warnings: [...r.warnings, ...r.replayWarnings],
    codeVersion: r.codeVersion,
    oracle: r.oracle,
    attemptsPerRun: r.attemptsPerRun,
    passesNeeded: r.needed,
    gate: r.gate ?? null,
    change: { fields: r.fields },
    summary: { targets: count('target'), holdout: count('holdout'), good: count('good') },
    runs: r.runs.map((x) => ({
      runId: x.runId,
      role: x.role,
      outcome: outcomeOf(x).replace(' ', '-'),
      passes: x.passes,
      attempts: x.attempts.length,
      decision: x.decision ?? null,
      rate: x.undecided ? null : x.baseline ? keptJson(x, r) : gateJson(x.gate),
      deterministic: x.deterministic,
      recorded: x.recorded,
      undecided: x.undecided ?? null,
      // A good run decided against its own baseline: the baseline's tally and where it came from, the
      // margin, the bound on the drop, and the baseline's attempts; why there was none, when none.
      ...(x.baseline ? { baseline: x.baseline, margin: x.margin ?? null, drop: x.drop ?? null } : {}),
      ...(x.baselineRuns ? { baselineRuns: x.baselineRuns } : {}),
      ...(x.noBaseline ? { noBaseline: x.noBaseline } : {}),
      runs: x.attempts,
    })),
    // The rule good runs were kept by: against what, the margin, the risk and the most pairs or attempts.
    kept: r.kept ?? null,
    cost: { attempts: r.attempts, spent: r.spent, upstreamRequests: r.upstreamRequests, unknownModels: r.unknownModels },
    // Judge checks' calls, apart from the agent's: what they sent upstream and spent. Null when no judge was asked live.
    judge: r.judge ?? null,
    stopReason: r.stopReason,
  };
}

/** The fix a command reported to, in one dim line after its report: `fix fx-01K… · title · opened`. */
function fixLine(fix: { fixId: string; title: string }, what: string): string {
  return p.dim(`  fix ${shortFixId(fix.fixId)} · ${safe(fix.title)} · ${what} · shadowlap fix show ${shortFixId(fix.fixId)}`) + '\n';
}

/** What a verdict did to a fix, in a few words: `verified`, `rejected verdict kept`, or why it doesn't count. */
function standingWords(verdict: VerifyOutcome, standing: VerdictStanding, status: FixStatus): string {
  if (standing.counts) return verdict === 'accepted' ? status : `${verdict} verdict kept`;
  const why = standing.why === 'another-check' ? 'checked under another check' : standing.why === 'already-passing' ? 'its runs already passed as recorded' : 'none of its runs fails here';
  return `${verdict} verdict kept, not counted (${why}); still ${status}`;
}

/** The fixes a verdict was kept with, as `--json` prints them. */
const keptFixes = (fixes: Array<{ fix: Pick<StoredFix, 'fixId' | 'title' | 'status'>; standing: VerdictStanding | null }>) =>
  fixes.map(({ fix, standing }) => ({ fixId: fix.fixId, title: fix.title, status: fix.status, counts: standing?.counts ?? null, why: standing && !standing.counts ? standing.why : null }));

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
      throw new InvalidArgumentError(`${shortId(run.runId)} ${withoutCommand(run)} and has no command to re-run. Give yours after --:\n  shadowlap ${verb} … -- python agent.py`);
    }
    const argv = command.length ? command : run.command.argv;
    const commandFromImport = !command.length && commandIsImported(run);
    if (commandFromImport && !yes && !(await confirmImportedCommand(run, argv))) return null;
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
    .option('--gate <json|@file>', `how a probe decides, after each attempt: a gate that tells a re-asked call passing "good" of the time or more (a rescue) from one passing "bad" or less (lost), each verdict wrong at most "risk" of the time at those two rates, up to "max" attempts (default '{"good":${BLAME_DEFAULTS.good},"bad":${BLAME_DEFAULTS.bad},"risk":${BLAME_DEFAULTS.risk},"max":${BLAME_DEFAULTS.max}}'; give any of them)`)
    .option('--attempts <n>', 'a fixed count instead of the gate: attempts per probed model call (5 with --passes alone)', parseIntArg)
    .option('--passes <n>', 'with a fixed count: passing attempts that make a probe a rescue (default: 2, or 1 with one attempt)', parseIntArg)
    .option('--model <model>', 'rescue with this model from the probed call on, instead of asking the recorded one again')
    .option('--set <key=value>', 'set a request field from the probed call on, e.g. temperature=1 (repeatable)', (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option('--scope <name>', 'probe only model calls made in this scope, such as the agent\'s and not a simulated user\'s (see scope() in the SDKs)')
    .option('--scan <n>', 'model calls past the boundary to probe as well, in case rescue works again after it', parseCount, 2)
    .option('--writes <policy>', 'what write tools do after the fork: stub (the agent carries on as if the write succeeded) or block; a write the recording made, with the same arguments, gets what it got then', parseChoice(['stub', 'block'] as const), 'stub')
    .option('--reads <policy>', 'what read tools do after the fork: live | replay', parseChoice<ReadPolicy>(['live', 'replay']), 'live')
    .option('--concurrency <n>', 'attempts of one probe running at once', parseIntArg, 1)
    .option('--budget <usd>', 'start no attempt once this much is spent on live model calls', parseUsd)
    .option('--timeout <seconds>', 'stop an attempt after this long and count it as failed', parseIntArg)
    .option('--guard <mode>', 'network guard for connections that bypass Shadowlap: warn | block | off', parseChoice<GuardMode>(['warn', 'block', 'off']), 'warn')
    .option('-y, --yes', 'run the recorded command of an imported run without asking')
    .option('--json', 'print the report as JSON (progress still goes to stderr)')
    .action(async (runArg: string, command: string[], flags: { expect?: string; gate?: string; attempts?: number; passes?: number; model?: string; set: string[]; scope?: string; scan: number; writes: 'stub' | 'block'; reads: ReadPolicy; concurrency: number; budget?: number; timeout?: number; guard: GuardMode; yes?: boolean; json?: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      const rule = attemptRule(flags, { defaults: BLAME_DEFAULTS, passes: (n) => Math.min(2, n) });
      const expect = flags.expect !== undefined ? readExpectJson(flags.expect) : null;
      const spec = expect?.spec ?? null;
      const undecidable = undecidableRefusal(spec, 'blame');
      if (undecidable) throw new InvalidArgumentError(undecidable);
      const fields = parseFields(flags.set, flags.model);

      const store = readStore(opts);
      const parent = requireRun(store, runArg);
      const steps = store.getCalls(parent.runId).filter((c) => c.kind === 'api' && c.end && inScope(c.meta.scope, flags.scope)).length;
      store.close();
      if (!command.length && !hasRecordedCommand(parent)) {
        throw new InvalidArgumentError(`${shortId(parent.runId)} ${withoutCommand(parent)} and has no command to re-run. Give yours after --:\n  shadowlap blame ${shortId(parent.runId)} -- python agent.py`);
      }
      const argv = command.length ? command : parent.command.argv;
      const commandFromImport = !command.length && commandIsImported(parent);
      if (commandFromImport && !flags.yes && !(await confirmImportedCommand(parent, argv))) {
        process.exitCode = EXIT.usage;
        return;
      }

      const log = (line: string) => process.stderr.write(`${line}\n`);
      const most = maxProbes(steps, flags.scan);
      log(`${p.yellow('⑂')} Blaming ${shortId(parent.runId)} ${p.dim(`(${safe(quoteArgv(argv))})`)}: ${steps} model call${steps === 1 ? '' : 's'}${flags.scope ? ` in scope ${safe(flags.scope)}` : ''}`);
      const each = rule.gate ? rescueRule({ gate: rule.gate, needed: 0, attemptsPerProbe: rule.gate.max }) : `${rule.attempts} attempts, a rescue at ${rule.needed} passing`;
      // Under a gate its risk is the whole search's, spent across the most probes it makes.
      const spent = rule.gate ? `, the ${percent(rule.gate.risk)} risk spent across them` : '';
      log(
        p.dim(
          `  each probe: ${describeRescue(fields)}, ${each} · writes ${flags.writes === 'stub' ? 'stubbed' : 'blocked'}${flags.budget ? ` · budget ${formatBudget(flags.budget)}` : ''}\n  at most ${most} probe${most === 1 ? '' : 's'}${spent} and ${most * rule.attempts} attempts; every call before a probe replays from the recording for free`,
        ),
      );

      try {
        const settings = { attempts: rule.attempts, needed: rule.needed, gate: rule.gate, concurrency: flags.concurrency, scan: flags.scan, scope: flags.scope ?? null, writes: flags.writes, reads: flags.reads, liveTools: [], fields, spec, expect: expect?.json ?? null, budget: flags.budget ?? null, timeoutMs: flags.timeout === undefined ? null : flags.timeout * 1000, guard: flags.guard };
        const report = await runBlame({
          opts,
          parent,
          argv,
          commandFromImport,
          settings,
          command: blameCommand(parent.runId, { ...settings, argv: command.length ? command : null }),
          log,
        });
        if (flags.json) process.stdout.write(JSON.stringify(blameJson(report), null, 2) + '\n');
        else process.stdout.write('\n' + formatBlame(report, p) + '\n' + (report.fix ? fixLine(report.fix, report.fix.opened ? 'opened' : 'joined') : ''));
        if (report.contrast) emitJobEvent({ type: 'run', runId: report.contrast.rescuedRunId, role: 'passing' });
        if (report.fix) emitJobEvent({ type: 'link', label: 'Open the fix', href: fixHref(report.fix.fixId, 'blame') });
        emitJobEvent({ type: 'result', data: blameJson(report) });
        // A verdict (a blamed call, or none that rescues the run), 0; stopped before one, by its reason.
        process.exitCode = report.outcome === 'stopped' ? stoppedStatus(report.stopReason) : EXIT.ok;
      } catch (err) {
        if (!(err instanceof BlameError)) throw err;
        if (flags.json) process.stdout.write(JSON.stringify({ runId: parent.runId, outcome: 'error', error: { reason: err.reason, message: err.message }, judge: err.judge }, null, 2) + '\n');
        else process.stderr.write(`\n${p.red('✗')} ${err.message}\n`);
        process.exitCode = blameErrorStatus(err.reason);
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
    .option('--gate <json|@file>', `how a run decides, after each attempt where the replay forks: a gate that tells a run passing "good" of the time or more from one passing "bad" or less, each verdict wrong at most "risk" of the time at those two rates, up to "max" attempts (default '{"good":${SPRT_DEFAULTS.good},"bad":${SPRT_DEFAULTS.bad},"risk":${SPRT_DEFAULTS.risk},"max":${SPRT_DEFAULTS.max}}'; give any of them)`)
    .option('--attempts <n>', 'a fixed count instead of the gate: attempts per run, where the replay forks (5 with --passes alone)', parseIntArg)
    .option('--passes <n>', 'with a fixed count: attempts that must pass for a run to pass (default: 80%, rounded up: 4 of 5)', parseIntArg)
    .option('--model <model>', 'the change is this model, from each run\'s first model call')
    .option('--set <key=value>', 'the change sets this request field from each run\'s first model call (repeatable)', (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option('--from <model>', 'with --model or --set: change only the model calls made with this model, such as the agent\'s and not a simulated user\'s (repeatable)', (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option('--live-tool <name>', 'the change is in this tool: run it live, its first call and every call of it after a fork (repeatable)', (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option('--writes <policy>', 'what write tools do after a fork: stub (the agent carries on as if the write succeeded) or block', parseChoice(['stub', 'block'] as const), 'stub')
    .option('--reads <policy>', 'what read tools do after a fork: live | replay', parseChoice<ReadPolicy>(['live', 'replay']), 'live')
    .option('--concurrency <n>', 'runs verified at once', parseIntArg, 1)
    .option('--budget <usd>', 'start no attempt once this much is spent on live model calls', parseUsd)
    .option('--timeout <seconds>', 'stop an attempt after this long and count it as failed', parseIntArg)
    .option('--fail-fast', 'start nothing new once a run has failed')
    .option('--margin <share>', `a good run that forks is kept unless its pass rate drops this much or more below its baseline's: 0.1 is 10 points (default: verify.margin in ${'shadowlap.config.json'}, else ${KEPT_DEFAULTS.margin})`, parseMargin)
    .option('--baseline <source>', 'what a good run is compared with: paired, the same run under the code before the change, attempt for attempt; or history, its golden\'s test history (default: verify.baseline, else paired)', parseChoice(['paired', 'history'] as const))
    .option('--base <rev>', 'with a paired baseline: the commit before the change (default: HEAD, when the working tree has a change)')
    .option('--build <command>', 'with a paired baseline at a commit: build its checkout before its attempts, e.g. "npm run build"')
    .option('--guard <mode>', 'network guard for connections that bypass Shadowlap: warn | block | off', parseChoice<GuardMode>(['warn', 'block', 'off']), 'warn')
    .option('-y, --yes', 'run the recorded command of imported runs without asking')
    .option('--json', 'print the report as JSON (progress still goes to stderr)')
    .action(async (command: string[], flags: { fixes?: string[]; holdout?: string[]; keeps?: string[]; expect?: string; gate?: string; attempts?: number; passes?: number; model?: string; set: string[]; from: string[]; liveTool: string[]; writes: 'stub' | 'block'; reads: ReadPolicy; concurrency: number; budget?: number; timeout?: number; failFast?: boolean; margin?: number; baseline?: 'paired' | 'history'; base?: string; build?: string; guard: GuardMode; yes?: boolean; json?: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      const rule = attemptRule(flags, { defaults: SPRT_DEFAULTS, passes: (n) => Math.ceil(0.8 * n) });
      const expect = flags.expect !== undefined ? readExpectJson(flags.expect) : null;
      const spec = expect?.spec ?? null;
      const undecidable = undecidableRefusal(spec, 'verify');
      if (undecidable) throw new InvalidArgumentError(undecidable);
      const fields = parseFields(flags.set, flags.model);
      if (flags.from.length && !Object.keys(fields).length) throw new InvalidArgumentError('--from names the model calls --model and --set change: give one of them');
      // What good runs are kept against: the same runs under the code before the change, or history.
      const source = flags.baseline ?? loadConfig(process.cwd()).verify?.baseline ?? 'paired';
      if (source === 'history' && (flags.base !== undefined || flags.build !== undefined)) throw new InvalidArgumentError('--base and --build check out the code a paired baseline runs at: give them without --baseline history');
      if (!rule.gate && (flags.margin !== undefined || flags.baseline !== undefined || flags.base !== undefined || flags.build !== undefined)) throw new InvalidArgumentError('a fixed count (--attempts, --passes) judges every run on its own: --margin, --baseline, --base and --build are for the gate, which keeps a good run against its baseline');
      let baseline: VerifyBaseline;
      if (source === 'history') baseline = { source: 'history' };
      else {
        const found = resolveBase(process.cwd(), { base: flags.base, fields: Object.keys(fields).length > 0, build: flags.build ?? null });
        // A commit named that isn't one is a mistake; a working tree with nothing to compare is not.
        if ('none' in found && flags.base !== undefined) throw new InvalidArgumentError(found.none);
        baseline = 'base' in found ? { source: 'paired', base: found.base } : { source: 'none', why: found.none };
      }

      const store = readStore(opts);
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
        process.exitCode = EXIT.usage;
        return;
      }
      const runs: Parameters<typeof runVerify>[0]['runs'] = resolved.map((t) => ({ ...t, role: chosen.get(t.parent.runId)!.role }));

      const log = (line: string) => process.stderr.write(`${line}\n`);
      const n = (role: VerifyRole) => runs.filter((r) => r.role === role).length;
      const counts = [n('target') ? `${n('target')} to fix` : '', n('holdout') ? `${n('holdout')} held out` : '', n('good') ? `${n('good')} to keep` : ''].filter(Boolean).join(', ');
      log(`${p.yellow('⑂')} Verifying the code as it is now against ${runs.length} run${runs.length === 1 ? '' : 's'} (${counts})`);
      const decides = rule.gate ? `each run's gate: ${describeGate(rule.gate)}` : `a run passes at ${rule.needed} of ${rule.attempts} attempts`;
      log(p.dim(`  ${decides}; one that replays clean is settled by its first · writes ${flags.writes === 'stub' ? 'stubbed' : 'blocked'}${flags.budget ? ` · budget ${formatBudget(flags.budget)}` : ''}`));
      // How a good run that forks is kept: against its baseline, or, when there is none, by its gate alone.
      if (rule.gate && n('good')) {
        const margin = flags.margin ?? loadConfig(process.cwd()).verify?.margin ?? KEPT_DEFAULTS.margin;
        const max = loadConfig(process.cwd()).verify?.max ?? KEPT_DEFAULTS.max;
        if (baseline.source === 'none') log(p.dim(`  a good run that forks: by its gate on its own, as ${baseline.why}`));
        else log(p.dim(`  a good run that forks: ${describeBaselineRule({ margin, risk: rule.gate.risk, max, source: baseline.source, revision: baseline.source === 'paired' ? (baseline.base.revision ? baseline.base.label : 'the working tree, without the change') : null })}`));
      }

      const report = await runVerify({
        opts,
        runs,
        settings: { attempts: rule.attempts, needed: rule.needed, gate: rule.gate, concurrency: flags.concurrency, fields, ...(flags.from.length ? { fromModels: flags.from } : {}), failFast: !!flags.failFast, spec, expect: expect?.json ?? null, writes: flags.writes, reads: flags.reads, liveTools: flags.liveTool, budget: flags.budget ?? null, timeoutMs: flags.timeout === undefined ? null : flags.timeout * 1000, guard: flags.guard, ...(rule.gate ? { baseline } : {}), ...(flags.margin !== undefined ? { margin: flags.margin } : {}) },
        log,
      });
      // The verdict is kept whatever it is. It turns the fix of its failing runs verified when it accepts
      // and counts there: it checked the fix's own check, on a run that failed it as recorded.
      const line = verifyCommand(
        { fixes: flags.fixes, holdout: flags.holdout, keeps: flags.keeps },
        { expect: expect?.json ?? null, attempts: rule.attempts, ...(flags.passes !== undefined ? { passes: flags.passes } : {}), gate: rule.gate, fields, from: flags.from, liveTools: flags.liveTool, failFast: !!flags.failFast, margin: flags.margin, baseline: flags.baseline, base: flags.base, build: flags.build ?? null, writes: flags.writes, reads: flags.reads, budget: flags.budget ?? null, timeoutMs: flags.timeout === undefined ? null : flags.timeout * 1000, argv: command.length ? command : null },
      );
      const kept = recordVerifyFix(opts, report, { expect: expect?.json ?? null, command: line });
      const json = verifyJson(report, kept ? { verifyId: kept.verdict.verifyId, fixes: kept.fixes } : null);
      if (flags.json) process.stdout.write(JSON.stringify(json, null, 2) + '\n');
      else process.stdout.write('\n' + formatVerify(report, p) + '\n' + (kept?.fixes ?? []).map(({ fix: f, standing }) => fixLine(f, standingWords(report.verdict, standing, f.status))).join(''));
      for (const { fix: f } of kept?.fixes ?? []) emitJobEvent({ type: 'link', label: 'Open the fix', href: fixHref(f.fixId, 'verify', kept!.verdict.verifyId) });
      emitJobEvent({ type: 'result', data: json });
      // Accepted, 0; rejected, 1; not finished (a run's gate undecided, the budget spent), 3.
      process.exitCode = report.verdict === 'accepted' ? EXIT.ok : report.verdict === 'rejected' ? EXIT.failed : stoppedBy() ? interruptedStatus() : EXIT.inconclusive;
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
    .option('--repairer-timeout <seconds>', 'give up on the repairer when it has not answered after this long (default: repair.timeout in shadowlap.config.json, else 600)', parseIntArg)
    .option('--candidates <n>', 'fixes to ask the repairer for', parseIntArg, 3)
    .option('--stronger <model>', 'when asking the recorded model again rescues nothing, rescue with this one, and try switching to it')
    .option('--scope <name>', 'blame only model calls made in this scope, such as the agent\'s and not a simulated user\'s')
    .option('--set <key=value>', 'blame\'s probes set this request field from the probed call on, e.g. temperature=1 for an agent recorded at 0 (repeatable)', (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option('--gate <json|@file>', `how verify decides each run, as for shadowlap verify (default '{"good":${SPRT_DEFAULTS.good},"bad":${SPRT_DEFAULTS.bad},"risk":${SPRT_DEFAULTS.risk},"max":${SPRT_DEFAULTS.max}}'; give any of them)`)
    .option('--attempts <n>', 'a fixed count instead of the gate: attempts per run, where the replay forks (5 with --passes alone)', parseIntArg)
    .option('--passes <n>', 'with a fixed count: attempts that must pass (default: 80%, rounded up)', parseIntArg)
    // Read in percent, kept as a share: the help shows the default as it is typed.
    .addOption(new Option('--max-growth <percent>', 'reject a fix that grows the input tokens per run by more than this').argParser(parsePercent).default(0.25, '25'))
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
    .action(async (command: string[], flags: { fixes?: string[]; holdout?: string[]; keeps?: string[]; expect?: string; repairer?: string; repairerTimeout?: number; candidates: number; stronger?: string; scope?: string; set: string[]; gate?: string; attempts?: number; passes?: number; maxGrowth: number; build?: string; apply?: boolean; branch?: string; pr?: boolean; goldens?: string; writes: 'stub' | 'block'; reads: ReadPolicy; concurrency: number; budget?: number; timeout?: number; guard: GuardMode; yes?: boolean; json?: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      if (!flags.fixes?.length) throw new InvalidArgumentError('give the failing runs to repair: --fixes <runs>');
      if (flags.pr && !flags.branch) throw new InvalidArgumentError('--pr opens a pull request from the branch --branch <name> makes; give both');
      if (flags.goldens && !flags.apply && !flags.branch) throw new InvalidArgumentError('--goldens puts recordings into the project, which happens with --apply or --branch');
      const rule = attemptRule(flags, { defaults: SPRT_DEFAULTS, passes: (n) => Math.ceil(0.8 * n) });
      const expect = flags.expect !== undefined ? readExpectJson(flags.expect) : null;
      const spec = expect?.spec ?? null;
      const undecidable = undecidableRefusal(spec, 'repair');
      if (undecidable) throw new InvalidArgumentError(undecidable);
      const config = loadConfig(process.cwd());
      const repairerSpec = flags.repairer ?? config.repair?.repairer;
      let repairer: Repairer | null = null;
      try {
        repairer = repairerSpec ? parseRepairer(repairerSpec) : null;
      } catch (err) {
        throw new InvalidArgumentError((err as Error).message);
      }

      const store = readStore(opts);
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
        process.exitCode = EXIT.usage;
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
      log(p.dim(`  repairer: ${repairer ? (repairer.model ? `${repairer.provider}:${repairer.model}` : `${repairer.provider}, with its own default model`) : 'none (--repairer)'} · the gate: ${rule.gate ? describeGate(rule.gate) : `${rule.needed} of ${rule.attempts} attempts per run`} · writes ${flags.writes === 'stub' ? 'stubbed' : 'blocked'}${flags.budget ? ` · budget ${formatBudget(flags.budget)}` : ''}`));

      const settings = { attempts: rule.attempts, needed: rule.needed, gate: rule.gate, concurrency: flags.concurrency, candidates: flags.candidates, stronger: flags.stronger ?? null, scope: flags.scope ?? null, rescueFields: parseFields(flags.set, undefined), maxGrowth: flags.maxGrowth, build: flags.build ?? null, repairer: repairer ?? { provider: 'anthropic' as const, model: '' }, spec, expect: expect?.json ?? null, writes: flags.writes, reads: flags.reads, liveTools: [], budget: flags.budget ?? null, timeoutMs: flags.timeout === undefined ? null : flags.timeout * 1000, guard: flags.guard };
      const outputs = { apply: !!flags.apply, branch: flags.branch ?? null, pr: !!flags.pr, goldens: flags.goldens ?? null };
      try {
        // The repair, and its hand-over. One that fails part way (a push or `gh` refused, a file changed)
        // still leaves the repair and its verdict to keep: the fix it verified is verified whatever happened after.
        let report: RepairReport;
        let handOverFailed: HandOverError | null = null;
        try {
          // How long the repairer may take: the flag, else the config, else the default (repairer.ts).
          const repairerTimeout = flags.repairerTimeout ?? config.repair?.timeout;
          report = await runRepair({ opts, targets, holdout: held, good, heldOutAutomatically, settings: { ...settings, repairerConfigured: repairer !== null, ...(repairerTimeout !== undefined ? { repairerTimeoutMs: repairerTimeout * 1000 } : {}) }, outputs, log });
        } catch (err) {
          if (!(err instanceof HandOverError)) throw err;
          handOverFailed = err;
          report = err.report;
        }
        // Kept with the fix its blames opened or joined: accepted, it turns the fix verified; empty, the
        // fix stays open with every candidate tried and why each was dropped.
        const line = repairCommand(
          { fixes: flags.fixes, holdout: flags.holdout, keeps: flags.keeps },
          {
            expect: expect?.json ?? null,
            ...(repairerSpec ? { repairer: repairerSpec } : {}),
            candidates: flags.candidates,
            ...(flags.stronger ? { stronger: flags.stronger } : {}),
            ...(flags.scope ? { scope: flags.scope } : {}),
            set: settings.rescueFields,
            attempts: rule.attempts,
            ...(flags.passes !== undefined ? { passes: flags.passes } : {}),
            gate: rule.gate,
            maxGrowth: flags.maxGrowth,
            build: flags.build ?? null,
            writes: flags.writes,
            reads: flags.reads,
            budget: flags.budget ?? null,
            timeoutMs: settings.timeoutMs,
            argv: command.length ? command : null,
          },
        );
        // Where --apply --goldens put the recordings, relative to the project as the store keeps paths: the ones that got there.
        const goldensCopied = report.output.applied && flags.goldens ? report.output.goldens.map((g) => resolve(flags.goldens!, basename(g))).filter((to) => existsSync(to)).map((to) => relative(process.cwd(), to)) : undefined;
        const kept = recordRepairFix(opts, report, { expect: expect?.json ?? null, command: line, ...(goldensCopied ? { goldensCopied } : {}) });
        // Each candidate's verification as verify --json prints one: the accepted one's with the verdict it was kept as.
        const candidates = report.candidates.map((c) => ({ ...c, verify: c.verify ? verifyJson(c.verify, c.id === report.accepted && kept?.verdict ? { verifyId: kept.verdict.verifyId, fixes: kept.fixes } : null) : null }));
        const json = { ...report, candidates, repairId: kept?.repair.repairId ?? null, verifyId: kept?.verdict?.verifyId ?? null, fixes: keptFixes(kept?.fixes ?? []), ...(handOverFailed ? { error: { message: handOverFailed.message } } : {}) };
        if (flags.json) process.stdout.write(JSON.stringify(json, null, 2) + '\n');
        else {
          // Open still, with the candidates it tried, or with none when no repairer proposed any (the report says why).
          const what = (f: StoredFix, standing: VerdictStanding | null) => (!kept!.repair.accepted ? (report.candidates.length ? 'still open, with the candidates tried' : 'still open') : standing ? standingWords('accepted', standing, f.status) : f.status);
          process.stdout.write('\n' + formatRepair(report, p) + '\n' + (kept?.fixes ?? []).map(({ fix: f, standing }) => fixLine(f, what(f, standing))).join(''));
          if (handOverFailed) process.stderr.write(`\n${p.red('✗')} ${handOverFailed.message}\n`);
        }
        for (const { fix: f } of kept?.fixes ?? []) emitJobEvent({ type: 'link', label: 'Open the fix', href: fixHref(f.fixId, 'repair') });
        if (report.output.patch) emitJobEvent({ type: 'file', path: report.output.patch, label: 'fix.patch' });
        emitJobEvent({ type: 'result', data: json });
        // Fixed and handed over, 0; stopped before a verdict, by its reason; no fix, or a hand-over that failed, 1.
        process.exitCode = report.outcome === 'fixed' && !handOverFailed ? EXIT.ok : report.outcome === 'stopped' ? stoppedStatus(report.why) : EXIT.failed;
      } catch (err) {
        if (!(err instanceof RepairError)) throw err;
        if (flags.json) process.stdout.write(JSON.stringify({ outcome: 'error', error: { message: err.message } }, null, 2) + '\n');
        else process.stderr.write(`\n${p.red('✗')} ${err.message}\n`);
        // Refused before anything ran: not in a git repository, another repair running here, a branch it can't make.
        process.exitCode = EXIT.usage;
      }
    });

  registerFixes(program);
}

/**
 * The status of a blame, verify or repair that stopped before its verdict, by why: a stop signal's
 * own; 3 for a budget spent; 2 for an agent whose Node is too old for the guard; 1 otherwise.
 */
function stoppedStatus(reason: string | null): number {
  if (stoppedBy() || reason === 'interrupted') return interruptedStatus();
  if (reason?.includes('budget')) return EXIT.inconclusive;
  if (reason === AGENT_NODE_TOO_OLD) return EXIT.usage;
  return EXIT.failed;
}

/**
 * Why blame could not start or could not trust what it saw, as a status: the run has no model call
 * to probe, or a budget was given for a model with no price, 2; what it saw could not be decided, 3;
 * cut short by a signal, its status; the run passes, or does not replay as recorded, 1.
 */
function blameErrorStatus(reason: BlameError['reason']): number {
  if (reason === 'interrupted' || stoppedBy()) return interruptedStatus();
  if (reason === 'no-model-calls' || reason === 'unpriced') return EXIT.usage;
  if (reason === 'inconclusive') return EXIT.inconclusive;
  return EXIT.failed;
}

/** What `fix pr` was given that it can't record, or a fix with no pull request to read. */
class FixPrError extends Error {}

/** The repairer shadowlap.config.json names, if it names one and can be read. */
function configuredRepairer(): string | null {
  try {
    return loadConfig(process.cwd()).repair?.repairer ?? null;
  } catch {
    return null;
  }
}

/** A fix by its id or a unique prefix, or a FixIdError that says where to find one. */
function requireFix(store: Store, idOrPrefix: string): StoredFix {
  const fix = resolveFix(store, idOrPrefix);
  if (!fix) {
    const note = missingStoreNote(store);
    throw new FixIdError(`no fix matches "${idOrPrefix.trim()}"${note ? `: ${note}` : ' (see: shadowlap fix ls)'}`, 'unknown');
  }
  return fix;
}

/** A fix id that names no fix, or several: as JSON with `--json`, else as an error. */
function fixIdFailed(err: unknown, arg: string, json: boolean | undefined): void {
  if (!(err instanceof FixIdError)) throw err;
  if (!json) throw err;
  process.stdout.write(JSON.stringify({ fixId: arg, status: 'error', error: { reason: err.reason, message: err.message } }, null, 2) + '\n');
  process.exitCode = EXIT.usage;
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
      const store = readStore(program.opts<GlobalOpts>());
      try {
        const list = fixList(store, flags.status ? { status: flags.status } : {});
        const note = missingStoreNote(store);
        process.stdout.write((flags.json ? JSON.stringify(list, null, 2) : note ? p.dim(`No fixes: ${note}`) : formatFixList(list, p)) + '\n');
      } finally {
        store.close();
      }
    });

  fix
    .command('show')
    .description('A fix and its three steps: where the run was lost, the change proposed for it, and every verdict on it')
    .argument('<fix>', 'a fix id or a unique prefix of it, such as fx-01K5CQ2E8M')
    .option('--json', 'print the fix as JSON, as the dashboard reads it')
    .action(async (arg: string, flags: { json?: boolean }) => {
      const store = readStore(program.opts<GlobalOpts>());
      try {
        const repairer = configuredRepairer();
        // The repair it suggests next, whether its repairer can be asked from here (claude on the PATH),
        // and whether a verified fix's patch is in this working tree already, which apply only marks applied.
        const fix = requireFix(store, arg);
        const patchInTree = await patchesInTree(process.cwd(), patchesToCheck(store, [fix]));
        const detail = fixDetail(store, fix.fixId, { repairer, checkRepairer: repairerProblem, patchInTree })!;
        process.stdout.write((flags.json ? JSON.stringify(detail, null, 2) : formatFixDetail(detail, p, { repairer })) + '\n');
      } catch (err) {
        fixIdFailed(err, arg, flags.json);
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
      const store = readStore(program.opts<GlobalOpts>());
      try {
        const updated = setFixTitle(store, requireFix(store, arg).fixId, words.join(' '));
        process.stdout.write(`${shortFixId(updated.fixId)} · ${safe(updated.title)}\n`);
      } finally {
        store.close();
      }
    });

  fix
    .command('pr')
    .description("A fix's pull request: record the one opened for it (CI's fix on failure does), or, with no url, read where it stands from GitHub with gh and record that: open, merged or closed")
    .argument('<fix>', 'a fix id or a unique prefix of it')
    .argument('[url]', 'the pull request opened for it')
    .option('--json', "print the fix's pull request as JSON")
    .action(async (arg: string, url: string | undefined, flags: { json?: boolean }) => {
      const store = readStore(program.opts<GlobalOpts>());
      try {
        const found = requireFix(store, arg);
        let pr = found.data.source?.pr ?? null;
        let note: string | null = null;
        if (url !== undefined) {
          if (!/^https?:\/\/\S+$/.test(url) || url.length > 2048) throw new FixPrError(`${url.slice(0, 80)} is not a pull request's address: give its https:// link`);
          pr = { url, number: prNumber(url), state: 'open', at: Date.now() };
          store.mergeFixData(found.fixId, { source: { pr } });
        } else {
          if (!pr) throw new FixPrError(`${shortFixId(found.fixId)} has no pull request: record one with shadowlap fix pr ${shortFixId(found.fixId)} <url>`);
          // Only a host this project uses is asked: a fix pulled from the team store can name any, and gh would send it a token.
          const hosts = await readableHosts(process.cwd());
          const read = hosts.has(prHost(pr.url)) ? await new Promise<PrRead>((done) => ghReader({ readable: (u) => hosts.has(prHost(u)) })(pr!.url, done)) : null;
          if (read?.state) {
            if (read.state !== (pr.state ?? 'open')) store.mergeFixData(found.fixId, { source: { pr: { state: read.state } } });
            pr = { ...pr, state: read.state };
          } else if (!read) note = `${prHost(pr.url) || 'its host'} is neither github.com, GH_HOST nor this project's origin, so gh isn't asked and its state is as recorded`;
          else note = read.unusable ? 'gh is not installed or not signed in, so its state is as recorded' : 'gh could not read it, so its state is as recorded';
        }
        if (flags.json) process.stdout.write(JSON.stringify({ fixId: found.fixId, pr, ...(note ? { note } : {}) }, null, 2) + '\n');
        else process.stdout.write(`${shortFixId(found.fixId)} · PR ${pr.number !== null ? `#${pr.number}` : pr.url} ${pr.state ?? 'open'}${note ? p.dim(` · ${note}`) : ''}\n`);
      } catch (err) {
        if (err instanceof FixIdError) return fixIdFailed(err, arg, flags.json);
        if (!(err instanceof FixPrError)) throw err;
        if (flags.json) process.stdout.write(JSON.stringify({ fixId: arg, status: 'error', error: { message: err.message } }, null, 2) + '\n');
        else process.stderr.write(`${p.red('✗')} ${err.message}\n`);
        process.exitCode = EXIT.usage;
      } finally {
        store.close();
      }
    });

  fix
    .command('apply')
    .description("Apply a verified fix: git apply its repair's patch, copy the recordings the fixed code made into the goldens folder, run shadowlap test on them, and mark the fix applied. On an applied fix, finish what is left")
    .argument('<fix>', 'a fix id or a unique prefix of it')
    .option('--goldens <dir>', "the project's goldens folder, where the repair's recordings go", 'goldens')
    .option('--no-test', 'copy the recordings without running shadowlap test on them')
    .option('--build <command>', 'rebuild the agent after the patch is applied, before the test')
    .option('--json', 'print what was done as JSON (progress still goes to stderr)')
    .action(async (arg: string, flags: { goldens: string; test: boolean; build?: string; json?: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      const store = readStore(opts);
      const log = (line: string) => process.stderr.write(`${line}\n`);
      try {
        const found = requireFix(store, arg);
        if (found.status === 'open') {
          const detail = fixDetail(store, found.fixId);
          const next = detail?.actions.repair?.argv;
          const other = detail?.verify.find((v) => v.verdict === 'accepted' && !v.counts);
          const why = other ? `a change was accepted, but under another check than this fix's (${detail!.check}), so it doesn't count.` : 'no change has been verified for it yet, so there is nothing to apply.';
          const fixFirst = other ? `Verify it under this fix's check:\n  ${quoteArgv(['shadowlap', 'verify', ...(next?.slice(1) ?? [])])}` : next ? `Repair it first:\n  ${repairLine(next, configuredRepairer())}` : '';
          throw new ApplyError(`${shortFixId(found.fixId)} is open: ${why}${fixFirst ? ` ${fixFirst}` : ''}`, EXIT.usage);
        }
        if (found.status !== 'applied') log(`${p.yellow('⑂')} Applying ${shortFixId(found.fixId)} · ${safe(found.title)}`);
        const result = await applyFix(store, found, { cwd: process.cwd(), goldens: flags.goldens, test: flags.test, build: flags.build ?? null, db: opts.db, log });
        if (flags.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        else if (result.status === 'already-applied') {
          // Only --no-test leaves a test undone here: say so rather than that nothing is left. A
          // teammate's repair, from the team store, left its recordings on their machine: none to test here.
          const repair = acceptedRepair(store, found);
          const untested = applyLeft(found, repair, { pulled: !!repair && store.repairPulled(repair.repairId) !== null })?.test;
          const left = untested ? `, but its goldens ${result.tests === 'failed' ? 'failed their last test' : 'are not tested yet'}: run it without --no-test to test them` : '; nothing is left to do';
          process.stdout.write(`${untested ? p.yellow('!') : p.green('✓')} ${shortFixId(found.fixId)} is already applied${found.appliedAt ? ` (${ago(found.appliedAt)})` : ''}${left}\n`);
        } else {
          // With no patch, a change of request fields (--set, --model) is named: the agent makes it, not a file.
          const change = result.patch === 'none' ? fieldChange(fixRecords(store, found)) : null;
          const what = [
            result.patch === 'applied' ? 'the patch is in the working tree' : result.patch === 'already' ? 'the patch was already in the working tree' : change ? `verified with ${safe(change)}; no patch, set it in your agent` : 'verified on the working tree, no patch to apply',
            ...(result.goldens.length ? [`${result.goldens.filter((g) => g.copied).length} of ${result.goldens.length} golden${result.goldens.length === 1 ? '' : 's'} copied to ${folder(flags.goldens)}`] : []),
            ...(result.tests !== 'skipped' ? [`shadowlap test ${result.tests}`] : []),
          ];
          process.stdout.write(`${clauses(`${result.tests === 'failed' ? p.red('✗') : p.green('✓')} ${shortFixId(found.fixId)} ${result.again ? 'finished applying' : 'applied'}: `, what)}\n`);
          if (result.tests === 'failed') process.stdout.write(p.dim(`  the fix stays applied; once the test passes, run shadowlap fix apply ${shortFixId(found.fixId)} again\n`));
          if (result.update) {
            const n = result.outdated.length;
            process.stdout.write(`${p.yellow('!')} ${n === 1 ? '1 other golden diverges' : `${n} other goldens diverge`} on what the patch changed: re-record ${n === 1 ? 'it' : 'them'} once the change is what you meant\n  ${safe(result.update)}\n`);
          }
        }
        // Goldens to re-record are the next thing to do: the drawer offers Update goldens, and the fix beside it.
        emitJobEvent({ type: 'link', label: 'Open the fix', href: fixHref(found.fixId), ...(result.update ? { secondary: true } : {}) });
        emitJobEvent({ type: 'result', data: result });
        process.exitCode = result.tests === 'failed' ? EXIT.failed : EXIT.ok;
      } catch (err) {
        if (err instanceof FixIdError) return fixIdFailed(err, arg, flags.json);
        if (!(err instanceof ApplyError)) throw err;
        if (flags.json) process.stdout.write(JSON.stringify({ fixId: arg, status: 'error', error: { message: err.message } }, null, 2) + '\n');
        else process.stderr.write(`${p.red('✗')} ${err.message}\n`);
        process.exitCode = err.exitCode;
      } finally {
        store.close();
      }
    });
}
