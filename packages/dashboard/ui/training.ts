import { commandText } from './goldens.js';
import { href } from './route.js';
import type { ModelOptionView, ModelsView, PairGroupView, PipView, ScoreDialogView, TrainingView } from './types.js';
import { isObject } from '../../engine/src/is-object.js';
import { twoDigits as pad } from '../../engine/src/words.js';

/**
 * Training's logic (`pages/Training.tsx`), without the DOM so the tests import it: which pair groups a
 * filter shows, the words for times and files, what Score a model sends, and how the palette opens a
 * Training dialog from anywhere. Nothing here imports the client or the app state, which need a
 * browser: the palette's actions take what they use from the palette's context.
 */

export type PairChip = 'all' | 'high' | 'medium';

/** The groups a confidence filter shows. A group's pairs come from one source, so they share its confidence. */
export function filterGroups(groups: readonly PairGroupView[], chip: PairChip): PairGroupView[] {
  return chip === 'all' ? [...groups] : groups.filter((g) => g.confidence === chip);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** When something was done, as the strip and the score cards say it: `just now`, `10:20` today, `Oct 1, 10:20` before. */
export function whenDone(ms: number, now = Date.now()): string {
  if (now - ms < 60_000 && now >= ms - 60_000) return 'just now';
  const d = new Date(ms);
  const t = new Date(now);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate()) return time;
  return `${MONTHS[d.getMonth()]!} ${d.getDate()}, ${time}`;
}

/** A file as the strip names it: its name (the whole path is on hover), or stdout for `-`. */
export function fileName(file: string): string {
  if (file === '-') return 'stdout';
  return file.split(/[\\/]/).filter(Boolean).pop() ?? file;
}

/** The line under Exported: how many pairs the last export wrote to which file, and when. */
export function leftNote(left: TrainingView['strip']['left'], now = Date.now()): string {
  if (left.file === null || left.at === null) return left.sub;
  return `pairs, to ${fileName(left.file)} · ${whenDone(left.at, now)}`;
}

/** A pip's class: every check passed (none), some (`part`), or none (`no`), as `.pips i` draws them. */
export function pipClass(p: Pick<PipView, 'kind'>): string {
  return p.kind === 'all' ? '' : p.kind === 'some' ? 'part' : 'no';
}

/** What a pip says on hover. */
export function pipTip(p: Pick<PipView, 'attempt' | 'score' | 'runId'>): string {
  return `attempt ${p.attempt} · ${p.score.toFixed(2)}${p.runId ? ' · opens its run' : ''}`;
}

/** The value Score a model's picker gives "Your own endpoint…": not an option's index. */
export const ENDPOINT = 'endpoint';

/** The option the picker starts on: the first model not scored yet (the server's `selected`), else the first, else the endpoint. */
export function firstPick(dialog: ScoreDialogView | null): string {
  if (!dialog?.options.length) return ENDPOINT;
  const i = dialog.options.findIndex((o) => o.key === dialog.selected);
  return String(i < 0 ? 0 : i);
}

/** The option a picker value names, or null for the endpoint or a value the listing doesn't have. */
export function pickedOption(dialog: ScoreDialogView | null, pick: string): ModelOptionView | null {
  if (!dialog || pick === ENDPOINT || !/^\d+$/.test(pick)) return null;
  return dialog.options[Number(pick)] ?? null;
}

export interface ScoreFields {
  model: string;
  baseUrl: string | null;
  attempts: number;
  /** The tasks to score when the model answers only some of the ready ones; null scores every ready task. */
  goldens: string[] | null;
}

/**
 * What Score a model sends to start the job: the picked model as `tasks score --model` takes it, with
 * its endpoint, or the base URL and model name typed for "Your own endpoint…". Null until the endpoint
 * is filled in. The server checks every field again.
 */
export function scoreFields(dialog: ScoreDialogView | null, pick: string, endpoint: { baseUrl: string; model: string }, attempts: number): ScoreFields | null {
  if (pick === ENDPOINT) {
    const model = endpoint.model.trim();
    const baseUrl = endpoint.baseUrl.trim();
    if (!model || !/^https?:\/\/\S+$/.test(baseUrl)) return null;
    return { model, baseUrl, attempts, goldens: null };
  }
  const o = pickedOption(dialog, pick);
  return o ? { model: o.request.model, baseUrl: o.request.baseUrl, attempts, goldens: o.request.goldens ?? null } : null;
}

