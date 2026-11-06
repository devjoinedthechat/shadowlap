import { Fragment, useEffect, useRef } from 'react';
import { Modal } from '../components/Dialog.js';
import { Switch } from '../components/Switch.js';
import { isMac, paletteKeyLabel, undoKeyLabel } from '../dom.js';
import { useScrollStop } from '../hooks.js';
import { copyCompares } from '../runs.js';
import { ACTIONS } from '../labels.js';
import { setSingleKeys, sheetLines, switchSentence, useSingleKeys, type SheetGroup, type SheetLine, type SheetPlace } from '../shortcuts.js';
import { useApp } from '../state.js';

/**
 * The shortcuts sheet (?), grouped by where they work: Anywhere and In a list on the left, Go to on
 * the right, a run's under both, dimmed away from a run. Its lines are the table in shortcuts.ts.
 * Single-key shortcuts can be turned off at its foot, and the browser remembers it.
 */
export function Shortcuts({ onRun }: { onRun: boolean }) {
  const { help, setHelp } = useApp();
  if (!help) return null;
  return <Panel onRun={onRun} close={() => setHelp(false)} />;
}

/** The sheet's columns: each column's groups, top to bottom. */
const COLUMNS: ReadonlyArray<readonly SheetGroup[]> = [['Anywhere', 'In a list'], ['Go to'], ['On a run']];

function Line({ line }: { line: SheetLine }) {
  const sk = line.single ? 'sk' : undefined;
  return (
    <>
      <dt className={sk}>
        {line.chips.map((c, i) => (c.join ? <span key={i} className="then">{c.text}</span> : <kbd key={i}>{c.text}</kbd>))}
      </dt>
      <dd className={sk}>{line.label}</dd>
    </>
  );
}

function Group({ name, place, on }: { name: SheetGroup; place: SheetPlace; on: boolean }) {
  return (
    <section className={`hgroup${on ? '' : ' off'}`}>
      <h4>
        {name}
        {on ? null : <small>open a run to use these</small>}
      </h4>
      <dl>
        {sheetLines(name, place, isMac()).map((line) => (
          <Fragment key={line.id}>
            <Line line={line} />
          </Fragment>
        ))}
      </dl>
    </section>
  );
}

function Panel({ onRun, close }: { onRun: boolean; close: () => void }) {
  const { exported, meta } = useApp();
  const singleKeys = useSingleKeys();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const body = useRef<HTMLDivElement>(null);
  useScrollStop(body);
  const place: SheetPlace = { exported, onRun, onRuns: !!document.querySelector('#runsQuery'), compares: copyCompares(meta?.runIds) };
  return (
    <Modal requestClose={close}>
      <div className="help" role="dialog" aria-modal="true" aria-labelledby="helpT" tabIndex={-1} ref={ref}>
        <header>
          <h3 id="helpT">{ACTIONS.keyboardShortcuts.label}</h3>
        </header>
        <div className="hbody" ref={body}>
          <div className="hgrid">
            {COLUMNS.map((groups) => (
              <div key={groups[0]} className="hcol">
                {groups.map((name) => (
                  <Group key={name} name={name} place={place} on={name !== 'On a run' || onRun} />
                ))}
              </div>
            ))}
          </div>
          <div className="hkeys">
            <Switch on={singleKeys} onChange={setSingleKeys}>
              Single-key shortcuts
            </Switch>
            <span>{switchSentence(exported, paletteKeyLabel(), undoKeyLabel())}</span>
          </div>
        </div>
        <footer>
          <button className="btn" type="button" onClick={close}>
            Close
          </button>
        </footer>
      </div>
    </Modal>
  );
}
