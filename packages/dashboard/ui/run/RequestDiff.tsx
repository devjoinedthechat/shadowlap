import { useEffect } from 'react';
import type { RunDetail } from '../api.js';
import { Copy } from '../components/Copy.js';
import { DiffHead, DiffNotes } from '../components/DiffNotes.js';
import { JsonDiffPart } from '../components/JsonDiffPart.js';
import { ErrorState, Skeleton } from '../components/States.js';
import { useLoad } from '../hooks.js';
import { useApp } from '../state.js';
import { errorText } from '../toast.js';
import { askDiff } from './diff-answers.js';

export { askDiff, JsonDiffPart };

/**
 * A fork's or a diverged test's diff, in the inspector's place once its finding's Show diff is pressed
 * (InspectorPanel.tsx): the request the run changed first, as the recording sent it and as this run
 * did, read by the server (`GET /api/runs/:id/diff`), drawn as one structural diff, the sentence and
 * each changed path's fix under it. A part of its own, loaded the first time it shows; the diff's
 * drawing is another (JsonDiff.tsx), asked for as this one's script comes, which Compare and a test's
 * report load too.
 */


/** What the panel draws once the answer came: the heads and the diff with the notes under it; a fork that changed nothing in words alone. */
function Answered({ diff }: { diff: NonNullable<Awaited<ReturnType<typeof askDiff>>> }) {
  // The server says whether the two sides are the same (`same`): no render reads both bodies to find out.
  if (diff.same) return <DiffNotes diff={diff} lines={[]} />;
  return (
    <>
      <DiffHead diff={diff} />
      <JsonDiffPart was={diff.was} now={diff.now} leftOut={diff.leftOut}>
        {(lines) => <DiffNotes diff={diff} lines={lines} />}
      </JsonDiffPart>
    </>
  );
}

/** The panel's body: `onAt` hears the call the diff shows once the answer came, for the panel's head. */
export function RequestDiff({ run, onAt }: { run: RunDetail; onAt: (at: number) => void }) {
  const { client } = useApp();
  const r = run.run;
  const live = r.status === 'running';
  const answer = useLoad(() => askDiff(client, r.runId, live), live ? `${r.runId} live` : r.runId);
  const at = answer.data?.at;
  useEffect(() => {
    if (at !== undefined) onAt(at);
  }, [at, onAt]);
  return (
    <section className="diffpanel jdp">
      {answer.data ? (
        <Answered diff={answer.data} />
      ) : answer.error ? (
        <ErrorState retry={answer.reload}>{errorText(answer.error)}</ErrorState>
      ) : answer.loading ? (
        <Skeleton what="diff" lines={6} />
      ) : (
        <Copy as="div" className="hint">{`This run kept no call #${r.divergence?.callNo ?? ''} to compare.`}</Copy>
      )}
    </section>
  );
}
