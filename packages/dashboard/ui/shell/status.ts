import { minuteStamp, plural, whenShort } from '../format.js';

/**
 * What the status bar says, part by part, in the order it draws them: on the left the store's path
 * and the counts; on the right (after a hidden job's chip, `JobChip`) the connection, only while
 * offline or expired, read-only, where the dashboard runs or the team store it syncs with, and the
 * version. An exported copy says what it holds and that it reads only. No DOM here: the tests
 * import it. A later part joins a list's end.
 */

/** A part, by the key its fit and its styles know it by. */
export type StatusKey = 'st-store' | 'st-runs' | 'st-sync' | 'st-ro' | 'st-where' | 'st-ver';

/** A piece of a part's words: plain, a path or an address as code (`code`), or what is wrong in bold (`off`). */
export type StatusWord = string | { code: string } | { off: string };

export interface StatusPart {
  key: StatusKey;
  words: StatusWord[];
  /** Its whole, on hover: the store's full path, the team store's address, why nothing changes here. */
  title?: string;
}

/** What gives way while the bar is too narrow, first to last, each part whole with its separator; the counts, the connection and read-only stay. */
export const STATUS_GIVES_WAY: readonly StatusKey[] = ['st-ver', 'st-where', 'st-store'];

export interface StatusFacts {
  exported: boolean;
  /** The store's path as the bar shows it and whole; null until the meta has come. */
  store: { shown: string; whole: string } | null;
  runs: number | null;
  attempts: number | null;
  exportedAt: number | null;
  conn: 'ok' | 'offline' | 'expired';
  /** Why nothing changes here, for a dashboard that is read-only; null for one that can change runs. */
  readOnly: string | null;
  /** Where the dashboard's server listens. */
  address: string;
  team: { name: string; url: string; settingUp: boolean; syncedAt: number | null } | null;
  version: string | null;
  now: number;
}

/** When the team store last synced: just now, 10:14 today, Oct 1 before that, or not yet. */
function syncedWords(team: NonNullable<StatusFacts['team']>, now: number): string {
  if (team.settingUp) return 'setting up';
  if (team.syncedAt === null) return 'not synced yet';
  return `synced ${now - team.syncedAt < 60_000 && now >= team.syncedAt ? 'just now' : whenShort(team.syncedAt, now)}`;
}

export function statusParts(f: StatusFacts): { left: StatusPart[]; right: StatusPart[] } {
  const ver: StatusPart[] = f.version ? [{ key: 'st-ver', words: [`shadowlap ${f.version}`] }] : [];
  if (f.exported)
    return {
      left: [{ key: 'st-runs', words: [f.runs === null ? '…' : `${plural(f.runs, 'run')} in this copy`] }],
      right: [{ key: 'st-sync', words: [`exported${f.exportedAt ? ` ${minuteStamp(f.exportedAt, f.now)}` : ''} · read-only`] }, ...ver],
    };
  const counts = f.runs === null ? '…' : `${plural(f.runs, 'run')}${f.attempts ? ` · ${plural(f.attempts, 'attempt')}` : ''}`;
  const left: StatusPart[] = [f.store ? { key: 'st-store', words: ['store ', { code: f.store.shown }], title: f.store.whole } : { key: 'st-store', words: ['store …'] }, { key: 'st-runs', words: [counts] }];
  // "synced" is said of a team store only: of the local server the bar says only what is wrong.
  const sync: StatusPart[] = f.conn === 'offline' ? [{ key: 'st-sync', words: [{ off: 'offline' }] }] : f.conn === 'expired' ? [{ key: 'st-sync', words: [{ off: 'link expired' }] }] : [];
  const ro: StatusPart[] = f.readOnly ? [{ key: 'st-ro', words: ['read-only'], title: f.readOnly }] : [];
  const where: StatusPart = f.team ? { key: 'st-where', words: ['store ', { code: f.team.name }, ` · ${syncedWords(f.team, f.now)}`], title: `team store ${f.team.url}` } : { key: 'st-where', words: [{ code: f.address }, ' · local only'] };
  return { left, right: [...sync, ...ro, where, ...ver] };
}
