import { Fragment } from 'react';
import type { CommentDecision } from '../types.js';

/**
 * What Preview pull request comment's dialog and a revision's page under Changes share of the pull
 * request comment: the decisions' steps, as the comment draws them and a revision's page lists them,
 * each with its calls. The dialog itself is a served part (pages/served.tsx), one script for
 * Settings → CI and the newest revision's page, so an exported copy's script holds none of it
 * (test/ui-exported-copy.test.ts).
 */

/** A quoted value with a hyphen in it (an order's id), kept whole; or a comma a value follows straight away, where a phone may break. */
const PIECES = /("[^"\s]*-[^"\s]*"|,(?! ))/;

/**
 * A decision's call on one line, cut where it doesn't fit, whole on hover; on a phone it wraps after
 * a comma, a quoted value with a hyphen in it kept whole.
 */
export function Call({ text }: { text: string }) {
  return (
    <code className="prc-call" title={text}>
      {text.split(PIECES).map((p, i) =>
        i % 2 === 0 ? (
          p
        ) : p === ',' ? (
          <Fragment key={i}>
            ,<wbr />
          </Fragment>
        ) : (
          <span key={i} className="nw">
            {p}
          </span>
        ),
      )}
    </code>
  );
}

/** Each rank 1 and 2 step of the goldens it flags: the rank, the golden and its call, what changed, then the recorded and the new decision. Rank 2 in amber, as every rank 2 change is. */
export function DecisionSteps({ rows, className = '' }: { rows: readonly CommentDecision[]; className?: string }) {
  return (
    <>
      {rows.map((d) => (
        <div key={`${d.golden}#${d.callNo}`} className={`prc-d${className ? ` ${className}` : ''}`}>
          <p>
            <span className={`prc-rk${d.rank === 1 ? '' : ' r2'}`}>rank {d.rank}</span> <code>{d.golden}</code> #{d.callNo} · {d.detail}
          </p>
          <p className="prc-a">
            <span>recorded</span> <Call text={d.recorded} />
          </p>
          <p className="prc-a">
            <span>now</span> <Call text={d.now} />
          </p>
        </div>
      ))}
    </>
  );
}
