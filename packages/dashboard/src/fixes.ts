import {
  commitTitle,
  describeBlocks,
  describeRescue,
  fixCost,
  fixOfRun,
  fixRecords,
  footprintDelta,
  formatUsd,
  GOOD_LABEL,
  outcomeOf,
  repairMarkdown,
  resolveFix,
  type FixData,
  type FixRecords,
  type FixStatus,
  type RepairCandidate,
  type RepairOutcome,
  type RunRecord,
  type Store,
  type StoredBlame,
  type StoredFix,
  type StoredRepair,
  type StoredVerdict,
  type VerifiedRun,
  type VerifyOutcome,
} from '@shadowlap/engine';

/**
 * Fixes, as the dashboard and `shadowlap fix --json` read them: plain JSON from the store, one
 * function per view, no HTTP. A fix is one failure and its three steps (blame, repair, verify);
 * engine `fixes.ts` says how runs, blames, repairs and verdicts are grouped into one.
 *
 * Besides the Fixes list and a fix's page, other views read fixes through three helpers here:
 * `fixesSummary` (the Overview's outcomes and funnel), `needsLookFixes` (Needs a look) and
 * `fixForRun` (a run page's banners and the Forks view's bundles).
 */

export type StepKey = 'blame' | 'repair' | 'verify';
export type StepState = 'done' | 'todo' | 'no';

/** One of a fix's three steps, as the list (`short`) and the stepper (`title`, `meta`) show it. */
export interface FixStep {
  key: StepKey;
  n: '01' | '02' | '03';
  state: StepState;
  short: string;
  title: string;
  meta: string;
}

export interface FixRow {
  fixId: string;
  href: string;
  status: FixStatus;
  title: string;
  /** The label it groups runs by, or null when it groups them by its check. */
  label: string | null;
  /** What a passing run does, in words. */
  check: string;
  failing: number;
  good: number;
  steps: FixStep[];
  /** Where it came from, such as "from CI · PR #138", or null for a fix opened here. */
  source: string | null;
  openedAt: number;
  verifiedAt: number | null;
  appliedAt: number | null;
  /** What everything behind it took: attempts that ran live, and what they and the repairer cost. */
  attempts: number;
  spent: number;
}

export interface FixList {
  fixes: FixRow[];
  /** For the filter chips: Verified counts applied fixes too. */
  counts: { all: number; open: number; verified: number };
}

export interface FixRunRef {
  runId: string;
  href: string;
  /** False when the run was deleted from the store since. */
  exists: boolean;
  status: RunRecord['status'] | null;
  startedAt: number | null;
  labels: string[];
}

export interface BlameStep {
  blameId: string;
  runId: string;
  runExists: boolean;
  at: number;
  outcome: StoredBlame['outcome'];
  title: string;
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
  /** How a probe asked again: "resample the probed call", or the fields it changed. */
  rescue: string;
  /** A rescue needs `needed` of `attemptsPerProbe` attempts to pass. */
  needed: number;
  attemptsPerProbe: number;
  probes: Array<{ callNo: number; step: number; passes: number; attempts: number; verdict: 'rescued' | 'lost' | 'rescued · blamed'; blamed: boolean; href: string }>;
  /** The attempts, bundled per probe. */
  bundles: Array<{ callNo: number; title: string; blamed: boolean; passes: number; attempts: Array<{ runId: string; passed: boolean; note: string; spent: number; href: string }> }>;
  /** Every call of the run, for the row that shows where it was lost. */
  callRow: Array<{ callNo: number; kind: string; inScope: boolean; verdict: 'rescued' | 'lost' | 'blamed' | null; passes: number; attempts: number }>;
  cost: { attempts: number; upstreamRequests: number; spent: number; unknownModels: string[] };
  oracle: string[];
  recordedFailures: string[];
  stopReason: string | null;
  warnings: string[];
  command: string;
  hrefs: { run: string; lostAt: string | null; rescued: string | null };
}

export type CandidateVerdict = 'accepted' | 'rejected' | 'set aside' | 'not tried' | 'build failed' | 'unsettled';

export interface RepairStep {
  repairId: string;
  at: number;
  /** Its files, relative to the project folder: `.shadowlap/repairs/<id>`. */
  dir: string;
  outcome: RepairOutcome;
  accepted: boolean;
  /** The accepted change in a few words (the commit title), or "No fix yet". */
  title: string;
  /** Why nothing was accepted. */
  why: string | null;
  /** Who proposed the candidates: `claude-code`, `anthropic:claude-opus-5-5`; null when no repairer was asked. */
  repairer: string | null;
  /** The model that answered, when it differs from the one asked. */
  served: string | null;
  /** The gate's run on the accepted candidate: its verdict, attempts and spend. */
  verify: { verifyId: string | null; attempts: number; spent: number } | null;
  change: { file: string; anchor: string; before: string; after: string; added: { at: number; text: string } | null; removed: string } | null;
  /** The accepted change's result per role: target 1 of 1. */
  roles: Array<{ role: 'target' | 'held-out' | 'good'; held: number; of: number }>;
  needed: number | null;
  attemptsPerRun: number | null;
  /** Where each failing run was lost, from its blame. */
  lost: Array<{ runId: string; at: string; href: string }>;
  diagnosis: string | null;
  candidates: Array<{ id: number; text: string; surface: string; file: string; source: 'repairer' | 'model'; verdict: CandidateVerdict; why: string }>;
  files: Array<{ name: string; note: string }>;
  /** report.md: the pull request body. */
  prBody: string;
  command: string;
  cost: { blame: number; repairer: number | null; verify: number };
  output: { patch: string | null; applied: boolean; branch: string | null; pr: string | null; goldens: string[] };
  warnings: string[];
}

