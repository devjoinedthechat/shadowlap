import { useRef, useState } from 'react';
import { Icon } from '../components/Icon.js';
import type { ReportPart } from '../types.js';
import { useUntilFound } from './until-found.js';

/**
 * What a crash died of, as the engine's parser read it from the agent's last lines: the exception
 * in one line, where the agent's own code raised it (no frame where the tail kept none of the
 * agent's), the line of code there, and Show traceback, the lines as the store kept them, each dim,
 * folded until found. A module of its own, so a page that names a crash the same way takes nothing
 * else of the report.
 */
export function ErrorPart({ part, id }: { part: Extract<ReportPart, { kind: 'error' }>; id: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLPreElement>(null);
  useUntilFound(box, !open, () => setOpen(true));
  const { error, file, lines } = part;
  const raised = error.raised;
  return (
    <div className="rperrw">
      <p className="rperr">
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
        ) : null}{' '}
        <button type="button" className="linkbtn rptog" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
          {open ? 'Hide traceback' : 'Show traceback'}
          <Icon name="caret" />
        </button>
      </p>
      {raised?.code ? <code className="rpsrc">{raised.code}</code> : null}
      <pre className="report tail" id={id} ref={box}>
        {lines.map((l, i) => (
          <span key={i} className="dim">
            {l}
            {i < lines.length - 1 ? '\n' : ''}
          </span>
        ))}
      </pre>
    </div>
  );
}
