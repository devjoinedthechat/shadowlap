import { commandIsImported, describeBaselineRule, describeGate, footprintDelta, outcomeOf, recordedRole, verifyTally, type DecisionsVerify, type Price, type Store, type VerifiedRun, type VerifyReport, type VerifyRole } from '@shadowlap/engine';
import { type TestSpec } from './checks.js';
import type { DecisionsSettings, DecisionTarget } from './decisions.js';
import { recordVerifyFix, verifyCommand } from './fixes.js';
import { type GlobalOpts } from './shared.js';
import { palette as p, shortId } from './ui.js';
import { runVerify } from './verify.js';

type VerifyRunsInput = { opts: GlobalOpts; store: Store; targets: DecisionTarget[]; session?: string | null; sessionName?: string | null; fields: Record<string, unknown>; from: string[] | null; settings: Pick<DecisionsSettings, 'thenVerify' | 'argv' | 'timeoutMs' | 'guard'>; prices: Record<string, Price> | undefined; budget: number | null; log: (line: string) => void; blocked?: string | null };

/** A golden's or a run's checks, and the runs judged by them: one verify per set. */
interface ChecksGroup {
  spec: TestSpec | null;
  json: unknown;
  targets: DecisionTarget[];
}

/** The runs grouped by the checks they are judged by. */
function groupsOf(targets: readonly DecisionTarget[], v: NonNullable<DecisionsSettings['thenVerify']>): ChecksGroup[] {
  const groups = new Map<string, ChecksGroup>();
  for (const t of targets) {
    const spec = v.expect?.spec ?? t.spec;
    const json = v.expect?.json ?? t.expect;
    const key = JSON.stringify(json ?? null);
    const g = groups.get(key) ?? { spec, json, targets: [] };
    g.targets.push(t);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** What one verify takes: each run in the role its recording plays under the group's checks, and the command that verifies them again. */
function planOf(g: ChecksGroup, input: VerifyRunsInput) {
  const s = input.settings;
  const v = s.thenVerify!;
  const runs = g.targets.map((t) => {
    const role = recordedRole(input.store, t.run, g.spec, input.prices);
    // A run whose command came from someone's pack (a golden's too, as importGolden marks one) is marked so later replays ask.
    return { parent: t.run, argv: s.argv ?? t.run.command.argv, commandFromImport: !s.argv && commandIsImported(t.run), role };
  });
  const role = (r: VerifyRole) => runs.filter((x) => x.role === r).map((x) => x.parent.runId);
  const line = verifyCommand({ fixes: role('target').map((id) => shortId(id)), keeps: role('good').map((id) => shortId(id)) }, { expect: g.json ?? null, attempts: v.attempts, passes: !v.gate && v.needed !== Math.ceil(0.8 * v.attempts) ? v.needed : undefined, gate: v.gate, keptMax: v.keptMax ?? undefined, fields: input.fields, from: input.from ?? undefined, liveTools: [], writes: v.writes, reads: 'live', budget: null, timeoutMs: s.timeoutMs, argv: s.argv });
  return { g, runs, line };
}

/**
 * A run verified, as the report keeps it, in verify --json's words: fixed, not-fixed, kept, broken,
 * inconclusive, unsettled; with why its last attempt could not be judged, when one stopped it, and the
 * rule that decided it. A good run kept against its baseline reads under the baseline test's rule, its
 * bound the drop's. Its bound is the one verify's line gives (engine `verifyTally`): none for a run an
 * attempt stopped or a clean replay, nor where a report's figures give none.
 */
export function entryOf(report: VerifyReport, rule: string): (r: VerifiedRun) => DecisionsVerify['runs'][number] {
  const keptRule = report.kept ? describeBaselineRule({ ...report.kept, revision: report.kept.label ?? report.kept.revision ?? null }) : null;
  return (r) => {
    const against = r.baseline && keptRule;
    return { runId: r.runId, role: r.role, outcome: outcomeOf(r).replace(' ', '-'), passes: r.passes, attempts: r.attempts.length, ...(against ? { baseline: { passes: r.baseline!.passes, attempts: r.baseline!.attempts } } : {}), bound: verifyTally(r).bound, undecided: r.undecided ?? null, rule: against ? keptRule : rule };
  };
}

/**
 * Verifies the runs a preview can't clear (needsVerify), as `shadowlap verify` would: each under its
 * own checks (a golden's from the config, those of the recording a run named by id comes from, or
 * `--expect`), one verify per set of checks, each run in the role its recording plays under them (a
 * run that fails them must now pass; one that passes must keep passing), and each with the rule that
 * decided it. With `blocked`, nothing runs: the verdict is not-run, with why, and the commands.
 */
export async function verifyRuns(input: VerifyRunsInput): Promise<DecisionsVerify> {
  const { targets, settings: s, log } = input;
  const v = s.thenVerify!;
  // The rule every run is decided by, said once over them.
  const rule = v.gate ? `gate: ${describeGate(v.gate)}` : `${v.needed} of ${v.attempts} attempts must pass`;
  const empty: DecisionsVerify = { verdict: 'not-run', verifyIds: [], runs: [], rule, commands: [], spent: 0, upstreamRequests: 0, reasons: [] };
  if (!targets.length) return empty;
  const plans = groupsOf(targets, v).map((g) => planOf(g, input));
  if (input.blocked) return { ...empty, commands: plans.map((x) => x.line), reasons: [input.blocked] };
  const out: DecisionsVerify = { ...empty, verdict: 'accepted' };
  const verified: VerifiedRun[] = [];
  for (const { g, runs, line } of plans) {
    const remaining = input.budget === null ? null : Math.max(0, input.budget - out.spent);
    log(`${p.yellow('⑂')} Verifying ${runs.length} run${runs.length === 1 ? '' : 's'} end to end: ${runs.map((r) => shortId(r.parent.runId)).join(', ')}`);
    const report = await runVerify({
      opts: input.opts,
      runs,
      settings: { attempts: v.attempts, needed: v.needed, gate: v.gate, ...(v.keptMax ? { keptMax: v.keptMax } : {}), concurrency: 1, fields: input.fields, ...(input.from?.length ? { fromModels: input.from } : {}), failFast: false, spec: g.spec, expect: g.json ?? null, writes: v.writes, reads: 'live', liveTools: [], budget: remaining, timeoutMs: s.timeoutMs, guard: s.guard },
      log,
    });
    const kept = recordVerifyFix(input.opts, report, { expect: g.json ?? null, command: line, session: input.session ?? null, name: input.sessionName ?? null });
    if (kept) out.verifyIds.push(kept.verdict.verifyId);
    out.commands.push(line);
    out.spent += report.spent;
    out.upstreamRequests += report.upstreamRequests;
    out.reasons.push(...report.reasons);
    verified.push(...report.runs);
    if (v.gate) (out.warnings ??= []).push(...report.runs.filter((r) => r.noBaseline).map((r) => `${shortId(r.runId)} was judged by its gate alone: ${r.noBaseline!}`));
    out.runs.push(...report.runs.map(entryOf(report, rule)));
    if (report.verdict === 'rejected') out.verdict = 'rejected';
    else if (report.verdict === 'incomplete' && out.verdict !== 'rejected') out.verdict = 'incomplete';
  }
  const footprint = footprintDelta(verified);
  if (footprint) out.footprint = { recorded: footprint.recorded, now: footprint.now };
  // The rule stated once is the one every run was decided by: the gate's, or a good run's baseline test.
  const rules = new Set(out.runs.map((r) => r.rule ?? rule));
  out.rule = rules.size === 1 ? [...rules][0]! : rules.size ? null : rule;
  return out;
}
