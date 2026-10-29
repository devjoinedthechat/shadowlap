import { canonicalize, fixLabelInfo, fixLabels, fixOfRun, lostAround, type Block, type FixStatus, type StoreOf, type StoredBlame, type StoredFix, type VerifiedRun, type VerifyOutcome, unrescuedWords, unsettledFirst } from '@shadowlap/engine';
import { checkSuggestion, fixHref, isUnblamedFailure, labelledFixes, runHref, toolsCalled } from './fix-shared.js';

/** A run's fix, as its page shows it: the fix it fails in, and what blame found of it. */

export interface FixRef {
  fixId: string;
  href: string;
  title: string;
  status: FixStatus;
  label: string | null;
  check: string;
}

/** What a run page's blame banner says: lost at #n (or gradually around two calls), model call k of m, the confidence, and in a few words what asking again did. */
export interface RunBlame {
  blameId: string;
  at: number;
  outcome: StoredBlame['outcome'];
  /** It placed the failure on no call only because its first probe couldn't tell: not settled, never "not rescued". Absent otherwise. */
  unsettled?: true;
  lostAt: number | null;
  /** The two calls it was lost gradually around, when no one call lost the run (lostAround): the banner says so, never "lost at". */
  range: { from: number; to: number; gradual: true } | null;
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
  /** For a failed run never blamed: the check of a fix its labels point to, which Run blame can use. */
  expect?: unknown;
}

function fixRef(store: StoreOf<'recording' | 'fixes'>, fix: StoredFix): FixRef {
  return { fixId: fix.fixId, href: fixHref(fix.fixId), title: fix.title, status: fix.status, label: fixLabelInfo(store, fix).label, check: fix.check.text };
}

/**
 * What asking the blamed call again did, against what the recording answered there, in a few words:
 * "it calls escalate instead" only when it calls other tools; the same tools with other arguments,
 * an answer without a tool call, or the same calls in other words or order say so.
 */
function askedInstead(recorded: readonly Block[], rescued: readonly Block[]): string {
  const was = toolsCalled(recorded);
  const now = toolsCalled(rescued);
  const calls = (blocks: readonly Block[]) => blocks.flatMap((x) => (x.type === 'tool_call' ? [`${x.name} ${canonicalize(x.input ?? null)}`] : [])).sort().join('\n');
  if (!rescued.length) return 'the run passes';
  if (!now.length) return was.length ? 'it answers without a tool call' : 'it answers differently';
  if (now.length !== was.length || now.some((t) => !was.includes(t))) return `it calls ${now.join(' and ')} instead`;
  return calls(rescued) !== calls(recorded) ? `it calls ${now.join(' and ')} with other arguments` : 'it answers differently';
}

function runBlame(b: StoredBlame, fixId: string | null): RunBlame {
  const r = b.report;
  const what = b.outcome === 'blamed' ? `asked again, ${askedInstead(r.contrast?.recorded ?? [], r.contrast?.rescued ?? [])}` : b.outcome === 'unrescuable' ? unrescuedWords(unsettledFirst(r)) : 'blame stopped early';
  return { blameId: b.blameId, at: b.at, outcome: b.outcome, ...(unsettledFirst(r) ? { unsettled: true as const } : {}), lostAt: r.blamed?.callNo ?? null, range: lostAround(r.range), step: r.blamed?.step ?? null, steps: r.steps, confidence: r.confidence, rescuedRunId: r.contrast?.rescuedRunId ?? null, short: what, href: fixId ? fixHref(fixId, 'blame') : runHref(b.runId) };
}

/** How a run takes part in Fixes, for its page and the Forks view; null when it doesn't. */
export function fixForRun(store: StoreOf<'recording' | 'readModels' | 'fixes'>, runId: string): FixForRun | null {
  const run = store.getRun(runId);
  if (!run) return null;
  const failing = fixOfRun(store, runId);
  if (failing) {
    const b = store.blamesOfRun(runId).at(-1);
    return { role: 'failing', fix: fixRef(store, failing), blame: b ? runBlame(b, failing.fixId) : null, probe: null, verify: null };
  }
  const probe = run.meta?.probe;
  if (probe && typeof probe.of === 'string') {
    const fix = fixOfRun(store, probe.of);
    const blames = store.blamesOfRun(probe.of);
    const b = [...blames].reverse().find((x) => x.report.probes.some((p) => p.attempts.some((a) => a.runId === runId))) ?? blames.at(-1) ?? null;
    const rescued = !!b && b.report.contrast?.rescuedRunId === runId;
    return {
      role: rescued ? 'rescued' : 'probe',
      fix: fix ? fixRef(store, fix) : null,
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
    return { role: 'verify', fix: fix ? fixRef(store, fix) : null, blame: null, probe: null, verify: { verifyId: verdict?.verifyId ?? null, repairId: verdict?.repairId ?? repair?.repairId ?? null, verdict: verdict?.verdict ?? null, role: attempt.role, passed: attempt.passed, href } };
  }
  const good = store.linksTo(runId, 'good')[0];
  if (good) {
    const fix = store.getFix(good.fixId);
    if (fix) return { role: 'good', fix: fixRef(store, fix), blame: null, probe: null, verify: null };
  }
  if (isUnblamedFailure(store, run)) {
    const suggested = checkSuggestion(run, fixLabels(run).length ? labelledFixes(store) : []);
    return { role: 'unblamed', fix: null, blame: null, probe: null, verify: null, ...(suggested ? { expect: suggested.expect } : {}) };
  }
  return null;
}
