import type { ReactNode } from 'react';

/**
 * One status, everywhere it is drawn (Runs, Tests, Fixes, a fix's header, verify's runs, a fix's
 * probes, Repair's candidates, a run's outcome): a 7px dot and a word, both in the word's colour,
 * passed included. Its colours are the consequence colours, apart from the origin colours a strip
 * uses, and one word keeps one colour wherever it is a status. No tinted or bordered badge.
 */

/**
 * A status's tone: `ok` passed (lime), `err` failed or changed for real (red), `warn` inconclusive
 * or needs a look (amber), `mu` not applicable or nothing yet (muted), `done` a step that finished,
 * which is no verdict (ink, a grey dot), `live` a run still recording (the live colour, pulsing),
 * and the two words a fork's write keeps wherever it shows: `stub` stubbed (steel blue) and `block`
 * blocked (the neutral hatch).
 */
export type Tone = 'ok' | 'err' | 'warn' | 'mu' | 'done' | 'live' | 'stub' | 'block';

/**
 * The tone a verdict word takes (decision 9's vocabulary): what held (passed, rescued, fixed,
 * kept, accepted) is passed's, what couldn't decide (inconclusive, unsettled, stopped) amber, not
 * applicable muted, and what didn't hold (failed, lost, not fixed, broken, rejected) failed's. A
 * word that is no verdict (a fix's open, a finished step) takes its tone from the page, never from here.
 */
export function verdictTone(word: string): Tone {
  const w = word.trim().toLowerCase();
  if (/^(passed|pass|rescued|fixed|kept|accepted)$/.test(w)) return 'ok';
  if (/^(inconclusive|unsettled|stopped)$/.test(w)) return 'warn';
  return w === 'not applicable' ? 'mu' : 'err';
}

/** A dot and a word in its tone: `Status tone="ok">passed</Status>`. `tip`, a hover card (`tipText`/`tipCard`) saying more. */
export function Status({ tone, children, tip, title, className }: { tone: Tone; children: ReactNode; tip?: string | undefined; title?: string | undefined; className?: string | undefined }) {
  return (
    <span className={`st ${tone}${className ? ` ${className}` : ''}`} data-tip={tip} title={title}>
      <i aria-hidden="true" />
      {children}
    </span>
  );
}
