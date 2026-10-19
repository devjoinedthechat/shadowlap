import { memo, useState } from 'react';
import { DeltaPill, Kpi, Legend, Seg } from '../components/bits.js';
import { tipCard } from '../components/HoverCard.js';
import { EventIcon, Glyph } from '../components/RunIcon.js';
import { useStored } from '../hooks.js';
import { cents, clock, ktok, money, num, plural, shortId, whenShort } from '../format.js';
import { ORIGIN_CODE, ORIGIN_COLOR, ORIGIN_NAME } from '../origins.js';
import { href } from '../route.js';
import type { ActivityItem, CacheUse, DaySums, FixesFunnel, GridFamily, GridRow, LiveRun, NeedsLookRow, OverviewSummary, RunGrid, TodayPanel as Today } from '../types.js';
import { activityGlyph, activityLine, blameWords, chartScale, dayText, kindGlyph, needsLookShown, originCounts, originRows, personName, reproducedNote, share, SHOW_ORIGINS, spentNote, testsKpi, tickText, todayTestsLine, verifiedNote } from './model.js';

/**
 * The Overview's panels, as the mock draws them: the outcome strip, this week's runs as rows of
 * calls, Needs a look, Today, Calls by origin, the prompt cache, the fixes funnel, what was spent and
 * not re-spent per day, and the activity feed. Each takes its part of the server's summary.
 */

// ---------------------------------------------------------------------------------------------- outcomes

/** Outcomes lead; what replaying saved sits next to what was spent, as the price of those outcomes. */
export function Outcomes({ o, now }: { o: OverviewSummary['outcomes']; now: number }) {
  const tests = testsKpi(o.testsPassing, now);
  const t = o.testsPassing;
  return (
    <div className="panel kstrip">
      <Kpi k="Failures reproduced" value={num(o.reproduced.value)} pill={<DeltaPill now={o.reproduced.value} then={o.reproduced.lastWeek} format={num} />} note={reproducedNote(o.reproduced)} href={href.fixes()} />
      <Kpi k="Fixes verified" value={num(o.fixesVerified.value)} tone="lime" pill={<DeltaPill now={o.fixesVerified.value} then={o.fixesVerified.lastWeek} format={num} good="up" />} note={verifiedNote(o.fixesVerified)} href={href.fixes()} />
      <Kpi k="Tests passing" value={tests.value} tone={tests.failing ? 'err' : ''} pill={t && t.goldens && t.lastWeek !== null ? <DeltaPill now={t.passing} then={t.lastWeek} format={num} good="up" /> : null} note={tests.note} href={href.tests()} />
      <Kpi k="Spent live" value={cents(o.spent.value)} pill={<DeltaPill now={o.spent.value} then={o.spent.lastWeek} format={cents} good="down" />} note={spentNote(o.spent)} />
    </div>
  );
}

/** Watch live, with a call count that goes up as calls arrive. */
export function WatchLive({ runId, command, calls }: { runId: string; command: string; calls: number }) {
  return (
    <a className="livebtn" href={href.run(runId)} title={`Recording ${shortId(runId)} · ${command}`}>
      <span className="pulse" aria-hidden="true" />
      <span className="lt">Watch live</span>
      <span className="lc">{plural(calls, 'call')}</span>
    </a>
  );
}

// ---------------------------------------------------------------------------------------------- this week's runs

/** One row's cells on its family's scale: its calls (a cell a range past 60 calls), a pulsing one for a recording's next call, then empty ones. */
function GridCells({ row, family, live }: { row: GridRow; family: GridFamily; live: boolean }) {
  const cells: Array<{ cls: string }> = [];
  for (let i = 0; i < family.cols; i++) {
    const code = row.cells[i];
    const origin = code ? ORIGIN_CODE[code] : undefined;
    const fork = row.forkCell === i;
    if (origin) cells.push({ cls: `${origin}${fork ? ' fk' : ''}` });
    else if (live && i === row.cells.length) cells.push({ cls: 'pend nextcell' });
    else cells.push({ cls: fork ? 'fk' : '' });
  }
  return (
    <span className="gs" style={{ gridTemplateColumns: `repeat(${Math.max(1, family.cols)}, minmax(0, 1fr))` }} aria-hidden="true">
      {cells.map((c, i) => (
        <i key={i} className={c.cls || undefined} />
      ))}
    </span>
  );
}

