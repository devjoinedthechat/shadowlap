import { Fragment } from 'react';
import type { Piece } from '../types.js';

/**
 * A sentence of a golden's report as the server words it in pieces (golden-report.ts `Piece`): its
 * paths, checks and files as code, an id with the page it opens as a link. The report's verdict and
 * its Request line's cause draw through it, so the browser words neither.
 */
export function Pieces({ pieces }: { pieces: readonly Piece[] }) {
  return (
    <>
      {pieces.map((p, i) =>
        typeof p === 'string' ? (
          <Fragment key={i}>{p}</Fragment>
        ) : p.href ? (
          <a key={i} href={p.href}>
            <code>{p.code}</code>
          </a>
        ) : (
          <code key={i}>{p.code}</code>
        ),
      )}
    </>
  );
}
