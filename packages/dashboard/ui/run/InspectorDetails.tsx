import { Fragment, useState, type ReactNode } from 'react';
import { INPUT_PARTS } from '../../../engine/src/tokens.js';
import type { CallDetail, RunNote } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { Code, LongWord } from '../components/Copy.js';
import { dur, formatUsd, num, shortFingerprint, stamp } from '../format.js';
import { useApp } from '../state.js';
import { errorText } from '../toast.js';
import { answeredBy, type FailedBy } from './calls.js';
import { originOf, modelLabel } from './model.js';
import { viaWords } from './notes.js';

/**
 * The inspector's Details tab (Inspector.tsx): what made the call and who answered it, its usage,
 * cost and timing, its fingerprint and headers, and the notes on it. A part of its own, loaded the
 * first time the tab shows, as a run's views are: a run's page opens on another tab. NoteForm is
 * Provenance's too.
 */

/** A failed model call's words in the Details tab, by who answered it. */
const OUTCOME_BY: Readonly<Record<FailedBy, string>> = { injected: 'by --fail-at, never sent', offline: 'refused offline', provider: 'from the provider' };
const LATENCY_BY: Readonly<Record<FailedBy, string>> = { injected: 'answered by shadowlap', offline: 'refused by the replay', provider: 'answered by the provider' };

/** Details' Origin and Outcome: what made the call, an overridden one by the flag that did, and who answered a failed one. */
function originRows(c: CallDetail['call'], flag: string | null, played: string | null): Array<[string, ReactNode]> {
  const origin = originOf(c);
  // An overridden call says what overrode it, though it ended in an error and is drawn as failed.
  const overridden = c.origin === 'overridden';
  const over = overridden && flag && /^--override\b/.test(flag) ? flag.split(' --')[0] : null;
  // The preset a call was played in by, said once for its Origin and its Outcome.
  const pre = played && `by the ${played} preset`;
  const made = origin === 'block' ? <>blocked <small>a write after the fork</small></> : origin === 'stub' ? <>stubbed <small>a write after the fork</small></> : origin === 'inject' ? (
      <>
        injected{' '}
        <small>
          {pre || (
            <>
              answered by shadowlap with <Code>--fail-at</Code>
            </>
          )}
        </small>
      </>
    ) : over || (overridden && pre) ? (
      <>
        {c.origin} <small>{pre || (over ? <Code>{over}</Code> : null)}</small>
      </>
    ) : (
      c.origin
    );
  const http = c.status ? ` · HTTP ${c.status}` : '';
  const by = answeredBy(c);
  const said = pre ? `${pre}${c.kind === 'api' ? ', never sent' : '; the tool didn’t run'}` : by && OUTCOME_BY[by];
  const outcome = c.outcome === null ? 'pending' : c.outcome === 'ok' ? `ok${http}` : <>error{http}{said ? <small> {said}</small> : null}</>;
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

export function DetailsTab({ runId, detail, models, flag, played }: { runId: string; detail: CallDetail; models?: Readonly<Record<string, string>> | undefined; flag: string | null; played: string | null }) {
  const c = detail.call;
  const rows: Array<[string, ReactNode]> = originRows(c, flag, played);
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
      <span title={c.fingerprint}>
        <LongWord>{shortFingerprint(c.fingerprint)}</LongWord>
      </span>{' '}
      <small>occurrence {c.occurrence}</small>
    </>,
  ]);
  // An id or a hash whole where its line holds it, and broken only where it doesn't: a digest is wider than a phone's column.
  rows.push(['Run', <LongWord>{runId}</LongWord>]);
  if (c.implHash) rows.push(['Implementation', <LongWord>{c.implHash}</LongWord>]);
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
  const [list, setList] = useState(notes);
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
      <NoteForm runId={runId} callNo={callNo} onSaved={setList} />
    </>
  );
}

/**
 * Adds a note on a call, or on the whole run (`callNo` null), as `shadowlap note` does with or without
 * `--call`: `onSaved` hears the notes the server keeps on that call, or on the run, after it. None on
 * a dashboard that changes nothing, or in a copy.
 */
export function NoteForm({ runId, callNo, onSaved }: { runId: string; callNo: number | null; onSaved: (notes: RunNote[]) => void }) {
  const { client, actionsOff, exported, toast, guard } = useApp();
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  if (exported || actionsOff) return null;
  return (
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
                onSaved(r.notes);
                setText('');
                toast(callNo === null ? 'Note saved on the run' : `Note saved on #${callNo}`);
              },
              (err: unknown) => toast(errorText(err), 'error'),
            )
            .finally(() => setSaving(false));
        });
      }}
    >
      <textarea placeholder={callNo === null ? 'Add a note on this run' : 'Add a note on this call'} aria-label={callNo === null ? 'A note on this run' : `A note on #${callNo}`} value={text} onChange={(e) => setText(e.target.value)} />
      <ActionButton className="btn" type="submit" disabled={saving || !text.trim()}>
        Add note
      </ActionButton>
    </form>
  );
}

