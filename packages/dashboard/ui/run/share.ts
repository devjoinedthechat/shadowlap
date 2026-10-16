import { num } from '../format.js';
import type { RunOffers } from '../types.js';

/**
 * The Share menu without the DOM: which copies it lists, in the mock's order and words, and the note
 * under them on how many redaction rules each applies (decision 6). The tests import it.
 */

export type ShareKey = 'link' | 'html' | 'pack' | 'dataset' | 'otel' | 'har';

export interface ShareItem {
  key: ShareKey;
  label: string;
  note: string;
}

const ITEMS: Record<ShareKey, Omit<ShareItem, 'key'>> = {
  link: { label: 'Share link', note: 'a redacted report in your bucket · expires in 7 days' },
  html: { label: 'HTML file', note: 'export html · these views in one file that opens anywhere' },
  pack: { label: 'Pack', note: 'pack · a folder for a golden, or for a colleague to replay' },
  dataset: { label: 'Dataset for evals', note: 'export dataset · JSONL, Braintrust, Langfuse or OpenAI chat' },
  otel: { label: 'OpenTelemetry trace', note: 'export otel · a span per call, for the tools you already use' },
  har: { label: 'HAR', note: 'export har · the model calls, for anything that reads HTTP archives' },
};

/**
 * The copies the menu lists: the share link first when the project has a team store and the server
 * can make one, then the HTML file (which downloads even from a server without its job), then each
 * copy the server can make (`can`: its job kind is listed, or for a pack, the run's own action).
 */
export function shareItems(o: { can: (key: ShareKey) => boolean; team: RunOffers['team'] | null | undefined }): ShareItem[] {
  const keys: ShareKey[] = [];
  if (o.team && o.can('link')) keys.push('link');
  keys.push('html');
  for (const key of ['pack', 'dataset', 'otel', 'har'] as const) if (o.can(key)) keys.push(key);
  return keys.map((key) => ({ key, ...ITEMS[key] }));
}

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

const rulesWord = (n: number) => `${num(n)} redaction ${n === 1 ? 'rule' : 'rules'}`;

/**
 * The note under the copies. HTML, pack, dataset and HAR apply every rule; a trace keeps no prompt
 * text, so only the rules without a path apply to it, and the note says so when that is fewer. With
 * only a count (an older server), every copy is said to apply it; with nothing, the config's rules.
 */
export function shareNote(offers: Pick<RunOffers, 'copies'> | null | undefined, fallback: number | null): { text: string; link: 'Settings' | 'Add some' } {
  const total = offers?.copies.total ?? fallback;
  if (total === null || total === undefined) return { text: 'The redaction rules in shadowlap.config.json apply to every copy.', link: 'Settings' };
  if (total === 0) return { text: 'No redaction rules yet: a copy holds what was recorded.', link: 'Add some' };
  const trace = offers?.copies.formats.find((f) => f.id === 'otel')?.rules;
  const head = `${rulesWord(total)} ${total === 1 ? 'applies' : 'apply'} to every copy`;
  if (trace === undefined || trace === total) return { text: `${head}.`, link: 'Settings' };
  // A trace keeps no prompt text: only the rules without a path have anything to mask in it.
  return { text: `${head}, ${trace === 0 ? 'none' : num(trace)} to a trace.`, link: 'Settings' };
}

/** The folder a pack goes into unless another is typed: inside the project's exports folder (decision 5). */
export function defaultPackFolder(runId: string): string {
  return `.shadowlap/exports/${runId.slice(0, 10).toLowerCase()}`;
}

/** Why a run can't be copied yet, on each copy's hover. */
export const STILL_RECORDING = 'Still recording: copy it once it has ended';

/** What decides how a copy is made: whether the page can run jobs, the job kinds the server lists, the run. */
export interface ShareContext {
  /** Why actions can't run here (a read-only dashboard, an expired link), or null when they can. */
  actionsOff: string | null;
  /** The server lists this copy's job kind. */
  hasJob: boolean;
  /** The run is still recording. */
  live: boolean;
}

/**
 * How the HTML file is made: as a job, which writes it into `.shadowlap/exports/` and then downloads
 * it, where the page runs jobs and the server has the kind; else straight from the server
 * (`GET /api/runs/:id/export`), which a read-only dashboard still answers, since reading and copying
 * never stop.
 */
export function htmlCopyVia(o: Pick<ShareContext, 'actionsOff' | 'hasJob'>): 'job' | 'download' {
  return o.hasJob && !o.actionsOff ? 'job' : 'download';
}

/**
 * Why a copy in the menu is off, for its hover; null when it can be made. Nothing is copied while
 * the run records. The HTML file downloads where jobs can't run; every other copy is a job.
 */
export function shareItemOff(key: ShareKey, o: Pick<ShareContext, 'actionsOff' | 'live'>): string | null {
  if (o.live) return STILL_RECORDING;
  if (key === 'html') return null;
  return o.actionsOff;
}

/**
 * Push, in the header: a run that is only on this machine goes to the team store the config names,
 * with the runs it came from. Never on an exported copy or a run still recording, and only where
 * the server has the team store's `push` job.
 */
export function canPush(o: { exported: boolean; live: boolean; team: RunOffers['team'] | null | undefined; hasPush: boolean }): boolean {
  return !o.exported && !o.live && o.team?.state === 'only-here' && o.hasPush;
}
