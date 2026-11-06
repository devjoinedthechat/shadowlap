import { type ReactNode, useId, useRef, useState } from 'react';
import { Seg } from '../components/bits.js';
import { tipCard } from '../components/HoverCard.js';
import { Id } from '../components/Id.js';
import { Glyph } from '../components/RunIcon.js';
import { Section } from '../components/Section.js';
import { glossed } from '../components/Term.js';
import { cents, ktok, money, num, shortId } from '../format.js';
import { useStored } from '../hooks.js';
import { useListKeys } from '../list-keys.js';
import { ORIGIN_NAME } from '../origins.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import type { CacheUse, DaySums, OverviewSummary } from '../types.js';
import { chartScale, dayText, kindGlyph, originCounts, originRows, share, tickText, usageLine } from './model.js';
import { useAbouts } from './words.js';

/**
 * Usage, under the rest and folded until asked for: what replaying served, the prompt cache and
 * what was spent, each a receipt next to what it paid for. Folded, its heading's line says the three
 * in figures, and nothing under it is drawn; open, each has its part, with today's receipt under
 * them. Open or folded is kept for the session.
 */

const USAGE_KEY = 'shadowlap-overview-usage';

function wasOpen(): boolean {
  try {
    return sessionStorage.getItem(USAGE_KEY) === 'open';
  } catch {
    return false;
  }
}

function keepOpen(open: boolean): void {
  try {
    if (open) sessionStorage.setItem(USAGE_KEY, 'open');
    else sessionStorage.removeItem(USAGE_KEY);
  } catch {
    // Storage blocked: Usage opens folded next time.
  }
}

/** Parts of a line joined by dots, each kept whole with its dot, so a line that wraps breaks only after a dot and never starts on one. */
const dotted = (parts: readonly string[]) => parts.map((p) => p.replace(/ /g, '\u00a0')).join('\u00a0· ');

