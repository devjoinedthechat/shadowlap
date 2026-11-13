import { aboutForms } from '../about.js';
import { AboutLine } from '../components/About.js';
import { FindingPanel, ResultsMatrixPart } from '../components/FindingPanel.js';
import { tipCard } from '../components/HoverCard.js';
import type { ReceiptLine } from '../components/Receipt.js';
import { RuleText } from '../components/Verdict.js';
import { approx, goldenName, minuteStamp, plural, shortId } from '../format.js';
import { cellTone, resultsKey, TONE_COLOUR, type Matrix, type MatrixCell, type MatrixCol } from '../matrix.js';
import { href } from '../route.js';
import { beforeOutcome } from '../run/preset.js';
import type { ChaosMatrix, RunAbout } from '../types.js';

/**
 * A recording's error-path presets in the inspector's place on its page (Show results, key
 * `presets`): the run against each preset on the shared matrix (FindingPanel), each cell how the
 * preset came out, its attempts on hover and the one that shows it a click away. A part of its own
 * that only the served dashboard hands in (served-parts.ts): an exported copy keeps no presets. The
 * server reads each cell (`chaosOfRun`, src/chaos.ts); this only lays them out.
 */

/** Loads the matrix's script with the panel's: the part's load calls it, so Show results opens on both. */
export const preloadMatrix = (): void => ResultsMatrixPart.preload();

/** A verdict as a cell says it: `not applicable` in words. */
const word = (verdict: string): string => verdict.replace('-', ' ');

type Cell = ChaosMatrix['cells'][number];

/** The attempt a cell opens: the first that didn't pass, else the last. */
const shownAttempt = (c: Cell): string | null => (c.runs.find((r) => !r.passed) ?? c.runs.at(-1))?.runId ?? null;

/** A cell as the matrix draws it: the verdict, `5 of 6 passed`, the gate's bound, the attempt it opens and a card with a row per attempt. */
function cellOf(c: Cell, col: MatrixCol): MatrixCell {
  const w = word(c.verdict);
  const tally = c.attempts ? `${c.passes} of ${c.attempts} passed` : null;
  const opens = shownAttempt(c);
  const rows = c.runs.map((r, i) => ({ label: `attempt ${i + 1} · ${shortId(r.runId)}`, value: r.passed ? 'passed' : `${r.verdict}${r.reason ? `: ${r.reason}` : ''}`, color: TONE_COLOUR[r.passed ? 'ok' : cellTone({ word: r.verdict })] }));
  return { word: w, tally, bound: c.bound, href: opens ? href.run(opens, c.callNo) : null, tip: tipCard([c.label, w, tally, c.bound].filter(Boolean).join(' · '), rows, col.sub ?? c.reason) };
}

/**
 * The matrix: the recording's one row, named by its short id in its label as the dialog's title names
 * it, against a column for each preset, its sub where the preset hit. Its head keeps room for the
 * about line's shortest form, so the line is cut at whole words, never given up.
 */
export function presetsMatrix(m: ChaosMatrix, about: RunAbout | null): Matrix {
  const cells = new Map(m.cells.map((c) => [c.preset, c]));
  const id = shortId(m.runId);
  return {
    id: `presets-${m.runId}`,
    label: `Error-path presets on ${id}`,
    rowInLabel: true,
    corner: 'run',
    rows: [{ key: m.runId, label: id, chip: m.golden ? goldenName(m.golden) : null, sub: about?.text ?? null, subMin: about?.text ? (aboutForms(about).filter(Boolean).at(-1) ?? null) : null }],
    cols: m.cells.map((c) => ({ key: c.preset, label: c.label, sub: beforeOutcome(c.detail) })),
    cell: (_row, col) => {
      const c = cells.get(col.key);
      return c ? cellOf(c, col) : null;
    },
  };
}

/** What ran, where and when: `6 presets · at get_ticket (#4) and model call #5 · Oct 1, 09:31`. */
export function presetsMeta(m: ChaosMatrix): string[] {
  const model = m.cells.find((c) => c.target?.kind !== 'tool' && c.callNo !== null && c.attempts > 0)?.callNo ?? null;
  const at = [...(m.toolCall ? [`${m.toolCall.name} (#${m.toolCall.callNo})`] : []), ...(model !== null ? [`model call #${model}`] : [])];
  return [plural(m.cells.length, 'preset'), ...(at.length ? [`at ${at.join(' and ')}`] : []), minuteStamp(m.at)];
}

/** The receipt: what the presets spent and that every call before the first they hit replayed free, then the requests upstream. */
export function presetsReceipt(m: ChaosMatrix): ReceiptLine[] {
  const hit = m.cells.map((c) => c.callNo).filter((n): n is number => n !== null);
  const first = hit.length ? Math.min(...hit) : null;
  return [{ parts: [`these presets spent ${approx(m.spent)}`, ...(first !== null && first > 1 ? [`every call before #${first} replayed free`] : [])] }, { parts: [plural(m.upstreamRequests, 'upstream request')] }];
}

/** What judged them: the gate's rule, and the checks with where they came from on hover, or that the agent's exit alone did. */
function judgedLine(m: ChaosMatrix) {
  const checks = m.judge?.checks ?? [];
  return [
    m.rule ? <RuleText key="rule" rule={m.rule} /> : null,
    checks.length ? (
      <span key="checks" data-tip={tipCard('The checks', [], m.judge?.from ?? null)}>
        checks: {checks.join('; ')}
      </span>
    ) : (
      <span key="checks">judged on the agent exiting 0 alone: no checks say what an error path must do</span>
    ),
  ];
}

/** The panel, from the recording's presets the page read with its finding. */
export function PresetsResults({ matrix: m, about }: { matrix: ChaosMatrix; about: RunAbout | null }) {
  const n = m.counts;
  return (
    <FindingPanel
      kind="presets"
      name="Error-path preset results"
      label="Run × presets"
      meta={presetsMeta(m)}
      cmd={m.command ?? `shadowlap ${m.golden ? `test ${m.golden}` : `replay ${m.runId}`} --chaos`}
      matrix={presetsMatrix(m, about)}
      keys={resultsKey([['failed', n.failed], ['inconclusive', n.inconclusive], ['passed', n.passed], ['not applicable', n.notApplicable]])}
      heads={{ sub: () => <AboutLine about={about} className="rmxab" /> }}
      line={judgedLine(m)}
      receipt={presetsReceipt(m)}
    />
  );
}
