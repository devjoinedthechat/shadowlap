import { agentCallsOf, type AttemptVerdict, BLAME_DEFAULTS, type BlameReport, blameStateWord, blameSteps, probedInScope, describeBlocks, describeRescue, expectArgs, failureReason, findPairs, type FixRecords, GATE_MAX_ATTEMPTS, hasRecordedCommand, keptAttemptVerdict, lostWords, pinWords, probeBound, probeFinding, probeInterval, probeTally, probeWord, type PulledFrom, rescueRule, type RunRecord, scopeArg, type SprtGate, type StoredBlame, type StoreOf, unrescuedHead, unrescuedWhy, unsettledFirst } from '@shadowlap/engine';
import { blameEvidence, gateEvidence, type BlameEvidence, type GateEvidence } from './evidence.js';
import type { FixCrash } from './fix-crash.js';
import type { FoundCommit } from './tests-bisect.js';
import { fieldArgs, rerunFlags, runIds, type RerunFlags } from './rerun.js';
import { askedAgain, attemptNote, commandLine, countArgs, type FixActions, gateArg, gateMarks, noAnswerLost, PULLED_CAP, pulledGate, runHref, sprtGate, type StepLine } from './fix-shared.js';

/** A fix's Blame step: where blame found the run lost, the probes that showed it, and what to run next. */

