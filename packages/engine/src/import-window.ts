/**
 * The window `shadowlap import langfuse|phoenix|logfire` reads without a trace id, checked as the CLI
 * checks it (cli/src/commands/import.ts), for the dashboard's Import capture, which says what is wrong
 * with a field before a job starts, and passes each as one argument. `since` and `until` are a date
 * (2026-09-30), a time (2026-09-30T14:00Z) or how long ago (30d, 12h); `limit` is 1 to 10,000 traces;
 * `traceName` a trace's name on one line. Logfire takes `since` with a trace id too: how far back that
 * trace may have started. No Node imports: the dashboard's browser bundle uses this too.
 */

export interface ImportWindow {
  since?: string | undefined;
  until?: string | undefined;
  limit?: string | undefined;
  traceName?: string | undefined;
}

/** The window's fields as the CLI's flags name them. */
export const IMPORT_WINDOW_FLAGS: Readonly<Record<keyof ImportWindow, string>> = { since: '--since', until: '--until', limit: '--limit', traceName: '--trace-name' };

/** The most traces one import reads. */
export const IMPORT_LIMIT_MAX = 10_000;

const DAY = 86_400_000;

/** A moment as the CLI reads one, in milliseconds; null when it isn't one. */
export function importMoment(raw: string, now: number = Date.now()): number | null {
  const v = raw.trim();
  const ago = /^(\d{1,4})([dh])$/.exec(v);
  if (ago) return now - Number(ago[1]) * (ago[2] === 'd' ? DAY : 3_600_000);
  if (!/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const at = new Date(v).getTime();
  return Number.isNaN(at) ? null : at;
}

/** Why a field of the window can't be read, in the CLI's words; null when it can, or is empty. */
export function importWindowFieldProblem(field: keyof ImportWindow, raw: string | undefined, now: number = Date.now()): string | null {
  const v = raw?.trim() ?? '';
  if (!v) return null;
  const flag = IMPORT_WINDOW_FLAGS[field];
  if (field === 'limit') return /^\d{1,5}$/.test(v) && Number(v) >= 1 && Number(v) <= IMPORT_LIMIT_MAX ? null : `${flag}: a number of traces from 1 to ${IMPORT_LIMIT_MAX}, not "${v}"`;
  if (field === 'traceName') return v.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v) ? null : `${flag}: a trace's name as the store shows it, on one line`;
  const at = importMoment(v, now);
  if (at === null) return `${flag}: a date (2026-09-30), a time (2026-09-30T14:00Z), or how long ago (30d, 12h), not "${v}"`;
  return field === 'since' && at > now ? `${flag}: "${v}" is not a moment in the past` : null;
}

/** Why the window can't be read, the first field's problem, or `--until` not after `--since`; null when it can. */
export function importWindowProblem(w: ImportWindow, now: number = Date.now()): string | null {
  for (const field of Object.keys(IMPORT_WINDOW_FLAGS) as Array<keyof ImportWindow>) {
    const problem = importWindowFieldProblem(field, w[field], now);
    if (problem) return problem;
  }
  const since = w.since?.trim() ? importMoment(w.since, now)! : now - 30 * DAY;
  const until = w.until?.trim() ? importMoment(w.until, now)! : now;
  if (until > since) return null;
  return w.until?.trim() ? `--until: "${w.until.trim()}" is not after --since` : `--since: "${w.since!.trim()}" is not a moment in the past`;
}

/** The window as the CLI's arguments, each field given as one (`--since=7d`), so no value is read as a flag. */
export function importWindowArgs(w: ImportWindow): string[] {
  return (Object.keys(IMPORT_WINDOW_FLAGS) as Array<keyof ImportWindow>).flatMap((field) => {
    const v = w[field]?.trim();
    return v ? [`${IMPORT_WINDOW_FLAGS[field]}=${v}`] : [];
  });
}
