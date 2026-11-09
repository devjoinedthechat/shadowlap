import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Chips, PageHeader } from '../components/bits.js';
import { tipCard } from '../components/HoverCard.js';
import { Id } from '../components/Id.js';
import { Link } from '../components/Link.js';
import { Page } from '../components/Page.js';
import { EmptyLine, EmptyState, ErrorState, Skeleton } from '../components/States.js';
import { Status } from '../components/Status.js';
import { rememberList } from '../fixes/data.js';
import { FixPage } from '../fixes/FixPage.js';
// What a fix's jobs end on in the drawer, registered as the Fixes chunk loads.
import '../fixes/job-footers.js';
import { CHIP_EMPTY, ciCard, failingCard, fixFacts, leadWait, rowCells, rungStatus, STEP_NAMES, UNBLAMED_CELLS, unblamedFailed, unblamedShows, type StepCell } from '../fixes/list.js';
import { chipKeeps, failingLine, FIX_CHIPS, fixStamp, treeBusy, type FixChip } from '../fixes/model.js';
import { FailedMust, Whole } from '../fixes/parts.js';
import { fixRowScope, unblamedScope } from '../fixes/row-scope.js';
import { RowStep } from '../fixes/RowStep.js';
import { RunBlameButton } from '../fixes/RunBlame.js';
import { useServerJobs } from '../fixes/tree.js';
import { shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { ACTIONS } from '../labels.js';
import { useListKeys } from '../list-keys.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { projectOf } from '../shell/ProjectBlock.js';
import { useApp } from '../state.js';
import { errorText } from '../toast.js';
import type { FixesView, FixesViewRow, JobListItem, UnblamedRow } from '../types.js';
import { unblamedBlameCard, unblamedTitle } from '../../src/unblamed-words.js';

/**
 * Fixes (#/fixes): a to-do list of failures, the failing runs nobody has blamed first, then each fix,
 * open ones first, then those ready to apply, then those applied, with how far blame, repair and
 * verify got and the step it leads with. A fix (#/fixes/<id>[/<step>[/<sub>]]) opens on its own page
 * with its three steps.
 */
export function FixesPage({ id, step, sub }: { id: string | null; step: string | null; sub: string | null }) {
  return id ? <FixPage key={id} id={id} step={step} sub={sub} /> : <FixList />;
}

/** The command the empty page offers: blame names where a failed run was lost, and opens its fix. */
const BLAME = `shadowlap blame <run> --expect '{"tools":{"send_email":1}}'`;

/** The filter chip, kept while the page is open in this tab: back from a fix, the list is as it was left. */
let chipShown: FixChip = 'all';

/** Where a list's runs-under-Failed link leads: the unblamed row's title and each fix's failing runs. */
const FAILED = href.runs({ types: 'failed' });

function FixList() {
  const { client, tick, feeds, meta } = useApp();
  const [chip, setChipState] = useState<FixChip>(() => chipShown);
  const setChip = (c: FixChip) => {
    chipShown = c;
    setChipState(c);
  };
  // Again when runs change, or fixes do (a blame or repair in a terminal, a title set elsewhere).
  const version = `${tick}:${feeds.fixes ?? 0}`;
  const loaded = useLoad(() => client.fixes(), 'fixes', version);
  const view = loaded.data;
  useEffect(() => {
    if (view) rememberList(view);
  }, [view]);
  const header = <PageHeader eyebrow={`${projectOf(meta)?.name ?? 'this project'} · failures`} title="Fixes" text="Find the call that lost the run, fix it, and check the fix holds." facts={view ? fixFacts(view) : undefined} />;
  if (loaded.error && !view)
    return (
      <Page>
        {header}
        <ErrorState retry={loaded.reload}>{errorText(loaded.error)}</ErrorState>
      </Page>
    );
  if (!view)
    return (
      <Page busy>
        {header}
        <Loading />
      </Page>
    );
  if (!view.counts.all && !view.unblamed)
    return (
      <Page>
        {header}
        <EmptyState title="No fixes yet" text="A fix starts from a run that failed its check: blame finds the model call that lost it, repair proposes a change, and verify proves the change before it ships." command={BLAME} />
      </Page>
    );
  return (
    <Page>
      {header}
      {/* Failing runs nobody has blamed, and no fix yet: their row alone, with no chip to pick. */}
      {view.counts.all ? (
        <div className="tbar">
          <Chips label="Status" items={FIX_CHIPS.map((c) => ({ ...c, count: view.counts[c.key] }))} value={chip} onChange={setChip} />
        </div>
      ) : null}
      <Rows view={view} chip={view.counts.all ? chip : 'all'} version={version} />
    </Page>
  );
}

type ListRow = { kind: 'unblamed'; u: UnblamedRow } | { kind: 'fix'; f: FixesViewRow };

/** A row's key: a fix's page, or the unblamed row's own, since its link is every fix's failing-runs link too. */
const keyOf = (r: ListRow): string => (r.kind === 'fix' ? r.f.href : 'unblamed');

const HEADS = (
  <div className="psh" aria-hidden="true">
    <span />
    <span>{STEP_NAMES.blame}</span>
    <span>{STEP_NAMES.repair}</span>
    <span>{STEP_NAMES.verify}</span>
    <span>Next step</span>
  </div>
);

function Rows({ view, chip, version }: { view: FixesView; chip: FixChip; version: string }) {
  const { meta, hasKind } = useApp();
  const box = useRef<HTMLDivElement>(null);
  // One read of the jobs for the whole list: each row's step waits by it, and says which of its own runs.
  const jobs = useServerJobs();
  const folder = meta?.project?.path ?? null;
  const un = view.unblamed && unblamedShows(chip) ? view.unblamed : null;
  const rows = useMemo<ListRow[]>(() => [...(un ? [{ kind: 'unblamed' as const, u: un }] : []), ...view.fixes.filter((f) => chipKeeps(chip, f)).map((f) => ({ kind: 'fix' as const, f }))], [un, view, chip]);
  // A capture's Run blame opens its page, where blame asks for your command first: no job, so no wait.
  const blameWait = un?.next && !un.next.capture && hasKind('blame') ? treeBusy(jobs, 'reads', 'blame', folder) : null;
  // j and k walk the rows; Enter opens one; ⌘K offers its steps.
  const inFocus = useListKeys({
    rows,
    keyOf,
    root: box,
    open: (r) => navigate(r.kind === 'fix' ? r.f.href : FAILED),
    actions: (r) =>
      r.kind === 'fix'
        ? fixRowScope(r.f)
        : unblamedScope({ name: unblamedTitle(r.u.count), command: r.u.next ? (r.u.next.command ?? ACTIONS.runBlame.label) : null, job: !r.u.next?.capture, wait: blameWait, press: () => box.current?.querySelector<HTMLElement>('[data-rowkey="unblamed"] .psn .btn')?.click() }),
  });
  if (!rows.length) return <EmptyLine>{CHIP_EMPTY[chip]}</EmptyLine>;
  return (
    <div className="pslist" role="list" ref={box}>
      {HEADS}
      {rows.map((r) =>
        r.kind === 'fix' ? (
          <FixListRow key={r.f.fixId} f={r.f} jobs={jobs} focused={inFocus === r.f.href} why={r.f.next ? leadWait(r.f.next, { jobs, folder, projectId: meta?.project?.id ?? null, hasKind }) : null} version={version} />
        ) : (
          <UnblamedListRow key="unblamed" u={r.u} jobs={jobs} focused={inFocus === 'unblamed'} />
        ),
      )}
    </div>
  );
}

/** A step's cell: its dot and word in its consequence colour, named for a screen reader and on a phone. */
function Step({ c }: { c: StepCell }) {
  return (
    <span className={`psk ${c.state} s-${c.key}`}>
      <i aria-hidden="true" />
      <span>
        <span className="psw">{STEP_NAMES[c.key]} </span>
        {c.short}
      </span>
    </span>
  );
}

/** The step a row has none of: its title's link opens the fix. */
const OPEN = (
  <span className="go" aria-hidden="true">
    Open&nbsp;→
  </span>
);

const FixListRow = memo(function FixListRow({ f, jobs, focused, why, version }: { f: FixesViewRow; jobs: readonly JobListItem[]; focused: boolean; why: string | null; version: string }) {
  const status = rungStatus(f);
  const card = failingCard(f);
  return (
    <div className={focused ? 'psrow krow' : 'psrow'} role="listitem" data-rowkey={f.href}>
      <span className="pst">
        <a className="rt" href={f.href}>
          {f.title}
        </a>
        <span className="rs">
          <Status tone={status.tone}>{status.text}</Status>
          {f.label ? <span className="chip">{f.label}</span> : null}
          {f.ci ? (
            <span className="chip" data-tip={tipCard('From CI', [], ciCard(f))}>
              from CI
            </span>
          ) : f.source ? (
            <span className="chip">{f.source}</span>
          ) : null}
          <span className="nw">
            <Link href={FAILED} quiet tip={tipCard(card.title, [], card.text)}>
              {failingLine(f)}
            </Link>
          </span>
          <span className="nw">opened {fixStamp(f.openedAt)}</span>
          {f.broken ? <span className="fxbad">doesn’t hold: {f.broken}</span> : null}
        </span>
        <FailedMust fix={f} />
      </span>
      {rowCells(f, jobs).map((c) => (
        <Step key={c.key} c={c} />
      ))}
      <span className="psn">{f.next ? <RowStep fixId={f.fixId} lead={f.next} why={why} version={version} /> : OPEN}</span>
    </div>
  );
});

function UnblamedListRow({ u, jobs, focused }: { u: UnblamedRow; jobs: readonly JobListItem[]; focused: boolean }) {
  const card = unblamedBlameCard(u.count, shortId(u.runId));
  return (
    <div className={focused ? 'psrow psun krow' : 'psrow psun'} role="listitem" data-rowkey="unblamed">
      <span className="pst">
        <a className="rt" href={FAILED}>
          {unblamedTitle(u.count)}
        </a>
        <span className="rs">
          <Status tone="err">failed</Status>
          <span className="nw">
            newest <Id id={shortId(u.runId)} about={u.about} />
          </span>
        </span>
        <span className="fm">
          <span className="fmu">
            Failed: <Whole text={unblamedFailed(u)} />
          </span>
        </span>
      </span>
      {UNBLAMED_CELLS.map((c) => (
        <Step key={c.key} c={c} />
      ))}
      <span className="psn">
        {u.next?.capture ? (
          // A capture's opens its run page, where blame asks for the command that starts your agent first.
          <a className="btn sm" href={href.run(u.runId)} data-tip={tipCard(ACTIONS.runBlame.label, [], card)}>
            {ACTIONS.runBlame.label}
          </a>
        ) : u.next ? (
          <RunBlameButton runId={u.runId} offer={{ failed: u.checks, from: u.from ?? 'ask' }} className="btn sm" title={card} jobs={jobs} {...(u.next.command ? { line: u.next.command } : {})} />
        ) : (
          OPEN
        )}
      </span>
    </div>
  );
}

/** Loading: the heads and four rows in their final shape, as bars. */
function Loading() {
  return (
    <Skeleton what="the fixes">
      <div className="pslist">
        {HEADS}
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="psrow">
            <span className="pst">
              <span className="rt">A failure that lost the run</span>
              <span className="rs">open · 3 failing runs · opened Oct 1, 09:52</span>
            </span>
            <span className="psk">lost at #5</span>
            <span className="psk">no change yet</span>
            <span className="psk">not verified</span>
            <span className="psn" />
          </div>
        ))}
      </div>
    </Skeleton>
  );
}
