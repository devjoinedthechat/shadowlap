import { useEffect, useState } from 'react';
import { tokenInUse } from '../api.js';
import { CmdLine } from '../components/bits.js';
import { Icon } from '../components/Icon.js';
import { pastedLink } from '../connection.js';
import { copyText } from '../dom.js';
import { clock } from '../format.js';
import { readTokenLink } from '../route.js';
import { useApp } from '../state.js';

/**
 * What the page says when it cannot talk to its server. Offline: a bar under the top bar, what was
 * loaded and when, actions paused, and a retry that backs off 5, 10, 20, then 30 seconds. A session
 * token the server refuses: a full-screen card, since the dashboard was restarted (a restart issues
 * a new token) or the link is another dashboard's, with Paste the new link. A link with no token at
 * all gets the gate, which explains where the link comes from.
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

/** The mock's plain Copy command; it says Copied on itself, since a toast would sit under the card. */
function CopyCommand({ text }: { text: string }) {
  const [done, setDone] = useState<boolean | null>(null);
  useEffect(() => {
    if (done === null) return;
    const t = setTimeout(() => setDone(null), 1600);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button className="btn" type="button" onClick={() => void copyText(text).then(setDone)}>
      {done === null ? 'Copy command' : done ? 'Copied' : 'Copy failed'}
    </button>
  );
}

/**
 * Paste the new link: the link the dashboard printed, read from the clipboard, opened in this tab
 * (`pastedLink`): the page starts again with its token. Says why when the clipboard holds no
 * dashboard link, the one this page has, or can't be read.
 */
function PasteLink() {
  const [why, setWhy] = useState<string | null>(null);
  const paste = () =>
    navigator.clipboard.readText().then(
      (text) => {
        const step = pastedLink(text, location.origin);
        if (!step) return setWhy('The clipboard holds no dashboard link: copy the one shadowlap dashboard printed, with its #token=.');
        if (step.kind === 'go') return location.assign(step.url);
        if (readTokenLink(step.hash)?.token === tokenInUse()) return setWhy('That is the link this page already has: copy the one the dashboard printed when it last started.');
        setWhy(null);
        location.hash = step.hash;
      },
      () => setWhy('The browser didn’t let the page read the clipboard: paste the link into the address bar instead.'),
    );
  return (
    <>
      <button className="btn lime" type="button" onClick={() => void paste()}>
        Paste the new link
      </button>
      {why ? (
        <p className="fieldnote err" role="status">
          {why}
        </p>
      ) : null}
    </>
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
        <h2 id="connT">This link’s session token isn’t this dashboard’s</h2>
        <p>
          It was restarted, or the link is from another one. Every link carries a session token after the <code>#</code>, and each start of the dashboard issues a new one.
        </p>
        <p>Open the link it printed when it started, or start it again:</p>
        <CmdLine>shadowlap dashboard</CmdLine>
        <div className="actions">
          <CopyCommand text="shadowlap dashboard" />
          <PasteLink />
        </div>
      </div>
    </div>
  );
}

/** A link with no session token: nothing to show, and where the right link comes from. */
export function Gate() {
  // The right link, pasted over this one, starts the page again with its token.
  useEffect(() => {
    const on = () => {
      if (readTokenLink(location.hash)) location.reload();
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
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
