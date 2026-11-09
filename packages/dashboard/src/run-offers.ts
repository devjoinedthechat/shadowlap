import { resolve } from 'node:path';
import { abandonedRuns, checkStatus, hasRecordedCommand, isObject, shortRunId, storeView, type Normalizer, type RunRecord, type Store, type StoreOf, type TestResult } from '@shadowlap/engine';
import { parseStoreUrl, shortStoreName, storeKey, teamRunInStore } from '@shadowlap/remote';
import { lookupRun } from './api.js';
import { loadRunIndex, type IndexedRun } from './run-index.js';
import { fixForRun, type FixForRun } from './fixes.js';
import { injectionResults, type InjectionRow } from './injection.js';
import { copyRules, recordingNow, type CopyRules } from './run-exports.js';
import { bisectChoices, testOf, testRunBanner, type BisectChoices, type GoldenSource, type TestRunBanner } from './tests.js';
import { passedSince } from './runs-filter.js';
import { runState } from './runs-list.js';

/**
 * What the run page offers to do with a run beyond its own record, worked out from the project's
 * config: how many redaction rules each copy in the Share menu applies, whether the run is only on
 * this machine (Push), whether Run blame applies and the check it would likely use, Find breaking commit's
 * revisions, and what the banner of a test that diverged can do. A plain function, like the other
 * read models.
 */

/** Where the run stands with the team store named in the config. */
export type TeamState = 'only-here' | 'queued' | 'in-store' | 'recording' | 'pull-request';

/**
 * Run blame on a failed run, which the fixes' `blame` job runs: the job finds the check itself (and
 * answers 422 when nothing names it, so the page asks). This says the check it would likely use, for
 * the button's hover and for the command to run where the dashboard can't: the run's own `--expect`
 * (`run`), its golden's checks in the config (`golden`), the fix its labels point to (`fix`), none,
 * to blame on the exit status alone (`exit`), or none known (`ask`). `failed` names the checks the
 * run failed.
 */
export interface BlameOffer {
  from: 'run' | 'golden' | 'fix' | 'exit' | 'ask';
  /** The check, as `--expect` takes it; null to blame on the exit status; absent when it must be asked. */
  expect?: unknown;
  failed: string[];
}

/**
 * A replay made by `shadowlap test` whose golden diverged (the tests' read model), and what has
 * happened since: whether every rule Add normalizer adds is in shadowlap.config.json now, and the
 * newest replay of the same golden since this one that passed, which the banner links.
 */
export interface TestOffer extends TestRunBanner {
  normalized: boolean;
  passingRun: string | null;
  /**
   * The golden's checks now, as the CLI labels them (from the goldens on disk), which an update
   * runs, as the Tests screen's Update golden dialog counts them; null when the golden isn't on disk.
   */
  checks: string[] | null;
}

export interface RunOffers {
  runId: string;
  /** Share: how many of the project's redaction rules each copy applies. */
  copies: CopyRules;
  /**
   * The team store the config names (its short name), and where this run stands with it; null
   * without one. A run is only here (`only-here`, which Push sends) when it is, or when attempts
   * filed under it are (`localAttempts`: whether the run itself is, and how many attempts), as the
   * Runs page tags it `local`.
   */
  team: { store: string; state: TeamState; localAttempts?: { run: boolean; attempts: number } } | null;
  /** Run blame, for a failed run never blamed; null otherwise. */
  blame: BlameOffer | null;
  /** Find breaking commit: the revisions to start from, or why it can't start from this run. */
  bisect: BisectChoices | null;
  /** A replay made by `shadowlap test` whose golden diverged: Add normalizer and Update golden, or that the normalizer was added. */
  test: TestOffer | null;
  /**
   * Pack as golden…, whatever step leads: a recording a golden can be made from (next-step.ts's
   * `keepable`), with the folder the dialog offers; null otherwise, and with no project to pack into.
   */
  keep: { folder: string } | null;
  /**
   * Share's Security report: this run's newest kept injection result that has ended (one still
   * running has no report yet), and whether it planted payloads or tested a clean answer; null with none.
   */
  security: { resultId: string; mode: InjectionRow['mode'] } | null;
  /**
   * A test replay whose agent exited with an error: the last line it printed, and the call it stopped
   * at of its golden's recorded calls where the replay kept them (`ended_early`); absent or null for
   * any other run, and for a crash that kept no output.
   */
  crash?: { line: string; at: number | null; of: number | null } | null;
}

export interface RunOffersInput {
  /** The project's redaction rules, as a copy made now applies them. */
  redact: readonly Normalizer[];
  /** shadowlap.config.json as written: `store` (the team store), `tests` (each golden's checks) and `normalize` (its normalizers). */
  config: { store?: unknown; tests?: unknown; normalize?: unknown } | null;
  /** The goldens on disk, for Find breaking commit on a test replay; none when the dashboard was given none. */
  goldens?: readonly GoldenSource[];
  /** The commit the project's HEAD is at, for Find breaking commit on a run that passed; null outside git. */
  head?: string | null;
  /** The project's folder, which goldens are packed into; none packs nothing. */
  dir?: string | null;
}

