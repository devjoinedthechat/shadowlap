import { commandIsImported, importedCommandSource, quoteArgv, readConfigFile, retirementOf, RETIREMENTS_VERSION, testsEntryFor, type DecisionRun, type DecisionsReport, type DecisionStep, type RetirementNotice, type Store } from '@shadowlap/engine';
import { lookupRun } from './api.js';
import type { JobBuildResult, JobRequest } from './jobs.js';
import type { GoldenSource } from './tests.js';

/**
 * The decision diff as the dashboard reads it (`shadowlap decisions`, `migrate`): the sessions the
 * store keeps, one session whole (the report `--json` prints, its runs from their own rows), a run's
 * decisions for its page, the models the goldens use that retire, and the jobs that ask again,
 * migrate and verify what a session flagged. Plain functions of the store, for the Changes page.
 */

/** A session in the list: what changed, over how many runs, how many flagged, and where to open it. */
export interface DecisionSessionView {
  sessionId: string;
  kind: 'decisions' | 'migrate';
  at: number;
  change: string;
  runs: number;
  flagged: number;
  actor: string | null;
  revision: string | null;
  href: string;
}

/** One model call in a run's row of the matrix: its rank (0 the same, null not asked), and how often it changed. */
export interface DecisionCell {
  callNo: number;
  step: number;
  rank: number | null;
  changed: number;
  answered: number;
}

/** A run's row of the matrix, its cells in call order. */
export interface DecisionRow {
  runId: string;
  golden: string | null;
  /** How the row is titled: the golden's name, else the run's short id. */
  title: string;
  rank: number | null;
  cells: DecisionCell[];
}

export interface DecisionsListView {
  sessions: DecisionSessionView[];
  /** The models the project's goldens use that retire, for Needs a look. */
  retirements: RetirementsView;
}

export interface RetirementsView {
  /** The day the providers' pages were read: the table holds what they said then. */
  version: string;
  notices: Array<RetirementNotice & { goldens: string[] }>;
}

export const sessionHref = (kind: 'decisions' | 'migrate', id: string) => `#/changes/${kind}/${id}`;

export function decisionSessions(store: Store, o: { limit?: number; kind?: 'decisions' | 'migrate' } = {}): DecisionSessionView[] {
  return store.listDecisionSessions(o).map((s) => ({ ...s, href: sessionHref(s.kind, s.sessionId) }));
}

/** A run's row: its model calls in call order, each with its rank. */
export function decisionRow(run: DecisionRun): DecisionRow {
  const cells = [...run.decisions]
    .sort((a, b) => a.callNo - b.callNo)
    .map((s: DecisionStep): DecisionCell => ({ callNo: s.callNo, step: s.step, rank: s.rank ?? (s.samples.answered ? 0 : null), changed: s.samples.changed, answered: s.samples.answered }));
  return { runId: run.runId, golden: run.golden, title: run.golden ?? run.runId.slice(0, 10), rank: run.rank, cells };
}

/**
 * One session whole: a decisions session is the report `decisions --json` printed, a migrate one the
 * report `migrate --json` printed, its decisions' runs filled in from their rows; with the matrix
 * the page draws (one row per run, one cell per model call). Null for an id the store doesn't have.
 */
export function decisionSession(store: Store, sessionId: string): (Record<string, unknown> & { kind: 'decisions' | 'migrate'; matrix: DecisionRow[] }) | null {
  if (!/^(dc|mg)-[0-9A-Z]{26}$/.test(sessionId)) return null;
  const s = store.getDecisionSession(sessionId);
  if (!s) return null;
  const runs = s.runRows.map((r) => r.data as unknown as DecisionRun);
  const matrix = runs.map(decisionRow);
  if (s.kind === 'migrate') {
    const decisions = { ...((s.data.decisions as Record<string, unknown> | undefined) ?? {}), runs };
    return { ...s.data, kind: 'migrate', decisions, matrix };
  }
  return { ...s.data, kind: 'decisions', runs, matrix };
}

