import { DiffAnswer, DiffHead } from '../components/DiffNotes.js';
import { JsonDiffPart } from '../components/JsonDiffPart.js';
import { ErrorState, Skeleton } from '../components/States.js';
import { useLoad } from '../hooks.js';
import { askDiff } from '../run/diff-answers.js';
import { useApp } from '../state.js';
import { errorText } from '../toast.js';
import type { Followed, ReportPart } from '../types.js';
import { FoldedLines } from './ErrorPart.js';

/**
 * A divergence's Request part: its request on both sides as Show diff draws it on a run, by the same
 * components (DiffNotes.tsx), asked for (`GET /api/runs/:id/diff`) and drawn only once the report is
 * open, the structural diff's script with it, never while the report is folded; where the replay is
 * gone, the changes its result kept, with no notes. At its foot, in grey, what followed from it, so it
 * never reads as a second fault: the offline 503 the agent exited on, Show message opening its body.
 * A divergence that kept no changes, as a run offers no Show diff for it, draws what followed alone.
 */
export function RequestPart({ p, open, id }: { p: Extract<ReportPart, { kind: 'request' }>; open: boolean; id: string }) {
  const diff = p.runId ? <Asked runId={p.runId} callNo={p.callNo} /> : p.bodies ? <Kept p={p} bodies={p.bodies} /> : null;
  return (
    <>
      {open && diff ? <div className="diffpanel jdp rpdiff">{diff}</div> : null}
      {p.followed ? <FollowedLine f={p.followed} id={id} /> : null}
    </>
  );
}

/** The replay's diff, asked for as the report opens and kept for the page's life (diff-answers.ts), Retry on a failure. */
function Asked({ runId, callNo }: { runId: string; callNo: number }) {
  const { client } = useApp();
  const answer = useLoad(() => askDiff(client, runId, false), `request-diff:${runId}`);
  if (answer.data) return <DiffAnswer diff={answer.data} as="h4" />;
  if (answer.error) return <ErrorState retry={answer.reload}>{errorText(answer.error)}</ErrorState>;
  if (answer.loading) return <Skeleton what="diff" lines={6} />;
  return <p className="muted">{`The replay kept no call #${callNo} to compare.`}</p>;
}

/** The changes the result kept, the replay gone: both sides hold only what changed. */
function Kept({ p, bodies }: { p: Extract<ReportPart, { kind: 'request' }>; bodies: { was: unknown; now: unknown } }) {
  return (
    <>
      <DiffHead diff={{ what: 'request', at: p.callNo, against: p.against }} as="h4" />
      <JsonDiffPart was={bodies.was} now={bodies.now} />
    </>
  );
}

/** What followed, each clause kept whole, so a phone breaks the line after its colon; the body the agent got on request. */
function FollowedLine({ f, id }: { f: Followed; id: string }) {
  const head = (
    <>
      <span className="nw">{f.line[0]}</span> <span className="nw">{f.line[1]}</span>
    </>
  );
  return <FoldedLines head={head} what="message" lines={f.message === null ? null : f.message.split('\n')} id={id} quiet />;
}
