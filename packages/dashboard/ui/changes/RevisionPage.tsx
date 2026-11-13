import { Fragment, useRef, useState } from 'react';
import { ApiError } from '../api.js';
import { DecisionSteps, PrCommentDialog } from '../ci/comment-parts.js';
import { ActionButton } from '../components/ActionButton.js';
import { CodeBox } from '../components/CodeBox.js';
import { Words } from '../components/Copy.js';
import { Link } from '../components/Link.js';
import { Section } from '../components/Section.js';
import { EmptyLine, ErrorState, failedRead, Skeleton } from '../components/States.js';
import { Status } from '../components/Status.js';
import { statusTone } from '../components/status-tone.js';
import { rowOpen } from '../components/Table.js';
import { glossed } from '../components/Term.js';
import { DotLine } from '../components/Verdict.js';
import { VerdictLine } from '../components/VerdictLine.js';
import { goldenName, minuteStamp } from '../format.js';
import { useLoad } from '../hooks.js';
import { ACTIONS } from '../labels.js';
import { useListKeys } from '../list-keys.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { Unshown } from '../shell/unshown.js';
import { useApp } from '../state.js';
import type { KeptDecisions, PreviewVerdict, SessionCommentParts, VerdictGolden, VerdictRevision } from '../types.js';
import { leadFacts, leadIsOpen, rowTone, verdictHref } from './model.js';

/**
 * A revision's page under Changes › Verdicts: the verdict its test session gave, with the pull
 * request it ran for and, once that merged though the verdict didn't pass, the flag; each golden as
 * that session judged it, worst first, with its note in Tests' words; the decisions its pull request
 * comment carried, else the previews asked at the very same revision; what else the comment added
 * (a run's cost before and after, each injection gate), for a session that ran for a pull request;
 * and the command that gave the verdict. Open Tests is the page's lime while the newest revision
 * failed or couldn't decide, with Preview pull request comment beside it. A revision no session
 * checked says so, with the way back.
 */
export function RevisionPage({ rev }: { rev: string }) {
  const { client, runsTick, feeds } = useApp();
  const loaded = useLoad(() => client.verdictRevision(rev), `verdict:${rev}`, `${runsTick}:${feeds.tests ?? 0}:${feeds.decisions ?? 0}`);
  if (loaded.error && !loaded.data) {
    if (loaded.error instanceof ApiError && loaded.error.status === 404)
      return (
        <div className="empty tall">
          <Unshown at={`changes:${rev}`} />
          No change {rev}. <Link href={href.changes()}>Open Verdicts</Link>
        </div>
      );
    return <ErrorState retry={loaded.reload}>{failedRead(loaded.error)}</ErrorState>;
  }
  if (!loaded.data) return <Skeleton what="this change" lines={8} />;
  const page = loaded.data;
  return (
    <>
      <Verdict page={page} />
      <div className="grid2 secs">
        <Goldens goldens={page.goldens} />
        {page.comment?.decisions ? (
          <Section title="Decisions" sub={DECIDED}>
            <KeptSteps kept={page.comment.decisions} />
          </Section>
        ) : page.decisions.length ? (
          <Section title="Decisions" sub="the previews asked at this revision">
            <Decisions rows={page.decisions} />
          </Section>
        ) : (
          <Section title="Decisions" sub={DECIDED}>
            <EmptyLine>
              This session kept no preview of its prompt and tools. CI runs one on each pull request with the Action’s <code>decisions: true</code>.
            </EmptyLine>
          </Section>
        )}
      </div>
      {page.row.pullRequest && page.comment ? <OnThePullRequest comment={page.comment} /> : null}
      <CodeBox command={page.row.command} className="chcmd" />
    </>
  );
}

/** What a revision's Decisions says it holds, its comment having kept them. */
const DECIDED = 'what its prompt and tools decide differently';

/** Its verdict: the tally and the golden that leads it, with its note; the revision, the change, its pull request, who and when, then the flag; Preview pull request comment on the newest, then Open Tests. */
function Verdict({ page }: { page: VerdictRevision }) {
  const { row, lead } = page;
  return (
    <VerdictLine
      word={row.word}
      tone={rowTone(row.tone)}
      facts={
        <>
          {row.revision ? <code>{row.revision}</code> : 'no revision'}
          {leadFacts(row, minuteStamp(row.at), { pr: true }).map((f, i) => (
            <Fragment key={i}>
              {' · '}
              <Words glued={false}>{f}</Words>
            </Fragment>
          ))}
          {row.flag ? (
            <>
              {' · '}
              <span className="vdflag nw">{row.flag}</span>
            </>
          ) : null}
        </>
      }
      actions={
        <>
          {page.latest ? <PreviewComment /> : null}
          <a className={page.latest && leadIsOpen(row) ? 'btn sm lime' : 'btn sm'} href={href.tests()}>
            Open Tests
          </a>
        </>
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

/** Preview pull request comment, on the newest revision's page: the comment the newest session that ran every golden gives, this one. */
function PreviewComment() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ActionButton className="btn sm" reads onClick={() => setOpen(true)}>
        {ACTIONS.previewPrComment.label}
      </ActionButton>
      {open ? <PrCommentDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** The decisions the session's comment carried: each rank 1 and 2 step, then the note; or, with none flagged, the engine's sentence. Goldens by name, as the page names them. */
function KeptSteps({ kept }: { kept: KeptDecisions }) {
  if (!kept.rows.length)
    return (
      <div className="pbody">
        <p className="muted">{kept.sentence}.</p>
      </div>
    );
  return (
    <div className="pbody">
      <DecisionSteps rows={kept.rows.map((d) => ({ ...d, golden: goldenName(d.golden) }))} className="vdd" />
      {kept.note ? <p className="muted vdnote">{kept.note}</p> : null}
    </div>
  );
}

/** What the comment added beside the verdicts, for a session that ran for a pull request: a run's cost before and after, then each injection gate, its tally breaking only after a dot. None when it kept neither. */
function OnThePullRequest({ comment }: { comment: SessionCommentParts }) {
  const { cost, injection } = comment;
  if (!cost && !injection.length) return null;
  return (
    <Section title="On the pull request" sub="what the comment adds">
      <div className="pbody">
        <dl className="kvs vdkv">
          {cost ? (
            <>
              <dt>Cost per run</dt>
              <dd>
                {cost.amounts} <small>{cost.change}</small>
              </dd>
            </>
          ) : null}
          {injection.map((i) => (
            <Fragment key={i.golden}>
              <dt>Injection</dt>
              <dd>
                <Status tone={statusTone(i.verdict)}>{i.verdict}</Status> <code>{goldenName(i.golden)}</code>
                {i.tally ? (
                  <span className="rsub">
                    <DotLine text={i.tally} max={40} />
                  </span>
                ) : null}
              </dd>
            </Fragment>
          ))}
        </dl>
      </div>
    </Section>
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
