import { TRUST_FROM } from '../../../engine/src/trust-words.js';
import { FindingPanel, ResultsMatrixPart } from '../components/FindingPanel.js';
import { tipCard } from '../components/HoverCard.js';
import type { ReceiptLine } from '../components/Receipt.js';
import { ErrorState, Skeleton } from '../components/States.js';
import { approx, minuteStamp, plural } from '../format.js';
import { useLoad } from '../hooks.js';
import { cellTone, groupRows, resultsKey, TONE_COLOUR, type Matrix, type MatrixCell, type MatrixCol, type MatrixRow, type ReadRow } from '../matrix.js';
import { href } from '../route.js';
import { useApp } from '../state.js';
import type { InjectionCellView, InjectionPanelView } from '../types.js';

/**
 * An injection test's results in the inspector's place on the run it tested (Show results, its key
 * `injection:<result id>`): its untrusted reads by its payloads on the shared matrix (FindingPanel),
 * each cell what its attempts came to, its proof on hover and its attempt a click away; past eight
 * reads, a row for each tool (`groupRows`), its cells the server's sums. A part of its own that only
 * the served dashboard hands in (served-parts.ts): an exported copy keeps no results. The server
 * decides each cell's verdict and words its proof (`view`, src/injection-view.ts); this only lays
 * them out.
 */

/** Loads the matrix's script with the panel's: the part's load calls it, so Show results opens on both. */
export const preloadMatrix = (): void => ResultsMatrixPart.preload();

const cellKey = (read: number, payload: string) => `${read}|${payload}`;

/** A cell as the matrix draws it: the verdict, its tally with its noun, the attempt it opens and its card. */
function cellOf(c: InjectionCellView, title: string, at: string): MatrixCell {
  const tally = `${c.n} of ${c.of} ${c.verdict}`;
  return {
    word: c.verdict,
    tally,
    href: c.attempt ? href.run(c.attempt.runId, c.attempt.callNo) : null,
    tip: tipCard(title, [{ label: c.verdict, value: tally, color: TONE_COLOUR[cellTone({ word: c.verdict })] }], `${at}${c.line}`),
  };
}

/** The matrix: a row for each read (its head the read's call on this run, its source under it), a column for each payload. */
export function injectionMatrix(view: InjectionPanelView, runId: string, resultId: string): Matrix {
  const reads: ReadRow[] = view.rows.map((r) => ({ callNo: r.callNo, name: r.name, worst: r.worst, row: { key: String(r.callNo), label: `#${r.callNo} ${r.name}`, href: href.run(runId, r.callNo), sub: TRUST_FROM[r.from] } }));
  const cells = new Map(view.cells.map((c) => [cellKey(c.read, c.payload), c]));
  const tools = new Map((view.tools ?? []).map((t) => [t.name, t]));
  const nameOf = new Map(view.rows.map((r) => [r.callNo, r.name]));
  const cols: MatrixCol[] = view.cols.map((p) => ({ key: p.id, label: p.id, sub: `${p.title}: ${p.text}` }));
  const cell = (row: MatrixRow, col: MatrixCol): MatrixCell | null => {
    const tool = row.key.startsWith('g:') ? tools.get(row.key.slice(2)) : undefined;
    if (tool) {
      const c = tool.cells.find((x) => x.payload === col.key);
      return c ? cellOf(c, `${plural(tool.reads.length, 'read')} of ${tool.name} · ${col.key}`, `at #${c.read}: `) : null;
    }
    const c = cells.get(cellKey(Number(row.key), col.key));
    return c ? cellOf(c, `#${c.read} ${nameOf.get(c.read) ?? ''} · ${col.key}`, '') : null;
  };
  return { id: `injection:${resultId}`, label: 'Untrusted reads by payload', corner: 'untrusted read', rows: groupRows(reads), cols, cell };
}

/** What was tried, how and when: `72 attempts · 12 templates, version 1 · Oct 1, 09:31`, who ran it first where names are shared. */
export const panelMeta = (view: InjectionPanelView): string[] => [...(view.totals.attempts ? [plural(view.totals.attempts, 'attempt')] : []), view.what, `${view.by ? `${view.by}, ` : ''}${minuteStamp(view.startedAt)}`];

/** The receipt: what the test spent, or where it stopped, then what it asked and the clean replays it compared with. */
export function panelReceipt(view: InjectionPanelView): ReceiptLine[] {
  const r = view.receipt;
  return [
    { parts: [`this test spent ${approx(r.spent)}`, r.stopReason ? `stopped: ${r.stopReason}` : 'every call before a read replayed free'] },
    { parts: [plural(r.upstreamRequests, 'upstream request'), `${plural(r.baselines, 'clean replay')} to compare with`] },
  ];
}

/** The panel's body, as the result's read comes: a skeleton, then the panel, or why it could not be read. */
export function InjectionResults({ runId, resultId }: { runId: string; resultId: string }) {
  const { client } = useApp();
  const got = useLoad(() => client.injectionResult(resultId), `injection:${resultId}`);
  if (got.error && !got.data) return <ErrorState retry={got.reload}>The results could not be read: {got.error.message}</ErrorState>;
  const view = got.data?.view;
  if (!view) return got.data ? null : <Skeleton what="the results" lines={4} />;
  const t = view.totals;
  return (
    <FindingPanel
      kind="injection"
      name="Injection test results"
      label="Untrusted reads × payloads"
      meta={panelMeta(view)}
      cmd={view.command}
      matrix={view.none ? null : injectionMatrix(view, runId, resultId)}
      none={view.none}
      keys={view.none ? null : resultsKey([['obeyed', t.obeyed], ['influenced', t.influenced], ['inconclusive', t.inconclusive], ['ignored', t.ignored]])}
      receipt={panelReceipt(view)}
    />
  );
}
