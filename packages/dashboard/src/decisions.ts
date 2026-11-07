import { commandIsImported, type DecisionRun, fieldValue, goldensNeedingConsent, importedCommandSource, isReservedScope, type JobConsent, jobConsent, quoteArgv, type RetirementNotice, retirementOf, retirementTable, runOutcomeWord, type Store, type StoreOf, tallyWords } from '@shadowlap/engine';
import { decisionRow, type DecisionRow } from './decision-cells.js';
import { lookupRun } from './api.js';
import type { JobBuildResult, JobRequest } from './jobs.js';
import { links } from './links.js';
import { optionLike, type GoldenSource } from './tests.js';
import { sessionFacts } from './verdicts.js';

export { decisionRow, type DecisionCell, type DecisionRow, type RowEnding } from './decision-cells.js';

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
  actor: string | null;
  revision: string | null;
  href: string;
}

export interface DecisionsListView {
  sessions: DecisionSessionView[];
  /** The project's goldens: with none, a page waits for one before it offers a preview on every golden. */
  goldens: number;
  /** The models the project's goldens use that retire, for Needs a look. */
  retirements: RetirementsView;
}

export interface RetirementsView {
  /** The day the providers' pages were read: the table holds what they said then. */
  version: string;
  notices: Array<RetirementNotice & { goldens: string[] }>;
}

/** A row's most consequential call, the one its links open: its lowest rank, the first such call; null when none changed. */
export function telling(row: Pick<DecisionRow, 'cells'>): number | null {
  const ranked = row.cells.filter((c) => typeof c.rank === 'number' && c.rank > 0).sort((a, b) => a.rank! - b.rank! || a.callNo - b.callNo)[0];
  return ranked?.callNo ?? null;
}

/** The sessions the store keeps, newest first, each opening at its own page under Changes (a preview's tab, a migration's). */
export function decisionSessions(store: StoreOf<'decisions'> & Store, o: { limit?: number; kind?: 'decisions' | 'migrate' } = {}): DecisionSessionView[] {
  const rows = store.listDecisionSessions(o);
  const facts = sessionFacts(store, rows.map((s) => s.sessionId));
  return rows.map((s) => {
    const f = facts.get(s.sessionId);
    return { ...s, name: f?.name ?? s.change, goldens: f?.goldens ?? 0, unit: f?.unit ?? 'run', samples: f?.samples ?? null, href: links.changeSession(s.kind, s.sessionId) };
  });
}

/**
 * One session whole: a decisions session is the report `decisions --json` printed, a migrate one the
 * report `migrate --json` printed, its decisions' runs filled in from their rows; with the matrix
 * the page draws (one row per run, one cell per model call). Null for an id the store doesn't have.
 */
export function decisionSession(store: StoreOf<'decisions'>, sessionId: string): (Record<string, unknown> & { kind: 'decisions' | 'migrate'; matrix: DecisionRow[] }) | null {
  if (!/^(dc|mg)-[0-9A-Z]{26}$/.test(sessionId)) return null;
  const s = store.getDecisionSession(sessionId);
  if (!s) return null;
  const runs = s.runRows.map((r) => r.data as unknown as DecisionRun);
  if (s.kind === 'migrate') {
    const decisions = { ...((s.data.decisions as Record<string, unknown> | undefined) ?? {}), runs };
    return { ...s.data, kind: 'migrate', decisions, matrix: runs.map((r) => decisionRow(r)) };
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
  rank: number | null;
  changed: number;
  /** Its Decisions view at the run's most consequential call; `changes`, its cell on Changes. */
  href: string;
  changes: string;
  row: DecisionRow;
  run: DecisionRun;
  /** Whether the session left it to verify (`toVerify`; a session kept before it said which, the flagged). */
  toVerify: boolean;
  /** What verify found of it: its outcome, its tally and bound (` · 4 of 4 · rate >= 0.6 (95%)`), and the rule it was decided by. Null until verify took it. */
  verified: { outcome: string; tally: string; rule: string | null } | null;
}

/** A run's decisions under each session that asked its model calls again, newest first, for its page's Decisions view. */
export function runDecisions(store: StoreOf<'decisions'> & Store, runId: string, limit = 10): { runId: string; sessions: RunDecisionsSession[] } {
  const rows = store.decisionsOfRun(runId, limit);
  const facts = sessionFacts(store, rows.map((r) => r.sessionId));
  return {
    runId,
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
        href: links.run(runId, call, 'decisions'),
        changes: links.changeSession(r.kind, r.sessionId, runId, call),
        row,
        run,
        toVerify: !!f?.toVerify.includes(runId),
        verified: entry ? { outcome: runOutcomeWord(entry.outcome), tally: tallyWords(entry), rule: entry.rule ?? v?.rule ?? null } : null,
      };
    }),
  };
}

/**
 * The models the project's goldens are recorded on that retire, by the table that ships with
 * Shadowlap: each with the goldens that use it, the soonest first. A golden not in the store yet
 * (never tested here) can't be read, and is left out.
 */
