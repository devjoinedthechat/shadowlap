import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActionButton } from '../components/ActionButton.js';
import { PageHeader } from '../components/bits.js';
import { Id } from '../components/Id.js';
import { Page } from '../components/Page.js';
import { owePageHeading } from '../focus-manager.js';
import type { HeldAsk } from '../held.js';
import { elsewhereWords, type LinePart } from '../held-words.js';
import { shownProject, type HoldingView } from '../projects-api.js';
import { switchToLabel } from '../projects.js';
import { useRoute } from '../router.js';
import { switchProject } from '../shell/ProjectBlock.js';
import { Unshown, unshownKey } from '../shell/unshown.js';
import { useApp } from '../state.js';
import type { ElsewhereProps } from './held-elsewhere.js';

/**
 * A link into another project: the page asks the server which other project's store holds what its
 * address names (`GET /api/projects/holding`), its own loading look meanwhile, and shows the In page
 * when one does: *In support-agent*, a line that says whose store holds it and whose doesn't, and the
 * page's one lime action, **Switch to support-agent**, which switches and opens the same address
 * there, at the same call, view, step or pair. Otherwise, or when the ask fails, the page's own
 * not-found. Declared, with what shows while its code comes, in pages/held-elsewhere.tsx.
 *
 * It asks once for each thing and project shown: a fix's page reads again with every call a
 * recording makes, each read failing anew, and asking each time would open every other store as
 * often. A read that fails anew asks again only when the last ask failed (the server was out of
 * reach). An answer that names another project than the one the page shows means the dashboard
 * switched elsewhere: the page turns to it, as after a refused change.
 *
 * Once Switch is pressed the page holds, busy, until the page it opens has drawn: the item, or its
 * own read failing anew there, which asks again (a pair split across two projects names the first
 * one back). A read that fails before the switch has landed and the page has been asked to read
 * again was made in the project the page showed, and the page holds on: a fix's page reads again
 * with each call a recording there makes. A switch refused (the project left the list meanwhile)
 * says why in a toast and asks again, which finds nothing now. The opened page's heading takes the
 * focus.
 */

/** What an answer was asked for: the kind, the ids and the project the page showed. */
const keyOf = (ask: HeldAsk, shown: string | null) => `${ask.what}:${ask.ids.join('/')}:${shown ?? ''}`;

export function ElsewherePage({ ask, error = null, waiting, retry, fallback }: ElsewhereProps) {
  const app = useApp();
  const { client, reload } = app;
  const shown = app.meta?.project?.id ?? null;
  const key = keyOf(ask, shown);
  const [asked, setAsked] = useState<{ key: string; view: HoldingView | null | 'failed' } | null>(null);
  const [again, setAgain] = useState(0);
  const [switching, setSwitching] = useState(false);
  // Switch has landed, and the page has been asked to read again: a read failing before then was the project it showed.
  const landed = useRef(false);
  const askRef = useRef(ask);
  askRef.current = ask;

  // One ask per thing and project shown, and again when told to; none while a switch lands.
  useEffect(() => {
    if (switching) return;
    let live = true;
    const { what, ids } = askRef.current;
    client.projects.holding(what, ids).then(
      (view) => live && setAsked({ key, view }),
      () => live && setAsked({ key, view: 'failed' }),
    );
    return () => {
      live = false;
    };
  }, [client, key, again, switching]);

  // The page's read failed anew: once Switch has landed, that answer counts now; else only an ask that failed asks again.
  const seen = useRef(error);
  const lastFailed = asked?.key === key && asked.view === 'failed';
  useEffect(() => {
    if (error === seen.current) return;
    seen.current = error;
    if (!error) return;
    if (!switching) {
      if (lastFailed) setAgain((n) => n + 1);
    } else if (landed.current) setSwitching(false);
  }, [error, switching, lastFailed]);

  const view = asked?.view && asked.view !== 'failed' ? asked.view : null;
  const held = view?.held ?? null;
  // An answer for another project than the one shown: the dashboard switched elsewhere, and the page turns to it.
  const away = !switching && held !== null && asked?.key === key && view?.current.id !== shown;
  useEffect(() => {
    if (away) void reload();
  }, [away, reload]);

  if (!switching && (asked?.key !== key || away)) return <>{waiting}</>;
  if (!view || !held) return <>{fallback}</>;
  const holder = held.project;
  const press = async () => {
    const from = shownProject();
    landed.current = false;
    setSwitching(true);
    owePageHeading();
    await switchProject(app, holder.id, location.hash);
    // Refused (the toast says why): ask again, as the project shown is the same.
    if (shownProject() === from) return setSwitching(false);
    landed.current = true;
    retry?.();
    // With no read of its own to fail anew (the setup's place), what shows now asks again.
    if (!retry) setSwitching(false);
  };
  return <InPage held={held} current={view.current.name} what={ask.what} busy={switching} onSwitch={() => void press()} />;
}

function InPage({ held, current, what, busy, onSwitch }: { held: NonNullable<HoldingView['held']>; current: string; what: HeldAsk['what']; busy: boolean; onSwitch: () => void }) {
  const route = useRoute();
  const at = unshownKey(route);
  const holder = held.project.name;
  const words = elsewhereWords({ what, id: held.id, holder, current });
  return (
    <Page busy={busy}>
      {/* The crumbs name only the section, and the tab the project that holds it. */}
      {at ? <Unshown at={at} heldBy={holder} /> : null}
      <PageHeader
        eyebrow={words.eyebrow}
        title={partNodes(words.title, what)}
        text={partNodes(words.line, what)}
        actions={
          <ActionButton className="btn lime" disabled={busy} onClick={onSwitch}>
            {switchToLabel(holder)}
          </ActionButton>
        }
      />
    </Page>
  );
}

/**
 * Words in parts, handed to the header as they are, so the lead's `Copy` sets its words (`is in`
 * kept with the project's name) and each part is an element it keeps whole: a run's id as every
 * run's id is drawn, another id in mono, a project's name.
 */
function partNodes(parts: readonly LinePart[], what: HeldAsk['what']): ReactNode[] {
  return parts.map((p, i) =>
    p.face === 'id' ? (
      what === 'run' ? (
        <Id key={i} id={p.text} />
      ) : (
        <code key={i} className="nw">
          {p.text}
        </code>
      )
    ) : p.face === 'nw' ? (
      <span key={i} className="nw">
        {p.text}
      </span>
    ) : (
      p.text
    ),
  );
}
