import { InvalidArgumentError } from 'commander';
import { ACTIONS, describeBaselineRule, describeGate, dimLines, formatVerify, GATE_MAX_ATTEMPTS, KEPT_DEFAULTS, SPRT_DEFAULTS, type ReadPolicy, type RunRecord, type VerifyReport, type VerifyRole } from '@shadowlap/engine';
import { fixHref } from '@shadowlap/dashboard';
import { formatAttemptsUnrecorded } from '../attempt-unrecorded.js';
import { formatBudget, undecidableRefusal } from '../attempts.js';
import { buildCommand, configBuildNote, loadConfig } from '../config.js';
import { EXIT, interruptedStatus, stoppedBy } from '../exit-codes.js';
import { recordVerifyFix, verifyCommand, verifyRerun, type VerifyFlags } from '../fixes.js';
import { emitJobEvent } from '../job-events.js';
import { progressLog } from '../progress.js';
import type { GuardMode } from '../run-agent.js';
import { readStore, type GlobalOpts } from '../shared.js';
import { columnsOf, palette as p, shortId } from '../ui.js';
import { allowedUnrecorded, refuseUnrecorded } from '../unrecorded.js';
import { runVerify, type VerifyBaseline } from '../verify.js';
import { resolveBase } from '../verify-base.js';
import { attemptRule, parseFields, readExpectJson, selectRuns, targetsOf } from './fix-flags.js';
import { fixLine, standingWords, verifyAttempts, verifyJson } from './fix-report.js';

/**
 * `shadowlap verify`: a change checked before it ships, against failing runs it must now fix and
 * good runs it must not leave worse than their baseline. parseVerify reads the flags and what good
 * runs are kept against, chooseRuns the runs each flag names, and verifyRuns runs the verification
 * (verify.ts) and reports its verdict, which it keeps with the fix of its failing runs.
 */

/** The flags of `shadowlap verify`, as commander gives them. */
export interface VerifyCommandFlags {
  fixes?: string[];
  holdout?: string[];
  keeps?: string[];
  expect?: string;
  gate?: string;
  attempts?: number;
  passes?: number;
  model?: string;
  set?: string[];
  from?: string[];
  liveTool?: string[];
  writes: 'stub' | 'block';
  reads: ReadPolicy;
  concurrency: number;
  budget?: number;
  timeout?: number;
  failFast?: boolean;
  margin?: number;
  keptMax?: number;
  baseline?: 'paired' | 'history';
  base?: string;
  build?: string;
  guard: GuardMode;
  allowUnrecorded?: string[];
  yes?: boolean;
  json?: boolean;
}

/** What a verify was asked, read: how a run decides, the checks, the change's fields, and what good runs are kept against. */
export interface VerifyRequest {
  rule: ReturnType<typeof attemptRule>;
  expect: ReturnType<typeof readExpectJson> | null;
  fields: Record<string, unknown>;
  baseline: VerifyBaseline;
}

type VerifyRuns = Parameters<typeof runVerify>[0]['runs'];

/** `shadowlap verify [-- command]`. */
export async function verifyRuns(opts: GlobalOpts, command: string[], flags: VerifyCommandFlags): Promise<void> {
  const request = parseVerify(flags);
  const chosen = chooseRuns(opts, flags);
  const resolved = await targetsOf([...chosen.values()].map((x) => x.run), command, flags.yes, 'verify');
  if (!resolved) {
    process.exitCode = EXIT.usage;
    return;
  }
  const runs: VerifyRuns = resolved.map((t) => ({ ...t, role: chosen.get(t.parent.runId)!.role }));
  const { rule, expect, fields, baseline } = request;
  const progress = progressLog(process.stderr, !opts.verbose);
  const log = progress.log;
  for (const line of verifyPlan(request, runs, flags, columnsOf(process.stderr))) log(line);
  const report = await runVerify({
    opts,
    runs,
    settings: { attempts: rule.attempts, needed: rule.needed, gate: rule.gate, concurrency: flags.concurrency, fields, ...(flags.from?.length ? { fromModels: flags.from } : {}), failFast: !!flags.failFast, spec: expect?.spec ?? null, expect: expect?.json ?? null, writes: flags.writes, reads: flags.reads, liveTools: flags.liveTool ?? [], budget: flags.budget ?? null, timeoutMs: flags.timeout === undefined ? null : flags.timeout * 1000, guard: flags.guard, allowUnrecorded: [...allowedUnrecorded(flags.allowUnrecorded)], ...(rule.gate ? { baseline } : {}), ...(flags.margin !== undefined ? { margin: flags.margin } : {}), ...(flags.keptMax !== undefined ? { keptMax: flags.keptMax } : {}) },
    log,
  }).finally(() => progress.done());
  reportVerify(opts, report, request, command, flags);
}

