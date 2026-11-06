import type { CostWords } from './actions.js';
import { commandText } from './goldens.js';
import { ACTIONS, confirmWords } from './labels.js';
import type { Estimate } from '../../engine/src/estimates/estimate.js';
import { amountWords } from '../../engine/src/estimates/spending.js';
import { href } from './route.js';
import type { ModelOptionView, ModelsView, PairGroupView, PipView, ScoreDialogView, TrainingView } from './types.js';
import { twoDigits as pad } from '../../engine/src/words.js';

/** A job's price as a control holds it (spending.ts's Priced, kept apart so this file loads no browser code): an estimate, null for none, undefined until known. */
type Priced = Pick<Estimate, 'usd' | 'ceiling' | 'per'> | null | undefined;

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

/** What a pick says beyond its cost: the tasks it leaves out, or what your own endpoint can be. */
export function pickNote(dialog: ScoreDialogView | null, pick: string): string {
  if (!dialog) return '';
  return pick === ENDPOINT ? dialog.endpoint.note : (pickedOption(dialog, pick)?.note ?? '');
}

/** The score a run of this pick replaces, or null where it has none. */
export function pickReplaces(dialog: ScoreDialogView | null, pick: string, endpoint: { baseUrl: string; model: string }): number | null {
  if (!dialog) return null;
  if (pick !== ENDPOINT) return pickedOption(dialog, pick)?.lastScore ?? null;
  return dialog.options.find((o) => o.baseUrl !== null && o.id === endpoint.model.trim() && trimUrl(o.baseUrl) === trimUrl(endpoint.baseUrl) && o.lastScore !== null)?.lastScore ?? null;
}

/** What scoring bills: a model on this machine or your own endpoint nothing, a priced model about so much an attempt, one with no price by its provider. */
export function scoreCost(dialog: ScoreDialogView | null, pick: string, attempts = 1, ready = 1): CostWords | null {
  if (pick === ENDPOINT) return { price: 'Free', parts: ['runs at your endpoint, writes stubbed'] };
  const o = dialog ? pickedOption(dialog, pick) : null;
  if (!o) return null;
  if (o.local) return { price: 'Free', parts: [`runs at ${o.baseUrl ? `\`${o.baseUrl}\`` : 'this machine'}, writes stubbed`] };
  if (o.perAttempt === null) return { price: 'Billed by your provider', parts: ['live from each takeover, writes stubbed'] };
  const n = scoreRuns(o, attempts, ready);
  // In the engine's amount words, as the card and the drawer say the same total.
  return { price: amountWords(o.perAttempt * n), parts: [`${n} ${n === 1 ? 'attempt' : 'attempts'} on the ${o.where}`, 'live from each takeover, writes stubbed'] };
}

/** How many attempts scoring runs: the attempts picked, for each task the model answers, or for each ready one. */
function scoreRuns(o: ModelOptionView, attempts: number, ready: number): number {
  return attempts * (o.request.goldens?.length ?? ready);
}

/** The estimate Score model's job is sent, so its drawer says the picks' total: none for your own endpoint, a local server or a model with no price. */
export function scoreEstimate(dialog: ScoreDialogView | null, pick: string, attempts: number, ready: number): Priced {
  const o = dialog && pick !== ENDPOINT ? pickedOption(dialog, pick) : null;
  return o && !o.local && o.perAttempt !== null ? { usd: o.perAttempt * scoreRuns(o, attempts, ready), ceiling: false } : null;
}

/**
 * Score model…'s card, as a form's says it: what an attempt costs on the model its dialog starts on
 * (firstPick), once the models are listed; no line for a local server or your own endpoint, and no
 * estimate for a model with no price.
 */
export function scoreCard(models: ModelsView | null): { tip: string; sub: string; command: string; estimate: Priced } {
  const d = models?.dialog ?? null;
  const pick = firstPick(d);
  const o = pickedOption(d, pick);
  // A local server or your own endpoint bills nothing: no line, as a form's card says nothing it doesn't bill.
  const free = pick === ENDPOINT || !!o?.local;
  const estimate: Priced = !models || free ? undefined : o ? { usd: o.perAttempt, ceiling: false, per: 'an attempt' } : null;
  return { tip: confirmWords(ACTIONS.scoreModel.label), sub: 'Asks which model first', command: commandText(['tasks', 'score']), estimate };
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
 * The palette's Training actions: Export pairs… when there are pairs, Score model… when a task is
 * ready, each only when this dashboard runs its job kind (`kinds`, the client's
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
  if (app.hasKind(kinds.pairs) && counts.pairs > 0) out.push({ group: 'Actions', label: ACTIONS.exportPairs.label, hint: 'shadowlap export pairs', job: true, run: open('pairs', 'export') });
  if (app.hasKind(kinds.score) && counts.ready > 0) out.push({ group: 'Actions', label: ACTIONS.scoreModel.label, hint: 'shadowlap tasks score', job: true, run: open('tasks', 'score') });
  return out;
}
