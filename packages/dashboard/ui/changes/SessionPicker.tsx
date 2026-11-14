import { useMemo } from 'react';
import { Icon } from '../components/Icon.js';
import { Picker } from '../components/Picker.js';
import { useMenu } from '../components/Popover.js';
import { sessionHint } from '../decisions.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import type { DecisionSessionView, PreviewSession } from '../types.js';

/** Where the list stops, when older sessions are left out of it (`more`). */
export const olderSessions = (kind: 'decisions' | 'migrate', listed: number): string => `The newest ${listed} ${kind === 'migrate' ? 'migrations' : 'previews'}; older ones open from their runs’ Decisions views`;

/** The previews or migrations picker: the one shown by its name, then its goldens or runs and when, fitted to the rest, and where the list stops (`more`); a pick opens it on its tab. */
export function SessionPicker({ kind, sessions, shown, more = false }: { kind: 'decisions' | 'migrate'; sessions: readonly DecisionSessionView[]; shown: PreviewSession; more?: boolean }) {
  const menu = useMenu();
  const id = shown.sessionId;
  const listed = sessions.find((s) => s.sessionId === id) ?? null;
  const hint = listed ? sessionHint(listed) : '';
  return (
    <span className="pick">
      <button className="rpick dpick" type="button" aria-haspopup="listbox" aria-expanded={menu.open} aria-label={`${kind === 'migrate' ? 'Migration' : 'Preview'}: ${shown.view.name}${hint ? `, ${hint}` : ''}`} onClick={(e) => menu.toggle(e.currentTarget)}>
        <span className="pid">{shown.view.name}</span>
        <span className="rab">{hint}</span>
        <Icon name="caret" className="caret" />
      </button>
      {menu.anchor ? <SessionList kind={kind} anchor={menu.anchor} sessions={sessions} picked={id} onClose={menu.close} foot={more ? olderSessions(kind, sessions.length) : null} /> : null}
    </span>
  );
}

function SessionList({ kind, anchor, sessions, picked, onClose, foot }: { kind: 'decisions' | 'migrate'; anchor: HTMLElement; sessions: readonly DecisionSessionView[]; picked: string; onClose: () => void; foot: string | null }) {
  const items = useMemo(
    () =>
      sessions.map((s) => {
        const hint = sessionHint(s, { full: true });
        return {
          id: s.sessionId,
          text: `${s.name} ${s.change} ${hint}`,
          current: s.sessionId === picked,
          node: (
            <>
              <span className="pid">{s.name}</span>
              <span className="rab">{hint}</span>
            </>
          ),
        };
      }),
    [sessions, picked],
  );
  return (
    <Picker
      anchor={anchor}
      label={kind === 'migrate' ? 'Migrations' : 'Previews'}
      placeholder="Filter by model, field or golden"
      items={items}
      foot={foot}
      onClose={onClose}
      onPick={(sid) => {
        onClose();
        if (sid !== picked) navigate(href.changeSession(kind, sid));
      }}
    />
  );
}
