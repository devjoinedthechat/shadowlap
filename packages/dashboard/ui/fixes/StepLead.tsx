import { Fragment, type ReactNode } from 'react';
import { Words } from '../components/Copy.js';
import { VerdictLine } from '../components/VerdictLine.js';
import type { StepLine } from '../types.js';

/**
 * A fix's step opens on its verdict line, as the server words it (`StepLine`): its word in its
 * colour (blamed in ink, accepted in lime, inconclusive, stopped and not rescued in amber, rejected
 * in red), beside it the evidence the stepper above doesn't give, each part kept whole and the head
 * breaking only between them ("3 of 4 rescued from #5, 0 of 4 from #7"), where and how sure muted
 * under it (`facts`), its links at the right (`actions`); then what was found, in a sentence of the
 * engine's (`fxsay`). The head never says the word again, nor the stepper's title.
 */
export function StepLead({ line, facts, actions }: { line: StepLine; facts?: ReactNode; actions?: ReactNode }) {
  return (
    <>
      <VerdictLine word={line.word} tone={line.tone} facts={facts} actions={actions} className="sv">
        {line.head.length === 1 ? line.head[0]! : <HeadParts parts={line.head} />}
      </VerdictLine>
      {line.finding ? (
        <p className="fxsay">
          <Words>{line.finding}</Words>
        </p>
      ) : null}
    </>
  );
}

/** A head in parts, each kept whole, so a line too narrow breaks only between them. */
function HeadParts({ parts }: { parts: readonly string[] }) {
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={p}>
          {i ? ', ' : ''}
          <span className="nw">{p}</span>
        </Fragment>
      ))}
    </>
  );
}
