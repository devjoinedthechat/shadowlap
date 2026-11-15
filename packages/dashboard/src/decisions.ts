import { ACTIONS, commandIsImported, type DecisionRun, fieldValue, GATE_MAX_ATTEMPTS, SPRT_DEFAULTS, type SprtGate, goldensNeedingConsent, importedCommandSource, isReservedScope, MIGRATE_ID, migrateApplyProblem, type JobConsent, jobConsent, quoteArgv, retirementTable, type Store, type StoreOf, tallyCount, tallyWords } from '@shadowlap/engine';
import { decisionRow, LATER_STEPS, verifiedOutcome, viewSteps, type DecisionRow, type ViewStep } from './decision-cells.js';
import { lookupRun } from './api.js';
import { sprtGate } from './fix-shared.js';
import { moreFlags, moreOf, type PreviewMore } from './decision-more.js';
import { BUDGET_MAX, decisionsArgv, FIELD_NAME, migrateArgv, MODEL_NAME, PREVIEW_MAX, tooManyToPreview } from './decisions-argv.js';
import type { JobBuildResult, JobRequest } from './jobs.js';
import { links } from './links.js';
import { appliedState, applyInputOf, type AppliedState } from './migrate-applied.js';
import { type RetiringModel, retiringModels } from './retirements.js';
import { optionLike, type GoldenSource } from './tests.js';
import { sessionFacts } from './verdicts.js';

export { decisionRow, type DecisionCell, type DecisionRow, type RowEnding, type ViewStep } from './decision-cells.js';

/**
 * The decision diff as the dashboard reads it (`shadowlap decisions`, `migrate`): the sessions the
 * store keeps, one session whole (the report `--json` prints, its runs from their own rows), a run's
 * decisions for its page, the models the goldens use that retire, and the jobs that ask again,
 * migrate and verify what a session flagged. Plain functions of the store, for the Changes page.
 */

/**
 * A session in the list: what changed, over how many runs, how many flagged, and where to open it (its
 * page under Changes); its name (`decisionsName`), how many of its runs came from a golden and whether
 * to call them goldens (every one did) or runs, and its samples a step. `actor` is who ran it, which a
 * page shows only where checks are shared.
 */
export interface DecisionSessionView {
  sessionId: string;
  kind: 'decisions' | 'migrate';
  at: number;
  change: string;
  name: string;
  runs: number;
  goldens: number;
  unit: 'golden' | 'run';
  samples: number | null;
  flagged: number;
  /** Who ran it, only where names show (a team store); null otherwise. */
  actor: string | null;
  revision: string | null;
  href: string;
}

export interface DecisionsListView {
  sessions: DecisionSessionView[];
  /** The project's goldens: with none, a page waits for one before it offers a preview on every golden. */
  goldens: number;
  /** Older sessions are kept than the list holds: it stopped at its limit. */
  more: boolean;
}

export interface RetirementsView {
  /** The day the providers' pages were read: the table holds what they said then. */
  version: string;
  notices: RetiringModel[];
}

/** A row's most consequential call, the one its links open: its lowest rank, the first such call; null when none changed. */
export function telling(row: Pick<DecisionRow, 'cells'>): number | null {
  const ranked = row.cells.filter((c) => typeof c.rank === 'number' && c.rank > 0).sort((a, b) => a.rank! - b.rank! || a.callNo - b.callNo)[0];
  return ranked?.callNo ?? null;
}

/**
 * The sessions the store keeps, newest first, each opening at its own page under Changes (a
 * preview's tab, a migration's). `shared`: names show (a team store), so each says who ran it.
 */
export function decisionSessions(store: StoreOf<'decisions'> & Store, o: { limit?: number; kind?: 'decisions' | 'migrate'; shared?: boolean } = {}): DecisionSessionView[] {
  const { shared = false, ...which } = o;
  const rows = store.listDecisionSessions(which);
  const facts = sessionFacts(store, rows.map((s) => s.sessionId));
  // A migration's applied state names who applied it: its page reads it from the session, which names them only where shared.
  return rows.map(({ applied, ...s }) => {
    const f = facts.get(s.sessionId);
    return { ...s, actor: shared ? s.actor : null, name: f?.name ?? s.change, goldens: f?.goldens ?? 0, unit: f?.unit ?? 'run', samples: f?.samples ?? null, href: links.changeSession(s.kind, s.sessionId) };
  });
}

