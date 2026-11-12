import { useId, useRef } from 'react';
import { DotNodes } from '../components/DotParts.js';
import { tipCard } from '../components/HoverCard.js';
import { Icon } from '../components/Icon.js';
import { Id } from '../components/Id.js';
import { Glyph, RunIcon } from '../components/RunIcon.js';
import { ErrorState } from '../components/States.js';
import { Status } from '../components/Status.js';
import { ShowMore } from '../components/Table.js';
import { Whole } from '../fixes/parts.js';
import { rungStatus } from '../fixes/rung-status.js';
import { shortId, whenShort } from '../format.js';
import { useListKeys, type RowScope } from '../list-keys.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import type { RunLike } from '../runs.js';
import { useApp } from '../state.js';
import { type LookWait, RunStep, runStepJob, stepWhy, useLookWaits } from '../steps/RunStep.js';
import type { Issue, IssueRun } from '../types.js';
import { type AskedRuns, countName, issueGlyph, issueHref, type LinePart, lineParts } from './issues.js';
import { RowStatus } from './RunsTable.js';

/*
 * Runs › Failed as issues (FailedIssues.tsx reads them): a row an issue, its title the link to where
 * it is dealt with, the line under it saying what failed and where, its count the button that shows
 * its runs under it, when it was first and last seen, and its fix's place on the ladder with the step
 * it leads with at the column's end, so the steps line up. The row itself stays still: each of its
 * parts goes somewhere of its own. On a phone an issue is a block (runs.css).
 */

/** What an issue's row takes beside the issue: whether it is open, the runs asked for it, and what its count, Show more and Retry do. */
interface RowProps {
  open: boolean;
  focused: boolean;
  now: number;
  wait: LookWait | null;
  asked: AskedRuns | undefined;
  onToggle: (x: Issue) => void;
  onMore: (x: Issue, after: string) => void;
  onRetry: (key: string) => void;
}

/** A run under an issue, as its icon and Status read it: an issue's runs carry no totals, which neither draws. */
const asRun = (r: IssueRun): RunLike => ({ ...r, spent: 0, saved: 0, captured: 0 });

/** What a step that only opens a page says, where the issue leads with none it takes from here: Open run, Open Tests. */
function openStep(x: Issue): { label: string; to: string } | null {
  if (x.kind === 'test') return { label: 'Open Tests', to: href.tests() };
  return x.stepRun ? { label: 'Open run', to: href.run(x.stepRun) } : null;
}

/** The job an issue's step starts from here, as a list's row takes it (steps/RunStep.tsx); null for one that opens a page. */
const stepJobOf = (x: Issue) => (x.step && x.stepRun && !x.step.href && !(x.step.key === 'blame' && x.step.capture) ? runStepJob(x.step) : null);

/**
 * The step an issue leads with, small and plain with no key, as Needs a look draws a run's: a job
 * its run's page leads with (Run blame, Add normalizer and re-run, Find breaking commit, …), priced
 * as the pointer or the focus reaches it; a link (Open fix; a capture's Run blame, which only its
 * page can ask, its card the row's sentence); or the page that leads with it.
 */
