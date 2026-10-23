import { CAPS_ONLY_NOTE, countPairs, findPairs, oneSided as findOneSided, fixLabelInfo, fixOfRun, isInconclusiveNote, mainRefusal, modelReach, normalizeAddArgs, PAIR_FORMATS, refusedLine, ruleInForce, volatileValues, type ModelChoice, type ModelListing, type ModelReach, type Normalizer, type OneSided, type Pair, type PairFormat, type PairSource, type PairsExport, type Store, type Task, type TaskScoreRow } from '@shadowlap/engine';
import { fixForRun } from './fixes.js';
import { links } from './links.js';

/**
 * The Training screen's read model (`#/training`, `#/training/tasks`): preference pairs read from the
 * attempts blame, verify and --repeat left in the store, goldens as tasks, each model's scores on
 * them, and the models to score next. Plain JSON from plain inputs, no HTTP: `readTraining` gathers
 * what the store holds, the caller adds the tasks (they come from the project's goldens and config,
 * which the CLI reads: see `loadTasks` in the CLI's tasks.ts) and the model listing (it asks
 * providers, so it is fetched on its own and shaped by `scoreDialogView`), and `trainingView` shapes
 * it all for the screen. The jobs behind Export pairs and Score a model are built here too, from what
 * the browser names, never from a command line it sends. Copy follows the mock.
 */

export type PairFilter = 'all' | 'high' | 'medium';

/** The fix a pair source belongs to (Fixes, E1): set by the slice that groups failures into fixes. */
export interface SourceFix {
  id: string;
  label: string;
  /** The verify report a verify source is, for `#/fixes/<id>/verify/<verify-id>`. */
  verifyId?: string;
  /**
   * A verify of a repair candidate the gate turned down: no verdict of its own was kept, so it opens
   * at the fix's Repair step (`#/fixes/<id>/repair`), where its candidate is listed.
   */
  repair?: true;
}

export interface TrainingInput {
  pairs: Pair[];
  sources: PairSource[];
  tasks: Task[];
  /** Why the tasks couldn't be read (a mistake in the config's `tests`), shown in their place. */
  tasksError?: string | null;
  scores: TaskScoreRow[];
  /** Pairs exports, newest first. */
  exports: PairsExport[];
  /** The goldens' runs the store holds: a task row opens its run only when it is here. All of them when absent. */
  storedRuns?: Set<string>;
  /** The models to score (A7), or null while they are being listed. */
  models?: ModelListing | null;
  /** Which fix a source's pairs about a run belong to, when Fixes knows (sourceFixes). */
  fixOf?: FixOf;
  /** What makes each task blocked by an early fork ready, by golden (taskUpdate). */
  updates?: Record<string, TaskUpdate>;
}

/**
 * What makes a task ready whose golden's test forks before the takeover (`Task.fork`): the golden
 * passes, but a model takes over only where the recording still replays. Updating it re-records it
 * as the agent runs now (`shadowlap test <golden> --update`), after a normalizer for each value its
 * fork shows that changes on every run, which would fork the next test again. When such values were
 * all that changed, the normalizers are the whole fix, and the golden is tested again instead.
 */
export interface TaskUpdate {
  golden: string;
  /** The call its last test forked at, and the call the task takes over at. */
  forkedAt: number;
  takeover: number;
  /** The paths it adds a normalizer for first: `$.metadata.user_id`. */
  normalizers: string[];
  /** The golden is re-recorded (`test --update`), not only tested again. */
  rerecords: boolean;
  /** What the job runs, after `shadowlap`, in order. */
  steps: string[][];
}

/** What Update the golden runs for a task blocked by an early fork, or null for any other task. */
export function taskUpdate(store: Store, task: Task, normalizers: readonly Normalizer[]): TaskUpdate | null {
  if (task.status !== 'blocked' || !task.fork || !task.takeover) return null;
  const run = task.fork.runId ? store.getRun(task.fork.runId) : null;
  const found = run?.divergence ? volatileValues(run.divergence, normalizers) : null;
  // Only values that surely change every run get a rule, and only one the config doesn't have: an id
  // that changed may be a real change, which the update records.
  const sure = (found?.values ?? []).filter((v) => v.certain && !ruleInForce(v.normalizer, normalizers));
  const rerecords = !found?.explainsAll;
  const steps = [...sure.map((v) => normalizeAddArgs(v.normalizer)), rerecords ? ['test', task.golden, '--update'] : ['test', task.golden]];
  return { golden: task.golden, forkedAt: task.fork.callNo, takeover: task.takeover.callNo, normalizers: sure.map((v) => v.path), rerecords, steps };
}

/**
 * The fix the pairs a source made about one run belong to: a blame's is the blamed run's, a verify's
 * the one of the fixes its verdict counted for that the run fails in. `runId` is the run the pairs
 * are about (Pair.runId), which for a blame is the source's own run.
 */
export type FixOf = (source: PairSource, runId: string) => SourceFix | null;

/** What the store holds for Training; `tasks` and `models` come from the caller, and `normalizers` from the config as it is now. */
export function readTraining(store: Store, extra: { tasks: Task[]; tasksError?: string | null; models?: ModelListing | null; fixOf?: FixOf; normalizers?: readonly Normalizer[] }): TrainingInput {
  const { pairs, sources } = findPairs(store);
  // The goldens' runs, and the test runs that forked before a takeover, that the store still holds.
  const storedRuns = new Set(extra.tasks.flatMap((t) => [t.runId, t.fork?.runId ?? null].filter((id): id is string => !!id && !!store.getRun(id))));
  const updates: Record<string, TaskUpdate> = {};
  for (const t of extra.tasks) {
    const u = taskUpdate(store, t, extra.normalizers ?? []);
    if (u) updates[t.golden] = u;
  }
  return {
    pairs,
    sources,
    tasks: extra.tasks,
    ...(extra.tasksError ? { tasksError: extra.tasksError } : {}),
    scores: store.listTaskScores(),
    exports: store.listPairsExports(5),
    storedRuns,
    ...(extra.models !== undefined ? { models: extra.models } : {}),
    ...(extra.fixOf ? { fixOf: extra.fixOf } : {}),
    ...(Object.keys(updates).length ? { updates } : {}),
  };
}