export function retirementsView(store: StoreOf<'recording'>, goldens: readonly GoldenSource[], now = Date.now()): RetirementsView {
  const byModel = new Map<string, RetirementNotice & { goldens: string[] }>();
  for (const g of goldens) {
    if (!g.runId || !store.getRun(g.runId)) continue;
    const seen = new Set<string>();
    for (const c of store.getCalls(g.runId)) {
      // Shadowlap's own calls (its judge's) are no model the agent uses.
      if (c.kind !== 'api' || isReservedScope(c.meta.scope)) continue;
      const provider = (c.meta.provider ?? c.end?.meta.provider ?? null);
      const model = (c.end?.meta.model ?? c.meta.model ?? null);
      if (!model) continue;
      const key = `${String(provider)}\u0000${model}`;
      if (seen.has(key)) continue;
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
function targetArgs(store: StoreOf<'recording'>, req: JobRequest, goldens: readonly GoldenSource[]): { args: string[]; runIds: string[]; byId: string[]; packs: string[] } | { error: string; status?: number } {
  const args: string[] = [];
  const runIds: string[] = [];
  // Runs named by id, and goldens by their pack folder: each asks for a yes as a test asks of it.
  const byId: string[] = [];
  const packs: string[] = [];
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

/**
 * `shadowlap decisions` as a job: `{ runs?, goldens?, model?, set?, from?, scope?, fromCode?, samples?,
 * thenVerify?, yes? }`. Without `samples`, each step is asked as the CLI asks it by default: 3 times
 * under the change and 3 times as recorded, the control, six requests a step. `samples` given is
 * passed on whatever it is, 1 too, which asks once and has no control.
 */
export function decisionsJob(req: JobRequest, store: StoreOf<'recording'>, goldens: readonly GoldenSource[], projectDir: string = process.cwd()): JobBuildResult {
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
    samples = ['--samples', String(req.samples)];
  }
  const runsAgent = fromCode || req.thenVerify === true;
  let yes: string[] = [];
  if (runsAgent) {
    const consent = commandConsent(store, targets.byId, targets.packs, projectDir, req.yes);
    if ('ask' in consent) return consent.ask;
    yes = consent.yes;
  }
  const args = ['decisions', ...targets.args, ...(typeof req.model === 'string' ? ['--model', req.model] : []), ...set, ...from, ...scope, ...(fromCode ? ['--from-code'] : []), ...samples, ...(req.thenVerify === true ? ['--then-verify'] : []), ...yes];
  const what = fromCode ? 'the prompt in your working tree' : typeof req.model === 'string' ? req.model : 'the fields set';
  return { args, title: `Previewing ${what}`, ...(targets.runIds.length === 1 ? { runId: targets.runIds[0]! } : {}) };
}

/** `shadowlap migrate` as a job: `{ to, goldens?, runs?, from?, scope?, set?, yes? }`; every golden when none are named. */
export function migrateJob(req: JobRequest, store: StoreOf<'recording'>, goldens: readonly GoldenSource[], projectDir: string = process.cwd()): JobBuildResult {
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
  const consent = commandConsent(store, targets.byId, targets.packs, projectDir, req.yes);
  if ('ask' in consent) return consent.ask;
  return { args: ['migrate', '--to', req.to, ...targets.args, ...from, ...scope, ...set, ...consent.yes], title: `Migrating to ${req.to}` };
}

/** A session's report: a decisions session's own, a migration's decisions. */
export const sessionReport = (session: NonNullable<ReturnType<typeof decisionSession>>) => (session.kind === 'migrate' ? session.decisions : session) as { flagged?: unknown; toVerify?: unknown; runs?: DecisionRun[]; change?: { fromCode?: unknown } };

/**
 * The runs a session's Verify takes, as `decisions --verify <session> [run…]` picks them: those it
 * could not clear (`toVerify`; a session kept before it said which, the ones it flagged), or those
 * `named` names among them (a run id, or a list of them), each by its id or a prefix of 6 or more.
 * Why there are none, when none.
 */
export function runsToVerify(session: NonNullable<ReturnType<typeof decisionSession>>, named?: unknown): string[] | { error: string; status: number } {
  const report = sessionReport(session);
  const listed = Array.isArray(report.toVerify) ? report.toVerify : report.flagged;
  const ids = (Array.isArray(listed) ? listed : []).filter((id): id is string => typeof id === 'string');
  if (named !== undefined) {
    const wanted = Array.isArray(named) ? named : [named];
    const picked = wanted.map((w) => ids.find((id) => id === w || (typeof w === 'string' && w.length >= 6 && id.startsWith(w))));
    if (!wanted.length || picked.some((id) => !id)) return { error: `this session cleared ${wanted.length === 1 ? 'that run' : 'a run named'}: there is nothing to verify`, status: 404 };
    return [...new Set(picked as string[])];
  }
  return ids.length ? ids : { error: 'this session cleared every run: there is nothing to verify', status: 409 };
}

/**
 * Verify the runs a session could not clear, the page's primary action: `shadowlap decisions --verify
 * <session>` (with the one `runId` names, or those `runIds` name, the runs no verify took yet), which verifies each run under its own checks (its
 * golden's, or for a run named by id those of the recording it comes from), one verify per set of
 * checks, in the role its recording plays under them, with the session's change, and keeps what it
 * finds in the session.
 */
export function verifyFlaggedJob(req: JobRequest, store: StoreOf<'recording' | 'decisions'>, projectDir: string = process.cwd()): JobBuildResult {
  if (typeof req.sessionId !== 'string') return { error: 'sessionId is required' };
  const session = decisionSession(store, req.sessionId);
  if (!session) return { error: `no session ${req.sessionId.slice(0, 40)}`, status: 404 };
  if (req.runIds !== undefined && (!Array.isArray(req.runIds) || req.runIds.length > 500)) return { error: 'runIds is a list of the runs to verify' };
  const named = req.runIds ?? req.runId;
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
  const args = ['decisions', '--verify', req.sessionId, ...(named !== undefined ? flagged : []), ...consent.yes];
  return { args, title: `Verifying ${runs.length} run${runs.length === 1 ? '' : 's'} end to end`, ...(runs.length === 1 ? { runId: runs[0]!.runId } : {}) };
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
