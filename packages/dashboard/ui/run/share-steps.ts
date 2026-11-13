import { num, shortId } from '../format.js';
import { draftCommand } from '../job-title.js';
import type { RunOffers } from '../types.js';

/*
 * What the run page's header, its steps and its keys say of a copy: Pack's command, Pack as golden…'s
 * verb, Push and the drawer's Copy link. Share's menu and the dialogs it opens word the rest
 * (share.ts), and the served dashboard hands the menu in (ShareMenu.tsx, a part), so the run page's
 * script holds none of their words; the facts those dialogs say are share-facts.ts'.
 */

/** Pack's command for one run, wherever it is asked (Share, the bulk bar, the key `p`): the folder as typed, quoted as its job's is. */
export function packRunCommand(runId: string, dir: string): string {
  return draftCommand(['pack', shortId(runId), dir.trim()]);
}

/** What Pack as golden… waits with, as it packs a golden and tests it: a Tests job holds the goldens. */
export const PACK_VERB = 'pack it';

/**
 * The link a finished share job made, from its result (`shadowlap share` reports `url` and
 * `expiresAt`), for the drawer's Copy link: a job's own links only ever open pages of the dashboard,
 * and this one is a presigned URL in the team's bucket. Null until the job has ended well, or for
 * anything that isn't a web address.
 */
export function sharedLink(job: { done: boolean; code: number | null; result?: unknown }): { url: string; expiresAt: number | null } | null {
  if (!job.done || job.code !== 0 || !job.result || typeof job.result !== 'object') return null;
  const { url, expiresAt } = job.result as { url?: unknown; expiresAt?: unknown };
  if (typeof url !== 'string' || url.length > 8192 || !/^https?:\/\/[^\s]+$/.test(url)) return null;
  return { url, expiresAt: typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? expiresAt : null };
}

/**
 * Push, in the header: a run that is only on this machine goes to the team store the config names,
 * with the runs it came from, and so do attempts filed under it that are only here (a run in the
 * store whose attempts aren't has Push too, as the Runs page tags it local). Never on an exported
 * copy or a run still recording, and only where the server has the team store's `push` job.
 */
export function canPush(o: { exported: boolean; live: boolean; team: RunOffers['team'] | null | undefined; hasPush: boolean }): boolean {
  return !o.exported && !o.live && o.team?.state === 'only-here' && o.hasPush;
}

/** What Push sends, for its hover: the run, its attempts only here, or both. */
export function pushTitle(team: NonNullable<RunOffers['team']>): string {
  const a = team.localAttempts;
  const attempts = a ? (a.attempts === 1 ? 'attempt' : `${num(a.attempts)} attempts`) : '';
  if (a && !a.run) return `Copy this run’s ${attempts} to the team store, ${team.store}: the run is there already`;
  return `Copy this run${a ? ` and its ${attempts}` : ''} to the team store, ${team.store}, with the runs it came from`;
}
