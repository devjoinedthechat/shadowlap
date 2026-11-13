import { ownArgs } from './job-title.js';
import { ACTIONS } from './labels.js';

/**
 * How a job ended, in the words its own kind has for it: a session's verdict and tally, an update
 * that held or diverged again, the commit a search named, what a revert left, a verify's verdict, a repeat's paths. What
 * these don't name, `jobStatus` (jobs.ts) words from the CLI's own lines. An exit code is always the
 * job's real one. No DOM here: the tests import it.
 */

export interface JobWords {
  text: string;
  tone: '' | 'ok' | 'warn' | 'err';
}

/** What the words are read from: an ended job with an exit code. */
interface EndedJob {
  args: readonly string[];
  kind?: string | undefined;
  title?: string | undefined;
  code: number | null;
  result?: unknown;
  /** What a job's git step left in the working tree (Revert's): `done`, `untouched` or `conflicts`. */
  git?: 'done' | 'untouched' | 'conflicts' | undefined;
}

const asRecord = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** The last totals `shadowlap test` printed, each golden by its verdict. */
function sessionTotals(all: string): { passed: number; failed: number; inconclusive: number; interrupted: boolean } | null {
  const m = [...all.matchAll(/^(\d+) passed, (\d+) failed(?:, (\d+) inconclusive(?: \(.*?\))?)?(, \d+ not run: interrupted)?/gm)].at(-1);
  return m ? { passed: Number(m[1]), failed: Number(m[2]), inconclusive: Number(m[3] ?? 0), interrupted: !!m[4] } : null;
}

/** A job that re-records its goldens: Update golden, a task's, and Add normalizer and update golden. */
const updates = (job: EndedJob): boolean => job.kind === 'test-update' || job.kind === 'task-update' || (job.kind === 'normalize-and-test' && /updating/.test(job.title ?? ''));

/** What failed in Add normalizer and re-run's one golden: the check, or the request, which the normalizer didn't cover. */
function failedOne(job: EndedJob, all: string, goldens: number): string {
  if (job.kind !== 'normalize-and-test' || goldens !== 1) return 'failed';
  if (/^\s*✗ .*check failed/m.test(all)) return 'check failed';
  return /^\s*✗ .*diverged/m.test(all) ? 'diverged' : 'failed';
}

/** A session's verdict and its tally ("failed · 2 of 7 goldens passed · exit 1"); one golden needs no tally, and an update says whether it held. */
function sessionStatus(job: EndedJob, all: string, code: number): JobWords | null {
  const t = sessionTotals(all);
  if (!t) return null;
  const exit = `exit ${code}`;
  // Stopped: the goldens after the one it was replaying didn't run, so the counts are no verdict.
  if (t.interrupted || code === 130 || code === 143) return { text: `interrupted · ${exit}`, tone: 'warn' };
  const goldens = t.passed + t.failed + t.inconclusive;
  const tally = goldens > 1 && job.kind !== 'chaos' ? ` · ${t.passed} of ${goldens} goldens passed` : '';
  if (t.failed) return { text: `${updates(job) ? 'diverged again' : `${failedOne(job, all, goldens)}${tally}`} · ${exit}`, tone: 'err' };
  if (t.inconclusive) return { text: `inconclusive${tally} · ${exit}`, tone: 'warn' };
  if (code !== 0) return { text: `${t.passed} passed · ${exit}`, tone: 'err' };
  return goldens ? { text: updates(job) ? `updated · ${exit}` : `passed${tally} · ${exit}`, tone: 'ok' } : null;
}

/** Find breaking commit: the commit it named; none between the two, which nothing failed to reach (amber); or a range it couldn't take. */
function bisectStatus(job: EndedJob, all: string, code: number): JobWords | null {
  if (job.kind !== 'bisect' && job.args[0] !== 'bisect') return null;
  const exit = `exit ${code}`;
  const first = /^✓ first bad commit (\S+)/m.exec(all);
  if (first) return { text: `first bad commit ${first[1]!} · ${exit}`, tone: 'ok' };
  const none = /^✗ no first bad commit/m.test(all);
  if (none && code === 1) return { text: `no first bad commit · ${exit}`, tone: 'warn' };
  return none || code === 2 ? { text: `not searched · ${exit}`, tone: 'err' } : null;
}