/** The folder a run is packed into as a golden: `goldens/` and its short id in lower case, never a label, which groups and filters runs and names none. */
export const goldenFolder = (runId: string): string => `goldens/${shortRunId(runId).toLowerCase()}`;

/**
 * Whether a recording can be packed as a golden yet: there is a project to pack it into, and no golden
 * is made from it, one whose pack holds it or one it was unpacked from. One of a fork or a replay of
 * it says nothing of this one.
 */
export function packableIn(dir: string | null | undefined, goldens: readonly Pick<GoldenSource, 'runId' | 'path'>[], run: RunRecord): boolean {
  if (!dir) return false;
  const from: unknown = run.meta?.imported?.from;
  const unpacked = typeof from === 'string' && from ? resolve(dir, from) : null;
  return !goldens.some((g) => g.runId === run.runId || resolve(dir, g.path) === unpacked);
}

/**
 * A recording a golden can be made from, as Pack as golden… takes one: it ended, didn't fail, holds
 * calls and the command it was recorded with, and no golden is made from it yet. A golden from a
 * failed run would pass on the failure and diverge once the fix ships. Its outcome by today's checks
 * is the page's to add.
 */
export function keepable(row: Pick<IndexedRun, 'kind' | 'status' | 'failed' | 'calls'>, run: RunRecord, dir: string | null | undefined, goldens: readonly Pick<GoldenSource, 'runId' | 'path'>[]): boolean {
  return row.kind === 'recording' && row.status === 'completed' && !row.failed && row.calls > 0 && hasRecordedCommand(run) && packableIn(dir, goldens, run);
}

/** Pack as golden… for a recording a golden can be made from: from the run index, reading no call. */
function keepOffer(store: Store, run: RunRecord, input: RunOffersInput): RunOffers['keep'] {
  const row = loadRunIndex(store).byId.get(run.runId);
  return row && keepable(row, run, input.dir, input.goldens ?? []) ? { folder: goldenFolder(run.runId) } : null;
}

/** Share's Security report: the newest of the run's kept injection results with a report, not one still running. */
function securityOffer(store: Store, run: RunRecord): RunOffers['security'] {
  const done = injectionResults(store, { runId: run.runId }).results.find((r) => !r.running);
  return done ? { resultId: done.resultId, mode: done.mode } : null;
}

function teamOf(store: StoreOf<'recording' | 'readModels' | 'team'>, run: RunRecord, raw: unknown): RunOffers['team'] {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let loc: ReturnType<typeof parseStoreUrl>;
  try {
    loc = parseStoreUrl(raw);
  } catch {
    return null;
  }
  const name = shortStoreName(loc);
  // A run its recorder left marked running was interrupted: only here, and pushed as it is.
  if (recordingNow(store, run)) return { store: name, state: 'recording' };
  if (run.meta?.imported?.pr) return { store: name, state: 'pull-request' };
  const key = storeKey(loc);
  const row = store.teamRun(key, run.runId);
  const state: TeamState = row && teamRunInStore(row) ? 'in-store' : row?.state === 'queued' ? 'queued' : 'only-here';
  // Attempts filed under it (--repeat, blame's probes, verify's) that are only here: a push of the run sends them.
  const attempts = localAttemptsOf(store, key, run.runId);
  if (!attempts) return { store: name, state };
  return { store: name, state: state === 'in-store' ? 'only-here' : state, localAttempts: { run: state !== 'in-store', attempts } };
}

/**
 * How many attempts filed under a run are only on this machine, as the store's counts have them:
 * ended (or left by a recorder that is gone, which a push ends), not from a pull request's folder,
 * not in the store's index.
 */
function localAttemptsOf(store: StoreOf<'recording' | 'readModels' | 'team'>, key: string, runId: string): number {
  const attempts = loadRunIndex(store).attempts.get(runId) ?? [];
  const ended = attempts.some((a) => a.status === 'running') ? abandonedRuns(store) : new Set<string>();
  let n = 0;
  for (const a of attempts) {
    if (a.status === 'running' && !ended.has(a.runId)) continue;
    const row = store.teamRun(key, a.runId);
    if (row && teamRunInStore(row)) continue;
    if (store.getRun(a.runId)?.meta?.imported?.pr) continue;
    n++;
  }
  return n;
}

