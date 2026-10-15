import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { inlineParts, parseMarkdown, type MdBlock } from './model.js';

/** A step's header: its title, a line or two under it, and its actions on the right (`.sh`). */
export function StepHead({ title, text, actions }: { title: ReactNode; text?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="sh">
      <div>
        <h2>{title}</h2>
        {text ? <p>{text}</p> : null}
      </div>
      {actions ? <div className="actions">{actions}</div> : null}
    </div>
  );
}

/** Text with its `code` set in code. */
export function Inline({ text }: { text: string }) {
  return (
    <>
      {inlineParts(text).map((p, i) => (p.code ? <code key={i}>{p.text}</code> : <span key={i}>{p.text}</span>))}
    </>
  );
}

function Block({ b }: { b: MdBlock }) {
  switch (b.kind) {
    case 'h':
      return b.level <= 2 ? (
        <h3>
          <Inline text={b.text} />
        </h3>
      ) : (
        <h4>
          <Inline text={b.text} />
        </h4>
      );
    case 'p':
      return (
        <p>
          <Inline text={b.text} />
        </p>
      );
    case 'ul':
      return (
        <ul>
          {b.items.map((x, i) => (
            <li key={i}>
              <Inline text={x} />
            </li>
          ))}
        </ul>
      );
    case 'code':
      return (
        <pre className="fxcode">
          {b.lines.map((l, i) => (
            <span key={i} className={b.lang === 'diff' ? (l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : undefined) : undefined}>
              {l}
              {'\n'}
            </span>
          ))}
        </pre>
      );
    case 'table':
      return (
        <div className="fxtable">
          <table>
            <thead>
              <tr>
                {b.head.map((h, i) => (
                  <th key={i}>
                    <Inline text={h} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j}>
                      <Inline text={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/**
 * report.md, the pull request body, as the page draws it: whole when it fits the panel, else its
 * first part with the rest a click away. Drawn from blocks, never as HTML.
 */
export function Markdown({ text }: { text: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [all, setAll] = useState(false);
  // Whether the body is taller than the clamped panel. It starts clamped and is measured before it
  // paints: a body that fits drops the clamp and the button. Another body is measured again.
  const [long, setLong] = useState(true);
  const [measured, setMeasured] = useState(text);
  if (measured !== text) {
    setMeasured(text);
    setLong(true);
    setAll(false);
  }
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const clamp = long && !all;
  useLayoutEffect(() => {
    const el = box.current;
    if (el && clamp) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [text, clamp]);
  return (
    <>
      <div ref={box} className={`prbody${clamp ? ' clamp' : ''}`}>
        {blocks.map((b, i) => (
          <Block key={i} b={b} />
        ))}
      </div>
      {long ? (
        <div className="fxmore">
          <button className="linkbtn" type="button" aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? 'Show less' : 'Show all of report.md'}
          </button>
        </div>
      ) : null}
    </>
  );
}
