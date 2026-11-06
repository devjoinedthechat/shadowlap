import { Fragment, useRef, useState } from 'react';
import { ApiError } from '../api.js';
import { Chips } from '../components/bits.js';
import { Words } from '../components/Copy.js';
import { Link } from '../components/Link.js';
import { EmptyLine, EmptyState, ErrorState, Skeleton } from '../components/States.js';
import { Status } from '../components/Status.js';
import { rowOpen, ShowMore } from '../components/Table.js';
import { VerdictLine } from '../components/VerdictLine.js';
import { minuteStamp } from '../format.js';
import { useLoad } from '../hooks.js';
import { useListKeys } from '../list-keys.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { useApp } from '../state.js';
import type { SessionVerdict, VerdictRow, VerdictsKind, VerdictsView } from '../types.js';
import { chipEmpty, kindLine, leadFacts, leadIsOpen, moreLimit, rowTone, titledByRevision, VERDICT_CHIPS, VERDICTS_STEP, verdictHref, type LinePart } from './model.js';

/**
 * Changes › Verdicts: every change checked before it shipped, and the verdict it got, one row each,
 * newest first: each revision a test session ran every golden at, each preview and migration, each
 * verify a fix keeps. The newest revision's verdict leads, as Tests' does. A verdict is said in the
 * words of the command that gave it (the API's); who made a change is named only where checks are
 * shared, through a team store.
 */

/** The chip and how far the list reads, kept while the page is open in this tab: back from a revision's page the list reads as far as it was left, so Esc finds its row. A new chip reads from the top. */
let kept: { chip: VerdictsKind; limit: number } = { chip: 'all', limit: VERDICTS_STEP };

/** What knows a row to the list keys: where it leads, else its own id. */
const rowKey = (row: VerdictRow) => verdictHref(row) ?? row.id;

export function VerdictsTab() {
  const { client, runsTick, feeds } = useApp();
  const [shown, setShown] = useState(kept);
  const show = (next: typeof kept) => {
    kept = next;
    setShown(next);
  };
  const { chip, limit } = shown;
  // The chip in the refresh, not the key: the rows stay until another chip's come. The answer says which chip and how many it is for.
  const loaded = useLoad(() => client.verdicts(chip, limit).then((view) => ({ chip, limit, view })), 'verdicts', `${chip}:${limit}:${runsTick}:${feeds.tests ?? 0}:${feeds.decisions ?? 0}:${feeds.fixes ?? 0}`);
  const failed = loaded.error ? <ErrorState retry={loaded.reload}>{failedWords(loaded.error)}</ErrorState> : null;
  if (!loaded.data) return failed ?? <Loading />;
  const { view } = loaded.data;
  if (view.counts.all === 0) return failed ?? <EmptyState title="No change checked yet" text="Each test session CI runs checks the change it was given, and each preview a change you might make. Their verdicts collect here, newest first." copy command="shadowlap test goldens/*" />;
  // A chip's read that failed leaves another chip's rows: the error stands in their place.
  const stale = loaded.data.chip !== chip;
  return (
    <>
      {view.lead ? <Lead lead={view.lead} /> : null}
      <div className="tbar">
        <Chips label="Kind of check" items={VERDICT_CHIPS.map((c) => ({ ...c, count: view.counts[c.key] }))} value={chip} onChange={(c) => show({ chip: c, limit: VERDICTS_STEP })} />
      </div>
      {failed && stale ? failed : <Rows view={view} chip={loaded.data.chip} limit={loaded.data.limit} onMore={(n) => show({ chip, limit: n })} />}
    </>
  );
}

/** What the page says when its data couldn't be read: the status the server answered, else what went wrong. */
const failedWords = (err: Error) => (err instanceof ApiError ? `The dashboard server answered ${err.status} for this page’s data.` : err.message);

/** The newest revision's verdict, whatever the chip: its revision and tally, the change, and the way into its page, lime while it failed or couldn't decide. */
function Lead({ lead }: { lead: SessionVerdict }) {
  return (
    <VerdictLine
      word={lead.word}
      tone={rowTone(lead.tone)}
      facts={leadFacts(lead, minuteStamp(lead.at)).join(' · ')}
      actions={
        <a className={leadIsOpen(lead) ? 'btn sm lime' : 'btn sm'} href={href.changes(lead.key)}>
          Open the change
        </a>
      }
    >
      <code>{lead.revision ?? 'no revision'}</code> · <span className="nw">{lead.line}</span>
    </VerdictLine>
  );
}