/** A golden's checks in the config's `tests`: its own entry, else one whose last part's `*` matches it. */
export function goldenExpect(tests: unknown, golden: string): unknown {
  if (!isObject(tests)) return undefined;
  const clean = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const target = clean(golden);
  const own = Object.entries(tests).find(([k]) => clean(k) === target)?.[1];
  const entry =
    own ??
    Object.entries(tests).find(([k]) => {
      const key = clean(k);
      const cut = key.lastIndexOf('/');
      const [dir, last] = [key.slice(0, Math.max(0, cut)), key.slice(cut + 1)];
      if (!last.includes('*') || target.slice(0, Math.max(0, target.lastIndexOf('/'))) !== dir) return false;
      const re = new RegExp(`^${last.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
      return re.test(target.slice(target.lastIndexOf('/') + 1));
    })?.[1];
  return isObject(entry) && isObject(entry.expect) ? entry.expect : undefined;
}

const modelCalls = new WeakMap<object, Map<string, boolean>>();

/** Whether a run made a model call, from the index of its calls by kind: none of its calls read. */
const MADE_MODEL_CALL_SQL = `SELECT EXISTS (SELECT 1 FROM call_events WHERE run_id = ? AND kind = 'api' AND phase = 'start') AS made`;

/** Whether a run that has ended made a model call: blame asks model calls again, so it needs one. */
function madeModelCall(store: StoreOf<'readModels'>, run: RunRecord): boolean {
  let seen = modelCalls.get(store);
  if (!seen) {
    seen = new Map();
    modelCalls.set(store, seen);
  }
  const known = seen.get(run.runId);
  if (known !== undefined) return known;
  const made = Number(store.query(MADE_MODEL_CALL_SQL, run.runId)[0]?.made ?? 0) === 1;
  if (seen.size > 2000) seen.clear();
  seen.set(run.runId, made);
  return made;
}

/**
 * Run blame for a run that failed and was never blamed: a check it failed, or the agent's exit. A
 * capture has no command to run again, a run still recording has not failed yet, and a run that made
 * no model call has no answer of the model's to blame. Nor has an interrupted run (stopped, or timed
 * out) that failed no check: blame replays a run to see it fail as recorded first, and a stop is not
 * something the agent did, so it never does.
 */
export function blameOffer(store: StoreOf<'recording' | 'readModels' | 'fixes'>, run: RunRecord, tests: unknown, fix: () => FixForRun | null = () => fixForRun(store, run.runId)): BlameOffer | null {
  if (run.status === 'running' || !hasRecordedCommand(run) || run.meta?.blame) return null;
  // A blame probe's or a verify attempt's outcome belongs to the fix it was made for, and a preset's
  // attempt failed on the failure the preset played in: its verdict is the preset's.
  if (run.meta?.probe || run.meta?.verify || run.meta?.chaos) return null;
  // A pack can carry anything: only a list of checks is read as one.
  const checks = Array.isArray(run.meta?.checks) ? run.meta.checks : [];
  const notPassed = checks.filter((c) => isObject(c) && c.ok === false && typeof c.label === 'string');
  // A check that could not be decided can't be on a probe either, so no probe could pass: blame
  // refuses such a run, and it isn't offered.
  if (notPassed.some((c) => checkStatus(c) === 'inconclusive')) return null;
  const failed = notPassed.map((c) => c.label);
  if (!failed.length && run.status !== 'failed') return null;
  if (!madeModelCall(store, run)) return null;
  if (failed.length) {
    const own = run.meta?.expect;
    if (isObject(own)) return { from: 'run', expect: own, failed };
    const golden = run.meta?.test?.golden;
    const fromConfig = typeof golden === 'string' ? goldenExpect(tests, golden) : undefined;
    if (fromConfig !== undefined) return { from: 'golden', expect: fromConfig, failed };
  }
  const suggested = fix();
  if (suggested?.role === 'unblamed' && suggested.expect !== undefined && suggested.expect !== null) return { from: 'fix', expect: suggested.expect, failed };
  return failed.length ? { from: 'ask', failed } : { from: 'exit', expect: null, failed };
}

const RULE_FIELDS = ['kind', 'name', 'path', 'pattern', 'replace'] as const;

/** Whether a rule as written in the config is the same rule as one Add normalizer adds. */
function sameRule(written: unknown, rule: Normalizer): boolean {
  return isObject(written) && RULE_FIELDS.every((k) => (written[k] ?? undefined) === rule[k]);
}

/**
 * The diverged test's banner, and what has happened since: every rule Add normalizer adds is in the
 * config's `normalize` (it was added, here or by hand), and the newest replay of the golden that
 * passed since this one, which shows the rule worked (or the update after it did). `goldens`, those
 * on disk, give the checks an update would run.
 */
export function testOffer(store: StoreOf<'recording' | 'tests'>, run: RunRecord, normalize: unknown, goldens: readonly GoldenSource[] = []): TestOffer | null {
  const banner = testRunBanner(store, run.runId);
  if (!banner) return null;
  const rules = Array.isArray(normalize) ? normalize : [];
  const wanted = banner.values.values.map((v) => v.normalizer);
  const normalized = wanted.length > 0 && wanted.every((w) => rules.some((r) => sameRule(r, w)));
  return { ...banner, normalized, passingRun: normalized ? passedSince(store, run, banner.golden) : null, checks: goldens.find((g) => g.path === banner.golden)?.checks ?? null };
}

/** Whether a test replay's agent exited with an error, as its golden's result says (a run keeps no exit of its own): a crash. */
export function crashed(row: Pick<IndexedRun, 'status' | 'outcome'> | null, result: TestResult | null): boolean {
  if (result) return result.failure === 'exit';
  return !!row && row.status === 'failed' && row.outcome.kind === 'check-failed' && row.outcome.check === null;
}

/** A test replay that crashed (`crashed`, by its golden's result): what the agent printed last, and where it stopped. */
export function crashOffer(store: StoreOf<'recording' | 'tests'>, run: RunRecord): NonNullable<RunOffers['crash']> | null {
  const test = testOf(run);
  const result = test ? (store.listTestResults({ sessionId: test.session, golden: test.golden, limit: 1 })[0] ?? null) : null;
  if (!result || !crashed(null, result)) return null;
  const line = result.data?.output?.split('\n').map((l) => l.trim()).filter(Boolean).at(-1);
  if (!line) return null;
  const d = run.divergence?.type === 'ended_early' ? run.divergence : null;
  return { line, at: d?.callNo ?? null, of: d?.recorded ?? null };
}

/**
 * Find breaking commit for a run blame found failing when this store holds no fix to say which check: one
 * that exited 0 and kept no checks of its own failed the check blame was given. With the run's fix
 * here, bisectChoices reads that check from it and searches with it (`--expect`, replayed with
 * `--fork`), and this changes nothing. Without it (a pack carries a run's blame, never its fix), the
 * tests' read model would look for where a passing run changes; bisect needs the check, and the job
 * takes none: the page says so, with the command to run instead.
 */
export function blamedBisect(run: RunRecord, b: BisectChoices | null): BisectChoices | null {
  if (!b || b.failed || b.unavailable || b.target.kind !== 'run' || !run.meta?.blame) return b;
  const bad = b.good;
  return {
    ...b,
    failed: true,
    good: null,
    bad,
    fork: true,
    live: true,
    args: null,
    unavailable: `blame found this run failing a check that bisect can't know from the run: give it on the command line, shadowlap bisect ${run.runId.slice(0, 10)} --good <commit>${bad ? ` --bad ${bad}` : ''} --expect '<checks>' --fork`,
  };
}

/** Whether two revisions name the same commit: one is the other, or its abbreviation (7 characters at least). */
export function sameCommit(a: string, b: string): boolean {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  if (x === y) return true;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  return short.length >= 7 && /^[0-9a-f]+$/.test(short) && long.startsWith(short);
}

/**
 * Find breaking commit for a run that passed: bisect searches the commits after the run's own, up to HEAD,
 * for the first where it does something else. A run made at HEAD has nothing after it to search yet
 * (the CLI would stop at once, `--good` and `--bad` being the same commit), so the page says so
 * rather than offer a search that can't start.
 */
export function passingBisect(b: BisectChoices | null, head: string | null | undefined): BisectChoices | null {
  if (!b || b.failed || b.unavailable || !b.good || !head || !sameCommit(b.good, head)) return b;
  return { ...b, args: null, unavailable: `this run passed at ${b.good}, which is HEAD: there is no later commit to search yet` };
}

/**
 * The store as Find breaking commit reads a run its recorder left marked running: as the run list has
 * it, interrupted and ended at its last call, as one stopped with Ctrl-C reads, never as one still
 * recording. Any other run is read as it is.
 */
function asListed(store: Store, run: RunRecord): Store {
  const state = runState(store, run.runId);
  if (!state || state.status === run.status) return store;
  const shown: RunRecord = { ...run, status: state.status, endedAt: run.endedAt ?? state.endedAt };
  return storeView(store, { getRun: (id) => (id === run.runId ? shown : store.getRun(id)) });
}

export function runOffers(store: Store, idOrPrefix: string, input: RunOffersInput): RunOffers | null {
  const run = lookupRun(store, idOrPrefix);
  if (!run) return null;
  return {
    runId: run.runId,
    copies: copyRules(input.redact),
    team: teamOf(store, run, input.config?.store),
    blame: blameOffer(store, run, input.config?.tests),
    bisect: passingBisect(blamedBisect(run, bisectChoices(asListed(store, run), run.runId, { goldens: input.goldens ?? [] })), input.head),
    test: testOffer(store, run, input.config?.normalize, input.goldens ?? []),
    keep: keepOffer(store, run, input),
    security: securityOffer(store, run),
    crash: crashOffer(store, run),
  };
}
