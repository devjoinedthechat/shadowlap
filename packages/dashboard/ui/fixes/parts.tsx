import { Fragment, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { breakPoints, cellKeepsWhole, flagParts, inlineParts, parseMarkdown, plainCell, type MdBlock } from './model.js';

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

/** Text with its `code` set in code. `breaks` lets a narrow table cell wrap JSON after its commas and colons (`breakPoints`). */
export function Inline({ text, breaks = false }: { text: string; breaks?: boolean }) {
  const words = (t: string) => (breaks ? breakPoints(t).map((w, i) => (i ? <Fragment key={i}><wbr />{w}</Fragment> : <Fragment key={i}>{w}</Fragment>)) : t);
  return (
    <>
      {inlineParts(text).map((p, i) => (p.code ? <code key={i}>{words(p.text)}</code> : <span key={i}>{words(p.text)}</span>))}
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
                    // Where the panel is narrow, a row stands as its headers and values (`data-h`), so no column is out of view.
                    <td key={j} data-h={plainCell(b.head[j] ?? '')} className={cellKeepsWhole(c) ? 'nw' : undefined}>
                      <Inline text={c} breaks />
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
