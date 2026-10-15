import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import { Icon } from '../components/Icon.js';
import { isMac } from '../dom.js';
import { useApp, useLayer } from '../state.js';

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
  const { exported } = useApp();
  useLayer('dialog', true, close);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => prev?.focus?.();
  }, []);
  const groups: Array<[string, boolean, Array<[ReactNode, string]>]> = [
    [
      'Anywhere',
      true,
      [
        ...(exported ? [] : ([[k(isMac() ? '⌘' : 'Ctrl', 'K'), 'Search or jump to anything']] as Array<[ReactNode, string]>)),
        [k('/'), onRun ? 'Filter this run’s calls' : 'Search or jump to anything'],
        [k('?'), 'Show these shortcuts'],
        [k('Esc'), 'Close a menu, dialog or panel'],
      ],
    ],
    [
      'Go to',
      true,
      exported
        ? [[then('g', 'r'), 'Runs'], [then('g', 'c'), 'Compare']]
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
        [
          <>
            <kbd>1</kbd>
            <span className="then">–</span>
            <kbd>4</kbd>
          </>,
          'Switch the inspector tab',
        ],
        [k('v'), 'Next view'],
        [k('n'), 'Jump to the fork or lost call'],
        [k('p'), 'Open the parent run'],
        ...(exported ? [] : ([[k('f'), 'Fork at the selected call']] as Array<[ReactNode, string]>)),
      ],
    ],
  ];
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="help" role="dialog" aria-modal="true" aria-labelledby="helpT" tabIndex={-1} ref={ref}>
        <header>
          <h3 id="helpT">Keyboard shortcuts</h3>
          <button className="ibtn" type="button" aria-label="Close" onClick={close}>
            <Icon name="x" />
          </button>
        </header>
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
    </div>
  );
}