/** The flags checked against each other, and what good runs are kept against: the same runs under the code before the change, or history. */
function parseVerify(flags: VerifyCommandFlags): VerifyRequest {
  const rule = attemptRule(flags, { defaults: SPRT_DEFAULTS, passes: (n) => Math.ceil(0.8 * n) });
  const expect = flags.expect !== undefined ? readExpectJson(flags.expect) : null;
  const undecidable = undecidableRefusal(expect?.spec ?? null, 'verify');
  if (undecidable) throw new InvalidArgumentError(undecidable);
  const fields = parseFields(flags.set, flags.model);
  if (flags.from?.length && !Object.keys(fields).length) throw new InvalidArgumentError('--from names the model calls --model and --set change: give one of them');
  const source = flags.baseline ?? loadConfig(process.cwd()).verify?.baseline ?? 'paired';
  if (source === 'history' && (flags.base !== undefined || flags.build !== undefined)) throw new InvalidArgumentError('--base and --build check out the code a paired baseline runs at: give them without --baseline history');
  if (!rule.gate && (flags.margin !== undefined || flags.keptMax !== undefined || flags.baseline !== undefined || flags.base !== undefined || flags.build !== undefined)) throw new InvalidArgumentError('a fixed count (--attempts, --passes) judges every run on its own: --margin, --kept-max, --baseline, --base and --build are for the gate, which keeps a good run against its baseline');
  if (flags.keptMax !== undefined && (flags.keptMax < 1 || flags.keptMax > GATE_MAX_ATTEMPTS)) throw new InvalidArgumentError(`--kept-max is a whole number from 1 to ${GATE_MAX_ATTEMPTS}`);
  if (source === 'history') return { rule, expect, fields, baseline: { source: 'history' } };
  // The checkout of the code before the change builds as --build says, else as the config's build does.
  const found = resolveBase(process.cwd(), { base: flags.base, fields: Object.keys(fields).length > 0, build: buildCommand(flags.build, () => loadConfig(process.cwd())).command });
  // A commit named that isn't one is a mistake; a working tree with nothing to compare is not.
  if ('none' in found && flags.base !== undefined) throw new InvalidArgumentError(found.none);
  return { rule, expect, fields, baseline: 'base' in found ? { source: 'paired', base: found.base } : { source: 'none', why: found.none } };
}

/** The runs each flag names, each with its one role; refused when a run is given two, or none is given. */
function chooseRuns(opts: GlobalOpts, flags: VerifyCommandFlags): Map<string, { run: RunRecord; role: VerifyRole; flag: string }> {
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
    // Every attempt replays its run: a tool the model called that the run never recorded, which writes, would run again for real.
    for (const { run } of chosen.values()) refuseUnrecorded(store, run, allowedUnrecorded(flags.allowUnrecorded));
  } finally {
    store.close();
  }
  if (!chosen.size) throw new InvalidArgumentError('give the runs to verify: --fixes <runs> for failing runs the change fixes, --keeps label:good for runs it must not break');
  return chosen;
}

/**
 * What the verification will do, said before it starts: the runs by role, how each decides, and how a
 * good run that forks is kept, each dim line fit to a terminal `columns` wide (null: a pipe or a file).
 */