export interface VerifyRow {
  role: 'target' | 'held-out' | 'good';
  runId: string;
  href: string;
  attempts: number;
  passes: number;
  /** The first attempt replayed clean, so it settled the run. */
  deterministic: boolean;
  outcome: ReturnType<typeof outcomeOf>;
  /** Where it went: where it forked, or why it failed. */
  note: string;
  /** Input tokens and cost per run, as recorded and under the change (the mean of its attempts). */
  tokens: { recorded: number; now: number } | null;
  cost: { recorded: number | null; now: number | null } | null;
}

export interface VerifyStep {
  verifyId: string;
  href: string;
  at: number;
  verdict: VerifyOutcome;
  /** What was verified: the code version, or "repair candidate 3". */
  code: string;
  /** How the switch between changes names it: "repair candidate 3 · accepted". */
  label: string;
  headline: string;
  /** "a run passes when 4 of 5 attempts meet the check: …" */
  oracle: string;
  needed: number;
  attemptsPerRun: number;
  rows: VerifyRow[];
  tokens: { before: number; after: number; change: string } | null;
  cost: { before: number; after: number; change: string } | null;
  attempts: number;
  upstreamRequests: number;
  spent: number;
  unknownModels: string[];
  reasons: string[];
  warnings: string[];
  command: string;
  repairId: string | null;
  candidate: number | null;
}

export interface FixActions {
  /** An open fix: repair from here. Argv after `shadowlap`, without `--db` or `--repairer`, which the caller adds. */
  repair: { argv: string[]; command: string } | null;
  /** A verified fix: apply its repair's patch (`patch`), or mark a change verified in the working tree applied (`mark`). */
  apply: { kind: 'patch' | 'mark'; argv: string[]; gitApply: string | null } | null;
  applied: boolean;
}

export interface FixDetail extends FixRow {
  /** The check as JSON, as `--expect` takes it; null for the exit code alone. */
  expect: unknown;
  failingRuns: FixRunRef[];
  goodRuns: FixRunRef[];
  openedBy: string | null;
  upstreamRequests: number;
  /** The step a fix opens on without one in its URL: its last finished step. */
  defaultStep: StepKey;
  actions: FixActions;
  /** The blame the Blame step shows (the latest that found a call, else the latest), and every blame, newest first. */
  blame: BlameStep | null;
  blames: Array<{ blameId: string; runId: string; at: number; outcome: StoredBlame['outcome']; lostAt: number | null; confidence: string }>;
  /** The repair the Repair step shows (the latest accepted, else the latest), and every repair, newest first. */
  repair: RepairStep | null;
  repairs: Array<{ repairId: string; at: number; outcome: RepairOutcome; accepted: boolean; title: string }>;
  /** Every change verified, newest first, and the one shown without one in the URL. */
  verify: VerifyStep[];
  defaultVerify: string | null;
  /** Commands that run each step again, as the empty steps show them. */
  commands: { blame: string; repair: string; verify: string };
  applied: FixData['applied'] | null;
}

// ---- Shared pieces ---------------------------------------------------------------------------

export const fixHref = (fixId: string, step?: StepKey, sub?: string): string => `#/fixes/${fixId}${step ? `/${step}${sub ? `/${sub}` : ''}` : ''}`;
const runHref = (runId: string, call?: number | null): string => `#/run/${runId}${call ? `/${call}` : ''}`;
const short = (id: string) => id.slice(0, 10);
const s = (n: number) => (n === 1 ? '' : 's');
const approx = (usd: number) => `≈${formatUsd(usd)}`;
const ROLE: Record<VerifiedRun['role'], VerifyRow['role']> = { target: 'target', holdout: 'held-out', good: 'good' };

/** Single quotes around a shell word that needs them, as the CLI prints commands. */
const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
const commandLine = (argv: string[]) => ['shadowlap', ...argv].map(quote).join(' ');

/** The blame a fix shows: the latest that found where a run was lost, else the latest. */
function shownBlame(rec: FixRecords): StoredBlame | null {
  return [...rec.blames].reverse().find((b) => b.outcome === 'blamed') ?? rec.blames.at(-1) ?? null;
}

/** The repair a fix shows: the latest that accepted a candidate, else the latest. */
function shownRepair(rec: FixRecords): StoredRepair | null {
  return [...rec.repairs].reverse().find((r) => r.accepted) ?? rec.repairs.at(-1) ?? null;
}

function acceptedVerdict(rec: FixRecords): StoredVerdict | null {
  return [...rec.verdicts].reverse().find((v) => v.verdict === 'accepted') ?? null;
}

const acceptedCandidate = (r: StoredRepair): RepairCandidate | null => (r.accepted ? (r.report.candidates.find((c) => c.id === r.report.accepted) ?? null) : null);

function repairerLabel(r: StoredRepair): string | null {
  const x = r.report.repairer;
  if (!x) return null;
  return x.model ? `${x.provider}:${x.model}` : x.provider;
}

/** What kind of change a candidate is, in two words. */
function changeKind(c: RepairCandidate): string {
  if (c.source === 'model' || c.surface === 'model') return 'model switch';
  if (c.surface.startsWith('tool ')) return 'tool description fix';
  return 'prompt fix';
}

function sourceText(fix: StoredFix): string | null {
  const src = fix.data.source;
  if (!src) return null;
  const pr = src.pr ? `PR ${src.pr.number !== null ? `#${src.pr.number}` : src.pr.url}` : '';
  if (src.ci) return pr ? `from CI · ${pr}` : 'from CI';
  return pr ? `pull request · ${pr}` : null;
}

