import { hasRecordedCommand, type Normalizer, type RunRecord, type Store } from '@shadowlap/engine';
import { parseStoreUrl, shortStoreName, teamRunInStore } from '@shadowlap/remote';
import { lookupRun } from './api.js';
import { fixForRun } from './fixes.js';
import { copyRules, type CopyRules } from './run-exports.js';
import { bisectChoices, testRunBanner, type BisectChoices, type GoldenSource, type TestRunBanner } from './tests.js';

/**
 * What the run page offers to do with a run beyond its own record, worked out from the project's
 * config: how many redaction rules each copy in the Share menu applies, whether the run is only on
 * this machine (Push), the check Run blame would use, Find the commit's revisions, and what the
 * banner of a test that diverged can do. A plain function, like the other read models.
 */

/** Where the run stands with the team store named in the config. */
export type TeamState = 'only-here' | 'queued' | 'in-store' | 'recording' | 'pull-request';

/**
 * Run blame on a failed run: the check a passing run must meet, and where it came from — the run's
 * own `--expect` (`run`), its golden's checks in the config (`golden`), the fix its labels point to
 * (`fix`) — or none, to blame on the exit status alone (`exit`), or none known, so the page asks
 * (`ask`). `failed` names the checks the run failed.
 */
export interface BlameOffer {
  from: 'run' | 'golden' | 'fix' | 'exit' | 'ask';
  /** The check, as `--expect` takes it; null to blame on the exit status; absent when it must be asked. */
  expect?: unknown;
  failed: string[];
}

export interface RunOffers {
  runId: string;
  /** Share: how many of the project's redaction rules each copy applies. */
  copies: CopyRules;
  /** The team store the config names (its short name), and where this run stands with it; null without one. */
  team: { store: string; state: TeamState } | null;
  /** Run blame, for a failed run never blamed; null otherwise. */
  blame: BlameOffer | null;
  /** Find the commit: the revisions to start from, or why it can't start from this run. */
  bisect: BisectChoices | null;
  /** A replay made by `shadowlap test` whose golden diverged: Add normalizer and Update golden. */
  test: TestRunBanner | null;
}

export interface RunOffersInput {
  /** The project's redaction rules, as a copy made now applies them. */
  redact: readonly Normalizer[];
  /** shadowlap.config.json as written: `store` (the team store) and `tests` (each golden's checks). */
  config: { store?: unknown; tests?: unknown } | null;
  /** The goldens on disk, for Find the commit on a test replay; none when the dashboard was given none. */
  goldens?: readonly GoldenSource[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function teamOf(store: Store, run: RunRecord, raw: unknown): RunOffers['team'] {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let loc: ReturnType<typeof parseStoreUrl>;
  try {
    loc = parseStoreUrl(raw);
  } catch {
    return null;
  }
  const name = shortStoreName(loc);
  if (run.status === 'running') return { store: name, state: 'recording' };
  if (run.meta?.imported?.pr) return { store: name, state: 'pull-request' };
  const row = store.teamRun(loc.url, run.runId);
  return { store: name, state: row && teamRunInStore(row) ? 'in-store' : row?.state === 'queued' ? 'queued' : 'only-here' };
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

/**
 * Run blame for a run that failed and was never blamed: a check it failed, or the agent's exit. A
 * capture has no command to run again, and a run still recording has not failed yet.
 */
export function blameOffer(store: Store, run: RunRecord, tests: unknown): BlameOffer | null {
  if (run.status === 'running' || !hasRecordedCommand(run) || run.meta?.blame) return null;
  // A blame probe's or a verify attempt's outcome belongs to the fix it was made for.
  if (run.meta?.probe || run.meta?.verify) return null;
  const failed = (run.meta?.checks ?? []).filter((c) => isObject(c) && c.ok === false && typeof c.label === 'string').map((c) => c.label);
  const exited = run.status === 'failed' || run.status === 'crashed';
  if (!failed.length && !exited) return null;
  if (failed.length) {
    const own = run.meta?.expect;
    if (isObject(own)) return { from: 'run', expect: own, failed };
    const golden = run.meta?.test?.golden;
    const fromConfig = typeof golden === 'string' ? goldenExpect(tests, golden) : undefined;
    if (fromConfig !== undefined) return { from: 'golden', expect: fromConfig, failed };
  }
  const suggested = fixForRun(store, run.runId);
  if (suggested?.role === 'unblamed' && suggested.expect !== undefined && suggested.expect !== null) return { from: 'fix', expect: suggested.expect, failed };
  return failed.length ? { from: 'ask', failed } : { from: 'exit', expect: null, failed };
}

/**
 * Find the commit for a run blame found failing: one that exited 0 and kept no checks of its own
 * failed the check blame was given, which the tests' read model can't see on the run, so it would
 * look for where a passing run changes. Bisect needs that check (`--expect`, replayed with `--fork`),
 * and the job takes none: the page says so, with the command to run instead.
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

export function runOffers(store: Store, idOrPrefix: string, input: RunOffersInput): RunOffers | null {
  const run = lookupRun(store, idOrPrefix);
  if (!run) return null;
  return {
    runId: run.runId,
    copies: copyRules(input.redact),
    team: teamOf(store, run, input.config?.store),
    blame: blameOffer(store, run, input.config?.tests),
    bisect: blamedBisect(run, bisectChoices(store, run.runId, { goldens: input.goldens ?? [] })),
    test: testRunBanner(store, run.runId),
  };
}
