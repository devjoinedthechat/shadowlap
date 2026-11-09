import type { ReactNode } from 'react';
import { ResultsToggle } from '../components/ResultsToggle.js';
import { glossed } from '../components/Term.js';
import { GLUED_SEPARATOR, glued, wholeTallies } from '../format.js';
import { useServedParts } from '../served-parts.js';
import type { InjectionFinding as Finding } from './model.js';

/** A finding's weight, as the bar draws it: a failed gate red, one that showed too little to say amber, one that passed lime. */
const TONE: Readonly<Record<Finding['gate'], string>> = { failed: 'blame', inconclusive: 'inc', passed: 'live' };
const WORD: Readonly<Record<Finding['gate'], string>> = { failed: 'no', inconclusive: 'inc', passed: 'ok' };

/**
 * A kept test's finding on the run it tested: `injection test` or `injection gate` in ink, its verdict
 * in its colour, then its line, glossed and wrapping whole (the bar's `.banner.wrap`), a gate's golden
 * after it, and Show results at its end. The results come in a part of their own (served-parts.ts),
 * so where the dashboard handed none in, the finding offers none. The finding is one too: a copy
 * keeps no results, so it never draws one, and a run's page loads it as a test's first shows.
 */
export function InjectionFinding({ runId, f, fx, more }: { runId: string; f: Finding; fx: boolean; more: ReactNode }) {
  const { InjectionResults } = useServedParts();
  return (
    <section className={`banner wrap ${TONE[f.gate]}${fx ? ' fx' : ''}`} data-finding="injection">
      <span className="bk">{f.label}</span>
      <span className="why">
        <em className={WORD[f.gate]}>{f.gate}</em>
        {GLUED_SEPARATOR}
        {glossed(glued(wholeTallies(f.line)))}
        {f.golden ? `${GLUED_SEPARATOR}${f.golden}` : null}
      </span>
      {InjectionResults ? (
        <span className="end">
          <ResultsToggle runId={runId} which={`injection:${f.resultId}`} preload={() => InjectionResults.preload()} />
        </span>
      ) : null}
      {more}
    </section>
  );
}