function stepsOf(rec: FixRecords): FixStep[] {
  const b = shownBlame(rec);
  const p = shownRepair(rec);
  const v = acceptedVerdict(rec);
  const rejected = rec.verdicts.filter((x) => x.verdict === 'rejected').length;

  let blame: FixStep;
  if (!b) blame = { key: 'blame', n: '01', state: 'todo', short: 'not blamed', title: 'Not blamed yet', meta: 'find the call that lost the run' };
  else {
    const r = b.report;
    const cost = `${r.attempts} attempt${s(r.attempts)} · ${approx(r.spent)}`;
    if (b.outcome === 'blamed' && r.blamed) blame = { key: 'blame', n: '01', state: 'done', short: `lost at #${r.blamed.callNo}`, title: `Lost at model call #${r.blamed.callNo}`, meta: `confidence ${r.confidence} · ${cost}` };
    else if (b.outcome === 'unrescuable') blame = { key: 'blame', n: '01', state: 'done', short: 'not rescued', title: 'Not rescued from any model call', meta: cost };
    else blame = { key: 'blame', n: '01', state: 'todo', short: 'blame stopped', title: 'Stopped before the search finished', meta: r.stopReason ?? cost };
  }

  let repair: FixStep;
  const c = p && acceptedCandidate(p);
  if (p && c) {
    const n = p.report.candidates.length;
    const by = repairerLabel(p);
    repair = { key: 'repair', n: '02', state: 'done', short: changeKind(c), title: commitTitle(c), meta: `candidate ${p.report.candidates.indexOf(c) + 1} of ${n} · ${by ? `proposed by ${by}` : 'no repairer needed'}` };
  } else if (p) {
    const tried = p.report.candidates.filter((x) => x.state !== 'invalid' && x.state !== 'untried').length;
    repair = { key: 'repair', n: '02', state: 'todo', short: 'no fix yet', title: 'No fix yet', meta: p.report.candidates.length ? `${tried} candidate${s(tried)} tried, none accepted` : (p.report.why ?? 'the repair found nothing to try') };
  } else repair = { key: 'repair', n: '02', state: 'todo', short: 'no fix yet', title: 'No fix yet', meta: 'repair proposes a prompt fix' };

  let verify: FixStep;
  if (v) {
    const runs = v.report.runs;
    const held = runs.filter((x) => outcomeOf(x) !== 'broken').length;
    const kept = runs.some((x) => x.role === 'good');
    verify = { key: 'verify', n: '03', state: 'done', short: `${held} of ${runs.length} held`, title: `${held} of ${runs.length} run${s(runs.length)} held`, meta: rejected ? `${rejected} earlier change${s(rejected)} rejected` : kept ? 'every failing run fixed, every good run kept' : 'every failing run fixed' };
  } else if (rejected) verify = { key: 'verify', n: '03', state: 'no', short: 'rejected', title: 'Rejected', meta: `${rejected} change${s(rejected)} rejected` };
  else if (rec.verdicts.length) verify = { key: 'verify', n: '03', state: 'todo', short: 'not settled', title: 'Not settled', meta: 'a verify stopped before every run settled' };
  else verify = { key: 'verify', n: '03', state: 'todo', short: 'not verified', title: 'Not verified yet', meta: 'checks a fix before it ships' };
  return [blame, repair, verify];
}

function rowOf(rec: FixRecords): FixRow {
  const f = rec.fix;
  const cost = fixCost([rec]);
  return {
    fixId: f.fixId,
    href: fixHref(f.fixId),
    status: f.status,
    title: f.title,
    label: f.label,
    check: f.check.text,
    failing: rec.failing.length,
    good: rec.good.length,
    steps: stepsOf(rec),
    source: sourceText(f),
    openedAt: f.openedAt,
    verifiedAt: f.verifiedAt,
    appliedAt: f.appliedAt,
    attempts: cost.attempts,
    spent: cost.spent,
  };
}

// ---- The list ----------------------------------------------------------------------------------

/** Every fix, the most recently opened first, with the counts for the filter chips. */
export function fixList(store: Store, options: { status?: FixStatus | 'all' } = {}): FixList {
  const all = store.listFixes().map((f) => rowOf(fixRecords(store, f)));
  const open = all.filter((f) => f.status === 'open').length;
  const fixes = !options.status || options.status === 'all' ? all : all.filter((f) => (options.status === 'verified' ? f.status !== 'open' : f.status === options.status));
  return { fixes, counts: { all: all.length, open, verified: all.length - open } };
}

// ---- A fix -------------------------------------------------------------------------------------

function runRef(store: Store, runId: string): FixRunRef {
  const run = store.getRun(runId);
  return { runId, href: runHref(runId), exists: run !== null, status: run?.status ?? null, startedAt: run?.startedAt ?? null, labels: run?.meta?.labels ?? [] };
}

const inScope = (callScope: unknown, scope: string | null) => !scope || (typeof callScope === 'string' && (callScope === scope || callScope.startsWith(`${scope}/`)));

