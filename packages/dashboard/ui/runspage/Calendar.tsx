import type { Ref } from 'react';
import { tipCard } from '../components/HoverCard.js';
import { personName } from '../overview/model.js';
import type { RunChip } from '../runs.js';
import type { DayCount, RunsByDay } from '../types.js';
import { Avatar } from './people.js';
import { CAL_CELLS, CAL_NOUN, calSummary, counted, dayTip, failedOf, GRID_STEPS, monthLabels, spanText } from './calendar-model.js';
import { useDayPicks } from './day-picks.js';
import { dayText } from '../overview/model.js';
import { ACTIONS, confirmWords } from '../labels.js';
import { ActionButton } from '../components/ActionButton.js';
import { SrSpace } from '../components/bits.js';

/** What the twelve weeks over Runs are drawn from, as the slim row of days or the grid alike. */
export interface WeeksProps {
  /** Null while it loads: the space it takes is kept, so the table doesn't jump when it comes. */
  data: RunsByDay | null;
  chip: RunChip;
  range: [number, number] | null;
  onPick: (range: [number, number] | null) => void;
  /** A team store is set: the hover names who ran them, the summary who ran most. */
  byPerson: boolean;
  /** Find breaking commit, offered with Failed picked and days chosen that failed; null hides it. */
  onFindCommit: ((range: [number, number]) => void) | null;
}

/** Find breaking commit for the days picked, its card saying where the search starts; on a dashboard that changes nothing it waits, its card saying why. */
export function FindCommitLink({ days, range, onFindCommit }: { days: readonly DayCount[]; range: [number, number]; onFindCommit: (range: [number, number]) => void }) {
  const label = ACTIONS.findBreakingCommit.label;
  return (
    <ActionButton className="linkbtn" tip={confirmWords(label)} sub={`From the first failure ${spanText(days, range)}, between a commit where it worked and its own`} onClick={() => onFindCommit(range)}>
      {label}
    </ActionButton>
  );
}

/**
 * Twelve weeks above the Runs table, a column per week, coloured by runs per day in four shades
 * split at the quartiles of the busy days: what Calendar opens from the slim row of days, and Hide
 * calendar closes. It counts what the chips and the filter field match, so with Failed picked it
 * shows failures per day, in red. Click a day, drag across several, or Shift-click to extend; the
 * table and the chip counts follow. Clicking the day again, Clear or Escape undoes it; the arrow
 * keys move between days, Enter picks one, Shift+Enter extends (`useDayPicks`).
 */
export function Calendar({ data, chip, range, onPick, byPerson, onFindCommit, onToggle, toggleRef }: WeeksProps & { onToggle: () => void; toggleRef: Ref<HTMLButtonElement> }) {
  const days: DayCount[] = data?.days ?? [];
  const pick = useDayPicks({ count: days.length, range, onPick, steps: GRID_STEPS });
  const { shown, focusDay } = pick;
  const noun = CAL_NOUN[chip];
  const todayIndex = days.length - 1;

  const sum = calSummary(days, shown);
  const one = !!shown && shown[0] === shown[1];
  const busiest = sum.busiest ? days[sum.busiest.index] : null;
  const failedNoun = chip === 'failed' ? 'runs' : noun;
  return (
    <section className={`cal${shown ? ' has-sel' : ''}${chip === 'failed' ? ' fails' : ''}${data ? '' : ' wait'}`} aria-hidden={data ? undefined : true} aria-label={`${noun.charAt(0).toUpperCase()}${noun.slice(1)} per day, last 12 weeks`}>
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
        <div className="calgrid" role="group" aria-label="Days, a column per week" ref={pick.box} onPointerDown={pick.onPointerDown} onPointerMove={pick.onPointerMove} onKeyDown={pick.onKeyDown}>
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
                onFocus={() => pick.setFocus(i)}
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
          {range && onFindCommit && chip === 'failed' && sum.failed > 0 ? <FindCommitLink days={days} range={range} onFindCommit={onFindCommit} /> : null}
        </div>
        <dl className="calkv">
          {!one ? (
            <>
              <dt>Busiest</dt>
              <dd>
                {busiest && sum.busiest ? (
                  <span>
                    {dayText(busiest.day, true)}
                    <SrSpace />
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
              {sum.all ? (
                <>
                  <SrSpace />
                  <small>{failedOf(sum.failed, sum.all, failedNoun)}</small>
                </>
              ) : null}
            </span>
          </dd>
        </dl>
        <p className="calhint">Click a day or drag across several to filter the table. Shift-click extends.</p>
        <button className="linkbtn" type="button" aria-expanded="true" ref={toggleRef} onClick={onToggle}>
          Hide calendar
        </button>
      </div>
    </section>
  );
}
