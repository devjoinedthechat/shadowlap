import { Fragment, useCallback, useEffect, type MouseEvent } from 'react';
import { ActionButton } from '../components/ActionButton.js';
import { Conversation, useChange } from '../components/Conversation.js';
import { Decision } from '../components/Decision.js';
import { Icon } from '../components/Icon.js';
import { Id } from '../components/Id.js';
import { Link } from '../components/Link.js';
import { glossed } from '../components/Term.js';
import { cellCost, cellLead, drawnCells, outcomeTone } from '../decisions.js';
import { focusQuiet, pageUp } from '../focus-manager.js';
import { shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { glueBound } from '../matrix.js';
import { ACTIONS } from '../labels.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { useApp } from '../state.js';
import type { CellOpen, DecisionCell, DecisionRun, DecisionStep, PreviewSession, Toned } from '../types.js';
import { CLEARED_RUN, GONE_RUN, PreviewVerifyButton, VERIFY_THIS_RUN_TIP } from './VerifyAsk.js';

/**
 * A preview's cell, opened (`#/changes/decisions/<session>/<run>/<call>`): its most consequential
 * change and how often, or why nothing was compared; for a range, the calls it stands for and the
 * others that changed; the recorded and the changed decision side by side; each changed argument
 * field by field and the other changes; the judge checks' verdicts; the tokens and cost either way;
 * then the conversation up to the call, as the inspector draws it. A run no longer in the store has
 * no page to open and no conversation.
 */

type Row = PreviewSession['matrix'][number];

/** The report's step behind a cell, which keeps both decisions: a preview keeps its runs under `runs`, a migration under `decisions`. */
function stepOf(session: PreviewSession, runId: string, callNo: number): DecisionStep | null {
  const runs = (session.runs ?? (session.decisions as { runs?: unknown } | undefined)?.runs) as DecisionRun[] | undefined;
  return runs?.find((r) => r.runId === runId)?.decisions.find((s) => s.callNo === callNo) ?? null;
}

/** Set as a press opens a cell: its panel, as it first draws, comes into view. An address opened afresh leaves the page where it is. */
let reveal = false;
export const revealCell = (): void => {
  reveal = true;
};

/**
 * A cell opens under the matrix, and pressed again closes, in place of the address as a pick in a page
 * is: Back leaves Preview rather than walking back through every cell opened, and the page keeps its
 * scroll. A cell that opens is brought into view the nearest way, as one from a tall matrix's top row
 * could open below the window.
 */
export function openCell(kind: 'decisions' | 'migrate', sessionId: string, run: string, call: number | null, current: boolean): void {
  if (!current) revealCell();
  navigate(current ? href.changeSession(kind, sessionId) : href.changeSession(kind, sessionId, run, call), true);
}

/** The cell an address opens: its run's row at its call; a run's address without a call, the call its row ends on, else its first. */
export function openedCell(session: PreviewSession, run: string | null, call: number | null): { row: PreviewSession['matrix'][number]; callNo: number } | null {
  const row = run ? session.matrix.find((r) => r.runId === run) : undefined;
  const callNo = call ?? row?.ending.callNo ?? row?.cells[0]?.callNo ?? null;
  return row && callNo !== null ? { row, callNo } : null;
}

/**
 * An opened cell closes by Esc or its ×, back to its session's page in place of the address (as the
 * cell opened), the focus on the cell's own button where it was in the panel or lost. Esc closes it
 * before the matrix lets go of its row: the shell asks `pageUp` first.
 */
function useCellClose(to: string): () => boolean {
  const close = useCallback((): boolean => {
    const a = document.activeElement;
    const lost = !a || a === document.body || !!a.closest('#dcell');
    const cell = lost ? document.querySelector<HTMLElement>('.dmx button.dc[aria-current="true"]') : null;
    navigate(to, true);
    if (cell) focusQuiet(cell);
    return true;
  }, [to]);
  useEffect(() => {
    pageUp.current = close;
    return () => {
      if (pageUp.current === close) pageUp.current = null;
    };
  }, [close]);
  return close;
}

/** A plain press of a link the page handles itself; one with a modifier, or another button, opens as a link does. */
const plainPress = (e: MouseEvent): boolean => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

export function DecisionCellPanel({ session, row, callNo }: { session: PreviewSession; row: Row; callNo: number }) {
  const cell = row.cells.find((c) => c.callNo === callNo) ?? null;
  const close = href.changeSession(session.kind, session.sessionId);
  const shut = useCellClose(close);
  useEffect(() => {
    if (!reveal) return;
    reveal = false;
    document.querySelector<HTMLElement>('#dcell')?.scrollIntoView({ block: 'nearest' });
  }, []);
  const runLink = href.run(row.runId, callNo, 'decisions');
  const step = cell ? stepOf(session, row.runId, callNo) : null;
  return (
    <section className="panel dcell" id="dcell" aria-label={`Model call #${callNo} of ${shortId(row.runId)}`}>
      <header className="dch">
        <h2>
          <code>#{callNo}</code>
          {cell ? ` · step ${cell.step}` : null} of {row.inStore ? <Id id={row.runId} href={runLink} about={row.about?.text ?? null} /> : <Id id={row.runId} />}
        </h2>
        {row.golden ? <span className="chip">{row.golden.replace(/^goldens\//, '')}</span> : null}
        {step?.scope ? <span className="scopetag">{step.scope}</span> : null}
        <span className="sp" />
        <span className="dacts">
          <CellVerify session={session} row={row} />
          {row.inStore ? (
            <a className="btn" href={runLink}>
              Open run
            </a>
          ) : null}
          <a
            className="ibtn"
            href={close}
            aria-label="Close"
            onClick={(e) => {
              if (!plainPress(e)) return;
              e.preventDefault();
              shut();
            }}
          >
            <Icon name="x" />
          </a>
        </span>
      </header>
      <div className="pbody">
        {cell ? <CellBody session={session} row={row} cell={cell} step={step} /> : <p className="dlead">This run has no model call #{callNo} in this preview.</p>}
      </div>
      {cell && row.inStore ? <CellConversation row={row} callNo={callNo} /> : null}
    </section>
  );
}

/**
 * Verify this run, before Open run: plain, on a run the preview left to verify that verify hasn't
 * taken; waiting, with why, on one the preview cleared or one gone from the store; none once verify
 * took it, nor on a migration, which Changes never verifies from here.
 */
function CellVerify({ session, row }: { session: PreviewSession; row: Row }) {
  if (session.kind !== 'decisions' || row.verified) return null;
  const label = ACTIONS.verifyThisRun.label;
  if (!row.toVerify)
    return (
      <ActionButton className="btn" why={CLEARED_RUN.why} tip={CLEARED_RUN.tip}>
        {label}
      </ActionButton>
    );
  if (!row.inStore)
    return (
      <ActionButton className="btn" why={GONE_RUN} tip={VERIFY_THIS_RUN_TIP}>
        {label}
      </ActionButton>
    );
  return <PreviewVerifyButton sessionId={session.sessionId} change={session.view.change} rows={[{ runId: row.runId, golden: row.golden, about: row.about?.text ?? null, verified: null }]} label={label} one tip={VERIFY_THIS_RUN_TIP} />;
}

function CellBody({ session, row, cell, step }: { session: PreviewSession; row: Row; cell: DecisionCell; step: DecisionStep | null }) {
  const v = session.view;
  const lead = cellLead(cell);
  const open: CellOpen | null = cell.open ?? null;
  const several = v.samples > 1;
  return (
    <>
      <p className="dlead">
        {'sentence' in lead ? (
          lead.sentence
        ) : (
          <>
            {lead.rank ? (
              <>
                <b className={`drk q${lead.rank}`}>rank {lead.rank}</b>{' '}
              </>
            ) : null}
            {lead.text}
            {lead.quiet ? <span className="dlm">{`\u00a0${lead.quiet}`}</span> : null}
          </>
        )}
        {row.verified ? (
          <span className={`dlv ${outcomeTone(row.verified.outcome)}`}>
            verified: <b>{glossed(row.verified.outcome)}</b>
            {glueBound(row.verified.tally)}
          </span>
        ) : null}
      </p>
      <RangeLine session={session} row={row} callNo={cell.callNo} />
      {step?.now && open ? (
        <>
          <div className="dpair">
            <div className="dside">
              <span className="k">recorded · {step.model.recorded ?? 'its model'}</span>
              <Decision d={step.recorded} other={step.now} side="recorded" stop={open.stops.recorded} stopDiffers={step.recorded.stop !== step.now.stop} />
            </div>
            <div className={`dside${cell.state === 'ranked' && cell.rank ? ` q${cell.rank}` : ''}`}>
              <span className="k">
                {v.side}
                {several && (cell.state === 'ranked' || cell.state === 'noise') && cell.rank !== 0 ? ' · its most consequential sample' : ''}
              </span>
              <Decision d={step.now} other={step.recorded} side="now" stop={open.stops.now} stopDiffers={step.recorded.stop !== step.now.stop} />
            </div>
          </div>
          {open.args.length || step.changes.length > 1 ? (
            <ul className="dchg">
              {open.args.map((a) => (
                <li key={a} className="dargs">
                  <code>{a}</code>
                </li>
              ))}
              {step.changes.slice(1).map((x, i) => (
                <li key={i}>
                  <span className="dalso">also</span>
                  <b className={`drk q${x.rank}`}>rank {x.rank}</b> {x.detail}
                </li>
              ))}
            </ul>
          ) : null}
          {open.judges.length ? (
            <ul className="djudge">
              {open.judges.map((j, i) => (
                <li key={i}>
                  <span className="jn">judge "{j.name}"</span> <TonedWords words={j.words} />
                </li>
              ))}
            </ul>
          ) : null}
          <p className="dspend">{cellCost(open.delta, v)}</p>
        </>
      ) : null}
    </>
  );
}

/** The engine's words in their colours: a verdict green or red, inconclusive amber, the rest as it is. */
function TonedWords({ words }: { words: readonly Toned[] }) {
  return (
    <>
      {words.map((w, i) => (w.tone === 'ok' || w.tone === 'no' || w.tone === 'y' ? <b key={i} className={w.tone}>{w.text}</b> : <Fragment key={i}>{w.text}</Fragment>))}
    </>
  );
}

/** For a cell that stands for a range: the calls it stands for, and the others that changed, each opening. */
function RangeLine({ session, row, callNo }: { session: PreviewSession; row: Row; callNo: number }) {
  const range = drawnCells(row.cells).find((c) => c.count > 1 && c.first.callNo <= callNo && callNo <= c.last.callNo);
  if (!range) return null;
  const part = row.cells.slice(row.cells.indexOf(range.first), row.cells.indexOf(range.last) + 1);
  const others = part.filter((x) => x.rank && x.callNo !== callNo);
  return (
    <p className="dbin">
      This cell stands for model calls #{range.first.callNo}–#{range.last.callNo}
      {others.length ? '; the others that changed: ' : ', and none of the others changed'}
      {others.map((x, i) => (
        <Fragment key={x.callNo}>
          {i ? ', ' : null}
          <Link href={href.changeSession(session.kind, session.sessionId, row.runId, x.callNo)}>
            #{x.callNo}
          </Link>{' '}
          <span className="dlm">rank {x.rank}</span>
        </Fragment>
      ))}
      .
    </p>
  );
}

/** The conversation up to the call, read as the inspector reads it, the message a fork changed marked against its parent's. */
function CellConversation({ row, callNo }: { row: Row; callNo: number }) {
  const { client } = useApp();
  const detail = useLoad(() => client.call(row.runId, callNo), `call:${row.runId}:${callNo}`);
  const change = useChange({ parent: row.parent, forkAt: row.forkAt, detail: detail.data ?? null, by: 'fork' });
  return (
    <div className="dconv">
      {detail.error ? <div className="ibar err">{detail.error.message}</div> : !detail.data ? <div className="ibar">Loading #{callNo}…</div> : <Conversation detail={detail.data} change={change} foldKey={`${row.runId}:${callNo}`} />}
    </div>
  );
}
