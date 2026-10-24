import { setOwn } from './canonical.js';

/**
 * Dates and times near a run's start, masked for matching. An agent that puts "Today is 2026-09-16"
 * in its prompt sends a different request tomorrow, so a replay would fork at the first call for a
 * reason nobody chose. Before fingerprinting, every date, timestamp or epoch value within about a
 * day of the run's own start becomes a placeholder: the recording's "today" and the replay's "today"
 * both read `<date>`, however far apart the two runs are. Dates further away stay as they are, so
 * a real change to one still forks.
 *
 * A replay is matched against two references, its own start and the recording's, on both sides: a
 * value the replay served back from the recording (a tool result, `now()`) carries the recording's
 * "today" into the replay's requests, and the same request must read the same on both sides.
 *
 * It applies to matching only: stored requests keep their values, and the agent's clock is never
 * touched, so live calls after a fork carry the real time (request signing depends on it).
 * `"clock": "exact"` in shadowlap.config.json turns it off.
 */

export type ClockMode = 'auto' | 'exact';

const HOUR = 3_600_000;
/** How far from the reference a timestamp may be and still read as "now". */
export const CLOCK_WINDOW_MS = 36 * HOUR;
/** Calendar dates carry no time zone, so they get a day more. */
const DATE_WINDOW_MS = 60 * HOUR;

export const CLOCK_PLACEHOLDERS = ['<datetime>', '<date>', '<epoch>'] as const;

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const MONTH = '(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\\.?';
const WEEKDAY = '(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Tues|Wed|Thu|Thurs|Fri|Sat|Sun),?\\s+)?';
const monthIndex = (name: string) => MONTHS[name.slice(0, 3).toLowerCase()] ?? -1;

interface Rule {
  re: RegExp;
  placeholder: (typeof CLOCK_PLACEHOLDERS)[number];
  window: number;
  /** Milliseconds since the epoch for a match, or NaN to leave it alone. */
  time: (m: RegExpExecArray) => number;
}

// Order matters: a datetime is masked before the date inside it could be.
const RULES: Rule[] = [
  {
    // 2026-09-16T10:31:22.123Z, 2026-09-16 10:31, with or without an offset
    re: /\b(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?/g,
    placeholder: '<datetime>',
    window: CLOCK_WINDOW_MS,
    time: (m) => Date.parse(`${m[1]}T${m[2]}${m[3] ? (m[3] === 'Z' ? 'Z' : m[3].length === 5 ? `${m[3].slice(0, 3)}:${m[3].slice(3)}` : m[3]) : 'Z'}`),
  },
  {
    // Wed, 16 Sep 2026 10:31:22 GMT (HTTP dates, toUTCString)
    re: new RegExp(`${WEEKDAY}(\\d{1,2}) ${MONTH} (\\d{4}) (\\d{2}:\\d{2}:\\d{2}) (GMT|UTC|[+-]\\d{4})`, 'g'),
    placeholder: '<datetime>',
    window: CLOCK_WINDOW_MS,
    time: (m) => Date.parse(`${m[1]} ${m[2]} ${m[3]} ${m[4]} ${m[5]}`),
  },
  {
    // Wed Sep 16 2026 10:31:22 GMT+0200 (Central European Summer Time): Date.prototype.toString
    re: new RegExp(`${WEEKDAY}${MONTH} (\\d{1,2}) (\\d{4}) (\\d{2}:\\d{2}:\\d{2}) GMT([+-]\\d{4})(?: \\([^)]*\\))?`, 'g'),
    placeholder: '<datetime>',
    window: CLOCK_WINDOW_MS,
    time: (m) => Date.parse(`${m[2]} ${m[1]} ${m[3]} ${m[4]} GMT${m[5]}`),
  },
  {
    // 2026-09-16
    re: /\b(\d{4})-(\d{2})-(\d{2})\b/g,
    placeholder: '<date>',
    window: DATE_WINDOW_MS,
    time: (m) => Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
  },
  {
    // Wednesday, September 16, 2026 · Sep 16 2026 · September 16th, 2026
    re: new RegExp(`${WEEKDAY}${MONTH} (\\d{1,2})(?:st|nd|rd|th)?,? (\\d{4})\\b`, 'g'),
    placeholder: '<date>',
    window: DATE_WINDOW_MS,
    time: (m) => Date.UTC(Number(m[3]), monthIndex(m[1]!), Number(m[2])),
  },
  {
    // Wednesday, 16 September 2026 · 16th Sep 2026
    re: new RegExp(`${WEEKDAY}(\\d{1,2})(?:st|nd|rd|th)? ${MONTH},? (\\d{4})\\b`, 'g'),
    placeholder: '<date>',
    window: DATE_WINDOW_MS,
    time: (m) => Date.UTC(Number(m[3]), monthIndex(m[2]!), Number(m[1])),
  },
  {
    // Epoch milliseconds, and seconds with or without a fraction (Date.now(), time.time())
    re: /\b(\d{13}|\d{10}(?:\.\d{1,9})?)\b/g,
    placeholder: '<epoch>',
    window: CLOCK_WINDOW_MS,
    time: (m) => (m[1]!.length === 13 ? Number(m[1]) : Number(m[1]) * 1000),
  },
];

/** One run's start, or several (a replay's and its recording's): a value near any of them is masked. */
export type ClockReference = number | readonly number[];

const near = (t: number, reference: ClockReference, window: number) => Number.isFinite(t) && (typeof reference === 'number' ? Math.abs(t - reference) <= window : reference.some((r) => Math.abs(t - r) <= window));

/** Whether a time (ms) is within `window` of the reference, or of any of them for a list: what masking reads as "now". */
export const nearClock = near;

/**
 * Told each date, time or epoch value masking reads, masked or not: its time in ms and how near a
 * reference it has to be to be masked. A request that masks the same against two references is one
 * whose every such value is near both or near neither (the sidecar's fingerprint cache).
 */
export type ClockSeen = (time: number, window: number) => void;

export function maskClockText(text: string, reference: ClockReference, seen?: ClockSeen): string {
  // Every form above has a run of at least four digits; most strings in a request have none.
  if (!/\d{4}/.test(text)) return text;
  let out = text;
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray;
      const time = rule.time(m);
      seen?.(time, rule.window);
      return near(time, reference, rule.window) ? rule.placeholder : m[0];
    });
  }
  return out;
}

/** A copy of a JSON-like value with dates, timestamps and epoch values near `reference` (any of them, for a list) masked. */
export function maskClock(value: unknown, reference: ClockReference, seen?: ClockSeen): unknown {
  if (typeof value === 'string') return maskClockText(value, reference, seen);
  if (typeof value === 'number') {
    const ms = Number.isInteger(value) && value >= 1e12 && value < 1e13 ? value : value >= 1e9 && value < 1e10 ? value * 1000 : NaN;
    if (seen && Number.isFinite(ms)) seen(ms, CLOCK_WINDOW_MS);
    return near(ms, reference, CLOCK_WINDOW_MS) ? '<epoch>' : value;
  }
  if (Array.isArray(value)) return value.map((v) => maskClock(v, reference, seen));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) setOwn(out, k, maskClock(v, reference, seen));
    return out;
  }
  return value;
}
