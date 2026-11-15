import { Fragment, type ReactNode } from 'react';
import { JUDGE_ASKED } from '../../../engine/src/checks/labels.js';
import { titled, Words } from '../components/Copy.js';
import { tipCard } from '../components/HoverCard.js';
import { headingRef } from '../focus-manager.js';
import { Status } from '../components/Status.js';
import { judgeRows } from '../judge-rows.js';
import type { FixesViewRow, FixPr, FixRow } from '../types.js';
import { failedMust, flagParts, wholeParts } from './model.js';
import { rungStatus } from './rung-status.js';

/** A judge's card, on the Must line and on its line of the Blame step's check: its rows as Tests' checks draw them (`judgeRows`: what it asks, what it reads, the model), and when it is asked. */
export const judgeTip = (j: NonNullable<FixRow['judge']>): string => tipCard(j.label, judgeRows(j), `${JUDGE_ASKED.charAt(0).toUpperCase()}${JUDGE_ASKED.slice(1)}`);

/**
 * What a fix's failing runs did and the check they must meet (`failedMust`): "Failed: … · Must: …",
 * each label kept with its value where the line wraps, the check's first judge on the check's card.
 * The dot between them is drawn only while both share a line; the one in the text is for reading it
 * aloud or copying it. `tail` follows the check: the fix's header puts its way to change it there.
 */
export function FailedMust({ fix, tail }: { fix: Pick<FixRow, 'title' | 'failed' | 'check' | 'judge'>; tail?: ReactNode }) {
  const { failed, must } = failedMust(fix);
  return (
    <span className="fm">
      {failed ? (
        <>
          <span className="fmu">
            Failed: <Whole text={failed} />
          </span>
          <span className="fmsep"> · </span>
        </>
      ) : null}
      <span className="fmu">
        Must: <Whole text={must} tip={fix.judge ? judgeTip(fix.judge) : null} />
      </span>
      {tail}
    </span>
  );
}

/**
 * A check or a failure, a sentence in the UI face, a count kept with its unit and a comparison kept
 * whole where there is room (`wholeParts`); with a card (`tip`), it takes the focus to show it.
 */
export function Whole({ text, tip = null }: { text: string; tip?: string | null }) {
  return (
    <span className="fmv" {...(tip ? { tabIndex: 0, 'data-tip': tip } : {})}>
      {wholeParts(text).map((p, i) =>
        p.whole ? (
          <span key={i} className="kc">
            {p.text}
          </span>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </span>
  );
}

/** A title's last clause from its conjunction on (`before the refund was issued`), as the mock's `clauseHtml` finds it. */
const CLAUSE = / ((?:before|after|when|while|until|unless|because|once|since) \S.*)$/;

/**
 * A fix's title as `titled` sets it, its last clause from a conjunction kept whole where its line
 * holds it (`.clause`), so a narrow heading breaks before the conjunction, never after it.
 */
export function clauseTitled(title: string): { children: ReactNode; 'aria-label'?: string } {
  const head = titled(title);
  const m = CLAUSE.exec(title);
  if (!m) return head;
  const children = (
    <>
      <Words>{title.slice(0, m.index)}</Words>{' '}
      <span className="clause">
        <Words>{m[1]!}</Words>
      </span>
    </>
  );
  return { ...head, children };
}

/** A fix page's heading: its title as `clauseTitled` sets it, the page's focus target. */
export function FixTitle({ title }: { title: string }) {
  const head = clauseTitled(title);
  return (
    <h1 ref={headingRef} aria-label={head['aria-label']}>
      {head.children}
    </h1>
  );
}

/** Text whose command-line flags are set as code, each kept on one line (`--stronger <model>`). */
export function Flagged({ text }: { text: string }) {
  return (
    <>
      {flagParts(text).map((p, i) =>
        p.flag ? (
          <code key={i} className="flag">
            {p.text}
          </code>
        ) : (
          <Words key={i}>{p.text}</Words>
        ),
      )}
    </>
  );
}

/** A pull request's page, where its address is a web page's: one a pull from the team store brought may be anything else, which stays words. */
export const prHref = (pr: Pick<FixPr, 'url'> | null | undefined): string | null => (pr && /^https?:\/\/\S+$/.test(pr.url) ? pr.url : null);

/** Words with the pull request they name (`PR #138`) a link to its page, which opens apart from the dashboard; the words alone where it has none. */
function PrIn({ text, pr }: { text: string; pr: Pick<FixPr, 'url' | 'number'> | null | undefined }) {
  const page = prHref(pr);
  const named = pr ? (pr.number !== null ? `PR #${pr.number}` : pr.url) : '';
  const at = page && named ? text.indexOf(named) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <a className="prlink" href={page!} target="_blank" rel="noopener noreferrer">
        {named}
      </a>
      {text.slice(at + named.length)}
    </>
  );
}

/** A fix's place on the ladder, as its row and its page say it (`rungStatus`), the pull request it merged with a link to its page. */
export function RungStatus({ f }: { f: Pick<FixesViewRow, 'rung' | 'pr' | 'broken' | 'status'> }) {
  const status = rungStatus(f);
  return (
    <Status tone={status.tone}>
      <PrIn text={status.text} pr={f.pr} />
    </Status>
  );
}

/** Where a fix came from (`from CI · PR #138`, `PR #138 closed`), its pull request a link to its page. */
export function FixSource({ source, pr }: { source: string; pr: FixPr | null | undefined }) {
  return <PrIn text={source} pr={pr} />;
}
