import type { ReactNode } from 'react';
import { ResultsToggle } from '../components/ResultsToggle.js';
import { GLUED_SEPARATOR } from '../format.js';
import { presetsVerdict } from '../run/preset.js';
import { useServedParts } from '../served-parts.js';
import type { ChaosMatrix } from '../types.js';

const TONE = { failed: 'blame', inconclusive: 'inc', passed: 'live' } as const;
const WORD = { failed: 'no', inconclusive: 'inc', passed: 'ok' } as const;

/**
 * What the presets came to, after the verdict: the presets that failed then those inconclusive, each
 * group's labels joined with `and` (`malformed JSON and oversized result failed · tool timeout
 * inconclusive`), or `every preset passed`, with those that didn't apply.
 */
export function presetsLine(m: ChaosMatrix): string {
  const said = (verdict: string) => {
    const labels = m.cells.filter((c) => c.verdict === verdict).map((c) => c.label);
    return labels.length ? `${labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)!}` : labels[0]!} ${verdict}` : null;
  };
  const parts = [said('failed'), said('inconclusive')].filter((x): x is string => !!x);
  if (parts.length) return parts.join(GLUED_SEPARATOR);
  return `every preset passed${m.counts.notApplicable ? `, ${m.counts.notApplicable} not applicable` : ''}`;
}

/**
 * A recording's error-path presets as a finding on its page: `error-path presets` in ink, the verdict
 * in its colour, then what came of them, wrapping whole (the bar's `.banner.wrap`), and Show results
 * at its end, which opens the matrix in the inspector's place (PresetsResults.tsx). A part of its own:
 * a copy keeps no presets, so it never draws one, and a run's page loads it as one first shows.
 */
export function PresetsFinding({ runId, m, fx, more }: { runId: string; m: ChaosMatrix; fx: boolean; more: ReactNode }) {
  const { PresetsResults } = useServedParts();
  const v = presetsVerdict(m.counts);
  return (
    <section className={`banner wrap ${TONE[v]}${fx ? ' fx' : ''}`} data-finding="presets">
      <span className="bk">error-path presets</span>
      <span className="why">
        <em className={WORD[v]}>{v}</em>
        {GLUED_SEPARATOR}
        {presetsLine(m)}
      </span>
      {PresetsResults ? (
        <span className="end">
          <ResultsToggle runId={runId} which="presets" preload={() => PresetsResults.preload()} />
        </span>
      ) : null}
      {more}
    </section>
  );
}
