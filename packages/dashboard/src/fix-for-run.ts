import { canonicalize, checkSuggestion, fixLabelInfo, fixLabels, fixLinksOfRun, fixOfRun, fixRecords, labelledFixes, lostRange, type Block, type FixStatus, type StoreOf, type StoredBlame, type StoredFix, type VerifiedRun, type VerifyOutcome, unrescuedSaid, unsettledFirst } from '@shadowlap/engine';
import { changeWords } from './fix-list.js';
import { brokenOf, fixHref, type FixPr, type FixRung, isUnblamedFailure, prOf, rungOf, runHref, toolsCalled } from './fix-shared.js';
import type { RunIndex } from './run-index.js';

/** A run's fix, as its page shows it: the fix it fails in, and what blame found of it. */

export interface FixRef {
  fixId: string;
  href: string;
  title: string;
  status: FixStatus;
  label: string | null;
  check: string;
  /** How it stands, as Fixes says it, in the words its link on a run's page and its Open fix say (`fixSaid`). */
  said: FixSaid;
  /** What a run's finding says of it: how it stands, for a run that fails in it (`fixStateWords`); what a good run of it is for. */
  state: string;
}

/** How a fix stands in a run page's words: the tone of its dot, its words beside its link, and why on hover. */
export interface FixSaid {
  tone: 'warn' | 'ok' | 'err';
  text: string;
  why: string;
}

/**
 * Where a fix stands, as Fixes says it: its status, its rung on the ladder (`rungOf`: merged with its
 * pull request), why an applied one doesn't hold (`brokenOf`), and for an open one what changed and
 * what verify made of it, as Needs a look says it (`changeWords`); null where nothing changed.
 */
interface Standing {
  status: FixStatus;
  title: string;
  rung: FixRung;
  pr: FixPr | null;
  broken: string | null;
  change: string | null;
}

/**
 * How a fix stands on a run's page, as Fixes says it: open (with what changed), verified and not
 * applied yet, applied, or merged with its pull request; an applied fix that doesn't hold is broken,
 * in red.
 */
export function fixSaid(s: Standing): FixSaid {
  if (s.status === 'applied' && s.broken) return { tone: 'err', text: 'fix broken', why: `applied, but it doesn’t hold: ${s.broken}` };
  if (s.status === 'open') return { tone: 'warn', text: 'fix open', why: s.change ? `open: ${s.change}` : 'open: no change has been verified for it yet' };
  if (s.rung === 'merged') return { tone: 'ok', text: s.pr?.number != null ? `fix merged · PR #${s.pr.number}` : 'fix merged', why: 'merged: its change shipped with its pull request' };
  if (s.status === 'applied') return { tone: 'ok', text: 'fix applied', why: 'applied: its change is in your working tree' };
  return { tone: 'ok', text: `fix ${s.status}`, why: `${s.status}: a change fixed its failing runs, not applied yet` };
}

/**
 * What the finding of a run that fails in a fix says of it, as Fixes says it: no change yet for it,
 * or what changed for an open one; fixed, and how far (verified, applied, merged); or applied and
 * broken since.
 */
export function fixStateWords(s: Standing): string {
  if (s.status === 'open') return s.change ? `“${s.title}”: ${s.change}` : `no change yet for “${s.title}”`;
  if (s.status === 'applied' && s.broken) return `“${s.title}” is applied but doesn’t hold · ${s.broken}`;
  return `fixed: “${s.title}”, ${s.rung === 'merged' ? 'merged' : s.status}`;
}

/** What a run page's blame banner says: lost at #n (or around or between two calls), model call k of m, the confidence, and in a few words what asking again did. */
export interface RunBlame {
  blameId: string;
  at: number;
  outcome: StoredBlame['outcome'];
  /** It placed the failure on no call only because its first probe couldn't tell: inconclusive at the first model call, never "not rescued". Absent otherwise. */
  unsettled?: true;
  lostAt: number | null;
  /** The two calls it was lost around or between, when no one call is pinned (lostRange): the banner says so, never "lost at". */
  range: { from: number; to: number; gradual?: true } | null;
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

/** A fix as a run's page and its next step name it. */
export function fixRef(store: StoreOf<'recording' | 'fixes'>, fix: StoredFix): FixRef {
  const rec = fixRecords(store, fix);
  const standing: Standing = { status: fix.status, title: fix.title, rung: rungOf(rec), pr: prOf(rec), broken: brokenOf(rec), change: fix.status === 'open' ? changeWords(rec) : null };
  return { fixId: fix.fixId, href: fixHref(fix.fixId), title: fix.title, status: fix.status, label: fixLabelInfo(store, fix).label, check: fix.check.text, said: fixSaid(standing), state: fixStateWords(standing) };
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

/** What a blame found, in a few words: "asked again, it calls escalate instead", or why it placed the failure on no call. A run's page says it with or without a fix. */
export function blameShort(b: StoredBlame): string {
  const r = b.report;
  return b.outcome === 'blamed' ? `asked again, ${askedInstead(r.contrast?.recorded ?? [], r.contrast?.rescued ?? [])}` : b.outcome === 'unrescuable' ? unrescuedSaid(r) : 'blame stopped early';
}

function runBlame(b: StoredBlame, fixId: string | null): RunBlame {
  const r = b.report;
  return { blameId: b.blameId, at: b.at, outcome: b.outcome, ...(unsettledFirst(r) ? { unsettled: true as const } : {}), lostAt: r.blamed?.callNo ?? null, range: lostRange(r.range), step: r.blamed?.step ?? null, steps: r.steps, confidence: r.confidence, rescuedRunId: r.contrast?.rescuedRunId ?? null, short: blameShort(b), href: fixId ? fixHref(fixId, 'blame') : runHref(b.runId) };
}

/** How a run takes part in Fixes, for its page and the Forks view; null when it doesn't. `index`: the run index, where the caller has it for many runs. */
export function fixForRun(store: StoreOf<'recording' | 'readModels' | 'fixes'>, runId: string, index?: RunIndex): FixForRun | null {
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
  const good = fixLinksOfRun(store, runId, 'good')[0];
  if (good) {
    const fix = store.getFix(good.fixId);
    // Its finding says what a good run of it is for.
    if (fix) return { role: 'good', fix: { ...fixRef(store, fix), state: `a good run of “${fix.title}”: a change must keep it passing` }, blame: null, probe: null, verify: null };
  }
  if (isUnblamedFailure(store, run, index)) {
    const suggested = checkSuggestion(run, fixLabels(run).length ? labelledFixes(store) : []);
    return { role: 'unblamed', fix: null, blame: null, probe: null, verify: null, ...(suggested ? { expect: suggested.expect } : {}) };
  }
  return null;
}