const GridFamilyRows = memo(function GridFamilyRows({ family, now }: { family: GridFamily; now: number }) {
  return (
    <div className="gfam">
      {family.rows.map((r) => {
        const live = r.status === 'running';
        const g = kindGlyph(r.kind, { failed: r.failed, live });
        // Interrupted (stopped before it ended, failing nothing else): said in grey, as on the run's page and in Runs.
        const cut = r.status === 'crashed' && !r.failed ? ' · interrupted' : '';
        const counts = originCounts(r.origins);
        const rows = SHOW_ORIGINS.filter((o) => counts[o]).map((o) => ({ label: ORIGIN_NAME[o], value: num(counts[o]), color: ORIGIN_COLOR[o] }));
        const tip = tipCard(`${shortId(r.runId)} · ${r.label}${cut}${r.context ? ' · before this week' : ''}`, rows.length ? rows : [{ label: 'calls', value: num(r.calls) }]);
        return (
          <a key={r.runId} className={`grow${r.context ? ' ctx' : ''}`} href={href.run(r.runId)} data-tip={tip}>
            <span className="gid" style={{ paddingLeft: r.depth * 14 }}>
              <Glyph kind={g.kind} label={cut ? `${g.label}, interrupted` : g.label} className="ri" />
              <code>{shortId(r.runId)}</code>
            </span>
            <GridCells row={r} family={family} live={live} />
            <span className="gw">{live ? 'now' : whenShort(r.startedAt, now)}</span>
          </a>
        );
      })}
    </div>
  );
});

