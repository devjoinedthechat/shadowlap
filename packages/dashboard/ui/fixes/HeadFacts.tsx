import { repairOutcomeWord } from '../../../engine/src/repair-words.js';
import { tipCard, type TipRow } from '../components/HoverCard.js';
import { approx, GLUED_SEPARATOR, num, shortId } from '../format.js';
import { personName } from '../person.js';
import type { FixDetail } from '../types.js';
import { fixName, fixStamp, laterStamp } from './model.js';

/**
 * What a fix's page says of it beyond its steps, each with a card where it holds more: its good runs
 * by id; who opened it and who applied it, named where checks are shared (elsewhere the server names
 * no one); how it was applied; the runs a check given since left out; what everything behind it took;
 * each check it has had; and the repairs the Repair step doesn't show.
 */

const by = (who: string | null | undefined): string => (who ? ` by ${personName(who)}` : '');
const s = (n: number): string => (n === 1 ? '' : 's');
/** The first five runs by id, then how many more. */
const ids = (runs: readonly string[]): string => runs.slice(0, 5).map(shortId).join(', ') + (runs.length > 5 ? ` and ${runs.length - 5} more` : '');

/** The fix's name, its label (else its id), its card naming every label it groups runs by where it has more than that one. */
export function FixLabels({ fix }: { fix: Pick<FixDetail, 'label' | 'labels' | 'fixId'> }) {
  const others = fix.labels.filter((l) => l !== fix.label);
  if (!fix.label || !others.length) return <code>{fixName(fix)}</code>;
  return (
    <code tabIndex={0} data-tip={tipCard('Its labels', [], `It groups the runs labelled ${[fix.label, ...others].join(', ')}.`)}>
      {fixName(fix)}
    </code>
  );
}

/** `1 good`, its card naming the good runs a change must keep passing. */
export function GoodRuns({ fix }: { fix: Pick<FixDetail, 'good' | 'goodRuns'> }) {
  const words = `${fix.good} good`;
  if (!fix.goodRuns.length) return <span>{words}</span>;
  return (
    <span tabIndex={0} data-tip={tipCard(`${fix.good} good run${s(fix.good)}`, [], `${ids(fix.goodRuns.map((r) => r.runId))}. A change that breaks one is rejected.`)}>
      {words}
    </span>
  );
}

/** `opened Nov 2, 10:04 by ana`. */
export function Opened({ fix }: { fix: Pick<FixDetail, 'openedAt' | 'openedBy'> }) {
  return (
    <span>
      opened {fixStamp(fix.openedAt)}
      {by(fix.openedBy)}
    </span>
  );
}

const PATCH: Readonly<Record<NonNullable<FixDetail['applied']>['patch'], string>> = { applied: 'applied to the working tree', already: 'in the working tree already', none: 'none: a change of request fields, or one verified as it was' };

/** `applied 17:40 by ben`, its card saying how: with what, its patch, the goldens it copied and how their test went. */
export function Applied({ fix }: { fix: Pick<FixDetail, 'appliedAt' | 'verifiedAt' | 'openedAt' | 'applied'> }) {
  if (!fix.appliedAt) return null;
  const a = fix.applied;
  const when = laterStamp(fix.appliedAt, fix.verifiedAt ?? fix.openedAt);
  const rows: TipRow[] = a
    ? [
        { label: 'With', value: a.via ?? 'fix apply' },
        { label: 'Patch', value: PATCH[a.patch] },
        { label: 'Goldens', value: a.goldens.length ? a.goldens.join(', ') : 'none copied' },
        { label: 'Their test', value: a.tests },
      ]
    : [];
  return (
    <>
      {GLUED_SEPARATOR}
      <span {...(rows.length ? { tabIndex: 0, 'data-tip': tipCard('Applied', rows) } : {})}>
        applied {when}
        {by(a?.by)}
      </span>
    </>
  );
}

/** `2 left out by its check`, where a check given since judged runs of the fix otherwise, its card naming them. */
export function LeftOut({ fix }: { fix: Pick<FixDetail, 'left'> }) {
  const n = fix.left.failing.length + fix.left.good.length;
  if (!n) return null;
  const rows: TipRow[] = [...(fix.left.failing.length ? [{ label: 'Failing runs it passes', value: ids(fix.left.failing) }] : []), ...(fix.left.good.length ? [{ label: 'Good runs it fails', value: ids(fix.left.good) }] : [])];
  return (
    <>
      {GLUED_SEPARATOR}
      <span tabIndex={0} data-tip={tipCard(`${n} run${s(n)} left the fix`, rows, 'Its check, given since, judged them otherwise')}>
        {n} left out by its check
      </span>
    </>
  );
}

/** `≈$3.12 spent`, its card saying on what: every attempt blame, repair and verify ran live for the fix, and the repairer. */
export function Spent({ fix }: { fix: Pick<FixDetail, 'attempts' | 'spent' | 'upstreamRequests'> }) {
  if (!fix.attempts && !fix.spent) return null;
  const rows: TipRow[] = [
    { label: 'Attempts', value: num(fix.attempts) },
    { label: 'Upstream requests', value: num(fix.upstreamRequests) },
  ];
  return (
    <>
      {GLUED_SEPARATOR}
      <span tabIndex={0} data-tip={tipCard(`${approx(fix.spent)} spent on this fix`, rows, 'What its blames, repairs and verifies ran live, and what the repairer cost')}>
        {approx(fix.spent)} spent
      </span>
    </>
  );
}

/** The Must line's `changed Nov 3`, where the fix's check changed, its card listing each check it has had, the one it has first. */
export function CheckChanged({ fix }: { fix: Pick<FixDetail, 'checks'> }) {
  if (fix.checks.length < 2) return null;
  const rows: TipRow[] = [...fix.checks].reverse().map((c, i) => ({ label: `${fixStamp(c.at)}${by(c.by)}`, value: i ? c.text : `${c.text}, its check now` }));
  const changes = fix.checks.length - 1;
  return (
    <span className="fmx" tabIndex={0} data-tip={tipCard(`Its check changed ${changes === 1 ? 'once' : `${changes} times`}`, rows)}>
      changed {fixStamp(fix.checks.at(-1)!.at)}
    </span>
  );
}

/** The Repair step's ` · 2 other repairs`, for the repairs it doesn't show, its card listing each: when, how it ended and its change. */
export function OtherRepairs({ repairs }: { repairs: FixDetail['repairs'] }) {
  if (!repairs.length) return null;
  const rows: TipRow[] = repairs.map((r) => ({ label: fixStamp(r.at), value: `${repairOutcomeWord(r.outcome)} · ${r.title}` }));
  return (
    <>
      {' · '}
      <span tabIndex={0} data-tip={tipCard(`${repairs.length} other repair${s(repairs.length)} of this fix`, rows, 'The step shows the one whose change counts, else the newest')}>
        {repairs.length} other repair{s(repairs.length)}
      </span>
    </>
  );
}
