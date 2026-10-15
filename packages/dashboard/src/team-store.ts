import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '@shadowlap/engine';
import { CREDENTIAL_HINTS, credentialsHere, formatStoreUrl, lastCheck, parseStoreUrl, shortStoreName, storeKindName, type LastCheck, type Provider, type StoreLocation } from '@shadowlap/remote';

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
  /** The store's identity: scheme, bucket and folder. */
  url: string;
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
  /** Runs in the store, as far as this machine knows. */
  inStore: number;
  /** Runs here that aren't in the store: the "local" tag. Runs pulled from a pull request's folder aren't counted. */
  onlyLocal: number;
  /** Ids of those runs, newest first (at most 500). */
  localRuns: string[];
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
}

/** Runs whose ids the `local` tag needs at most: the newest only-local runs. */
const LOCAL_IDS = 500;

/** The team store for `/api/meta`, or null when the config names none (or names one that isn't a store URL). Pure. */
export function teamStoreStatus(store: Store, input: TeamStoreInput): TeamStoreStatus | null {
  if (!input.store) return null;
  let loc: StoreLocation;
  try {
    loc = parseStoreUrl(input.store);
  } catch {
    return null;
  }
  const sync = store.teamSync(loc.url);
  // In the store means listed in its index, where teammates find it: a run whose upload was cut
  // short before its index segment is still only here. Counted in SQL: a store may list many
  // thousands of runs, and this is read on every /api/meta.
  const summary = store.teamSummary(loc.url);
  const local = store.teamLocalOnly(loc.url, LOCAL_IDS);
  const pushedAt = sync?.pushedAt ?? null;
  const pulledAt = sync?.pulledAt ?? null;
  const check = lastCheck(store, loc.url);
  const here = input.credentials ?? null;
  const hint = CREDENTIAL_HINTS[loc.provider];
  return {
    url: loc.url,
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
    inStore: summary.inStore,
    onlyLocal: local.count,
    localRuns: local.ids,
    queued: summary.queued,
    check,
    access: check?.credentials ?? (here ? `${here.uses}, ${here.from}` : `${hint.uses}: ${hint.from}`),
    ciPush: input.ciPush !== false,
    ciProviders: summary.ciProviders,
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