/**
 * Which fix the pairs a source made about a run belong to, read from the store's fixes (E1), for
 * `readTraining`'s `fixOf`. A blame's is the fix its blamed run fails in, opened at its Blame step.
 * A verify's opens at that verify: under the fix the run fails in when the verdict counted for it
 * (one verify can check the runs of several fixes), else under the first fix it counted for. A
 * `--repeat` belongs to none.
 */
export function sourceFixes(store: Store): FixOf {
  const label = (f: { label: string | null; title: string }) => f.label ?? f.title;
  // What a verify source is: its verdict (or repair), the first fix that counted it, and every fix it was linked to.
  const verifies = new Map<string, { fix: SourceFix; linked: Set<string> } | null>();
  const verifyOf = (s: PairSource) => {
    if (verifies.has(s.key)) return verifies.get(s.key)!;
    // The verify's first attempt (the source starts when it did) names the verdict, and so the fix.
    const attempts = store.childRuns(s.runId).filter((r) => r.meta?.verify);
    const first = attempts.find((r) => r.startedAt === s.at) ?? attempts[0];
    const f = first ? fixForRun(store, first.runId) : null;
    const report = f?.verify?.verifyId ? store.linksTo(f.verify.verifyId, 'verify') : f?.verify?.repairId ? store.linksTo(f.verify.repairId, 'repair') : [];
    const kept = f?.verify?.verifyId ? { verifyId: f.verify.verifyId } : f?.verify?.repairId ? { repair: true as const } : {};
    const v = f?.fix ? { fix: { id: f.fix.fixId, label: label(f.fix), ...kept }, linked: new Set(report.map((l) => l.fixId)) } : null;
    verifies.set(s.key, v);
    return v;
  };
  const known = new Map<string, SourceFix | null>();
  return (s, runId) => {
    const key = `${s.key}\n${runId}`;
    if (known.has(key)) return known.get(key)!;
    let fix: SourceFix | null = null;
    if (s.kind === 'blame') {
      const f = fixForRun(store, s.runId);
      fix = f?.role === 'failing' && f.fix ? { id: f.fix.fixId, label: label(f.fix) } : null;
    } else if (s.kind === 'verify') {
      const v = verifyOf(s);
      const own = v ? fixOfRun(store, runId) : null;
      fix = v && own && own.fixId !== v.fix.id && v.linked.has(own.fixId) ? { ...v.fix, id: own.fixId, label: label({ label: fixLabelInfo(store, own).label, title: own.title }) } : (v?.fix ?? null);
    }
    known.set(key, fix);
    return fix;
  };
}

/**
 * What `shadowlap dashboard` gives the Training screen (`DashboardOptions.training`). The dashboard
 * can't read goldens as tasks itself, since their checks are the CLI's, so the CLI hands it its loader.
 */
export interface TrainingOptions {
  /**
   * The project's goldens as tasks (`loadTasks` in the CLI's tasks.ts), from the project folder the
   * dashboard's jobs run in (`root`, null without one). Without it, Training lists none and Score a
   * model can't run.
   */
  loadTasks?: (store: Store, root: string | null) => Task[];
  /** Where the model listing reads keys and provider addresses (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** How the listing asks providers for their models (default `fetch`); tests pass a fake. */
  fetch?: typeof fetch;
  /** How long each provider's list is waited for (1500 ms). */
  timeoutMs?: number;
}

// ---- the view ----

export interface Kpi {
  value: string;
  sub: string;
  href: string | null;
}

export interface AnswerView {
  text: string;
  what: string;
  runId: string;
  callNo: number;
  href: string;
}

export interface PairGroupView {
  key: string;
  confidence: 'high' | 'medium';
  /**
   * What the group is headed by: the run the pairs are about (`about`) at its call where the answers
   * were given (Pair.aboutCallNo: for a verify or `--repeat`, the call at the same point of the same
   * path, whatever the prompt said). When that run never got there (the change verified added a step
   * before the call), the attempt that gave the rejected answer, at its own call, and `attemptOf`
   * names the run it replayed.
   */
  runId: string;
  callNo: number;
  /** Opens `runId` at `callNo`. The rejected answer links its own attempt as well. */
  href: string;
  /** The run the pairs are about: the blamed run, or the run verify or `--repeat` replayed. */
  about: string;
  /** When the group is headed by an attempt: the run it replayed, which never made this call (`attempt of 01M51H39CA`). */
  attemptOf: { runId: string; href: string } | null;
  /** The fix these pairs belong to: the fix of the run they are about, opened at its Blame step or at the verify. */
  fix: { label: string; href: string } | null;
  source: { key: string; kind: PairSource['kind']; label: string; href: string };
  /** `from blame`, `from verify`, `from --repeat`. */
  from: string;
  count: number;
  context: string;
  rejected: AnswerView;
  chosen: AnswerView[];
  /** `chosen · blame attempt, passed`, or `chosen · 3 attempts that passed`. */
  chosenLabel: string;
  ids: string[];
}

export interface SourceView {
  key: string;
  kind: PairSource['kind'];
  label: string;
  href: string;
  made: number;
  /** Shown beside a source that made pairs. */
  confidence: 'high' | 'medium' | null;
  why: string;
}

