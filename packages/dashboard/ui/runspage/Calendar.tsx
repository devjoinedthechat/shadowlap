import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { tipCard } from '../components/HoverCard.js';
import { personName } from '../overview/model.js';
import type { RunChip } from '../runs.js';
import type { DayCount, RunsByDay } from '../types.js';
import { Avatar } from './people.js';
import { CAL_CELLS, CAL_NOUN, calSummary, counted, dayTip, dragEnd, dragOver, dragStart, failedOf, keyPick, monthLabels, moveDay, shownRange, spanText, type Drag } from './calendar-model.js';
import { dayText } from '../overview/model.js';

/**
 * Twelve weeks above the Runs table, a column per week, coloured by runs per day in four shades
 * split at the quartiles of the busy days. It counts what the chips and the filter field match, so
 * with Failed picked it shows failures per day, in red. Click a day, drag across several, or
 * Shift-click to extend; the table and the chip counts follow. Clicking the day again, Clear or
 * Escape undoes it; the arrow keys move between days, Enter picks one, Shift+Enter extends.
 */
export function Calendar({
  data,
  chip,
  range,
  onPick,
  byPerson,
  onFindCommit,
  actionsOff = null,
}: {
  data: RunsByDay | null;
  chip: RunChip;
  range: [number, number] | null;
  onPick: (range: [number, number] | null) => void;
  /** A team store is set: the hover names who ran them, the summary who ran most. */
  byPerson: boolean;
  /** Find the commit, offered with Failed picked and days chosen that failed; null hides it. */
  onFindCommit: ((range: [number, number]) => void) | null;
  /** Why actions can't run here (a read-only dashboard): Find the commit is off, saying why. */
  actionsOff?: string | null;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const days: DayCount[] = data?.days ?? [];
  const shown = shownRange(drag, range);
  const noun = CAL_NOUN[chip];
  const todayIndex = days.length - 1;
  const focusDay = focus ?? (range ? range[0] : todayIndex);

  // A drag ends wherever the pointer is let go, on the calendar or not. The day it ended on takes the
  // focus (without a ring, as after any click), so Escape undoes the pick and the arrow keys go on from
  // there.
  useEffect(() => {
    if (!drag) return;
    const up = () => {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d) return;
      onPick(dragEnd(d));
      setFocus(d.b);
      grid.current?.querySelector<HTMLElement>(`[data-day="${d.b}"]`)?.focus({ preventScroll: true });
    };
    const cancel = () => {
      dragRef.current = null;
      setDrag(null);
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [drag, onPick]);

  const dayAt = (e: { clientX: number; clientY: number }): number | null => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el instanceof Element ? el.closest('[data-day]') : null;
    return cell && grid.current?.contains(cell) ? Number((cell as HTMLElement).dataset.day) : null;
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const day = dayAt(e);
    if (day === null) return;
    e.preventDefault();
    const d = dragStart(day, range, e.shiftKey);
    dragRef.current = d;
    setDrag(d);
    setFocus(day);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const cur = dragRef.current;
    if (!cur) return;
    const day = dayAt(e);
    if (day === null) return;
    const next = dragOver(cur, day);
    if (next !== cur) {
      dragRef.current = next;
      setDrag(next);
    }
  };
  const focusOn = (day: number) => {
    setFocus(day);
    grid.current?.querySelector<HTMLElement>(`[data-day="${day}"]`)?.focus();
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('[data-day]') : null;
    if (!t) return;
    const day = Number(t.dataset.day);
    const to = moveDay(day, e.key, days.length);
    if (to !== null) focusOn(to);
    else if (e.key === 'Enter' || e.key === ' ') onPick(keyPick(day, range, e.shiftKey));
    else if (e.key === 'Escape' && range) onPick(null);
    else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      // At the edge: nothing further to move to, but the page does not scroll either.
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const sum = calSummary(days, shown);
  const one = !!shown && shown[0] === shown[1];
  const busiest = sum.busiest ? days[sum.busiest.index] : null;
  const failedNoun = chip === 'failed' ? 'runs' : noun;
  return (
    <section className={`cal${shown ? ' has-sel' : ''}${chip === 'failed' ? ' fails' : ''}`} aria-label={`${noun.charAt(0).toUpperCase()}${noun.slice(1)} per day, last 12 weeks`}>
      <div className="calmain">
        <div className="calmon" aria-hidden="true">
          {monthLabels(days).map((m) => (
            <span key={m.col} style={{ gridColumn: m.col }}>
              {m.label}
            </span>
          ))}
        </div>
        <div className="calwd" aria-hidden="true">
          <span>Mon</span>
          <span />
          <span>Wed</span>
          <span />
          <span>Fri</span>
          <span />
          <span />
        </div>
        <div className="calgrid" role="group" aria-label="Days, a column per week" ref={grid} onPointerDown={down} onPointerMove={move} onKeyDown={key}>
          {Array.from({ length: CAL_CELLS }, (_, i) => {
            const d = days[i];
            if (!d) return <span key={i} className="cd fut" />;
            const tip = dayTip(d, { today: i === todayIndex, noun, byPerson, failedChip: chip === 'failed' });
            const on = !!shown && i >= shown[0] && i <= shown[1];
            return (
              <button
                key={d.day}
                type="button"
                className={`cd l${d.level}${on ? ' on' : ''}`}
                data-day={i}
                tabIndex={i === focusDay ? 0 : -1}
                aria-pressed={on}
                aria-label={`${dayText(d.day, true)}: ${counted(d.runs, noun)}`}
                data-tip={tipCard(tip.title, tip.rows)}
                onFocus={() => setFocus(i)}
              />
            );
          })}
        </div>
        <div className="calleg" aria-hidden="true">
          Less
          <i className="cd" />
          <i className="cd l1" />
          <i className="cd l2" />
          <i className="cd l3" />
          <i className="cd l4" />
          More
        </div>
      </div>
      <div className="calside">
        <div className="ovbig">
          <b>{sum.runs.toLocaleString('en-US')}</b>
          <span>
            {sum.runs === 1 ? noun.replace(/s$/, '') : noun} {shown ? spanText(days, shown) : byPerson ? 'in 12 weeks, by everyone' : 'in 12 weeks, on this machine'}
          </span>
          {range ? (
            <button className="linkbtn" type="button" onClick={() => onPick(null)}>
              Clear
            </button>
          ) : null}
          {range && onFindCommit && chip === 'failed' && sum.failed > 0 ? (
            <button className="linkbtn" type="button" disabled={!!actionsOff} title={actionsOff ?? undefined} onClick={() => onFindCommit(range)}>
              Find the commit
            </button>
          ) : null}
        </div>
        <dl className="calkv">
          {!one ? (
            <>
              <dt>Busiest</dt>
              <dd>
                {busiest && sum.busiest ? (
                  <span>
                    {dayText(busiest.day, true)}
                    <small>{counted(sum.busiest.runs, noun)}</small>
                  </span>
                ) : (
                  <span className="calnone">none</span>
                )}
              </dd>
            </>
          ) : null}
          {byPerson ? (
            <>
              <dt>By</dt>
              <dd>
                {sum.people.length ? (
                  sum.people.slice(0, 4).map((p) => (
                    <span className="calwho" key={p.author}>
                      <Avatar author={p.author || null} />
                      {p.author ? personName(p.author) : 'unknown'}
                      <small>{p.runs.toLocaleString('en-US')}</small>
                    </span>
                  ))
                ) : (
                  <span className="calnone">nobody</span>
                )}
              </dd>
            </>
          ) : null}
          <dt>Failed</dt>
          <dd>
            <span>
              {sum.failed ? <span className="calerr">{sum.failed.toLocaleString('en-US')}</span> : <span className="calnone">none</span>}
              {sum.all ? <small>{failedOf(sum.failed, sum.all, failedNoun)}</small> : null}
            </span>
          </dd>
        </dl>
        <p className="calhint">Click a day or drag across several to filter the table. Shift-click extends.</p>
      </div>
    </section>
  );
}