/** A run's decisions under each session that asked its model calls again, newest first, for its page's Decisions view. */
export function runDecisions(store: Store, runId: string, limit = 10): { runId: string; sessions: Array<{ sessionId: string; kind: 'decisions' | 'migrate'; at: number; change: string; rank: number | null; changed: number; href: string; row: DecisionRow; run: DecisionRun }> } {
  return {
    runId,
    sessions: store.decisionsOfRun(runId, limit).map((r) => {
      const run = r.data as unknown as DecisionRun;
      return { sessionId: r.sessionId, kind: r.kind, at: r.at, change: r.change, rank: r.rank, changed: r.changed, href: sessionHref(r.kind, r.sessionId), row: decisionRow(run), run };
    }),
  };
}

/**
 * The models the project's goldens are recorded on that retire, by the table that ships with
 * Shadowlap: each with the goldens that use it, the soonest first. A golden not in the store yet
 * (never tested here) can't be read, and is left out.
 */
export function retirementsView(store: Store, goldens: readonly GoldenSource[], now = Date.now()): RetirementsView {
  const byModel = new Map<string, RetirementNotice & { goldens: string[] }>();
  for (const g of goldens) {
    if (!g.runId || !store.getRun(g.runId)) continue;
    const seen = new Set<string>();
    for (const c of store.getCalls(g.runId)) {
      if (c.kind !== 'api') continue;
      const provider = (c.meta.provider ?? c.end?.meta.provider ?? null) as string | null;
      const model = (c.end?.meta.model ?? c.meta.model ?? null) as string | null;
      const key = `${provider}\u0000${model}`;
      if (!model || seen.has(key)) continue;
      seen.add(key);
      const notice = byModel.get(key) ?? (() => {
        const n = retirementOf(provider, model, { now });
        return n ? { ...n, goldens: [] as string[] } : null;
      })();
      if (!notice) continue;
      notice.goldens.push(g.path);
      byModel.set(key, notice);
    }
  }
  const order = (n: RetirementNotice) => (n.days === null ? Number.MAX_SAFE_INTEGER : n.days);
  return { version: RETIREMENTS_VERSION, notices: [...byModel.values()].sort((a, b) => order(a) - order(b) || b.goldens.length - a.goldens.length) };
}

// ---- jobs ----

const MODEL = /^[\w.:@/-]{1,200}$/;
const FIELD = /^[A-Za-z_][\w.]{0,99}$/;
const fieldValue = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

/** `--set` flags from the request's fields, checked: a field name, and a value JSON can carry. */
function setArgs(raw: unknown): string[] | { error: string } {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'set must map request fields to values, such as {"temperature":0}' };
  const out: string[] = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!FIELD.test(k) || k === 'model') return { error: `${k.slice(0, 40)} is not a request field to set${k === 'model' ? ': give the model as model' : ''}` };
    const text = fieldValue(v);
    if (text === undefined || text.length > 2000) return { error: `the value for ${k} is too long, or not JSON` };
    out.push('--set', `${k}=${text}`);
  }
  return out;
}

/** The runs and goldens a request names: run ids from the store, goldens from the project's list. */
function targetArgs(store: Store, req: JobRequest, goldens: readonly GoldenSource[]): { args: string[]; runIds: string[]; byId: string[] } | { error: string; status?: number } {
  const args: string[] = [];
  const runIds: string[] = [];
  // Runs named by id: a golden runs its pack's command as a test does, without asking.
  const byId: string[] = [];
  if (req.runs !== undefined) {
    if (!Array.isArray(req.runs) || req.runs.length > 500) return { error: 'runs must be a list of run ids' };
    for (const id of req.runs) {
      const run = typeof id === 'string' ? lookupRun(store, id) : null;
      if (!run) return { error: `no run ${String(id).slice(0, 40)}`, status: 404 };
      args.push(run.runId);
      runIds.push(run.runId);
      byId.push(run.runId);
    }
  }
  if (req.goldens !== undefined) {
    const known = new Map(goldens.map((g) => [g.path, g]));
    const names = req.goldens === 'all' ? [...known.keys()] : req.goldens;
    if (!Array.isArray(names) || names.length > 500) return { error: 'goldens must be a list of the project\'s goldens, or "all"' };
    for (const name of names) {
      const g = typeof name === 'string' ? known.get(name) : undefined;
      if (!g) return { error: `${String(name).slice(0, 80)} is not one of the project's goldens`, status: 404 };
      args.push(g.path);
      if (g.runId) runIds.push(g.runId);
    }
  }
  if (!args.length) return { error: 'name the runs or goldens to ask again: runs, goldens, or goldens "all"' };
  return { args, runIds, byId };
}

