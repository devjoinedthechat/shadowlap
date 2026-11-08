import { useRef, type ReactNode } from 'react';
import { AboutLine, useFitAbouts } from '../components/About.js';
import { tipCard } from '../components/HoverCard.js';
import { Id } from '../components/Id.js';
import { MatrixKey, type KeyEntry } from '../components/MatrixKey.js';
import { Receipt } from '../components/Receipt.js';
import { DecisionCells, topCall } from './DecisionCells.js';
import { glossed } from '../components/Term.js';
import { outcomeTone, receiptWords } from '../decisions.js';
import { glueBound } from '../matrix.js';
import { useListKeys } from '../list-keys.js';
import { href } from '../route.js';
import type { PreviewKeyEntry, PreviewSession } from '../types.js';

/**
 * A preview's matrix (Changes › Preview): one grid, a row per run named by its id with its about
 * line and the golden it came from, a cell per model call in its consequence colour (split a band a
 * sample where its samples differ; past 60 calls a cell stands for a range, drawn as its most
 * consequential call), and what changed most. The key sits in its head, over the cells it explains;
 * what couldn't be asked or judged closes it in amber, the receipt under a hairline at its foot.
 * A row is one Tab stop, ← → Home End along its cells; j and k move over the rows, Enter opens a
 * run's most telling step.
 */

type Row = PreviewSession['matrix'][number];

const SWATCH: Record<PreviewKeyEntry['sw'], ReactNode> = {
  w: <i className="dg w" aria-hidden="true" />,
  s: <i className="dg s" aria-hidden="true" />,
  r: <i className="dg r" aria-hidden="true" />,
  m: <i className="dg" aria-hidden="true" />,
  un: <i className="dg un" aria-hidden="true" />,
  jw: <i className="dg jw" aria-hidden="true" />,
  na: <i className="dg na" aria-hidden="true" />,
  spl: (
    <i className="dg spl" aria-hidden="true">
      <i className="w" />
      <i />
      <i />
    </i>
  ),
};

const keyEntry = (e: PreviewKeyEntry): KeyEntry => ({ n: e.n, words: e.words, sw: SWATCH[e.sw], tip: tipCard(e.card.title, e.card.rows.map(([label, value]: [string, string]) => ({ label, value })), e.card.text) });

/** What a row ends on: what flags it in its colour, else its biggest change, quiet, and why it doesn't flag; then what verify found. */
function Ending({ row, cleared }: { row: Row; cleared: string }) {
  if (!row.inStore) return <p className="dsl dsm">not in the store</p>;
  const e = row.ending;
  const tone = e.tone === 'w' ? 'dsd q1' : e.tone === 's' ? 'dsd q2' : e.tone === 'y' ? 'dsy' : e.callNo === null ? 'dsm' : 'dsd';
  return (
    <>
      <p className="dsl" data-tip={e.why ? tipCard(e.text, [], e.why) : undefined}>
        <span className={tone}>{e.text}</span>
        {e.then ? <span className="dsm">{` ${e.then}`}</span> : null}
        {e.waits ? <span className="dsy">{` · ${e.waits} wait${e.waits === 1 ? 's' : ''} on a judge`}</span> : null}
      </p>
      {row.verified ? (
        <span className={`dsv ${outcomeTone(row.verified.outcome)}`}>
          <b>{glossed(row.verified.outcome)}</b>
          {glueBound(row.verified.tally)}
        </span>
      ) : row.cleared ? (
        <span className="dsv" data-tip={tipCard('Not run end to end', [], cleared)}>
          not run end to end
        </span>
      ) : null}
    </>
  );
}

export function DecisionMatrix({ session, open, onOpen }: { session: PreviewSession; open: { run: string; call: number | null } | null; onOpen: (run: string, call: number | null) => void }) {
  const { view, matrix } = session;
  const box = useRef<HTMLDivElement>(null);
  useFitAbouts(box);
  const inFocus = useListKeys({
    rows: matrix,
    keyOf: (row) => row.runId,
    root: box,
    open: (row) => onOpen(row.runId, topCall(row)),
    // A row is drawn as its cells (`display: contents`): its label takes the focus.
    box: (el) => (el.firstElementChild as HTMLElement | null) ?? el,
  });
  return (
    <section className="dmx" aria-label="Decisions, a row per run, a cell per model call">
      <div className="dmg" ref={box}>
        <div className="dmkey">
          <MatrixKey main={view.key.main.map(keyEntry)} quiet={view.key.quiet.map(keyEntry)} />
        </div>
        <div className="dmh" aria-hidden="true">
          <span>Run</span>
          <span>Model calls, in order</span>
          <span>What changed most</span>
        </div>
        {matrix.map((row) => {
          const mine = open?.run === row.runId;
          const call = topCall(row);
          return (
            <div key={row.runId} className={['dmr', mine ? 'open' : '', inFocus === row.runId ? 'krow' : ''].filter(Boolean).join(' ')} data-rowkey={row.runId}>
              <div className="dml" tabIndex={-1}>
                <span className="dmid">
                  {row.inStore ? <Id id={row.runId} list href={href.run(row.runId, call, 'decisions')} about={row.about?.text ?? null} /> : <Id id={row.runId} list />}
                  {row.golden ? <span className="chip">{row.golden.replace(/^goldens\//, '')}</span> : null}
                </span>
                {row.about ? <AboutLine about={row.about} className="dmab" /> : null}
              </div>
              <DecisionCells row={row} open={mine ? (open?.call ?? null) : null} onOpen={(c) => onOpen(row.runId, c)} />
              <div className="dms">
                <Ending row={row} cleared={view.cleared} />
              </div>
            </div>
          );
        })}
      </div>
      {view.warnings.length ? (
        <ul className="dnotes">
          {view.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
      <Receipt lines={receiptWords(view.receipt, view.verify?.endToEnd ?? null).map((l) => ({ parts: l.parts, tip: l.card ? tipCard(l.card.title, l.card.rows.map(([label, value]) => ({ label, value }))) : null }))} />
    </section>
  );
}
