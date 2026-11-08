import { Fragment, useId, useRef, type ReactNode } from 'react';
import { Icon } from '../components/Icon.js';
import { Id } from '../components/Id.js';
import { Glyph, RunIcon } from '../components/RunIcon.js';
import { Status } from '../components/Status.js';
import { ShowMore } from '../components/Table.js';
import { Whole } from '../fixes/parts.js';
import { RunBlameButton } from '../fixes/RunBlame.js';
import { rungStatus } from '../fixes/rung-status.js';
import { shortId, whenShort } from '../format.js';
import { useListKeys, type RowScope } from '../list-keys.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import type { RunLike } from '../runs.js';
import type { Issue, IssueRun } from '../types.js';
import { countName, firstPart, issueGlyph, issueHref, laterParts } from './issues.js';
import { RowStatus } from './RunsTable.js';

/*
 * Runs › Failed as issues (FailedIssues.tsx reads them): a row an issue, its title the link to where
 * it is dealt with, the line under it saying what failed and where, its count the button that shows
 * its runs under it, when it was first and last seen, and its fix's place on the ladder with the step
 * it leads with at the column's end, so the steps line up. The row itself stays still: each of its
 * parts goes somewhere of its own. On a phone an issue is a block (runs.css).
 */

/** An issue's runs past those its read carried, and where the next ask starts. */
export interface MoreRuns {
  runs: readonly IssueRun[];
  more: string | null;
}

/** A run under an issue, as its icon and Status read it: an issue's runs carry no totals, which neither draws. */
const asRun = (r: IssueRun): RunLike => ({ ...r, spent: 0, saved: 0, captured: 0 });

/** What a step that only opens a page says, where the issue leads with none of its own: Open run, Open Tests. */
function openStep(x: Issue): { label: string; to: string } | null {
  if (x.kind === 'test') return { label: 'Open Tests', to: href.tests() };
  return x.stepRun ? { label: 'Open run', to: href.run(x.stepRun) } : null;
}

/** The step an issue leads with: Run blame on the run it names, a link (Open fix, a capture's Run blame, which only its page can ask), or the page that leads with it. */
function IssueStep({ x }: { x: Issue }) {
  const s = x.step;
  if (s?.key === 'blame' && !s.capture && x.stepRun) return <RunBlameButton runId={x.stepRun} offer={s.offer} className="btn sm" {...(s.sub ? { tip: s.sub } : {})} {...(s.command ? { line: s.command } : {})} />;
  if (s?.key === 'blame' && x.stepRun) return <a className="btn sm" href={href.run(x.stepRun)} title="Its page asks for your command, then blames it">{s.label}</a>;
  if (s?.href) return <a className="btn sm" href={s.href} {...(s.title ? { title: s.title } : {})}>{s.label}</a>;
  // A golden's step or a run's (Update golden, Find breaking commit, …) is taken where it leads, on Tests or on the run's page, as is an issue's that leads with none.
  const o = openStep(x);
  return o ? (
    <a className="btn sm" href={o.to}>
      {o.label}
    </a>
  ) : null;
}

/** The fix's place on the ladder and how many of its runs nobody has blamed, or a golden's `passed` once it passed again. */
function IssueStatus({ x }: { x: Issue }) {
  if (x.fix) {
    const st = rungStatus(x.fix);
    return (
      <span className="isst">
        <Status tone={st.tone}>{st.text}</Status>
        {x.notBlamed ? <span className="isnb">· {x.notBlamed.toLocaleString('en-US')} not blamed</span> : null}
      </span>
    );
  }
  if (x.golden?.passed) {
    return (
      <span className="isst">
        <Status tone="ok">passed</Status>
      </span>
    );
  }
  return null;
}

/** The line under the title: what failed or how it was judged, where it was planted or lost, how many came from production, then its newest run. */
function IssueLine({ x }: { x: Issue }) {
  const first = firstPart(x);
  const parts: ReactNode[] = [];
  if (first && 'failed' in first) {
    parts.push(
      <>
        Failed: <Whole text={first.failed} />
      </>,
    );
  } else if (first) parts.push(first.text.length <= 36 ? <span className="nw">{first.text}</span> : first.text);
  for (const p of laterParts(x)) parts.push(<span className="nw">{p}</span>);
  parts.push(
    <span className="nw">
      newest <Id id={shortId(x.newest.runId)} about={x.newest.about?.text ?? null} />
    </span>,
  );
  return (
    <span className="rsub">
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i ? ' · ' : null}
          {p}
        </Fragment>
      ))}
    </span>
  );
}

