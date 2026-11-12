import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { applyDeltas } from '../../../engine/src/deltas.js';
import { INPUT_PARTS } from '../../../engine/src/tokens.js';
import type { Block, CallDetail, CallRow, Delta, RunNote } from '../api.js';
import { Conversation, useFormatJson } from '../components/Conversation.js';
import { Org, Seg } from '../components/bits.js';
import { Tabs } from '../components/Tabs.js';
import { tipText } from '../components/HoverCard.js';
import { Icon } from '../components/Icon.js';
import { JsonTree } from '../components/Json.js';
import { copyText } from '../dom.js';
import { dur, formatUsd, jsonText, num, shortFingerprint, stamp } from '../format.js';
import { agentOf } from '../scopes.js';
import { shortcut, shortcutCard } from '../shortcuts.js';
import { useApp } from '../state.js';
import { errorText } from '../toast.js';
import { failedBy, failureNote, type FailedBy } from './calls.js';
import { EditAndFork } from './EditAndFork.js';
import { AddCheckLink, type CheckEntry } from './check-entry.js';
import { viaWords } from './notes.js';
import { conversationLink, modelLabel, originOf, tokensText, turnCalls } from './model.js';
import { ActionButton } from '../components/ActionButton.js';

/**
 * The inspector for the selected call: Conversation (as the model saw it, thinking included, with
 * Jump to change on a fork), Response (text played back at its recorded pacing, or the raw stream),
 * Request, and Details (usage, cost, timing, fingerprint, headers and notes).
 */

export type InspectorTab = 'conversation' | 'response' | 'request' | 'details';
export const TABS: readonly InspectorTab[] = ['conversation', 'response', 'request', 'details'];

const TAB_NAMES: Readonly<Record<InspectorTab, string>> = { conversation: 'Conversation', response: 'Response', request: 'Request', details: 'Details' };
const PART_KEYS = ['part1', 'part2', 'part3', 'part4'] as const;

/** The inspector's tabs, each with its key, 1 to 4, and a card that says it and goes with it. */
const TAB_ITEMS = () =>
  TABS.map((key, i) => {
    const mark = shortcut(PART_KEYS[i]!);
    return { key, label: TAB_NAMES[key], mark, tip: mark['aria-keyshortcuts'] ? tipText(TAB_NAMES[key]) : undefined };
  });

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
  /** The turn this fork changed, the call the change was first sent at, and what changed it (a test's replay says so). */
  change: { turn: number; firstAt: number; by?: 'fork' | 'replay' } | null;
  live: boolean;
  /** The flag that made the fork, as the run names it (`--fail-at 19=529`), for a call Shadowlap answered. */
  flag?: string | null;
  /** Selects another call: a tool call's Conversation tab leads to the model call of its own conversation. */
  onSelect?: (n: number) => void;
  /** Add check… on the summary line, where the selected call takes it (run/check-entry.tsx). */
  check?: CheckEntry | undefined;
}

