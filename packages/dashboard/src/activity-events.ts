import { ACTIONS, confirmWords, DECISIONS_ID, goldenWords, isObject, MIGRATE_ID, presetTotals, type StoredEvent } from '@shadowlap/engine';
import type { ActivityIcon } from './views.js';
import { links } from './links.js';

/**
 * How the activity feed words the events a feature's own routes start: previews of a change and
 * migrations, error-path presets, coverage, injection tests, a Find breaking commit that named no
 * commit, and a golden's checks changed in the check builder. They live here, beside the feed (activity.ts spreads them into its table), not in their
 * route modules: the feed is read on a read-model thread, which loads no route module, so a
 * describer registered from one never reached it, and those events read as their bare kind there.
 */

/** How a stored event reads in the feed. */
export interface EventText {
  kind: ActivityIcon;
  /** Its colour when it failed (`err`) or couldn't decide, stopped or needs a look (`warn`): ActivityItem's. */
  outcome?: 'err' | 'warn';
  text: string;
  /** Where it opens; defaults to its run, if it has one. */
  href?: string;
}

export type Describe = (event: StoredEvent, data: Record<string, unknown>) => EventText;

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const runs = (d: Record<string, unknown>) => `${Number(d.runs) || 0} run${Number(d.runs) === 1 ? '' : 's'}`;
/** A preview by its name, lower-cased to run on in a sentence (`model switch to claude-haiku-4-5`), else its change in words. */
const previewName = (d: Record<string, unknown>) => (typeof d.name === 'string' && d.name ? `${d.name.charAt(0).toLowerCase()}${d.name.slice(1)}` : typeof d.change === 'string' ? d.change : 'a change');
const flagged = (d: Record<string, unknown>) => (Number(d.flagged) ? ` · ${Number(d.flagged)} with a write, stop or judged change` : '');
/** A migration's event opens its report, when its ref is the migration's id. */
const migrationAt = (e: StoredEvent): { href?: string } => (e.ref && MIGRATE_ID.test(e.ref) ? { href: links.changeSession('migrate', e.ref) } : {});
/** The labels an event names, as text. */
const labels = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export const FEATURE_EVENT_TEXT: ReadonlyArray<readonly [string, Describe]> = [
  // A session of `shadowlap decisions` or `migrate`, by its name; one kept before events had a name,
  // by its change. One that settled nothing says why, as its page does. A preview opens on its tab
  // under Changes, at its session; a migration, at its report under Changes › Migrate.
  [
    'decisions.done',
    (e, d) => {
      const at = e.ref && DECISIONS_ID.test(e.ref) ? { href: links.changeSession('decisions', e.ref) } : {};
      if (typeof d.why === 'string' && d.why) return { kind: 'fork', outcome: 'warn', text: `Preview inconclusive · ${previewName(d)} on ${runs(d)} · ${d.why}`, ...at };
      return { kind: 'fork', text: `Previewed ${previewName(d)} on ${runs(d)}${flagged(d)}`, ...at };
    },
  ],
  [
    'migrate.done',
    (e, d) => {
      const at = migrationAt(e);
      const change = typeof d.change === 'string' ? d.change : 'another model';
      if (typeof d.why === 'string' && d.why) return { kind: 'fork', outcome: 'warn', text: `Migration inconclusive · ${change} on ${runs(d)} · ${d.why}`, ...at };
      return { kind: 'fork', text: `Migration previewed: ${change} on ${runs(d)}${flagged(d)}`, ...at };
    },
  ],
  // `shadowlap migrate apply`: the switch went into the working tree, with the goldens it left to update.
  [
    'migrate.applied',
    (e, d) => {
      const from = labels(d.from);
      const left = labels(d.outdated).length;
      const to = typeof d.to === 'string' ? d.to : 'another model';
      return { kind: 'setting', text: `Config change applied · ${from.length ? `${from.join(', ')} → ` : ''}${to}${left ? ` · ${left} golden${left === 1 ? '' : 's'} to update` : ''}`, ...migrationAt(e) };
    },
  ],
  // A session of presets, in the tests' shape coloured by how they came out; on one run, it opens
  // that run. One with an inconclusive preset and no failure, or one stopped, reads in amber.
  [
    'chaos.session',
    (e, d) => {
      const failed = count(d.failed);
      const inconclusive = count(d.inconclusive);
      const totals = presetTotals({ passed: count(d.passed), failed, inconclusive, notApplicable: count(d.notApplicable) });
      const outcome = failed ? 'err' : inconclusive || d.interrupted === true ? 'warn' : null;
      return { kind: 'test', ...(outcome ? { outcome } : {}), text: `Error-path presets ${d.interrupted === true ? 'stopped' : 'ran'} · ${totals}`, href: e.runId ? links.run(e.runId) : links.tests() };
    },
  ],
  // A coverage scan, by what it found no golden covers, and what it packed: amber while a behaviour has no golden. It opens
  // Tests at Not covered, which lists them.
  [
    'coverage.scanned',
    (_e, d) => {
      const uncovered = count(d.uncovered);
      const packed = count(d.packed);
      const notPacked = count(d.notPacked);
      const found = uncovered ? `${uncovered} behaviour${uncovered === 1 ? '' : 's'} without a golden` : 'every behaviour has a golden';
      return { kind: 'test', ...(uncovered || notPacked ? { outcome: 'warn' as const } : {}), text: `Coverage read · ${found}${packed ? ` · ${packed} golden${packed === 1 ? '' : 's'} packed` : ''}${notPacked ? ` · ${notPacked} not packed` : ''}`, href: links.tests({ at: 'notcovered' }) };
    },
  ],
  // What an injection test showed, opening the run it tested. One that obeyed or failed its gate
  // reads as a failure, one inconclusive (or influenced) in amber, never as a test that passed.
  ['injection.tested', injectionText],
  // Find breaking commit that named no first bad commit: why, so the next search starts elsewhere.
  // A golden's answer opens Tests, which shows it; a run's, the run.
  // Settings → Tools' declaration of what a tool Shadowlap doesn't record does, and the Undo that takes one out.
  ['tool.unrecorded', (e, d) => ({ kind: 'setting', text: `${d.effect === 'read' || d.effect === 'write' ? `Unrecorded tool declared a ${d.effect}` : 'Unrecorded tool declaration removed'} · ${e.ref ?? 'a tool'}`, href: links.settings('tools') })],
  ['bisect.none', (e, d) => ({ kind: 'test', outcome: 'warn', text: `No first bad commit · ${e.ref ?? confirmWords(ACTIONS.findBreakingCommit.label)}${typeof d.why === 'string' && d.why ? `: ${d.why}` : ''}`, href: e.runId ? links.run(e.runId) : links.tests() })],
  // A golden's checks changed in the check builder (routes/checks.ts records it): what it gained, or
  // lost, by the golden's name; its ref stays the path.
  [
    'checks.changed',
    (e, d) => {
      const [added, removed, golden] = [labels(d.added), labels(d.removed), e.ref ? goldenWords(e.ref) : 'a golden'];
      // Pack with injection gate…'s write: the golden's gate, which has no check's labels.
      if (d.gate !== undefined) return { kind: 'setting', text: `Injection gate added · ${golden}`, href: links.tests() };
      const text = added.length && !removed.length ? `Check added · ${golden}: ${added.join('; ')}` : removed.length && !added.length ? `Check removed · ${golden}: ${removed.join('; ')}` : `Checks changed · ${golden}`;
      return { kind: 'setting', text, href: links.tests() };
    },
  ],
];