export interface BlameStep {
  blameId: string;
  runId: string;
  runExists: boolean;
  /**
   * Its agent exited with an error, the first reason the run failed by the engine's rule
   * (`failureReason`), as its run page says: Open run opens it whole, where that shows, not at a call.
   */
  exited: boolean;
  at: number;
  outcome: StoredBlame['outcome'];
  title: string;
  /**
   * Its verdict line: `blamed` in ink, its head the blamed probe's tally and the next one's (`3 of 4
   * rescued from #5`, `0 of 4 from #7`), its finding `boundary`; else the engine's word for a blame
   * that found no call (`inconclusive`, `not rescued`, `stopped`) in amber, headed by its first
   * probe's tally (` by <model>` after a stronger model's), or how far a stopped search got.
   */
  line: StepLine;
  /** The model call whose recorded answer lost the run, by call number. */
  lostAt: number | null;
  /** Its position among the model calls of the blame's scope: model call `step` of `steps`. */
  step: number | null;
  steps: number;
  scope: string | null;
  confidence: 'high' | 'medium' | 'low';
  confidenceWhy: string;
  /** The evidence on both sides of the boundary, in one sentence. */
  boundary: string;
  /** The next model call, where asking again no longer rescued the run. */
  next: { callNo: number; step: number; passes: number; attempts: number } | null;
  rescuedRunId: string | null;
  /** What the model answered at the blamed call in the recording and in the rescued fork, in one line each. */
  answers: { callNo: number; recorded: string; rescued: string } | null;
  /**
   * How many training pairs the blame's attempts made, as `export pairs` counts them (engine
   * pairs.ts): each passing answer at the blamed call against the recorded one. Null once the
   * blamed run is gone from the store.
   */
  pairs: number | null;
  /** How a probe asked again: "resample the probed call", or the fields it changed. */
  rescue: string;
  /** A rescue needs `needed` of `attemptsPerProbe` attempts to pass, or, decided by a gate, the fewest passes that can rescue and the most attempts. */
  needed: number;
  attemptsPerProbe: number;
  /** How a probe decides, its gate's rule said once: `gate: rescue at 60%+, lost at 10%-, <= 5% risk, up to 20 attempts`, or `a rescue needs 2 of 5 attempts to pass`. */
  rule: string;
  /**
   * Each probe: its tally and verdict, and under a gate the bound on the attempts it decided on
   * (`bound`, `rate >= 0.34 (95%)`) and the interval it is read from (`interval`, for its bar against
   * `marks`), both null for a fixed count. `attempts` is how many ran, and `inconclusive` how many of
   * them could not be judged, neither passed nor failed; `tally` says both as the engine does
   * (`probeTally`: `2 of 4`, `1 of 1, an attempt not judged`). Its attempts are its bundle's.
   */
  probes: Array<{ callNo: number; step: number; passes: number; attempts: number; inconclusive: number; tally: string; verdict: 'rescued' | 'lost' | 'inconclusive' | 'rescued · blamed'; bound: string | null; interval: { lo: number; hi: number } | null; blamed: boolean; href: string; gate: GateEvidence }>;
  /** The gate's two marks, `[bad, good]`, for the probes' bars; null for a fixed count. */
  marks: [number, number] | null;
  /** The attempts, bundled per probe. */
  bundles: Array<{ callNo: number; title: string; blamed: boolean; passes: number; attempts: Array<{ runId: string; passed: boolean; verdict: AttemptVerdict; note: string; spent: number; href: string }> }>;
  /**
   * The agent's calls of the run, the judge's left out (the engine's `agentCallsOf`), for the row that
   * shows where it was lost: `inScope` is false for a call outside the blame's scope or in a reserved
   * one (`probedInScope`), and `probed` true for a model call blame's search steps through (`blameSteps`:
   * one that ended, in scope), as many as `steps` and the CLI's blame header count. A probed call's
   * `tally` is its probe's passes of the attempts judged (`3/4`); null for one no probe re-asked. A
   * call that isn't a model call carries its `name` (the tool's) for its hover, in a run short enough
   * for the row to draw it (`CALL_ROW_NAMED`).
   */
  callRow: Array<{ callNo: number; kind: string; name?: string; inScope: boolean; probed: boolean; verdict: 'rescued' | 'lost' | 'inconclusive' | 'blamed' | null; passes: number; attempts: number; inconclusive: number; tally: string | null }>;
  /** What the blame ran and spent; `judge`, what its judge checks' calls cost apart, as the CLI's report adds it, null when no judge was asked. */
  cost: { attempts: number; upstreamRequests: number; spent: number; unknownModels: string[]; judge: { upstreamRequests: number; spent: number } | null };
  oracle: string[];
  recordedFailures: string[];
  stopReason: string | null;
  /**
   * For a blame that placed the failure on no call and knows no answer of the model's lost the run
   * (its passing attempts answered as the recording did, or every attempt met a write's recorded
   * error again): where to look instead. Null otherwise.
   */
  look: string | null;
  warnings: string[];
  /**
   * The command that blames the run the same way again: as it ran, for a blame made here; for one
   * a pull brought (`pulled`), made here from its checked fields, so a teammate's command line is
   * never offered to copy.
   */
  command: string;
  /** The store a pull brought it from, and when; null for a blame made here. */
  pulled: PulledFrom | null;
  hrefs: { run: string; lostAt: string | null; rescued: string | null };
  /** What the report says beyond its probes, when it says it: the calls it lost the run between, and its error bound. */
  evidence: BlameEvidence;
  /**
   * Where no model rescued a test replay that crashed, whose own step is Find breaking commit or
   * Revert (fix-crash.ts): the first bad commit once that named it, whether its golden replays offline
   * (its search "offline and free"), and whether a stronger model asked again too. Null otherwise.
   */
  crash: BlameCrash | null;
}

/** A crash's facts, as the Blame step's note and its commit line read them. */
export interface BlameCrash {
  commit: FoundCommit | null;
  offline: boolean;
  stronger: boolean;
}

/** The crash's facts of a blame whose run crashed, as fix-crash.ts found them. */
const crashOf = (r: BlameReport, crash: FixCrash | null): BlameCrash | null => (crash ? { commit: crash.commit, offline: crash.offline, stronger: typeof r.rescue?.fields.model === 'string' } : null);


/**
 * The pairs a blamed run's attempts made, read from that run and its attempts alone, so a fix's page
 * doesn't read every run in the store. Training owns what a pair is; this only counts them.
 */
function blamePairs(store: StoreOf<'recording' | 'readModels' | 'fixes'>, runId: string): number | null {
  const run = store.getRun(runId);
  if (!run) return null;
  return findPairs(store, { runs: [run, ...store.childRuns(runId)] }).sources.find((x) => x.key === `blame:${runId}`)?.made ?? 0;
}

