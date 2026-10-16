import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { applyDeltas } from '../../../engine/src/deltas.js';
import type { Block, CallDetail, CallRow, Delta, RunNote, Turn, TurnBlock } from '../api.js';
import { Org, Seg } from '../components/bits.js';
import { Icon } from '../components/Icon.js';
import { JsonTree } from '../components/Json.js';
import { copyText } from '../dom.js';
import { asJson, dur, formatUsd, jsonText, num, shortFingerprint, stamp } from '../format.js';
import { useApp } from '../state.js';
import { refusedOffline } from './calls.js';
import { conversationLink, modelLabel, originOf, tokensText, turnCalls } from './model.js';

/**
 * The inspector for the selected call: Conversation (as the model saw it, thinking included, with
 * Jump to change on a fork), Response (text played back at its recorded pacing, or the raw stream),
 * Request, and Details (usage, cost, timing, fingerprint, headers and notes).
 */

export type InspectorTab = 'conversation' | 'response' | 'request' | 'details';
export const TABS: readonly InspectorTab[] = ['conversation', 'response', 'request', 'details'];

let formatJsonPref = true;

export interface InspectorProps {
  runId: string;
  call: CallRow | null;
  /** The run's calls, to say which call each message of a conversation came from. */
  calls: readonly CallRow[];
  /** The run's models as the page names them (`claude-opus-5`), by the short name a row carries. */
  models?: Readonly<Record<string, string>> | undefined;
  detail: CallDetail | null;
  error: string | null;
  tab: InspectorTab;
  onTab: (t: InspectorTab) => void;
  onStep: (delta: number) => void;
  /** The turn this fork changed, and the call the change was first sent at. */
  change: { turn: number; firstAt: number } | null;
  live: boolean;
  /** The flag that made the fork, as the run names it (`--fail-at 19=529`), for a call Shadowlap answered. */
  flag?: string | null;
  /** Selects another call: a tool call's Conversation tab leads to the model call of its own conversation. */
  onSelect?: (n: number) => void;
}

export function Inspector({ runId, call, calls, models, detail, error, tab, onTab, onStep, change, live, flag, onSelect }: InspectorProps) {
  if (!call) return <section className="insp" aria-label="Inspector"><div className="empty">{live ? 'Waiting for the first call…' : 'No calls in this run.'}</div></section>;
  const c = detail && detail.call.callNo === call.callNo ? detail.call : null;
  const kindName = call.kind === 'api' ? call.name : call.kind === 'tool' ? call.name : `${call.kind}.${call.name}`;
  const summary = call.kind === 'api' ? [call.model, tokensText(call), call.origin === 'replayed' || call.latencyMs === null ? null : dur(call.latencyMs)].filter(Boolean).join(' · ') : call.effect ? `${call.effect} tool` : call.kind;
  return (
    <section className="insp" aria-label={`Call ${call.callNo}`}>
      <div className="ihead">
        <span className="cn">#{call.callNo}</span>
        <span className="ct" title={call.name}>
          {kindName}
        </span>
        <Org origin={originOf(call)} />
        {call.scope ? <span className="scopetag">{call.scope}</span> : null}
        <span className="nav">
          <button className="ibtn" type="button" aria-label="Previous call (k)" onClick={() => onStep(-1)}>
            <Icon name="up" />
          </button>
          <button className="ibtn" type="button" aria-label="Next call (j)" onClick={() => onStep(1)}>
            <Icon name="down" />
          </button>
        </span>
      </div>
      <div className="ihead isumrow">
        <span className="isum">{summary}</span>
      </div>
      <div className="tabs" role="tablist" aria-label="Inspector">
        {TABS.map((t, i) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} title={`${i + 1}`} onClick={() => onTab(t)}>
            {t === 'conversation' ? 'Conversation' : t === 'response' ? 'Response' : t === 'request' ? 'Request' : 'Details'}
          </button>
        ))}
      </div>
      <div className="ibody" key={`${runId}:${call.callNo}:${tab}`} tabIndex={-1}>
        {error ? <div className="ibar err">{error}</div> : !c || !detail ? <div className="ibar">Loading #{call.callNo}…</div> : tab === 'conversation' ? <ConversationTab detail={detail} calls={calls} models={models} change={change} flag={flag ?? null} onSelect={onSelect} /> : tab === 'response' ? <ResponseTab detail={detail} /> : tab === 'request' ? <RequestTab detail={detail} /> : <DetailsTab runId={runId} detail={detail} models={models} />}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------- conversation

function FormatSwitch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <span
      className="switch"
      role="switch"
      tabIndex={0}
      aria-checked={on}
      onClick={() => onChange(!on)}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          onChange(!on);
        }
      }}
    >
      <i />
      Format JSON
    </span>
  );
}

