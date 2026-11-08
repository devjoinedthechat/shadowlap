import { useEffect, useRef, useSyncExternalStore } from 'react';
import { ApiError, JOB_KINDS, type Client } from '../api.js';
import { useLoad, type Loaded } from '../hooks.js';
import { href, parseRoute, samePage } from '../route.js';
import { currentRoute, navigate } from '../router.js';
import { useAppSelector, type AppState } from '../state.js';
import { errorText } from '../toast.js';
import type { FixDetail } from '../types.js';
import { stepFor } from './model.js';

/**
 * The fix the page on the screen shows, as its own read last answered (`client.fix`, the pooled read
 * that takes every call of the blamed run), shared with what a job of that fix ends on: its drawer
 * reads the fix's next step from here, never the fix again. `at` is when that read started, by this
 * page's clock, so an answer read since a job ended says what the job left.
 */
export interface PageFix {
  fix: FixDetail;
  at: number;
}

let shown: PageFix | null = null;
let readAgain: (() => void) | null = null;
const listeners = new Set<() => void>();
const subscribe = (on: () => void) => {
  listeners.add(on);
  return () => void listeners.delete(on);
};
const say = (next: PageFix | null) => {
  shown = next;
  for (const on of listeners) on();
};

/** Open Blame: the way on of a blame press the server refused, the step being a page's name. */
export const OPEN_BLAME = 'Open Blame';

/** Blame, repair and verify: the jobs a fix's steps show, which its page follows and whose drawers end on its next step. */
export const isStepJob = (kind: string | undefined): boolean => kind === JOB_KINDS.blame || kind === JOB_KINDS.repair || kind === JOB_KINDS.verify;

/**
 * The fix page's read, as `useLoad` makes it, each answer shared (`usePageFix`) with when its read
 * started. An answer that comes once the page has gone, or after a later read's, isn't shared.
 */
export function useFixRead(client: Pick<Client, 'fix'>, id: string, refresh: string): Loaded<FixDetail> {
  const loaded = useLoad(
    () => {
      const at = Date.now();
      return client.fix(id).then((fix) => {
        if (readAgain && !(shown?.fix.fixId === fix.fixId && shown.at > at)) say({ fix, at });
        return fix;
      });
    },
    `fix:${id}`,
    refresh,
  );
  const { reload } = loaded;
  useEffect(() => {
    readAgain = reload;
    return () => {
      readAgain = null;
      say(null);
    };
  }, [reload]);
  return loaded;
}

/** The fix the page on the screen shows, as its read last answered; null off a fix's page. */
export function usePageFix(): PageFix | null {
  return useSyncExternalStore(subscribe, () => shown, () => null);
}

/** Asks the fix's page to read it again: what a drawer does while the answer shared is from before its job ended. */
export function readPageFixAgain(): void {
  readAgain?.();
}

/** Whether a link leads to the page on the screen, as the drawer's ways on ask it: every step of a fix is its one page. */
export function onThisPage(to: string): boolean {
  return typeof location !== 'undefined' && samePage(parseRoute(to), currentRoute());
}

/** Each step job this tab follows that has ended, a line each: its id, its fix and the links it printed into fixes. One string, so it changes only as such a job ends. */
function endedStepJobs(a: Pick<AppState, 'jobs'>): string {
  return a.jobs
    .filter((w) => w.job.done && !w.lost && w.job.fixId && isStepJob(w.job.kind))
    .map((w) => [w.job.id, w.job.fixId, ...(w.job.links ?? []).map((l) => l.href).filter((h) => h.startsWith(href.fixes()))].join(' '))
    .join('\n');
}

/**
 * The page follows a blame, a repair or a verify of its fix to what it wrote once it ends, if this tab
 * follows it: to the link the job printed into this fix (its Blame step, its Repair step, its new
 * verdict), which the drawer leaves out, being this page. The address is replaced, so the drawer stays
 * open. A verdict the page's read doesn't hold yet waits for the read that does. A job that had ended
 * before the page opened on this fix moves nothing.
 */
export function useFollowJobs(id: string, fix: Pick<FixDetail, 'fixId' | 'verify'> | null): void {
  const ended = useAppSelector(endedStepJobs);
  const seen = useRef<{ id: string; jobs: Set<string> } | null>(null);
  if (seen.current?.id !== id) seen.current = { id, jobs: new Set(ended ? ended.split('\n').map((l) => l.split(' ')[0]!) : []) };
  const was = seen.current.jobs;
  useEffect(() => {
    if (!fix || !ended) return;
    for (const [job = '', fixId, ...links] of ended.split('\n').map((l) => l.split(' '))) {
      if (was.has(job) || fixId !== fix.fixId) continue;
      const to = links.find(onThisPage);
      const r = to ? parseRoute(to) : null;
      if (r?.page === 'fixes' && r.step === 'verify' && r.sub && !fix.verify.some((v) => v.verifyId === r.sub)) continue;
      was.add(job);
      if (to) navigate(to, true);
    }
  }, [ended, fix, was]);
}

/** Whether the page shows the fix's Blame step. */
function onBlameStep(fixId: string): boolean {
  if (typeof location === 'undefined' || !shown || shown.fix.fixId !== fixId) return false;
  const r = currentRoute();
  return r.page === 'fixes' && stepFor(shown.fix, r.step) === 'blame';
}

/**
 * A press the server refused. Run blame again or Run blame with stronger model refused (409) once the
 * fix's blame has moved on since the page read it: the server's sentence, with Open Blame as the
 * toast's way on unless the page shows that step. Any other goes as every job's refusal does.
 */
export function refusedPress(app: Pick<AppState, 'toast' | 'watchJob'>, kind: string, fields: Record<string, unknown>, err: unknown): void {
  const fixId = typeof fields.fixId === 'string' ? fields.fixId : null;
  if (kind !== JOB_KINDS.blame || !fixId || !(err instanceof ApiError) || err.status !== 409 || onBlameStep(fixId)) app.watchJob(Promise.reject(err));
  else app.toast(errorText(err), 'error', { label: OPEN_BLAME, run: () => navigate(href.fixes(fixId, 'blame')) });
}