export interface TaskRowView {
  golden: string;
  name: string;
  /** `takes over at #17 · decides between refunding and escalating`, or `no call to take over`. */
  sub: string;
  takeover: number | null;
  /** What scores it: the agent's exit and the outcome checks; for a task whose checks only cap spending, those caps. */
  checks: string[];
  after: { live: string[]; stubbed: string[] } | null;
  status: { key: Task['status']; label: string; badge: 'ok' | 'y' | 'n'; short: string | null };
  rewards: string | null;
  /**
   * The golden's run at the takeover; Tests for a blocked task, or for one blocked by an early fork
   * the test run where it forked; null when the store doesn't hold the run.
   */
  href: string | null;
  /** What the row's link opens, on hover. */
  opens: string | null;
  /** For a task blocked by an early fork: what Update the golden runs. */
  update: TaskUpdate | null;
}

export interface ModelCardView {
  model: string;
  baseUrl: string | null;
  /** Where it ran: `the recorded model`, `Anthropic API`, `Ollama, on this machine`. */
  via: string;
  /**
   * Its endpoint (`127.0.0.1:60863`), when another card has the same model name: the same model scored
   * at two endpoints is two cards, told apart by it. Null otherwise.
   */
  where: string | null;
  /** The mean over the ready tasks it was scored on. */
  mean: number | null;
  /** The ready tasks it was scored on: fewer than all of them when a task became ready after it was scored. */
  tasks: number;
  /** `on 1 of 2 tasks` when it wasn't scored on every ready task, so its mean is over fewer; null when it was. */
  coverage: string | null;
  /** The bar's width, 0 to 1. */
  bar: number;
  /** What its attempts' own calls cost, in USD. */
  spent: number;
  /** What their judge checks' calls cost, apart from `spent`: they ask the judge, never the model scored. 0 without one. */
  judgeSpent: number;
  /** `≈$0.165 spent`, or `$0, not a paid API`, with what the judge checks cost after it: `≈$0.165 spent · judge ≈$0.012`. */
  cost: string;
  /** When it was last scored (ms); the UI shows it after the cost. */
  at: number;
}

export interface PipView {
  score: number;
  /** every check passed, some, none */
  kind: 'all' | 'some' | 'none';
  attempt: number;
  runId: string | null;
  href: string | null;
}

export interface ScoreRowView {
  golden: string;
  name: string;
  cells: Array<{ model: string; baseUrl: string | null; pips: PipView[]; mean: number } | null>;
}

export interface ModelOptionView extends ModelChoice {
  /** Unique among the options: the model and its endpoint. */
  key: string;
  /**
   * What the dialog sends to start the job (scoreModelJob): the model as `--model` takes it, the
   * endpoint, and the tasks when it can answer only some of the ready ones (null: every ready task).
   */
  request: { model: string; baseUrl: string | null; goldens: string[] | null };
  /** `qwen2.5:7b · scored 0.80`, as the picker lists it. */
  label: string;
  lastScore: number | null;
  /** The note under the picker: where it runs, what an attempt costs, and the score it replaces. */
  note: string;
}

export interface ScoreDialogView {
  title: string;
  options: ModelOptionView[];
  groups: string[];
  /** The first model not scored yet that answers every ready task, else the first not scored yet, else the first. */
  selected: string | null;
  attempts: number[];
  /** "Your own endpoint…": a base URL and a model name, filled in with these. */
  endpoint: { key: string; group: string; label: string; baseUrl: string; model: string; note: string };
  /** Providers that couldn't be listed, and why. */
  notes: Array<{ group: string; note: string }>;
  /**
   * Listed models left out because they can't answer any ready task, grouped by where they run and
   * why: `{ group: 'Anthropic API', models: ['claude-haiku-4-5'], why: 'refund-flow: it uses the OpenAI Responses API, …' }`.
   */
  leftOut: Array<{ group: string; models: string[]; why: string }>;
}

