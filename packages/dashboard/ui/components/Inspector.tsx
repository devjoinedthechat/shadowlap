import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { applyDeltas } from '../../../engine/src/deltas.js';
import type { Block, CallDetail, Delta, Turn, TurnBlock } from '../api.js';
import { formatBytes, formatTokens, formatUsd, json, isFailure } from '../format.js';
import { href } from '../router.js';
import type { Client } from '../api.js';
import { CopyButton, JsonView, Origin } from './common.js';
import { CallNotes } from './Notes.js';

export type Tab = 'conversation' | 'response' | 'request' | 'details';

export function Inspector({ detail, loading, error, tab, onTab, runId, client, actionsEnabled }: { detail: CallDetail | null; loading: boolean; error: string | null; tab: Tab; onTab: (t: Tab) => void; runId: string; client: Client; actionsEnabled: boolean }) {
  if (error) return <section className="inspector"><p className="note pad err">{error}</p></section>;
  if (!detail) return <section className="inspector"><p className="note pad">{loading ? 'Loading call…' : 'Select a call.'}</p></section>;
  const c = detail.call;
  const isApi = c.kind === 'api';
  const tabs: Array<[Tab, string]> = [
    ['conversation', 'Conversation'],
    ['response', isApi ? 'Response' : 'Result'],
    ['request', isApi ? 'Request' : 'Arguments'],
    ['details', 'Details'],
  ];
  return (
    <section className="inspector" aria-label={`Call ${c.callNo}`}>
      <header className="insp-head">
        <div className="insp-title">
          <span className="callno">#{c.callNo}</span>
          <b title={c.name}>{c.name}</b>
          <Origin origin={c.origin} error={isFailure(c)} />
          {c.replayedFrom !== null ? <span className="note">from #{c.replayedFrom}</span> : null}
        </div>
        <nav className="insp-tabs" role="tablist">
          {tabs.map(([t, label], i) => (
            <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => onTab(t)} title={`${label} · ${i + 1}`}>
              {label}
            </button>
          ))}
        </nav>
      </header>
      <div className="insp-body" key={`${runId}:${c.callNo}:${tab}`}>
        {tab === 'conversation' ? <ConversationTab detail={detail} runId={runId} /> : null}
        {tab === 'response' ? isApi ? <ResponseTab detail={detail} /> : <ResultTab detail={detail} /> : null}
        {tab === 'request' ? (
          <div className="pane">
            <Toolbar right={<CopyButton text={json(detail.request)} />}>{isApi ? 'Stored request · credentials are never stored' : 'Recorded arguments'}</Toolbar>
            <JsonView value={detail.request} open={isApi ? 1 : 3} />
          </div>
        ) : null}
        {tab === 'details' ? <DetailsTab detail={detail} runId={runId} client={client} actionsEnabled={actionsEnabled} /> : null}
      </div>
    </section>
  );
}

function Toolbar({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="toolbar">
      <div className="toolbar-left">{children}</div>
      {right ? <div className="toolbar-right">{right}</div> : null}
    </div>
  );
}

// ---- conversation: a transcript, not a stack of cards

const FORMAT_KEY = 'shadowlap-dashboard-format-json';
function savedFormat(): boolean {
  try {
    return localStorage.getItem(FORMAT_KEY) === '1';
  } catch {
    return false;
  }
}