/** A failed attempt's first failure, short: `issue_refund called once`, `the agent exited with code 1`. */
export function shortFailure(f: string | undefined): string {
  if (!f) return 'failed';
  const m = /^(\S+)(?: with .*?)? called (.+?), but called (\d+) times?/.exec(f);
  if (m) {
    const n = Number(m[3]);
    return m[2] === '0 times' ? `${m[1]} called` : `${m[1]} called ${n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`}`;
  }
  return f.split(' (')[0]!;
}

function blameStep(store: Store, b: StoredBlame): BlameStep {
  const r = b.report;
  const run = store.getRun(b.runId);
  const rate = (x: { passes: number; attempts: unknown[] }) => `${x.passes} of ${x.attempts.length}`;
  const blamedCall = r.blamed?.callNo ?? null;
  let boundary: string;
  let title: string;
  if (b.outcome === 'blamed' && r.blamed) {
    title = `Lost at model call #${r.blamed.callNo}`;
    boundary = `Resampling #${r.blamed.callNo} rescued ${rate(r.blamed)} attempts; ${r.lost ? `resampling #${r.lost.callNo}, the next model call, rescued ${rate(r.lost)}.` : 'it is the last model call, and the recording, which kept its answer, fails.'}`;
  } else if (b.outcome === 'unrescuable') {
    title = 'Not rescued from any model call';
    const first = r.probes[0];
    boundary = first ? `Resampling from the first model call, #${first.callNo}, passed ${rate(first)} attempts, fewer than the ${r.needed} a rescue needs.` : 'No probe rescued the run.';
  } else {
    title = 'Stopped before the search finished';
    boundary = `${r.stopReason ? `Stopped: ${r.stopReason}. ` : ''}${r.blamed ? `So far: rescued up to #${r.blamed.callNo}${r.lost ? `, lost from #${r.lost.callNo}` : ''}.` : 'No probe had settled.'}`;
  }
  const confidenceWhy =
    r.confidence === 'low'
      ? r.nonMonotone.length
        ? `rescue worked again at ${r.nonMonotone.map((x) => `#${x.rescued} after failing at #${x.lost}`).join(', ')}, so the boundary is not clean`
        : 'the search did not finish'
      : r.confidence === 'medium' && r.lost
        ? `#${r.lost.callNo} still passed ${rate(r.lost)}, below the bar: the run was not reliably lost there`
        : 'rescue stops cleanly at the boundary';
  const probeOf = new Map(r.probes.map((x) => [x.callNo, x]));
  const verdictOf = (x: { callNo: number; rescued: boolean }) => (x.callNo === blamedCall ? 'rescued · blamed' : x.rescued ? 'rescued' : 'lost');
  const callRow = run
    ? store.getCalls(b.runId).map((c) => {
        const p = probeOf.get(c.callNo);
        return { callNo: c.callNo, kind: c.kind, inScope: c.kind === 'api' && inScope(c.meta.scope, b.scope), verdict: p ? (p.callNo === blamedCall ? ('blamed' as const) : p.rescued ? ('rescued' as const) : ('lost' as const)) : null, passes: p?.passes ?? 0, attempts: p?.attempts.length ?? 0 };
      })
    : [];
  const contrast = r.contrast;
  return {
    blameId: b.blameId,
    runId: b.runId,
    runExists: run !== null,
    at: b.at,
    outcome: b.outcome,
    title,
    lostAt: blamedCall,
    step: r.blamed?.step ?? null,
    steps: r.steps,
    scope: b.scope,
    confidence: r.confidence,
    confidenceWhy,
    boundary,
    next: r.lost ? { callNo: r.lost.callNo, step: r.lost.step, passes: r.lost.passes, attempts: r.lost.attempts.length } : null,
    rescuedRunId: contrast?.rescuedRunId ?? null,
    answers: contrast ? { callNo: contrast.callNo, recorded: describeBlocks(contrast.recorded), rescued: describeBlocks(contrast.rescued) } : null,
    rescue: describeRescue(r.rescue?.fields ?? {}),
    needed: r.needed,
    attemptsPerProbe: r.attemptsPerProbe,
    probes: r.probes.map((x) => ({ callNo: x.callNo, step: x.step, passes: x.passes, attempts: x.attempts.length, verdict: verdictOf(x), blamed: x.callNo === blamedCall, href: runHref(b.runId, x.callNo) })),
    bundles: r.probes.map((x) => ({
      callNo: x.callNo,
      title: `blame · probe #${x.callNo}`,
      blamed: x.callNo === blamedCall,
      passes: x.passes,
      attempts: x.attempts.map((a) => ({ runId: a.runId, passed: a.passed, note: a.passed ? 'passed' : shortFailure(a.failures[0]), spent: a.spent, href: runHref(a.runId) })),
    })),
    callRow,
    cost: { attempts: r.attempts, upstreamRequests: r.upstreamRequests, spent: r.spent, unknownModels: r.unknownModels },
    oracle: r.oracle,
    recordedFailures: r.recordedFailures,
    stopReason: r.stopReason,
    warnings: r.warnings,
    command: b.command,
    hrefs: { run: runHref(b.runId), lostAt: blamedCall ? runHref(b.runId, blamedCall) : null, rescued: contrast ? runHref(contrast.rescuedRunId) : null },
  };
}

/** Where `after` differs from `before`: the text added, and where, and the text it replaced. */
function addedText(before: string, after: string): { added: { at: number; text: string } | null; removed: string } {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let e = 0;
  while (e < before.length - p && e < after.length - p && before[before.length - 1 - e] === after[after.length - 1 - e]) e++;
  const text = after.slice(p, after.length - e);
  return { added: text ? { at: p, text } : null, removed: before.slice(p, before.length - e) };
}

function candidateVerdict(c: RepairCandidate, r: StoredRepair): { verdict: CandidateVerdict; why: string } {
  switch (c.state) {
    case 'accepted':
      return { verdict: 'accepted', why: 'the smallest rewrite the gate accepts' };
    case 'invalid':
      return { verdict: 'set aside', why: c.reason ?? 'it could not be applied, so it never ran' };
    case 'rejected':
      return { verdict: 'rejected', why: c.reason ?? 'the gate rejected it' };
    case 'build-failed':
      return { verdict: 'build failed', why: c.reason ?? 'the build failed' };
    case 'incomplete':
      return { verdict: 'unsettled', why: c.reason ?? 'its verification did not finish' };
    default:
      return { verdict: 'not tried', why: r.accepted ? 'a smaller candidate was accepted first' : r.outcome === 'stopped' ? `the repair stopped first${r.report.why ? `: ${r.report.why}` : ''}` : 'not tried' };
  }
}

