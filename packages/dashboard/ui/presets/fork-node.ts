import { presetTotals } from '../../../engine/src/chaos.js';
import { approx, num, plural, shortId } from '../format.js';
import type { LineageNode } from '../types.js';

/*
 * The error-path presets in the Forks view: a session's attempts on one recording are one node under
 * it (PresetsNode.tsx), as the design files them, never forks of their own. No DOM here: the tests
 * import it.
 */

type Marked = LineageNode & { preset: NonNullable<LineageNode['preset']> };

/** An attempt as a mark in the node's strip: lime passed, red failed, amber inconclusive. */
export interface PresetsCell {
  runId: string;
  tone: '' | 'no' | 'inc';
  card: { t: string; s: string };
}

export interface PresetsNodeView {
  /** The recording they ran on: the title opens it with its results. */
  runId: string;
  /** Failed where a preset failed, else inconclusive where one couldn't say, else passed. */
  verdict: 'failed' | 'inconclusive' | 'passed';
  /** The line: the verdict, how the presets came out, the attempts and what they spent. */
  parts: string[];
  cells: PresetsCell[];
  /** The strip's name: its attempts, by their counts. */
  label: string;
  /** At most three attempts that failed, then inconclusive ones, each opening its run at the call it hit. */
  lines: Array<{ runId: string; tone: 'no' | 'inc'; callNo: number | null; words: string }>;
  more: string;
  /** Every attempt the node holds: the page of one of them is here. */
  runs: ReadonlySet<string>;
  /** When the session's first attempt started. */
  at: number;
}

/** The marked attempts a recording's presets nodes hold: the family's other nodes leave them out. */
export const inPresets = (n: LineageNode): boolean => !!n.preset && !!n.parentRunId;

/** The presets nodes under each recording: a session's marked attempts on it, oldest session first. */
export function presetSessions(nodes: readonly LineageNode[]): Map<string, Marked[][]> {
  const sessions = new Map<string, Marked[]>();
  for (const n of nodes) {
    if (!inPresets(n)) continue;
    const key = `${n.parentRunId!}\n${n.preset!.session}`;
    sessions.set(key, [...(sessions.get(key) ?? []), n as Marked]);
  }
  const out = new Map<string, Marked[][]>();
  for (const list of [...sessions.values()].map((l) => [...l].sort((a, b) => a.startedAt - b.startedAt)).sort((a, b) => a[0]!.startedAt - b[0]!.startedAt)) {
    const parent = list[0]!.parentRunId!;
    out.set(parent, [...(out.get(parent) ?? []), list]);
  }
  return out;
}

const TONE: Readonly<Record<string, PresetsCell['tone']>> = { failed: 'no', inconclusive: 'inc' };

/** How many of each, `4 passed`, leaving out a zero. */
const each = (counts: ReadonlyArray<readonly [string, number]>): string[] => counts.filter(([, n]) => n).map(([w, n]) => `${num(n)} ${w}`);

/** A session's node: its verdict and line from how the session's presets came out, its strip and lines from its attempts. */
export function presetsNode(attempts: readonly Marked[]): PresetsNodeView {
  const { counts, spent } = attempts[0]!.preset;
  const verdict = counts.failed ? 'failed' : counts.inconclusive ? 'inconclusive' : 'passed';
  const seen = new Map<string, number>();
  const cells = attempts.map((n): PresetsCell => {
    const i = (seen.get(n.preset.label) ?? 0) + 1;
    seen.set(n.preset.label, i);
    return { runId: n.runId, tone: TONE[n.preset.verdict] ?? '', card: { t: `${n.preset.label} · attempt ${i} · ${shortId(n.runId)}`, s: n.preset.verdict } };
  });
  const count = (v: string) => attempts.filter((n) => n.preset.verdict === v).length;
  const shown = (['failed', 'inconclusive'] as const).flatMap((v) => cells.filter((c) => c.card.s === v)).slice(0, 3);
  const callOf = new Map(attempts.map((n) => [n.runId, n.preset.callNo]));
  const left = (v: 'failed' | 'inconclusive') => count(v) - shown.filter((c) => c.card.s === v).length;
  return {
    runId: attempts[0]!.parentRunId!,
    verdict,
    parts: [verdict, presetTotals(counts), plural(attempts.length, 'attempt'), ...(spent ? [approx(spent)] : [])],
    cells,
    label: `${plural(attempts.length, 'attempt')} in the order they ran: ${each([['passed', count('passed')], ['failed', count('failed')], ['inconclusive', count('inconclusive')]]).join(', ')}`,
    lines: shown.map((c) => ({ runId: c.runId, tone: c.tone === 'no' ? 'no' : 'inc', callNo: callOf.get(c.runId) ?? null, words: `${c.card.t.slice(0, c.card.t.lastIndexOf(' · '))} · ${c.card.s}` })),
    more: [...each([['more failed', left('failed')], ['more inconclusive', left('inconclusive')]]), 'each attempt is a cell above'].join(' · '),
    runs: new Set(attempts.map((n) => n.runId)),
    at: attempts[0]!.startedAt,
  };
}
