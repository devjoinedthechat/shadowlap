import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import type { CallDetail, RunListItem } from '../api.js';
import { Org } from '../components/bits.js';
import { Code, Copy, Words } from '../components/Copy.js';
import { Decision } from '../components/Decision.js';
import { DotParts } from '../components/DotParts.js';
import { Icon } from '../components/Icon.js';
import { Id } from '../components/Id.js';
import { JsonDiffPart } from '../components/JsonDiffPart.js';
import { ErrorState, Skeleton } from '../components/States.js';
import { dur, formatUsd, plural, shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { ORIGIN_NAME } from '../origins.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { failureNote, tokensText } from '../run/calls.js';
import { runKindWords, runLikeOf } from '../run/model.js';
import { runType } from '../runs.js';
import { useApp } from '../state.js';
import { errorText } from '../toast.js';
import type { ArgPiece, ArgRun } from './args.js';
import type { Piece } from '../json-diff.js';
import { callOrigin, callWords, openRow, rowParts, sideClass, type Pair, type PathCall, type PathRow, type RowPart } from './paths.js';
import type { PairRun } from './Verdict.js';

/**
 * Both paths after the identical prefix in one list, a row a call, each column headed by its run:
 * a model call by what it decided, a tool by its name and effect, the words that differ from the
 * other side's marked, a call both made alike dimmed, a side that had ended left empty. Every row is
 * a button: it opens both calls under it, side by side (`#/compare/<a>/<b>/<n>`, by the row's
 * number), and closes them again, as their × does; the address only is replaced, so the row keeps
 * the focus. Each side is named by its run's id; `at` is the pair as its address names it, which a
 * row's address keeps.
 */
export function PairRows({ a, b, at, pair, call, runs, flag }: { a: PairRun; b: PairRun; at: { a: string; b: string }; pair: Pair; call: number | null; runs: readonly RunListItem[]; /** The flag that made the fork (`--fail-at 19=529`), which an injected failure's note names. */ flag: string | null }) {
  const open = openRow(pair.rows, call);
  const list = useRef<HTMLDivElement>(null);
  const toggle = (n: number | null) => navigate(href.compare(at.a, at.b, n), true);
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
        <Fragment key={r.n}>
          <button type="button" className={`cprow${r.n === open ? ' open' : ''}`} data-n={r.n} aria-expanded={r.n === open} aria-controls={r.n === open ? 'cmpd' : undefined} onClick={() => toggle(r.n === open ? null : r.n)}>
            <span className="cpn">#{r.n}</span>
            <Side id={a.id} row={r} side="a" />
            <Side id={b.id} row={r} side="b" />
          </button>
          {r.n === open ? <Opened a={a.id} b={b.id} at={at} row={r} flag={flag} onClose={() => close(r.n)} /> : null}
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

/**
 * The row opened: both calls side by side under it, as their runs' inspectors show them, each
 * opening its run there; the same tool's arguments and result as one split diff. It reads both calls
 * first: until both are in it says it is loading, and where one can't be read it says why, with Retry.
 */
function Opened({ a, b, at, row, flag, onClose }: { a: string; b: string; at: { a: string; b: string }; row: PathRow; flag: string | null; onClose: () => void }) {
  const { client } = useApp();
  const n = row.n;
  const da = useLoad(() => (row.a ? client.call(a, row.a.callNo) : null), `${a}:${row.a?.callNo ?? 'none'}:cmp`);
  const db = useLoad(() => (row.b ? client.call(b, row.b.callNo) : null), `${b}:${row.b?.callNo ?? 'none'}:cmp`);
  const ref = useRef<HTMLElement>(null);
  // Opened from a row or from the address, it scrolls into view once, the focus left where it is.
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  const failed = da.error ?? db.error;
  const retry = () => {
    if (da.error) da.reload();
    if (db.error) db.reload();
  };
  return (
    <section className="cmpd" id="cmpd" aria-label={`#${n} in both runs`} ref={ref}>
      <a
        className="ibtn cmpx"
        href={href.compare(at.a, at.b)}
        aria-label={`Close #${n}`}
        onClick={(e) => {
          e.preventDefault();
          onClose();
        }}
      >
        <Icon name="x" />
      </a>
      {failed ? (
        <ErrorState retry={retry}>{errorText(failed)}</ErrorState>
      ) : da.loading || db.loading ? (
        <Skeleton what={`#${n} in both runs`} lines={4} />
      ) : (
        <BothCalls a={a} b={b} row={row} da={da.data} db={db.data} flag={flag} />
      )}
    </section>
  );
}

/** Both calls of an opened row, once both are in: side by side, the same tool's arguments and result as one split diff under them, else each side's under its own call. */
function BothCalls({ a, b, row, da, db, flag }: { a: string; b: string; row: PathRow; da: CallDetail | null; db: CallDetail | null; flag: string | null }) {
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
  const side = (s: 'a' | 'b', own: boolean) => <OpenedSide id={s === 'a' ? a : b} otherId={s === 'a' ? b : a} c={s === 'a' ? row.a : row.b} other={s === 'a' ? row.b : row.a} detail={s === 'a' ? da : db} flag={flag} side={s} own={own} />;
  if (!(row.a?.kind === 'tool' && row.b?.kind === 'tool' && row.a.name === row.b.name))
    return both(
      <>
        {side('a', true)}
        {link(a, row.a)}
      </>,
      <>
        {side('b', true)}
        {link(b, row.b)}
      </>,
    );
  const [va, vb] = [toolValues(da), toolValues(db)];
  return (
    <>
      {both(side('a', false), side('b', false))}
      <p className="cmpk">Arguments</p>
      <JsonDiffPart was={va.args} now={vb.args} split />
      <p className="cmpk">Result</p>
      <JsonDiffPart was={va.result} now={vb.result} split />
      {both(link(a, row.a), link(b, row.b))}
    </>
  );
}

/** Why a model call failed, as its inspector's note says it before it says what its view shows (failureNote). */
function FailureNote({ by, d, flag }: { by: NonNullable<PathCall['failure']>['by']; d: CallDetail; flag: string | null }) {
  const note = failureNote(d.call, by, flag);
  return (
    <p className="cmpnote">
      {/* as the inspector's note says it (CallNote) */}
      <b>{note.word}</b> {note.why.map((p, i) => (typeof p === 'string' ? <Words key={i}>{p}</Words> : <Code key={i}>{p.code}</Code>))}
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

/**
 * A call as its side of the opened row heads it: the status it got and why, its decision beside the
 * other side's (a tool the other run doesn't call heard as `not called in <its id>`, then how many
 * more tool calls it made than its row lists), or a tool's name and effect.
 */
function OpenedCall({ c, other, otherId, detail, flag, side }: { c: PathCall; other: PathCall | null; otherId: string; detail: CallDetail | null; flag: string | null; side: 'a' | 'b' }) {
  if (c.kind === 'api' && c.failure)
    return (
      <>
        <p className="cmperr">
          <b>{callWords(c)[0]!.text}</b>
        </p>
        {detail ? <FailureNote by={c.failure.by} d={detail} flag={flag} /> : null}
      </>
    );
  if (c.decision) {
    // The other side's decision where it is a model call's, else this one's own, so nothing reads as missing there.
    const theirs = other?.kind === 'api' && !other.failure && other.decision ? other.decision : c.decision;
    return <Decision d={c.decision} other={theirs} side={side === 'a' ? 'recorded' : 'now'} stop={c.decision.stops} stopDiffers={theirs.stop !== c.decision.stop} notCalled={`, not called in ${shortId(otherId)}`} more={c.decision.moreTools ?? 0} />;
  }
  if (c.kind === 'api') return null;
  return (
    <p className="cmptool">
      <b>{c.name}</b>
      {effectTag(c)}
    </p>
  );
}

/** One side of the opened row: its run, its call (OpenedCall), what it cost and took, then a tool's arguments and result where the other side's isn't the same tool. */
function OpenedSide({ id, otherId, c, other, detail, flag, side, own }: { id: string; otherId: string; c: PathCall | null; other: PathCall | null; detail: CallDetail | null; flag: string | null; side: 'a' | 'b'; own: boolean }) {
  const who = (
    <p className="cmpwho">
      <code className="rnm">{shortId(id)}</code>
    </p>
  );
  if (!c)
    return (
      <>
        {who}
        <Copy className="cmpnone">No call: the run had ended.</Copy>
      </>
    );
  const values = toolValues(detail);
  return (
    <>
      {who}
      <OpenedCall c={c} other={other} otherId={otherId} detail={detail} flag={flag} side={side} />
      <p className="cmpmeta">
        <DotParts parts={metaWords(c, detail)} />
      </p>
      {c.kind !== 'api' && own ? (
        <>
          <p className="cmpk">Arguments</p>
          <JsonDiffPart was={values.args} now={values.args} />
          <p className="cmpk">Result</p>
          <JsonDiffPart was={values.result} now={values.result} />
        </>
      ) : null}
    </>
  );
}
