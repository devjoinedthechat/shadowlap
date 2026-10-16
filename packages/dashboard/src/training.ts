import { countPairs, findPairs, oneSided as findOneSided, fixLabelInfo, fixOfRun, PAIR_FORMATS, type ModelChoice, type ModelListing, type OneSided, type Pair, type PairFormat, type PairSource, type PairsExport, type Store, type Task, type TaskScoreRow } from '@shadowlap/engine';
import { fixForRun } from './fixes.js';

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
}

/**
 * The fix the pairs a source made about one run belong to: a blame's is the blamed run's, a verify's
 * the one of the fixes its verdict counted for that the run fails in. `runId` is the run the pairs
 * are about (Pair.runId), which for a blame is the source's own run.
 */
export type FixOf = (source: PairSource, runId: string) => SourceFix | null;

/** What the store holds for Training; `tasks` and `models` come from the caller. */
export function readTraining(store: Store, extra: { tasks: Task[]; tasksError?: string | null; models?: ModelListing | null; fixOf?: FixOf }): TrainingInput {
  const { pairs, sources } = findPairs(store);
  const storedRuns = new Set(extra.tasks.flatMap((t) => (t.runId && store.getRun(t.runId) ? [t.runId] : [])));
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
    const v = f?.fix ? { fix: { id: f.fix.fixId, label: label(f.fix), ...(f.verify?.verifyId ? { verifyId: f.verify.verifyId } : {}) }, linked: new Set(report.map((l) => l.fixId)) } : null;
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
  /** The golden's run at the takeover; Tests for a blocked task; null when the store doesn't hold the run. */
  href: string | null;
}

export interface ModelCardView {
  model: string;
  baseUrl: string | null;
  /** Where it ran: `the recorded model`, `Anthropic API`, `Ollama, on this machine`. */
  via: string;
  mean: number | null;
  /** The bar's width, 0 to 1. */
  bar: number;
  spent: number;
  /** `≈$0.165 spent`, or `$0, not a paid API`. */
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
  /** What the dialog sends to start the job (scoreModelJob): the model as `--model` takes it, and the endpoint. */
  request: { model: string; baseUrl: string | null };
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
  /** The first model not scored yet, else the first. */
  selected: string | null;
  attempts: number[];
  /** "Your own endpoint…": a base URL and a model name, filled in with these. */
  endpoint: { key: string; group: string; label: string; baseUrl: string; model: string; note: string };
  /** Providers that couldn't be listed, and why. */
  notes: Array<{ group: string; note: string }>;
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
    warning: (OneSided & { text: string; name: string | null; once: string | null; fix: { label: string; href: string } | null }) | null;
    empty: { title: string; text: string; command: string } | null;
    /** Why the tasks couldn't be read, such as a mistake in the config's `tests`; null when they could. */
    error: string | null;
    /** The first task that isn't one, for "weak checks teach the wrong thing". */
    weak: string | null;
  };
  scores: { sub: string; empty: string | null; cards: ModelCardView[]; rows: ScoreRowView[]; footnote: string };
  serve: { command: string; request: string; response: string } | null;
  exportDialog: { title: string; text: string; high: number; all: number; formats: Array<{ value: PairFormat; label: string }>; levels: Array<{ value: 'high' | 'medium'; label: string }> };
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

/** A fix as its source opens it: at the Blame step, or at the verify. */
function fixHref(kind: PairSource['kind'], fix: SourceFix): string {
  return kind === 'blame' ? `#/fixes/${fix.id}/blame` : `#/fixes/${fix.id}/verify${fix.verifyId ? `/${fix.verifyId}` : ''}`;
}

/** A source opens its fix; without one, its run's forks, at the call its pairs are about when it made some. */
function sourceHref(s: PairSource, fix: SourceFix | null, callNo: number | null): string {
  if (fix && s.kind !== 'repeat') return fixHref(s.kind, fix);
  return `#/run/${s.runId}${callNo ? `/${callNo}` : ''}/forks`;
}

/** The share of checks passed, as a pip: every check, some, or none. */
function pip(row: TaskScoreRow): PipView {
  return { score: row.score, kind: row.score >= 1 ? 'all' : row.score > 0 ? 'some' : 'none', attempt: row.attempt, runId: row.runId, href: row.runId ? `#/run/${row.runId}` : null };
}