/**
 * One session whole: a decisions session is the report `decisions --json` printed, a migrate one the
 * report `migrate --json` printed, its decisions' runs filled in from their rows; with the matrix
 * the page draws (one row per run, one cell per model call), and a migration's applied state (who
 * applied it only where `shared`). Null for an id the store doesn't have.
 */
export function decisionSession(store: StoreOf<'decisions' | 'tests'>, sessionId: string, o: { shared?: boolean } = {}): (Record<string, unknown> & { kind: 'decisions' | 'migrate'; matrix: DecisionRow[]; applied?: AppliedState | null }) | null {
  if (!/^(dc|mg)-[0-9A-Z]{26}$/.test(sessionId)) return null;
  const s = store.getDecisionSession(sessionId);
  if (!s) return null;
  const runs = s.runRows.map((r) => r.data as unknown as DecisionRun);
  if (s.kind === 'migrate') {
    const decisions = { ...((s.data.decisions as Record<string, unknown> | undefined) ?? {}), runs };
    return { ...s.data, kind: 'migrate', decisions, matrix: runs.map((r) => decisionRow(r)), applied: appliedState(store, s.applied, o) };
  }
  const fromCode = !!(s.data.change as { fromCode?: unknown } | undefined)?.fromCode;
  return { ...s.data, kind: 'decisions', runs, matrix: runs.map((r) => decisionRow(r, { fromCode })) };
}

/** A run's part of one session, for its Decisions view. */
export interface RunDecisionsSession {
  sessionId: string;
  kind: 'decisions' | 'migrate';
  at: number;
  change: string;
  name: string;
  samples: number | null;
  /** The rank most of its samples show at the run's most consequential step, and how many of its steps changed: the view's head says them. */
  rank: number | null;
  changed: number;
  /** Its cell on Changes, at the run's most consequential call. */
  changes: string;
  row: DecisionRow;
  /** The steps its view lists, ranked first, each worded (`viewSteps`). */
  steps: ViewStep[];
  run: DecisionRun;
  /** Whether the session left it to verify (`toVerify`; a session kept before it said which, the flagged). */
  toVerify: boolean;
  /** What verify found of it: its outcome, its tally and bound (` · 4 of 4 · rate >= 0.6 (95%)`), the tally alone (`4 of 4`), and the rule it was decided by. Null until verify took it. */
  verified: { outcome: string; tally: string; count: string; rule: string | null } | null;
  /** Run more attempts, or Verify again, on it alone where verify left it open (`moreOf`); null for a migration, which Changes never verifies from here. */
  more: PreviewMore | null;
}

/** A run's decisions under each session that asked its model calls again, newest first, for its page's Decisions view; with the line about later steps where one did. */
export function runDecisions(store: StoreOf<'decisions'> & Store, runId: string, limit = 10, keptMax: number | null = null): { runId: string; sessions: RunDecisionsSession[]; later: typeof LATER_STEPS | null } {
  const rows = store.decisionsOfRun(runId, limit);
  const facts = sessionFacts(store, rows.map((r) => r.sessionId));
  return {
    runId,
    later: rows.length ? LATER_STEPS : null,
    sessions: rows.map((r) => {
      const run = r.data as unknown as DecisionRun;
      const f = facts.get(r.sessionId);
      const row = decisionRow(run);
      const call = telling(row);
      const v = f?.verify && f.verify.verdict !== 'not-run' ? f.verify : null;
      const entry = v?.runs.find((x) => x.runId === runId) ?? null;
      return {
        sessionId: r.sessionId,
        kind: r.kind,
        at: r.at,
        change: r.change,
        name: f?.name ?? r.change,
        samples: f?.samples ?? null,
        rank: r.rank,
        changed: r.changed,
        changes: links.changeSession(r.kind, r.sessionId, runId, call),
        row,
        steps: viewSteps(run),
        run,
        toVerify: !!f?.toVerify.includes(runId),
        verified: entry ? { outcome: verifiedOutcome(entry.outcome), tally: tallyWords(entry), count: tallyCount(entry), rule: entry.rule ?? v?.rule ?? null } : null,
        more: r.kind === 'decisions' && entry && v ? moreOf(v, verdictsGate(store, v.verifyIds), verdictsKeptMax(store, v.verifyIds) ?? keptMax, runId) : null,
      };
    }),
  };
}