const trimUrl = (u: string) => u.trim().replace(/\/+$/, '');

/**
 * The note under the picker: where the model runs and what an attempt costs (the server's words), and
 * for "Your own endpoint…" the score it replaces when that model was scored at that endpoint before.
 */
export function pickNote(dialog: ScoreDialogView | null, pick: string, endpoint: { baseUrl: string; model: string }): string {
  if (!dialog) return '';
  if (pick !== ENDPOINT) return pickedOption(dialog, pick)?.note ?? '';
  const before = dialog.options.find((o) => o.baseUrl !== null && o.id === endpoint.model.trim() && trimUrl(o.baseUrl) === trimUrl(endpoint.baseUrl) && o.lastScore !== null);
  return before ? `${dialog.endpoint.note} · replaces its score of ${before.lastScore!.toFixed(2)}` : dialog.endpoint.note;
}

/**
 * The command Export pairs runs, as the server builds it from what the dialog sends (`exportPairsJob`):
 * the confidence, the format, and the file in the project folder it writes.
 */
export function exportCommand(format: string, minConfidence: 'high' | 'medium', out: string): string {
  return commandText(['export', 'pairs', '--min-confidence', minConfidence, '--format', format, '--out', out]);
}

/**
 * The command Score a model runs, as the server builds it from what the dialog sends
 * (`scoreModelJob`): the tasks it scores (the model's own, else every ready one), the model, its
 * endpoint, and the attempts per task. Null until the dialog has a model to send.
 */
export function scoreCommand(fields: ScoreFields | null, ready: readonly string[]): string | null {
  if (!fields) return null;
  let base: string | null = null;
  if (fields.baseUrl) {
    try {
      base = new URL(fields.baseUrl.trim()).toString().replace(/\/+$/, '');
    } catch {
      return null;
    }
  }
  return commandText(['tasks', 'score', ...(fields.goldens ?? ready), '--model', fields.model.trim(), ...(base ? ['--base-url', base] : []), '--attempts', String(fields.attempts)]);
}

/** The providers that couldn't be listed, in one line: `Not listed: OpenAI API (OPENAI_API_KEY is not set) · Ollama, on this machine (isn't running)`. */
export function notesLine(notes: ModelsView['notes']): string | null {
  return notes.length ? `Not listed: ${notes.map((n) => `${n.group} (${n.note})`).join(' · ')}` : null;
}

/**
 * The listed models left out because they can't answer any ready task, in one line: `Not offered:
 * gpt-prod (azure-refund: its takeover call goes through Azure OpenAI, …) · Anthropic API: claude-haiku-4-5,
 * claude-opus-5-5 (refund-flow: it uses the OpenAI Responses API, …)`. Past three models, the rest are counted.
 */
export function leftOutLine(leftOut: ScoreDialogView['leftOut'] | undefined): string | null {
  if (!leftOut?.length) return null;
  const names = (models: string[]) => (models.length > 3 ? `${models.slice(0, 3).join(', ')} and ${models.length - 3} more` : models.join(', '));
  return `Not offered: ${leftOut.map((l) => `${l.models.length === 1 ? l.models[0]! : `${l.group}: ${names(l.models)}`} (${l.why})`).join(' · ')}`;
}

const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/**
 * How a Training job ended, in the job drawer's status line, from the result it reports: Score a model
 * by the tasks it scored (`scored · mean 0.87`; `3 of 4 tasks scored` when a golden no longer replays
 * up to its takeover or was skipped; `nothing scored`), Export pairs by the pairs it wrote. Null for
 * other jobs, or one that sent no result: the drawer then reads the CLI's words.
 */
export function trainingJobStatus(job: { kind?: string; code: number | null; result?: unknown }): { text: string; tone: 'ok' | 'warn' | 'err' } | null {
  const r = job.result;
  if (job.code === null || !isObject(r)) return null;
  const exit = `exit ${job.code}`;
  if (job.kind === 'score') {
    const tasks = Array.isArray(r.tasks) ? r.tasks.filter(isObject) : [];
    const total = tasks.length + (Array.isArray(r.skipped) ? r.skipped.length : 0);
    const scored = tasks.filter((t) => Array.isArray(t.attempts) && t.attempts.length > 0).length;
    if (typeof r.mean !== 'number' || !scored) return { text: `nothing scored · ${exit}`, tone: 'err' };
    if (job.code === 0 && scored === total) return { text: `scored · mean ${r.mean.toFixed(2)} · ${exit}`, tone: 'ok' };
    return { text: `${scored} of ${count(total, 'task')} scored · ${exit}`, tone: 'warn' };
  }
  if (job.kind === 'pairs' && typeof r.pairs === 'number') {
    return r.pairs ? { text: `${count(r.pairs, 'pair')} written · ${exit}`, tone: job.code === 0 ? 'ok' : 'err' } : { text: `nothing exported · ${exit}`, tone: 'warn' };
  }
  return null;
}