/** An issue's runs, newest first, each a link to its page; past those its read carried, Show more asks for the next. */
function IssueRuns({ x, id, now, more, onMore }: { x: Issue; id: string; now: number; more: MoreRuns | undefined; onMore: (x: Issue, after: string) => void }) {
  const runs = more ? [...x.runs, ...more.runs] : x.runs;
  const next = more ? more.more : x.more;
  return (
    <div className="isruns" id={id}>
      {runs.map((r) => (
        <a key={r.runId} className="isr" href={href.run(r.runId)}>
          <RunIcon run={asRun(r)} />
          <code>{shortId(r.runId)}</code>
          <span className="rab">{r.about?.text ?? r.command}</span>
          <RowStatus r={asRun(r)} />
          <span className="w">{whenShort(r.startedAt, now)}</span>
        </a>
      ))}
      {next ? <ShowMore shown={runs.length} total={x.count} onMore={() => onMore(x, next)} /> : null}
    </div>
  );
}

function IssueRow({ x, open, focused, now, more, onToggle, onMore }: { x: Issue; open: boolean; focused: boolean; now: number; more: MoreRuns | undefined; onToggle: (x: Issue) => void; onMore: (x: Issue, after: string) => void }) {
  const runsId = useId();
  const g = issueGlyph(x);
  const n = x.count;
  return (
    <>
      <tr className={`iss still${open ? ' open' : ''}${focused ? ' krow' : ''}`} data-rowkey={x.key} role="row">
        <td className="isw" role="cell">
          <span className="it">
            <Glyph kind={g.kind} label={g.label} className="ic" />
            <a href={issueHref(x)}>
              {x.golden ? (
                <>
                  <code className="gn">{x.golden.name}</code> {x.golden.did}
                </>
              ) : (
                x.title
              )}
            </a>
          </span>
          <IssueLine x={x} />
        </td>
        <td className="num" role="cell">
          <button type="button" className="xbtn isn" aria-expanded={open} aria-controls={open ? runsId : undefined} aria-label={countName(n, open)} onClick={() => onToggle(x)}>
            {n.toLocaleString('en-US')}
            <span className="phw">&nbsp;{n === 1 ? 'run' : 'runs'}</span>
            <Icon name="caret" />
          </button>
        </td>
        <td className="num hide-sm" role="cell">
          {whenShort(x.first, now)}
        </td>
        <td className="num" role="cell">
          <span className="phw">last </span>
          {whenShort(x.last, now)}
        </td>
        <td className="isfix" role="cell">
          <span className="isfx">
            <IssueStatus x={x} />
            <IssueStep x={x} />
          </span>
        </td>
      </tr>
      {open ? (
        <tr className="sub still" role="row">
          <td colSpan={5} role="cell">
            <IssueRuns x={x} id={runsId} now={now} more={more} onMore={onMore} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** ⌘K on an issue: Open, Show or Hide its runs, and its step where it starts something from here. */
function issueScope(x: Issue, open: boolean, toggle: (x: Issue) => void): RowScope {
  const to = issueHref(x);
  return {
    name: x.golden ? `${x.golden.name} ${x.golden.did}` : (x.title ?? x.failed),
    items: (step) => {
      const s = x.step;
      // A step that only goes somewhere is Open's twin, or a link: it isn't offered twice.
      const starts = s && x.stepRun && !s.href && !(s.key === 'blame' && s.capture) ? (step?.(x.stepRun, s) ?? null) : null;
      return [{ label: 'Open', hint: to, run: () => navigate(to) }, { label: open ? 'Hide its runs' : 'Show its runs', hint: countName(x.count, open), run: () => toggle(x) }, ...(starts ? [starts] : [])];
    },
  };
}

/** The issues, in the order of their newest run, with the keys a list takes: j and k, Enter on a title, ⌘K on a row. */
export function IssuesTable({ issues, open, now, more, onToggle, onMore }: { issues: readonly Issue[]; open: ReadonlySet<string>; now: number; more: ReadonlyMap<string, MoreRuns>; onToggle: (x: Issue) => void; onMore: (x: Issue, after: string) => void }) {
  const box = useRef<HTMLTableElement | null>(null);
  const inFocus = useListKeys({ rows: issues, keyOf: (x) => x.key, root: box, open: (x) => navigate(issueHref(x)), actions: (x) => issueScope(x, open.has(x.key), onToggle) });
  return (
    // Its roles said outright: a phone draws its rows as blocks (runs.css), which can cost a table them.
    <table className="t issues" ref={box} aria-label="Issues" role="table">
      <thead>
        <tr>
          <th scope="col">Issue</th>
          <th scope="col" className="num">
            Runs
          </th>
          <th scope="col" className="num hide-sm">
            First seen
          </th>
          <th scope="col" className="num">
            Last seen
          </th>
          <th scope="col" className="isfix">
            Fix
          </th>
        </tr>
      </thead>
      <tbody role="rowgroup">
        {issues.map((x) => (
          <IssueRow key={x.key} x={x} open={open.has(x.key)} focused={inFocus === x.key} now={now} more={more.get(x.key)} onToggle={onToggle} onMore={onMore} />
        ))}
      </tbody>
    </table>
  );
}
