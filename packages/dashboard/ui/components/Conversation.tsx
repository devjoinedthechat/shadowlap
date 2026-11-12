import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { CallDetail, Turn, TurnBlock } from '../api.js';
import { asJson, num } from '../format.js';
import { useLoad } from '../hooks.js';
import { useApp } from '../state.js';
import { CodeText } from './Copy.js';
import { Switch } from './Switch.js';

/**
 * A model call's conversation as the model saw it (or would have, for a call that failed), drawn
 * alike by the run page's inspector and a preview's opened cell: the first two messages and the last
 * six, those between folded behind a button before the third; the message a fork changed marked, with
 * Jump to change; Format JSON, one preference for both. `from` numbers each message by the call it
 * came from, and `which` says which of a batch's conversations it is; a cell has neither. `foldKey`
 * keeps a cell's fold open while the page is (`<run>:<call>`); the inspector's is its own.
 */

/** Format JSON: one preference for every conversation drawn, as long as the page is open. */
let formatJsonPref = true;
/** The cells whose earlier messages were shown, by `<run>:<call>`. */
const unfolded = new Set<string>();

/** Where the conversation changed: the turn, the call the change was first sent at, and what changed it. */
export interface ConversationChange {
  turn: number;
  firstAt: number;
  by?: 'fork' | 'replay';
}

/** The first turn that differs from the parent's conversation at the same call, or the first one the parent didn't have; null for none. */
export function changedTurn(mine: readonly Turn[], theirs: readonly Turn[]): number | null {
  for (let i = 0; i < mine.length; i++) if (i >= theirs.length || JSON.stringify(mine[i]) !== JSON.stringify(theirs[i])) return i;
  return null;
}

/** The turn a fork changed in the conversation at a call, read against its parent's at the same call from the fork point on. */
export function useChange(o: { parent: string | null; forkAt: number | null; detail: CallDetail | null; by: 'fork' | 'replay' }): ConversationChange | null {
  const { client } = useApp();
  const { parent, forkAt, detail, by } = o;
  const n = detail?.call.callNo ?? null;
  const want = !!parent && forkAt !== null && n !== null && n >= forkAt && detail?.call.kind === 'api' && !!detail.conversation;
  const theirs = useLoad(() => (want && parent && n ? client.call(parent, n) : null), want ? `${parent}:${n}` : 'none');
  return useMemo(() => {
    const mine = detail?.conversation?.turns;
    const other = theirs.data?.conversation?.turns;
    if (!want || !mine || !other || !forkAt) return null;
    const turn = changedTurn(mine, other);
    return turn === null ? null : { turn, firstAt: forkAt, by };
  }, [want, detail, theirs.data, forkAt, by]);
}

function shown(text: string, format: boolean): string {
  if (!format) return text;
  const parsed = asJson(text);
  return parsed === undefined ? text : JSON.stringify(parsed, null, 2);
}

/** Format JSON as every conversation shares it: its value, and a setter that keeps it for the next one drawn. */
export function useFormatJson(): [boolean, (v: boolean) => void] {
  const [format, setState] = useState(formatJsonPref);
  return [
    format,
    (v: boolean) => {
      formatJsonPref = v;
      setState(v);
    },
  ];
}