/** `1 file · +1 −1` for a patch. */
function patchNote(patch: string | null): string {
  if (!patch) return 'no patch';
  const lines = patch.split('\n');
  const files = lines.filter((l) => l.startsWith('diff --git ')).length;
  const plus = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const minus = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
  return `${files} file${s(files)} · +${plus} −${minus}`;
}

function repairStep(rec: FixRecords, r: StoredRepair, fixId: string): RepairStep {
  const rep = r.report;
  const c = acceptedCandidate(r);
  const v = c?.verify ?? null;
  const verdict = rec.verdicts.find((x) => x.repairId === r.repairId) ?? null;
  const roles: RepairStep['roles'] = [];
  if (v) {
    for (const role of ['target', 'holdout', 'good'] as const) {
      const of = v.runs.filter((x) => x.role === role);
      if (of.length) roles.push({ role: ROLE[role], held: of.filter((x) => x.verdict === 'pass').length, of: of.length });
    }
  }
  const dir = r.dir.replace(/\/+$/, '');
  const goldens = rep.output.goldens.length;
  return {
    repairId: r.repairId,
    at: r.at,
    dir,
    outcome: r.outcome,
    accepted: r.accepted,
    title: c ? commitTitle(c) : 'No fix yet',
    why: c ? null : rep.why,
    repairer: repairerLabel(r),
    served: rep.repairer?.served && rep.repairer.served !== rep.repairer.model ? rep.repairer.served : null,
    verify: v ? { verifyId: verdict?.verifyId ?? null, attempts: v.attempts, spent: v.spent } : null,
    change: c ? { file: c.file, anchor: c.surface, before: c.before, after: c.after, ...addedText(c.before, c.after) } : null,
    roles,
    needed: v?.needed ?? null,
    attemptsPerRun: v?.attemptsPerRun ?? null,
    lost: rep.targets.map((t) => ({
      runId: t.runId,
      at: t.outcome === 'blamed' && t.callNo !== null ? `model call #${t.callNo} (${t.step} of ${t.steps})${t.rescuedBy ? `, rescued by ${t.rescuedBy}` : ''}` : t.outcome === 'unrescuable' ? 'not rescued from any model call' : (t.note ?? t.outcome),
      href: fixHref(fixId, 'blame'),
    })),
    diagnosis: rep.diagnosis,
    candidates: rep.candidates.map((x) => ({ id: x.id, text: x.after, surface: x.surface, file: x.file, source: x.source, ...candidateVerdict(x, r) })),
    files: [
      ...(rep.patch ? [{ name: 'fix.patch', note: patchNote(rep.patch) }] : []),
      { name: 'report.md', note: 'the pull request body' },
      { name: 'report.json', note: 'for agents and CI' },
      ...(goldens ? [{ name: 'goldens/', note: `${goldens} recording${s(goldens)} made by the fixed code` }] : []),
    ],
    prBody: repairMarkdown(rep),
    command: r.command,
    cost: rep.cost,
    output: { patch: rep.output.patch, applied: rep.output.applied, branch: rep.output.branch, pr: rep.output.pr, goldens: rep.output.goldens },
    warnings: rep.warnings,
  };
}

/** A change in percent, as verify prints it: +20%, −5.0%, ±0%. */
function pct(before: number, after: number): string {
  if (before === 0) return after === 0 ? '±0%' : 'new';
  const d = ((after - before) / before) * 100;
  return `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d) < 10 ? Math.abs(d).toFixed(1) : Math.round(Math.abs(d))}%`;
}

function headline(v: StoredVerdict): string {
  const runs = v.report.runs;
  if (v.verdict === 'accepted') {
    const failing = runs.some((x) => x.role !== 'good');
    const good = runs.some((x) => x.role === 'good');
    return failing && good ? 'Every failing run fixed, every good run kept' : failing ? 'Every failing run fixed' : 'Every good run kept';
  }
  if (v.verdict === 'rejected') return runs.some((x) => x.role === 'good' && x.verdict === 'fail') ? 'The change broke a run that worked' : 'The change did not fix every failing run';
  return 'Not every run settled';
}

function verifyStep(v: StoredVerdict, fixId: string): VerifyStep {
  const r = v.report;
  const code = v.candidate !== null ? `repair candidate ${v.candidate}` : (r.codeVersion ?? 'working tree');
  const rows: VerifyRow[] = r.runs.map((x) => {
    const failure = x.verdict === 'fail' ? x.attempts.find((a) => !a.passed)?.failures[0] : undefined;
    const forks = [...new Set(x.attempts.map((a) => a.forkedAt).filter((f): f is number => f !== null))];
    const n = x.attempts.length;
    const mean = (pick: (a: (typeof x.attempts)[number]) => number | null) => {
      if (!n) return null;
      let sum = 0;
      for (const a of x.attempts) {
        const value = pick(a);
        if (value === null) return null;
        sum += value;
      }
      return sum / n;
    };
    const now = mean((a) => a.footprint.inputTokens);
    return {
      role: ROLE[x.role],
      runId: x.runId,
      href: runHref(x.runId),
      attempts: n,
      passes: x.passes,
      deterministic: x.deterministic,
      outcome: outcomeOf(x),
      note: failure ? shortFailure(failure) : !n ? 'not started' : x.deterministic ? 'clean replay' : forks.length ? `forked at ${forks.map((f) => `#${f}`).join(', ')}` : '',
      tokens: now === null ? null : { recorded: x.recorded.footprint.inputTokens, now },
      cost: n ? { recorded: x.recorded.footprint.cost, now: mean((a) => a.footprint.cost) } : null,
    };
  });
  const d = footprintDelta(r.runs);
  return {
    verifyId: v.verifyId,
    href: fixHref(fixId, 'verify', v.verifyId),
    at: v.at,
    verdict: v.verdict,
    code,
    label: `${code} · ${v.verdict}`,
    headline: headline(v),
    oracle: `a run passes when ${r.needed} of ${r.attemptsPerRun} attempts meet the check: ${r.oracle.join('; ')}`,
    needed: r.needed,
    attemptsPerRun: r.attemptsPerRun,
    rows,
    tokens: d ? { before: d.recorded.inputTokens, after: d.now.inputTokens, change: pct(d.recorded.inputTokens, d.now.inputTokens) } : null,
    cost: d && d.recorded.cost !== null && d.now.cost !== null ? { before: d.recorded.cost, after: d.now.cost, change: pct(d.recorded.cost, d.now.cost) } : null,
    attempts: r.attempts,
    upstreamRequests: r.upstreamRequests,
    spent: r.spent,
    unknownModels: r.unknownModels,
    reasons: r.reasons,
    warnings: [...r.warnings, ...(r.replayWarnings ?? [])],
    command: v.command,
    repairId: v.repairId,
    candidate: v.candidate,
  };
}

