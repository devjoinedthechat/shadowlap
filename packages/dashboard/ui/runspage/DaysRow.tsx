import { useEffect, useLayoutEffect, useRef, useState, type Ref, type RefObject } from 'react';
import { tipCard } from '../components/HoverCard.js';
import { num } from '../format.js';
import { useMedia, type Loaded } from '../hooks.js';
import type { DayCount, RunsByDay } from '../types.js';
import { Calendar, FindCommitLink, type WeeksProps } from './Calendar.js';
import { barOf, barSpans, barTop, CAL_NOUN, calSummary, firstGivesWay, monthMarks, oneOf, rowSteps, spanText } from './calendar-model.js';
import { useDayPicks } from './day-picks.js';

/** A day's bar is too narrow to tap on a phone or a touch screen: there a bar is a week. */
const WEEKLY = '(max-width: 640px), (pointer: coarse)';

/**
 * The twelve weeks over Runs as one slim row of days, a bar each: its height the runs it had, on a
 * square-root scale so a quiet day still shows, its failures red at its foot (all red under
 * Failed), the months under it. On a phone or a touch screen a bar is a week, which picks its seven
 * days. It filters the table as the grid does (`useDayPicks`); one sentence at its end says what it
 * counts, with Clear, Find breaking commit and Calendar, which opens the grid in its place.
 */
export function DaysRow({ data, chip, range, onPick, byPerson, onFindCommit, actionsOff = null, onToggle, toggleRef }: WeeksProps & { onToggle: () => void; toggleRef: Ref<HTMLButtonElement> }) {
  const weekly = useMedia(WEEKLY);
  const step = weekly ? 7 : 1;
  const days: DayCount[] = data?.days ?? [];
  const pick = useDayPicks({ count: days.length, range, onPick, steps: rowSteps(step) });
  const { shown, focusDay } = pick;
  const noun = CAL_NOUN[chip];
  const failedChip = chip === 'failed';
  const spans = barSpans(days, step);
  const top = barTop(days, spans);
  const sum = calSummary(days, shown);
  const per = weekly ? 'per week' : 'per day';
  const marks = monthMarks(days, spans);
  const months = useRef<HTMLDivElement>(null);
  useMonthsFit(months, marks.map((m) => `${m.label}${m.at}`).join());
  return (
    <section className={`cal hist${shown ? ' has-sel' : ''}${failedChip ? ' fails' : ''}${data ? '' : ' wait'}`} aria-hidden={data ? undefined : true} aria-label={`${noun.charAt(0).toUpperCase()}${noun.slice(1)} ${per}, last 12 weeks`}>
      <div className="hmain">
        <div className="calgrid hbars" role="group" aria-label={weekly ? 'Weeks, oldest first: tap a week or drag across several to filter the table' : 'Days, oldest first: click a day or drag across several to filter the table'} ref={pick.box} onPointerDown={pick.onPointerDown} onPointerMove={pick.onPointerMove} onKeyDown={pick.onKeyDown}>
          {spans.map(([a, b]) => {
            const bar = barOf(days, [a, b], { today: days.length - 1, noun, byPerson, failedChip, top });
            const on = !!shown && b >= shown[0] && a <= shown[1];
            return (
              <button
                key={days[a]!.day}
                type="button"
                className={`cd hb${on ? ' on' : ''}`}
                data-day={a}
                data-to={b > a ? b : undefined}
                tabIndex={focusDay >= a && focusDay <= b ? 0 : -1}
                aria-pressed={on}
                aria-label={bar.label}
                data-tip={tipCard(bar.tip.title, bar.tip.rows)}
                onFocus={() => pick.setFocus(a)}
              >
                {bar.heights.hn > 0 ? <i className="hn" style={{ height: `${bar.heights.hn.toFixed(1)}%` }} /> : null}
                {bar.heights.hf > 0 ? <i className="hf" style={{ height: `${bar.heights.hf.toFixed(1)}%` }} /> : null}
              </button>
            );
          })}
        </div>
        <div className="hmon" aria-hidden="true" ref={months}>
          {marks.map((m) => (
            <span key={`${m.label}${m.at}`} style={{ left: `min(${m.at.toFixed(2)}%, calc(100% - 2em))` }}>
              {m.label}
            </span>
          ))}
        </div>
      </div>
      <div className="calside">
        <p className="hsum">
          {data ? (
            <>
              <span className="nw">
                <b>{num(sum.runs)}</b> {sum.runs === 1 ? oneOf(noun) : noun}
              </span>{' '}
              {shown ? spanText(days, shown) : byPerson ? 'in 12 weeks, by everyone' : 'in 12 weeks, on this machine'}
              {!failedChip && sum.failed ? (
                <>
                  ,{' '}
                  <span className="nw">
                    <span className="calerr">{num(sum.failed)}</span> failed
                  </span>
                </>
              ) : null}
              .
            </>
          ) : (
            ' '
          )}
        </p>
        <p className="hact">
          {range ? (
            <button className="linkbtn" type="button" onClick={() => onPick(null)}>
              Clear
            </button>
          ) : null}
          {range && onFindCommit && failedChip && sum.failed > 0 ? <FindCommitLink days={days} range={range} onFindCommit={onFindCommit} actionsOff={actionsOff} /> : null}
          <button className="linkbtn" type="button" aria-expanded="false" ref={toggleRef} onClick={onToggle}>
            Calendar
          </button>
        </p>
      </div>
    </section>
  );
}

/** Calendar or the slim row, as last picked while the dashboard is open; not in the address. */
const kept = { calendar: false };

/**
 * The twelve weeks over Runs: the slim row of days, or the grid once Calendar is pressed, until
 * Hide calendar. The button that takes its place takes the focus, so a key press goes on from it.
 * While they load the space they take is kept; if they can't be read, the table moves up.
 */
export function TwelveWeeks({ load, ...rest }: Omit<WeeksProps, 'data'> & { load: Loaded<RunsByDay> }) {
  const [grid, setGrid] = useState(kept.calendar);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const toggled = useRef(false);
  useEffect(() => {
    if (!toggled.current) return;
    toggled.current = false;
    toggleRef.current?.focus();
  }, [grid]);
  const onToggle = () => {
    toggled.current = true;
    kept.calendar = !grid;
    setGrid(!grid);
  };
  if (!load.data && load.error) return null;
  const props = { ...rest, data: load.data, onToggle, toggleRef };
  return grid ? <Calendar {...props} /> : <DaysRow {...props} />;
}

/**
 * Drops the first bar's month name where the next one would run into it, measured as the row is laid
 * out, once the fonts are in, and again as its width changes (`firstGivesWay`).
 */
export function useMonthsFit(ref: RefObject<HTMLElement | null>, marks: string): void {
  useLayoutEffect(() => {
    const row = ref.current;
    if (!row) return;
    let live = true;
    const fit = () => live && fitMonths(row);
    fit();
    void document.fonts?.ready.then(fit);
    const sized = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    sized?.observe(row);
    return () => {
      live = false;
      sized?.disconnect();
    };
  }, [ref, marks]);
}

/** Shows the first month name under the row again, then hides it if the next name runs into it. */
export function fitMonths(row: Pick<HTMLElement, 'children'>): void {
  const first = row.children[0] as HTMLElement | undefined;
  const next = row.children[1] as HTMLElement | undefined;
  if (!first) return;
  first.hidden = false;
  if (next) first.hidden = firstGivesWay(first.getBoundingClientRect(), next.getBoundingClientRect());
}
