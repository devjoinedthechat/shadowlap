import type { StoreOf } from '@shadowlap/engine';
import type { ObjectStore } from './object-store.js';

/**
 * The newest test session CI pushed to the team store, as a pull keeps it per store
 * (team_sync.data.ciSession). `shadowlap test --push` in a CI job writes the session's report under
 * `tests/` with `ci`, the CI it ran in; a teammate's own `--push` has none. Settings → CI names it
 * under Your workflow (*Last seen in CI*), never with who pushed it. A pull request's job writes
 * under `pr/<n>/`, so only your branches' sessions are seen here.
 */
export interface CiSessionSeen {
  /** The CI that ran it, as the engine's ciProvider names it: `github`, `gitlab`, `buildkite`, … or `ci`. */
  ci: string;
  /** The test session in that job's store, and the revision it tested. */
  session: string | null;
  revision: string | null;
  /** When its report was pushed, at the session's end. */
  at: number;
  /** Its goldens by each result's verdict, as the Tests page counts a session. */
  passed: number;
  failed: number;
  inconclusive: number;
}

/** What a pull keeps: the newest report key it listed, so the next lists only later ones, and the newest CI session among them. */
interface Kept {
  listed: string;
  session: CiSessionSeen | null;
}

/** A report's key: a ULID, which sorts by time. */
const REPORT_KEY = /^tests\/[0-9A-HJKMNP-TV-Z]{26}\.json$/;
/** The reports read in one pull, newest first: a CI session older than these many later ones is past the line's use. */
const MOST_READ = 50;
/** A session's report is a few KB a golden. */
const MAX_REPORT = 16 * 1024 * 1024;

function keptOf(store: StoreOf<'team'>, key: string): Kept | null {
  const data = store.teamSync(key)?.data.ciSession as Partial<Kept> | undefined;
  if (typeof data !== 'object' || data === null || typeof data.listed !== 'string') return null;
  return { listed: data.listed, session: data.session && typeof data.session.at === 'number' ? data.session : null };
}

/** The newest CI session a pull from this store kept, or null before one. */
export function lastCiSession(store: StoreOf<'team'>, key: string): CiSessionSeen | null {
  return keptOf(store, key)?.session ?? null;
}

/** A report as `test --push` wrote it, when CI pushed it: its session, revision and counts by verdict. */
export function ciSessionOf(body: string): CiSessionSeen | null {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return null;
  }
  const d = doc as { format?: unknown; version?: unknown; at?: unknown; ci?: unknown; report?: { session?: unknown; revision?: unknown; results?: unknown } };
  if (d?.format !== 'shadowlap-store-tests' || d.version !== 1 || typeof d.at !== 'number' || typeof d.ci !== 'string' || !d.ci) return null;
  const results = Array.isArray(d.report?.results) ? (d.report.results as Array<{ verdict?: unknown }>) : null;
  if (!results) return null;
  const count = (verdict: string) => results.filter((r) => r?.verdict === verdict).length;
  const text = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 80) : null);
  return { ci: d.ci.slice(0, 20), session: text(d.report?.session), revision: text(d.report?.revision), at: d.at, passed: count('passed'), failed: count('failed'), inconclusive: count('inconclusive') };
}

/**
 * Lists the reports pushed since the newest one listed before, reads them newest first, and keeps
 * the first a CI job pushed. Never throws: a store out of reach, or a report that can't be read,
 * leaves what was kept, and the pull goes on.
 */
export async function pullCiSession(store: StoreOf<'team'>, remote: ObjectStore, key: string): Promise<CiSessionSeen | null> {
  const kept = keptOf(store, key);
  try {
    const keys: string[] = [];
    for await (const o of remote.list('tests/')) if (REPORT_KEY.test(o.key) && (!kept || o.key > kept.listed)) keys.push(o.key);
    keys.sort();
    const listed = keys.at(-1);
    if (listed === undefined) return kept?.session ?? null;
    let found: CiSessionSeen | null = null;
    for (const k of keys.slice(-MOST_READ).reverse()) {
      const got = await remote.get(k, { maxBytes: MAX_REPORT }).catch(() => null);
      found = got ? ciSessionOf(got.body.toString('utf8')) : null;
      if (found) break;
    }
    const session = found ?? kept?.session ?? null;
    store.setTeamSync(key, { data: { ciSession: { listed, session } satisfies Kept } });
    return session;
  } catch {
    // The store out of reach: the line keeps what an earlier pull saw.
    return kept?.session ?? null;
  }
}