/**
 * Each probe's part of a blame's head, its tally kept whole where the head wraps (the mock's
 * `rescuedHead`): `3 of 4 rescued from #5` first, then `0 of 4 from #7`, an attempt not judged
 * counted apart as the engine counts it (`probeTally`).
 */
function rescuedParts(ps: ReadonlyArray<Parameters<typeof probeTally>[0] & { callNo: number }>): string[] {
  return ps.map((p, i) => {
    const tally = probeTally(p, `${i ? '' : ' rescued'} from #${p.callNo}`);
    // With no attempt of it judged, the tally names no call: where it was, after it.
    return tally.includes(`#${p.callNo}`) ? tally : `${tally} at #${p.callNo}`;
  });
}

/**
 * What a blame found, as its step says it: its title, the evidence on both sides of the boundary in
 * one sentence (`boundary`), and its verdict line (`BlameStep['line']`), whose finding it is.
 */
function blameFinding(b: StoredBlame, r: BlameReport): { title: string; boundary: string; line: StepLine } {
  if (b.outcome === 'blamed' && r.blamed) {
    // Two calls when it pinned no one: lost gradually around them, or between them when the probes there could not decide.
    const checked = r.pin ? ` ${pinWords(r.pin)}` : '';
    const boundary =
      (r.gate && r.blamed.decision
        ? `The re-asked call #${r.blamed.callNo}: ${probeFinding(r.blamed, r.gate)}; ${r.lost ? `#${r.lost.callNo}, the next model call: ${probeFinding(r.lost, r.gate)}.` : 'it is the last model call, and the recording, which kept its answer, fails.'}`
        : `Resampling #${r.blamed.callNo} rescued ${probeTally(r.blamed, ' attempts')}; ${r.lost?.undecided ? `#${r.lost.callNo}, the next model call, was inconclusive: ${probeTally(r.lost, ' passed')}.` : r.lost ? `resampling #${r.lost.callNo}, the next model call, rescued ${probeTally(r.lost)}.` : 'it is the last model call, and the recording, which kept its answer, fails.'}`) + checked;
    // The last model call heads with its own tally alone.
    return { title: lostWords(r.blamed.callNo, r.range, 'title'), boundary, line: { word: 'blamed', tone: 'done', head: rescuedParts(r.lost ? [r.blamed, r.lost] : [r.blamed]), finding: boundary } };
  }
  const unsettled = unsettledFirst(r);
  if (b.outcome === 'unrescuable') {
    // Blame's own headline, without its mark: inconclusive at the first model call when its first
    // probe couldn't tell, which is no finding that no answer lost it; else not rescued, from any
    // model call only where its bound bears that out.
    const title = unrescuedHead(r).replace(/^\S+ /, '');
    const boundary = unrescuedWhy(r).evidence ?? 'No probe rescued the run.';
    const first = r.probes[0];
    const model = r.rescue?.fields.model;
    const by = !unsettled && typeof model === 'string' ? ` by ${model}` : '';
    return { title, boundary, line: { word: blameStateWord('unrescuable', unsettled), tone: 'warn', head: first ? rescuedParts([first]).map((x) => x + by) : [title], finding: boundary } };
  }
  // The probe past the last rescue lost the run there, or could not tell, which is no loss.
  const after = r.lost ? (probeWord(r.lost) === 'inconclusive' ? `, inconclusive at #${r.lost.callNo}` : `, lost from #${r.lost.callNo}`) : '';
  const boundary = `${r.stopReason ? `Stopped: ${r.stopReason}. ` : ''}${r.blamed ? `So far: rescued up to #${r.blamed.callNo}${after}.` : 'No probe had settled.'}`;
  const head = r.blamed ? `Rescued up to #${r.blamed.callNo} so far` : 'No probe settled before it stopped';
  return { title: 'Stopped before the search finished', boundary, line: { word: blameStateWord('stopped', unsettled), tone: 'warn', head: [head], finding: boundary } };
}

/** Why a blame is as sure as it is, which its confidence says on hover. */
function confidenceWhyOf(r: BlameReport): string {
  return r.confidence === 'low'
    ? r.nonMonotone.length
      ? `rescue worked again at ${r.nonMonotone.map((x) => `#${x.rescued} after failing at #${x.lost}`).join(', ')}, so the boundary is not clean`
      : unsettledFirst(r)
        ? `#${r.probes[0]!.callNo} was inconclusive: whether resampling rescues the run is undecided`
        : 'the search did not finish'
    : r.confidence === 'medium' && r.lost
      ? r.lost.decision === 'inconclusive'
        ? `#${r.lost.callNo} was inconclusive: the run was not reliably lost there`
        : `#${r.lost.callNo} still passed ${probeTally(r.lost)}, below the bar: the run was not reliably lost there`
      : 'rescue stops cleanly at the boundary';
}

/** An attempt that could not be judged is counted apart (probeTally), never as one that failed. */
const unsure = (x: Parameters<typeof probeTally>[0] | undefined): number => x?.attempts.filter((a) => a.verdict === 'inconclusive').length ?? 0;

/**
 * The most calls the Blame step's row draws whole, its tool calls among them (ui/fixes/model.ts's
 * `CALL_ROW_MAX`, which test/fix-steps.test.ts holds equal): a longer run's row shows its model calls
 * only, so its other calls carry no name, and a run of thousands of calls reads none.
 */
export const CALL_ROW_NAMED = 18;

/** The Blame step's row (`BlameStep['callRow']`): the agent's calls of the blamed run, each probed one with its probe's verdict and tally. */
function callRowOf(store: StoreOf<'recording'>, b: StoredBlame): BlameStep['callRow'] {
  const blamedCall = b.report.blamed?.callNo ?? null;
  const probeOf = new Map(b.report.probes.map((x) => [x.callNo, x]));
  const calls = agentCallsOf(store.getCalls(b.runId));
  const probed = new Set(blameSteps(calls, b.scope).map((c) => c.callNo));
  const named = calls.length <= CALL_ROW_NAMED;
  return calls.map((c) => {
    const p = probeOf.get(c.callNo);
    return { callNo: c.callNo, kind: c.kind, ...(named && c.kind !== 'api' ? { name: c.name } : {}), inScope: probedInScope(c.meta.scope, b.scope), probed: probed.has(c.callNo), verdict: p ? (p.callNo === blamedCall ? ('blamed' as const) : probeWord(p)) : null, passes: p?.passes ?? 0, attempts: p?.attempts.length ?? 0, inconclusive: unsure(p), tally: p ? `${p.passes}/${p.attempts.length - unsure(p)}` : null };
  });
}

/** Whether a run failed first on its agent's exit, by the engine's rule, before any check of its own. */
const exitedFirst = (run: RunRecord | null): boolean => run !== null && failureReason({ status: run.status, checks: run.meta?.checks ?? [] })?.kind === 'exit';

/**
 * A blame as the Blame step shows it. `fallback` is the fix's own blame command, which a pulled
 * blame shows when its fields can't be made into one.
 */
export function blameStep(store: StoreOf<'recording' | 'readModels' | 'fixes'>, b: StoredBlame, fallback: string, crash: FixCrash | null = null): BlameStep {
  // The gate as it can be read: a malformed one reads as none, the fixed count's words then.
  const r = { ...b.report, gate: sprtGate(b.report.gate) };
  const run = store.getRun(b.runId);
  const blamedCall = r.blamed?.callNo ?? null;
  const { title, boundary, line } = blameFinding(b, r);
  const verdictOf = (x: Parameters<typeof probeWord>[0] & { callNo: number }) => (x.callNo === blamedCall ? 'rescued · blamed' : probeWord(x));
  const contrast = r.contrast;
  const rescuedNote = contrast ? `passed · ${askedAgain(contrast.rescued)}` : 'passed';
  return {
    blameId: b.blameId,
    runId: b.runId,
    runExists: run !== null,
    exited: exitedFirst(run),
    at: b.at,
    outcome: b.outcome,
    title,
    line,
    lostAt: blamedCall,
    step: r.blamed?.step ?? null,
    steps: r.steps,
    scope: b.scope,
    confidence: r.confidence,
    confidenceWhy: confidenceWhyOf(r),
    boundary,
    next: r.lost ? { callNo: r.lost.callNo, step: r.lost.step, passes: r.lost.passes, attempts: r.lost.attempts.length } : null,
    rescuedRunId: contrast?.rescuedRunId ?? null,
    answers: contrast ? { callNo: contrast.callNo, recorded: describeBlocks(contrast.recorded), rescued: describeBlocks(contrast.rescued) } : null,
    pairs: blamePairs(store, b.runId),
    rescue: describeRescue(r.rescue?.fields ?? {}),
    needed: r.needed,
    attemptsPerProbe: r.attemptsPerProbe,
    rule: rescueRule(r),
    probes: r.probes.map((x) => {
      const interval = probeInterval(x, r.gate);
      return { callNo: x.callNo, step: x.step, passes: x.passes, attempts: x.attempts.length, inconclusive: unsure(x), tally: probeTally(x), verdict: verdictOf(x), bound: probeBound(x, r.gate), interval: interval ? { lo: interval.lo, hi: interval.hi } : null, blamed: x.callNo === blamedCall, href: runHref(b.runId, x.callNo), gate: gateEvidence(x) };
    }),
    marks: gateMarks(r.gate),
    bundles: r.probes.map((x) => ({
      callNo: x.callNo,
      title: `blame · probe #${x.callNo}`,
      blamed: x.callNo === blamedCall,
      passes: x.passes,
      attempts: x.attempts.map((a) => ({ runId: a.runId, passed: a.passed, verdict: keptAttemptVerdict(a), note: a.passed ? (a.runId === contrast?.rescuedRunId ? rescuedNote : 'passed') : attemptNote(false, a.failures[0], undefined, keptAttemptVerdict(a)), spent: a.spent, href: runHref(a.runId) })),
    })),
    callRow: run ? callRowOf(store, b) : [],
    cost: { attempts: r.attempts, upstreamRequests: r.upstreamRequests, spent: r.spent, unknownModels: r.unknownModels, judge: r.judge ? { upstreamRequests: r.judge.upstreamRequests, spent: r.judge.spent } : null },
    oracle: r.oracle,
    recordedFailures: r.recordedFailures,
    stopReason: r.stopReason,
    look: noAnswerLost(b) || unsettledFirst(r) ? unrescuedWhy(r).look : null,
    warnings: r.warnings,
    // A teammate's command line is never offered to copy: the same blame, made here from its checked fields.
    command: b.pulled ? sameBlame(b, fallback) : b.command,
    pulled: b.pulled ?? null,
    hrefs: { run: runHref(b.runId), lostAt: blamedCall ? runHref(b.runId, blamedCall) : null, rescued: contrast ? runHref(contrast.rescuedRunId) : null },
    evidence: blameEvidence(b.report),
    crash: crashOf(r, crash),
  };
}

/**
 * A kept blame as `shadowlap blame` arguments that blame its run the same way again, from its
 * checked fields: the run, `expect` (the fix's check now, or the blame's own), its scope and
 * rescue, the gate or count after it (`decide`), and its flags (rerun.ts) but `--budget`. Null when
 * any of them isn't of its shape, or it kept no flags: then it is not run again from here.
 */
function blameArgs(b: StoredBlame, expect: unknown, decide: string[] | null): { argv: string[]; rerun: RerunFlags } | null {
  const rerun = rerunFlags('blame', b.rerun, { pulled: !!b.pulled, drop: new Set(['--budget']) });
  const check = expectArgs(expect);
  const scope = scopeArg(b.scope);
  const fields = fieldArgs(b.report.rescue?.fields);
  if (!rerun || !check || !scope || !fields || !decide || !runIds([b.runId])) return null;
  return { argv: ['blame', b.runId, ...check, ...scope, ...fields, ...decide, ...rerun.flags, ...(rerun.command ? ['--', ...rerun.command] : [])], rerun };
}

/** A blame's fixed count as the CLI takes it, or null when it isn't one. */
function blameCount(r: BlameReport, pulled = false): string[] | null {
  return countArgs(r.attemptsPerProbe, r.needed, pulled);
}

/**
 * Run blame again, or Run blame with stronger model, for an open fix whose shown blame placed its failure
 * on no call (`FixActions`): built from that blame's checked fields (`blameArgs`), under the fix's
 * check now, with the run named in full and without its budget. Neither for a fix whose run is gone,
 * one whose command came from a capture, which has none to run again, or a blame kept before its
 * flags were.
 */
export function blameNext(store: StoreOf<'recording'>, rec: FixRecords, b: StoredBlame | null): Pick<FixActions, 'blameAgain' | 'blameStronger'> {
  const none = { blameAgain: null, blameStronger: null };
  if (rec.fix.status !== 'open' || !b || b.outcome === 'blamed') return none;
  const run = store.getRun(b.runId);
  if (!run || !hasRecordedCommand(run)) return none;
  const unsettled = unsettledFirst(b.report);
  const stopped = b.outcome === 'stopped';
  const pulled = b.pulled ?? null;
  const g = nextBlameGate(b, false);
  if (stopped || unsettled) {
    const gate = nextBlameGate(b, unsettled);
    const made = blameArgs(b, rec.fix.check.expect, gate ? gateArg(gate, BLAME_DEFAULTS) : blameCount(b.report, !!pulled));
    if (!made) return none;
    // The last blame's bar beside the lower one, and how far a stopped search got: its ask says both.
    const lastGood = unsettled && gate ? (b.report.gate?.good ?? null) : null;
    const soFar = stopped ? (b.report.blamed?.callNo ?? null) : null;
    return { blameAgain: { kind: stopped ? 'stopped' : 'unsettled', argv: made.argv, command: commandLine(made.argv), gate: unsettled ? gate : null, lastGood, soFar, pulled, left: made.rerun.left }, blameStronger: null };
  }
  // A stronger model can't help when blame found the model's answer isn't what lost the run, nor one asked already.
  if (noAnswerLost(b) || b.report.rescue.fields.model !== undefined) return none;
  const made = blameArgs(b, rec.fix.check.expect, g ? gateArg(g, BLAME_DEFAULTS) : blameCount(b.report, !!pulled));
  if (!made) return none;
  return { blameAgain: null, blameStronger: { argv: made.argv, command: `${commandLine(made.argv)} --model <model>`, attempts: b.report.attempts, spent: b.report.spent, pulled, left: made.rerun.left } };
}

/**
 * The gate Run blame again or with a stronger model probes by: the shown blame's, held to the cap
 * for a pulled one; with `unsettled` (one inconclusive at its first probe), more attempts and a
 * lower bar, as blame's report words it. Null for a blame of a fixed count.
 */
export function nextBlameGate(b: StoredBlame, unsettled: boolean): SprtGate | null {
  const pulled = !!b.pulled;
  const g = pulledGate(sprtGate(b.report.gate), pulled, PULLED_CAP.blame);
  if (!g || !unsettled) return g;
  const lower = Math.max(0.05, +(g.good - 0.2).toFixed(2));
  return { ...g, good: lower > g.bad ? lower : g.good, max: Math.min(pulled ? PULLED_CAP.blame : GATE_MAX_ATTEMPTS, g.max * 2) };
}

/**
 * How Run blame again or with a stronger model decides each probe, as its command carries it
 * (`blameNext`): by its gate, or by the shown blame's fixed count of attempts. Null when it carries
 * neither, and so has no command.
 */
export function nextBlameRule(b: StoredBlame, unsettled: boolean): { gate: SprtGate } | { attempts: number } | null {
  const gate = nextBlameGate(b, unsettled);
  if (gate) return { gate };
  const count = blameCount(b.report, !!b.pulled);
  return count ? { attempts: Number(count[1]) } : null;
}

/** A pulled blame as this machine would run it again under its own check, from its checked fields; `fallback` when they make none. */
function sameBlame(b: StoredBlame, fallback: string): string {
  const g = pulledGate(sprtGate(b.report.gate), !!b.pulled, PULLED_CAP.blame);
  const made = blameArgs(b, b.expect, g ? gateArg(g, BLAME_DEFAULTS) : blameCount(b.report, !!b.pulled));
  return made ? commandLine(made.argv) : fallback;
}