export function Inspector({ runId, call, calls, models, detail, error, tab, onTab, onStep, change, live, flag, onSelect, check }: InspectorProps) {
  if (!call) return <section className="insp" aria-label="Inspector"><div className="empty">{live ? 'Waiting for the first call…' : 'No calls in this run.'}</div></section>;
  const c = detail && detail.call.callNo === call.callNo ? detail.call : null;
  const kindName = call.kind === 'api' ? call.name : call.kind === 'tool' ? call.name : `${call.kind}.${call.name}`;
  // A model call's model, then its tokens and latency: a long model id gives way, the numbers stay in view.
  const rest = call.kind === 'api' ? [tokensText(call), call.origin === 'replayed' || call.latencyMs === null ? null : dur(call.latencyMs)].filter(Boolean).join(' · ') : '';
  const summary = call.kind === 'api' ? [call.model, rest].filter(Boolean).join(' · ') : call.effect ? `${call.effect} tool` : call.kind;
  return (
    <section className="insp" id="insp" aria-label={`Call ${call.callNo}`}>
      <div className="ihead">
        <span className="cn">#{call.callNo}</span>
        <span className="ct" title={call.name}>
          {kindName}
        </span>
        <Org origin={originOf(call)} />
        {agentOf(call) ? <span className="scopetag">{agentOf(call)}</span> : null}
        <span className="nav">
          <button className="ibtn" type="button" aria-label="Previous call" data-tip={tipText(shortcutCard('prevCall')!)} onClick={() => onStep(-1)} {...shortcut('prevCall')}>
            <Icon name="up" />
          </button>
          <button className="ibtn" type="button" aria-label="Next call" data-tip={tipText(shortcutCard('nextCall')!)} onClick={() => onStep(1)} {...shortcut('nextCall')}>
            <Icon name="down" />
          </button>
        </span>
      </div>
      <div className="ihead isumrow">
        <span className="isum" title={summary}>
          {call.kind === 'api' && call.model ? (
            <>
              <span className="im">{call.model}</span>
              {rest ? <span className="ir">{` · ${rest}`}</span> : null}
            </>
          ) : (
            summary
          )}
        </span>
        {check ? <AddCheckLink check={check} /> : null}
        {/* The fork menu's override with the result edited here, a tool's or what a person answered: on every tab. */}
        {c && detail ? (
          <span className="iedit">
            <EditAndFork runId={runId} detail={detail} live={live} />
          </span>
        ) : null}
      </div>
      <Tabs label="The selected call" idPrefix="itab" panelId="ibody" items={TAB_ITEMS()} value={tab} onChange={onTab} />
      <div className="ibody" id="ibody" key={`${runId}:${call.callNo}:${tab}`} role="tabpanel" aria-labelledby={`itab-${tab}`} tabIndex={-1}>
        {error ? <div className="ibar err">{error}</div> : !c || !detail ? <div className="ibar">Loading #{call.callNo}…</div> : tab === 'conversation' ? <ConversationTab detail={detail} calls={calls} change={change} flag={flag ?? null} onSelect={onSelect} /> : tab === 'response' ? <ResponseTab detail={detail} /> : tab === 'request' ? <RequestTab detail={detail} /> : <DetailsTab runId={runId} detail={detail} models={models} flag={flag ?? null} />}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------- conversation

function ConversationTab({ detail, calls, change, flag, onSelect }: { detail: CallDetail; calls: readonly CallRow[]; change: InspectorProps['change']; flag: string | null; onSelect?: ((n: number) => void) | undefined }) {
  const c = detail.call;
  const [format] = useFormatJson();
  if (c.kind !== 'api') {
    const result = detail.result as { result?: unknown; error?: unknown } | null;
    const args = (detail.request as { args?: unknown } | null)?.args ?? detail.request;
    return (
      <>
        <div className="ibar">Its arguments, then its result:</div>
        <div className="jbox">{jsonText(args ?? {}, format)}</div>
        <div className="jbox">{result ? jsonText(result.error ?? result.result ?? null, format) : c.outcome === null ? 'no result yet' : 'no result'}</div>
        <ConversationLink detail={detail} calls={calls} onSelect={onSelect} />
      </>
    );
  }
  // A run of many conversations (a batch): which one this call's is.
  const conversations = calls.reduce((n, x) => Math.max(n, x.conversation ?? 0), 0);
  const k = detail.conversation?.n;
  const which = k && conversations > 1 ? ` · conversation ${num(k)} of ${num(conversations)}` : '';
  // Which call each message came from, when the server names the tool calls' ids.
  const from = detail.conversation ? turnCalls(detail.conversation.turns, calls) : undefined;
  return <Conversation detail={detail} from={from} which={which} change={change} note={<CallNote c={c} flag={flag} />} />;
}

/** A failed model call's words in each place, by who answered it. */
const RESPONSE_BY: Readonly<Record<FailedBy, string>> = { injected: ' · written by Shadowlap, nothing sent', offline: ' · refused offline', provider: ' · from the provider' };
const OUTCOME_BY: Readonly<Record<FailedBy, string>> = { injected: 'by --fail-at, never sent', offline: 'refused offline', provider: 'from the provider' };
const LATENCY_BY: Readonly<Record<FailedBy, string>> = { injected: 'answered by Shadowlap', offline: 'refused by the replay', provider: 'answered by the provider' };

/** Who answered a model call that failed: Shadowlap's --fail-at (never sent), an offline replay (refused), or the provider; null for any other call. */
function answeredBy(c: CallDetail['call']): FailedBy | null {
  return c.kind !== 'api' || c.outcome !== 'error' ? null : failedBy(c);
}

/**
 * What happened to a call that ended in an error, over its conversation: the verdict on a line of its own in its colour
 * (Never sent., Refused., Failed.), then why, a plain line over a hairline as the mock draws it.
 */
export function CallNote({ c, flag }: { c: CallDetail['call']; flag: string | null }) {
  if (c.outcome !== 'error') return null;
  const by = failedBy(c);
  const note = failureNote(c, by, flag);
  return (
    <div className={`inote ${by === 'injected' ? 'inj' : 'err'}`}>
      <b>{note.word}</b> {note.why.map((p, i) => (typeof p === 'string' ? <Fragment key={i}>{p}</Fragment> : <code key={i}>{p.code}</code>))} {SHOWN[by]}
    </div>
  );
}

/** What the view under a failed call's note shows: the conversation the agent sent, or would have. */
const SHOWN: Record<FailedBy, string> = { injected: 'This is the conversation the agent would have sent.', offline: 'This is what the agent sent.', provider: 'This is the conversation the agent sent.' };

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
    const head = c.origin === 'blocked' ? (c.effect === 'read' ? 'Blocked: a read the recording doesn’t hold, after the fork, so the agent got this instead of a live result:' : 'Blocked: a write tool after the fork, so the agent got this instead of the real result:') : c.origin === 'stubbed' ? 'Stubbed: a write tool after the fork answered with a stand-in:' : c.origin === 'replayed' ? 'Served from the recording:' : result?.error ? 'The call threw:' : 'The recorded result:';
    return (
      <>
        <div className="ibar">
          <span>{head}</span>
        </div>
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
          <pre className="rawsse" tabIndex={0}>{r.raw}</pre>
        ) : (
          <>
            <div className="ibar err">
              HTTP {c.status ?? '?'}
              {RESPONSE_BY[answeredBy(c) ?? 'provider']}
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
        <pre className="rawsse" tabIndex={0}>
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

/** Details' Origin and Outcome: what made the call, an overridden one by the flag that did, and who answered a failed one. */
function originRows(c: CallDetail['call'], flag: string | null): Array<[string, ReactNode]> {
  const origin = originOf(c);
  const over = origin === 'over' && flag && /^--override\b/.test(flag) ? flag.split(' --')[0] : null;
  const made = origin === 'block' ? <>blocked <small>a write after the fork</small></> : origin === 'stub' ? <>stubbed <small>a write after the fork</small></> : origin === 'inject' ? <>injected <small>answered by Shadowlap with --fail-at</small></> : over ? <>{c.origin} <small>{over}</small></> : c.origin;
  const http = c.status ? ` · HTTP ${c.status}` : '';
  const by = answeredBy(c);
  const outcome = c.outcome === null ? 'pending' : c.outcome === 'ok' ? `ok${http}` : <>error{http}{by ? <small> {OUTCOME_BY[by]}</small> : null}</>;
  return [['Origin', made], ['Outcome', outcome]];
}

/**
 * Details' tokens, cost and time. A failed model call's input is what its request held, with nothing spent where it was
 * never sent, and its latency says who answered.
 */
function spendRows(c: CallDetail['call']): Array<[string, ReactNode]> {
  const rows: Array<[string, ReactNode]> = [];
  const by = answeredBy(c);
  const unsent = by === 'injected' || by === 'offline';
  if (c.usage) {
    const parts = by ? (unsent ? 'in the request; nothing was sent' : 'in the request') : `${num(c.usage.cacheRead)} ${INPUT_PARTS.cacheRead} · ${num(c.usage.cacheWrite)} ${INPUT_PARTS.cacheCreation} · ${num(c.usage.input)} ${INPUT_PARTS.uncached}`;
    rows.push(['Input tokens', <>{num(c.usage.input + c.usage.cacheRead + c.usage.cacheWrite)} <small>{parts}</small></>]);
    rows.push(['Output tokens', num(c.usage.output)]);
  }
  if (c.kind === 'api') rows.push(['Cost', unsent ? '$0' : c.cost === null ? <small>no price for this model · add one under prices in shadowlap.config.json</small> : <>≈{formatUsd(c.cost)}{c.origin === 'replayed' ? <small> not re-spent</small> : null}</>]);
  const answered = by && c.origin !== 'replayed' ? <small> {LATENCY_BY[by]}</small> : null;
  if (c.latencyMs !== null) rows.push(['Latency', <>{dur(c.latencyMs)}{c.ttftMs !== null ? <small> first token at {dur(c.ttftMs)}</small> : null}{c.origin === 'replayed' ? <small> replayed</small> : answered}</>]);
  return rows;
}

function DetailsTab({ runId, detail, models, flag }: { runId: string; detail: CallDetail; models?: Readonly<Record<string, string>> | undefined; flag: string | null }) {
  const c = detail.call;
  const rows: Array<[string, ReactNode]> = originRows(c, flag);
  if (c.effect) rows.push(['Effect', c.effect]);
  if (c.scope) rows.push(['Scope', c.scope]);
  if (c.agent && (c.agent !== c.scope || c.spawnedBy)) rows.push(['Agent', c.spawnedBy ? <>{c.agent}<small> started by #{c.spawnedBy}</small></> : c.agent]);
  // A call made to a host of another's format: the format it speaks, and the host it went to.
  if (c.provider)
    rows.push([
      'Provider',
      c.via ? (
        <>
          {c.provider} <small>via {viaWords(c.via, c.provider)}</small>
        </>
      ) : (
        c.provider
      ),
    ]);
  if (c.extraRead) rows.push(['Extra read', <small key="x">answered live: the recording held no counterpart, and the replay went on replaying, as a clock, random or pure read may</small>]);
  if (c.model) rows.push(['Model', modelLabel(models, c.model)]);
  if (c.stopReason) rows.push(['Stop reason', c.stopReason]);
  rows.push(...spendRows(c));
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
                  (err: unknown) => toast(errorText(err), 'error'),
                )
                .finally(() => setSaving(false));
            });
          }}
        >
          <textarea placeholder="Add a note on this call" aria-label={`A note on #${callNo}`} value={text} onChange={(e) => setText(e.target.value)} />
          <ActionButton className="btn" type="submit" disabled={saving || !text.trim()}>
            Add note
          </ActionButton>
        </form>
      ) : null}
    </>
  );
}