/** `#28`, `#28 and #31`, `#28, #31 and #40`. */
const listWords = (words: readonly string[]): string => (words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)!}` : (words[0] ?? ''));

function injectionText(e: StoredEvent, d: Record<string, unknown>): EventText {
  const n = count;
  const name = typeof e.ref === 'string' && !e.ref.startsWith('inj-') ? e.ref : e.runId ? e.runId.slice(0, 10) : 'a run';
  if (d.mode === 'clean') {
    // Find cause…'s question and its answer: `Asked whether #4 caused #28 · caused`, the writes asked of as the CLI recorded them.
    const asked = Array.isArray(d.writes) ? d.writes.map((w: unknown) => (isObject(w) ? n(w.callNo) : 0)).filter((w) => w > 0) : [];
    const writes = asked.length ? listWords(asked.map((w) => `#${w}`)) : 'its writes';
    const verdict = d.verdict === 'caused' || d.verdict === 'not caused' ? d.verdict : 'inconclusive';
    const text = `Asked whether #${n(d.read)} caused ${writes} · ${verdict}`;
    if (verdict === 'inconclusive') return { kind: 'warn', outcome: 'warn', text };
    return { kind: verdict === 'caused' ? 'fail' : 'test', ...(verdict === 'caused' ? { outcome: 'err' as const } : {}), text };
  }
  const text = n(d.obeyed)
    ? `obeyed a planted instruction in ${n(d.obeyed)} of ${n(d.attempts)} attempts`
    : n(d.influenced)
      ? `influenced in ${n(d.influenced)} of ${n(d.attempts)} attempts`
      : d.gate === 'inconclusive'
        ? `inconclusive after ${n(d.attempts)} attempts`
        : n(d.inconclusive)
          ? `ignored every planted instruction in ${n(d.ignored)} of ${n(d.attempts)} attempt${n(d.attempts) === 1 ? '' : 's'}, ${n(d.inconclusive)} inconclusive`
          : `ignored every planted instruction · ${n(d.attempts)} attempt${n(d.attempts) === 1 ? '' : 's'}`;
  const outcome = n(d.obeyed) || d.gate === 'failed' ? 'err' : d.gate === 'inconclusive' || n(d.influenced) ? 'warn' : null;
  return { kind: outcome === 'err' ? 'fail' : outcome === 'warn' ? 'warn' : 'test', ...(outcome ? { outcome } : {}), text: `Injection · ${name}: ${text}` };
}
