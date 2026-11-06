import { useRef } from 'react';
import { tipCard } from '../components/HoverCard.js';
import { Icon } from '../components/Icon.js';
import { MenuItem, Popover, useMenu } from '../components/Popover.js';
import { DOCS, docsHref, type DocsLink } from '../docs-links.js';
import { useMedia } from '../hooks.js';
import { ACTIONS } from '../labels.js';
import { useSingleKeys } from '../single-keys.js';
import { useApp } from '../state.js';
import { helpRowKey } from './top.js';

/** A touch screen, with no keys to press: the shortcuts' row is left out there, so the focus starts on Docs. */
const TOUCH = '(hover: none) and (pointer: coarse)';

/** Opens a page of the docs in a tab of its own, telling it nothing of this one. */
function openDocs(link: DocsLink): void {
  window.open(docsHref(link), '_blank', 'noopener');
}

/**
 * The top bar's help: Keyboard shortcuts (`?` at its right while single keys are on), then the docs
 * and the command line's, each opened on the repository in a tab of its own. The shortcuts sheet
 * opens once the menu has closed and its button has the focus back, so closing the sheet hands the
 * focus to the button rather than to a row already gone. An exported copy keeps it.
 */
export function HelpMenu() {
  const { conn, setHelp } = useApp();
  const singleKeys = useSingleKeys();
  const touch = useMedia(TOUCH);
  const menu = useMenu();
  const button = useRef<HTMLButtonElement>(null);
  const pick = (then: () => void) => () => {
    menu.close();
    button.current?.focus({ preventScroll: true });
    then();
  };
  return (
    <>
      <button
        className="ibtn"
        id="helpBtn"
        type="button"
        aria-label="Help"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        data-tip={tipCard('Help', [], 'Keyboard shortcuts, the docs and the command line')}
        ref={button}
        onClick={(e) => conn !== 'expired' && menu.toggle(e.currentTarget)}
      >
        <Icon name="help" />
      </button>
      {menu.open ? (
        <Popover anchor={menu.anchor} onClose={menu.close} align="end" label="Help" className="fkm narrow helpmenu">
          {touch ? null : <MenuItem label={ACTIONS.keyboardShortcuts.label} note={helpRowKey(singleKeys)} onPick={pick(() => setHelp(true))} />}
          <MenuItem label="Docs" note="github.com" onPick={pick(() => openDocs(DOCS.dashboard))} />
          <MenuItem label="Command line" note="shadowlap --help" onPick={pick(() => openDocs(DOCS.cli))} />
        </Popover>
      ) : null}
    </>
  );
}
