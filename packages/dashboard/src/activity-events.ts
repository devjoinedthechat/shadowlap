import { ACTIONS, confirmWords, type StoredEvent } from '@shadowlap/engine';
import type { ActivityIcon } from './views.js';
import { links } from './links.js';

/**
 * How the activity feed words the events a feature's own routes start: previews of a change and
 * migrations, error-path presets, coverage, injection tests, and a Find breaking commit that named no
 * commit. They live here, beside the feed (activity.ts spreads them into its table), not in their
 * route modules: the feed is read on a read-model thread, which loads no route module, so a
 * describer registered from one never reached it, and those events read as their bare kind there.
 */

/** How a stored event reads in the feed. */
export interface EventText {
  kind: ActivityIcon;
  text: string;
  /** Where it opens; defaults to its run, if it has one. */
  href?: string;
}

export type Describe = (event: StoredEvent, data: Record<string, unknown>) => EventText;

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const runs = (d: Record<string, unknown>) => `${Number(d.runs) || 0} run${Number(d.runs) === 1 ? '' : 's'}`;
const flagged = (d: Record<string, unknown>) => (Number(d.flagged) ? ` · ${Number(d.flagged)} with a write, stop or judged change` : '');

export const FEATURE_EVENT_TEXT: ReadonlyArray<readonly [string, Describe]> = [
  // A session of `shadowlap decisions` or `migrate` (the Changes page opens one).
  ['decisions.done', (_e, d) => ({ kind: 'fork', text: `Previewed ${typeof d.change === 'string' ? d.change : 'a change'} on ${runs(d)}${flagged(d)}` })],
  ['migrate.done', (_e, d) => ({ kind: 'fork', text: `Migration previewed: ${typeof d.change === 'string' ? d.change : 'another model'} on ${runs(d)}${flagged(d)}` })],
  // A session of presets, by how they came out; on one run, it opens that run. One with an
  // inconclusive preset and no failure reads in amber, as a test session's does.
  [
    'chaos.session',
    (e, d) => {
      const failed = count(d.failed);
      const inconclusive = count(d.inconclusive);
      const parts = [`${count(d.passed)} passed`, `${failed} failed`, ...(inconclusive ? [`${inconclusive} inconclusive`] : [])];
      return { kind: failed ? 'fail' : inconclusive ? 'warn' : 'test', text: `Error-path presets ${d.interrupted === true ? 'stopped' : 'ran'} · ${parts.join(', ')}`, href: e.runId ? links.run(e.runId) : links.tests() };
    },
  ],
  // A coverage scan, by what it found no golden covers, and what it packed.
  [
    'coverage.scanned',
    (_e, d) => {
      const uncovered = count(d.uncovered);
      const packed = count(d.packed);
      const notPacked = count(d.notPacked);
      const found = uncovered ? `${uncovered} behaviour${uncovered === 1 ? '' : 's'} without a golden` : 'every behaviour has a golden';
      return { kind: 'test', text: `Coverage read · ${found}${packed ? ` · ${packed} golden${packed === 1 ? '' : 's'} packed` : ''}${notPacked ? ` · ${notPacked} not packed` : ''}`, href: links.tests() };
    },
  ],
  // What an injection test showed, opening the run it tested. One that obeyed or failed its gate
  // reads as a failure, one inconclusive (or influenced) in amber, never as a test that passed.
  ['injection.tested', injectionText],
  // Find breaking commit that named no first bad commit: why, so the next search starts elsewhere.
  // A golden's answer opens Tests, which shows it; a run's, the run.
  ['bisect.none', (e, d) => ({ kind: 'test', text: `No first bad commit · ${e.ref ?? confirmWords(ACTIONS.findBreakingCommit.label)}${typeof d.why === 'string' && d.why ? `: ${d.why}` : ''}`, href: e.runId ? links.run(e.runId) : links.tests() })],
];

function injectionText(e: StoredEvent, d: Record<string, unknown>): EventText {
  const n = count;
  const name = typeof e.ref === 'string' && !e.ref.startsWith('inj-') ? e.ref : e.runId ? e.runId.slice(0, 10) : 'a run';
  if (d.mode === 'clean') {
    if (d.verdict === 'inconclusive') return { kind: 'warn', text: `Injection · ${name}: inconclusive, whether #${n(d.read)} caused the writes` };
    return { kind: d.verdict === 'caused' ? 'fail' : 'test', text: `Injection · ${name}: ${typeof d.verdict === 'string' ? d.verdict : 'tested'} by #${n(d.read)}` };
  }
  const text = n(d.obeyed)
    ? `obeyed a planted instruction in ${n(d.obeyed)} of ${n(d.attempts)} attempts`
    : n(d.influenced)
      ? `influenced in ${n(d.influenced)} of ${n(d.attempts)} attempts`
      : d.gate === 'inconclusive'
        ? `inconclusive after ${n(d.attempts)} attempts`
        : n(d.inconclusive)
          ? `ignored every planted instruction in ${n(d.ignored)} of ${n(d.attempts)} attempt${n(d.attempts) === 1 ? '' : 's'}, ${n(d.inconclusive)} inconclusive`
          : `ignored every planted instruction (${n(d.attempts)} attempts)`;
  return { kind: n(d.obeyed) || d.gate === 'failed' ? 'fail' : d.gate === 'inconclusive' || n(d.influenced) ? 'warn' : 'test', text: `Injection · ${name}: ${text}` };
}