/** Every run this week as a row of calls coloured by origin, grouped under the recording it came from. */
export function WeekGrid({ grid, now }: { grid: RunGrid; now: number }) {
  const counts = originCounts(grid.origins);
  const present = SHOW_ORIGINS.filter((o) => counts[o] > 0);
  return (
    <section className="panel ovgrid">
      <header>
        <h2>This week’s runs</h2>
        <span className="sub">every call, by what happened to it</span>
        <span className="sp" />
        <a className="more" href={href.runs()}>
          All runs
        </a>
      </header>
      <div className="pbody">
        <div className="gtop">
          <div className="ovbig">
            <b>{num(grid.calls)}</b>
            <span>calls in {plural(grid.runs, 'run')}</span>
          </div>
          {present.length ? <Legend origins={present} /> : null}
        </div>
        {grid.families.length === 0 ? <div className="empty">No runs this week. The newest are on Runs.</div> : null}
        {grid.families.map((f) => (
          <GridFamilyRows key={f.rows[0]!.runId} family={f} now={now} />
        ))}
      </div>
      {grid.more > 0 ? (
        <a className="attn-more" href={href.runs()}>
          {plural(grid.more, 'more run')} this week on Runs
        </a>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------- needs a look

/** Most urgent first; three, then "Show N more". A recording in progress shows under Today instead. */
export function NeedsLook({ items, total }: { items: readonly NeedsLookRow[]; total: number }) {
  const [open, setOpen] = useState(false);
  const shown = needsLookShown(items, open);
  return (
    <section className="panel needs">
      <header>
        <h2>Needs a look</h2>
        <span className="sub">{num(total)}</span>
      </header>
      <div className="attn">
        {total === 0 ? <div className="empty">Nothing needs a look.</div> : null}
        {shown.rows.map((x) => (
          <a key={`${x.kind}:${x.fixId ?? x.runId ?? x.title}`} href={x.href}>
            <EventIcon kind={x.icon} />
            <span>
              <span className="t">{x.title}</span>
              <span className="d" title={x.detail}>
                {x.detail}
              </span>
            </span>
            <span className="go">{x.action} →</span>
          </a>
        ))}
        {shown.more ? (
          <button className="attn-more" type="button" onClick={() => setOpen(!open)}>
            {shown.more}
          </button>
        ) : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------- today

function outcomeWords(o: { kind: string; callNo?: number }): string {
  if (o.kind === 'diverged' && o.callNo) return `diverged at #${o.callNo}`;
  if (o.kind === 'lost' && o.callNo) return `lost at #${o.callNo}`;
  if (o.kind === 'check-failed') return 'check failed';
  if (o.kind === 'inconclusive') return 'inconclusive';
  return 'failed';
}

/** What ran today: one line each, with a count or a status on the right. */
export function TodayCard({ today, live }: { today: Today; live: readonly LiveRun[] }) {
  const tests = today.tests;
  const blamed = today.blame.runs[0];
  return (
    <section className="panel ovtoday">
      <header>
        <h2>Today</h2>
        <span className="sub">{dayText(today.day)}</span>
      </header>
      <div className="pbody">
        <div className="ovbig">
          <b>{num(today.served)}</b>
          <span>
            calls served from recordings · <em>{cents(today.notRespent)}</em> not re-spent
          </span>
        </div>
      </div>
      <div className="attn">
        {today.recording.map((r) => {
          const calls = live.find((l) => l.runId === r.runId)?.calls ?? r.calls;
          return (
            <a key={r.runId} href={href.run(r.runId)}>
              <EventIcon kind="live" live />
              <span>
                <span className="t">
                  Recording <code>{shortId(r.runId)}</code>
                </span>
                <span className="d cmd" title={r.command}>
                  {r.command}
                </span>
              </span>
              <span className="go">
                <span className="now">{plural(calls, 'call')}…</span>
              </span>
            </a>
          );
        })}
        <a href={href.runs()}>
          <EventIcon kind="clean" />
          <span>
            <span className="t">Replays</span>
            <span className="d">{today.replays ? 'every call matched the recording' : 'none yet today'}</span>
          </span>
          <span className="go">{num(today.replays)} today</span>
        </a>
        <a href={href.runs()}>
          <EventIcon kind="fork" />
          <span>
            <span className="t">Forks</span>
            <span className="d">{today.forks.count ? `${plural(today.forks.live, 'call')} went live · ${plural(today.forks.blocked, 'write')} blocked` : 'none yet today'}</span>
          </span>
          <span className="go">{num(today.forks.count)} today</span>
        </a>
        <a href={tests.latestFailure ? href.run(tests.latestFailure.runId) : href.tests()}>
          <EventIcon kind={todayTestsLine(tests, tests.latestFailure ? outcomeWords(tests.latestFailure.outcome) : null).icon} />
          <span>
            <span className="t">Tests</span>
            <span className="d">{todayTestsLine(tests, tests.latestFailure ? outcomeWords(tests.latestFailure.outcome) : null).text}</span>
          </span>
          <span className="go">{num(tests.count)} today</span>
        </a>
        {today.blame.probes && blamed ? (
          <a href={blamed.fixId ? href.fixes(blamed.fixId, 'blame') : href.run(blamed.runId)}>
            <EventIcon kind="blame" />
            <span>
              <span className="t">Blame</span>
              <span className="d">
                {blamed.title ? `${blamed.title.charAt(0).toLowerCase()}${blamed.title.slice(1)} · ` : `${shortId(blamed.runId)} · `}
                {blameWords(blamed)}
              </span>
            </span>
            <span className="go">{plural(today.blame.probes, 'probe')}</span>
          </a>
        ) : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------- calls by origin

export function OriginCard({ origins }: { origins: Readonly<Record<string, number>> }) {
  const counts = originCounts(origins);
  const rows = originRows(counts);
  const total = rows.reduce((t, r) => t + r.count, 0);
  return (
    <section className="panel ovc">
      <header>
        <h2>Calls by origin</h2>
        <span className="sub">this week</span>
        <span className="sp" />
        <a className="more" href={href.runs()}>
          Runs
        </a>
      </header>
      <div className="pbody">
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
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------- the prompt cache

/** Live model calls where the prompt cache stopped hitting: the Context view's rule, across every run. */
export function CacheCard({ cache }: { cache: CacheUse }) {
  const pct = cache.readShare === null ? null : Math.round(cache.readShare * 100);
  return (
    <section className="panel ovc">
      <header>
        <h2>Prompt cache</h2>
        <span className="sub">live model calls, this week</span>
      </header>
      <div className="pbody">
        <div className="ovbig">
          <b>{pct === null ? '—' : `${pct}%`}</b>
          <span>{pct === null ? 'no live model calls this week' : 'of input read from the cache'}</span>
        </div>
        <div className="segbar" role="img" aria-label={pct === null ? 'no live model calls' : `${pct}% read from the cache`}>
          {cache.input ? (
            <>
              {cache.cacheRead ? <i className="rep" style={{ flex: cache.cacheRead }} /> : null}
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
            <div className="leaks">
              {cache.misses.map((m) => {
                const g = kindGlyph(m.kind);
                return (
                  <a key={`${m.runId}#${m.callNo}`} href={href.run(m.runId, m.callNo, 'context')} title={`${m.model ? `${m.model} · ` : ''}${num(m.tokens)} tokens sent again`}>
                    <Glyph kind={g.kind} label={g.label} className="ri" />
                    <code>{shortId(m.runId)}</code>
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
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------- fixes

/** How far each failure got: blamed, a fix verified, the fix applied; and what the attempts behind them cost live. */
export function FixesCard({ fixes }: { fixes: FixesFunnel }) {
  const steps: Array<[string, number]> = [
    ['Failures', fixes.failures],
    ['Blamed', fixes.blamed],
    ['Fix verified', fixes.verified],
    ['Applied', fixes.applied],
  ];
  return (
    <section className="panel ovc">
      <header>
        <h2>Fixes</h2>
        <span className="sub">every failure so far</span>
        <span className="sp" />
        <a className="more" href={href.fixes()}>
          Fixes
        </a>
      </header>
      <div className="pbody">
        <div className="ovbig">
          <b>{num(fixes.open)} open</b>
          <span>{fixes.readyToApply ? `${plural(fixes.readyToApply, 'verified fix', 'verified fixes')} ready to apply` : 'nothing waiting to apply'}</span>
        </div>
        <div className="fsteps">
          {steps.map(([label, n]) => (
            <div className="fstep" key={label}>
              <span className="fb" style={{ width: `${fixes.failures ? (n / fixes.failures) * 100 : 0}%` }} />
              <span className="fl">{label}</span>
              <b>{num(n)}</b>
            </div>
          ))}
        </div>
        <p className="leaknote">
          <span className="ln">
            {plural(fixes.attempts, 'attempt')} behind these · {cents(fixes.spent)} spent live.
          </span>{' '}
          <span className="ln">Everything before each fork replayed free.</span>
        </p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------- spent per day

const isView = (v: string): v is 'chart' | 'table' => v === 'chart' || v === 'table';

/** Two measures in one unit, as grouped bars on one axis: lime for replayed (not re-spent), the live colour for spent. */
export function DailyCard({ daily }: { daily: readonly DaySums[] }) {
  const [view, setView] = useStored('shadowlap-overview-daily', 'chart', isView);
  return (
    <section className="panel">
      <header>
        <h2>Spent and not re-spent</h2>
        <span className="sub">per day, last 7 days</span>
        <span className="sp" />
        <Seg
          label="Show as"
          items={[
            { key: 'chart', label: 'Chart' },
            { key: 'table', label: 'Table' },
          ]}
          value={view}
          onChange={setView}
        />
      </header>
      <div className="pbody">{view === 'table' ? <DailyTable daily={daily} /> : <DailyChart daily={daily} />}</div>
    </section>
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
              {tickText(t)}
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
        {daily.map((d) => (
          <span key={d.day}>{dayText(d.day)}</span>
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
            <td className="num lime">{money(d.notRespent)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------------------------- activity

/**
 * The five latest entries of the activity feed; with a team store each names who did it. A recording
 * pulses while something records it (`live`, as the top bar's chip has it): the feed goes by the
 * run's stored status, which a killed recorder leaves at running.
 */
export function ActivityCard({ items, now, byPerson, live }: { items: readonly ActivityItem[] | null; now: number; byPerson: boolean; live: readonly LiveRun[] }) {
  const recording = new Set(live.map((l) => l.runId));
  return (
    <section className="panel">
      <header>
        <h2>Activity</h2>
        <span className="sub">latest</span>
      </header>
      <div className="feed">
        {items && !items.length ? <div className="empty">Nothing yet. Recordings, replays, forks, tests and fixes show here.</div> : null}
        {(items ?? []).map((a) => {
          const line = activityLine(a.text, a.runId ?? a.ref);
          return (
            <a key={a.id} href={a.href ?? (a.runId ? href.run(a.runId) : href.overview())}>
              <span className="at">{whenShortOrClock(a.at, now)}</span>
              <EventIcon kind={activityGlyph(a.kind)} live={!!a.live && !!a.runId && recording.has(a.runId)} />
              <span className="w">
                {byPerson && a.actor ? <b className="actor">{personName(a.actor)}</b> : null}
                {byPerson && a.actor ? ' ' : null}
                {line.text}
                {line.code ? <code>{line.code}</code> : null}
              </span>
            </a>
          );
        })}
      </div>
    </section>
  );
}

/** 10:14 today, Sep 30 before. */
function whenShortOrClock(at: number, now: number): string {
  const d = new Date(at);
  const t = new Date(now);
  return d.toDateString() === t.toDateString() ? clock(at) : whenShort(at, now);
}
