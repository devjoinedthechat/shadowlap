import { useEffect } from 'react';
import type { RunDetail } from '../api.js';
import { DiffAnswer, NoDiffAnswer } from '../components/DiffNotes.js';
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

/** The panel's body, at call `at` where one was picked (null: where the run left its recording): `onAt` hears the call the diff shows once the answer came, for the panel's head. */
export function RequestDiff({ run, at: asked = null, onAt }: { run: RunDetail; at?: number | null; onAt: (at: number) => void }) {
  const { client } = useApp();
  const r = run.run;
  const live = r.status === 'running';
  const answer = useLoad(() => askDiff(client, r.runId, live, asked), `${r.runId}${asked === null ? '' : ` #${asked}`}${live ? ' live' : ''}`);
  const at = answer.data?.at;
  useEffect(() => {
    if (at !== undefined) onAt(at);
  }, [at, onAt]);
  return (
    <section className="diffpanel jdp">
      {answer.data ? (
        <DiffAnswer diff={answer.data} picked={asked !== null} />
      ) : answer.error ? (
        <ErrorState retry={answer.reload}>{errorText(answer.error)}</ErrorState>
      ) : answer.loading ? (
        <Skeleton what="diff" lines={6} />
      ) : (
        <NoDiffAnswer who="This run" at={asked ?? r.divergence?.callNo} />
      )}
    </section>
  );
}
