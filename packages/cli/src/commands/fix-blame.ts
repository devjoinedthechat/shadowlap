import { InvalidArgumentError } from 'commander';
import { BLAME_DEFAULTS, blameBound, blameSteps, commandIsImported, describeRescue, dimLines, fitLine, formatBlame, hasRecordedCommand, riskPercent, rescueRule, unsettledFirst, type ReadPolicy, type RunRecord, whole } from '@shadowlap/engine';
import { fixHref } from '@shadowlap/dashboard';
import { formatAttemptsUnrecorded } from '../attempt-unrecorded.js';
import { formatBudget, undecidableRefusal } from '../attempts.js';
import { BlameError, blameRuleOf, runBlame, type BlameRun } from '../blame.js';
import { EXIT } from '../exit-codes.js';
import { blameCommand } from '../fixes.js';
import { emitJobEvent } from '../job-events.js';
import { progressLog } from '../progress.js';
import type { GuardMode } from '../run-agent.js';
import { confirmImportedCommand, readStore, requireRun, withoutCommand, type GlobalOpts } from '../shared.js';
import { columnsOf, palette as p, quoteArgv, safe, shortId } from '../ui.js';
import { allowedUnrecorded, refuseUnrecorded } from '../unrecorded.js';
import { attemptRule, parseFields, readExpectJson } from './fix-flags.js';
import { blameErrorStatus, blameJson, fixLine, stoppedStatus } from './fix-report.js';

/**
 * `shadowlap blame`: where a failed run was lost. parseBlame reads what it was asked against the
 * run; blameRun says what the search will do, runs it (blame.ts), and reports it with the status
 * its verdict ends with.
 */

/** The flags of `shadowlap blame`, as commander gives them. */
export interface BlameFlags {
  expect?: string;
  gate?: string;
  attempts?: number;
  passes?: number;
  model?: string;
  set?: string[];
  scope?: string;
  scan: number;
  writes: 'stub' | 'block';
  reads: ReadPolicy;
  concurrency: number;
  budget?: number;
  timeout?: number;
  guard: GuardMode;
  allowUnrecorded?: string[];
  yes?: boolean;
  json?: boolean;
}

/** A blame as it was asked for, read against the run it probes. */
export interface BlameRequest {
  rule: ReturnType<typeof attemptRule>;
  expect: ReturnType<typeof readExpectJson> | null;
  fields: Record<string, unknown>;
  parent: RunRecord;
  /** The run's model calls that can be probed: those made in --scope, when it is given. */
  steps: number;
  argv: string[];
  commandFromImport: boolean;
}

/** `shadowlap blame <run> [-- command]`. */
export async function blameRun(opts: GlobalOpts, runArg: string, command: string[], flags: BlameFlags): Promise<void> {
  const request = await parseBlame(opts, runArg, command, flags);
  if (!request) {
    process.exitCode = EXIT.usage;
    return;
  }
  const { rule, expect, fields, parent, argv, commandFromImport } = request;
  // In a terminal each probe's attempts fold into one line that counts them; -v keeps every line.
  const progress = progressLog(process.stderr, !opts.verbose);
  const log = progress.log;
  for (const line of blamePlan(request, flags, columnsOf(process.stderr))) log(line);
  try {
    const settings = { attempts: rule.attempts, needed: rule.needed, gate: rule.gate, concurrency: flags.concurrency, scan: flags.scan, scope: flags.scope ?? null, writes: flags.writes, reads: flags.reads, liveTools: [], fields, spec: expect?.spec ?? null, expect: expect?.json ?? null, budget: flags.budget ?? null, timeoutMs: flags.timeout === undefined ? null : flags.timeout * 1000, guard: flags.guard, allowUnrecorded: [...allowedUnrecorded(flags.allowUnrecorded)] };
    const report = await runBlame({
      opts,
      parent,
      argv,
      commandFromImport,
      settings,
      command: blameCommand(parent.runId, { ...settings, argv: command.length ? command : null }),
      log,
    }).finally(() => progress.done());
    reportBlame(report, flags);
  } catch (err) {
    if (!(err instanceof BlameError)) throw err;
    if (flags.json) process.stdout.write(JSON.stringify({ runId: parent.runId, outcome: 'error', error: { reason: err.reason, message: err.message }, judge: err.judge }, null, 2) + '\n');
    else process.stderr.write(`\n${p.red('✗')} ${err.message}\n`);
    process.exitCode = blameErrorStatus(err.reason);
  }
}

