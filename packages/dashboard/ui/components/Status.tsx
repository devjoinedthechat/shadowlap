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
 * `fk` what came of a fork's writes where no check judges it (quiet, a neutral dot), and the two
 * words a fork's write keeps wherever it shows: `stub` stubbed (steel blue) and `block` blocked (the
 * neutral hatch).
 */
export type Tone = 'ok' | 'err' | 'warn' | 'mu' | 'done' | 'live' | 'fk' | 'stub' | 'block';

/** Each verdict word's tone: decision 9's vocabulary, an injection test's, and the two words a fork's writes keep. */
const VERDICT_TONE: Readonly<Record<string, Tone>> = {
  passed: 'ok',
  rescued: 'ok',
  fixed: 'ok',
  kept: 'ok',
  accepted: 'ok',
  inconclusive: 'warn',
  unsettled: 'warn',
  stopped: 'warn',
  'not rescued': 'warn',
  incomplete: 'warn',
  influenced: 'warn',
  failed: 'err',
  lost: 'err',
  'not fixed': 'err',
  broken: 'err',
  rejected: 'err',
  obeyed: 'err',
  caused: 'err',
  'not applicable': 'mu',
  ignored: 'mu',
  'not caused': 'mu',
  stubbed: 'stub',
  blocked: 'block',
};

/**
 * The tone a status's verdict word takes: what held (passed, rescued, fixed, kept, accepted) is
 * passed's, what couldn't decide (inconclusive, unsettled, stopped, a blame no call rescued, a
 * verify that didn't finish, a payload that influenced the agent) amber, what didn't hold (failed,
 * lost, not fixed, broken, rejected, a payload the agent obeyed or that caused what it did) failed's,
 * what showed nothing (not applicable, a payload ignored or that caused nothing) muted, and a fork's
 * stubbed and blocked writes their own. Any other word is no verdict, and reads muted: never red for
 * what did not fail. A word that is no verdict but has a colour (a fix's verified, a setup that is
 * done) takes it from its page. Not fixes/model.ts's `verdictTone`, a fix step's verdict in that
 * page's tones.
 */
export function statusTone(word: string): Tone {
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
