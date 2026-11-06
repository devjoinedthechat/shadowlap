import { Fragment, useRef } from 'react';
import { ApiError } from '../api.js';
import { CodeBox } from '../components/CodeBox.js';
import { Words } from '../components/Copy.js';
import { Link } from '../components/Link.js';
import { Section } from '../components/Section.js';
import { EmptyLine, ErrorState, Skeleton } from '../components/States.js';
import { Status, statusTone } from '../components/Status.js';
import { rowOpen } from '../components/Table.js';
import { glossed } from '../components/Term.js';
import { VerdictLine } from '../components/VerdictLine.js';
import { minuteStamp } from '../format.js';
import { useLoad } from '../hooks.js';
import { useListKeys } from '../list-keys.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { Unshown } from '../shell/unshown.js';
import { useApp } from '../state.js';
import type { PreviewVerdict, VerdictGolden, VerdictRevision } from '../types.js';
import { leadFacts, leadIsOpen, rowTone, verdictHref } from './model.js';

/**
 * A revision's page under Changes › Verdicts: the verdict its test session gave, each golden as that
 * session judged it, worst first, with its note in Tests' words, the previews asked at the very same
 * revision, and the command that gave the verdict. Open Tests is the page's lime while the newest
 * revision failed or couldn't decide. A revision no session checked says so, with the way back.
 */
export function RevisionPage({ rev }: { rev: string }) {
  const { client, runsTick, feeds } = useApp();
  const loaded = useLoad(() => client.verdictRevision(rev), `verdict:${rev}`, `${runsTick}:${feeds.tests ?? 0}:${feeds.decisions ?? 0}`);
  if (loaded.error && !loaded.data) {
    if (loaded.error instanceof ApiError && loaded.error.status === 404)
      return (
        <div className="empty tall">
          <Unshown at={`changes:${rev}`} />
          No change <code>{rev}</code>. <Link href={href.changes()}>Open Verdicts</Link>
        </div>
      );
    return <ErrorState retry={loaded.reload}>{loaded.error instanceof ApiError ? `The dashboard server answered ${loaded.error.status} for this page’s data.` : loaded.error.message}</ErrorState>;
  }
  if (!loaded.data) return <Skeleton what="this change" lines={8} />;
  const page = loaded.data;
  return (
    <>
      <Verdict page={page} />
      <div className="grid2 secs">
        <Goldens goldens={page.goldens} />
        <Section title="Decisions" sub="the previews asked at this revision">
          {page.decisions.length ? <Decisions rows={page.decisions} /> : <EmptyLine>No preview asked at this revision.</EmptyLine>}
        </Section>
      </div>
      <CodeBox command={page.row.command} className="chcmd" />
    </>
  );
}

/** Its verdict: the tally and the golden that leads it, with its note; the revision, the change, who and when; Open Tests. */
function Verdict({ page }: { page: VerdictRevision }) {
  const { row, lead } = page;
  return (
    <VerdictLine
      word={row.word}
      tone={rowTone(row.tone)}
      facts={
        <>
          {row.revision ? <code>{row.revision}</code> : 'no revision'}
          {leadFacts(row, minuteStamp(row.at)).map((f, i) => (
            <Fragment key={i}>
              {' · '}
              <Words glued={false}>{f}</Words>
            </Fragment>
          ))}
        </>
      }
      actions={
        <a className={page.latest && leadIsOpen(row) ? 'btn sm lime' : 'btn sm'} href={href.tests()}>
          Open Tests
        </a>
      }
    >
      <span className="nw">{row.line}</span>
      {lead ? (
        <>
          {' · '}
          <span className="nw">{lead.name}</span> <Words>{lead.note}</Words>
        </>
      ) : null}
    </VerdictLine>
  );
}

/** Where a golden's row leads: the replay that judged it while the store has it, else Tests. */
const goldenHref = (g: VerdictGolden) => (g.runId ? href.run(g.runId) : href.tests());

function Goldens({ goldens }: { goldens: readonly VerdictGolden[] }) {
  const box = useRef<HTMLDivElement>(null);
  // Rows can lead to one place (Tests), so each is known by its golden.
  const inFocus = useListKeys({ rows: goldens, keyOf: (g) => g.golden, root: box, open: (g) => navigate(goldenHref(g)) });
  return (
    <Section title="Goldens" sub="as this session judged them">
      <div className="tscroll" ref={box}>
        <table className="t fit vdg">
          <tbody>
            {goldens.map((g) => (
              <tr key={g.golden} className={inFocus === g.golden ? 'krow' : undefined} data-rowkey={g.golden} {...rowOpen(() => navigate(goldenHref(g)))}>
                <td>
                  <code>
                    <a className="rowa" href={goldenHref(g)}>
                      {g.name}
                    </a>
                  </code>
                </td>
                <td>
                  <Status tone={statusTone(g.verdict)}>{g.verdict}</Status>
                  <span className="rsub">{glossed(g.note)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/** The previews and migrations asked at this revision, newest first: each its change and when, its verdict in its command's words. */
function Decisions({ rows }: { rows: readonly PreviewVerdict[] }) {
  return (
    <div className="tscroll">
      <table className="t fit vdg">
        <tbody>
          {rows.map((d) => {
            const to = verdictHref(d);
            return (
              <tr key={d.id} className={to ? undefined : 'still'} {...(to ? rowOpen(() => navigate(to)) : {})}>
                <td>
                  {to ? (
                    <a className="rowa" href={to}>
                      <Words>{d.title}</Words>
                    </a>
                  ) : (
                    <Words>{d.title}</Words>
                  )}
                  <span className="rsub">
                    {d.kind} · {minuteStamp(d.at)}
                  </span>
                </td>
                <td>
                  <Status tone={rowTone(d.tone)}>{d.word}</Status>
                  <span className="rsub">{d.line}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