export interface TrainingView {
  strip: { pairs: Kpi & { high: number; medium: number }; tasks: Kpi & { ready: number; total: number; blocked: number; notTask: number }; best: Kpi & { model: string | null; mean: number | null }; left: Kpi & { pairs: number; file: string | null; at: number | null } };
  tabs: { pairs: number; tasks: number };
  actions: { exportPairs: boolean; scoreModel: boolean };
  pairs: {
    filter: PairFilter;
    counts: { all: number; high: number; medium: number };
    groups: PairGroupView[];
    /** Pairs made per source, for the Blame step's count. */
    madeBy: Record<string, number>;
    sources: SourceView[];
    confidence: Array<{ level: 'high' | 'medium'; title: string; sub: string }>;
    footnote: string;
    empty: { title: string; text: string; command: string } | null;
  };
  tasks: {
    rows: TaskRowView[];
    /**
     * Every ready task rewards the same thing. `text` says it in one line; `name` is the task that
     * rewards the opposite (shown as code) and `once` what it needs first, for a view that marks it up.
     */
    warning: (OneSided & { text: string; name: string | null; once: string | null; fix: { label: string; href: string | null; update: TaskUpdate | null } | null }) | null;
    empty: { title: string; text: string; command: string } | null;
    /** Why the tasks couldn't be read, such as a mistake in the config's `tests`; null when they could. */
    error: string | null;
    /** The first golden that is no task because its checks only cap tokens and cost, for "weak checks teach the wrong thing"; null without one. */
    weak: string | null;
  };
  scores: { sub: string; empty: string | null; cards: ModelCardView[]; rows: ScoreRowView[]; footnote: string };
  serve: { command: string; request: string; response: string } | null;
  /** Export pairs: the formats and confidences it offers, and the file the job writes (`out`, in the project folder). */
  exportDialog: { title: string; text: string; high: number; all: number; out: string; formats: Array<{ value: PairFormat; label: string }>; levels: Array<{ value: 'high' | 'medium'; label: string }> };
  scoreDialog: ScoreDialogView | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
/** An amount as the mock writes it: `$0.0041`, `$0.017`, `$1.25`, trailing zeros dropped. */
export const money = (v: number) => (v ? `$${(v < 0.01 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v.toFixed(2)).replace(/0+$/, '').replace(/\.$/, '')}` : '$0');
/** An estimate as the mock writes it: `≈$0.165`. */
export const approx = (v: number) => (v ? `≈$${v < 1 ? v.toFixed(3) : v.toFixed(2)}` : '$0');
const STATUS: Record<Task['status'], { label: string; badge: 'ok' | 'y' | 'n' }> = { ready: { label: 'ready', badge: 'ok' }, blocked: { label: 'blocked', badge: 'y' }, 'not-a-task': { label: 'not a task', badge: 'n' }, 'no-golden': { label: 'no golden', badge: 'n' } };
const STATUS_ORDER: Record<Task['status'], number> = { ready: 0, blocked: 1, 'not-a-task': 2, 'no-golden': 3 };
const FROM: Record<PairSource['kind'], string> = { blame: 'from blame', verify: 'from verify', repeat: 'from --repeat' };
const LOOPBACK = /^https?:\/\/(localhost|127\.|\[::1\])/;

const modelKey = (model: string, baseUrl: string | null) => `${model}\n${baseUrl ?? ''}`;

/** A fix as its source opens it: at the Blame step, at the verify, or for a repair candidate turned down, at the Repair step. */
function fixHref(kind: PairSource['kind'], fix: SourceFix): string {
  if (kind === 'blame') return links.fixes(fix.id, 'blame');
  return fix.repair ? links.fixes(fix.id, 'repair') : links.fixes(fix.id, 'verify', fix.verifyId ?? null);
}

/** A source opens its fix; without one, its run's forks, at the call its pairs are about when it made some. */
function sourceHref(s: PairSource, fix: SourceFix | null, callNo: number | null): string {
  if (fix && s.kind !== 'repeat') return fixHref(s.kind, fix);
  return links.run(s.runId, callNo, 'forks');
}

/** An endpoint as a card names it: its host and port, or the provider's own API. */
function endpointName(baseUrl: string | null): string {
  if (!baseUrl) return "the provider's API";
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** The share of checks passed, as a pip: every check, some, or none. */
function pip(row: TaskScoreRow): PipView {
  return { score: row.score, kind: row.score >= 1 ? 'all' : row.score > 0 ? 'some' : 'none', attempt: row.attempt, runId: row.runId, href: row.runId ? links.run(row.runId) : null };
}

/** Each model's scores on the ready tasks, by model and endpoint: the mean of every attempt, and the tasks they were on. */
function modelScores(scores: readonly TaskScoreRow[], ready: Set<string>): Map<string, { mean: number; tasks: Set<string> }> {
  const by = new Map<string, { xs: number[]; tasks: Set<string> }>();
  for (const r of scores) {
    if (!ready.has(r.golden)) continue;
    const k = modelKey(r.model, r.baseUrl);
    const m = by.get(k) ?? { xs: [], tasks: new Set<string>() };
    m.xs.push(r.score);
    m.tasks.add(r.golden);
    by.set(k, m);
  }
  return new Map([...by].map(([k, m]) => [k, { mean: mean(m.xs), tasks: m.tasks }]));
}

/** Each model's mean over the ready tasks' attempts, by model and endpoint. */
function modelMeans(scores: readonly TaskScoreRow[], ready: Set<string>): Map<string, number> {
  return new Map([...modelScores(scores, ready)].map(([k, m]) => [k, m.mean]));
}

/** The note under the model picker: where the model runs, what an attempt costs, and the score it replaces. */
export function scoreNote(c: Pick<ModelChoice, 'where' | 'baseUrl' | 'perAttempt' | 'local'> | null, lastScore: number | null): string {
  const where = !c
    ? 'Any OpenAI-compatible server, such as vLLM serving the model you’re training. Not a paid API.'
    : c.local
      ? `Runs at ${c.baseUrl ?? 'this machine'} · not a paid API`
      : c.perAttempt === null
        ? `${c.where} · no price for this model, so the cost isn't estimated`
        : `${c.where} · about ${money(c.perAttempt)} an attempt`;
  return lastScore === null ? where : `${where} · replaces its score of ${lastScore.toFixed(2)}`;
}

/** A refused task and why, as a note says it: `refund-flow: it uses the OpenAI Responses API, …`. */
const refusal = (r: ModelReach['refused'][number]) => `${r.name}: ${r.why}`;

/**
 * Score a model's picker: the listed models with their last scores, the one to preselect, and "Your
 * own endpoint…". A model is offered only when it can answer a ready task (`modelReach`, what `tasks
 * score` would refuse): one that answers only some is scored on those, and its note says which it
 * leaves out; one that answers none is left out, and `leftOut` says why.
 */
export function scoreDialogView(tasks: readonly Task[], scores: readonly TaskScoreRow[], listing: ModelListing): ScoreDialogView | null {
  const ready = tasks.filter((t) => t.status === 'ready');
  if (!ready.length) return null;
  const means = modelMeans(scores, new Set(ready.map((t) => t.golden)));
  const options: ModelOptionView[] = [];
  const leftOut: ScoreDialogView['leftOut'] = [];
  for (const c of listing.choices) {
    const reach = modelReach(c, tasks);
    if (!reach.tasks.length) {
      // Why its own provider's task can't ask it says more than that the others were recorded elsewhere.
      const first = mainRefusal(reach);
      const why = first ? refusal(first) : 'no task is ready';
      const same = leftOut.find((l) => l.group === c.group && l.why === why);
      if (same) same.models.push(c.id);
      else leftOut.push({ group: c.group, models: [c.id], why });
      continue;
    }
    const last = means.get(modelKey(c.id, c.baseUrl)) ?? null;
    const flag = (name: string) => (c.flags.includes(name) ? (c.flags[c.flags.indexOf(name) + 1] ?? null) : null);
    const some = reach.refused.length > 0;
    // The tasks it leaves out, grouped by why: three tasks recorded on other clouds are one reason, not three.
    const note = some ? `${scoreNote(c, last)} · scores ${reach.tasks.length} of ${plural(ready.length, 'task')}, not ${refusedLine(c, reach)}` : scoreNote(c, last);
    options.push({ ...c, key: modelKey(c.id, c.baseUrl), request: { model: flag('--model') ?? c.id, baseUrl: flag('--base-url'), goldens: some ? reach.tasks : null }, label: last === null ? c.id : `${c.id} · scored ${last.toFixed(2)}`, lastScore: last, note });
  }
  // The first model not scored yet that answers every ready task, else the first not scored yet.
  const first = options.find((o) => o.lastScore === null && o.request.goldens === null) ?? options.find((o) => o.lastScore === null) ?? options[0] ?? null;
  return {
    title: `Score a model on ${plural(ready.length, 'task')}`,
    options,
    groups: [...new Set(options.map((o) => o.group))],
    selected: first?.key ?? null,
    attempts: [...SCORE_ATTEMPTS],
    endpoint: { key: '__endpoint', group: 'Other', label: 'Your own endpoint…', baseUrl: 'http://127.0.0.1:8000/v1', model: 'my-finetune', note: scoreNote(null, null) },
    notes: listing.notes,
    leftOut,
  };
}

/** `GET /api/models` (A7): every model to score, with its price per attempt and its last score, and Score a model's picker. */
export interface ModelsView {
  /** Ready tasks: the ones a model is scored on, whose tokens price an attempt. */
  ready: number;
  /** Every listed model, with its last score and which ready tasks it can answer (the picker offers only those that answer one). */
  choices: Array<ModelChoice & { lastScore: number | null; reach: ModelReach }>;
  /** Providers that couldn't be listed, and why. */
  notes: ModelListing['notes'];
  /** The tokens an attempt is expected to use after its takeover, which the prices are estimated from. */
  tokens: ModelListing['tokens'];
  /** The picker; null when no task is ready. */
  dialog: ScoreDialogView | null;
}

export function modelsView(tasks: readonly Task[], scores: readonly TaskScoreRow[], listing: ModelListing): ModelsView {
  const ready = tasks.filter((t) => t.status === 'ready');
  const means = modelMeans(scores, new Set(ready.map((t) => t.golden)));
  return {
    ready: ready.length,
    choices: listing.choices.map((c) => ({ ...c, lastScore: means.get(modelKey(c.id, c.baseUrl)) ?? null, reach: modelReach(c, tasks) })),
    notes: listing.notes,
    tokens: listing.tokens,
    dialog: scoreDialogView(tasks, scores, listing),
  };
}

/**
 * From a training loop: an example of one `tasks serve` request for a ready task and its response
 * (serve-tasks.ts in the CLI), cut to what a loop reads: the score, each check, the run and what it
 * cost. Nothing was asked, so the page labels it an example, the run is a placeholder, and one check
 * is shown missed, to show that a score is the share of the checks passed. The request names no
 * `from`, which only takes over elsewhere than the task's own call. The endpoint also answers the
 * task, model, takeover, each check's detail, the exit code and the time (docs/training.md has all of it).
 */
function serveSample(t: Task): { command: string; request: string; response: string } {
  const q = JSON.stringify;
  const checks = ['the agent exits 0', ...t.checks.filter((c) => !c.cap).map((c) => c.label)];
  // The last check missed: a score is the share of the checks passed.
  const missed = checks.length - 1;
  const score = Math.round(((checks.length - 1) / checks.length) * 100) / 100;
  return {
    command: 'shadowlap tasks serve goldens/ --port 4779',
    request: [`POST /v1/tasks/${t.name}/attempts`, 'Authorization: Bearer <token>', '{ "model": "my-finetune", "baseUrl": "http://127.0.0.1:8000/v1" }'].join('\n'),
    response: ['200 OK', `{ "score": ${score},`, '  "checks": [', ...checks.map((c, i) => `    { "check": ${q(c)}, "pass": ${i !== missed} }${i < checks.length - 1 ? ',' : ' ],'}`), '  "run": "<run id>", "spent": 0 }'].join('\n'),
  };
}

export function trainingView(input: TrainingInput, options: { filter?: PairFilter } = {}): TrainingView {
  const filter = options.filter ?? 'all';
  const counts = countPairs(input.pairs);
  const ready = input.tasks.filter((t) => t.status === 'ready');
  const readySet = new Set(ready.map((t) => t.golden));
  const blocked = input.tasks.filter((t) => t.status === 'blocked').length;
  const notTask = input.tasks.filter((t) => t.status === 'not-a-task').length;
  const stored = (runId: string | null) => !!runId && (input.storedRuns ? input.storedRuns.has(runId) : true);

  // ---- scores ----
  // The model a ready task's recording asked at its takeover runs as "the recorded model".
  const recorded = new Set(ready.flatMap((t) => (t.model ? [t.model] : [])));
  const models = new Map<string, { model: string; baseUrl: string | null; via: string; spent: number; judgeSpent: number; at: number; first: number; rows: TaskScoreRow[] }>();
  for (const r of input.scores) {
    const k = modelKey(r.model, r.baseUrl);
    const via = r.baseUrl === null && recorded.has(r.model) ? 'the recorded model' : (r.via ?? r.baseUrl ?? 'the recorded provider');
    const m = models.get(k) ?? { model: r.model, baseUrl: r.baseUrl, via, spent: 0, judgeSpent: 0, at: 0, first: r.at, rows: [] };
    m.rows.push(r);
    m.spent += r.spent;
    m.judgeSpent += r.judgeSpent ?? 0;
    m.at = Math.max(m.at, r.at);
    m.first = Math.min(m.first, r.at);
    models.set(k, m);
  }
  const scored = modelScores(input.scores, readySet);
  const ordered = [...models.entries()].sort((a, b) => a[1].first - b[1].first || a[0].localeCompare(b[0]));
  const cards: ModelCardView[] = ordered.map(([k, m]) => {
    const s = scored.get(k);
    const value = s?.mean ?? null;
    const tasks = s?.tasks.size ?? 0;
    const local = !!m.baseUrl && LOOPBACK.test(m.baseUrl);
    // What the judge checks cost goes after the model's own, apart: a model on this machine is free, its judge may not be.
    const cost = `${m.spent ? `${approx(m.spent)} spent` : local ? '$0, not a paid API' : '$0 spent'}${m.judgeSpent ? ` · judge ${approx(m.judgeSpent)}` : ''}`;
    return { model: m.model, baseUrl: m.baseUrl, via: m.via, where: null, mean: value, tasks, coverage: tasks < ready.length ? `on ${tasks} of ${plural(ready.length, 'task')}` : null, bar: value ?? 0, spent: m.spent, judgeSpent: m.judgeSpent, cost, at: m.at };
  });
  // The same model scored at two endpoints is two cards and two columns: each says its endpoint.
  for (const c of cards) if (cards.some((o) => o !== c && o.model === c.model)) c.where = endpointName(c.baseUrl);
  // Means over different tasks don't compare: the best is among the models scored on every ready
  // task, and only when none was is it the best of the rest, with the tasks it covers.
  const whole = cards.filter((c) => c.mean !== null && c.coverage === null);
  let best: ModelCardView | null = null;
  for (const c of whole.length ? whole : cards) if (c.mean !== null && (!best || c.mean > best.mean!)) best = c;
  const rows: ScoreRowView[] = ready.map((t) => ({
    golden: t.golden,
    name: t.name,
    cells: ordered.map(([, m]) => {
      const mine = m.rows.filter((r) => r.golden === t.golden).sort((a, b) => a.attempt - b.attempt);
      return mine.length ? { model: m.model, baseUrl: m.baseUrl, pips: mine.map(pip), mean: mean(mine.map((r) => r.score)) } : null;
    }),
  }));

  // ---- pairs ----
  const listed = input.pairs.filter((x) => filter === 'all' || x.confidence === filter);
  const sourceOf = new Map(input.sources.map((s) => [s.key, s]));
  // A source's own fix (its run's) heads its row in the list; each group's is the fix of the run its pairs are about.
  const fixOf = (s: PairSource, runId: string) => input.fixOf?.(s, runId) ?? null;
  // Where a source opens without a fix: its run's forks, at the call its first pair about that run is about.
  const sourceCall = (s: PairSource) => (s.kind === 'blame' ? s.callNo : (input.pairs.find((x) => x.source === s.key && x.runId === s.runId && x.aboutCallNo !== null)?.aboutCallNo ?? null));
  const sourceLink = (s: PairSource) => sourceHref(s, fixOf(s, s.runId), sourceCall(s));
  const groups: PairGroupView[] = [];
  const byKey = new Map<string, PairGroupView>();
  for (const x of listed) {
    // Pairs from the same call share their conversation and rejected answer, so they show as one group.
    const key = `${x.source}:${x.rejected.runId}:${x.rejected.callNo}:${x.rejected.text}`;
    let g = byKey.get(key);
    if (!g) {
      const s = sourceOf.get(x.source);
      const fix = s ? fixOf(s, x.runId) : null;
      // Headed by the run the pairs are about, at the same call; by the attempt when that run never got there.
      const head = x.aboutCallNo !== null ? { runId: x.runId, callNo: x.aboutCallNo } : { runId: x.rejected.runId, callNo: x.rejected.callNo };
      g = {
        key,
        confidence: x.confidence,
        runId: head.runId,
        callNo: head.callNo,
        href: links.run(head.runId, head.callNo),
        about: x.runId,
        attemptOf: head.runId === x.runId ? null : { runId: x.runId, href: links.run(x.runId) },
        fix: fix && s && s.kind !== 'repeat' ? { label: fix.label, href: fixHref(s.kind, fix) } : null,
        source: { key: x.source, kind: x.sourceKind, label: s?.label ?? x.sourceKind, href: s ? sourceLink(s) : links.run(x.runId) },
        from: FROM[x.sourceKind],
        count: 0,
        context: x.context,
        rejected: { text: x.rejected.text, what: x.rejected.what, runId: x.rejected.runId, callNo: x.rejected.callNo, href: links.run(x.rejected.runId, x.rejected.callNo) },
        chosen: [],
        chosenLabel: '',
        ids: [],
      };
      byKey.set(key, g);
      groups.push(g);
    }
    g.count++;
    g.ids.push(x.id);
    g.chosen.push({ text: x.chosen.text, what: x.chosen.what, runId: x.chosen.runId, callNo: x.chosen.callNo, href: links.run(x.chosen.runId, x.chosen.callNo) });
  }
  for (const g of groups) g.chosenLabel = g.chosen.length === 1 ? `chosen · ${g.chosen[0]!.what}` : `chosen · ${g.chosen.length} attempts that passed`;
  const madeBy: Record<string, number> = {};
  for (const x of input.pairs) madeBy[x.source] = (madeBy[x.source] ?? 0) + 1;

  // ---- tasks ----
  const updateOf = (t: Task) => input.updates?.[t.golden] ?? null;
  const warn = findOneSided(input.tasks);
  const opposite = warn?.opposite ? (input.tasks.find((t) => t.golden === warn.opposite!.golden) ?? null) : null;
  // A task whose test fails is fixed on Tests, and one whose last test is inconclusive settled there;
  // one whose test forks before its takeover, by updating its golden.
  const oppositeUpdate = opposite ? updateOf(opposite) : null;
  const once = !opposite ? null : oppositeUpdate ? 'its golden is updated' : opposite.status === 'blocked' ? 'its test passes' : 'it is a task';
  const warning = warn
    ? {
        ...warn,
        text: `All of them reward “${warn.rewards}”, so a model that learned only that would score full marks.${opposite ? ` ${opposite.name} rewards the opposite once ${once}.` : ''}`,
        name: opposite?.name ?? null,
        once,
        fix: oppositeUpdate ? { label: 'Update the golden…', href: null, update: oppositeUpdate } : opposite?.status === 'blocked' ? { label: `${isInconclusiveNote(opposite.note) ? 'Settle' : 'Fix'} it on Tests`, href: links.tests(), update: null } : null,
      }
    : null;
  // Tasks a model can be scored on first, then what keeps the rest from being one; the project's order within each.
  const byStatus = [...input.tasks].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  const taskRows: TaskRowView[] = byStatus.map((t) => {
    const outcome = t.checks.filter((c) => !c.cap).map((c) => c.label);
    const checks = outcome.length ? ['the agent exits 0', ...outcome] : t.checks.map((c) => c.label);
    // Without an outcome check nothing is scored, so no model takes over: the task has no call to take over.
    const takeover = t.takeover;
    const k = takeover?.callNo ?? null;
    const update = updateOf(t);
    const atTakeover = t.runId && stored(t.runId) ? links.run(t.runId, k) : null;
    // A task blocked by an early fork opens the test run where it forked, where what changed shows; else the golden's run.
    const forkRun = update && t.fork?.runId && stored(t.fork.runId) ? links.run(t.fork.runId, t.fork.callNo) : null;
    const href = update ? (forkRun ?? atTakeover) : t.status === 'blocked' ? links.tests() : atTakeover;
    const opens = !href ? null : href === links.tests() ? 'Open Tests' : href === forkRun ? `Open the test run where it forked, at #${t.fork!.callNo}` : k !== null ? 'Open the golden’s run at the takeover' : 'Open the golden’s run';
    return {
      golden: t.golden,
      name: t.name,
      sub: takeover ? `takes over at #${takeover.callNo} · ${takeover.why}${t.scope !== null && t.scopes.length > 1 ? ` · plays scope ${t.scope}` : ''}` : 'no call to take over',
      takeover: k,
      checks,
      after: k !== null ? t.after : null,
      status: { key: t.status, ...STATUS[t.status], short: t.note },
      rewards: t.rewards,
      href,
      opens,
      update,
    };
  });

  // ---- serve: one request and its response, from the first ready task ----
  const first = ready[0] ?? null;
  const serve = first ? serveSample(first) : null;

  const last = input.exports[0] ?? null;
  return {
    strip: {
      pairs: { value: String(counts.all), sub: counts.all ? `${counts.high} high confidence · ${counts.medium} medium` : 'blame a failing run to make some', href: links.training(), high: counts.high, medium: counts.medium },
      tasks: { value: `${ready.length} / ${input.tasks.length}`, sub: input.tasksError ? 'the tasks can’t be read' : [blocked ? `${blocked} blocked` : '', notTask ? `${notTask} not a task` : ''].filter(Boolean).join(' · ') || (input.tasks.length ? 'every golden is a task' : 'no goldens yet'), href: links.training('tasks'), ready: ready.length, total: input.tasks.length, blocked, notTask },
      // The best names its endpoint when its model was scored at two; the same model at two endpoints is one model scored.
      best: { value: best ? best.mean!.toFixed(2) : '—', sub: best ? `${best.model}${best.where ? ` at ${best.where}` : ''} · ${best.coverage ?? `${plural(new Set(cards.map((c) => c.model)).size, 'model')} scored`}` : 'no model scored yet', href: links.training('tasks'), model: best?.model ?? null, mean: best?.mean ?? null },
      // The UI adds the export's time (`at`) after the file, as it formats every time.
      left: { value: String(last?.pairs ?? 0), sub: last ? `pairs, to ${last.file === '-' ? 'stdout' : last.file}` : 'nothing exported yet', href: null, pairs: last?.pairs ?? 0, file: last?.file ?? null, at: last?.at ?? null },
    },
    tabs: { pairs: counts.all, tasks: ready.length },
    actions: { exportPairs: counts.all > 0, scoreModel: ready.length > 0 },
    pairs: {
      filter,
      counts,
      groups,
      madeBy,
      sources: input.sources.map((s) => ({ key: s.key, kind: s.kind, label: s.label, href: sourceLink(s), made: s.made, confidence: s.made ? s.confidence : null, why: s.why })),
      confidence: [
        { level: 'high', title: 'Blame asked this call again, and the run passed.', sub: 'This answer decided the run.' },
        { level: 'medium', title: 'A passing and a failing attempt first differ here.', sub: 'Nothing checked that this answer decided the run.' },
      ],
      footnote: 'Identical answers count once.',
      empty: counts.all ? null : { title: 'No pairs yet', text: 'Blame a failing run. The answer it was lost on and an answer that went on to pass make a pair.', command: 'shadowlap blame <run> --expect <checks>' },
    },
    tasks: {
      rows: taskRows,
      warning,
      empty: input.tasks.length || input.tasksError ? null : { title: 'No tasks yet', text: 'A golden whose checks say what the agent must do is a task: a model takes over at one call, and the checks score what it did.', command: 'shadowlap pack <run> goldens/<name>' },
      error: input.tasksError ?? null,
      // A golden whose checks only cap tokens and cost: one with no checks at all has none to call weak.
      weak: input.tasks.find((t) => t.status === 'not-a-task' && t.note === CAPS_ONLY_NOTE)?.name ?? null,
    },
    scores: {
      sub: `mean share of checks passed, ${plural(ready.length, 'task')}`,
      empty: ready.length && cards.length ? null : 'No scores yet.',
      cards,
      rows,
      footnote: 'Each attempt replays the calls before the takeover free, so only the model being scored is paid for. Every attempt is a run in the store, so an odd score opens like any fork.',
    },
    serve,
    exportDialog: {
      title: 'Export preference pairs',
      text: 'One JSON line per pair: the conversation as the model saw it at that call, the answer to prefer and the one to avoid. Redaction rules apply to the copy.',
      high: counts.high,
      all: counts.all,
      out: PAIRS_EXPORT_FILE,
      formats: [
        { value: 'openai-preference', label: 'OpenAI preference' },
        { value: 'trl', label: 'TRL preference' },
      ],
      levels: [
        { value: 'high', label: `High confidence only (${counts.high})` },
        { value: 'medium', label: `High and medium (${counts.all})` },
      ],
    },
    scoreDialog: input.models ? scoreDialogView(input.tasks, input.scores, input.models) : null,
  };
}

// ---- the jobs behind the dialogs ----

/** Where a dashboard export of pairs is written, in the project folder (decision 5). */
export const PAIRS_EXPORT_FILE = '.shadowlap/exports/pairs.jsonl';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Attempts per task Score a model offers; the job takes no other count (the CLI takes any). */
export const SCORE_ATTEMPTS: readonly number[] = [5, 10];
const MODEL_NAME = /^[\w.:/@+][\w.:/@+-]{0,199}$/;

/**
 * Export pairs as a job: `{ format, minConfidence }` from the dialog, checked, as argv after
 * `shadowlap`. The file is always the project's exports folder, so a request can't name a path.
 */
export function exportPairsJob(body: unknown): { args: string[]; out: string } | { error: string } {
  const b = isObject(body) ? body : {};
  const format = b.format ?? 'openai-preference';
  const min = b.minConfidence ?? 'high';
  if (typeof format !== 'string' || !(PAIR_FORMATS as string[]).includes(format)) return { error: `format must be ${PAIR_FORMATS.join(' or ')}` };
  if (min !== 'high' && min !== 'medium') return { error: 'minConfidence must be high or medium' };
  return { args: ['export', 'pairs', '--min-confidence', min, '--format', format, '--out', PAIRS_EXPORT_FILE], out: PAIRS_EXPORT_FILE };
}

/**
 * Score a model as a job: `{ model, baseUrl?, attempts (5 or 10), goldens? }` from the dialog,
 * checked, as argv after `shadowlap`. The goldens must be ready tasks (every ready task when none are
 * named); the model is a name, and the base URL an http or https URL, such as an OpenAI-compatible
 * server's.
 */
export function scoreModelJob(body: unknown, tasks: readonly Task[]): { args: string[]; goldens: string[] } | { error: string } {
  if (!isObject(body)) return { error: 'the request must be a JSON object' };
  const { model, baseUrl, attempts, goldens } = body;
  if (typeof model !== 'string' || !MODEL_NAME.test(model.trim())) return { error: 'model must be a model name, such as qwen2.5:7b' };
  let base: string | null = null;
  if (baseUrl !== undefined && baseUrl !== null && baseUrl !== '') {
    if (typeof baseUrl !== 'string') return { error: 'baseUrl must be a URL' };
    let url: URL;
    try {
      url = new URL(baseUrl.trim());
    } catch {
      return { error: 'baseUrl must be a URL, such as http://127.0.0.1:8000/v1' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'baseUrl must be an http or https URL' };
    if (url.username || url.password) return { error: 'baseUrl must not carry credentials: the key is read from the environment' };
    base = url.toString().replace(/\/+$/, '');
  }
  const n = attempts ?? 5;
  if (!SCORE_ATTEMPTS.includes(n as number)) return { error: `attempts must be ${SCORE_ATTEMPTS.join(' or ')}` };
  const ready = tasks.filter((t) => t.status === 'ready').map((t) => t.golden);
  let chosen: string[];
  if (goldens === undefined || goldens === null) chosen = ready;
  else {
    if (!Array.isArray(goldens) || !goldens.every((g): g is string => typeof g === 'string')) return { error: 'goldens must be a list of golden paths' };
    const unknown = goldens.find((g) => !ready.includes(g));
    if (unknown !== undefined) return { error: `${unknown} is not a ready task` };
    chosen = [...new Set(goldens)];
  }
  if (!chosen.length) return { error: 'no task is ready to score' };
  // A golden path that looks like an option would be read as one.
  if (chosen.some((g) => g.startsWith('-'))) return { error: 'a golden path must not start with "-"' };
  return { args: ['tasks', 'score', ...chosen, '--model', model.trim(), ...(base ? ['--base-url', base] : []), '--attempts', String(n)], goldens: chosen };
}

/**
 * Update the golden of a task its test's early fork blocks, as a job: `{ golden }` from the dialog,
 * which must name such a task. What it runs is `taskUpdate`'s, built here from the store and the
 * config, never from the request: a `normalize add` for each value that changes every run, then
 * `test <golden> --update`, which re-records it (or `test <golden>` when those rules are the fix).
 */
export function taskUpdateJob(body: unknown, store: Store, tasks: readonly Task[], normalizers: readonly Normalizer[]): { steps: string[][]; title: string } | { error: string } {
  const golden = isObject(body) ? body.golden : undefined;
  if (typeof golden !== 'string' || !golden) return { error: 'name the golden to update' };
  const task = tasks.find((t) => t.golden === golden);
  if (!task) return { error: `${golden} is not a golden of this project` };
  // A golden path that looks like an option would be read as one.
  if (task.golden.startsWith('-')) return { error: 'a golden path must not start with "-"' };
  const u = taskUpdate(store, task, normalizers);
  if (!u) return { error: `${task.name} is not blocked by its test forking before the takeover${task.status === 'blocked' ? `: ${task.note ?? 'its test fails'}; ${isInconclusiveNote(task.note) ? 'settle' : 'fix'} it on Tests` : ''}` };
  return { steps: u.steps, title: u.rerecords ? `Updating ${task.name}` : `Adding a normalizer for ${task.name}` };
}
