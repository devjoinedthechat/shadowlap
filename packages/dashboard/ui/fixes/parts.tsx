import { Fragment } from 'react';
import type { FixRow } from '../types.js';
import { failedMust, flagParts, wholeParts } from './model.js';

/**
 * What a fix's failing runs did and the check they must meet (`failedMust`): "Failed: … · Must: …",
 * each label kept with its value where the line wraps. The dot between them is drawn only while both
 * share a line; the one in the text is for reading it aloud or copying it.
 */
export function FailedMust({ fix }: { fix: Pick<FixRow, 'title' | 'failed' | 'check'> }) {
  const { failed, must } = failedMust(fix);
  return (
    <span className="fm">
      {failed ? (
        <>
          <span className="fmu">
            Failed: <Whole text={failed} />
          </span>
          <span className="fmsep"> · </span>
        </>
      ) : null}
      <span className="fmu">
        Must: <Whole text={must} />
      </span>
    </span>
  );
}

/** A check or a failure, a sentence in the UI face, a count kept with its unit and a comparison kept whole where there is room (`wholeParts`). */
export function Whole({ text }: { text: string }) {
  return (
    <span className="fmv">
      {wholeParts(text).map((p, i) =>
        p.whole ? (
          <span key={i} className="kc">
            {p.text}
          </span>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </span>
  );
}

/** Text whose command-line flags are set as code, each kept on one line (`--stronger <model>`). */
export function Flagged({ text }: { text: string }) {
  return (
    <>
      {flagParts(text).map((p, i) =>
        p.flag ? (
          <code key={i} className="flag">
            {p.text}
          </code>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </>
  );
}