export function Usage({ s }: { s: Pick<OverviewSummary, 'sums' | 'cache' | 'outcomes' | 'daily' | 'today'> }) {
  const [open, setOpen] = useState(wasOpen);
  const id = useId();
  const toggle = () => {
    keepOpen(!open);
    setOpen(!open);
  };
  const served = s.today.served;
  return (
    <Section
      title="Usage"
      className="ovuse"
      sub={dotted(usageLine(s.sums.week, s.cache.readShare, s.outcomes.spent.value))}
      actions={
        <button className="linkbtn" type="button" aria-expanded={open} aria-controls={id} onClick={toggle}>
          {open ? 'Hide' : 'Show'}
        </button>
      }
    >
      {open ? (
        <>
          <div className="ugrid" id={id}>
            <OriginPart origins={s.sums.week.origins} />
            <CachePart cache={s.cache} />
            <SpendPart daily={s.daily} />
          </div>
          {served ? (
            <p className="leaknote">
              Today {num(served)} {served === 1 ? 'call was' : 'calls were'} served from recordings: {cents(s.today.notRespent)} {glossed('not re-spent')}.
            </p>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}

function Part({ title, sub, actions, className, children }: { title: string; sub: ReactNode; actions?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={`upart${className ? ` ${className}` : ''}`}>
      <div className="uph">
        <h3>{title}</h3>
        <span className="sub">{sub}</span>
        {actions ? (
          <>
            <span className="sp" />
            {actions}
          </>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function OriginPart({ origins }: { origins: Readonly<Record<string, number>> }) {
  const counts = originCounts(origins);
  const rows = originRows(counts);
  const total = rows.reduce((t, r) => t + r.count, 0);
  return (
    <Part title="Calls by origin" sub="this week">
      <div className="ovbig">
        <b>{share(counts.rep, total)}</b>
        <span>replayed from a recording, for $0</span>
      </div>
      <div className="segbar" role="img" aria-label={rows.map((r) => `${r.share} ${ORIGIN_NAME[r.origin]}`).join(', ') || 'no calls this week'}>
        {rows.map((r) => (
          <i key={r.origin} className={r.origin} style={{ flex: r.count }} />
        ))}
      </div>
      <ul className="oleg">
        {rows.map((r) => (
          <li key={r.origin}>
            <i className={r.origin} />
            <span>{ORIGIN_NAME[r.origin]}</span>
            <em>{r.share}</em>
            <b>{num(r.count)}</b>
          </li>
        ))}
      </ul>
      {total === 0 ? <p className="leaknote">No calls this week yet.</p> : null}
    </Part>
  );
}

/** Live model calls where the prompt cache stopped hitting: the Context view's rule, across every run. */
function CachePart({ cache }: { cache: CacheUse }) {
  const pct = cache.readShare === null ? null : share(cache.readShare, 1);
  const box = useRef<HTMLDivElement>(null);
  const aboutOf = useAbouts();
  // j and k walk the misses after Recent runs, while Usage is open; Enter opens the call's context.
  const inFocus = useListKeys({ rows: cache.misses, keyOf: (m) => `${m.runId}#${m.callNo}`, root: box, open: (m) => navigate(href.run(m.runId, m.callNo, 'context')) });
  return (
    <Part title="Prompt cache" sub="live model calls, this week">
      <div className="ovbig">
        <b>{pct ?? '—'}</b>
        <span>{pct === null ? 'no live model calls this week' : 'of input read from the cache'}</span>
      </div>
      <div className="segbar" role="img" aria-label={pct === null ? 'no live model calls' : `${pct} read from the cache`}>
        {cache.input ? (
          <>
            {cache.cacheRead ? <i className="cread" style={{ flex: cache.cacheRead }} /> : null}
            {cache.input > cache.cacheRead ? <i className="pend" style={{ flex: cache.input - cache.cacheRead }} /> : null}
          </>
        ) : (
          <i className="pend" style={{ flex: 1 }} />
        )}
      </div>
      {cache.misses.length ? (
        <>
          <div className="leakh">
            <span>Where it stopped hitting</span>
            <b>{ktok(cache.sentAgain)} tokens sent again</b>
          </div>
          <div className="leaks" ref={box}>
            {cache.misses.map((m) => {
              const g = kindGlyph(m.kind);
              const key = `${m.runId}#${m.callNo}`;
              const id = shortId(m.runId);
              const about = aboutOf(id);
              // The run's about line on its id's hover; the model and the tokens only for a run the dashboard hasn't listed.
              return (
                <a key={key} className={inFocus === key ? 'krow' : undefined} data-rowkey={key} href={href.run(m.runId, m.callNo, 'context')} title={about ? undefined : `${m.model ? `${m.model} · ` : ''}${num(m.tokens)} tokens sent again`}>
                  <Glyph kind={g.kind} label={g.label} className="ri" />
                  <Id id={id} list about={about} />
                  <span>
                    #{m.callNo}
                    {m.scope ? ` · ${m.scope}` : ''}
                  </span>
                  <b>{ktok(m.tokens)}</b>
                </a>
              );
            })}
          </div>
          <p className="leaknote">
            <span className="ln">Usually a change in the prompt.</span> <span className="ln">The run’s Context view shows where.</span>
          </p>
        </>
      ) : (
        <p className="leaknote">{pct === null ? 'Live model calls that report the cache show here.' : 'The cache hit on every live call after the first.'}</p>
      )}
    </Part>
  );
}

const isView = (v: string): v is 'chart' | 'table' => v === 'chart' || v === 'table';

/** Two measures in one unit, as grouped bars on one axis: the live colour for spent, the replayed one for not re-spent. */
function SpendPart({ daily }: { daily: readonly DaySums[] }) {
  const [view, setView] = useStored('shadowlap-overview-daily', 'chart', isView);
  return (
    <Part
      title="Spend per day"
      className="uspend"
      sub={<>live and {glossed('not re-spent')}, last 7 days</>}
      actions={
        <Seg
          label="Show as"
          items={[
            { key: 'chart', label: 'Chart' },
            { key: 'table', label: 'Table' },
          ]}
          value={view}
          onChange={setView}
        />
      }
    >
      {view === 'table' ? <DailyTable daily={daily} /> : <DailyChart daily={daily} />}
    </Part>
  );
}

/** A day under its bars: `Oct 13`, then `14` with its month hidden on a phone where the day before had the same month. */
function DayLabel({ day, before }: { day: string; before: string | undefined }) {
  const text = dayText(day);
  const [month, n] = text.split(' ');
  if (!before || !n || dayText(before).split(' ')[0] !== month) return <span>{text}</span>;
  return (
    <span>
      <span className="xm">{month} </span>
      {n}
    </span>
  );
}

function DailyChart({ daily }: { daily: readonly DaySums[] }) {
  const { max, ticks } = chartScale(daily.flatMap((d) => [d.spent, d.notRespent]));
  const h = (v: number) => `${Math.min(100, (v / max) * 100)}%`;
  return (
    <>
      <div className="legend dlegend">
        <span>
          <i className="lc-spent" />
          spent live
        </span>
        <span>
          <i className="lc-saved" />
          not re-spent
        </span>
      </div>
      <div className="ybars">
        <div className="yaxis">
          {ticks.map((t) => (
            <span key={t} style={{ bottom: h(t) }}>
              {tickText(t, ticks[1]!)}
            </span>
          ))}
        </div>
        <div className="plot">
          {ticks.map((t) => (
            <span key={t} className={`gl${t ? '' : ' base'}`} style={{ bottom: h(t) }} />
          ))}
          <div className="groups">
            {daily.map((d) => (
              <div
                key={d.day}
                className="grp"
                data-tip={tipCard(dayText(d.day, true), [
                  { label: 'spent live', value: money(d.spent), color: 'var(--c-spent)' },
                  { label: 'not re-spent', value: money(d.notRespent), color: 'var(--c-saved)' },
                ])}
              >
                <i className="bar-spent" style={{ height: h(d.spent) }} />
                <i className="bar-saved" style={{ height: h(d.notRespent) }} />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="xlabels">
        {daily.map((d, i) => (
          <DayLabel key={d.day} day={d.day} before={daily[i - 1]?.day} />
        ))}
      </div>
    </>
  );
}

function DailyTable({ daily }: { daily: readonly DaySums[] }) {
  return (
    <table className="t daytable">
      <thead>
        <tr>
          <th>Day</th>
          <th className="num">Spent live</th>
          <th className="num">Not re-spent</th>
        </tr>
      </thead>
      <tbody>
        {daily.map((d) => (
          <tr key={d.day}>
            <td>{dayText(d.day, true)}</td>
            <td className="num">{money(d.spent)}</td>
            <td className="num">{money(d.notRespent)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