/**
 * The models the project's goldens are recorded on that retire, by the table that ships with
 * shadowlap: each with the goldens that use it, the soonest first. A golden not in the store yet
 * (never tested here) can't be read, and is left out.
 */
export function retirementsView(store: StoreOf<'recording'>, goldens: readonly GoldenSource[], now = Date.now()): RetirementsView {
  return { version: retirementTable().version, notices: retiringModels(store, goldens, now) };
}

// ---- jobs ----

const MODEL = MODEL_NAME;
const FIELD = FIELD_NAME;

/** The request's fields to set, checked: each a field name and its value as `--set` gives it (`fieldValue`), which JSON can carry. */
function setArgs(raw: unknown): Array<[string, string]> | { error: string } {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'set must map request fields to values, such as {"temperature":0}' };
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!FIELD.test(k) || k === 'model') return { error: `${k.slice(0, 40)} is not a request field to set${k === 'model' ? ': give the model as model' : ''}` };
    const text = fieldValue(v);
    if (text === undefined || text.length > 2000) return { error: `the value for ${k} is too long, or not JSON` };
    out.push([k, text]);
  }
  return out;
}

/** The runs and goldens a request names: run ids from the store, goldens from the project's list. */
function targetArgs(store: StoreOf<'recording'>, req: JobRequest, goldens: readonly GoldenSource[]): { args: string[]; runIds: string[]; byId: string[]; packs: string[] } | { error: string; status?: number } {
  const args: string[] = [];
  const runIds: string[] = [];
  // Runs named by id, and goldens by their pack folder: each asks for a yes as a test asks of it.
  const byId: string[] = [];
  const packs: string[] = [];
  if (req.runs !== undefined) {
    if (!Array.isArray(req.runs)) return { error: 'runs must be a list of run ids' };
    const many = tooManyToPreview(req.runs.length);
    if (many) return { error: many };
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
    if (!Array.isArray(names) || names.length > PREVIEW_MAX) return { error: 'goldens must be a list of the project\'s goldens, or "all"' };
    for (const name of names) {
      const g = typeof name === 'string' ? known.get(name) : undefined;
      if (!g) return { error: `${String(name).slice(0, 80)} is not one of the project's goldens`, status: 404 };
      // A path that starts with "-" would be read as one of the CLI's options, never as a golden.
      if (optionLike(g.path)) return { error: `${g.path.slice(0, 80)}: its path starts with "-", which the CLI would read as an option: rename it under "tests" in shadowlap.config.json` };
      args.push(g.path);
      packs.push(g.path);
      if (g.runId) runIds.push(g.runId);
    }
  }
  if (!args.length) return { error: 'name the runs or goldens to ask again: runs, goldens, or goldens "all"' };
  return { args, runIds, byId, packs };
}

/** The request's `from`, checked: the recorded models a switch changes. */
function fromArgs(raw: unknown): string[] | { error: string } {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 20 || raw.some((m) => typeof m !== 'string' || !MODEL.test(m))) return { error: 'from is a list of the recorded models to switch from, such as ["claude-sonnet-4-5-20250929"]' };
  return raw as string[];
}

/** The request's `scope`, checked: a scope's name, or `none` for the calls made in none. */
export function scopeArgs(raw: unknown): { scope: string | null } | { error: string } {
  if (raw === undefined || raw === null) return { scope: null };
  if (typeof raw !== 'string' || !/^[\w.:/-]{1,100}$/.test(raw) || isReservedScope(raw)) return { error: 'scope is the name of a scope the agent made calls in, or none' };
  return { scope: raw };
}

/** The request's `budget`, checked: Stop at $, an amount in USD above 0 to the cent, as Run injection test's is. */
export function budgetArg(raw: unknown): { budget: number | null } | { error: string } {
  if (raw === undefined || raw === null) return { budget: null };
  const cents = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw * 100) : 0;
  if (cents <= 0 || cents > BUDGET_MAX * 100) return { error: 'budget is an amount in USD above 0, such as 25.00' };
  return { budget: cents / 100 };
}