/** `shadowlap repair` from a fix: its failing runs (by label when it has one), the good runs, its check. */
export function repairArgv(store: Store, rec: FixRecords): string[] {
  const fixes = rec.fix.label ? [`label:${rec.fix.label}`] : rec.failing;
  const anyGood = store.allRuns().some((r) => r.meta?.labels?.includes(GOOD_LABEL));
  const keeps = anyGood ? [`label:${GOOD_LABEL}`] : rec.good;
  const expect = rec.fix.check.expect;
  return ['repair', '--fixes', ...fixes, ...(keeps.length ? ['--keeps', ...keeps] : []), ...(expect !== null && expect !== undefined ? ['--expect', JSON.stringify(expect)] : [])];
}

/** One fix, every step as its page shows it. Null for an id that matches no fix. */
export function fixDetail(store: Store, idOrPrefix: string): FixDetail | null {
  let found: StoredFix | null;
  try {
    found = resolveFix(store, idOrPrefix);
  } catch {
    return null; // ambiguous
  }
  if (!found) return null;
  const fix = found;
  const rec = fixRecords(store, fix);
  const row = rowOf(rec);
  const cost = fixCost([rec]);
  const b = shownBlame(rec);
  const p = shownRepair(rec);
  const verify = [...rec.verdicts].reverse().map((v) => verifyStep(v, fix.fixId));
  const accepted = acceptedVerdict(rec);
  const done = row.steps.filter((x) => x.state === 'done');
  const repairArgs = repairArgv(store, rec);
  const expect = fix.check.expect;
  const blameRun = b?.runId ?? rec.failing[0] ?? null;
  const acceptedRepair = p && p.accepted ? p : null;
  return {
    ...row,
    expect,
    failingRuns: rec.failing.map((id) => runRef(store, id)),
    goodRuns: rec.good.map((id) => runRef(store, id)),
    openedBy: fix.data.openedBy ?? null,
    upstreamRequests: cost.upstreamRequests,
    defaultStep: done.at(-1)?.key ?? 'blame',
    actions: {
      repair: fix.status === 'open' ? { argv: repairArgs, command: commandLine([...repairArgs, '--repairer', 'claude-code']) } : null,
      apply: fix.status === 'verified' ? { kind: acceptedRepair ? 'patch' : 'mark', argv: ['fix', 'apply', fix.fixId], gitApply: acceptedRepair?.report.patch ? `git apply ${acceptedRepair.dir.replace(/\/+$/, '')}/fix.patch` : null } : null,
      applied: fix.status === 'applied',
    },
    blame: b ? blameStep(store, b) : null,
    blames: [...rec.blames].reverse().map((x) => ({ blameId: x.blameId, runId: x.runId, at: x.at, outcome: x.outcome, lostAt: x.report.blamed?.callNo ?? null, confidence: x.report.confidence })),
    repair: p ? repairStep(rec, p, fix.fixId) : null,
    repairs: [...rec.repairs].reverse().map((x) => ({ repairId: x.repairId, at: x.at, outcome: x.outcome, accepted: x.accepted, title: (() => { const c = acceptedCandidate(x); return c ? commitTitle(c) : 'No fix yet'; })() })),
    verify,
    defaultVerify: accepted?.verifyId ?? verify[0]?.verifyId ?? null,
    commands: {
      blame: commandLine(['blame', blameRun ? short(blameRun) : '<run>', ...(expect !== null && expect !== undefined ? ['--expect', JSON.stringify(expect)] : [])]),
      repair: commandLine([...repairArgs.map((a) => (/^[0-9A-Z]{26}$/.test(a) ? short(a) : a)), '--repairer', 'claude-code']),
      verify: commandLine(['verify', ...repairArgs.slice(1).map((a) => (/^[0-9A-Z]{26}$/.test(a) ? short(a) : a))]),
    },
    applied: fix.data.applied ?? null,
  };
}

// ---- For the other views ------------------------------------------------------------------------

export interface FixesSummary {
  /** Fixes still open, and verified fixes not applied yet. */
  open: number;
  readyToApply: number;
  /**
   * How far failures got: every failure (fixes, and failed runs never blamed), those blamed to a
   * finished verdict, those with a verified fix (applied ones too), and those applied.
   */
  funnel: { failures: number; blamed: number; verified: number; applied: number };
  /** The attempts behind every fix, and what they and the repairers cost, in USD. */
  attempts: number;
  upstreamRequests: number;
  spent: number;
  /** Failures blame reproduced (it replays a run exactly before it probes), by the time of a run's first blame. */
  reproduced: { thisWeek: number; lastWeek: number; total: number };
  /** Accepted verdicts on fixes, and rejected ones: changes rejected before they shipped. */
  verified: { thisWeek: number; lastWeek: number; total: number };
  rejected: { thisWeek: number; lastWeek: number; total: number };
}

