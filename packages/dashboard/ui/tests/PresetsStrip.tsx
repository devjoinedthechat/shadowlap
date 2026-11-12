import type { PresetsEntryRow } from '../../src/presets-entries.js';
import type { GoldenRow } from '../api.js';
import { tipCard, type TipRow } from '../components/HoverCard.js';
import { TestsJobButton } from '../fixes/TestsJobButton.js';
import { ACTIONS } from '../labels.js';
import { href } from '../route.js';
import { openResults } from '../run/panel-state.js';
import type { LeadPress } from './Verdict.js';

/** What a golden's presets wait for, in the server's words: they share the test lane. */
const PRESETS_VERB = 'run its presets';

type Presets = NonNullable<GoldenRow['presets']>;
type Cell = Presets['cells'][number];

const TONE: Record<string, string> = { passed: 'ok', failed: 'err', inconclusive: 'warn' };
const COLOUR: Record<string, string> = { passed: 'var(--cq-lime)', failed: 'var(--cq-red)', inconclusive: 'var(--cq-amber)' };

/** The strip's counts, the verdicts there are: `1 failed · 1 inconclusive · 4 passed`. */
export function presetsCounts(p: Pick<Presets, 'failed' | 'inconclusive' | 'passed'>): string {
  return (['failed', 'inconclusive', 'passed'] as const)
    .filter((v) => p[v])
    .map((v) => `${p[v]} ${v}`)
    .join(' · ');
}

/** A preset's cell's card: its words, its verdict with its tally where it took several attempts, and the call it hit. */
export function presetCard(c: Cell): string {
  const rows: TipRow[] = [{ label: c.verdict, value: c.attempts > 1 ? `${c.passes} of ${c.attempts}` : '', color: COLOUR[c.verdict] ?? 'var(--cq-muted)' }];
  if (c.callNo !== null) rows.push({ label: 'at', value: `#${c.callNo}` });
  return tipCard(c.label, rows);
}

/**
 * A golden's error-path presets under its checks, as the design draws them: `error-path presets`,
 * which opens its recording with their results, a cell a preset in its verdict's colour (one picture,
 * named by its counts, each cell's card on hover: no Tab stop, as a strip's cells have none), then
 * the counts, which open the attempt that proves the verdict. A golden whose tests entry sets its
 * presets, none run yet, says so and offers Run error-path presets…, which waits as Tests' buttons
 * do while a session runs (its presets share the test lane).
 */
export function PresetsStrip({ row, press }: { row: GoldenRow & PresetsEntryRow; press: Pick<LeadPress, 'wait' | 'onPresets'> | undefined }) {
  const p = row.presets;
  if (!p) {
    const source = row.source;
    if (!row.presetsEntry || source.kind !== 'run' || !press?.onPresets) return null;
    const open = press.onPresets;
    return (
      <div className="gpstrip">
        <span className="gpk">error-path presets</span>
        <span className="gpn">not run yet</span>
        <TestsJobButton className="linkbtn" verb={PRESETS_VERB} off={press.wait(PRESETS_VERB)} onClick={() => open(source.runId)}>
          {ACTIONS.runPresets.label}
        </TestsJobButton>
      </div>
    );
  }
  const counts = presetsCounts(p);
  return (
    <div className="gpstrip">
      <a
        className="gpk"
        href={href.run(p.recording)}
        onClick={(e) => {
          e.stopPropagation();
          openResults(p.recording, 'presets');
        }}
      >
        error-path presets
      </a>
      <span className="pcells" role="img" aria-label={`${p.ran} preset${p.ran === 1 ? '' : 's'}: ${counts.replaceAll(' · ', ', ')}`}>
        {p.cells.map((c) => (
          <i key={c.label} className={`pc ${TONE[c.verdict] ?? 'n'}`} data-tip={presetCard(c)} />
        ))}
      </span>
      {p.runId ? (
        <a className="gpn" href={href.run(p.runId)} onClick={(e) => e.stopPropagation()}>
          {counts}
        </a>
      ) : (
        <span className="gpn">{counts}</span>
      )}
    </div>
  );
}