/** Each model's mean over the ready tasks' attempts, by model and endpoint. */
function modelMeans(scores: readonly TaskScoreRow[], ready: Set<string>): Map<string, number> {
  const by = new Map<string, number[]>();
  for (const r of scores) {
    if (!ready.has(r.golden)) continue;
    const k = modelKey(r.model, r.baseUrl);
    by.set(k, [...(by.get(k) ?? []), r.score]);
  }
  return new Map([...by].map(([k, xs]) => [k, mean(xs)]));
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

/** Score a model's picker: the listed models with their last scores, the one to preselect, and "Your own endpoint…". */
export function scoreDialogView(tasks: readonly Task[], scores: readonly TaskScoreRow[], listing: ModelListing): ScoreDialogView | null {
  const ready = tasks.filter((t) => t.status === 'ready');
  if (!ready.length) return null;
  const means = modelMeans(scores, new Set(ready.map((t) => t.golden)));
  const options: ModelOptionView[] = listing.choices.map((c) => {
    const last = means.get(modelKey(c.id, c.baseUrl)) ?? null;
    const flag = (name: string) => (c.flags.includes(name) ? (c.flags[c.flags.indexOf(name) + 1] ?? null) : null);
    return { ...c, key: modelKey(c.id, c.baseUrl), request: { model: flag('--model') ?? c.id, baseUrl: flag('--base-url') }, label: last === null ? c.id : `${c.id} · scored ${last.toFixed(2)}`, lastScore: last, note: scoreNote(c, last) };
  });
  const first = options.find((o) => o.lastScore === null) ?? options[0] ?? null;
  return {
    title: `Score a model on ${plural(ready.length, 'task')}`,
    options,
    groups: [...new Set(options.map((o) => o.group))],
    selected: first?.key ?? null,
    attempts: [...SCORE_ATTEMPTS],
    endpoint: { key: '__endpoint', group: 'Other', label: 'Your own endpoint…', baseUrl: 'http://127.0.0.1:8000/v1', model: 'my-finetune', note: scoreNote(null, null) },
    notes: listing.notes,
  };
}

/** `GET /api/models` (A7): every model to score, with its price per attempt and its last score, and Score a model's picker. */
export interface ModelsView {
  /** Ready tasks: the ones a model is scored on, whose tokens price an attempt. */
  ready: number;
  choices: Array<ModelChoice & { lastScore: number | null }>;
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
    choices: listing.choices.map((c) => ({ ...c, lastScore: means.get(modelKey(c.id, c.baseUrl)) ?? null })),
    notes: listing.notes,
    tokens: listing.tokens,
    dialog: scoreDialogView(tasks, scores, listing),
  };
}

/**
 * From a training loop: one `tasks serve` request for a ready task and its response (serve-tasks.ts
 * in the CLI), cut to what a loop reads, as the mock shows it: the score, each check, the run and
 * what it cost. The endpoint also answers the task, model, takeover, each check's detail, the exit
 * code and the time (docs/training.md has all of it). The model and run id are samples.
 */
