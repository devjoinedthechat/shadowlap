import { useId, useState } from 'react';
import { JOB_KINDS } from '../api.js';
import { Dialog } from '../components/Dialog.js';
import { COMMIT_NAME, GoodCommitField } from '../components/GoodCommit.js';
import { namedIn } from '../components/Id.js';
import { shortId } from '../format.js';
import { sentence } from '../normalize.js';
import { useApp } from '../state.js';
import type { BisectChoices } from '../types.js';
import { bisectBadFact, bisectCommand, bisectCost, bisectRequest, bisectUpTo, FLAKY_NOTE, revisionTally } from './find-commit.js';
import { ACTIONS, confirmWords } from '../labels.js';

/**
 * Find breaking commit, from the calendar: the first failure on the days picked is where it started
 * failing, and bisect replays it at commits between one where it still worked (before the first day
 * picked) and its own, halving each time, to name the first that broke it. Replays are free, so it
 * costs no tokens, unless its replays have to run live from where they diverge (`bisectCost`). A
 * first failure at the first commit has nothing before it to search: the server offers the first
 * that started later, and `earlier` says why the first was passed over.
 */
export function FindCommitDialog({ runId, choices, earlier = null, onClose }: { runId: string; choices: BisectChoices; earlier?: { runId: string; why: string } | null; onClose: () => void }) {
  const { client, watchJob, guard } = useApp();
  const id = useId();
  const [picked, setPicked] = useState(choices.good ?? choices.revisions[0]?.rev ?? '');
  const [typed, setTyped] = useState('');
  const what = choices.target.kind === 'golden' ? choices.target.golden : shortId(runId);
  const upTo = bisectUpTo(choices);
  const title = namedIn(`Find breaking commit for ${what}`, what);
  const lead = `Finds the first commit that broke ${choices.target.kind === 'golden' ? what : 'the run'}, from one where it worked.`;
  const bad = bisectBadFact(choices);
  if (choices.unavailable) return <Dialog title={title} lead={lead} doc="bisect" warn={{ text: choices.unavailable.replace(/\.$/, '') }} facts={[bad]} onClose={onClose} />;
  const rev = typed.trim() || picked;
  return (
    <Dialog
      title={title}
      lead={lead}
      doc="bisect"
      {...(earlier ? { warn: { text: `${sentence(earlier.why)} This finds the commit that broke ${what}, the first failure on those days that started later` } } : {})}
      facts={[bad]}
      command={bisectCommand(runId, choices, rev)}
      cost={bisectCost(choices)}
      ok={confirmWords(ACTIONS.findBreakingCommit.label)}
      okDisabled={!COMMIT_NAME.test(rev) || rev === upTo}
      onClose={onClose}
      onOk={() => guard(() => watchJob(client.startJob(JOB_KINDS.bisect, bisectRequest(runId, choices, rev))))}
    >
      <GoodCommitField
        id={id}
        choices={choices.revisions.map((r) => ({ value: r.rev, subject: new Date(r.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), how: revisionTally(r) }))}
        picked={picked}
        typed={typed}
        onPick={setPicked}
        onType={setTyped}
      />
      {choices.fork ? <p className="dlgnote fieldhint">{FLAKY_NOTE}</p> : null}
    </Dialog>
  );
}