export function Conversation({ detail, from, which = '', change, note, foldKey }: { detail: CallDetail; from?: ReadonlyMap<number, number> | undefined; which?: string; change: ConversationChange | null; note?: ReactNode; foldKey?: string | undefined }) {
  const c = detail.call;
  const conv = detail.conversation;
  const [format, setFormat] = useFormatJson();
  const [expanded, setExpandedState] = useState(() => (foldKey ? unfolded.has(foldKey) : false));
  const setExpanded = () => {
    if (foldKey) unfolded.add(foldKey);
    setExpandedState(true);
  };
  const changedRef = useRef<HTMLDivElement>(null);
  const [jump, setJump] = useState(false);
  useEffect(() => {
    if (jump) changedRef.current?.scrollIntoView({ block: 'center' });
  }, [jump]);
  if (!conv) return <>{note}<div className="ibar">The request could not be read as a conversation; the Request tab shows it as stored.</div></>;
  const turns = conv.turns;
  // Tool results name their call only by id in some providers: the tool's name comes from the call that asked for it.
  const names = new Map<string, string>();
  for (const t of turns) for (const b of t.blocks) if (b.type === 'tool_call' && b.id) names.set(b.id, b.name);
  const keepLast = 6;
  const hidden = expanded ? 0 : Math.max(0, turns.length - keepLast - 2);
  const visible = hidden ? [...turns.slice(0, 2).map((t, i) => [t, i] as const), ...turns.slice(2 + hidden).map((t, i) => [t, i + 2 + hidden] as const)] : turns.map((t, i) => [t, i] as const);
  return (
    <>
      {note}
      <div className="ibar">
        <span>
          {num(turns.length)} {turns.length === 1 ? 'message' : 'messages'} · what the model {c.outcome === 'error' ? 'would have seen' : 'saw'} at #{conv.fromCallNo ?? c.callNo}
          {which}
        </span>
        {change ? (
          <button
            className="linkbtn"
            type="button"
            onClick={() => {
              setExpanded();
              setJump(false);
              setTimeout(() => setJump(true));
            }}
          >
            Jump to change
          </button>
        ) : null}
        <span className="sp" />
        <Switch on={format} onChange={setFormat}>
          Format JSON
        </Switch>
      </div>
      {visible.map(([t, i]) => (
        <Fragment key={i}>
          {hidden && i === 2 + hidden ? (
            <button className="expand" type="button" onClick={setExpanded}>
              Show {hidden} earlier {hidden === 1 ? 'message' : 'messages'}
            </button>
          ) : null}
          <Message turn={t} callNo={from?.get(i) ?? null} format={format} names={names} changed={change?.turn === i} changedBy={change?.by ?? 'fork'} firstAt={change?.firstAt ?? null} innerRef={change?.turn === i ? changedRef : undefined} />
        </Fragment>
      ))}
    </>
  );
}

function Message({ turn, callNo, format, names, changed, changedBy, firstAt, innerRef }: { turn: Turn; callNo: number | null; format: boolean; names: Map<string, string>; changed: boolean; changedBy: 'fork' | 'replay'; firstAt: number | null; innerRef?: RefObject<HTMLDivElement | null> | undefined }) {
  const role = turn.role;
  return (
    <div className={`msg ${role}${changed ? ' changed' : ''}`} ref={innerRef}>
      <div className="role">
        {role}
        {callNo !== null ? <small>#{callNo}</small> : null}
      </div>
      <div>
        {turn.blocks.length === 0 ? <div className="txt muted">empty</div> : null}
        {turn.blocks.map((b, i) => (
          <MessageBlock key={i} block={b} format={format} names={names} />
        ))}
        {changed ? <span className="chg">changed in this {changedBy}{firstAt ? ` · first sent at #${firstAt}` : ''}</span> : null}
      </div>
    </div>
  );
}

function MessageBlock({ block, format, names }: { block: TurnBlock; format: boolean; names: Map<string, string> }) {
  switch (block.type) {
    case 'text':
      return <div className="txt">{block.text}</div>;
    case 'thinking':
      return (
        <div className="think">
          <span className="tlab">{block.redacted ? 'redacted thinking' : 'thinking'}</span>
          {block.redacted ? null : block.text}
        </div>
      );
    case 'tool_call':
      return (
        <div className="tu">
          {/* its arguments break only between them: after a comma or a run of opening braces, a short object whole; past a few
              lines (`CODE_SET`), as written */}
          <span className="ar">→</span> <b>{block.name}</b> <CodeText>{JSON.stringify(block.input)}</CodeText>
        </div>
      );
    case 'tool_result': {
      const name = block.name ?? (block.id ? names.get(block.id) : undefined);
      return (
        <>
          <div className="tu">
            <span className="ar">←</span> {block.isError ? 'error' : null} <b>{name ?? 'result'}</b>
          </div>
          <div className="jbox">{shown(block.content, format)}</div>
        </>
      );
    }
    default:
      return <div className="txt muted">[{block.label}]</div>;
  }
}

/** Forget every cell's fold and the Format JSON preference: for tests. */
export function forgetConversationPrefs(): void {
  unfolded.clear();
  formatJsonPref = true;
}
