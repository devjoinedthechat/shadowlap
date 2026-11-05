import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import { Modal } from '../components/Dialog.js';
import { isMac } from '../dom.js';
import { useScrollStop } from '../hooks.js';
import { copyCompares } from '../runs.js';
import { useApp } from '../state.js';

/** The shortcuts panel (?): Anywhere, Go to, and On a run, dimmed away from a run. */
export function Shortcuts({ onRun }: { onRun: boolean }) {
  const { help, setHelp } = useApp();
  if (!help) return null;
  return <Panel onRun={onRun} close={() => setHelp(false)} />;
}

const k = (...keys: string[]) =>
  keys.map((x, i) => (
    <kbd key={i}>{x}</kbd>
  ));
const then = (a: string, b: string) => (
  <>
    <kbd>{a}</kbd>
    <span className="then">then</span>
    <kbd>{b}</kbd>
  </>
);
const or = (a: string, b: string) => (
  <>
    <kbd>{a}</kbd>
    <span className="then">or</span>
    <kbd>{b}</kbd>
  </>
);

function Panel({ onRun, close }: { onRun: boolean; close: () => void }) {
  const { exported, meta } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const body = useRef<HTMLDivElement>(null);
  useScrollStop(body);
  const groups: Array<[string, boolean, Array<[ReactNode, string]>]> = [
    [
      'Anywhere',
      true,
      // An exported copy has no palette: there `/` only filters a run's calls, so it sits under On a run.
      [
        ...(exported ? [] : ([[k(isMac() ? '⌘' : 'Ctrl', 'K'), 'Search or jump to anything']] as Array<[ReactNode, string]>)),
        ...(exported ? [] : ([[k('/'), onRun ? 'Filter this run’s calls' : 'Search or jump to anything']] as Array<[ReactNode, string]>)),
        [k('?'), 'Show these shortcuts'],
        [k('u'), 'Undo, while a toast offers it'],
        [k('Esc'), 'Close a menu, dialog or panel'],
      ],
    ],
    [
      'Go to',
      true,
      exported
        ? [[then('g', 'r'), 'Runs'], ...(copyCompares(meta?.runIds) ? ([[then('g', 'c'), 'Compare']] as Array<[ReactNode, string]>) : [])]
        : [
            [then('g', 'o'), 'Overview'],
            [then('g', 'r'), 'Runs'],
            [then('g', 'c'), 'Compare'],
            [then('g', 'f'), 'Fixes'],
            [then('g', 't'), 'Tests'],
            [then('g', 'a'), 'Training'],
            [then('g', 's'), 'Settings'],
          ],
    ],
    [
      'On a run',
      onRun,
      [
        [or('j', '↓'), 'Next call'],
        [or('k', '↑'), 'Previous call'],
        [or('←', '→'), 'In Calls, fold or open the selected call’s group'],
        [
          <>
            <kbd>1</kbd>
            <span className="then">–</span>
            <kbd>4</kbd>
          </>,
          'Switch the inspector tab',
        ],
        [k('v'), 'Next view'],
        [k('n'), 'Jump to the fork, the lost call or the first failed one'],
        [k('p'), 'Open the parent run'],
        ...(exported
          ? ([[k('/'), 'Filter this run’s calls']] as Array<[ReactNode, string]>)
          : ([
              [k('f'), 'Fork at the selected call'],
              // The good/bad key, on a run's page and on the Runs row with the focus.
              [or('+', '-'), 'Label it good or bad; again to take it off'],
            ] as Array<[ReactNode, string]>)),
      ],
    ],
  ];
  return (
    <Modal requestClose={close}>
      <div className="help" role="dialog" aria-modal="true" aria-labelledby="helpT" tabIndex={-1} ref={ref}>
        <header>
          <h3 id="helpT">Keyboard shortcuts</h3>
        </header>
        <div className="hbody" ref={body}>
          <div className="hgrid">
            {groups.map(([title, on, rows]) => (
              <section key={title} className={`hgroup${on ? '' : ' off'}`}>
                <h4>
                  {title}
                  {on ? null : <small>open a run to use these</small>}
                </h4>
                <dl>
                  {rows.map(([keys, what], i) => (
                    <Fragment key={i}>
                      <dt>{keys}</dt>
                      <dd>{what}</dd>
                    </Fragment>
                  ))}
                </dl>
              </section>
            ))}
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
