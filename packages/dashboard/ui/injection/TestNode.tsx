import { Fragment } from 'react';
import { useOfflineLink } from '../components/ActionButton.js';
import { Glyph } from '../components/RunIcon.js';
import { glossed } from '../components/Term.js';
import { shortId, stamp } from '../format.js';
import { href } from '../route.js';
import { openResults } from '../run/panel-state.js';
import type { InjectionRow, LineageNode } from '../types.js';
import { testNode, type TestCell } from './fork-node.js';

/**
 * A kept injection test in the Forks view, under the run it tested, as the design files one: its
 * title opening that run with its results (a --clean answer's run, which draws the answer), its line
 * glossed, a --clean answer's rule under it once in the family, its replays as one picture, and lines
 * that open the attempts its verdict rests on. The node is no link of its own, and its strip is a
 * picture: a cell is a mark too small to be a target (WCAG 2.5.8), its replay on hover, so the strip
 * takes no Tab stop, as AttemptList draws more than six attempts.
 */
export function TestNode({ row, runs, current, rule }: { row: InjectionRow; runs: readonly LineageNode[]; current: string; rule: string | null }) {
  const v = testNode(row, runs);
  const attemptLink = useOfflineLink();
  const results = row.mode === 'plant' && !row.running;
  return (
    <div className={`fnode fb${v.runs.has(current) ? ' here' : ''}`}>
      <Glyph kind={v.glyph.kind} label={v.glyph.label} />
      <div className="fmain">
        <span className="f1">
          <a className="more fbt" href={href.run(row.runId)} onClick={results ? () => openResults(row.runId, `injection:${row.resultId}`) : undefined}>
            <code>{v.title}</code>
          </a>
        </span>
        <span className="f2 block">
          <GlossedParts parts={v.parts} />
          {rule ? <span className="frule">{rule}</span> : null}
        </span>
        {v.cells.length || v.replays.length ? (
          // a picture of the replays in the order they ran, each one's card on hover, its words said once for a screen reader
          <div className="astrip" role="img" aria-label={v.label}>
            {v.cells.map(mark)}
            {v.replays.length ? <span className="acsep" /> : null}
            {v.replays.map(mark)}
          </div>
        ) : null}
        {v.lines.length || v.more ? (
          <div className="alist">
            {v.lines.map((l) => (
              <span key={l.runId} className="al">
                <i className={l.tone} aria-hidden="true" />
                <a className="more rlink" href={href.run(l.runId, l.callNo)} onClick={attemptLink}>
                  <code className="rnm">{shortId(l.runId)}</code>
                </a>
                <span className="an"> · {glossed(l.words)}</span>
              </span>
            ))}
            {v.more ? <span className="more2">{v.more}</span> : null}
          </div>
        ) : null}
      </div>
      <span className="fr">{stamp(row.at)}</span>
    </div>
  );
}

const mark = (c: TestCell) => <i key={c.runId} className={`ac ${c.tone}`} data-tip={JSON.stringify(c.card)} />;

/** The line's parts joined by dots, each short one kept whole as DotParts keeps a receipt's, its glossary words carded. */
function GlossedParts({ parts }: { parts: readonly string[] }) {
  return (
    <>
      {parts.map((p, i) => {
        const text = glossed(i < parts.length - 1 ? `${p} ·` : p);
        return (
          <Fragment key={i}>
            {i ? ' ' : null}
            {p.length <= 44 ? <span className="nw">{text}</span> : text}
          </Fragment>
        );
      })}
    </>
  );
}