/** A preview's request, checked as its job and its estimate (`GET /api/decisions/estimates`) take it: its targets as the job resolves them, and its change. */
export interface PreviewRequest {
  targets: { args: string[]; runIds: string[]; byId: string[]; packs: string[] };
  model: string | null;
  set: Array<[string, string]>;
  from: string[];
  scope: string | null;
  fromCode: boolean;
  samples: number | null;
  /** Stop at $, or null for none. */
  budget: number | null;
  /** Then verify the runs it can't clear, live. */
  thenVerify: boolean;
}

/** `{ runs?, goldens?, model?, set?, from?, scope?, fromCode?, samples?, budget?, thenVerify? }` checked, a change or none. */
export function previewRequest(req: JobRequest, store: StoreOf<'recording'>, goldens: readonly GoldenSource[]): PreviewRequest | { error: string; status?: number } {
  const targets = targetArgs(store, req, goldens);
  if ('error' in targets) return targets;
  if (req.model !== undefined && (typeof req.model !== 'string' || !MODEL.test(req.model))) return { error: 'model is a model name, such as claude-sonnet-5-5' };
  const set = setArgs(req.set);
  if ('error' in set) return set;
  const from = fromArgs(req.from);
  if ('error' in from) return from;
  const scope = scopeArgs(req.scope);
  if ('error' in scope) return scope;
  if (req.samples !== undefined && (typeof req.samples !== 'number' || !Number.isInteger(req.samples) || req.samples < 1 || req.samples > 20)) return { error: 'samples is a whole number from 1 to 20' };
  const budget = budgetArg(req.budget);
  if ('error' in budget) return budget;
  return { targets, model: typeof req.model === 'string' ? req.model : null, set, from, scope: scope.scope, fromCode: req.fromCode === true, samples: typeof req.samples === 'number' ? req.samples : null, budget: budget.budget, thenVerify: req.thenVerify === true };
}

/**
 * `shadowlap decisions` as a job: `{ runs?, goldens?, model?, set?, from?, scope?, fromCode?, samples?,
 * thenVerify?, budget?, yes? }`. Without `samples`, each step is asked as the CLI asks it by default: 3
 * times under the change and 3 times as recorded, the control, six requests a step. `samples` given
 * is passed on whatever it is, 1 too, which asks once and has no control. `budget` is Stop at $.
 */
export function decisionsJob(req: JobRequest, store: StoreOf<'recording'>, goldens: readonly GoldenSource[], projectDir: string = process.cwd()): JobBuildResult {
  const p = previewRequest(req, store, goldens);
  if ('error' in p) return p;
  if (!p.model && !p.set.length && !p.fromCode) return { error: 'give the change: a model, fields to set, or fromCode for the prompt and tools in the working tree' };
  if (p.from.length && !p.model && !p.set.length) return { error: 'from names the model calls a model or fields change: give one of them' };
  const runsAgent = p.fromCode || p.thenVerify;
  let yes: string[] = [];
  if (runsAgent) {
    const consent = commandConsent(store, p.targets.byId, p.targets.packs, projectDir, req.yes);
    if ('ask' in consent) return consent.ask;
    yes = consent.yes;
  }
  const args = [...decisionsArgv({ targets: p.targets.args, model: p.model, set: p.set, from: p.from, scope: p.scope, fromCode: p.fromCode, samples: p.samples, thenVerify: p.thenVerify, budget: p.budget }), ...yes];
  const title = p.fromCode ? ACTIONS.previewChangedPrompt.doing : p.model ? ACTIONS.previewModelSwitch.doing : ACTIONS.previewFieldChange.doing;
  return { args, title, ...(p.targets.runIds.length === 1 ? { runId: p.targets.runIds[0]! } : {}) };
}

/** The drawer's row for a read of what the working tree sends, as the CLI's own line begins. */
export const READING_TREE = 'Reading what your working tree sends';

/**
 * What `--from-code` reads, as a job: `shadowlap decisions <targets> --from-code --dry-run`, `{ runs?,
 * goldens?, scope?, yes? }`. Each run is replayed offline from the working tree with nothing sent, so
 * it holds the tree as a reader (worktree.ts) and asks the consent a sent golden's command needs; its
 * answer is the job's `result` (the CLI's `decisions-read`), which Preview changed prompt reads.
 */