/** The flags read, and the run blame probes; null when its command needs a yes it didn't get. */
async function parseBlame(opts: GlobalOpts, runArg: string, command: string[], flags: BlameFlags): Promise<BlameRequest | null> {
  const rule = attemptRule(flags, { defaults: BLAME_DEFAULTS, passes: (n) => Math.min(2, n) });
  const expect = flags.expect !== undefined ? readExpectJson(flags.expect) : null;
  const undecidable = undecidableRefusal(expect?.spec ?? null, 'blame');
  if (undecidable) throw new InvalidArgumentError(undecidable);
  const fields = parseFields(flags.set, flags.model);

  const store = readStore(opts);
  let parent: RunRecord;
  let steps: number;
  try {
    parent = requireRun(store, runArg);
    // The model calls the search probes, as runBlame finds them: a judge check's are none of them.
    steps = blameSteps(store.getCalls(parent.runId), flags.scope).length;
    // Every probe replays the run: a tool its model called that it never recorded, which writes, would run again for real.
    refuseUnrecorded(store, parent, allowedUnrecorded(flags.allowUnrecorded));
  } finally {
    store.close();
  }
  if (!command.length && !hasRecordedCommand(parent)) {
    throw new InvalidArgumentError(`${shortId(parent.runId)} ${withoutCommand(parent)} and has no command to re-run. Give yours after --:\n  shadowlap blame ${shortId(parent.runId)} -- python agent.py`);
  }
  const argv = command.length ? command : parent.command.argv;
  const commandFromImport = !command.length && commandIsImported(parent);
  if (commandFromImport && !flags.yes && !(await confirmImportedCommand(parent, argv))) return null;
  return { rule, expect, fields, parent, steps, argv, commandFromImport };
}

/**
 * What the search will do, said before it starts: the run, each probe's rule, and the most probes and
 * attempts it makes, as the engine bounds the search runBlame runs (blameBound), each dim line fit to
 * a terminal `columns` wide (null: a pipe or a file).
 */
export function blamePlan({ rule, fields, parent, steps, argv }: Pick<BlameRequest, 'rule' | 'fields' | 'parent' | 'steps' | 'argv'>, flags: Pick<BlameFlags, 'scan' | 'scope' | 'writes' | 'budget'>, columns: number | null): string[] {
  const bound = blameBound(steps, blameRuleOf({ gate: rule.gate, attempts: rule.attempts, scan: flags.scan }));
  const most = bound.probes;
  const attempts = most * bound.each;
  const each = rule.gate ? rescueRule({ gate: rule.gate, needed: 0, attemptsPerProbe: rule.gate.max, probeBudget: most }) : `${rule.attempts} attempts, a rescue at ${rule.needed} passing`;
  // Under a gate its risk is the whole search's, spent across the most probes it makes.
  const spent = rule.gate ? `, the ${riskPercent(rule.gate.risk)} risk spent across them` : '';
  return [
    // The agent's command stays in one piece, as it is copied.
    ...fitLine(`${p.yellow('⑂')} Blaming ${shortId(parent.runId)} ${p.dim(`(${whole(safe(quoteArgv(argv)))})`)}: ${steps} model call${steps === 1 ? '' : 's'}${flags.scope ? ` in scope ${safe(flags.scope)}` : ''}`, columns),
    ...dimLines(p, '  ', `each probe: ${describeRescue(fields)}, ${each} · writes ${flags.writes === 'stub' ? 'stubbed' : 'blocked'}${flags.budget ? ` · budget ${formatBudget(flags.budget)}` : ''}`, columns),
    ...dimLines(p, '  ', `at most ${most} probe${most === 1 ? '' : 's'}${spent} and ${attempts} attempt${attempts === 1 ? '' : 's'}${bound.pin ? `, and ${bound.pin} more to check a call they pin` : ''}; every call before a probe replays from the recording for free`, columns),
  ];
}

/** The report, as text or JSON, what its attempts ran unrecorded, its job's links, and its status. */
function reportBlame(report: BlameRun, flags: BlameFlags): void {
  if (flags.json) process.stdout.write(JSON.stringify(blameJson(report), null, 2) + '\n');
  else process.stdout.write('\n' + formatBlame(report, p, columnsOf(process.stdout)) + '\n' + (report.fix ? fixLine(report.fix, report.fix.opened ? 'opened' : 'joined', columnsOf(process.stdout)) : ''));
  // What the probes' attempts ran that nothing recorded, a write unstubbed: said once, after the report.
  const ranBlame = formatAttemptsUnrecorded(report.probes.flatMap((x) => x.attempts.map((a) => a.unrecordedTools)));
  if (ranBlame) process.stderr.write('\n' + ranBlame);
  if (report.contrast) emitJobEvent({ type: 'run', runId: report.contrast.rescuedRunId, role: 'passing' });
  if (report.fix) emitJobEvent({ type: 'link', label: 'Open the fix', href: fixHref(report.fix.fixId, 'blame') });
  emitJobEvent({ type: 'result', data: blameJson(report) });
  // A verdict (a blamed call, or none that rescues the run), 0; stopped before one, by its reason;
  // not settled from the first model call, which is no verdict, 3.
  process.exitCode = report.outcome === 'stopped' ? stoppedStatus(report.stopReason) : unsettledFirst(report) ? EXIT.inconclusive : EXIT.ok;
}