// ---- the palette opens a Training dialog from any page ----

export type TrainingDialog = 'export' | 'score';

let pending: TrainingDialog | null = null;
const listeners = new Set<(kind: TrainingDialog) => void>();

/** Asks the Training page to open a dialog: at once when it is open, else as soon as it opens. */
export function requestTrainingDialog(kind: TrainingDialog): void {
  pending = kind;
  for (const l of listeners) l(kind);
}

/** The dialog asked for and not opened yet, taken. */
export function takeTrainingDialog(): TrainingDialog | null {
  const kind = pending;
  pending = null;
  return kind;
}

/** Follows dialog requests while the page is open; returns the unsubscribe. */
export function onTrainingDialog(fn: (kind: TrainingDialog) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** What the palette knows of Training: the counts from the last time the page or the palette read it. */
let counts: { pairs: number; ready: number } | null = null;

/** Which Training actions counts call for: `export`, `score`, both, or none yet. */
const offered = (c: typeof counts) => (c === null ? null : `${c.pairs > 0 ? 'export' : ''}:${c.ready > 0 ? 'score' : ''}`);

/** Tells an open palette to read its sources again: the page hands in the palette's own (paletteSourcesChanged), which needs the app. */
let tellPalette: () => void = () => undefined;

export function onTrainingCountsChange(fn: () => void): void {
  tellPalette = fn;
}

/** Keeps the counts the page or the palette read (null forgets them), and tells an open palette when they change what it offers. */
export function noteTrainingCounts(view: Pick<TrainingView, 'tabs'> | null): void {
  const before = offered(counts);
  counts = view ? { pairs: view.tabs.pairs, ready: view.tabs.tasks } : null;
  if (offered(counts) !== before) tellPalette();
}

/** What the palette's Training actions use from the palette's context (`PaletteContext` has it). */
export interface TrainingPaletteContext {
  app: {
    exported: boolean;
    hasKind: (kind: string) => boolean;
    guard: (fn: () => void) => void;
    client: { training: () => Promise<Pick<TrainingView, 'tabs'>> };
  };
  go: (hash: string) => void;
}

export interface TrainingCommand {
  group: 'Actions';
  label: string;
  hint: string;
  /** Each opens what starts a job: paused while the server can't be reached. */
  job: true;
  run: () => void;
}

/**
 * The palette's Training actions: Export preference pairs… when there are pairs, Score a model on the
 * tasks… when a task is ready, each only when this dashboard runs its job kind (`kinds`, the client's
 * JOB_KINDS). Each time the palette opens, the counts are read again (an ETag keeps it cheap): a blame
 * or a fixed test may have changed them since, and an open palette is told when they did. Until they
 * were read once, neither is offered. Either opens Training, and its dialog when there is something
 * to export or score.
 */
export function trainingPalette({ app, go }: TrainingPaletteContext, kinds: { pairs: string; score: string }): TrainingCommand[] {
  if (app.exported) return [];
  app.client.training().then(noteTrainingCounts, () => undefined);
  if (counts === null) return [];
  const out: TrainingCommand[] = [];
  const open = (tab: 'pairs' | 'tasks', kind: TrainingDialog) => () =>
    app.guard(() => {
      go(href.training(tab));
      requestTrainingDialog(kind);
    });
  if (app.hasKind(kinds.pairs) && counts.pairs > 0) out.push({ group: 'Actions', label: 'Export preference pairs…', hint: 'shadowlap export pairs', job: true, run: open('pairs', 'export') });
  if (app.hasKind(kinds.score) && counts.ready > 0) out.push({ group: 'Actions', label: 'Score a model on the tasks…', hint: 'shadowlap tasks score', job: true, run: open('tasks', 'score') });
  return out;
}