/** A tool result that is a JSON object or array, parsed; anything else is left as the text it was. */
function asJson(text: string): unknown {
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return undefined;
  try {
    const v: unknown = JSON.parse(t);
    return v !== null && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

function ConversationTab({ detail, runId }: { detail: CallDetail; runId: string }) {
  const conv = detail.conversation;
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The inspector's own scroller, not every scrollable ancestor.
    const body = endRef.current?.closest<HTMLElement>('.insp-body');
    if (body) body.scrollTop = body.scrollHeight;
  }, [conv]);
  const [formatJson, setFormatJsonState] = useState(savedFormat);
  const setFormatJson = (on: boolean) => {
    setFormatJsonState(on);
    try {
      localStorage.setItem(FORMAT_KEY, on ? '1' : '0');
    } catch {
      // the choice lasts for this page only
    }
  };
  if (!conv) return <p className="note pad">No model call before this one, so no conversation yet.</p>;
  const own = conv.fromCallNo === detail.call.callNo;
  // The conversation is shown as the model saw it, so a tool result is the string it received. When
  // any of them is JSON, formatting it is offered — off until asked for, and remembered.
  const hasJson = conv.turns.some((t) => t.blocks.some((b) => b.type === 'tool_result' && asJson(b.content) !== undefined));
  // An injected failure was answered here, before anything went out: the conversation is what the
  // agent would have sent, and no model ever saw it.
  const injected = detail.call.origin === 'injected';
  return (
    <div className="pane">
      <Toolbar
        right={
          hasJson ? (
            <button type="button" className="textbtn" aria-pressed={formatJson} onClick={() => setFormatJson(!formatJson)} title={formatJson ? 'Show tool results as the model received them' : 'Lay out JSON tool results as a tree'}>
              {formatJson ? 'As sent' : 'Format JSON'}
            </button>
          ) : undefined
        }
      >
        {injected && own ? (
          <>
            Never sent: Shadowlap answered with HTTP {detail.call.status ?? '?'} (--fail-at). This is what the agent would have sent
          </>
        ) : own ? 'As sent in this call' : (
          <>
            As sent in <a href={href.run(runId, conv.fromCallNo)}>#{conv.fromCallNo}</a>, the model call before this one
          </>
        )}
        {conv.model ? <> · {conv.model}</> : null} · {conv.turns.length} turns
        {conv.tools.length ? <> · {conv.tools.length} tools</> : null}
      </Toolbar>
      <div className="transcript">
        {conv.turns.map((t, i) => (
          <TurnView key={i} turn={t} index={i} formatJson={formatJson} />
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}

const ROLE: Record<Turn['role'], string> = { system: 'System', user: 'User', assistant: 'Assistant', tool: 'Tool' };

function TurnView({ turn, index, formatJson = false }: { turn: Turn; index: number; formatJson?: boolean }) {
  return (
    <article className={`turn r-${turn.role}`}>
      <div className="turn-role">
        {ROLE[turn.role]}
        <span>{index + 1}</span>
      </div>
      <div className="turn-body">{turn.blocks.length === 0 ? <p className="note">empty</p> : turn.blocks.map((b, i) => <TurnBlockView key={i} block={b} formatJson={formatJson} />)}</div>
    </article>
  );
}

function Clamp({ text, lines = 16, mono = false }: { text: string; lines?: number; mono?: boolean }) {
  const long = text.split('\n').length > lines || text.length > lines * 110;
  const [open, setOpen] = useState(!long);
  return (
    <div className="clamp">
      <pre className={`${mono ? 'mono-text' : 'prose'}${open ? '' : ' clamped'}`} style={{ ['--lines' as string]: lines }}>
        {text}
      </pre>
      {long ? (
        <button type="button" className="textbtn" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : `Show all · ${text.length.toLocaleString()} chars`}
        </button>
      ) : null}
    </div>
  );
}

function TurnBlockView({ block, formatJson = false }: { block: TurnBlock; formatJson?: boolean }) {
  switch (block.type) {
    case 'text':
      return <Clamp text={block.text} />;
    case 'thinking':
      return (
        <details className="thinking">
          <summary>{block.redacted ? 'redacted thinking' : `thinking · ${block.text.length.toLocaleString()} chars`}</summary>
          {block.redacted ? null : <pre className="prose">{block.text}</pre>}
        </details>
      );
    case 'tool_call':
      return (
        <div className="call-block">
          <div className="call-line">
            <span className="arrow">→</span> <b>{block.name}</b>
          </div>
          <pre className="code">{json(block.input)}</pre>
        </div>
      );
    case 'tool_result': {
      const parsed = formatJson ? asJson(block.content) : undefined;
      return (
        <div className={`call-block${block.isError ? ' is-error' : ''}`}>
          <div className="call-line">
            <span className="arrow">←</span> {block.isError ? 'error' : 'result'}
            {block.name ? <b> {block.name}</b> : null}
          </div>
          {parsed !== undefined ? <JsonView value={parsed} open={2} /> : <Clamp text={block.content} lines={8} mono />}
        </div>
      );
    }
    default:
      return <p className="note">[{block.label}]</p>;
  }
}

// ---- response, with playback at the recorded pacing

function BlocksView({ blocks, stopReason, streaming }: { blocks: Block[]; stopReason: string | null; streaming?: boolean }) {
  return (
    <div className="transcript single">
      <article className="turn r-assistant">
        <div className="turn-role">Assistant</div>
        <div className="turn-body">
          {blocks.length === 0 ? <p className="note">{streaming ? '' : 'No content.'}</p> : null}
          {blocks.map((b, i) =>
            b.type === 'tool_call' ? (
              <div className="call-block" key={i}>
                <div className="call-line">
                  <span className="arrow">→</span> <b>{b.name}</b>
                </div>
                <pre className="code">{json(b.input)}</pre>
              </div>
            ) : b.type === 'thinking' ? (
              <details className="thinking" key={i} open={streaming}>
                <summary>thinking</summary>
                <pre className="prose">{b.text}</pre>
              </details>
            ) : (
              <pre className="prose" key={i}>
                {b.text}
                {streaming && i === blocks.length - 1 ? <span className="caret" /> : null}
              </pre>
            ),
          )}
          {streaming && blocks.length === 0 ? <span className="caret" /> : null}
          {stopReason ? <p className="stop">stop · {stopReason}</p> : null}
        </div>
      </article>
    </div>
  );
}

const SPEEDS = [1, 2, 4, 0] as const;

function ResponseTab({ detail }: { detail: CallDetail }) {
  const r = detail.response;
  const [raw, setRaw] = useState(false);
  const [upto, setUpto] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const deltas: Delta[] = r?.deltas ?? [];
  const partial = useMemo(() => (upto === null ? null : applyDeltas(deltas.slice(0, upto))), [deltas, upto]);

  useEffect(() => {
    if (!playing) return;
    const i = upto ?? 0;
    if (i >= deltas.length) {
      setPlaying(false);
      return;
    }
    if (speed === 0) {
      setUpto(deltas.length);
      return;
    }
    const prevT = i > 0 ? deltas[i - 1]!.t : 0;
    const t = setTimeout(() => setUpto(i + 1), Math.min(1500, Math.max(0, (deltas[i]!.t - prevT) / speed)));
    return () => clearTimeout(t);
  }, [playing, upto, speed, deltas]);

  if (!r || r.kind === 'empty') return <p className="note pad">{detail.call.outcome === null ? 'No response: the call did not finish.' : 'The response body was empty.'}</p>;
  const total = deltas.length;
  const duration = total ? deltas[total - 1]!.t : 0;
  const elapsed = upto !== null && upto > 0 ? deltas[Math.min(upto, total) - 1]!.t : 0;
  const streamed = r.kind === 'sse' && total > 0;

  return (
    <div className="pane">
      <Toolbar
        right={
          <>
            <button type="button" className="textbtn" aria-pressed={raw} onClick={() => setRaw(!raw)}>
              {raw ? 'Rendered' : 'Raw'}
            </button>
            <CopyButton text={r.raw} />
          </>
        }
      >
        {streamed ? (
          <span className="player">
            <button
              type="button"
              className="btn small"
              onClick={() => {
                if (playing) setPlaying(false);
                else {
                  if (upto === null || upto >= total) setUpto(0);
                  setPlaying(true);
                }
              }}
            >
              {playing ? 'Pause' : upto !== null && upto < total ? 'Resume' : 'Play'}
            </button>
            <span className="speeds" role="group" aria-label="Playback speed">
              {SPEEDS.map((s) => (
                <button key={s} type="button" aria-pressed={speed === s} onClick={() => setSpeed(s)}>
                  {s === 0 ? 'instant' : `${s}×`}
                </button>
              ))}
            </span>
            <span className="tabular">
              {upto === null ? `${r.events} events · ${(duration / 1000).toFixed(2)} s` : `${(elapsed / 1000).toFixed(2)} / ${(duration / 1000).toFixed(2)} s`}
            </span>
          </span>
        ) : r.kind === 'json' ? (
          'JSON response'
        ) : (
          'Response'
        )}
      </Toolbar>
      {streamed && upto !== null ? (
        <div className="progress" aria-hidden="true">
          <i style={{ width: `${duration ? (100 * elapsed) / duration : 100}%` }} />
        </div>
      ) : null}
      {raw || r.kind === 'text' ? <pre className="code raw">{r.raw}</pre> : partial ? <BlocksView blocks={partial.blocks} stopReason={partial.stopReason} streaming={playing || (upto ?? 0) < total} /> : <BlocksView blocks={r.blocks} stopReason={r.stopReason} />}
    </div>
  );
}

function ResultTab({ detail }: { detail: CallDetail }) {
  const result = detail.result as { result?: unknown; error?: { name?: string; message?: string } } | null;
  if (!result) return <p className="note pad">{detail.call.outcome === null ? 'No result: the call did not finish.' : 'No result.'}</p>;
  const heading = result.error ? 'The call threw' : detail.call.origin === 'stubbed' ? 'Returned by onFork (writes stubbed)' : detail.call.origin === 'replayed' ? 'Served from the recording' : 'Recorded result';
  return (
    <div className="pane">
      <Toolbar right={<CopyButton text={json(result.error ?? result.result)} />}>{heading}</Toolbar>
      {result.error ? (
        <p className="error-line">
          <b>{result.error.name}</b> {result.error.message}
        </p>
      ) : null}
      {'result' in result ? <JsonView value={result.result} open={3} /> : null}
    </div>
  );
}

// ---- details

/** A full hash, wrapped rather than cut, with a copy button: ids are for comparing and pasting. */
function Hash({ value }: { value: string }) {
  return (
    <span className="hash">
      {/* Breaks into even halves when it does not fit on one line. */}
      <code>
        {value.slice(0, Math.ceil(value.length / 2))}
        <wbr />
        {value.slice(Math.ceil(value.length / 2))}
      </code>
      <CopyButton text={value} />
    </span>
  );
}

function DetailsTab({ detail, runId, client, actionsEnabled }: { detail: CallDetail; runId: string; client: Client; actionsEnabled: boolean }) {
  const c = detail.call;
  const rows: Array<[string, ReactNode]> = [['Origin', <Origin origin={c.origin} error={isFailure(c)} key="o" />]];
  rows.push(['Outcome', c.outcome === null ? 'pending' : `${c.outcome}${c.status ? ` · HTTP ${c.status}` : ''}`]);
  if (c.origin === 'injected') rows.push(['Answered by', 'Shadowlap, with --fail-at: the request reached no provider']);
  if (c.effect) rows.push(['Effect', c.effect]);
  if (c.scope) rows.push(['Scope', <code key="s">{c.scope}</code>]);
  if (c.provider) rows.push(['Provider', c.provider]);
  if (c.model) rows.push(['Model', c.model]);
  if (c.stopReason) rows.push(['Stop reason', c.stopReason]);
  if (c.usage)
    rows.push([
      'Tokens',
      `${formatTokens(c.usage.input)} in · ${formatTokens(c.usage.output)} out${c.usage.cacheRead ? ` · ${formatTokens(c.usage.cacheRead)} cache read` : ''}${c.usage.cacheWrite ? ` · ${formatTokens(c.usage.cacheWrite)} cache write` : ''}`,
    ]);
  if (c.kind === 'api') rows.push(['Cost', c.cost === null ? 'no price for this model · add one under prices in shadowlap.config.json' : `≈${formatUsd(c.cost)}${c.origin === 'replayed' ? ' · not re-spent' : ''}`]);
  if (c.latencyMs !== null) rows.push(['Latency', `${c.latencyMs} ms`]);
  if (c.bytes !== null) rows.push(['Size', formatBytes(c.bytes)]);
  if (c.attempts) rows.push(['Retries', `${c.attempts} before the final outcome`]);
  if (c.error) rows.push(['Error', <span className="err" key="e">{c.error}</span>]);
  rows.push(['Fingerprint', <Hash key="f" value={c.fingerprint} />], ['Occurrence', String(c.occurrence)]);
  if (c.implHash) rows.push(['Implementation', <Hash key="i" value={c.implHash} />]);
  return (
    <div className="pane">
      <CallNotes key={`${runId}:${c.callNo}`} client={client} runId={runId} callNo={c.callNo} notes={detail.notes} enabled={actionsEnabled} />
      <dl className="kv">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {Object.keys(c.headers).length ? (
        <>
          <h3 className="section-label">Response headers</h3>
          <dl className="kv mono">
            {Object.entries(c.headers).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : null}
    </div>
  );
}