export function decisionsReadJob(req: JobRequest, store: StoreOf<'recording'>, goldens: readonly GoldenSource[], projectDir: string = process.cwd()): JobBuildResult {
  const targets = targetArgs(store, req, goldens);
  if ('error' in targets) return targets;
  const scope = scopeArgs(req.scope);
  if ('error' in scope) return scope;
  const consent = commandConsent(store, targets.byId, targets.packs, projectDir, req.yes);
  if ('ask' in consent) return consent.ask;
  const args = [...decisionsArgv({ targets: targets.args, scope: scope.scope, fromCode: true }), '--dry-run', ...consent.yes];
  return { args, title: READING_TREE, ...(targets.runIds.length === 1 ? { runId: targets.runIds[0]! } : {}) };
}

/** `shadowlap migrate` as a job: `{ to, goldens?, runs?, from?, scope?, set?, budget?, yes? }`; every golden when none are named. `budget` is Stop at $. */
export function migrateJob(req: JobRequest, store: StoreOf<'recording'>, goldens: readonly GoldenSource[], projectDir: string = process.cwd()): JobBuildResult {
  if (typeof req.to !== 'string' || !MODEL.test(req.to)) return { error: 'to is the model to switch to, such as claude-sonnet-5-5' };
  const named = req.goldens !== undefined || req.runs !== undefined;
  const targets = named ? targetArgs(store, req, goldens) : targetArgs(store, { goldens: 'all' }, goldens);
  if ('error' in targets) return named ? targets : { error: 'the project has no goldens to migrate: pack a run as a golden first', status: 409 };
  const set = setArgs(req.set);
  if ('error' in set) return set;
  const from = fromArgs(req.from);
  if ('error' in from) return from;
  const scope = scopeArgs(req.scope);
  if ('error' in scope) return scope;
  const budget = budgetArg(req.budget);
  if ('error' in budget) return budget;
  const consent = commandConsent(store, targets.byId, targets.packs, projectDir, req.yes);
  if ('ask' in consent) return consent.ask;
  return { args: [...migrateArgv({ to: req.to, targets: targets.args, from, scope: scope.scope, set, budget: budget.budget }), ...consent.yes], title: `Migrating to ${req.to}` };
}

/**
 * `shadowlap migrate apply <id>` as a job: `{ migrationId }`, a kept migration whose config change can
 * be applied (migrateApplyProblem, the CLI's own refusal, answers 409 otherwise). No consent is
 * asked: its offline replay skips a golden from a pack the repository doesn't track.
 */
export function migrateApplyJob(req: JobRequest, store: StoreOf<'decisions' | 'tests'>): JobBuildResult {
  if (typeof req.migrationId !== 'string' || !MIGRATE_ID.test(req.migrationId)) return { error: 'migrationId is a migration’s id: mg- and 26 letters and digits' };
  const session = decisionSession(store, req.migrationId);
  if (!session || session.kind !== 'migrate') return { error: `no migration ${req.migrationId}`, status: 404 };
  const problem = migrateApplyProblem(applyInputOf({ ...session, sessionId: req.migrationId }));
  if (problem) return { error: problem, status: 409 };
  return { args: ['migrate', 'apply', req.migrationId], title: ACTIONS.applyConfigChange.doing };
}

/** A session's report: a decisions session's own, a migration's decisions. */
export const sessionReport = (session: NonNullable<ReturnType<typeof decisionSession>>) => (session.kind === 'migrate' ? session.decisions : session) as { flagged?: unknown; toVerify?: unknown; runs?: DecisionRun[]; change?: { fromCode?: unknown } };

/** The run of `among` that `w` names, by its id or a prefix of 6 or more. */
const namedRun = (among: readonly string[], w: unknown): string | undefined => among.find((id) => id === w || (typeof w === 'string' && w.length >= 6 && id.startsWith(w)));

/**
 * The runs a session's Verify takes, as `decisions --verify <session> [run…]` picks them: those it
 * could not clear (`toVerify`; a session kept before it said which, the ones it flagged), or those
 * `named` names among them (a run id, or a list of them; an empty list names none), each by its id or
 * a prefix of 6 or more. Why there are none, when none, naming each run named that it cleared or never asked.
 */
