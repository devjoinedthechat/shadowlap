import { existsSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { InvalidArgumentError } from 'commander';
import { describeGate, dimLines, formatRepair, messageOf, SPRT_DEFAULTS, type ReadPolicy, type RepairReport, type RunRecord, type StoredFix, type VerdictStanding } from '@shadowlap/engine';
import { fixHref } from '@shadowlap/dashboard';
import { formatAttemptsUnrecorded } from '../attempt-unrecorded.js';
import { formatBudget, undecidableRefusal } from '../attempts.js';
import { loadConfig } from '../config.js';
import { EXIT, interruptedStatus, stoppedBy } from '../exit-codes.js';
import { recordRepairFix, repairCommand } from '../fixes.js';
import { emitJobEvent } from '../job-events.js';
import { progressLog } from '../progress.js';
import { HandOverError, RepairError, splitHoldout } from '../repair.js';
import { runRepair } from '../repair-run.js';
import { parseRepairer, type Repairer } from '../repairer.js';
import type { GuardMode } from '../run-agent.js';
import { readStore, type GlobalOpts } from '../shared.js';
import { columnsOf, palette as p, shortId } from '../ui.js';
import { allowedUnrecorded, refuseUnrecorded } from '../unrecorded.js';
import { attemptRule, parseFields, readExpectJson, selectRuns, targetsOf } from './fix-flags.js';
import { fixLine, keptFixes, standingWords, stoppedStatus, verifyAttempts, verifyJson } from './fix-report.js';

/**
 * `shadowlap repair`: failing runs fixed. parseRepair reads the flags and the repairer, chooseRuns
 * the runs each flag names, and repairRuns runs the repair (repair.ts) and its hand-over, then
 * reports what it kept with the fix its blames opened or joined.
 */

/** The flags of `shadowlap repair`, as commander gives them. */
export interface RepairFlags {
  fixes?: string[];
  holdout?: string[];
  keeps?: string[];
  expect?: string;
  repairer?: string;
  repairerTimeout?: number;
  candidates: number;
  stronger?: string;
  scope?: string;
  set?: string[];
  gate?: string;
  attempts?: number;
  passes?: number;
  maxGrowth: number;
  build?: string;
  apply?: boolean;
  branch?: string;
  pr?: boolean;
  goldens?: string;
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

/** What a repair was asked, read: how verify decides, the checks, the repairer as given and as read. */
export interface RepairRequest {
  rule: ReturnType<typeof attemptRule>;
  expect: ReturnType<typeof readExpectJson> | null;
  config: ReturnType<typeof loadConfig>;
  /** The repairer as the flag or the config names it. */
  repairerSpec: string | undefined;
  repairer: Repairer | null;
}

type Target = NonNullable<Awaited<ReturnType<typeof targetsOf>>>[number];

/** `shadowlap repair [-- command]`. */
export async function repairRuns(opts: GlobalOpts, command: string[], flags: RepairFlags): Promise<void> {
  const request = parseRepair(flags);
  const { fixes, holdout, keeps } = chooseRuns(opts, flags);
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
  await repairTargets(opts, request, { targets, held, good, heldOutAutomatically }, command, flags);
}

/** The flags checked against each other, the checks read, and the repairer the flag or the config names. */
function parseRepair(flags: RepairFlags): RepairRequest {
  if (!flags.fixes?.length) throw new InvalidArgumentError('give the failing runs to repair: --fixes <runs>');
  if (flags.pr && !flags.branch) throw new InvalidArgumentError('--pr opens a pull request from the branch --branch <name> makes; give both');
  if (flags.goldens && !flags.apply && !flags.branch) throw new InvalidArgumentError('--goldens puts recordings into the project, which happens with --apply or --branch');
  const rule = attemptRule(flags, { defaults: SPRT_DEFAULTS, passes: (n) => Math.ceil(0.8 * n) });
  const expect = flags.expect !== undefined ? readExpectJson(flags.expect) : null;
  const undecidable = undecidableRefusal(expect?.spec ?? null, 'repair');
  if (undecidable) throw new InvalidArgumentError(undecidable);
  const config = loadConfig(process.cwd());
  const repairerSpec = flags.repairer ?? config.repair?.repairer;
  let repairer: Repairer | null;
  try {
    repairer = repairerSpec ? parseRepairer(repairerSpec) : null;
  } catch (err) {
    throw new InvalidArgumentError(messageOf(err));
  }
  return { rule, expect, config, repairerSpec, repairer };
}

/** The runs each flag names; refused when a run is given two roles. */
function chooseRuns(opts: GlobalOpts, flags: RepairFlags): { fixes: RunRecord[]; holdout: RunRecord[]; keeps: RunRecord[] } {
  const store = readStore(opts);
  let fixes: RunRecord[];
  let holdout: RunRecord[];
  let keeps: RunRecord[];
  try {
    fixes = selectRuns(store, flags.fixes ?? [], '--fixes');
    holdout = selectRuns(store, flags.holdout ?? [], '--holdout');
    keeps = selectRuns(store, flags.keeps ?? [], '--keeps');
    // Blame and verify replay every one of them: a tool the model called that a run never recorded, which writes, would run again for real.
    for (const run of [...fixes, ...holdout, ...keeps]) refuseUnrecorded(store, run, allowedUnrecorded(flags.allowUnrecorded));
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
  return { fixes, holdout, keeps };
}

/**
 * What the repair will do, said before it starts: the runs it repairs, holds out and keeps, then who
 * proposes the candidates, the gate and the writes, in a dim line fit to a terminal `columns` wide
 * (null: a pipe or a file).
 */
export function repairPlan({ rule, repairer }: Pick<RepairRequest, 'rule' | 'repairer'>, runs: { targets: readonly unknown[]; held: readonly unknown[]; good: readonly unknown[]; heldOutAutomatically: boolean }, flags: Pick<RepairFlags, 'writes' | 'budget'>, columns: number | null): string[] {
  const { targets, held, good, heldOutAutomatically } = runs;
  return [
    `${p.yellow('⑂')} Repairing ${targets.length} failing run${targets.length === 1 ? '' : 's'}${held.length ? `, with ${held.length} held out from the repairer${heldOutAutomatically ? ' (every other one)' : ''}` : ''}${good.length ? `, keeping ${good.length} good run${good.length === 1 ? '' : 's'}` : ''}`,
    ...dimLines(p, '  ', `repairer: ${repairer ? (repairer.model ? `${repairer.provider}:${repairer.model}` : `${repairer.provider}, with its own default model`) : 'none (--repairer)'} · the gate: ${rule.gate ? describeGate(rule.gate) : `${rule.needed} of ${rule.attempts} attempts per run`} · writes ${flags.writes === 'stub' ? 'stubbed' : 'blocked'}${flags.budget ? ` · budget ${formatBudget(flags.budget)}` : ''}`, columns),
  ];
}

/** The repair and its hand-over, said before it starts, then reported; a repair refused before anything ran ends with 2. */
async function repairTargets(opts: GlobalOpts, request: RepairRequest, runs: { targets: Target[]; held: Target[]; good: Target[]; heldOutAutomatically: boolean }, command: string[], flags: RepairFlags): Promise<void> {
  const { rule, expect, config, repairer } = request;
  const { targets, held, good, heldOutAutomatically } = runs;
  const progress = progressLog(process.stderr, !opts.verbose);
  const log = progress.log;
  for (const line of repairPlan(request, runs, flags, columnsOf(process.stderr))) log(line);

  const settings = { attempts: rule.attempts, needed: rule.needed, gate: rule.gate, concurrency: flags.concurrency, candidates: flags.candidates, stronger: flags.stronger ?? null, scope: flags.scope ?? null, rescueFields: parseFields(flags.set, undefined), maxGrowth: flags.maxGrowth, build: flags.build ?? null, repairer: repairer ?? { provider: 'anthropic' as const, model: '' }, spec: expect?.spec ?? null, expect: expect?.json ?? null, writes: flags.writes, reads: flags.reads, liveTools: [], budget: flags.budget ?? null, timeoutMs: flags.timeout === undefined ? null : flags.timeout * 1000, guard: flags.guard, allowUnrecorded: [...allowedUnrecorded(flags.allowUnrecorded)] };
  const outputs = { apply: !!flags.apply, branch: flags.branch ?? null, pr: !!flags.pr, goldens: flags.goldens ?? null };
  try {
    // The repair, and its hand-over. One that fails part way (a push or `gh` refused, a file changed)
    // still leaves the repair and its verdict to keep: the fix it verified is verified whatever happened after.
    let report: RepairReport;
    let handOverFailed: HandOverError | null = null;
    try {
      // How long the repairer may take: the flag, else the config, else the default (repairer.ts).
      const repairerTimeout = flags.repairerTimeout ?? config.repair?.timeout;
      report = await runRepair({ opts, targets, holdout: held, good, heldOutAutomatically, settings: { ...settings, repairerConfigured: repairer !== null, ...(repairerTimeout !== undefined ? { repairerTimeoutMs: repairerTimeout * 1000 } : {}) }, outputs, log }).finally(() => progress.done());
    } catch (err) {
      if (!(err instanceof HandOverError)) throw err;
      handOverFailed = err;
      report = err.report;
    }
    reportRepair(opts, report, handOverFailed, { request, settings, command, flags });
  } catch (err) {
    if (!(err instanceof RepairError)) throw err;
    if (flags.json) process.stdout.write(JSON.stringify({ outcome: 'error', error: { message: err.message } }, null, 2) + '\n');
    else process.stderr.write(`\n${p.red('✗')} ${err.message}\n`);
    // Refused before anything ran: not in a git repository, another repair running here, a branch it can't make.
    process.exitCode = EXIT.usage;
  }
}

/**
 * What the repair kept, with the fix its blames opened or joined: accepted, it turns the fix verified;
 * empty, the fix stays open with every candidate tried and why each was dropped. Then the report, as
 * text or JSON, what its verifies ran unrecorded, its job's links and patch, and its status.
 */
function reportRepair(opts: GlobalOpts, report: RepairReport, handOverFailed: HandOverError | null, o: { request: RepairRequest; settings: { rescueFields: Record<string, unknown>; timeoutMs: number | null }; command: string[]; flags: RepairFlags }): void {
  const { request, settings, command, flags } = o;
  const { rule, expect, repairerSpec } = request;
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
    process.stdout.write('\n' + formatRepair(report, p, columnsOf(process.stdout)) + '\n' + (kept?.fixes ?? []).map(({ fix: f, standing }) => fixLine(f, what(f, standing), columnsOf(process.stdout))).join(''));
    if (handOverFailed) process.stderr.write(`\n${p.red('✗')} ${handOverFailed.message}\n`);
  }
  // Each candidate's verify: what its attempts ran that nothing recorded (the blame's attempts named theirs as they ran).
  const ranRepair = formatAttemptsUnrecorded(report.candidates.flatMap((c) => (c.verify ? verifyAttempts(c.verify) : [])).map((a) => a.unrecordedTools));
  if (ranRepair) process.stderr.write('\n' + ranRepair);
  for (const { fix: f } of kept?.fixes ?? []) emitJobEvent({ type: 'link', label: 'Open the fix', href: fixHref(f.fixId, 'repair') });
  if (report.output.patch) emitJobEvent({ type: 'file', path: report.output.patch, label: 'fix.patch' });
  emitJobEvent({ type: 'result', data: json });
  // Fixed and handed over, 0; stopped before a verdict, by its reason; no fix, or a hand-over that failed, 1.
  process.exitCode = stoppedBy() ? interruptedStatus() : report.outcome === 'fixed' && !handOverFailed ? EXIT.ok : report.outcome === 'stopped' ? stoppedStatus(report.why) : EXIT.failed;
}
