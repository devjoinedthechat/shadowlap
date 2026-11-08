import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import type { CallDetail, RunListItem } from '../api.js';
import { Org } from '../components/bits.js';
import { Decision } from '../components/Decision.js';
import { Icon } from '../components/Icon.js';
import { Id } from '../components/Id.js';
import { JsonDiffPart } from '../components/JsonDiffPart.js';
import { dur, formatUsd, plural, shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { ORIGIN_NAME } from '../origins.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { failedWhy, tokensText } from '../run/calls.js';
import { runKindWords, runLikeOf } from '../run/model.js';
import { runType } from '../runs.js';
import { useApp } from '../state.js';
import type { ArgPiece, ArgRun } from './args.js';
import type { Piece } from '../json-diff.js';
import { callOrigin, openRow, rowParts, sideClass, type Pair, type PathCall, type PathRow, type RowPart } from './paths.js';
import type { PairRun } from './Verdict.js';

/**
 * Both paths after the identical prefix in one list, a row a call, each column headed by its run:
 * a model call by what it decided, a tool by its name and effect, the words that differ from the
 * other side's marked, a call both made alike dimmed, a side that had ended left empty. Every row is
 * a button: it opens both calls under it, side by side (`#/compare/<a>/<b>/<call>`), and closes them
 * again, as their × does; the address only is replaced, so the row keeps the focus.
 */
export function PairRows({ a, b, pair, call, runs, flag }: { a: PairRun; b: PairRun; pair: Pair; call: number | null; runs: readonly RunListItem[]; /** The flag that made the fork (`--fail-at 19=529`), which an injected failure's note names. */ flag: string | null }) {
  const open = openRow(pair.rows, call);
  const list = useRef<HTMLDivElement>(null);
  const toggle = (n: number | null) => navigate(href.compare(a.id, b.id, n), true);
  // The × goes with the part it closes: the focus goes back to its row.
  const close = (n: number) => {
    toggle(null);
    list.current?.querySelector<HTMLButtonElement>(`button.cprow[data-n="${n}"]`)?.focus();
  };
  return (
    <div className="paths2" role="group" aria-label="Both runs after the identical prefix, a row a call" ref={list}>
      <div className="cprow cphead">
        <span className="cpn" />
        <ColumnHead side={a} from={pair.from.a} runs={runs} />
        <ColumnHead side={b} from={pair.from.b} runs={runs} />
      </div>
      {pair.rows.map((r) => (
        <Fragment key={r.callNo}>
          <button type="button" className={`cprow${r.callNo === open ? ' open' : ''}`} data-n={r.callNo} aria-expanded={r.callNo === open} aria-controls={r.callNo === open ? 'cmpd' : undefined} onClick={() => toggle(r.callNo === open ? null : r.callNo)}>
            <span className="cpn">#{r.callNo}</span>
            <Side id={a.id} row={r} side="a" />
            <Side id={b.id} row={r} side="b" />
          </button>
          {r.callNo === open ? <Opened a={a.id} b={b.id} row={r} flag={flag} onClose={() => close(r.callNo)} /> : null}
        </Fragment>
      ))}
    </div>
  );
}

/** A column's head: the run's id, its about line on hover, then its kind as its page's eyebrow says it and how many calls it made after the prefix. */
function ColumnHead({ side, from, runs }: { side: PairRun; from: number; runs: readonly RunListItem[] }) {
  const prefix = from - 1;
  const about = runs.find((r) => r.runId === side.run?.run.runId)?.about?.text;
  const kind = side.run ? runKindWords(side.run, runType(runLikeOf(side.run)), side.rescued) : null;
  const after = side.run ? Math.max(0, side.run.callsTotal - prefix) : null;
  return (
    <span className="cph">
      <Id id={shortId(side.id)} about={about} />
      {kind !== null && after !== null ? (
        <span className="pk">
          <span className="nw">{kind} ·</span> <span className="nw">{`${plural(after, 'call')}${prefix ? ` after #${prefix}` : ''}`}</span>
        </span>
      ) : null}
    </span>
  );
}

/** A run of words, marked where it differs from the other side's. */
function Marked({ pieces }: { pieces: readonly Pick<Piece, 'text' | 'marked'>[] }) {
  return (
    <>
      {pieces.map((p, i) =>
        p.marked ? (
          <mark key={i} className="jdw">
            {p.text}
          </mark>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </>
  );
}

/** Runs of an argument's text, a line free to break after each `wbr`. */
function Runs({ runs }: { runs: readonly ArgRun[] }) {
  return (
    <>
      {runs.map((r, i) => (
        <Fragment key={i}>
          {r.marked ? <mark className="jdw">{r.text}</mark> : r.text}
          {r.wbr ? <wbr /> : null}
        </Fragment>
      ))}
    </>
  );
}

/** Arguments in pieces a line breaks between, each kept whole where it fits its column: after its key's colon where it doesn't. */
function ArgsPieces({ pieces }: { pieces: readonly ArgPiece[] }) {
  return (
    <>
      {pieces.map((p, i) => (
        <Fragment key={i}>
          {i ? <wbr /> : null}
          {p.kind === 'words' ? (
            p.parts.map((w, k) =>
              w.whole ? (
                <span key={k} className="nw">
                  <Runs runs={w.runs} />
                </span>
              ) : (
                <Runs key={k} runs={w.runs} />
              ),
            )
          ) : p.key ? (
            <span className="jdv">
              <Runs runs={p.key} />
              <wbr />
              <span className="jdv">
                <Runs runs={p.value} />
              </span>
            </span>
          ) : (
            <span className="jdv">
              <Runs runs={p.value} />
            </span>
          )}
        </Fragment>
      ))}
    </>
  );
}

function Part({ p }: { p: RowPart }) {
  return <span className={p.kind}>{'pieces' in p ? <ArgsPieces pieces={p.pieces} /> : 'marked' in p ? <Marked pieces={p.marked} /> : p.text}</span>;
}

/** A tool's effect tag, what it does or `input` for a person's answer, after a space a screen reader hears; none for any other call. */
function effectTag(c: Pick<PathCall, 'kind' | 'input' | 'effect'>): ReactNode {
  if (c.kind !== 'tool' || (!c.input && !c.effect)) return null;
  return (
    <>
      <span className="sr"> </span>
      {c.input ? <span className="eff input">input</span> : <span className={`eff ${c.effect!}`}>{c.effect}</span>}
    </>
  );
}

/** A side of a row: the run named for a screen reader after the row's number, then its call, its effect and its origin, a heard space between each. */
function Side({ id, row, side }: { id: string; row: PathRow; side: 'a' | 'b' }) {
  const c = side === 'a' ? row.a : row.b;
  const other = side === 'a' ? row.b : row.a;
  if (!c)
    return (
      <span className="pside none">
        <span className="sr"> {shortId(id)}: no call</span>
      </span>
    );
  const parts = rowParts(c, other, row.similar);
  const marked = parts.some((p) => !('text' in p));
  return (
    <span className={sideClass(row, side)}>
      <span className="pnm">
        <span className="sr"> {shortId(id)}: </span>
        <span className={`pdec${marked ? ' wrap' : ''}`}>
          {parts.map((p, i) => (
            <Fragment key={i}>
              {i ? ' ' : null}
              <Part p={p} />
            </Fragment>
          ))}
        </span>
        {effectTag(c)}
      </span>
      <span className="sr"> </span>
      <Org origin={callOrigin(c)} />
    </span>
  );
}

/** A tool's arguments and its result as the call's detail holds them. */
function toolValues(d: CallDetail | null): { args: unknown; result: unknown } {
  if (!d) return { args: null, result: null };
  const result = d.result as { result?: unknown; error?: unknown } | null;
  return { args: (d.request as { args?: unknown } | null)?.args ?? d.request ?? null, result: result ? (result.error ?? result.result ?? null) : null };
}

/** The row opened: both calls side by side under it, as their runs' inspectors show them, each opening its run there; the same tool's arguments and result as one split diff. */
function Opened({ a, b, row, flag, onClose }: { a: string; b: string; row: PathRow; flag: string | null; onClose: () => void }) {
  const { client } = useApp();
  const n = row.callNo;
  const da = useLoad(() => (row.a ? client.call(a, row.a.callNo) : null), `${a}:${row.a?.callNo ?? 'none'}:cmp`).data;
  const db = useLoad(() => (row.b ? client.call(b, row.b.callNo) : null), `${b}:${row.b?.callNo ?? 'none'}:cmp`).data;
  const ref = useRef<HTMLElement>(null);
  // Opened from a row or from the address, it scrolls into view once, the focus left where it is.
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  const same = row.a?.kind === 'tool' && row.b?.kind === 'tool' && row.a.name === row.b.name;
  const [va, vb] = [toolValues(da ?? null), toolValues(db ?? null)];
  const link = (id: string, c: PathCall | null) =>
    c ? (
      <a className="more" href={href.run(id, c.callNo)}>
        Open run at #{c.callNo}
        <span className="sr">, {shortId(id)}</span>
      </a>
    ) : null;
  const both = (x: ReactNode, y: ReactNode) => (
    <div className="cmpdx">
      <div className="cmpdc">{x}</div>
      <div className="cmpdc">{y}</div>
    </div>
  );
  return (
    <section className="cmpd" id="cmpd" aria-label={`#${n} in both runs`} ref={ref}>
      <a
        className="ibtn cmpx"
        href={href.compare(a, b)}
        aria-label={`Close #${n}`}
        onClick={(e) => {
          e.preventDefault();
          onClose();
        }}
      >
        <Icon name="x" />
      </a>
      {same ? (
        <>
          {both(<OpenedSide id={a} c={row.a} other={row.b} detail={da ?? null} flag={flag} side="a" />, <OpenedSide id={b} c={row.b} other={row.a} detail={db ?? null} flag={flag} side="b" />)}
          <p className="cmpk">Arguments</p>
          <JsonDiffPart was={va.args} now={vb.args} split />
          <p className="cmpk">Result</p>
          <JsonDiffPart was={va.result} now={vb.result} split />
          {both(link(a, row.a), link(b, row.b))}
        </>
      ) : (
        both(
          <>
            <OpenedSide id={a} c={row.a} other={row.b} detail={da ?? null} flag={flag} side="a" own />
            {link(a, row.a)}
          </>,
          <>
            <OpenedSide id={b} c={row.b} other={row.a} detail={db ?? null} flag={flag} side="b" own />
            {link(b, row.b)}
          </>,
        )
      )}
    </section>
  );
}

/** Why a model call failed, as its inspector's note says it before it points at the conversation. */
function FailureNote({ c, d, flag }: { c: PathCall; d: CallDetail | null; flag: string | null }) {
  const status = c.failure?.status ?? '?';
  if (c.failure?.by === 'injected') {
    const attempts = d?.call.attempts ? `, ${d.call.attempts + 1} attempts` : '';
    return (
      <p className="cmpnote">
        <b>Never sent.</b> Shadowlap answered with HTTP {status} (<code>{flag && /^--fail-at\b/.test(flag) ? flag : '--fail-at'}</code>){attempts}.
      </p>
    );
  }
  if (c.failure?.by === 'offline')
    return (
      <p className="cmpnote">
        <b>Refused.</b> The replay is offline and this request is not in the recording, so it got HTTP {status}.
      </p>
    );
  return (
    <p className="cmpnote">
      <b>Failed.</b> {d ? failedWhy(d.call) : `The provider answered HTTP ${status}.`}
    </p>
  );
}

/** What a call cost and took, in the calls list's formats: a replayed model call `replayed, not re-spent`; a call with no price leaves its cost out. */
function metaWords(c: PathCall, d: CallDetail | null): string[] {
  const origin = ORIGIN_NAME[callOrigin(c)];
  if (!d) return [origin];
  const replayed = c.origin === 'replayed';
  if (c.kind === 'api' && !c.failure) {
    if (replayed) return [origin, 'replayed, not re-spent'];
    const tokens = tokensText(d.call);
    return [origin, ...(tokens ? [`${tokens} tokens`] : []), ...(d.call.latencyMs !== null ? [dur(d.call.latencyMs)] : []), ...(d.call.cost !== null ? [formatUsd(d.call.cost)] : [])];
  }
  return [origin, ...(c.kind === 'tool' && !replayed && d.call.latencyMs !== null ? [dur(d.call.latencyMs)] : [])];
}

/** One side of the opened row: its run, then its decision, the status it got and why, or a tool's name and effect (its arguments and result where the other side's isn't the same tool), then what it cost and took. */
function OpenedSide({ id, c, other, detail, flag, side, own = false }: { id: string; c: PathCall | null; other: PathCall | null; detail: CallDetail | null; flag: string | null; side: 'a' | 'b'; own?: boolean }) {
  const who = (
    <p className="cmpwho">
      <code className="rnm">{shortId(id)}</code>
    </p>
  );
  if (!c)
    return (
      <>
        {who}
        <p className="cmpnone">No call: the run had ended.</p>
      </>
    );
  const tool = c.kind !== 'api';
  const values = toolValues(detail);
  // The other side's decision where it is a model call's, else this one's own, so nothing reads as missing there.
  const theirs = other?.kind === 'api' && !other.failure && other.decision ? other.decision : (c.decision ?? null);
  return (
    <>
      {who}
      {c.kind === 'api' && c.failure ? (
        <>
          <p className="cmperr">
            <b>HTTP {c.failure.status ?? '?'}</b>
          </p>
          <FailureNote c={c} d={detail} flag={flag} />
        </>
      ) : c.decision ? (
        <Decision d={c.decision} other={theirs} side={side === 'a' ? 'recorded' : 'now'} stop={c.decision.stops} stopDiffers={!!theirs && theirs.stop !== c.decision.stop} />
      ) : tool ? (
        <p className="cmptool">
          <b>{c.name}</b>
          {effectTag(c)}
        </p>
      ) : null}
      {tool && own ? (
        <>
          <p className="cmpk">Arguments</p>
          <JsonDiffPart was={values.args} now={values.args} />
          <p className="cmpk">Result</p>
          <JsonDiffPart was={values.result} now={values.result} />
        </>
      ) : null}
      <p className="cmpmeta">{metaWords(c, detail).join(' · ')}</p>
    </>
  );
}
