import { useRef, useState, type ReactNode } from 'react';
import { Icon } from '../components/Icon.js';
import type { CrashError } from '../types.js';
import { useUntilFound } from './until-found.js';

/**
 * A line of what went wrong, with the lines behind it on request: Show <what> opens them under it, each
 * dim, folded until found (find in page opens them). `src`, a line of code under it; `quiet`, what
 * followed from a fault rather than the fault, in grey. A module of its own, so a page that names a
 * crash the same way (a fix's Blame step) takes nothing else of the report.
 */
export function FoldedLines({ head, what, lines, id, quiet = false, src = null }: { head: ReactNode; what: string; lines: readonly string[] | null; id: string; quiet?: boolean; src?: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={quiet ? 'rperrw q' : 'rperrw'}>
      <p className="rperr">
        {head}
        {lines ? (
          <>
            {' '}
            <button type="button" className="linkbtn rptog" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
              {open ? `Hide ${what}` : `Show ${what}`}
              <Icon name="caret" />
            </button>
          </>
        ) : null}
      </p>
      {src ? <code className="rpsrc">{src}</code> : null}
      {lines ? <Tail lines={lines} id={id} open={open} found={() => setOpen(true)} /> : null}
    </div>
  );
}

/**
 * The lines, each dim, folded until found while shut: a component of its own, so the box is folded
 * and heard the moment it mounts, though its lines came after the line first drew without them.
 */
function Tail({ lines, id, open, found }: { lines: readonly string[]; id: string; open: boolean; found: () => void }) {
  const box = useRef<HTMLPreElement>(null);
  useUntilFound(box, !open, found);
  return (
    <pre className="report tail" id={id} ref={box}>
      {lines.map((l, i) => (
        <span key={i} className="dim">
          {l}
          {i < lines.length - 1 ? '\n' : ''}
        </span>
      ))}
    </pre>
  );
}

/**
 * What a crash died of, as the engine's parser read it from the agent's last lines: the exception
 * in one line, where the agent's own code raised it (no frame where the tail kept none of the
 * agent's), the line of code there, and Show traceback, the lines as the store kept them.
 */
export function ErrorPart({ part, id }: { part: CrashError; id: string }) {
  const { error, file, lines } = part;
  const raised = error.raised;
  const head = (
    <>
      <code>{error.exception}</code>
      {raised && file ? (
        <span className="m">
          {' in '}
          <code>{file}</code>
          {raised.line !== null ? `, line ${raised.line}` : ''}
          {raised.fn ? (
            <>
              {', in '}
              <code>{raised.fn}</code>
            </>
          ) : null}
        </span>
      ) : null}
    </>
  );
  return <FoldedLines head={head} what="traceback" lines={lines} id={id} src={raised?.code ?? null} />;
}