function shown(text: string, format: boolean): string {
  if (!format) return text;
  const parsed = asJson(text);
  return parsed === undefined ? text : JSON.stringify(parsed, null, 2);
}

function ConversationTab({ detail, calls, models, change, flag, onSelect }: { detail: CallDetail; calls: readonly CallRow[]; models?: Readonly<Record<string, string>> | undefined; change: { turn: number; firstAt: number } | null; flag: string | null; onSelect?: ((n: number) => void) | undefined }) {
  const c = detail.call;
  const [format, setFormatState] = useState(formatJsonPref);
  const setFormat = (v: boolean) => {
    formatJsonPref = v;
    setFormatState(v);
  };
  const [expanded, setExpanded] = useState(false);
  const changedRef = useRef<HTMLDivElement>(null);
  const [jump, setJump] = useState(false);
  useEffect(() => {
    if (jump) changedRef.current?.scrollIntoView({ block: 'center' });
  }, [jump]);
  if (c.kind !== 'api') {
    const result = detail.result as { result?: unknown; error?: unknown } | null;
    const args = (detail.request as { args?: unknown } | null)?.args ?? detail.request;
    return (
      <>
        <div className="ibar">A {c.kind === 'tool' ? 'tool' : c.kind} call has no conversation. Its arguments, then its result:</div>
        <div className="jbox">{jsonText(args ?? {}, format)}</div>
        <div className="jbox">{result ? jsonText(result.error ?? result.result ?? null, format) : c.outcome === null ? 'no result yet' : 'no result'}</div>
        <ConversationLink detail={detail} calls={calls} onSelect={onSelect} />
      </>
    );
  }
  const conv = detail.conversation;
  const injected = c.origin === 'injected';
  const failed = c.outcome === 'error';
  const note = failed ? (
    <div className={`inote ${injected ? 'inj' : 'err'}`}>
      {injected ? (
        <>
          <b>Never sent.</b> Shadowlap answered with HTTP {c.status ?? '?'} (<code>{flag && /^--fail-at\b/.test(flag) ? flag : '--fail-at'}</code>){c.attempts ? `, ${c.attempts + 1} attempts` : ''}. This is the conversation the agent would have sent.
        </>
      ) : refusedOffline(c) ? (
        <>
          <b>Refused.</b> The replay is offline and this request is not in the recording, so it got HTTP {c.status}. This is what the agent sent.
        </>
      ) : (
        <>
          <b>{c.status ? `HTTP ${c.status}.` : 'It failed.'}</b> {(c.error ?? 'The call ended in an error').replace(/\.?$/, '.')} This is what the agent sent.
        </>
      )}
    </div>
  ) : null;
  if (!conv) return <>{note}<div className="ibar">The request could not be read as a conversation; the Request tab shows it as stored.</div></>;
  const turns = conv.turns;
  // A run of many conversations (a batch): which one this call's is.
  const conversations = calls.reduce((n, x) => Math.max(n, x.conversation ?? 0), 0);
  const which = conv.n && conversations > 1 ? ` · conversation ${num(conv.n)} of ${num(conversations)}` : '';
  // Which call each message came from, when the server names the tool calls' ids.
  const from = turnCalls(turns, calls);
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
          {num(turns.length)} {turns.length === 1 ? 'message' : 'messages'} · what the model {failed ? 'would have seen' : 'saw'} at #{conv.fromCallNo ?? c.callNo}
          {which}
          {conv.model && !which ? ` · ${modelLabel(models, conv.model)}` : ''}
        </span>
        {change ? (
          <button
            className="linkbtn"
            type="button"
            onClick={() => {
              setExpanded(true);
              setJump(false);
              setTimeout(() => setJump(true));
            }}
          >
            Jump to change
          </button>
        ) : null}
        <span className="sp" />
        <FormatSwitch on={format} onChange={setFormat} />
      </div>
      {visible.map(([t, i]) => (
        <Fragment key={i}>
          {hidden && i === 2 + hidden ? (
            <button className="expand" type="button" onClick={() => setExpanded(true)}>
              Show {hidden} earlier {hidden === 1 ? 'message' : 'messages'}
            </button>
          ) : null}
          <Message turn={t} callNo={from.get(i) ?? null} format={format} names={names} changed={change?.turn === i} firstAt={change?.firstAt ?? null} innerRef={change?.turn === i ? changedRef : undefined} />
        </Fragment>
      ))}
    </>
  );
}