function serveSample(t: Task): { command: string; request: string; response: string } {
  const q = JSON.stringify;
  const checks = ['the agent exits 0', ...t.checks.filter((c) => !c.cap).map((c) => c.label)];
  const from = t.takeover?.callNo ?? null;
  return {
    command: 'shadowlap tasks serve goldens/ --port 4779',
    request: [`POST /v1/tasks/${t.name}/attempts`, 'Authorization: Bearer <token>', `{ "model": "my-finetune", "baseUrl": "http://127.0.0.1:8000/v1"${from !== null ? `,\n  "from": ${from}` : ''} }`].join('\n'),
    response: ['200 OK', '{ "score": 1,', '  "checks": [', ...checks.map((c, i) => `    { "check": ${q(c)}, "pass": true }${i < checks.length - 1 ? ',' : ' ],'}`), '  "run": "01K5CR2M8Q…", "spent": 0 }'].join('\n'),
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
  const models = new Map<string, { model: string; baseUrl: string | null; via: string; spent: number; at: number; first: number; rows: TaskScoreRow[] }>();
  for (const r of input.scores) {
    const k = modelKey(r.model, r.baseUrl);
    const via = r.baseUrl === null && recorded.has(r.model) ? 'the recorded model' : (r.via ?? r.baseUrl ?? 'the recorded provider');
    const m = models.get(k) ?? { model: r.model, baseUrl: r.baseUrl, via, spent: 0, at: 0, first: r.at, rows: [] };
    m.rows.push(r);
    m.spent += r.spent;
    m.at = Math.max(m.at, r.at);
    m.first = Math.min(m.first, r.at);
    models.set(k, m);
  }
  const means = modelMeans(input.scores, readySet);
  const ordered = [...models.entries()].sort((a, b) => a[1].first - b[1].first || a[0].localeCompare(b[0]));
  const cards: ModelCardView[] = ordered.map(([k, m]) => {
    const value = means.get(k) ?? null;
    const local = !!m.baseUrl && LOOPBACK.test(m.baseUrl);
    return { model: m.model, baseUrl: m.baseUrl, via: m.via, mean: value, bar: value ?? 0, spent: m.spent, cost: m.spent ? `${approx(m.spent)} spent` : local ? '$0, not a paid API' : '$0 spent', at: m.at };
  });
  let best: { model: string; mean: number } | null = null;
  for (const c of cards) if (c.mean !== null && (!best || c.mean > best.mean)) best = { model: c.model, mean: c.mean };
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
        href: `#/run/${head.runId}/${head.callNo}`,
        about: x.runId,
        attemptOf: head.runId === x.runId ? null : { runId: x.runId, href: `#/run/${x.runId}` },
        fix: fix && s && s.kind !== 'repeat' ? { label: fix.label, href: fixHref(s.kind, fix) } : null,
        source: { key: x.source, kind: x.sourceKind, label: s?.label ?? x.sourceKind, href: s ? sourceLink(s) : `#/run/${x.runId}` },
        from: FROM[x.sourceKind],
        count: 0,
        context: x.context,
        rejected: { text: x.rejected.text, what: x.rejected.what, runId: x.rejected.runId, callNo: x.rejected.callNo, href: `#/run/${x.rejected.runId}/${x.rejected.callNo}` },
        chosen: [],
        chosenLabel: '',
        ids: [],
      };
      byKey.set(key, g);
      groups.push(g);
    }
    g.count++;
    g.ids.push(x.id);
    g.chosen.push({ text: x.chosen.text, what: x.chosen.what, runId: x.chosen.runId, callNo: x.chosen.callNo, href: `#/run/${x.chosen.runId}/${x.chosen.callNo}` });
  }
  for (const g of groups) g.chosenLabel = g.chosen.length === 1 ? `chosen · ${g.chosen[0]!.what}` : `chosen · ${g.chosen.length} attempts that passed`;
  const madeBy: Record<string, number> = {};
  for (const x of input.pairs) madeBy[x.source] = (madeBy[x.source] ?? 0) + 1;

  // ---- tasks ----
  const warn = findOneSided(input.tasks);
  const opposite = warn?.opposite ? (input.tasks.find((t) => t.golden === warn.opposite!.golden) ?? null) : null;
  const warning = warn
    ? {
        ...warn,
        text: `All of them reward “${warn.rewards}”, so a model that learned only that would score full marks.${opposite ? ` ${opposite.name} rewards the opposite once ${opposite.status === 'blocked' ? 'its test passes' : 'it is a task'}.` : ''}`,
        name: opposite?.name ?? null,
        once: opposite ? (opposite.status === 'blocked' ? 'its test passes' : 'it is a task') : null,
        fix: opposite?.status === 'blocked' ? { label: 'Fix it on Tests', href: '#/tests' } : null,
      }
    : null;
  // Tasks a model can be scored on first, then what keeps the rest from being one; the project's order within each.
  const byStatus = [...input.tasks].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  const taskRows: TaskRowView[] = byStatus.map((t) => {
    const outcome = t.checks.filter((c) => !c.cap).map((c) => c.label);
    const checks = outcome.length ? ['the agent exits 0', ...outcome] : t.checks.map((c) => c.label);
    // Without an outcome check nothing is scored, so no model takes over: the mock's "no call to take over".
    const takeover = outcome.length && t.status !== 'no-golden' ? t.takeover : null;
    const k = takeover?.callNo ?? null;
    return {
      golden: t.golden,
      name: t.name,
      sub: takeover ? `takes over at #${takeover.callNo} · ${takeover.why}${t.scope !== null && t.scopes.length > 1 ? ` · plays scope ${t.scope}` : ''}` : 'no call to take over',
      takeover: k,
      checks,
      after: k !== null ? t.after : null,
      status: { key: t.status, ...STATUS[t.status], short: t.note },
      rewards: t.rewards,
      href: t.status === 'blocked' ? '#/tests' : stored(t.runId) ? `#/run/${t.runId}${k !== null ? `/${k}` : ''}` : null,
    };
  });

  // ---- serve: one request and its response, from the first ready task ----
  const first = ready[0] ?? null;
  const serve = first ? serveSample(first) : null;

  const last = input.exports[0] ?? null;
  return {
    strip: {
      pairs: { value: String(counts.all), sub: counts.all ? `${counts.high} high confidence · ${counts.medium} medium` : 'blame a failing run to make some', href: '#/training', high: counts.high, medium: counts.medium },
      tasks: { value: `${ready.length} / ${input.tasks.length}`, sub: input.tasksError ? 'the tasks can’t be read' : [blocked ? `${blocked} blocked` : '', notTask ? `${notTask} not a task` : ''].filter(Boolean).join(' · ') || (input.tasks.length ? 'every golden is a task' : 'no goldens yet'), href: '#/training/tasks', ready: ready.length, total: input.tasks.length, blocked, notTask },
      best: { value: best ? best.mean.toFixed(2) : '—', sub: best ? `${best.model} · ${plural(cards.length, 'model')} scored` : 'no model scored yet', href: '#/training/tasks', model: best?.model ?? null, mean: best?.mean ?? null },
      // The UI adds the export's time (`at`) after the file, as it formats every time.
      left: { value: String(last?.pairs ?? 0), sub: last ? `pairs, to ${last.file === '-' ? 'stdout' : last.file}` : 'nothing until you export it', href: null, pairs: last?.pairs ?? 0, file: last?.file ?? null, at: last?.at ?? null },
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
      empty: input.tasks.length || input.tasksError ? null : { title: 'No tasks yet', text: 'A golden with outcome checks is a task: a model takes over at one call, and the checks score what it did.', command: 'shadowlap pack <run> goldens/<name>' },
      error: input.tasksError ?? null,
      weak: input.tasks.find((t) => t.status === 'not-a-task')?.name ?? null,
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
      formats: [
        { value: 'openai-preference', label: 'OpenAI preference fine-tuning' },
        { value: 'trl', label: 'prompt, chosen, rejected (TRL)' },
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