export function verifyPlan({ rule, baseline }: Pick<VerifyRequest, 'rule' | 'baseline'>, runs: ReadonlyArray<{ role: VerifyRole }>, flags: Pick<VerifyCommandFlags, 'writes' | 'budget' | 'margin' | 'keptMax' | 'build'>, columns: number | null): string[] {
  const n = (role: VerifyRole) => runs.filter((r) => r.role === role).length;
  const counts = [n('target') ? `${n('target')} to fix` : '', n('holdout') ? `${n('holdout')} held out` : '', n('good') ? `${n('good')} to keep` : ''].filter(Boolean).join(', ');
  const decides = rule.gate ? `each run's gate: ${describeGate(rule.gate)}` : `a run passes at ${rule.needed} of ${rule.attempts} attempts`;
  const lines = [`${p.yellow('⑂')} Verifying the code as it is now against ${runs.length} run${runs.length === 1 ? '' : 's'} (${counts})`, ...dimLines(p, '  ', `${decides}; one that replays clean is settled by its first · writes ${flags.writes === 'stub' ? 'stubbed' : 'blocked'}${flags.budget ? ` · budget ${formatBudget(flags.budget)}` : ''}`, columns)];
  // How a good run that forks is kept: against its baseline, or, when there is none, by its gate alone.
  if (rule.gate && n('good')) {
    const margin = flags.margin ?? loadConfig(process.cwd()).verify?.margin ?? KEPT_DEFAULTS.margin;
    const max = flags.keptMax ?? loadConfig(process.cwd()).verify?.max ?? KEPT_DEFAULTS.max;
    if (baseline.source === 'none') lines.push(...dimLines(p, '  ', `a good run that forks: by its gate on its own, as ${baseline.why}`, columns));
    else lines.push(...dimLines(p, '  ', `a good run that forks: ${describeBaselineRule({ margin, risk: rule.gate.risk, max, source: baseline.source, revision: baseline.source === 'paired' ? (baseline.base.revision ? baseline.base.label : 'the working tree, without the change') : null })}`, columns));
    // A checkout of a commit built as the config says, nobody having typed --build: said, as every command that runs it says it.
    if (baseline.source === 'paired' && baseline.base.revision && baseline.base.build && flags.build === undefined) lines.push(...dimLines(p, '  ', configBuildNote(baseline.base.build), columns));
  }
  return lines;
}

/**
 * The verdict, kept whatever it is: it turns the fix of its failing runs verified when it accepts and
 * counts there (it checked the fix's own check, on a run that failed it as recorded). Then the report,
 * as text or JSON, what its attempts ran unrecorded, its job's links, and its status.
 */
function reportVerify(opts: GlobalOpts, report: VerifyReport, { rule, expect, fields }: VerifyRequest, command: string[], flags: VerifyCommandFlags): void {
  const step: VerifyFlags = { expect: expect?.json ?? null, attempts: rule.attempts, ...(flags.passes !== undefined ? { passes: flags.passes } : {}), gate: rule.gate, fields, from: flags.from, liveTools: flags.liveTool ?? [], failFast: !!flags.failFast, margin: flags.margin, keptMax: flags.keptMax, baseline: flags.baseline, base: flags.base, build: flags.build ?? null, writes: flags.writes, reads: flags.reads, budget: flags.budget ?? null, timeoutMs: flags.timeout === undefined ? null : flags.timeout * 1000, argv: command.length ? command : null };
  const line = verifyCommand({ fixes: flags.fixes, holdout: flags.holdout, keeps: flags.keeps }, step);
  // Its flags kept apart from the line, which is only shown: Fixes runs it again from them.
  const kept = recordVerifyFix(opts, report, { expect: expect?.json ?? null, command: line, rerun: verifyRerun(step) });
  const json = verifyJson(report, kept ? { verifyId: kept.verdict.verifyId, fixes: kept.fixes } : null);
  if (flags.json) process.stdout.write(JSON.stringify(json, null, 2) + '\n');
  else process.stdout.write('\n' + formatVerify(report, p, columnsOf(process.stdout)) + '\n' + (kept?.fixes ?? []).map(({ fix: f, standing }) => fixLine(f, standingWords(report.verdict, standing, f.status), columnsOf(process.stdout))).join(''));
  const ranVerify = formatAttemptsUnrecorded(verifyAttempts(report).map((a) => a.unrecordedTools));
  if (ranVerify) process.stderr.write('\n' + ranVerify);
  for (const { fix: f } of kept?.fixes ?? []) emitJobEvent({ type: 'link', label: ACTIONS.openFix.label, href: fixHref(f.fixId, 'verify', kept!.verdict.verifyId) });
  emitJobEvent({ type: 'result', data: json });
  // Accepted, 0; rejected, 1; not finished (a run's gate undecided, the budget spent), 3.
  // A stop signal ends it with its own status whenever it came, the verdict reached or not.
  process.exitCode = stoppedBy() ? interruptedStatus() : report.verdict === 'accepted' ? EXIT.ok : report.verdict === 'rejected' ? EXIT.failed : EXIT.inconclusive;
}
