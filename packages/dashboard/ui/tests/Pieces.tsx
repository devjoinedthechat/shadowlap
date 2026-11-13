import { Code, Words } from '../components/Copy.js';
import type { Piece } from '../types.js';

/**
 * A sentence of a golden's report as the server words it in pieces (golden-report.ts `Piece`), glued
 * as a verdict's words are (a count with its noun): its paths, checks and files as code, an id with
 * the page it opens as a link. The report's verdict and its Request line's cause draw through it, so
 * the browser words neither.
 */
export function Pieces({ pieces }: { pieces: readonly Piece[] }) {
  return (
    <>
      {pieces.map((p, i) =>
        typeof p === 'string' ? (
          <Words key={i}>{p}</Words>
        ) : p.href ? (
          <a key={i} href={p.href}>
            <Code>{p.code}</Code>
          </a>
        ) : (
          <Code key={i}>{p.code}</Code>
        ),
      )}
    </>
  );
}
