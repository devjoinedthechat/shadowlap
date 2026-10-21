import { commandIsImported, importedCommandSource, isReservedScope, judgedOutcome, quoteArgv, retirementOf, retirementTable, type DecisionRun, type DecisionStep, type RetirementNotice, type Store } from '@shadowlap/engine';
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

/**
 * One model call in a run's row of the matrix: its rank (the most consequential change any sample
 * showed; 0 the same, null not asked), the rank most of its samples show (`majority`, which flags
 * the run), how often it changed, for a cell drawn split, and how the judge checks that read a
 * text-only change came out (`judge`).
 */
export interface DecisionCell {
  callNo: number;
  step: number;
  rank: number | null;
  majority: number | null;
  changed: number;
  answered: number;
  /**
   * For a text-only change a judge check reads (judgedOutcome): `inconclusive` when the step waits on
   * a judge (the words of a sample could not be judged, and its samples don't flag it without them),
   * else `changed` when a check comes out otherwise for the new words (the cell ranks 2), `unchanged`
   * when every one came out as recorded; null when no check read it.
   */
  judge: 'changed' | 'inconclusive' | 'unchanged' | null;
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
    .map((s: DecisionStep): DecisionCell => ({ callNo: s.callNo, step: s.step, rank: s.rank ?? (s.samples.answered ? 0 : null), majority: s.majority ?? (s.samples.answered === 1 ? s.rank : null) ?? (s.samples.answered ? 0 : null), changed: s.samples.changed, answered: s.samples.answered, judge: judgedOutcome(s) }));
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
      // Shadowlap's own calls (its judge's) are no model the agent uses.
      if (c.kind !== 'api' || isReservedScope(c.meta.scope)) continue;
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
  return { version: retirementTable().version, notices: [...byModel.values()].sort((a, b) => order(a) - order(b) || b.goldens.length - a.goldens.length) };
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

/** `--from` flags from the request's `from`: the recorded models a switch changes. */
function fromArgs(raw: unknown): string[] | { error: string } {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 20 || raw.some((m) => typeof m !== 'string' || !MODEL.test(m))) return { error: 'from is a list of the recorded models to switch from, such as ["claude-sonnet-4-5-20250929"]' };
  return (raw as string[]).flatMap((m) => ['--from', m]);
}

/** `--scope` from the request's `scope`: a scope's name, or `none` for the calls made in none. */
function scopeArgs(raw: unknown): string[] | { error: string } {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== 'string' || !/^[\w.:/-]{1,100}$/.test(raw) || isReservedScope(raw)) return { error: 'scope is the name of a scope the agent made calls in, or none' };
  return ['--scope', raw];
}

/** `shadowlap decisions` as a job: `{ runs?, goldens?, model?, set?, from?, scope?, fromCode?, samples?, thenVerify?, yes? }`. */
export function decisionsJob(req: JobRequest, store: Store, goldens: readonly GoldenSource[]): JobBuildResult {
  const targets = targetArgs(store, req, goldens);
  if ('error' in targets) return targets;
  if (req.model !== undefined && (typeof req.model !== 'string' || !MODEL.test(req.model))) return { error: 'model is a model name, such as claude-sonnet-5-5' };
  const set = setArgs(req.set);
  if ('error' in set) return set;
  const from = fromArgs(req.from);
  if ('error' in from) return from;
  const scope = scopeArgs(req.scope);
  if ('error' in scope) return scope;
  const fromCode = req.fromCode === true;
  if (!req.model && !set.length && !fromCode) return { error: 'give the change: a model, fields to set, or fromCode for the prompt and tools in the working tree' };
  if (from.length && !req.model && !set.length) return { error: 'from names the model calls a model or fields change: give one of them' };
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
  const args = ['decisions', ...targets.args, ...(typeof req.model === 'string' ? ['--model', req.model] : []), ...set, ...from, ...scope, ...(fromCode ? ['--from-code'] : []), ...samples, ...(req.thenVerify === true ? ['--then-verify'] : []), ...(runsAgent && req.yes === true ? ['--yes'] : [])];
  const what = fromCode ? 'the prompt in your working tree' : typeof req.model === 'string' ? req.model : 'the fields set';
  return { args, title: `Previewing ${what}`, ...(targets.runIds.length === 1 ? { runId: targets.runIds[0]! } : {}) };
}

