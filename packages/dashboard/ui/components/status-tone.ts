import type { Tone } from './Status.js';

/**
 * The verdict words' tones, apart from Status.tsx, which every page draws: only the parts that colour
 * a word they are handed import it (Changes' revision page, the results matrix, Tests' Security), so
 * the run page, which never does, loads none of it.
 */

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
