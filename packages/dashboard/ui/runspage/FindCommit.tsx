import { useId, useState, type ReactNode } from 'react';
import { JOB_KINDS } from '../api.js';
import { Dialog } from '../components/Dialog.js';
import type { DialogFact } from '../components/DialogFacts.js';
import { COMMIT_NAME, GoodCommitField } from '../components/GoodCommit.js';
import { Id, namedIn } from '../components/Id.js';
import { shortId, stamp } from '../format.js';
import { sentence } from '../normalize.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { useApp } from '../state.js';
import { sentEstimate } from '../spending.js';
import type { BisectChoices } from '../types.js';
import { bisectQuery, useBisectEstimate } from './bisect-estimate.js';
import { bisectBadFact, bisectCommand, bisectCost, bisectRequest, bisectUpTo, FLAKY_NOTE, revisionTally } from './find-commit.js';
import { ACTIONS, confirmWords } from '../labels.js';
import { Copy } from '../components/Copy.js';

/** The failure on the days picked a search starts from, as the server names it (routes/runs-list.ts `DaysBisect`). */
export interface DaysFailure {
  label: string;
  command: string;
  startedAt: number;
}

/** The failure it starts from, as a row: its id, a link to it, then what it is, its command and when it ran. */
function failureFact(runId: string, f: DaysFailure | null): DialogFact | null {
  return f ? { label: 'Failure', value: <Id id={shortId(runId)} href={href.run(runId)} />, quiet: `${f.label} · \`${f.command}\` · ${stamp(f.startedAt)}` } : null;
}

/** Why the first failure on the days picked was passed over, as a sentence, its run's id a link to it where the words name it. */
function passedOver(earlier: { runId: string; why: string }): ReactNode {
  const words = sentence(earlier.why);
  const id = shortId(earlier.runId);
  const at = words.indexOf(id);
  const link = <Id id={id} href={href.run(earlier.runId)} />;
  return at < 0 ? (
    <>
      {link}: {words}
    </>
  ) : (
    <>
      {words.slice(0, at)}
      {link}
      {words.slice(at + id.length)}
    </>
  );
}

/**
 * Find breaking commit, from the calendar: the first failure on the days picked is where it started
 * failing (`failure`, the row that names it), and bisect replays it at commits between one where it
 * still worked (before the first day picked) and its own, halving each time, to name the first that
 * broke it, each commit named by its subject. Replays are free, so it costs no tokens, unless its
 * replays have to run live from where they diverge: its Cost line is the search's estimate from the
 * commit picked, once it has rested, and the job keeps the last one shown. A first failure at the
 * first commit has nothing before it to search: the server offers the first that started later, and
 * `earlier` says why the first was passed over, its id a link to it. One it can't search from that
 * Tests finds the commit for (`onTests`) leads there.
 */
export function FindCommitDialog({ runId, choices, failure = null, earlier = null, onClose }: { runId: string; choices: BisectChoices; failure?: DaysFailure | null; earlier?: { runId: string; why: string } | null; onClose: () => void }) {
  const { client, watchJob, guard } = useApp();
  const id = useId();
  const [picked, setPicked] = useState(choices.good ?? choices.revisions[0]?.rev ?? '');
  const [typed, setTyped] = useState('');
  const what = choices.target.kind === 'golden' ? choices.target.golden : shortId(runId);
  const upTo = bisectUpTo(choices);
  const title = namedIn(`Find breaking commit for ${what}`, what);
  const lead = `Finds the first commit that broke ${choices.target.kind === 'golden' ? what : 'the run'}, from one where it worked.`;
  const facts = [failureFact(runId, failure), bisectBadFact(choices)];
  const rev = typed.trim() || picked;
  const estimate = useBisectEstimate(bisectQuery(runId, choices, choices.unavailable ? '' : rev));
  if (choices.unavailable) {
    const tests = choices.onTests ? { ok: 'Open Tests', onOk: () => navigate(href.tests()) } : {};
    return <Dialog title={title} lead={lead} doc="bisect" warn={{ text: choices.unavailable.replace(/\.$/, '') }} facts={facts} {...tests} onClose={onClose} />;
  }
  return (
    <Dialog
      title={title}
      lead={lead}
      doc="bisect"
      {...(earlier ? { warn: { text: <>{passedOver(earlier)} This finds the commit that broke {what}, the first failure on those days that started later</> } } : {})}
      facts={facts}
      command={bisectCommand(runId, choices, rev)}
      cost={{ ...bisectCost(choices), estimate }}
      ok={confirmWords(ACTIONS.findBreakingCommit.label)}
      okDisabled={!COMMIT_NAME.test(rev) || rev === upTo}
      onClose={onClose}
      onOk={() => guard(() => watchJob(client.startJob(JOB_KINDS.bisect, { ...bisectRequest(runId, choices, rev), ...sentEstimate(estimate) })))}
    >
      <GoodCommitField
        id={id}
        choices={choices.revisions.map((r) => ({ value: r.rev, subject: r.subject ?? null, how: revisionTally(r) }))}
        picked={picked}
        typed={typed}
        onPick={setPicked}
        onType={setTyped}
      />
      {choices.fork && !estimate?.card ? <Copy className="dlgnote fieldhint">{FLAKY_NOTE}</Copy> : null}
    </Dialog>
  );
}