/** `shadowlap migrate` as a job: `{ to, goldens?, runs?, from?, scope?, set?, yes? }`; every golden when none are named. */
export function migrateJob(req: JobRequest, store: Store, goldens: readonly GoldenSource[]): JobBuildResult {
  if (typeof req.to !== 'string' || !MODEL.test(req.to)) return { error: 'to is the model to switch to, such as claude-sonnet-5-5' };
  const named = req.goldens !== undefined || req.runs !== undefined;
  const targets = named ? targetArgs(store, req, goldens) : targetArgs(store, { goldens: 'all' }, goldens);
  if ('error' in targets) return named ? targets : { error: 'the project has no goldens to migrate: keep a run as a golden first', status: 409 };
  const set = setArgs(req.set);
  if ('error' in set) return set;
  const from = fromArgs(req.from);
  if ('error' in from) return from;
  const scope = scopeArgs(req.scope);
  if ('error' in scope) return scope;
  const consent = importedConsent(store, targets.byId, req.yes);
  if (consent) return consent;
  return { args: ['migrate', '--to', req.to, ...targets.args, ...from, ...scope, ...set, ...(req.yes === true ? ['--yes'] : [])], title: `Migrating to ${req.to}` };
}

/**
 * Verify the runs a session flagged, the page's primary action: `shadowlap decisions --verify
 * <session>` (with the one `runId` names), which verifies each run under its own checks (its
 * golden's, or for a run named by id those of the recording it comes from), one verify per set of
 * checks, in the role its recording plays under them, with the session's change, and keeps what it
 * finds in the session.
 */
export function verifyFlaggedJob(req: JobRequest, store: Store): JobBuildResult {
  if (typeof req.sessionId !== 'string') return { error: 'sessionId is required' };
  const session = decisionSession(store, req.sessionId);
  if (!session) return { error: `no session ${req.sessionId.slice(0, 40)}`, status: 404 };
  const report = (session.kind === 'migrate' ? session.decisions : session) as { flagged?: unknown };
  let flagged = (Array.isArray(report.flagged) ? report.flagged : []).filter((id): id is string => typeof id === 'string');
  if (req.runId !== undefined) {
    flagged = flagged.filter((id) => id === req.runId || (typeof req.runId === 'string' && req.runId.length >= 6 && id.startsWith(req.runId)));
    if (!flagged.length) return { error: 'that run has no write, stop or judged change in this session', status: 404 };
  }
  if (!flagged.length) return { error: 'no run in this session has a write, stop or judged change: there is nothing to verify', status: 409 };
  const runs = flagged.map((id) => store.getRun(id)).filter((r): r is NonNullable<typeof r> => r !== null);
  if (runs.length < flagged.length) return { error: 'a run this session flagged is no longer in the store', status: 409 };
  // A run from the store whose command came from someone's pack runs only with a yes; a golden runs its pack's command, as test runs it.
  const goldenRuns = new Set(session.matrix.filter((row) => row.golden).map((row) => row.runId));
  const consent = importedConsent(store, flagged.filter((id) => !goldenRuns.has(id)), req.yes);
  if (consent) return consent;
  const args = ['decisions', '--verify', req.sessionId, ...(req.runId !== undefined ? [flagged[0]!] : []), ...(req.yes === true ? ['--yes'] : [])];
  return { args, title: `Verifying ${runs.length} run${runs.length === 1 ? '' : 's'} with a write, stop or judged change`, ...(runs.length === 1 ? { runId: runs[0]!.runId } : {}) };
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
