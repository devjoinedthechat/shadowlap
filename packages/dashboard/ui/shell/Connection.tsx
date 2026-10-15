import { useEffect, useState } from 'react';
import { CmdLine } from '../components/bits.js';
import { Icon } from '../components/Icon.js';
import { copyText } from '../dom.js';
import { clock } from '../format.js';
import { useApp } from '../state.js';

/**
 * What the page says when it cannot talk to its server. Offline: a bar under the top bar, what was
 * loaded and when, actions paused, and a retry that backs off 5, 10, 20, then 30 seconds. Expired: a
 * full-screen card, since a restart issued a new session token. A link with no token at all gets the
 * gate, which explains where the link comes from.
 */

export function OfflineBar() {
  const { conn, loadedAt, retryIn, retrying, retryNow } = useApp();
  useEffect(() => {
    document.body.classList.toggle('is-offline', conn === 'offline');
    return () => document.body.classList.remove('is-offline');
  }, [conn]);
  if (conn !== 'offline') return null;
  return (
    <div className="connbar" role="status">
      <span className="cdot" />
      <span className="ct">
        <b>Can’t reach the dashboard server.</b> It may have stopped; start it again with <code>shadowlap dashboard</code>. You’re seeing what was loaded{loadedAt ? ` at ${clock(loadedAt)}` : ''}, and actions are paused.
      </span>
      <span className="cr">{retrying ? 'Reconnecting…' : `Retrying in ${retryIn}s`}</span>
      <button className="btn sm" type="button" disabled={retrying} onClick={retryNow}>
        Retry now
      </button>
    </div>
  );
}

function CopyCommand({ text }: { text: string }) {
  const [done, setDone] = useState<boolean | null>(null);
  useEffect(() => {
    if (done === null) return;
    const t = setTimeout(() => setDone(null), 1600);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button className="btn" type="button" onClick={() => void copyText(text).then(setDone)}>
      <Icon name="copy" />
      {done === null ? 'Copy command' : done ? 'Copied' : 'Copy failed'}
    </button>
  );
}

export function ExpiredCard() {
  const { conn } = useApp();
  useEffect(() => {
    document.body.classList.toggle('is-expired', conn === 'expired');
    return () => document.body.classList.remove('is-expired');
  }, [conn]);
  if (conn !== 'expired') return null;
  return (
    <div className="connblock" role="alertdialog" aria-labelledby="connT">
      <div className="cb">
        <span className="cbi">
          <Icon name="clock" />
        </span>
        <h2 id="connT">This link has expired</h2>
        <p>
          The dashboard was restarted. Every link carries a session token after the <code>#</code>, and a restart issues a new one, so links from before stop working.
        </p>
        <p>Open the link it printed when it started, or start it again:</p>
        <CmdLine>shadowlap dashboard</CmdLine>
        <div className="actions">
          <CopyCommand text="shadowlap dashboard" />
        </div>
      </div>
    </div>
  );
}

/** A link with no session token: nothing to show, and where the right link comes from. */
export function Gate() {
  return (
    <div className="connblock gate" role="alertdialog" aria-labelledby="gateT">
      <div className="cb">
        <span className="cbi">
          <Icon name="keys" />
        </span>
        <h2 id="gateT">Open the dashboard from its link</h2>
        <p>
          Recordings hold prompts and tool data, so the dashboard serves them only to the link <code>shadowlap dashboard</code> prints. That link carries a session token for this run of the dashboard.
        </p>
        <CmdLine>shadowlap dashboard</CmdLine>
        <div className="actions">
          <CopyCommand text="shadowlap dashboard" />
        </div>
      </div>
    </div>
  );
}
