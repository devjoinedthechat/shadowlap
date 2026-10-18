import { CLOCK_PLACEHOLDERS } from './clock.js';
import { firstDifference, hintsFor } from './diff.js';
import { compilePattern, normalizerApplies } from './normalize.js';
import { commandIsImported, hasRecordedCommand } from './pack.js';
import type { Store } from './store.js';
import type { DiffEntry, DivergenceReport, Normalizer, RunRecord } from './types.js';

/**
 * `shadowlap calibrate`: a recording replayed with the same code should be clean. When it isn't,
 * whatever changed between the two runs is something the agent generates each time (a request id,
 * a temp path, a seed), and the normalizer that masks it can be proposed without asking anyone.
 */

export interface Proposal {
  normalizer: Normalizer;
  /** One line: what the value looked like, for the report. */
  why: string;
}

export interface CalibrationStep {
  proposals: Proposal[];
  /** Changes no normalizer could be proposed for; calibration stops on these. */
  unexplained: DiffEntry[];
}

const TOKEN = /[A-Za-z0-9_]/;
const PLACEHOLDER = '<VAR>';
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Whether a normalizer (proposed or configured) already makes this change disappear. */
export function covered(entry: DiffEntry, kind: DivergenceReport['kind'], name: string, normalizers: Normalizer[]): boolean {
  if (entry.op !== 'changed') return false;
  for (const n of normalizers) {
    if (!normalizerApplies(n, kind, name) || (n.path !== undefined && n.path !== entry.path)) continue;
    if (n.pattern === undefined) return true;
    if (typeof entry.before !== 'string' || typeof entry.after !== 'string') continue;
    const re = compilePattern(n.pattern);
    const a = entry.before.replace(re, n.replace);
    re.lastIndex = 0;
    if (a === entry.after.replace(re, n.replace)) return true;
  }
  return false;
}

/**
 * The varying token between two versions of a string, as a narrow regex: the fixed text just before
 * it, then the token's character class. `/tmp/fp-x8Kq2/out` and `/tmp/fp-Zp01a/out` give
 * `/\/tmp\/fp-[A-Za-z0-9_]+/`. Null when the strings differ in more than tokens.
 */
export function generalize(before: string, after: string): string | null {
  let a = before;
  let b = after;
  const parts: string[] = [];
  for (let round = 0; round < 5 && a !== b; round++) {
    let start = firstDifference(a, b);
    while (start > 0 && TOKEN.test(a[start - 1]!)) start--;
    let endA = start;
    while (endA < a.length && TOKEN.test(a[endA]!)) endA++;
    let endB = start;
    while (endB < b.length && TOKEN.test(b[endB]!)) endB++;
    const [ta, tb] = [a.slice(start, endA), b.slice(start, endB)];
    if (!ta || !tb) return null;
    // The fixed text the token is attached to (`/tmp/fp-`), or the word before it (`session `).
    let from = start;
    while (from > 0 && start - from < 16 && !/\s/.test(a[from - 1]!)) from--;
    if (start - from < 3) {
      while (from > 0 && /\s/.test(a[from - 1]!)) from--;
      while (from > 0 && start - from < 16 && !/\s/.test(a[from - 1]!)) from--;
    }
    const context = a.slice(from, start);
    if (context.trim().length < 3) return null; // too little fixed text to keep the pattern narrow
    const cls = /^\d+$/.test(ta) && /^\d+$/.test(tb) ? '\\d+' : /^[0-9a-f]+$/.test(ta) && /^[0-9a-f]+$/.test(tb) ? '[0-9a-f]+' : '[A-Za-z0-9_]+';
    const part = `${escape(context)}${cls}`;
    parts.push(part);
    const re = new RegExp(part, 'g');
    const next = (s: string) => s.replace(re, () => `${context}${PLACEHOLDER}`);
    const [na, nb] = [next(a), next(b)];
    if (na === a && nb === b) return null;
    [a, b] = [na, nb];
  }
  if (a !== b) return null;
  return `/${parts.join('|')}/`;
}

const CLOCK = new RegExp(CLOCK_PLACEHOLDERS.join('|'), 'g');
/** The clock placeholders in a value, in order (clock.ts), or '' for none. */
const clockPlaceholders = (v: unknown): string => (typeof v === 'string' ? (v.match(CLOCK) ?? []).join(' ') : '');

/** Normalizers that would make a clean replay of this divergence, and the changes none can explain. */
export function proposeNormalizers(d: DivergenceReport, existing: Normalizer[] = []): CalibrationStep {
  const proposals: Proposal[] = [];
  const unexplained: DiffEntry[] = [];
  const scope = (n: Normalizer): Normalizer => ({ kind: d.kind, ...(d.kind === 'tool' ? { name: d.name } : {}), ...n });
  for (const entry of d.diff ?? []) {
    if (covered(entry, d.kind, d.name, [...existing, ...proposals.map((p) => p.normalizer)])) continue;
    if (entry.op !== 'changed') {
      unexplained.push(entry);
      continue;
    }
    // A date masked as "today" on one side only: one of the two is further from both runs' starts,
    // which is no value generated on each run. A rule for it would hide the whole value, a real
    // change to it included; the report's hint says what to do instead.
    if (clockPlaceholders(entry.before) !== clockPlaceholders(entry.after)) {
      unexplained.push(entry);
      continue;
    }
    const hint = hintsFor(entry, d.kind, d.name)[0];
    if (hint?.normalizer) {
      proposals.push({ normalizer: hint.normalizer, why: hint.message.split(';')[0]! });
      continue;
    }
    if (typeof entry.before === 'string' && typeof entry.after === 'string') {
      const pattern = generalize(entry.before, entry.after);
      if (pattern) {
        proposals.push({ normalizer: scope({ path: entry.path, pattern, replace: PLACEHOLDER }), why: 'a value generated on each run' });
        continue;
      }
      if (entry.before.length <= 120 && entry.after.length <= 120) {
        proposals.push({ normalizer: scope({ path: entry.path, replace: PLACEHOLDER }), why: 'a short value that differs on each run' });
        continue;
      }
      unexplained.push(entry);
      continue;
    }
    if (typeof entry.before !== 'object' && typeof entry.after !== 'object') {
      proposals.push({ normalizer: scope({ path: entry.path, replace: PLACEHOLDER }), why: 'a value that differs on each run' });
      continue;
    }
    unexplained.push(entry);
  }
  return { proposals, unexplained };
}

/**
 * The recording `shadowlap calibrate` works on when none is named: the project's setup run when it
 * has one, else the newest finished recording made here (completed or failed; one imported from a
 * pack or a capture runs someone else's command, or none). Null when there is none to calibrate,
 * which the dashboard shows as "Record a run first".
 */
export function calibrationTarget(store: Store, options: { setupRunId?: string | null } = {}): { run: RunRecord; source: 'setup' | 'newest' } | null {
  const usable = (r: RunRecord) => r.mode === 'record' && (r.status === 'completed' || r.status === 'failed') && hasRecordedCommand(r) && !commandIsImported(r);
  if (options.setupRunId) {
    const run = store.getRun(options.setupRunId);
    if (run && usable(run)) return { run, source: 'setup' };
  }
  for (let limit = 50; ; limit *= 4) {
    const runs = store.finishedRecordings(limit);
    const run = runs.find(usable);
    if (run) return { run, source: 'newest' };
    if (runs.length < limit) return null;
  }
}
