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
