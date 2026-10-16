import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { abandonedRuns, teamRunCounts, type Store, type TeamRunCounts } from '@shadowlap/engine';
import { CREDENTIAL_HINTS, credentialsHere, formatStoreUrl, lastCheck, parseStoreUrl, shortStoreName, storeKey, storeKindName, type LastCheck, type Provider, type StoreLocation } from '@shadowlap/remote';

/**
 * The team store as `/api/meta` reports it: the bucket and folder shadowlap.config.json names, when
 * this machine last pushed and pulled, how many runs are in the store and which are only here (the
 * Runs page's `local` tag), the last `shadowlap store check`, and whose credentials this machine
 * would use. teamStoreStatus is pure (the store and what readTeamStoreInput gathered in, JSON out);
 * readTeamStoreInput does the reading: the config, and the environment and files the clouds' own
 * tools keep credentials in. Nothing here makes a request: the bucket is the CLI's to talk to.
 */

export interface TeamStoreInput {
  /** `store` from shadowlap.config.json, as written; null without one. */
  store: string | null;
  /** `ciPush` from shadowlap.config.json: Settings → Store's "Push from CI". On unless set to false. */
  ciPush?: boolean;
  /** What this machine would sign in with for the store, found offline (credentialsHere); null when nothing names any. */
  credentials?: { uses: string; from: string } | null;
}

export interface TeamStoreStatus {
  /** The store as people read it: scheme, bucket and folder. */
  url: string;
  /** Its identity, which this machine keeps what it knows of the store under: the URL, with its endpoint when it names one. */
  key: string;
  /** As written in the config, with its settings. */
  configured: string;
  provider: Provider;
  providerName: string;
  bucket: string;
  prefix: string;
  account: string | null;
  region: string | null;
  /** `northwind-agent-runs/support-agent`, for the status bar. */
  name: string;
  pushedAt: number | null;
  pulledAt: number | null;
  /** The later of the two; null before the first sync. */
  syncedAt: number | null;
  /**
   * Runs in the store, as far as this machine knows, counted as every screen counts runs: attempts
   * (`--repeat`, blame's probes, verify's attempts) are filed under their run.
   */
  inStore: number;
  /**
   * Runs here with something not in the store: the run itself, or attempts filed under it (the
   * Runs page's `local` tag). Runs still recording and runs pulled from a pull request's folder aren't counted.
   */
  onlyLocal: number;
  /** Ids of those runs, newest first (at most 500). */
  localRuns: string[];
  /** Attempts only here, filed under runs here: a push of their runs sends them. */
  localAttempts: number;
  /** Runs queued while recording, pushed when they end. */
  queued: number;
  /** The last `shadowlap store check` on this machine: access, encryption, versioning and object lock. */
  check: LastCheck | null;
  /** Your access: the credentials the last check used, else those found on this machine, else where they would come from. */
  access: string;
  /** Settings → Store's "Push from CI" switch: `test --push` in CI pushes, unless the config's `ciPush` is false. */
  ciPush: boolean;
  /** The CI providers whose runs are in the store (github, gitlab…), for "ci (GitHub Actions)". */
  ciProviders: string[];
  /** A setup of the store started on the setup page and not finished: the status bar says "setting up", as the design's does. */
  settingUp: boolean;
}

/** Runs whose ids the `local` tag needs at most: the newest only-local runs. */
const LOCAL_IDS = 500;

/**
 * The store's write counters for runs and for what it knows of the team store (change_counts, kept
 * by triggers for every writer): neither moves for a call a recording appends.
 */
const COUNTERS_SQL = `SELECT name, n FROM change_counts WHERE name IN ('runs', 'team')`;
/** Changes with every commit to the store, by this connection (total_changes) or by any other (data_version): for a store without the counters. */
const VERSION_SQL = `SELECT (SELECT data_version FROM pragma_data_version()) AS dv, total_changes() AS tc`;

interface TeamFacts {
  counts: TeamRunCounts;
  /** The CI providers whose runs the store's index lists, for "ci (GitHub Actions)". */
  ciProviders: string[];
}
const kept = new WeakMap<Store, { key: string; version: string; facts: TeamFacts }>();

/**
 * What changes the counts: a run added, ended, changed or deleted, a row of what this machine knows
 * of the store, and the recordings whose recorder is gone (which a push ends and sends).
 */
function versionOf(store: Store, ended: ReadonlySet<string>): string {
  const counters = new Map(store.query(COUNTERS_SQL).map((r) => [String(r.name), Number(r.n)]));
  const v = counters.has('runs') && counters.has('team') ? `${counters.get('runs')}|${counters.get('team')}` : (() => {
    const row = store.query(VERSION_SQL)[0];
    return `${String(row?.dv)}|${String(row?.tc)}`;
  })();
  return `${v}|${[...ended].sort().join(',')}`;
}

