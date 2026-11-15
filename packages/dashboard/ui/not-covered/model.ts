import { ENDS_ANOTHER_WAY, NOT_PACKED, nearestThen, notPackedHead } from '../../../engine/src/coverage-words.js';
import { goldenName, plural } from '../format.js';
import { commandText } from '../goldens.js';
import type { CoverageGroupView, CoverageView } from '../types.js';

/*
 * Tests › Not covered's words, worked out of the last scan as the server sends it (`/api/coverage`):
 * a behaviour in two lines from where it parts from its nearest golden, what a screen reader is told
 * of it, its details and its foot. The words the CLI's report says too come from the engine
 * (coverage-words.ts); the short ones here are the dashboard's own.
 */

type Group = Pick<CoverageGroupView, 'path' | 'writes' | 'outcome' | 'ended' | 'nearest'> & Partial<Pick<CoverageGroupView, 'unknown'>>;

/** How a run ended, at the end of line 1 and of a strip: the short words, its swatch, red where it failed. */
const END: Readonly<Record<string, { words: string; swatch: 'k-model' | 'k-err' | 'k-read' }>> = {
  answered: { words: 'answered', swatch: 'k-model' },
  'model-error': { words: 'model call failed', swatch: 'k-err' },
  'token-limit': { words: 'token limit', swatch: 'k-err' },
  'tool-call': { words: 'ended on a tool call', swatch: 'k-model' },
  'agent-error': { words: 'agent failed', swatch: 'k-err' },
  'no-model-calls': { words: 'no model calls', swatch: 'k-read' },
};

/** How a run ended, after "then it": the details' Path, and what a screen reader is told. */
const THEN: Readonly<Record<string, string>> = {
  answered: 'answered',
  'model-error': 'stopped on a model call that failed',
  'token-limit': 'stopped at the token limit',
  'tool-call': 'ended on a tool call',
  'agent-error': 'failed',
  'no-model-calls': 'made no model calls',
};

export const endOf = (g: Pick<Group, 'outcome' | 'ended'>) => END[g.outcome] ?? { words: g.ended, swatch: 'k-model' as const };
export const thenOf = (g: Pick<Group, 'outcome' | 'ended'>): string => THEN[g.outcome] ?? g.ended;

/**
 * A step on a line: a tool the model called (a write or a read; `unknown`, one whose effect nothing
 * names, which the scan counts as a write), or the reads between folded, their names on its card.
 */
export type LineStep = { name: string; write: boolean; unknown?: true } | { more: number; names: string[] };

/** The steps of `path` a line keeps: the first `head`, every write and the last; a single read between stays, more fold into one. */
export function foldSteps(path: readonly string[], writes: readonly string[], head: number, unknown: readonly string[] = []): LineStep[] {
  const keep = path.map((x, i) => i < head || writes.includes(x) || i === path.length - 1);
  const out: LineStep[] = [];
  for (let i = 0; i < path.length; ) {
    let j = i;
    while (j < path.length && !keep[j]) j++;
    if (j - i > 1) out.push({ more: j - i, names: path.slice(i, j) });
    else {
      j = i + 1;
      out.push({ name: path[i]!, write: writes.includes(path[i]!), ...(unknown.includes(path[i]!) ? { unknown: true as const } : {}) });
    }
    i = j;
  }
  return out;
}

/** The steps a behaviour shares with its nearest golden, as many as its path has. */
const sharedOf = (g: Pick<Group, 'path' | 'nearest'>): number => (g.nearest ? Math.min(g.nearest.shared, g.path.length) : 0);

/**
 * Line 1: what production did from where it parts from its nearest golden, the steps the two share
 * left out; where the two take the same steps and only end another way, its last step. Then how it
 * ended (`endOf`).
 */
export function lineSteps(g: Group): LineStep[] {
  const shared = sharedOf(g);
  const from = g.nearest && !g.nearest.differs && shared > 0 && shared === g.path.length ? shared - 1 : shared;
  return foldSteps(g.path.slice(from), g.writes, 2, g.unknown);
}

/** Line 2: where it parts from its nearest golden, the last step they share and what the golden does there; or that no golden starts this way. */
export type Where = { after: string; golden: string; calls: string | null } | { same: string } | { first: string } | null;

export function whereOf(g: Group): Where {
  const n = g.nearest;
  if (!n) return null;
  const golden = goldenName(n.golden);
  if (!n.differs) return { same: golden };
  const shared = sharedOf(g);
  return shared ? { after: g.path[shared - 1]!, golden, calls: n.differs.golden } : { first: golden };
}