/**
 * Under a tool call's arguments and result: the model call of its own conversation that asked for it
 * (or that its result feeds), and in a batch which conversation it is, with a way to that call's
 * conversation. Only from what the server says, so it never leads to another ticket's.
 */
function ConversationLink({ detail, calls, onSelect }: { detail: CallDetail; calls: readonly CallRow[]; onSelect?: ((n: number) => void) | undefined }) {
  const link = conversationLink(detail.call, detail.conversation, calls);
  if (!link) return null;
  return (
    <div className="ibar convlink">
      <span>{link.text}</span>
      {onSelect ? (
        <button className="linkbtn" type="button" onClick={() => onSelect(link.callNo)}>
          Show its conversation
        </button>
      ) : null}
    </div>
  );
}

function Message({ turn, callNo, format, names, changed, firstAt, innerRef }: { turn: Turn; callNo: number | null; format: boolean; names: Map<string, string>; changed: boolean; firstAt: number | null; innerRef?: React.RefObject<HTMLDivElement | null> | undefined }) {
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
        {changed ? <span className="chg">changed in this fork{firstAt ? ` · first sent at #${firstAt}` : ''}</span> : null}
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
          <span className="ar">→</span> <b>{block.name}</b> {JSON.stringify(block.input)}
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

// ---------------------------------------------------------------------------------------------- response

function blocksText(blocks: Block[]): { think: string; text: string } {
  const think = blocks.filter((b) => b.type === 'thinking').map((b) => (b as { text: string }).text).join('\n\n');
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text') parts.push(b.text);
    else if (b.type === 'tool_call') parts.push(`→ ${b.name} ${JSON.stringify(b.input)}`);
  }
  return { think, text: parts.join('\n\n') };
}

const SPEEDS = [1, 2, 4, 0] as const;

function ResponseTab({ detail }: { detail: CallDetail }) {
  const c = detail.call;
  const [raw, setRaw] = useState(false);
  if (c.kind !== 'api') {
    const result = detail.result as { result?: unknown; error?: { name?: string; message?: string } } | null;
    const head = c.origin === 'blocked' ? 'Blocked: a write tool after the fork. The agent got this instead of the real result:' : c.origin === 'stubbed' ? 'Stubbed: a write tool after the fork answered with a stand-in:' : c.origin === 'replayed' ? 'Served from the recording:' : result?.error ? 'The call threw:' : 'The recorded result:';
    return (
      <>
        <div className="ibar">{head}</div>
        <div className="jbox">{result ? jsonText(result.error ?? result.result ?? null) : c.outcome === null ? 'no result yet' : 'no result'}</div>
      </>
    );
  }
  const r = detail.response;
  const mode = (
    <div className="ibar">
      <Seg
        label="Show the response as"
        items={[
          { key: 'text', label: 'Text' },
          { key: 'raw', label: 'Raw' },
        ]}
        value={raw ? 'raw' : 'text'}
        onChange={(k) => setRaw(k === 'raw')}
      />
      <span className="sp" />
      <span>{raw && r ? (r.kind === 'sse' ? `the stream as recorded · ${num(r.events)} events` : 'the response as written') : ''}</span>
    </div>
  );
  if (!r || r.kind === 'empty') return <>{mode}<div className="ibar">{c.outcome === null ? 'No response yet: the call has not finished.' : 'The response body was empty.'}</div></>;
  if (c.outcome === 'error')
    return (
      <>
        {mode}
        {raw ? (
          <pre className="rawsse">{r.raw}</pre>
        ) : (
          <>
            <div className="ibar err">
              HTTP {c.status ?? '?'}
              {c.origin === 'injected' ? ' · written by Shadowlap, nothing sent' : ''}
            </div>
            <div className="jbox">{r.raw}</div>
          </>
        )}
      </>
    );
  if (r.kind === 'text' && !raw)
    return (
      <>
        {mode}
        <div className="resp">{r.raw}</div>
      </>
    );
  if (raw)
    return (
      <>
        {mode}
        <pre className="rawsse">
          {r.raw.split('\n').map((line, i) => (
            <span key={i} className={/^event:/.test(line) ? 'ev' : undefined}>
              {line}
              {'\n'}
            </span>
          ))}
        </pre>
      </>
    );
  return (
    <>
      {mode}
      <Playback blocks={r.blocks} deltas={r.deltas} stopReason={r.stopReason} replayed={c.origin === 'replayed'} latency={c.latencyMs} />
    </>
  );
}