const WEEK = 7 * 24 * 60 * 60 * 1000;

/** What fixes came to, for the Overview: this week is the 7 days up to `now`, last week the 7 before. */
export function fixesSummary(store: Store, now: number = Date.now()): FixesSummary {
  const fixes = store.listFixes();
  const records = fixes.map((f) => fixRecords(store, f));
  const cost = fixCost(records);
  const week = (at: number) => (at <= now && at > now - WEEK ? 'this' : at <= now - WEEK && at > now - 2 * WEEK ? 'last' : null);
  const tally = (ats: number[]) => ({ thisWeek: ats.filter((a) => week(a) === 'this').length, lastWeek: ats.filter((a) => week(a) === 'last').length, total: ats.length });

  const firstBlame = new Map<string, number>();
  for (const b of store.listBlames()) if (!firstBlame.has(b.runId)) firstBlame.set(b.runId, b.at);
  const verdicts = new Map<string, StoredVerdict>();
  for (const rec of records) for (const v of rec.verdicts) verdicts.set(v.verifyId, v);
  const of = (verdict: VerifyOutcome) => [...verdicts.values()].filter((v) => v.verdict === verdict).map((v) => v.at);

  const blamed = records.filter((r) => r.blames.some((b) => b.outcome !== 'stopped')).length;
  return {
    open: fixes.filter((f) => f.status === 'open').length,
    readyToApply: fixes.filter((f) => f.status === 'verified').length,
    funnel: { failures: fixes.length + unblamedFailures(store).length, blamed, verified: fixes.filter((f) => f.status !== 'open').length, applied: fixes.filter((f) => f.status === 'applied').length },
    attempts: cost.attempts,
    upstreamRequests: cost.upstreamRequests,
    spent: cost.spent,
    reproduced: tally([...firstBlame.values()]),
    verified: tally(of('accepted')),
    rejected: tally(of('rejected')),
  };
}

/**
 * A failed run that is not a fix yet: a recording whose agent exited with an error, never blamed and
 * in no fix. Attempts, tests and forks are not recordings, so a failed fork is not counted.
 */
function isUnblamedFailure(store: Store, run: RunRecord): boolean {
  if (run.mode !== 'record' || run.status !== 'failed') return false;
  if (run.meta?.blame || store.blamesOfRun(run.runId).length) return false;
  return store.linksTo(run.runId, 'failing').length === 0;
}

function unblamedFailures(store: Store): RunRecord[] {
  return store.allRuns().filter((r) => isUnblamedFailure(store, r));
}

export interface NeedsLookItem {
  /** `open`: a failure with no fix yet; `unblamed`: a failed run never blamed; `ready`: a verified fix not applied. */
  kind: 'open' | 'unblamed' | 'ready';
  href: string;
  /** The glyph the mock gives it: blame, fail or fixok. */
  icon: 'blame' | 'fail' | 'fixok';
  title: string;
  detail: string;
  action: 'Fix it' | 'Run blame' | 'Apply';
  fixId: string | null;
  runId: string | null;
  at: number;
  /** For a failed run never blamed: the check of a fix with the same label, which a blame of it can use. */
  expect?: unknown;
}

/** What needs a look about fixes, most urgent first: failures with no fix yet (open fixes, then failed runs never blamed), then verified fixes not applied. */
export function needsLookFixes(store: Store, options: { limit?: number } = {}): NeedsLookItem[] {
  const open: NeedsLookItem[] = [];
  const ready: NeedsLookItem[] = [];
  for (const fix of store.listFixes()) {
    const rec = fixRecords(store, fix);
    if (fix.status === 'open') {
      const b = shownBlame(rec);
      const where = b?.outcome === 'blamed' && b.report.blamed ? `lost at model call #${b.report.blamed.callNo}` : b?.outcome === 'unrescuable' ? 'not rescued from any model call' : 'blame stopped early';
      open.push({ kind: 'open', href: fixHref(fix.fixId), icon: 'blame', title: fix.title, detail: `${where} · ${rec.repairs.length ? 'no fix found yet' : 'no fix yet'}`, action: 'Fix it', fixId: fix.fixId, runId: null, at: fix.openedAt });
    } else if (fix.status === 'verified') {
      const p = shownRepair(rec);
      const c = p && acceptedCandidate(p);
      ready.push({ kind: 'ready', href: fixHref(fix.fixId, c ? 'repair' : 'verify'), icon: 'fixok', title: 'A verified fix is ready', detail: c ? commitTitle(c) : fix.title, action: 'Apply', fixId: fix.fixId, runId: null, at: fix.verifiedAt ?? fix.openedAt });
    }
  }
  const unblamed: NeedsLookItem[] = unblamedFailures(store).map((run) => {
    const joined = (run.meta?.labels ?? []).map((l) => store.fixesByGroup(`label:${l}`)[0]).find(Boolean);
    return {
      kind: 'unblamed' as const,
      href: runHref(run.runId),
      icon: 'fail' as const,
      title: `A run failed: ${short(run.runId)}`,
      detail: `${(run.meta?.labels ?? []).filter((l) => l !== GOOD_LABEL).join(', ') || run.command.argv.join(' ').slice(0, 60)} · not blamed yet`,
      action: 'Run blame' as const,
      fixId: null,
      runId: run.runId,
      at: run.startedAt,
      ...(joined ? { expect: joined.check.expect } : {}),
    };
  });
  const newest = (a: NeedsLookItem, b: NeedsLookItem) => b.at - a.at;
  const all = [...open.sort(newest), ...unblamed.sort(newest), ...ready.sort(newest)];
  return options.limit ? all.slice(0, options.limit) : all;
}

