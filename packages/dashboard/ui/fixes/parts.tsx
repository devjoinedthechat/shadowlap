import { Fragment, useId, useMemo, useState, type ReactNode } from 'react';
import { JUDGE_ASKED } from '../../../engine/src/checks/labels.js';
import { titled, Words } from '../components/Copy.js';
import { tipCard } from '../components/HoverCard.js';
import { Icon } from '../components/Icon.js';
import { headingRef } from '../focus-manager.js';
import { judgeRows } from '../judge-rows.js';
import type { FixRow } from '../types.js';
import { breakPoints, cellKeepsWhole, failedMust, flagParts, inlineParts, parseMarkdown, plainCell, wholeParts, type MdBlock } from './model.js';

/** A judge's card, on the Must line and on its line of the Blame step's check: its rows as Tests' checks draw them (`judgeRows`: what it asks, what it reads, the model), and when it is asked. */
export const judgeTip = (j: NonNullable<FixRow['judge']>): string => tipCard(j.label, judgeRows(j), `${JUDGE_ASKED.charAt(0).toUpperCase()}${JUDGE_ASKED.slice(1)}`);

/**
 * What a fix's failing runs did and the check they must meet (`failedMust`): "Failed: … · Must: …",
 * each label kept with its value where the line wraps, the check's first judge on the check's card.
 * The dot between them is drawn only while both share a line; the one in the text is for reading it
 * aloud or copying it. `tail` follows the check: the fix's header puts its way to change it there.
 */
export function FailedMust({ fix, tail }: { fix: Pick<FixRow, 'title' | 'failed' | 'check' | 'judge'>; tail?: ReactNode }) {
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
        Must: <Whole text={must} tip={fix.judge ? judgeTip(fix.judge) : null} />
      </span>
      {tail}
    </span>
  );
}

/**
 * A check or a failure, a sentence in the UI face, a count kept with its unit and a comparison kept
 * whole where there is room (`wholeParts`); with a card (`tip`), it takes the focus to show it.
 */
export function Whole({ text, tip = null }: { text: string; tip?: string | null }) {
  return (
    <span className="fmv" {...(tip ? { tabIndex: 0, 'data-tip': tip } : {})}>
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

/** A title's last clause from its conjunction on (`before the refund was issued`), as the mock's `clauseHtml` finds it. */
const CLAUSE = / ((?:before|after|when|while|until|unless|because|once|since) \S.*)$/;

/**
 * A fix's title as `titled` sets it, its last clause from a conjunction kept whole where its line
 * holds it (`.clause`), so a narrow heading breaks before the conjunction, never after it.
 */
export function clauseTitled(title: string): { children: ReactNode; 'aria-label'?: string } {
  const head = titled(title);
  const m = CLAUSE.exec(title);
  if (!m) return head;
  const children = (
    <>
      <Words>{title.slice(0, m.index)}</Words>{' '}
      <span className="clause">
        <Words>{m[1]!}</Words>
      </span>
    </>
  );
  return { ...head, children };
}

/** A fix page's heading: its title as `clauseTitled` sets it, the page's focus target. */
export function FixTitle({ title }: { title: string }) {
  const head = clauseTitled(title);
  return (
    <h1 ref={headingRef} aria-label={head['aria-label']}>
      {head.children}
    </h1>
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
          <Words key={i}>{p.text}</Words>
        ),
      )}
    </>
  );
}

/** An operator, a dot or an arrow kept with the word before it, so no line starts with one (`<= 0.10`). */
const heldBefore = (t: string) => t.replace(/ (?=(?:[<>]=?|!=|[·→]) )/g, '\u00a0');

/**
 * Text with its `code` set in code, its words joined and kept whole as a report keeps them, never set
 * apart by sentence. `breaks` lets a narrow table cell wrap JSON after its commas and colons (`breakPoints`).
 */
export function Inline({ text, breaks = false }: { text: string; breaks?: boolean }) {
  const words = (t: string) => breakPoints(heldBefore(t)).map((w, i) => (i ? <Fragment key={i}><wbr />{w}</Fragment> : <Fragment key={i}>{w}</Fragment>));
  return (
    <>
      {inlineParts(text).map((p, i) => (p.code ? <code key={i}>{breaks ? words(p.text) : p.text}</code> : <span key={i}>{breaks ? words(p.text) : <Words>{p.text}</Words>}</span>))}
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

/** report.md's blocks, a section the step shows around it already gathered under its heading (`fold`). */
type MdPart = { fold: null; b: MdBlock } | { fold: string; blocks: MdBlock[] };

/**
 * report.md's blocks with each section `titles` names (`### What failed`) gathered under its
 * heading, up to the next heading. The report's last line, what the repair cost, is in no section.
 */
export function foldedBlocks(blocks: readonly MdBlock[], titles: readonly string[]): MdPart[] {
  const out: MdPart[] = [];
  let into: MdBlock[] | null = null;
  for (const [i, b] of blocks.entries()) {
    if (b.kind === 'h') into = null;
    const foot = i === blocks.length - 1 && b.kind === 'p' && b.text.startsWith('Cost:');
    if (into && !foot) into.push(b);
    else if (b.kind === 'h' && titles.includes(b.text)) {
      into = [];
      out.push({ fold: b.text, blocks: into });
    } else out.push({ fold: null, b });
  }
  return out;
}

/**
 * report.md as the repair writes it, the pull request's body, boxed as a preview of it (`.prbody.md`)
 * and drawn from blocks, never as HTML. Its sections the step shows around it already (`folds`,
 * by heading: What failed and Candidates) start closed: the heading, a summary of the section
 * (`1 run · lost at model call #5`) and a caret that opens it.
 */
export function Markdown({ text, folds = {} }: { text: string; folds?: Readonly<Record<string, string>> }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="prbody md">
      {foldedBlocks(blocks, Object.keys(folds)).map((p, i) => (p.fold === null ? <Block key={i} b={p.b} /> : <Fold key={p.fold} title={p.fold} summary={folds[p.fold] ?? ''} blocks={p.blocks} />))}
    </div>
  );
}

/** A section of report.md that opens on request: `Show what failed`. */
function Fold({ title, summary, blocks }: { title: string; summary: string; blocks: readonly MdBlock[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const name = `${title.charAt(0).toLowerCase()}${title.slice(1)}`;
  return (
    <>
      <h4 className="mdh">
        <span>{title}</span>
        <span className="mds">{summary}</span>
        <button type="button" className="xbtn" aria-expanded={open} aria-controls={open ? id : undefined} aria-label={`${open ? 'Hide' : 'Show'} ${name}`} onClick={() => setOpen(!open)}>
          <Icon name="caret" />
        </button>
      </h4>
      {open ? (
        <div id={id}>
          {blocks.map((b, i) => (
            <Block key={i} b={b} />
          ))}
        </div>
      ) : null}
    </>
  );
}