function Rows({ view, chip, limit, onMore }: { view: VerdictsView; chip: VerdictsKind; limit: number; onMore: (limit: number) => void }) {
  const box = useRef<HTMLElement>(null);
  // j and k walk the rows; Enter opens one that leads somewhere.
  const inFocus = useListKeys({
    rows: view.rows,
    keyOf: rowKey,
    root: box,
    open: (r) => {
      const to = verdictHref(r);
      if (to) navigate(to);
    },
  });
  if (!view.rows.length) return <EmptyLine>{chip === 'all' ? 'No change checked yet.' : <Parts parts={chipEmpty(chip)} />}</EmptyLine>;
  const next = moreLimit({ shown: view.rows.length, limit, count: view.counts[chip] });
  return (
    <>
      <section className="panel sec tscroll vdsec" ref={box}>
        <table className="t vdt">
          <thead>
            <tr>
              <th>Change</th>
              <th className="hide-sm">Checked on</th>
              <th className="hide-md">What moved</th>
              <th>Verdict</th>
              <th className="hide-sm">When</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r) => (
              <Row key={r.id} row={r} focused={inFocus === rowKey(r)} />
            ))}
          </tbody>
        </table>
      </section>
      {next !== null ? <ShowMore shown={view.rows.length} total={view.counts[chip]} onMore={() => onMore(next)} /> : view.more ? <p className="muted vdlocal">Older changes than these aren’t listed.</p> : null}
      {view.shared ? null : (
        <p className="muted vdlocal">
          This machine’s test sessions only: CI’s show here once it pushes them to a team store.{' '}
          <Link href={href.settings('store')} to>
            Team store
          </Link>
        </p>
      )}
    </>
  );
}

/** A part of a line: its words, then its code in the code face. */
function Part({ part }: { part: LinePart }) {
  return (
    <>
      {part.words ?? null}
      {part.words && part.code ? ' ' : null}
      {part.code ? <code>{part.code}</code> : null}
    </>
  );
}

/** A line in parts, a space between each: a sentence that names a command. */
function Parts({ parts }: { parts: readonly LinePart[] }) {
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i ? ' ' : null}
          <Part part={p} />
        </Fragment>
      ))}
    </>
  );
}

/** A row's kind line, each part kept whole, a revision in the code face. */
function KindLine({ parts }: { parts: readonly LinePart[] }) {
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i ? ' · ' : null}
          <span className="nw">
            <Part part={p} />
          </span>
        </Fragment>
      ))}
    </>
  );
}

/** A change: what it is and how it was checked, what moved, its verdict in its command's words, and when. One that leads nowhere yet (a preview's) is still. */
function Row({ row, focused }: { row: VerdictRow; focused: boolean }) {
  const to = verdictHref(row);
  const title = titledByRevision(row) ? <code>{row.title}</code> : <Words>{row.title}</Words>;
  return (
    <tr className={[to ? '' : 'still', focused ? 'krow' : ''].join(' ').trim() || undefined} data-rowkey={rowKey(row)} {...(to ? rowOpen(() => navigate(to)) : {})}>
      <td className="vdc">
        {to ? (
          <a className="rowa" href={to}>
            {title}
          </a>
        ) : (
          title
        )}
        <span className="rsub">
          <KindLine parts={kindLine(row)} />
        </span>
      </td>
      <td className="hide-sm">{row.checked}</td>
      <td className="hide-md vdm">
        {row.moved.map((m, i) => (
          <Fragment key={i}>
            {i ? <span className="sep"> · </span> : null}
            <span className="nw">{m}</span>
          </Fragment>
        ))}
      </td>
      <td className="vdv">
        <Status tone={rowTone(row.tone)}>{row.word}</Status>
        <span className="rsub">{row.line}</span>
      </td>
      <td className="hide-sm vdw">{minuteStamp(row.at)}</td>
    </tr>
  );
}

/** Loading: the lead, the chips and five rows in their final shape, as bars. */
function Loading() {
  return (
    <Skeleton what="the changes checked">
      <VerdictLine word="passed" tone="mu" facts="The change checked · when">
        no revision · 0 of 0 goldens passed
      </VerdictLine>
      <div className="tbar">
        <div className="chips">
          {VERDICT_CHIPS.map((c) => (
            <span key={c.key}>{c.label}</span>
          ))}
        </div>
      </div>
      <section className="panel sec tscroll vdsec">
        <table className="t vdt">
          <tbody>
            {[0, 1, 2, 3, 4].map((i) => (
              <tr key={i}>
                <td className="vdc">
                  A change that was checked
                  <span className="rsub">test session</span>
                </td>
                <td className="hide-sm">7 goldens</td>
                <td className="hide-md vdm">every golden held</td>
                <td className="vdv">
                  <span className="st mu">
                    <i />
                    passed
                  </span>
                  <span className="rsub">7 of 7 goldens passed</span>
                </td>
                <td className="hide-sm vdw">Oct 1, 10:00</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </Skeleton>
  );
}
