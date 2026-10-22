import { useState } from 'react';
import { JOB_KINDS } from '../api.js';
import { CmdLine } from '../components/bits.js';
import { Dialog } from '../components/Dialog.js';
import { shortId } from '../format.js';
import { sentence } from '../normalize.js';
import { useApp } from '../state.js';
import type { BisectChoices } from '../types.js';
import { bisectCommand, bisectRequest, bisectUpTo, revisionTally } from './find-commit.js';

/**
 * Find the commit, from the calendar: the first failure on the days picked is where it started
 * failing, and bisect replays it at commits between one where it still worked (before the first day
 * picked) and its own, halving each time, to name the first that broke it. Replays are free, so it
 * costs no tokens, unless its replays have to run live from where they diverge. A
 * first failure at the first commit has nothing before it to search: the server offers the first
 * that started later, and `earlier` says why the first was passed over.
 */
export function FindCommitDialog({ runId, choices, earlier = null, onClose }: { runId: string; choices: BisectChoices; earlier?: { runId: string; why: string } | null; onClose: () => void }) {
  const { client, watchJob } = useApp();
  const listed = choices.revisions.map((r) => r.rev);
  const [good, setGood] = useState(choices.good ?? listed[0] ?? '');
  const [own, setOwn] = useState(listed.length === 0);
  const what = choices.target.kind === 'golden' ? choices.target.golden : shortId(runId);
  const upTo = bisectUpTo(choices);
  if (choices.unavailable)
    return (
      <Dialog title={`Find the commit that broke ${what}`} text={sentence(choices.unavailable)} onClose={onClose}>
        {null}
      </Dialog>
    );
  const rev = good.trim();
  return (
    <Dialog
      title={`Find the commit that broke ${what}`}
      text={`Replays it at commits between a good one and ${upTo}, halving each time, and names the first where it fails. ${choices.live ? 'Its replays run live from where they diverge, so this costs tokens.' : 'Replays are free, so this costs no tokens.'}`}
      ok="Find the commit"
      okDisabled={!/^[A-Za-z0-9][A-Za-z0-9._/~^-]{0,199}$/.test(rev) || rev === upTo}
      onClose={onClose}
      onOk={() => {
        onClose();
        watchJob(client.startJob(JOB_KINDS.bisect, bisectRequest(runId, choices, rev)));
      }}
    >
      {earlier ? (
        <p className="fxdlg fcearly">
          {sentence(earlier.why)} This finds the commit that broke {what}, the first failure on those days that started later.
        </p>
      ) : null}
      <div className="form one">
        <label>
          A commit where it still worked
          {own ? (
            <input spellCheck={false} placeholder="a commit, tag or branch" value={good} onChange={(e) => setGood(e.target.value)} />
          ) : (
            <select
              value={good}
              onChange={(e) => {
                if (e.target.value === '\u0000') {
                  setOwn(true);
                  setGood('');
                } else setGood(e.target.value);
              }}
            >
              {choices.revisions.map((r) => (
                <option key={r.rev} value={r.rev}>
                  {r.rev.slice(0, 12)} · {new Date(r.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · {revisionTally(r)}
                </option>
              ))}
              <option value={'\u0000'}>Another commit…</option>
            </select>
          )}
        </label>
      </div>
      <CmdLine>{bisectCommand(runId, choices, rev)}</CmdLine>
    </Dialog>
  );
}
