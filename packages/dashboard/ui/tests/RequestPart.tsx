import { DiffAnswer, DiffHead, NoDiffAnswer } from '../components/DiffNotes.js';
import { JsonDiffPart } from '../components/JsonDiffPart.js';
import { ErrorState, failedRead, Skeleton } from '../components/States.js';
import { useLoad } from '../hooks.js';
import { askDiff } from '../run/diff-answers.js';
import { useApp } from '../state.js';
import type { Followed, ReportPart } from '../types.js';
import { FoldedLines } from './ErrorPart.js';
import { Pieces } from './Pieces.js';

/**
 * A divergence's Request part: its request on both sides as Show diff draws it on a run, by the same
 * components (DiffNotes.tsx), asked for (`GET /api/runs/:id/diff`) and drawn only once the report is
 * open, the structural diff's script with it, never while the report is folded; where the replay is
 * gone, the changes its result kept, with no notes. At its foot, in grey, what followed from it, so it
 * never reads as a second fault: the offline 503 the agent exited on, Show message opening its body.
 * A divergence that kept no changes, as a run offers no Show diff for it, draws what followed alone.
 * Where an applied migration left the golden waiting, its cause under the diff, in the server's words:
 * the migration whose config change switched its model, its id opening its report. Where the request
 * takes out what an accepted change put in, a line for each sentence, with when and why it was accepted.
 */
export function RequestPart({ p, open, id }: { p: Extract<ReportPart, { kind: 'request' }>; open: boolean; id: string }) {
  const diff = p.runId ? <Asked runId={p.runId} callNo={p.callNo} /> : p.bodies ? <Kept p={p} bodies={p.bodies} /> : null;
  return (
    <>
      {open && diff ? <div className="diffpanel jdp rpdiff">{diff}</div> : null}
      {p.cause ? (
        <p className="rpc rpcause">
          <Pieces pieces={p.cause} />
        </p>
      ) : null}
      {p.takenOut?.map((line, i) => (
        <p key={i} className="rpc rpcause">
          <Pieces pieces={line} />
        </p>
      ))}
      {p.followed ? <FollowedLine f={p.followed} id={id} /> : null}
    </>
  );
}

/** The replay's diff, asked for as the report opens and kept for the page's life (diff-answers.ts): in its shape while asked, Retry on a failure. */
function Asked({ runId, callNo }: { runId: string; callNo: number }) {
  const { client } = useApp();
  const answer = useLoad(() => askDiff(client, runId, false), `request-diff:${runId}`);
  if (answer.data) return <DiffAnswer diff={answer.data} as="h4" />;
  if (answer.error) return <ErrorState retry={answer.reload}>{failedRead(answer.error)}</ErrorState>;
  if (answer.loading) return <Asking at={callNo} />;
  return <NoDiffAnswer who="The replay" at={callNo} />;
}

/** A diff's lines while it is asked, as long as such lines run. */
const ASKING = ['model: "claude-sonnet-4"', 'max_tokens: 1024', 'metadata: {', '  user_id: "6f1c2a9e-0b4d-4e8a"', '}', 'messages: [ … ]'];

/**
 * The diff while it is asked, in its shape as quiet bars: both heads, then its lines in their box.
 * Its classes are its own (tests.css), as tests wait for the diff's `.jdh` and `.jl`.
 */
function Asking({ at }: { at: number }) {
  return (
    <Skeleton what="the request’s diff">
      <div className="rpskh">
        <span>Recorded request #{at} · the recording</span>
        <span>This run’s request #{at}</span>
      </div>
      <div className="rpskd">
        {ASKING.map((line, i) => (
          <span key={i}>{line}</span>
        ))}
      </div>
    </Skeleton>
  );
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
