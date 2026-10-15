import { countPairs, findPairs, oneSided as findOneSided, type ModelChoice, type ModelListing, type OneSided, type Pair, type PairSource, type PairsExport, type Store, type Task, type TaskScoreRow } from '@shadowlap/engine';

/**
 * The Training screen's read model (`#/training`, `#/training/tasks`): preference pairs read from the
 * attempts blame, verify and --repeat left in the store, goldens as tasks, each model's scores on
 * them, and the models to score next. Plain JSON from plain inputs, no HTTP: `readTraining` gathers
 * what the store holds, the caller adds the tasks (they come from the project's goldens and config)
 * and the model listing (it asks providers, so it is fetched on its own), and `trainingView` shapes
 * it all for the screen. Copy follows the mock.
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
  scores: TaskScoreRow[];
  /** Pairs exports, newest first. */
  exports: PairsExport[];
  /** The models to score (A7), or null while they are being listed. */
  models?: ModelListing | null;
  /** Which fix a source belongs to, when Fixes knows. */
  fixOf?: (source: PairSource) => SourceFix | null;
}

/** What the store holds for Training; `tasks` and `models` come from the caller. */
export function readTraining(store: Store, extra: { tasks: Task[]; models?: ModelListing | null; fixOf?: (source: PairSource) => SourceFix | null }): TrainingInput {
  const { pairs, sources } = findPairs(store);
  return { pairs, sources, tasks: extra.tasks, scores: store.listTaskScores(), exports: store.listPairsExports(5), ...(extra.models !== undefined ? { models: extra.models } : {}), ...(extra.fixOf ? { fixOf: extra.fixOf } : {}) };
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
  runId: string;
  callNo: number;
  /** Opens the run at the call the answers answer. */
  href: string;
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
  /** The golden's run at the takeover; Tests for a blocked task. */
  href: string | null;
}

export interface ModelCardView {
  model: string;
  baseUrl: string | null;
  via: string;
  mean: number | null;
  /** The bar's width, 0 to 1. */
  bar: number;
  spent: number;
  /** `$0.17 spent`, or `$0, not a paid API`. */
  cost: string;
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
  lastScore: number | null;
  /** The note under the picker: where it runs, what an attempt costs, and the score it replaces. */
  note: string;
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
    warning: (OneSided & { text: string; fix: { label: string; href: string } | null }) | null;
    empty: { title: string; text: string; command: string } | null;
    /** The first task that isn't one, for "weak checks teach the wrong thing". */
    weak: string | null;
  };
  scores: { sub: string; empty: string | null; cards: ModelCardView[]; rows: ScoreRowView[] };
  serve: { command: string; request: string; response: string } | null;
  exportDialog: { high: number; all: number; formats: Array<{ value: string; label: string }>; levels: Array<{ value: 'high' | 'medium'; label: string }> };
  scoreDialog: { title: string; options: ModelOptionView[]; groups: string[]; selected: string | null; attempts: number[]; endpointNote: string; notes: Array<{ group: string; note: string }> } | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const usd = (n: number) => (n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(4)}` : n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);
const STATUS: Record<Task['status'], { label: string; badge: 'ok' | 'y' | 'n' }> = { ready: { label: 'ready', badge: 'ok' }, blocked: { label: 'blocked', badge: 'y' }, 'not-a-task': { label: 'not a task', badge: 'n' }, 'no-golden': { label: 'no golden', badge: 'n' } };
const FROM: Record<PairSource['kind'], string> = { blame: 'from blame', verify: 'from verify', repeat: 'from --repeat' };

const modelKey = (model: string, baseUrl: string | null) => `${model}\n${baseUrl ?? ''}`;

function sourceHref(s: PairSource, fix: SourceFix | null): string {
  if (fix && s.kind === 'blame') return `#/fixes/${fix.id}/blame`;
  if (fix && s.kind === 'verify') return `#/fixes/${fix.id}/verify${fix.verifyId ? `/${fix.verifyId}` : ''}`;
  return `#/run/${s.runId}/${s.callNo ?? 1}/forks`;
}

/** The share of checks passed, as a pip: every check, some, or none. */
function pip(row: TaskScoreRow): PipView {
  return { score: row.score, kind: row.score >= 1 ? 'all' : row.score > 0 ? 'some' : 'none', attempt: row.attempt, runId: row.runId, href: row.runId ? `#/run/${row.runId}` : null };
}

/** Each model's mean over the ready tasks' attempts. */
function modelMeans(scores: TaskScoreRow[], ready: Set<string>): Map<string, number> {
  const by = new Map<string, number[]>();
  for (const r of scores) {
    if (!ready.has(r.golden)) continue;
    const k = modelKey(r.model, r.baseUrl);
    by.set(k, [...(by.get(k) ?? []), r.score]);
  }
  return new Map([...by].map(([k, xs]) => [k, mean(xs)]));
}

