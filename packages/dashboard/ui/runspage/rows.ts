/**
 * The Runs table's rows as pages of them are read. When the runs move (a run started, ended or was
 * deleted; a push or a pull changed which are only here), the table reads its first page again, and
 * only that: the rows read before that come after the new first page stay as they were, from where it
 * ends. A row further down is read again when its page is (Show more, or a change to what the table
 * shows). No DOM here: the tests import it.
 */

import { indexingNote } from '../palette.js';
import type { ChipCounts } from '../types.js';

/** The rows after the first page was read again: it, then those read before that come after it; `kept` counts those. */
export function withFirstPage<R extends { runId: string }>(had: readonly R[], first: readonly R[]): { rows: R[]; kept: number } {
  const last = first.at(-1);
  if (!last) return { rows: [], kept: 0 };
  const shown = new Set(first.map((r) => r.runId));
  // Where the new first page ends in the rows read before: a run new at the top pushed the rest down.
  const at = had.findIndex((r) => r.runId === last.runId);
  const rest = (at >= 0 ? had.slice(at + 1) : had.slice(first.length)).filter((r) => !shown.has(r.runId));
  return { rows: [...first, ...rest], kept: rest.length };
}

/**
 * What the table says while the server is still working out what its filter or its sort reads: the
 * verdicts `status:` reads (`what`), the about lines the filter's words match, or what runs spent.
 */
export function warmingLine(w: { done: number; total: number; what?: 'verdicts' } | null | undefined, o: { filtered: boolean; bySpent: boolean }): string | null {
  if (!w || w.done >= w.total) return null;
  const of = `${w.done.toLocaleString('en-US')} of ${w.total.toLocaleString('en-US')}`;
  if (w.what === 'verdicts') return `The verdicts of ${of} runs are known so far: runs among the rest may match too. The table fills in as they are worked out.`;
  if (o.filtered) return `The about lines of ${of} runs are known so far: runs among the rest may match too. The table fills in as they are worked out.`;
  if (o.bySpent) return `What ${of} runs spent is added up so far: the rest may sort higher. The table reorders as they are.`;
  return null;
}

/** The line under the table's head while what it shows is still coming: what is worked out (`warmingLine`), else what the search index has yet to read for the filter's words. */
export function tableNote(t: { warming: Parameters<typeof warmingLine>[0]; indexing?: { runs: number; of: number } | null }, o: { filtered: boolean; bySpent: boolean }): string | null {
  return warmingLine(t.warming, o) ?? indexingNote(t.indexing);
}

/** A page's chip counts less the runs a delete waits to take (or took, until the page is read again): each from All, and from each chip it counts under. */
export function lessChips(counts: ChipCounts | null, gone: ReadonlyArray<{ chips: readonly string[] }>): ChipCounts | null {
  if (!counts || !gone.length) return counts;
  const out: ChipCounts = { ...counts };
  for (const r of gone) {
    out.all = Math.max(0, out.all - 1);
    for (const c of r.chips) if (c in out) out[c as keyof ChipCounts] = Math.max(0, out[c as keyof ChipCounts] - 1);
  }
  return out;
}