/**
 * The by-run counts and the CI providers in the store, read again only when runs or what this
 * machine knows of the store changed, or a recording's recorder went away: the status bar, the
 * Overview and the Runs page ask on every reload, and a recording appends calls all the while.
 */
function teamFacts(store: Store, key: string): TeamFacts {
  const ended = abandonedRuns(store);
  const version = versionOf(store, ended);
  const hit = kept.get(store);
  if (hit && hit.key === key && hit.version === version) return hit.facts;
  const facts = { counts: teamRunCounts(store, key, LOCAL_IDS, ended), ciProviders: store.teamSummary(key).ciProviders };
  kept.set(store, { key, version, facts });
  return facts;
}

/** The by-run counts against one store (its identity, `storeKey`), kept until runs or the store's rows change. */
export function countsOf(store: Store, key: string): TeamRunCounts {
  return teamFacts(store, key).counts;
}

/** Whether the setup recorded with what this machine knows of a store (team_sync's `setup`, store-setup.ts) is under way. */
function settingUp(setup: unknown): boolean {
  if (typeof setup !== 'object' || setup === null) return false;
  const s = setup as { startedAt?: unknown; finishedAt?: unknown };
  return typeof s.startedAt === 'number' && typeof s.finishedAt !== 'number';
}

/** The team store for `/api/meta`, or null when the config names none (or names one that isn't a store URL). Pure. */
export function teamStoreStatus(store: Store, input: TeamStoreInput): TeamStoreStatus | null {
  if (!input.store) return null;
  let loc: StoreLocation;
  try {
    loc = parseStoreUrl(input.store);
  } catch {
    return null;
  }
  const key = storeKey(loc);
  const sync = store.teamSync(key);
  // In the store means listed in its index, where teammates find it: a run whose upload was cut
  // short before its index segment is still only here. Counted by run, as the Runs page and the
  // status bar count runs; read again only once runs or the store's rows have changed.
  const { counts, ciProviders } = teamFacts(store, key);
  const pushedAt = sync?.pushedAt ?? null;
  const pulledAt = sync?.pulledAt ?? null;
  const check = lastCheck(store, key);
  const here = input.credentials ?? null;
  const hint = CREDENTIAL_HINTS[loc.provider];
  return {
    url: loc.url,
    key,
    configured: formatStoreUrl(loc),
    provider: loc.provider,
    providerName: storeKindName(loc),
    bucket: loc.bucket,
    prefix: loc.prefix,
    account: loc.account ?? null,
    region: loc.region ?? null,
    name: shortStoreName(loc),
    pushedAt,
    pulledAt,
    syncedAt: pushedAt === null && pulledAt === null ? null : Math.max(pushedAt ?? 0, pulledAt ?? 0),
    inStore: counts.inStore,
    onlyLocal: counts.onlyLocal,
    localRuns: counts.localRuns,
    localAttempts: counts.localAttempts,
    queued: counts.queued,
    check,
    access: check?.credentials ?? (here ? `${here.uses}, ${here.from}` : `${hint.uses}: ${hint.from}`),
    ciPush: input.ciPush !== false,
    ciProviders,
    settingUp: settingUp(sync?.data.setup),
  };
}

export interface ReadTeamStoreOptions {
  /** The project folder, holding shadowlap.config.json. */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** The home folder holding ~/.aws, gcloud's and az's files; for tests. */
  home?: string;
}

/** Reads what teamStoreStatus needs from the project and this machine: the config, and the store's credentials. */
export function readTeamStoreInput(options: ReadTeamStoreOptions): TeamStoreInput {
  let store: string | null = null;
  let ciPush = true;
  const configFile = join(options.cwd, 'shadowlap.config.json');
  if (existsSync(configFile)) {
    try {
      const raw = JSON.parse(readFileSync(configFile, 'utf8')) as { store?: unknown; ciPush?: unknown };
      if (typeof raw.store === 'string') store = raw.store;
      if (raw.ciPush === false) ciPush = false;
    } catch {
      // a broken config is the settings page's to report
    }
  }
  const loc = (() => {
    try {
      return store ? parseStoreUrl(store) : null;
    } catch {
      return null;
    }
  })();
  // A few environment variables and small files: cheap enough to read each time.
  const credentials = loc ? credentialsHere(loc.provider, loc, { env: options.env ?? process.env, ...(options.home ? { home: options.home } : {}) }) : null;
  return { store, ciPush, credentials };
}