/** Its nearest golden in words: `<golden>, the same for 2 steps; then …` (`sep` between), the CLI's words where the two only end another way. */
export function nearestWords(n: NonNullable<Group['nearest']>, sep: string): string {
  const then = nearestThen(n.differs);
  return `${goldenName(n.golden)}, the same for ${plural(n.shared, 'step')}${then ? `${sep}${then}` : `, ${ENDS_ANOTHER_WAY}`}`;
}

/** The tools it counts as writes for want of an effect, after its writes: ` (effect unknown: lookup_kb)`, as `shadowlap coverage` prints it; '' for none. */
const unknownWords = (g: Group): string => (g.unknown?.length ? ` (effect unknown: ${g.unknown.join(', ')})` : '');

/** A behaviour in words, as a screen reader is told its two lines (or, `alone`, a dialog's strip): its whole path, how it ended, what it wrote, and its nearest golden. */
export function coverageSaid(g: Group, alone = false): string {
  const steps = g.path.length ? `${g.path.join(', then ')}, then ` : '';
  const writes = g.writes.length ? `Writes ${g.writes.join(', ')}${unknownWords(g)}` : 'No writes';
  return `${steps}${thenOf(g)}. ${writes}.${!alone && g.nearest ? ` Nearest golden ${nearestWords(g.nearest, ', ')}.` : ''}`;
}

/** Names joined as a sentence lists them: `a`, `a and b`, `a, b and c`. */
export const andList = (names: readonly string[]): string => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}` : (names[0] ?? ''));

/** The details' Path under the path: how many tool calls, what it wrote, and how it ended. */
export const pathWords = (g: Group): string => [plural(g.path.length, 'tool call'), g.writes.length ? `writes ${andList(g.writes)}${unknownWords(g)}` : 'no writes', `then it ${thenOf(g)}`].join(' · ');

/** The goldens the scan couldn't read, which cover nothing, as `shadowlap coverage` warns of them: null where it read every one. */
export function unreadWords(v: Pick<CoverageView, 'scan'>): string | null {
  const unread = v.scan?.data?.unreadable ?? [];
  if (!unread.length) return null;
  const many = unread.length > 1;
  return `${plural(unread.length, 'golden')} can’t be read, so ${many ? 'they cover' : 'it covers'} nothing here: ${unread.map((u) => `${goldenName(u.golden)} (${u.error})`).join('; ')}`;
}

/** The last `coverage --pack` that couldn't pack it, else null: a pack that made a golden leaves nothing to try again. */
export const lastTried = (g: Pick<CoverageGroupView, 'lastPack'>) => (g.lastPack && g.lastPack.golden === null ? g.lastPack : null);

/** Why the last pack couldn't pack it: main's sentence whole, else the CLI's report's words. */
export function triedWhy(last: NonNullable<CoverageGroupView['lastPack']>): string {
  return last.why ?? (last.reason ? NOT_PACKED[last.reason] : '');
}

/** What a row of a behaviour the agent no longer does says, amber: the report's words before their brackets. */
export const NO_LONGER = notPackedHead('not-reproduced');

/** The command a pack runs: the full key, with `--fork --expect` for one with checks, then the agent's command after `--`. */
export function packCommand(key: string, o: { fork?: boolean; expect?: string; command?: string } = {}): string {
  const head = commandText(['coverage', '--pack', key, ...(o.fork ? ['--fork', '--expect', o.expect?.trim() || '<checks>'] : [])]);
  const command = o.command?.trim();
  return command ? `${head} -- ${command}` : head;
}

/**
 * Whether Not covered shows: only where there is an imported run to read, scanned or not (Q14).
 * Rescan coverage leads, lime, where runs came in that the last scan didn't read (every one, before
 * a first scan), unless the page's own step leads.
 */
export const coverageShows = (v: CoverageView | null): v is CoverageView => !!v && (v.newRuns > 0 || (v.scan?.runs ?? 0) > 0);
export const rescanLeads = (v: CoverageView | null): boolean => coverageShows(v) && v.newRuns > 0;

/** Tests at Not covered, asked by a link (`#/tests?at=notcovered`). */
export const asksNotCovered = (hash: string): boolean => /^#\/tests\?(?:[^#]*&)?at=notcovered(?:&|$)/.test(hash);
