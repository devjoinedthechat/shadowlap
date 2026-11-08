import { useState } from 'react';
import { CHECK_MARKS } from '../../../engine/src/checks/labels.js';
import { plural } from '../../../engine/src/words.js';
import type { CheckPreview } from '../checks-api.js';
import { CodeBox } from '../components/CodeBox.js';
import { Copy } from '../components/Copy.js';
import { Id } from '../components/Id.js';
import { ErrorState } from '../components/States.js';
import { checkCommand, headWords, rowsWords, type Fragment, type PreviewNote } from './model.js';

/**
 * Against your recordings: the agent's newest recordings judged by the check as it is built, from
 * what they recorded, nothing replayed. The count first, not applicable in grey; then the notes, an
 * amber one before saving; the recordings it fails or is inconclusive on, on request; and the
 * command that gives the same numbers, its whole copy holding every id.
 */
export interface PreviewProps {
  answer: CheckPreview | null;
  /** Why the last read failed: said in the section's place, the last answer kept under it. */
  error: string | null;
  retry: () => void;
  notes: readonly PreviewNote[];
  /** The draft as judged: without its judges, whose verdicts no recording holds. */
  judged: Fragment | null;
  /** The draft has judges and nothing else. */
  judgesOnly: boolean;
  agent: string | null;
}

/** The most rows Show lists; the rest are counted. */
const ROWS = 12;

export function Preview({ answer, error, retry, notes, judged, judgesOnly, agent }: PreviewProps) {
  const [open, setOpen] = useState(false);
  const total = answer?.total ?? 0;
  const n = answer?.judged.length ?? 0;
  const head = (
    <p className="cb-k">
      <span className="k">Against your recordings</span>
      {answer && agent && total ? (
        <span className="cb-sub">
          the {n < total ? plural(n, 'newest recording') : plural(n, 'recording')} of <code>{agent}</code>, judged from what they recorded · nothing replayed
        </span>
      ) : null}
    </p>
  );
  if (judgesOnly) {
    return (
      <section className="cb-sec">
        {head}
        <Copy className="cb-count">Inconclusive on every recording until the golden is packed or updated</Copy>
      </section>
    );
  }
  if (!judged) return null;
  return (
    <section className="cb-sec">
      {head}
      {error ? <ErrorState retry={retry}>{error}</ErrorState> : null}
      {!answer ? error ? null : <p className="cb-note">Judging it on your recordings…</p> : !total ? (
        <p className="cb-count">
          No recording of <code>{agent ?? 'this agent'}</code> to judge it on yet
        </p>
      ) : (
        <Judged answer={answer} notes={notes} judged={judged} open={open} onOpen={() => setOpen(!open)} />
      )}
    </section>
  );
}

function Judged({ answer, notes, judged, open, onOpen }: { answer: CheckPreview; notes: readonly PreviewNote[]; judged: Fragment; open: boolean; onOpen: () => void }) {
  const na = answer.counts.notApplicable;
  const shown = [...answer.judged.filter((r) => r.outcome === 'failed'), ...answer.judged.filter((r) => r.outcome === 'inconclusive')];
  const failed = shown.filter((r) => r.outcome === 'failed').length;
  const cmd = checkCommand(
    answer.judged.map((r) => r.runId),
    judged,
  );
  return (
    <>
      <p className="cb-count">
        {headWords(answer)}
        {na ? <span className="cb-na"> · not applicable to {na}: the condition never held</span> : null}
      </p>
      {notes.length ? (
        <ul className="cb-notes">
          {notes.map((note, i) => (
            <Copy key={i} as="li" className={note.tone === 'amber' ? 'y' : 'na'}>
              {note.text}
            </Copy>
          ))}
        </ul>
      ) : null}
      {shown.length ? (
        <button className="linkbtn cb-more" type="button" aria-expanded={open} onClick={onOpen}>
          {open ? 'Hide' : 'Show'} {rowsWords(failed, shown.length - failed)}
        </button>
      ) : null}
      {open && shown.length ? (
        <div className="cb-rows">
          {shown.slice(0, ROWS).map((r) => (
            <div key={r.runId} className="cb-row">
              <b className={`cm ${r.outcome === 'failed' ? 'no' : 'inc'}`} aria-label={r.outcome}>
                {CHECK_MARKS[r.outcome]}
              </b>
              <span className="cb-rid">
                <Id id={r.runId} list />
                {r.labels.map((l) => (
                  <span key={l} className="chip">
                    {l}
                  </span>
                ))}
              </span>
              <span className="cb-d">{r.why.join(' · ')}</span>
            </div>
          ))}
          {shown.length > ROWS ? <p className="cb-note">and {shown.length - ROWS} more</p> : null}
        </div>
      ) : null}
      <CodeBox command={cmd.view} full={cmd.full} className="cb-cmd" />
      {cmd.more ? <p className="cb-cmdn">{cmd.more}</p> : null}
    </>
  );
}