function IssueStep({ x, wait }: { x: Issue; wait: LookWait | null }) {
  const app = useApp();
  const s = x.step;
  if (s?.href) {
    return (
      <a className="btn sm" href={s.href} {...(s.title ? { title: s.title } : {})}>
        {s.label}
      </a>
    );
  }
  if (s?.key === 'blame' && s.capture && x.stepRun) {
    return (
      <a className="btn sm" href={href.run(x.stepRun)} {...(s.sub ? { 'data-tip': tipCard(s.label, [], s.sub) } : {})}>
        {s.label}
      </a>
    );
  }
  const run = stepJobOf(x);
  if (s && x.stepRun && run && wait && !app.actionsOff && !app.exported) return <RunStep s={{ runId: x.stepRun, step: s }} why={stepWhy(app.hasKind, run, wait)} />;
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

/** A part of the line, drawn: what failed kept whole where it can be, a golden's path or exit line as code, a run by its id. */
function partNode(p: LinePart) {
  switch (p.kind) {
    case 'failed':
      return (
        <>
          Failed: <Whole text={p.failed} />
        </>
      );
    case 'detail':
      return (
        <>
          {p.code ? <code>{p.code}</code> : null}
          {p.code && p.words ? ' ' : null}
          {p.words}
        </>
      );
    case 'words':
      return p.text;
    case 'newest':
      return (
        <>
          newest <Id id={shortId(p.runId)} about={p.about} />
        </>
      );
  }
}

/** The line under the title, its parts joined by dots as a receipt's are: each of 36 characters or fewer whole, and a dot never starting a line. */
function IssueLine({ x }: { x: Issue }) {
  return (
    <span className="rsub">
      <DotNodes parts={lineParts(x).map((p) => ({ text: p.text, node: partNode(p) }))} max={36} />
    </span>
  );
}

/**
 * An issue's runs, newest first, each a link to its page; past those its read carried (and the pages
 * Show more brought), Show more asks for the next. Where its read carried its count alone, the
 * loading line stands in for them until they come, or says why they couldn't be read.
 */
function IssueRuns({ x, id, now, asked, onMore, onRetry }: { x: Issue; id: string } & Pick<RowProps, 'now' | 'asked' | 'onMore' | 'onRetry'>) {
  if (!x.runs) {
    return (
      <div className="isruns" id={id} {...(asked?.error ? {} : { 'aria-busy': true })}>
        {asked?.error ? <ErrorState retry={() => onRetry(x.key)}>Its runs couldn’t be read: {asked.error}</ErrorState> : <div className="empty">Loading runs…</div>}
      </div>
    );
  }
  const next = x.more;
  return (
    <div className="isruns" id={id}>
      {x.runs.map((r) => (
        <a key={r.runId} className="isr" href={href.run(r.runId)}>
          <RunIcon run={asRun(r)} />
          <Id id={shortId(r.runId)} list />
          <span className="rab">{r.about?.text ?? r.command}</span>
          <RowStatus r={asRun(r)} />
          <span className="w">{whenShort(r.startedAt, now)}</span>
        </a>
      ))}
      {next ? <ShowMore shown={x.runs.length} total={x.count} onMore={() => onMore(x, next)} /> : null}
    </div>
  );
}

function IssueRow({ x, open, focused, now, wait, asked, onToggle, onMore, onRetry }: { x: Issue } & RowProps) {
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
            <IssueStep x={x} wait={wait} />
          </span>
        </td>
      </tr>
      {open ? (
        <tr className="sub still" role="row">
          <td colSpan={5} role="cell">
            <IssueRuns x={x} id={runsId} now={now} asked={asked} onMore={onMore} onRetry={onRetry} />
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

interface TableProps extends Pick<RowProps, 'now' | 'onToggle' | 'onMore' | 'onRetry'> {
  issues: readonly Issue[];
  open: ReadonlySet<string>;
  /** The newest runs asked for the open issues whose read carried their count alone, by key. */
  asked: ReadonlyMap<string, AskedRuns>;
}

/**
 * The issues, in the order of their newest run. A dashboard that runs jobs reads the server's jobs
 * once for every row whose step starts one (`useLookWaits`), as Needs a look does; one that runs
 * none reads none, and its steps open their pages.
 */
export function IssuesTable(props: TableProps) {
  const { actionsOff, exported } = useApp();
  const jobs = !actionsOff && !exported && props.issues.some((x) => stepJobOf(x));
  return jobs ? <WaitingTable {...props} /> : <Table {...props} wait={null} />;
}

function WaitingTable(props: TableProps) {
  const wait = useLookWaits();
  return <Table {...props} wait={wait} />;
}

/** The table, with the keys a list takes: j and k, Enter on a title, ⌘K on a row. */
function Table({ issues, open, asked, now, wait, onToggle, onMore, onRetry }: TableProps & { wait: LookWait | null }) {
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
          <IssueRow key={x.key} x={x} open={open.has(x.key)} focused={inFocus === x.key} now={now} wait={wait} asked={asked.get(x.key)} onToggle={onToggle} onMore={onMore} onRetry={onRetry} />
        ))}
      </tbody>
    </table>
  );
}