export function runsToVerify(session: NonNullable<ReturnType<typeof decisionSession>>, named?: unknown): string[] | { error: string; status: number } {
  const report = sessionReport(session);
  const listed = Array.isArray(report.toVerify) ? report.toVerify : report.flagged;
  const ids = (Array.isArray(listed) ? listed : []).filter((id): id is string => typeof id === 'string');
  const wanted: unknown[] = named === undefined ? [] : Array.isArray(named) ? named : [named];
  if (!wanted.length) return ids.length ? ids : { error: 'this session cleared every run: there is nothing to verify', status: 409 };
  const missing = wanted.filter((w) => !namedRun(ids, w));
  const asked = session.matrix.map((row) => row.runId);
  const shown = (ws: unknown[]) => ws.map((w) => String(w).slice(0, 40)).join(', ');
  const strangers = missing.filter((w) => !namedRun(asked, w));
  if (strangers.length) return { error: `this session asked no run ${shown(strangers)}`, status: 404 };
  if (missing.length) return { error: `this session cleared ${shown(missing)}: ${missing.length === 1 ? 'it has' : 'they have'} nothing to verify`, status: 409 };
  return [...new Set(wanted.map((w) => namedRun(ids, w)!))];
}

/**
 * Verify the runs a session could not clear, the page's primary action: `shadowlap decisions --verify
 * <session>` (with the one `runId` names, or those `runIds` name, the runs no verify took yet), which verifies each run under its own checks (its
 * golden's, or for a run named by id those of the recording it comes from), one verify per set of
 * checks, in the role its recording plays under them, with the session's change, and keeps what it
 * finds in the session.
 */
export function verifyFlaggedJob(req: JobRequest, store: StoreOf<'recording' | 'decisions' | 'fixes' | 'tests'>, projectDir: string = process.cwd()): JobBuildResult {
  if (typeof req.sessionId !== 'string') return { error: 'sessionId is required' };
  const session = decisionSession(store, req.sessionId);
  if (!session) return { error: `no session ${req.sessionId.slice(0, 40)}`, status: 404 };
  if (req.runIds !== undefined && (!Array.isArray(req.runIds) || req.runIds.length > 500)) return { error: 'runIds is a list of the runs to verify' };
  // Refused before any consent is asked: a yes to a command that is then refused asks for nothing.
  const refused = limitsRefused(req.max, req.keptMax);
  if (refused) return { error: refused };
  // A list naming none names none, as the estimate takes it: every run left to verify.
  const named = Array.isArray(req.runIds) && req.runIds.length ? req.runIds : req.runId;
  const flagged = runsToVerify(session, named);
  if (!Array.isArray(flagged)) return flagged;
  const runs = flagged.map((id) => store.getRun(id)).filter((r): r is NonNullable<typeof r> => r !== null);
  if (runs.length < flagged.length) return { error: 'a run this session flagged is no longer in the store', status: 409 };
  // A run from the store whose command came from someone's pack runs only with a yes, and so does a
  // golden's, run from its pack, whose pack the repository doesn't track, as test asks of one.
  const goldenOf = new Map(session.matrix.filter((row) => row.golden).map((row) => [row.runId, row.golden!] as const));
  const consent = commandConsent(
    store,
    flagged.filter((id) => !goldenOf.has(id)),
    [...new Set(flagged.flatMap((id) => (goldenOf.has(id) ? [goldenOf.get(id)!] : [])))],
    projectDir,
    req.yes,
  );
  if ('ask' in consent) return consent.ask;
  // The gate's other figures kept as they were, with a good run's pairs raised alone too.
  const limits = moreFlags(sessionGate(store, session), req.max as number | undefined, req.keptMax as number | undefined);
  const args = ['decisions', '--verify', req.sessionId, ...(named !== undefined ? flagged : []), ...limits, ...consent.yes];
  const title = limits.length ? ACTIONS.runMoreAttempts.doing : runs.length === 1 ? `Verifying ${runs[0]!.runId.slice(0, 10)}` : `Verifying ${runs.length} runs`;
  return { args, title, ...(runs.length === 1 ? { runId: runs[0]!.runId } : {}) };
}

/**
 * The gate a session's verify was decided by: that of the newest verdict it kept that the store
 * still has, null for one decided by a fixed count (`--attempts`, from the CLI), and verify's own
 * when none is left.
 */
export function sessionGate(store: StoreOf<'fixes'>, session: NonNullable<ReturnType<typeof decisionSession>>): SprtGate | null {
  return verdictsGate(store, sessionVerifyIds(session));
}