export interface FixRef {
  fixId: string;
  href: string;
  title: string;
  status: FixStatus;
  label: string | null;
  check: string;
}

/** What a run page's blame banner says: lost at #n, model call k of m, the confidence, and in a few words what asking again did. */
export interface RunBlame {
  blameId: string;
  at: number;
  outcome: StoredBlame['outcome'];
  lostAt: number | null;
  step: number | null;
  steps: number;
  confidence: 'high' | 'medium' | 'low';
  rescuedRunId: string | null;
  /** "asked again, it calls escalate instead". */
  short: string;
  href: string;
}

export interface FixForRun {
  /**
   * How the run takes part: a failing run of the fix, a good run it keeps, an attempt of a blame
   * probe, the fork blame rescued it with, an attempt of a verify, or a failed run never blamed.
   */
  role: 'failing' | 'good' | 'probe' | 'rescued' | 'verify' | 'unblamed';
  fix: FixRef | null;
  /** The blame of the failing run (for a probe or the rescued fork, of the run it forked from). */
  blame: RunBlame | null;
  probe: { of: string; callNo: number; passed: boolean; blamed: boolean } | null;
  /** For a verify attempt: the verdict it counted towards (or the repair whose dropped candidate it tried). */
  verify: { verifyId: string | null; repairId: string | null; verdict: VerifyOutcome | null; role: VerifiedRun['role']; passed: boolean; href: string } | null;
}

function fixRef(fix: StoredFix): FixRef {
  return { fixId: fix.fixId, href: fixHref(fix.fixId), title: fix.title, status: fix.status, label: fix.label, check: fix.check.text };
}

function runBlame(b: StoredBlame, fixId: string | null): RunBlame {
  const r = b.report;
  const rescued = r.contrast?.rescued ?? [];
  const tools = [...new Set(rescued.flatMap((x) => (x.type === 'tool_call' ? [x.name] : [])))];
  const what = b.outcome === 'blamed' ? (tools.length ? `asked again, it calls ${tools.join(' and ')} instead` : rescued.length ? 'asked again, it answers without a tool call' : 'asked again, the run passes') : b.outcome === 'unrescuable' ? 'not rescued from any model call' : 'blame stopped early';
  return { blameId: b.blameId, at: b.at, outcome: b.outcome, lostAt: r.blamed?.callNo ?? null, step: r.blamed?.step ?? null, steps: r.steps, confidence: r.confidence, rescuedRunId: r.contrast?.rescuedRunId ?? null, short: what, href: fixId ? fixHref(fixId, 'blame') : runHref(b.runId) };
}

/** How a run takes part in Fixes, for its page and the Forks view; null when it doesn't. */
export function fixForRun(store: Store, runId: string): FixForRun | null {
  const run = store.getRun(runId);
  if (!run) return null;
  const failing = fixOfRun(store, runId);
  if (failing) {
    const b = store.blamesOfRun(runId).at(-1);
    return { role: 'failing', fix: fixRef(failing), blame: b ? runBlame(b, failing.fixId) : null, probe: null, verify: null };
  }
  const probe = run.meta?.probe;
  if (probe && typeof probe.of === 'string') {
    const fix = fixOfRun(store, probe.of);
    const blames = store.blamesOfRun(probe.of);
    const b = [...blames].reverse().find((x) => x.report.probes.some((p) => p.attempts.some((a) => a.runId === runId))) ?? blames.at(-1) ?? null;
    const rescued = !!b && b.report.contrast?.rescuedRunId === runId;
    return {
      role: rescued ? 'rescued' : 'probe',
      fix: fix ? fixRef(fix) : null,
      blame: b ? runBlame(b, fix?.fixId ?? null) : null,
      probe: { of: probe.of, callNo: probe.callNo, passed: probe.passed, blamed: !!b && b.report.blamed?.callNo === probe.callNo },
      verify: null,
    };
  }
  const attempt = run.meta?.verify;
  if (attempt) {
    const inReport = (r: { runs: VerifiedRun[] }) => r.runs.some((x) => x.attempts.some((a) => a.runId === runId));
    const verdict = [...store.listVerdicts()].reverse().find((v) => inReport(v.report)) ?? null;
    const repair = verdict ? null : ([...store.listRepairs()].reverse().find((r) => r.report.candidates.some((c) => c.verify && inReport(c.verify))) ?? null);
    const link = verdict ? store.linksTo(verdict.verifyId, 'verify')[0] : repair ? store.linksTo(repair.repairId, 'repair')[0] : undefined;
    const fix = link ? store.getFix(link.fixId) : run.parentRunId ? fixOfRun(store, run.parentRunId) : null;
    const href = fix ? (verdict ? fixHref(fix.fixId, 'verify', verdict.verifyId) : fixHref(fix.fixId, 'repair')) : runHref(run.parentRunId ?? runId);
    return { role: 'verify', fix: fix ? fixRef(fix) : null, blame: null, probe: null, verify: { verifyId: verdict?.verifyId ?? null, repairId: verdict?.repairId ?? repair?.repairId ?? null, verdict: verdict?.verdict ?? null, role: attempt.role, passed: attempt.passed, href } };
  }
  const good = store.linksTo(runId, 'good')[0];
  if (good) {
    const fix = store.getFix(good.fixId);
    if (fix) return { role: 'good', fix: fixRef(fix), blame: null, probe: null, verify: null };
  }
  if (isUnblamedFailure(store, run)) return { role: 'unblamed', fix: null, blame: null, probe: null, verify: null };
  return null;
}