/**
 * Revert: what git left in the tree, then how the golden's test came out. git refused and left the
 * tree as it was, `not reverted`; it left conflicts, `conflicts left in your working tree`; it
 * reverted and the test failed, `reverted · test failed`, the revert kept in the tree as Apply fix's
 * patch is. A test that passed reads as a session's does; one that ended otherwise, in a session's
 * words after `reverted` (`reverted · inconclusive · exit 3`).
 */
function revertStatus(job: EndedJob, all: string, code: number): JobWords | null {
  if (job.kind !== 'revert') return null;
  const exit = `exit ${code}`;
  if (job.git === 'conflicts') return { text: `conflicts left in your working tree · ${exit}`, tone: 'err' };
  if (job.git !== 'done') return { text: `not reverted · ${exit}`, tone: 'err' };
  if (code === 130 || code === 143) return { text: `reverted · test interrupted · ${exit}`, tone: 'warn' };
  const session = sessionStatus(job, all, code);
  if (code === 0) return session;
  // A failed golden, or no verdict at all to read, is the test that failed.
  return !session || sessionTotals(all)?.failed ? { text: `reverted · test failed · ${exit}`, tone: 'err' } : { text: `reverted · ${session.text}`, tone: session.tone };
}

/** A verify, a change's verify and a migration, by the verdict the command reported. */
function verdictStatus(job: EndedJob, code: number): JobWords | null {
  if (job.kind !== 'verify' && job.kind !== 'decisions-verify' && job.kind !== 'migrate') return null;
  const verdict = asRecord(job.result)?.verdict;
  const tones: Readonly<Record<string, JobWords['tone']>> = { accepted: 'ok', rejected: 'err', inconclusive: 'warn' };
  return typeof verdict === 'string' && tones[verdict] ? { text: `${verdict} · exit ${code}`, tone: tones[verdict] } : null;
}

/** Repeat: whether the attempts took one path. A repeat's failed check, or anything else non-zero, has the words of any replay. */
function repeatStatus(job: EndedJob, all: string, code: number): JobWords | null {
  const own = ownArgs(job.args);
  if (code !== 0 || own[0] !== 'replay' || !own.includes('--repeat')) return null;
  // Plant instruction: with no check to say whether the agent obeyed, all that can be said is that it replayed.
  if (own.includes('--inject-result')) return /check(s)? passed/i.test(all) ? null : { text: 'replayed · exit 0', tone: 'ok' };
  const report = asRecord(asRecord(job.result)?.report);
  const paths = Array.isArray(report?.paths) ? (report.paths as Array<{ runIds?: unknown }>) : [];
  const runs = paths.map((p) => (Array.isArray(p.runIds) ? p.runIds.length : 0));
  const total = runs.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const forked = Array.isArray(report?.forkedAt) && report.forkedAt.some((at) => at !== null);
  return { text: paths.length === 1 && !forked ? 'identical · exit 0' : `${Math.max(...runs)} of ${total} same path · exit 0`, tone: 'ok' };
}

