import { useEffect } from 'react';
import type { RunDetail } from '../api.js';
import { LoadFailed } from '../components/bits.js';
import { Copy } from '../components/Copy.js';
import { DiffHead, DiffNotes, sameSides } from '../components/DiffNotes.js';
import { onShow } from '../components/OnShow.js';
import { ErrorState, Skeleton } from '../components/States.js';
import { useLoad } from '../hooks.js';
import { useApp } from '../state.js';
import { errorText } from '../toast.js';
import { askDiff } from './diff-answers.js';

export { askDiff };

/**
 * A fork's or a diverged test's diff, in the inspector's place once its finding's Show diff is pressed
 * (InspectorPanel.tsx): the request the run changed first, as the recording sent it and as this run
 * did, read by the server (`GET /api/runs/:id/diff`), drawn as one structural diff, the sentence and
 * each changed path's fix under it. A part of its own, loaded the first time it shows; the diff's
 * drawing is another (JsonDiff.tsx), asked for as this one's script comes, which Compare and a test's
 * report load too.
 */

/** The structural diff, a script of its own: test/ui-bundle-size.test.ts fails the build if it loads with a page. */
export const JsonDiffPart = onShow(() => import('../components/JsonDiff.js').then((m) => m.JsonDiff), { waiting: <Skeleton what="diff" lines={6} />, failed: <LoadFailed what="diff" /> });

/** What the panel draws once the answer came: the heads and the diff with the notes under it; a fork that changed nothing in words alone. */
function Answered({ diff }: { diff: NonNullable<Awaited<ReturnType<typeof askDiff>>> }) {
  if (sameSides(diff)) return <DiffNotes diff={diff} lines={[]} />;
  return (
    <>
      <DiffHead diff={diff} />
      <JsonDiffPart was={diff.was} now={diff.now}>
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