function Playback({ blocks, deltas, stopReason, replayed, latency }: { blocks: Block[]; deltas: Delta[]; stopReason: string | null; replayed: boolean; latency: number | null }) {
  const [upto, setUpto] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const total = deltas.length;
  const partial = useMemo(() => (upto === null ? null : applyDeltas(deltas.slice(0, upto))), [deltas, upto]);
  useEffect(() => {
    if (!playing) return;
    const i = upto ?? 0;
    if (i >= total) {
      setPlaying(false);
      return;
    }
    if (speed === 0) {
      setUpto(total);
      return;
    }
    const prev = i > 0 ? deltas[i - 1]!.t : 0;
    const t = setTimeout(() => setUpto(i + 1), Math.min(1500, Math.max(0, (deltas[i]!.t - prev) / speed)));
    return () => clearTimeout(t);
  }, [playing, upto, speed, deltas, total]);
  const shownBlocks = partial ? partial.blocks : blocks;
  const { think, text } = blocksText(shownBlocks);
  const streaming = upto !== null && upto < total;
  const span = total ? deltas[total - 1]!.t : 0;
  const elapsed = upto !== null && upto > 0 ? deltas[Math.min(upto, total) - 1]!.t : 0;
  return (
    <>
      {think ? (
        <div className="think">
          <span className="tlab">thinking</span>
          {think}
        </div>
      ) : null}
      {total ? (
        <>
          <div className="play">
            <button
              className="btn sm"
              type="button"
              onClick={() => {
                if (playing) setPlaying(false);
                else {
                  if (upto === null || upto >= total) setUpto(0);
                  setPlaying(true);
                }
              }}
            >
              <Icon name={playing ? 'pause' : 'play'} />
              {playing ? 'Pause' : streaming ? 'Resume' : 'Play'}
            </button>
            <Seg label="Speed" items={SPEEDS.map((s) => ({ key: String(s), label: s === 0 ? 'instant' : `${s}×` }))} value={String(speed)} onChange={(k) => setSpeed(Number(k) as (typeof SPEEDS)[number])} />
            <span className="ev">{upto === null ? `${replayed ? 'as recorded' : 'streamed'} · ${dur(span || latency || 0)}` : `${dur(elapsed)} / ${dur(span)}`}</span>
          </div>
          <div className="prog">
            <i style={{ width: `${span ? (100 * elapsed) / span : upto === null ? 0 : 100}%` }} />
          </div>
        </>
      ) : null}
      <div className="resp">
        {text}
        {streaming || playing ? <span className="caret-blink" /> : null}
      </div>
      {stopReason && !streaming ? <div className="ibar stopline">stop · {stopReason}</div> : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------------- request

function RequestTab({ detail }: { detail: CallDetail }) {
  const { toast } = useApp();
  const api = detail.call.kind === 'api';
  const value = api ? detail.request : ((detail.request as { args?: unknown } | null)?.args ?? detail.request);
  return (
    <>
      <div className="ibar">
        <span>{api ? 'The request as stored · credentials are never stored' : 'The tool’s arguments'}</span>
        <span className="sp" />
        <button className="linkbtn" type="button" onClick={() => void copyText(jsonText(value)).then((ok) => toast(ok ? 'Copied the request' : 'Copying was refused by the browser'))}>
          <Icon name="copy" />
          Copy JSON
        </button>
      </div>
      <JsonTree value={value} open={api ? 1 : 3} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------- details

function DetailsTab({ runId, detail, models }: { runId: string; detail: CallDetail; models?: Readonly<Record<string, string>> | undefined }) {
  const c = detail.call;
  const rows: Array<[string, ReactNode]> = [];
  const origin = originOf(c);
  rows.push(['Origin', <>{origin === 'block' ? <>blocked <small>a write after the fork</small></> : origin === 'stub' ? <>stubbed <small>a write after the fork</small></> : origin === 'inject' ? <>injected <small>answered by Shadowlap with --fail-at</small></> : c.origin}</>]);
  rows.push(['Outcome', c.outcome === null ? 'pending' : c.outcome === 'ok' ? `ok${c.status ? ` · HTTP ${c.status}` : ''}` : <>error{c.status ? ` · HTTP ${c.status}` : ''}{origin === 'inject' ? <small> never sent</small> : null}</>]);
  if (c.effect) rows.push(['Effect', c.effect]);
  if (c.scope) rows.push(['Scope', c.scope]);
  if (c.provider) rows.push(['Provider', c.provider]);
  if (c.model) rows.push(['Model', modelLabel(models, c.model)]);
  if (c.stopReason) rows.push(['Stop reason', c.stopReason]);
  if (c.usage)
    rows.push([
      'Input tokens',
      <>
        {num(c.usage.input + c.usage.cacheRead + c.usage.cacheWrite)}{' '}
        <small>
          {num(c.usage.cacheRead)} cache read · {num(c.usage.cacheWrite)} cache write · {num(c.usage.input)} uncached
        </small>
      </>,
    ]);
  if (c.usage) rows.push(['Output tokens', num(c.usage.output)]);
  if (c.kind === 'api') rows.push(['Cost', c.cost === null ? <small>no price for this model · add one under prices in shadowlap.config.json</small> : <>≈{formatUsd(c.cost)}{c.origin === 'replayed' ? <small> not re-spent</small> : null}</>]);
  if (c.latencyMs !== null) rows.push(['Latency', <>{dur(c.latencyMs)}{c.ttftMs !== null ? <small> first token at {dur(c.ttftMs)}</small> : null}{c.origin === 'replayed' ? <small> replayed</small> : null}</>]);
  if (c.bytes !== null) rows.push(['Size', `${(c.bytes / 1024).toFixed(1)} kB response`]);
  if (c.attempts || c.kind === 'api') rows.push(['Retries', c.attempts ? `${c.attempts} before the final outcome` : '0']);
  if (c.replayedFrom !== null) rows.push(['Replayed from', `#${c.replayedFrom} of the parent run`]);
  if (c.error) rows.push(['Error', <span className="err">{c.error}</span>]);
  rows.push([
    'Fingerprint',
    <>
      <span title={c.fingerprint}>{shortFingerprint(c.fingerprint)}</span> <small>occurrence {c.occurrence}</small>
    </>,
  ]);
  rows.push(['Run', runId]);
  if (c.implHash) rows.push(['Implementation', c.implHash]);
  rows.push(['Started', stamp(c.startedAt)]);
  const headers = Object.entries(c.headers);
  return (
    <>
      <dl className="kvs">
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </Fragment>
        ))}
      </dl>
      {headers.length ? (
        <>
          <div className="sec-k">Response headers{c.origin === 'replayed' ? ' · as recorded' : ''}</div>
          <dl className="kvs hdrs">
            {headers.map(([k, v]) => (
              <Fragment key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </Fragment>
            ))}
          </dl>
        </>
      ) : null}
      <Notes runId={runId} callNo={c.callNo} notes={detail.notes} />
    </>
  );
}

function Notes({ runId, callNo, notes }: { runId: string; callNo: number; notes: RunNote[] }) {
  const { client, actionsOff, exported, toast, guard } = useApp();
  const [list, setList] = useState(notes);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const enabled = !exported && !actionsOff;
  return (
    <>
      <div className="sec-k">Notes on #{callNo}</div>
      <div className="notes">
        {list.length ? (
          list.map((n, i) => (
            <div className="note" key={i}>
              {n.text}
              <small>{stamp(n.at)}</small>
            </div>
          ))
        ) : (
          <div className="muted">No notes yet. Notes travel with the run when it is packed or exported.</div>
        )}
      </div>
      {enabled ? (
        <form
          className="addnote"
          onSubmit={(e) => {
            e.preventDefault();
            const v = text.trim();
            if (!v) return;
            guard(() => {
              setSaving(true);
              client
                .note(runId, callNo, v)
                .then(
                  (r) => {
                    setList(r.notes);
                    setText('');
                    toast(`Note saved on #${callNo}`);
                  },
                  (err: unknown) => toast(err instanceof Error ? err.message : String(err)),
                )
                .finally(() => setSaving(false));
            });
          }}
        >
          <textarea placeholder="Add a note on this call" aria-label={`A note on #${callNo}`} value={text} onChange={(e) => setText(e.target.value)} />
          <button className="btn" type="submit" disabled={saving || !text.trim()}>
            Add
          </button>
        </form>
      ) : null}
    </>
  );
}