/** `shadowlap decisions` as a job: `{ runs?, goldens?, model?, set?, fromCode?, samples?, thenVerify?, yes? }`. */
export function decisionsJob(req: JobRequest, store: Store, goldens: readonly GoldenSource[]): JobBuildResult {
  const targets = targetArgs(store, req, goldens);
  if ('error' in targets) return targets;
  if (req.model !== undefined && (typeof req.model !== 'string' || !MODEL.test(req.model))) return { error: 'model is a model name, such as claude-sonnet-5-5' };
  const set = setArgs(req.set);
  if ('error' in set) return set;
  const fromCode = req.fromCode === true;
  if (!req.model && !set.length && !fromCode) return { error: 'give the change: a model, fields to set, or fromCode for the prompt and tools in the working tree' };
  let samples: string[] = [];
  if (req.samples !== undefined) {
    if (typeof req.samples !== 'number' || !Number.isInteger(req.samples) || req.samples < 1 || req.samples > 20) return { error: 'samples is a whole number from 1 to 20' };
    if (req.samples > 1) samples = ['--samples', String(req.samples)];
  }
  const runsAgent = fromCode || req.thenVerify === true;
  if (runsAgent) {
    const consent = importedConsent(store, targets.byId, req.yes);
    if (consent) return consent;
  }
  const args = ['decisions', ...targets.args, ...(typeof req.model === 'string' ? ['--model', req.model] : []), ...set, ...(fromCode ? ['--from-code'] : []), ...samples, ...(req.thenVerify === true ? ['--then-verify'] : []), ...(runsAgent && req.yes === true ? ['--yes'] : [])];
  const what = fromCode ? 'the prompt in your working tree' : typeof req.model === 'string' ? req.model : 'the fields set';
  return { args, title: `Previewing ${what}`, ...(targets.runIds.length === 1 ? { runId: targets.runIds[0]! } : {}) };
}

/** `shadowlap migrate` as a job: `{ to, goldens?, runs?, set?, yes? }`; every golden when none are named. */
export function migrateJob(req: JobRequest, store: Store, goldens: readonly GoldenSource[]): JobBuildResult {
  if (typeof req.to !== 'string' || !MODEL.test(req.to)) return { error: 'to is the model to switch to, such as claude-sonnet-5-5' };
  const named = req.goldens !== undefined || req.runs !== undefined;
  const targets = named ? targetArgs(store, req, goldens) : targetArgs(store, { goldens: 'all' }, goldens);
  if ('error' in targets) return named ? targets : { error: 'the project has no goldens to migrate: keep a run as a golden first', status: 409 };
  const set = setArgs(req.set);
  if ('error' in set) return set;
  const consent = importedConsent(store, targets.byId, req.yes);
  if (consent) return consent;
  return { args: ['migrate', '--to', req.to, ...targets.args, ...set, ...(req.yes === true ? ['--yes'] : [])], title: `Migrating to ${req.to}` };
}

/**
 * Verify the runs a session flagged, the page's primary action: `shadowlap verify` on its runs with a
 * rank 1 or 2 change (or the one `runId` names), under the session's change. A run that failed as
 * recorded must now pass (`--fixes`), one that passed must keep passing (`--keeps`), each by its
 * golden's checks from the config when the runs share them.
 */
