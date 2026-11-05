import { useMemo, useRef } from 'react';
import { AboutLine, useFitAbouts } from '../components/About.js';
import { Icon } from '../components/Icon.js';
import { Id } from '../components/Id.js';
import { Picker } from '../components/Picker.js';
import { useMenu } from '../components/Popover.js';
import { shortId } from '../format.js';
import type { RunListItem } from '../types.js';

/**
 * A run picker (Compare's A and B, Redaction's preview): a button with the run's id, then its about
 * line fitted to the rest of it (decision 10), opening a picker of runs in the same form: a filter by
 * id, about line or label, the one picked checked. A native select can't set the about line apart
 * from the id.
 */
/** What a picker lists of a run: its id, its about line and what else its filter finds it by. */
export type PickableRun = Pick<RunListItem, 'runId' | 'about'> & Partial<Pick<RunListItem, 'labels'>>;

export function RunPicker({ label, value, runs, onPick }: { label: string; value: string; runs: readonly PickableRun[]; onPick: (runId: string) => void }) {
  const menu = useMenu();
  const shown = runs.find((r) => r.runId === value || r.runId.startsWith(value)) ?? null;
  const id = shown?.runId ?? value;
  const box = useRef<HTMLSpanElement>(null);
  useFitAbouts(box);
  return (
    <span className="pick" ref={box}>
      <button className="rpick" type="button" aria-haspopup="listbox" aria-expanded={menu.open} aria-label={`${label}: ${shortId(id)}${shown?.about ? `, ${shown.about.text}` : ''}`} onClick={(e) => menu.toggle(e.currentTarget)}>
        <code className="pid">{shortId(id)}</code>
        <AboutLine about={shown?.about} className="pab" />
        <Icon name="caret" className="caret" />
      </button>
      {menu.anchor ? (
        <RunList
          anchor={menu.anchor}
          label={label}
          runs={runs}
          picked={id}
          onClose={menu.close}
          onPick={(runId) => {
            menu.close();
            if (runId !== id) onPick(runId);
          }}
        />
      ) : null}
    </span>
  );
}

/** The open list: its rows made once for the runs and the one picked, however often the page around it draws. */
function RunList({ anchor, label, runs, picked, onClose, onPick }: { anchor: HTMLElement; label: string; runs: readonly PickableRun[]; picked: string; onClose: () => void; onPick: (runId: string) => void }) {
  const items = useMemo(
    () =>
      runs.map((r) => ({
        id: r.runId,
        text: `${r.runId} ${r.about?.text ?? ''} ${(r.labels ?? []).join(' ')}`,
        current: r.runId === picked,
        node: (
          <>
            <Id id={shortId(r.runId)} list className="pid" />
            <AboutLine about={r.about} className="pab" />
          </>
        ),
      })),
    [runs, picked],
  );
  return <Picker anchor={anchor} label={label} placeholder="Filter by id, about line or label" items={items} onClose={onClose} onPick={onPick} />;
}
