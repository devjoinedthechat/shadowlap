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

/** Each verdict word's tone, decision 9's vocabulary and the two words a fork's writes keep. */
const VERDICT_TONE: Readonly<Record<string, Tone>> = {
  passed: 'ok',
  rescued: 'ok',
  fixed: 'ok',
  kept: 'ok',
  accepted: 'ok',
  inconclusive: 'warn',
  unsettled: 'warn',
  stopped: 'warn',
  failed: 'err',
  lost: 'err',
  'not fixed': 'err',
  broken: 'err',
  rejected: 'err',
  'not applicable': 'mu',
  stubbed: 'stub',
  blocked: 'block',
};

/**
 * The tone a verdict word takes: what held (passed, rescued, fixed, kept, accepted) is passed's,
 * what couldn't decide (inconclusive, unsettled, stopped) amber, what didn't hold (failed, lost, not
 * fixed, broken, rejected) failed's, not applicable muted, and a fork's stubbed and blocked writes
 * their own. Any other word is no verdict, and reads muted: never red for what did not fail. A word
 * that is no verdict but has a colour (a fix's verified, a setup that is done) takes it from its page.
 */
export function verdictTone(word: string): Tone {
  const w = word.trim().toLowerCase();
  return Object.hasOwn(VERDICT_TONE, w) ? VERDICT_TONE[w]! : 'mu';
}

/** A dot and a word in its tone: `<Status tone="ok">passed</Status>`. `tip`, a hover card (`tipText`/`tipCard`) saying more. */
export function Status({ tone, children, tip, title, className }: { tone: Tone; children: ReactNode; tip?: string | undefined; title?: string | undefined; className?: string | undefined }) {
  return (
    <span className={`st ${tone}${className ? ` ${className}` : ''}`} data-tip={tip} title={title}>
      <i aria-hidden="true" />
      {children}
    </span>
  );
}
