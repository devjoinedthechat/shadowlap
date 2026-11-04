import { num, shortId } from '../format.js';
import { ACTIONS } from '../labels.js';
import type { RunOffers } from '../types.js';

/**
 * The Share menu without the DOM: which copies it lists, in the mock's order and words (parallel nouns,
 * an ellipsis on each that asks first), and the note
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
  html: { label: ACTIONS.exportHtml.label, note: 'export html · these views in one file that opens anywhere' },
  pack: { label: ACTIONS.pack.label, note: 'pack · a folder for a golden, or for a colleague to replay' },
  dataset: { label: ACTIONS.exportDataset.label, note: 'export dataset · JSONL, Braintrust, Langfuse or OpenAI chat' },
  otel: { label: ACTIONS.exportTrace.label, note: 'export otel · a span per call, for the tools you already use' },
  har: { label: ACTIONS.exportHar.label, note: 'export har · the model calls, for anything that reads HTTP archives' },
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

/**
 * The most runs one dataset takes, as the server's `export-dataset` job does (run-exports.ts
 * `MAX_DATASET_RUNS`): every id goes on the CLI's command line.
 */
export const DATASET_MAX_RUNS = 500;

/** Why a dataset can't be made from this many runs (the Runs page picks up to 1,000), or null when it can. */
export function datasetTooMany(count: number): string | null {
  return count > DATASET_MAX_RUNS ? `One dataset takes at most ${num(DATASET_MAX_RUNS)} runs: pick fewer, or export a label from a terminal with shadowlap export dataset --label <label>.` : null;
}

/**
 * The file a dataset goes into, in `.shadowlap/exports/`: one run's id, or how many runs and when
 * (UTC, to the second), as the `export-dataset` job names it when not told (src/run-exports.ts
 * `datasetName`). The dialog picks it when it opens and sends it, so its command is the one run.
 */
export function datasetFile(ids: readonly string[], now: Date): string {
  if (ids.length === 1) return `dataset-${ids[0]!.slice(0, 10).toLowerCase()}.jsonl`;
  return `dataset-${ids.length}-runs-${now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}.jsonl`;
}

/** A dataset of up to this many runs spells out every id in its command; past it, the first five and how many more. */
const DATASET_IDS_SHOWN = 10;

/**
 * The command the `export-dataset` job runs, as its dialog shows it: the runs, which calls and the
 * format picked, and the file it writes. `full` for Copy; `shown` names the first few runs of a long
 * pick and how many more, as a bulk Delete's does.
 */
export function datasetCommand(ids: readonly string[], o: { format: string; calls: string; file: string }): { shown: string; full: string } {
  const tail = `--calls ${o.calls} --format ${o.format} --out .shadowlap/exports/${o.file}`;
  const short = ids.map((id) => shortId(id));
  const full = `shadowlap export dataset ${short.join(' ')} ${tail}`;
  if (short.length <= DATASET_IDS_SHOWN) return { shown: full, full };
  return { shown: `shadowlap export dataset ${short.slice(0, 5).join(' ')} … and ${num(short.length - 5)} more ${tail}`, full };
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