export function verifyFlaggedJob(req: JobRequest, store: Store, configDir: string | null): JobBuildResult {
  if (typeof req.sessionId !== 'string') return { error: 'sessionId is required' };
  const session = decisionSession(store, req.sessionId);
  if (!session) return { error: `no session ${req.sessionId.slice(0, 40)}`, status: 404 };
  const report = (session.kind === 'migrate' ? session.decisions : session) as unknown as DecisionsReport;
  let flagged = report.runs.filter((r) => r.rank !== null && r.rank <= 2);
  if (req.runId !== undefined) {
    flagged = flagged.filter((r) => r.runId === req.runId || (typeof req.runId === 'string' && r.runId.startsWith(req.runId) && req.runId.length >= 6));
    if (!flagged.length) return { error: 'that run has no write or stop change in this session', status: 404 };
  }
  if (!flagged.length) return { error: 'no run in this session decides a write or when to stop differently: there is nothing to verify', status: 409 };
  const runs = flagged.map((r) => store.getRun(r.runId)).filter((r): r is NonNullable<typeof r> => r !== null);
  if (runs.length < flagged.length) return { error: 'a run this session flagged is no longer in the store', status: 409 };
  const consent = importedConsent(store, runs.filter((r) => !flagged.find((f) => f.runId === r.runId)?.golden).map((r) => r.runId), req.yes);
  if (consent) return consent;
  // The checks the goldens share, from the config, when they share one.
  let tests: unknown;
  try {
    tests = configDir ? (readConfigFile(configDir).data as { tests?: unknown }).tests : undefined;
  } catch {
    tests = undefined;
  }
  const entries = tests && typeof tests === 'object' ? Object.entries(tests as Record<string, { expect?: unknown }>).map(([recording, v]) => ({ recording, expect: v?.expect })) : [];
  const expects = new Set(flagged.map((r) => JSON.stringify((r.golden && configDir ? testsEntryFor(entries, r.golden, configDir)?.expect : undefined) ?? null)));
  const expect = expects.size === 1 ? (JSON.parse([...expects][0]!) as unknown) : null;
  const failing = runs.filter((r) => r.status === 'failed' || r.status === 'crashed').map((r) => r.runId.slice(0, 10));
  const passing = runs.filter((r) => r.status !== 'failed' && r.status !== 'crashed').map((r) => r.runId.slice(0, 10));
  const remedies = ((session.kind === 'migrate' ? (session.decisions as { remedies?: unknown }).remedies : (session as { remedies?: unknown }).remedies) ?? []) as Array<{ field: string; value: unknown; leftOut: boolean }>;
  const fields = { ...report.change.fields, ...Object.fromEntries(remedies.filter((x) => !x.leftOut).map((x) => [x.field, x.value])) };
  const args = [
    'verify',
    ...(failing.length ? ['--fixes', ...failing] : []),
    ...(passing.length ? ['--keeps', ...passing] : []),
    ...(expect !== null && expect !== undefined ? ['--expect', JSON.stringify(expect)] : []),
    ...(report.change.model ? ['--model', report.change.model] : []),
    ...Object.entries(fields).flatMap(([k, v]) => ['--set', `${k}=${fieldValue(v)}`]),
    ...(req.yes === true ? ['--yes'] : []),
  ];
  return { args, title: `Verifying ${runs.length} run${runs.length === 1 ? '' : 's'} with a write or stop change`, ...(runs.length === 1 ? { runId: runs[0]!.runId } : {}) };
}

/** The command a job runs, as its dialog shows it. */
export const commandLine = (args: readonly string[]) => quoteArgv(['shadowlap', ...args]);

/** A run whose command came from someone else's pack needs a yes before a job runs it. */
function importedConsent(store: Store, runIds: readonly string[], yes: unknown): JobBuildResult | null {
  if (yes === true) return null;
  for (const id of runIds) {
    const run = store.getRun(id);
    if (run && commandIsImported(run)) return { error: `${id.slice(0, 10)} came from ${importedCommandSource(run)}: this runs the command it was recorded with (${run.command.argv.join(' ')}). Confirm it to run it`, status: 409 };
  }
  return null;
}