/** The note under the model picker. */
export function scoreNote(c: Pick<ModelChoice, 'via' | 'baseUrl' | 'perAttempt' | 'local'> | null, lastScore: number | null): string {
  const where = !c
    ? 'Any OpenAI-compatible server, such as vLLM serving the model you’re training. Not a paid API.'
    : c.local
      ? `Runs at ${c.baseUrl ?? 'this machine'} · not a paid API`
      : c.perAttempt === null
        ? `${c.via} · no price for this model, so the cost isn't estimated`
        : `${c.via} · about ${usd(c.perAttempt)} an attempt`;
  return lastScore === null ? where : `${where} · replaces its score of ${lastScore.toFixed(2)}`;
}

/** What `shadowlap tasks score` runs for a choice, as argv after `shadowlap`. */
export function scoreArgv(goldens: string[], flags: string[], attempts: number): string[] {
  return ['tasks', 'score', ...goldens, ...flags, '--attempts', String(attempts)];
}

/** What `shadowlap export pairs` runs, as argv after `shadowlap`. */
export function exportPairsArgv(format: 'openai-preference' | 'trl', minConfidence: 'high' | 'medium', out: string): string[] {
  return ['export', 'pairs', '--min-confidence', minConfidence, '--format', format, '--out', out];
}

export function trainingView(input: TrainingInput, options: { filter?: PairFilter } = {}): TrainingView {
  const filter = options.filter ?? 'all';
  const counts = countPairs(input.pairs);
  const ready = input.tasks.filter((t) => t.status === 'ready');
  const readySet = new Set(ready.map((t) => t.golden));
  const blocked = input.tasks.filter((t) => t.status === 'blocked').length;
  const notTask = input.tasks.filter((t) => t.status === 'not-a-task').length;

  // ---- scores ----
  const models = new Map<string, { model: string; baseUrl: string | null; via: string; spent: number; at: number; first: number; rows: TaskScoreRow[] }>();
  for (const r of input.scores) {
    const k = modelKey(r.model, r.baseUrl);
    const m = models.get(k) ?? { model: r.model, baseUrl: r.baseUrl, via: r.via ?? (r.baseUrl ?? 'the recorded provider'), spent: 0, at: 0, first: r.at, rows: [] };
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
    const local = m.rows.every((r) => r.spent === 0) && !!m.baseUrl && /^https?:\/\/(localhost|127\.|\[::1\])/.test(m.baseUrl);
    return { model: m.model, baseUrl: m.baseUrl, via: m.via, mean: value, bar: value ?? 0, spent: m.spent, cost: m.spent ? `${usd(m.spent)} spent` : local ? '$0, not a paid API' : '$0 spent', at: m.at };
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
  const fixes = new Map(input.sources.map((s) => [s.key, input.fixOf?.(s) ?? null]));
  const groups: PairGroupView[] = [];
  const byKey = new Map<string, PairGroupView>();
  for (const x of listed) {
    // Pairs from the same call share their conversation and rejected answer, so they show as one group.
    const key = `${x.source}:${x.rejected.runId}:${x.rejected.callNo}:${x.rejected.text}`;
    let g = byKey.get(key);
    if (!g) {
      const s = sourceOf.get(x.source);
      const fix = fixes.get(x.source) ?? null;
      g = {
        key,
        confidence: x.confidence,
        runId: x.runId,
        callNo: x.callNo,
        href: `#/run/${x.rejected.runId}/${x.rejected.callNo}`,
        fix: fix && s ? { label: fix.label, href: sourceHref(s, fix) } : null,
        source: { key: x.source, kind: x.sourceKind, label: s?.label ?? x.sourceKind, href: s ? sourceHref(s, fix) : `#/run/${x.runId}` },
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
  const opposite = warn?.opposite ? input.tasks.find((t) => t.golden === warn.opposite!.golden) ?? null : null;
  const warning = warn
    ? {
        ...warn,
        text: `All of them reward “${warn.rewards}”, so a model that learned only that would score full marks.${opposite ? ` ${opposite.name} rewards the opposite once ${opposite.status === 'blocked' ? 'its test passes' : 'it is a task'}.` : ''}`,
        fix: opposite?.status === 'blocked' ? { label: 'Fix it on Tests', href: '#/tests' } : null,
      }
    : null;
  const taskRows: TaskRowView[] = input.tasks.map((t) => {
    const outcome = t.checks.filter((c) => !c.cap).map((c) => c.label);
    const checks = outcome.length ? ['the agent exits 0', ...outcome] : t.checks.map((c) => c.label);
    const k = t.takeover?.callNo ?? null;
    return {
      golden: t.golden,
      name: t.name,
      sub: t.takeover && t.status !== 'no-golden' ? `takes over at #${t.takeover.callNo} · ${t.takeover.why}` : 'no call to take over',
      takeover: k,
      checks,
      after: k !== null ? t.after : null,
      status: { key: t.status, ...STATUS[t.status], short: t.note },
      rewards: t.rewards,
      href: t.status === 'blocked' ? '#/tests' : t.runId ? `#/run/${t.runId}${k !== null ? `/${k}` : ''}` : null,
    };
  });

  // ---- serve: one request and its response, from the first ready task ----
  const first = ready[0] ?? null;
  const serve = first
    ? {
        command: 'shadowlap tasks serve goldens/ --port 4779',
        request: `POST /v1/tasks/${first.name}/attempts\n{ "model": "my-finetune", "baseUrl": "http://127.0.0.1:8000/v1"${first.takeover ? `,\n  "from": ${first.takeover.callNo}` : ''} }`,
        response: `200 OK\n${JSON.stringify(
          {
            task: first.name,
            model: 'my-finetune',
            takeover: first.takeover?.callNo ?? null,
            score: 1,
            checks: ['the agent exits 0', ...first.checks.filter((c) => !c.cap).map((c) => c.label)].map((check) => ({ check, pass: true, detail: null })),
            run: '01K5CR2M8Q…',
            spent: 0,
          },
          null,
          2,
        )}`,
      }
    : null;

  // ---- score a model ----
  let scoreDialog: TrainingView['scoreDialog'] = null;
  if (input.models && ready.length) {
    const options: ModelOptionView[] = input.models.choices.map((c) => {
      const last = means.get(modelKey(c.id, c.baseUrl)) ?? null;
      return { ...c, key: modelKey(c.id, c.baseUrl), lastScore: last, note: scoreNote(c, last) };
    });
    const groupsList = [...new Set(options.map((o) => o.group))];
    const firstUnscored = options.find((o) => o.lastScore === null) ?? options[0] ?? null;
    scoreDialog = {
      title: `Score a model on ${plural(ready.length, 'task')}`,
      options,
      groups: groupsList,
      selected: firstUnscored?.key ?? null,
      attempts: [5, 10],
      endpointNote: scoreNote(null, null),
      notes: input.models.notes,
    };
  }

  const last = input.exports[0] ?? null;
  return {
    strip: {
      pairs: { value: String(counts.all), sub: counts.all ? `${counts.high} high confidence · ${counts.medium} medium` : 'blame a failing run to make some', href: '#/training', high: counts.high, medium: counts.medium },
      tasks: { value: `${ready.length} / ${input.tasks.length}`, sub: [blocked ? `${blocked} blocked` : '', notTask ? `${notTask} not a task` : ''].filter(Boolean).join(' · ') || (input.tasks.length ? 'every golden is a task' : 'no goldens yet'), href: '#/training/tasks', ready: ready.length, total: input.tasks.length, blocked, notTask },
      best: { value: best ? best.mean.toFixed(2) : '—', sub: best ? `${best.model} · ${plural(cards.length, 'model')} scored` : 'no model scored yet', href: '#/training/tasks', model: best?.model ?? null, mean: best?.mean ?? null },
      left: { value: String(last?.pairs ?? 0), sub: last ? `pairs, to ${last.file === '-' ? 'stdout' : last.file}` : 'nothing until you export it', href: null, pairs: last?.pairs ?? 0, file: last?.file ?? null, at: last?.at ?? null },
    },
    tabs: { pairs: counts.all, tasks: ready.length },
    actions: { exportPairs: counts.all > 0, scoreModel: ready.length > 0 },
    pairs: {
      filter,
      counts,
      groups,
      madeBy,
      sources: input.sources.map((s) => ({ key: s.key, kind: s.kind, label: s.label, href: sourceHref(s, fixes.get(s.key) ?? null), made: s.made, confidence: s.made ? s.confidence : null, why: s.why })),
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
      empty: input.tasks.length ? null : { title: 'No tasks yet', text: 'A golden with outcome checks is a task: a model takes over at one call, and the checks score what it did.', command: 'shadowlap pack <run> goldens/<name>' },
      weak: input.tasks.find((t) => t.status === 'not-a-task')?.name ?? null,
    },
    scores: { sub: `mean share of checks passed, ${plural(ready.length, 'task')}`, empty: ready.length && cards.length ? null : 'No scores yet.', cards, rows },
    serve,
    exportDialog: {
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
    scoreDialog,
  };
}
