import { useEffect, useRef, useState } from 'react';
import { tokenInUse } from '../api.js';
import { CmdLine } from '../components/bits.js';
import { CodeBox, CopyButton } from '../components/CodeBox.js';
import { Icon } from '../components/Icon.js';
import { pastedLink } from '../connection.js';
import { copyText } from '../dom.js';
import { DOCS, docsHref } from '../docs-links.js';
import { clock } from '../format.js';
import { holdBehind } from '../overlays/modal-store.js';
import { readTokenLink } from '../route.js';
import { useApp } from '../state.js';

/**
 * What the page says when it cannot talk to its server. Offline: one hairline row under the top bar,
 * in the app's grid so it never covers the page: what failed, what was loaded and when, actions
 * paused, the command that starts it again, and a retry that backs off 5, 10, 20, then 30 seconds. On
 * a phone it is one line, with why behind a button. A session token the server refuses: a full-screen
 * card, since the dashboard was restarted (a restart issues a new token) or the link is another
 * dashboard's, with a command box and Paste the new link. A link with no token at all gets the gate,
 * which explains where the link comes from.
 */

/** What the bar's live region says while the server can't be reached, once as it comes: never the countdown or the buttons. */
export const OFFLINE_SAID = 'Offline · actions paused · Can’t reach the dashboard server · showing what loaded';

export function OfflineBar() {
  const { conn, loadedAt, retryIn, retrying, retryNow } = useApp();
  const [why, setWhy] = useState(false);
  useEffect(() => {
    document.body.classList.toggle('is-offline', conn === 'offline');
    return () => document.body.classList.remove('is-offline');
  }, [conn]);
  const offline = conn === 'offline';
  const when = loadedAt ? ` at ${clock(loadedAt)}` : '';
  // The live region is on the page before its words come, as the toast's is: one on a display: contents box, or drawn
  // with its words already in it, may never be heard (Safari drops such a box's role). What the bar draws is drawn only.
  const said = (
    <span className="sr" role="status">
      {offline ? `${OFFLINE_SAID}${when}` : ''}
    </span>
  );
  if (!offline) return said;
  return (
    <>
      {said}
      <div className={`connbar${why ? ' open' : ''}`}>
        <span className="cdot" />
        <span className="csay">
          <span className="cs" aria-hidden="true">
            Offline · actions paused
          </span>
          <span className="ct" aria-hidden="true">
            <b className="nw">Can’t reach the dashboard server</b> · <span className="nw">showing what loaded{when}</span> · <span className="nw">actions paused ·</span>
          </span>
        </span>
        <button className="linkbtn cwhy" type="button" aria-expanded={why} aria-controls="connWhyText" onClick={() => setWhy(!why)}>
          Why
        </button>
        {/* What Why discloses, next after it as a screen reader moves on: it shows only when asked for. */}
        <span className="cw" id="connWhyText">
          <span className="cwt">Can’t reach the dashboard server, so this shows what loaded{when}.</span> <span className="cwa">Start it again:</span>
        </span>
        <span className="cc">
          <span className="cwith">start it with </span>
          <code>shadowlap dashboard</code>
          <CopyButton text="shadowlap dashboard" label="the command" name="Copy command" sub="Starts the dashboard server again" className="linkbtn ccopy">
            {null}
          </CopyButton>
        </span>
        <span className="cr">{retrying ? 'Reconnecting…' : `Retrying in ${retryIn}s`}</span>
        <button className="btn sm" type="button" disabled={retrying} onClick={retryNow}>
          Retry now
        </button>
      </div>
    </>
  );
}

/** The gate's Copy: it says Copied on itself, as the gate renders outside the app, where a toast can't come from. */
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
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const expired = conn === 'expired';
    document.body.classList.toggle('is-expired', expired);
    // The page behind the card can't be used: Tab and assistive technology keep to the card, whose
    // way out (Paste the new link) has the focus. It is a modal's reason, counted with a modal's.
    const release = expired ? holdBehind(true) : null;
    if (expired) card.current?.querySelector<HTMLElement>('.btn.lime')?.focus();
    return () => {
      document.body.classList.remove('is-expired');
      release?.();
    };
  }, [conn]);
  if (conn !== 'expired') return null;
  return (
    <div className="connblock" role="alertdialog" aria-modal="true" aria-labelledby="connT" aria-describedby="connD" tabIndex={-1} ref={card}>
      <div className="cb">
        <span className="cbi">
          <Icon name="clock" />
        </span>
        <h1 id="connT">This link’s session token isn’t this dashboard’s</h1>
        <p id="connD">It was restarted, or the link is from another one. Open the link it printed when it started, or start it again:</p>
        <CodeBox command="shadowlap dashboard" />
        <p className="cbdoc">
          <a className="more dlgdoc" href={docsHref(DOCS.sessionTokens)} target="_blank" rel="noopener">
            {DOCS.sessionTokens.what} in the docs<span aria-hidden="true">{'\u00a0→'}</span>
          </a>
        </p>
        <div className="actions">
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
        <h1 id="gateT">Open the dashboard from its link</h1>
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
