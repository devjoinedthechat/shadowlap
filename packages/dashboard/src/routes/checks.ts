import { cleanLabel, type Store } from '@shadowlap/engine';
import { lookupRun } from '../api.js';
import type { RouteContext } from '../context.js';
import type { JobBuildResult, JobRequest } from '../jobs.js';
import type { Router } from '../router.js';
import type { GoldenSource } from '../tests.js';

/**
 * Checks: what a check says about the recordings there are, before it is saved. The check
 * builder's live preview runs `shadowlap check`, which judges recordings from what they recorded,
 * replaying nothing; the job's result is its report (`--json`'s, which the CLI reports over the
 * events pipe):
 *
 *   check   { expect?, recordings? }   `expect`: the expect object to try (an object, or its JSON);
 *                                      without it, each recording's own checks under `tests`.
 *                                      `recordings`: run ids or unique prefixes, `label:<name>`, or
 *                                      goldens the project lists; none, every recording in the store
 */

export const CHECK_JOB_KIND = 'check';

/** As long as a check a person writes gets, with room to spare. */
const MAX_EXPECT = 64 * 1024;
const MAX_RECORDINGS = 200;

/** The expect object a request gives, checked for its shape (the CLI reads the rest), or why not. */
function expectOf(raw: unknown): { expect: Record<string, unknown> | null } | { error: string } {
  if (raw === undefined || raw === null || raw === '') return { expect: null };
  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length > MAX_EXPECT) return { error: 'that check is too long' };
    try {
      value = JSON.parse(raw);
    } catch {
      return { error: 'the check must be JSON, such as {"calls":[{"tool":"issue_refund","after":"lookup_order"}]}' };
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { error: 'the check is an expect object, such as {"tools":{"send_email":0}}' };
  if (JSON.stringify(value).length > MAX_EXPECT) return { error: 'that check is too long' };
  return { expect: value as Record<string, unknown> };
}

/** One recording a request names, as the CLI takes it: a run's full id, `label:<name>`, or a golden's path. */
function recordingArg(store: Store, goldens: readonly GoldenSource[], raw: unknown): string | { error: string; status: number } {
  if (typeof raw !== 'string' || !raw) return { error: 'name each recording as text: a run id, label:<name> or a golden', status: 400 };
  if (raw.startsWith('label:')) {
    const label = cleanLabel(raw.slice('label:'.length));
    return 'error' in label ? { error: label.error, status: 400 } : `label:${label.label}`;
  }
  const golden = goldens.find((g) => g.path === raw && !g.path.startsWith('-'));
  if (golden) return golden.path;
  const run = lookupRun(store, raw);
  return run ? run.runId : { error: `no run or golden ${raw.slice(0, 40)}`, status: 404 };
}

/** `check`: the arguments `shadowlap check` runs with, built from checked fields, or why it can't run. */
export function checkJob(store: Store, goldens: readonly GoldenSource[], req: JobRequest): JobBuildResult {
  const asked = expectOf(req.expect);
  if ('error' in asked) return { error: asked.error };
  const raw = req.recordings ?? [];
  if (!Array.isArray(raw)) return { error: 'recordings is a list: run ids, label:<name> or goldens' };
  if (raw.length > MAX_RECORDINGS) return { error: `name at most ${MAX_RECORDINGS} recordings, or none for every recording in the store` };
  const recordings: string[] = [];
  for (const r of raw) {
    const arg = recordingArg(store, goldens, r);
    if (typeof arg !== 'string') return arg;
    if (!recordings.includes(arg)) recordings.push(arg);
  }
  return {
    args: ['check', ...recordings, ...(asked.expect ? ['--expect', JSON.stringify(asked.expect)] : [])],
    title: recordings.length === 1 ? 'Checking a recording' : 'Checking recordings',
  };
}

export function register(_router: Router, ctx: RouteContext): void {
  const goldens = (): GoldenSource[] => ctx.options.goldens?.() ?? [];
  ctx.jobs.registerJobKind(CHECK_JOB_KIND, { title: () => 'Checking recordings', build: (req, { store }) => checkJob(store, goldens(), req) });
}
