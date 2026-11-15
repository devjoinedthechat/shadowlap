import { plural } from './format.js';

/**
 * `shadowlap doctor`'s checks as a dashboard job's result carries them (`{ checks }`, as `doctor
 * --json` prints them), and their sum in the CLI's own words. Settings → Project's Health lists
 * them, and the job's drawer and toast end on the sum.
 */

export type DoctorVerdict = 'ok' | 'warn' | 'fail';

/** One check: what it looked at, its verdict, what it found, and for a problem, what to do. */
export interface DoctorCheck {
  name: string;
  verdict: DoctorVerdict;
  detail: string;
  fix?: string;
}

const VERDICTS: readonly string[] = ['ok', 'warn', 'fail'];

const isCheck = (c: unknown): c is DoctorCheck => {
  const x = c as Partial<DoctorCheck> | null;
  return typeof x === 'object' && x !== null && typeof x.name === 'string' && VERDICTS.includes(x.verdict ?? '') && typeof x.detail === 'string' && (x.fix === undefined || typeof x.fix === 'string');
};

/** The checks a doctor job's result holds, or null for a result that holds none. */
export function doctorChecks(result: unknown): DoctorCheck[] | null {
  const checks = (result as { checks?: unknown } | null | undefined)?.checks;
  return Array.isArray(checks) ? checks.filter(isCheck) : null;
}

/**
 * The checks summed up as `shadowlap doctor` ends its output: `1 problem, 2 warnings`, `2 warnings,
 * nothing blocking` or `everything looks fine`, in a problem's, a warning's or a pass's tone.
 */
export function doctorSum(checks: readonly DoctorCheck[]): { text: string; tone: 'err' | 'warn' | 'ok' } {
  const fails = checks.filter((c) => c.verdict === 'fail').length;
  const warns = checks.filter((c) => c.verdict === 'warn').length;
  if (fails) return { text: `${plural(fails, 'problem')}${warns ? `, ${plural(warns, 'warning')}` : ''}`, tone: 'err' };
  if (warns) return { text: `${plural(warns, 'warning')}, nothing blocking`, tone: 'warn' };
  return { text: 'everything looks fine', tone: 'ok' };
}

/** A check's verdict as its row says it, in its status's tone: ok, warning, problem. */
export const DOCTOR_WORDS: Readonly<Record<DoctorVerdict, { word: string; tone: 'ok' | 'warn' | 'err' }>> = {
  ok: { word: 'ok', tone: 'ok' },
  warn: { word: 'warning', tone: 'warn' },
  fail: { word: 'problem', tone: 'err' },
};