/** A check tried on the recordings, by the counts it reported. */
function checkStatus(job: EndedJob, code: number): JobWords | null {
  if (job.kind !== 'check') return null;
  const r = asRecord(job.result);
  const counts = asRecord(r?.counts);
  if (!r || !counts || !Array.isArray(r.recordings)) return null;
  const exit = `exit ${code}`;
  const n = r.recordings.length;
  if (!n) return { text: `nothing to check · ${exit}`, tone: 'warn' };
  // As `shadowlap check` counts them: a recording no check applied to is not applicable, never passed.
  const na = Number(counts.notApplicable ?? 0);
  const tally = `${Number(counts.passed ?? 0)} of ${n} recording${n === 1 ? '' : 's'} passed${na ? `, ${na} not applicable` : ''}`;
  if (counts.failed) return { text: `failed · ${tally} · ${exit}`, tone: 'err' };
  if (counts.inconclusive) return { text: `inconclusive · ${tally} · ${exit}`, tone: 'warn' };
  return na === n ? { text: `not applicable · ${tally} · ${exit}`, tone: '' } : { text: `passed · ${tally} · ${exit}`, tone: 'ok' };
}

const INJECTION_TONES: Readonly<Record<string, JobWords['tone']>> = { failed: 'err', inconclusive: 'warn', passed: 'ok', caused: 'err', 'not caused': '' };

/**
 * Run injection test and Find cause: the test's verdict (`failed · exit 1`, `inconclusive · exit 3`,
 * `passed · exit 0`), or a --clean answer's (`caused · exit 0` in red, `not caused · exit 0`,
 * `inconclusive · exit 3`), with the job's real code.
 */
function injectionStatus(job: EndedJob, code: number): JobWords | null {
  const r = asRecord(job.result);
  if (job.kind !== 'injection' || !r) return null;
  if (code === 130 || code === 143) return { text: `interrupted · exit ${code}`, tone: 'warn' };
  const first = Array.isArray(r.results) ? asRecord(r.results[0]) : null;
  const verdict = first?.mode === 'clean' ? first.verdict : r.verdict;
  return typeof verdict === 'string' && verdict in INJECTION_TONES ? { text: `${verdict} · exit ${code}`, tone: INJECTION_TONES[verdict]! } : null;
}

/**
 * Pack with injection gate: packed, then how its gate's test came out (`packed · its test failed ·
 * exit 1`), so its title ends `Packed with injection gate` whatever the test said. A write refused
 * after the pack prints no session, and ends as the generic words say it.
 */
function packGateStatus(job: EndedJob, all: string, code: number): JobWords | null {
  if (job.kind !== 'pack-test' || job.title !== ACTIONS.packWithGate.doing) return null;
  const t = sessionTotals(all);
  if (!t || t.interrupted || code === 130 || code === 143) return null;
  const outcome = t.failed ? 'failed' : t.inconclusive ? 'inconclusive' : 'passed';
  return { text: `packed · its test ${outcome} · exit ${code}`, tone: INJECTION_TONES[outcome]! };
}

/**
 * Save check on a fix (`shadowlap fix check`): changed, with the verdicts that stopped counting for
 * it; the check it had already (`unchanged`); or one it refused (exit 2). Never the words of a check
 * tried on recordings, which its lines would read as.
 */
function fixCheckStatus(job: EndedJob, code: number): JobWords | null {
  if (job.kind !== 'fix-check') return null;
  const exit = `exit ${code}`;
  if (code === 2) return { text: `refused · ${exit}`, tone: 'warn' };
  const r = asRecord(job.result);
  if (code !== 0 || !r) return null;
  if (r.status === 'unchanged') return { text: `unchanged · ${exit}`, tone: 'warn' };
  const n = Array.isArray(r.uncounted) ? r.uncounted.length : 0;
  return { text: `changed${n ? ` · ${n} verdict${n === 1 ? ' no longer counts' : 's no longer count'}` : ''} · ${exit}`, tone: 'ok' };
}

/** How an ended job came out, where its kind has words for that; null leaves it to `jobStatus`. */
export function jobEnding(job: EndedJob, all: string, code: number): JobWords | null {
  return fixCheckStatus(job, code) ?? revertStatus(job, all, code) ?? verdictStatus(job, code) ?? checkStatus(job, code) ?? injectionStatus(job, code) ?? repeatStatus(job, all, code) ?? bisectStatus(job, all, code) ?? packGateStatus(job, all, code) ?? sessionStatus(job, all, code);
}