/** The pairs a good run of a session's verify ran under, as `sessionGate` reads its gate (`verdictsKeptMax`). */
export function sessionKeptMax(store: StoreOf<'fixes'>, session: NonNullable<ReturnType<typeof decisionSession>>): number | null {
  return verdictsKeptMax(store, sessionVerifyIds(session));
}

/** The verdicts a session's verify kept, oldest first. */
function sessionVerifyIds(session: NonNullable<ReturnType<typeof decisionSession>>): unknown[] {
  const verify = (sessionReport(session) as { verify?: { verifyIds?: unknown } | null }).verify;
  return Array.isArray(verify?.verifyIds) ? (verify.verifyIds as unknown[]) : [];
}

/** The newest verdict of `ids` still in the store. */
function newestVerdict(store: StoreOf<'fixes'>, ids: readonly unknown[]) {
  for (const id of [...ids].reverse()) {
    const kept = typeof id === 'string' ? store.getVerdict(id) : null;
    if (kept) return kept;
  }
  return null;
}

/** The gate of the newest verdict of `ids` still in the store, as `sessionGate` reads a session's: null for a fixed count, the defaults when none is left. */
function verdictsGate(store: StoreOf<'fixes'>, ids: readonly unknown[]): SprtGate | null {
  const kept = newestVerdict(store, ids);
  return kept ? sprtGate(kept.report.gate) : { kind: 'sprt', ...SPRT_DEFAULTS };
}

/**
 * The pairs a good run of the newest verdict of `ids` ran under (its report's `kept.max`, which a
 * `--kept-max` or a gate's max set), null where none says: Run more attempts starts a good run's
 * limit from it before the config's, so a second round never cuts a good run below the first's.
 */
function verdictsKeptMax(store: StoreOf<'fixes'>, ids: readonly unknown[]): number | null {
  const max = newestVerdict(store, ids)?.report.kept?.max;
  return typeof max === 'number' ? max : null;
}

/** Why Run more attempts' `max` or `keptMax` can't be taken, as its job and its estimate refuse it; null for whole numbers up to 1000, or none. */
export function limitsRefused(max: unknown, keptMax: unknown): string | null {
  const whole = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= GATE_MAX_ATTEMPTS);
  if (!whole(max)) return `max is the most attempts a run takes, a whole number up to ${GATE_MAX_ATTEMPTS}`;
  return whole(keptMax) ? null : `keptMax is the most pairs a good run takes, a whole number up to ${GATE_MAX_ATTEMPTS}`;
}

/** The command a job runs, as its dialog shows it. */
export const commandLine = (args: readonly string[]) => quoteArgv(['shadowlap', ...args]);

/**
 * The commands someone else chose that a job runs need a yes before it does, to the lines the
 * question showed (consent.ts): a run's whose command came from someone's pack or the team store,
 * and a golden's, from a pack (`packs`, relative to `projectDir`) the repository doesn't track and
 * this machine didn't record (goldensNeedingConsent), as `shadowlap test` asks of one. The CLI gets
 * `--yes` only once that question was asked and answered (JobConsent).
 */
function commandConsent(store: StoreOf<'recording'>, runIds: readonly string[], packs: readonly string[], projectDir: string, yes: unknown): JobConsent {
  const imported = runIds.map((id) => store.getRun(id)).filter((r): r is NonNullable<typeof r> => r !== null && commandIsImported(r));
  const sent = packs.length ? goldensNeedingConsent(store, packs, projectDir) : [];
  const named = [
    ...imported.map((r) => ({ what: `${r.runId.slice(0, 10)} came from ${importedCommandSource(r)}`, short: r.runId.slice(0, 10), argv: r.command.argv })),
    ...sent.map((g) => ({ what: `${g.dir} is from a pack this repository doesn't track`, short: g.dir, argv: g.argv })),
  ];
  return jobConsent(
    named.map((n) => n.argv),
    yes,
    () => {
      const [first, ...more] = named;
      const kind = sent.length && imported.length ? '' : ` ${sent.length ? 'golden' : 'run'}${more.length === 1 ? '' : 's'}`;
      return `${first!.what}: this runs the command it was recorded with (${quoteArgv(first!.argv)})${more.length ? `, and ${more.length} more${kind} like it: ${more.map((m) => `${m.short} (${quoteArgv(m.argv)})`).join(', ')}` : ''}. Confirm it to run it`;
    },
  );
}
