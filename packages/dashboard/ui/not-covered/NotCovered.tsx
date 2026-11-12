import { Fragment, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ENDS_ANOTHER_WAY } from '../../../engine/src/coverage-words.js';
import { quoteArgv } from '../../../engine/src/text.js';
import { JOB_KINDS } from '../api.js';
import { useFitAbouts } from '../components/About.js';
import { CmdLine } from '../components/bits.js';
import { tipCard } from '../components/HoverCard.js';
import { Icon } from '../components/Icon.js';
import { Id } from '../components/Id.js';
import { JobButton } from '../components/JobButton.js';
import { Section } from '../components/Section.js';
import { TestsJobButton } from '../fixes/TestsJobButton.js';
import { goldenName, justNow, minuteStamp, plural, shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { ACTIONS } from '../labels.js';
import { useListKeys, type RowScope } from '../list-keys.js';
import { personName } from '../person.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { useApp } from '../state.js';
import { addressNow } from '../dom.js';
import type { CoverageGroupView, CoverageView } from '../types.js';
import { andList, asksNotCovered, coverageSaid, coverageShows, endOf, lastTried, lineSteps, NO_LONGER, nearestWords, packCommand, pathWords, triedWhy, whereOf, type LineStep, type Where } from './model.js';
import { PackDialogPart } from './part.js';

/*
 * Tests › Not covered: what production did that no golden tests, a behaviour a row, from where it
 * parts from its nearest golden, with Pack as golden (or Pack with checks… for one the agent no
 * longer does), its details on request, Rescan coverage at the head and the last scan in the foot.
 * The scan is the CLI's (`/api/coverage` reads the one it kept): read again as a scan or a pack
 * writes one, and as runs come in, which the foot then counts. It shows only where there is an
 * imported run to read. The pack dialogs are a part the served dashboard hands in (part.tsx).
 */

/** The jobs whose end changes what it shows. */
const ENDS = new Set<string>([JOB_KINDS.coverage, JOB_KINDS.coveragePack]);

const RESCAN_SUB = 'Groups the imported runs by what they did and checks each behaviour against the goldens on disk';
const LEAD = ['what production did that no golden tests,', 'from where it parts from the nearest one:', 'pack it, and CI replays it on every commit'];

/** The last scan, read again as a scan or a pack writes one, as runs come in, and as this tab's scans and packs end. */
export function useCoverage(): CoverageView | null {
  const { client, feeds, runsTick, jobs } = useApp();
  const ended = jobs.filter((w) => w.job.done && ENDS.has(w.job.kind ?? '')).length;
  return useLoad(() => client.coverage(), 'coverage', `${feeds.coverage ?? 0}:${runsTick}:${ended}`).data ?? null;
}

/** A behaviour's name in a list, from its line: `lookup_order → issue_refund · writes …`. */
const nameOf = (g: CoverageGroupView): string => g.line.slice(0, 48);

/** ⌘K on a row: its one action, as its button says it, waiting as it waits. */
function rowScope(g: CoverageGroupView, box: RefObject<HTMLElement | null>): RowScope | null {
  const button = () => box.current?.querySelector<HTMLElement>(`[data-rowkey="cov:${g.key}"] .cvacts .btn`) ?? null;
  if (!button()) return null;
  return {
    name: nameOf(g),
    items: () => {
      const b = button();
      if (!b) return [];
      const why = b.getAttribute('data-why');
      return [{ label: b.textContent?.trim() ?? '', hint: why ?? packCommand(g.key, { fork: !!g.pack?.forkable }), job: true, ...(why ? { wait: why } : {}), run: () => b.click() }];
    },
  };
}

/** A step of line 1: a tool's name, teal for a write, or the reads between folded, their names on its card. */
function Step({ s }: { s: LineStep }) {
  if ('more' in s) {
    return (
      <span className="cvmore" data-tip={tipCard(`${plural(s.more, 'step')} more`, [], s.names.join(' → '))}>
        … {s.more} more
      </span>
    );
  }
  return s.write ? (
    <code className="wr" title="a write">
      {s.name}
    </code>
  ) : (
    <code className="rd">{s.name}</code>
  );
}

/** Line 2's parts: the last step the two share and what the golden does there, or that none starts this way. */
function wherePieces(w: Where): ReactNode[] {
  if (!w) return ['no golden starts this way'];
  if ('same' in w)
    return [
      <>
        <code>{w.same}</code> takes the same steps, {ENDS_ANOTHER_WAY}
      </>,
    ];
  if ('first' in w)
    return [
      <>
        parts from <code>{w.first}</code> at its first step
      </>,
    ];
  return [
    <>
      after <code>{w.after}</code>
    </>,
    <>
      <code>{w.golden}</code>{' '}
      {w.calls === null ? (
        'has stopped here'
      ) : (
        <>
          calls <code>{w.calls}</code> here
        </>
      )}
    </>,
  ];
}

/** A behaviour in two lines, one group a screen reader is told in words: what production did and how it ended, then where it parts from its nearest golden. */
export function Lines({ g, note }: { g: CoverageGroupView; note?: ReactNode }) {
  const end = endOf(g);
  const steps = lineSteps(g);
  const parts = [...wherePieces(whereOf(g)), ...(note ? [note] : [])];
  return (
    <span className="cvs cvln" role="group" aria-label={coverageSaid(g)}>
      <span className="l1">
        {steps.map((s, i) => (
          <Fragment key={i}>
            <Step s={s} />
            <span className="ar"> → </span>
          </Fragment>
        ))}
        <span className={`cvend${end.swatch === 'k-err' ? ' err' : ''}`}>{end.words}</span>
      </span>
      <span className="l2">
        {parts.map((p, i) => (
          <Fragment key={i}>
            {i ? ' ' : null}
            <span className="cvp">
              {p}
              {i < parts.length - 1 ? ' ·' : null}
            </span>
          </Fragment>
        ))}
      </span>
    </span>
  );
}

/** Pack as golden, or Pack with checks…: it asks first, in its dialog, and waits as every pack does (`pack it`). `quiet`: the plain one a forkable row keeps in its details. */
function PackButton({ g, fork, quiet = false }: { g: CoverageGroupView; fork: boolean; quiet?: boolean }) {
  const { actionsOff } = useApp();
  const [asking, setAsking] = useState(false);
  const label = fork ? ACTIONS.packWithChecks.label : ACTIONS.packBehaviour.label;
  const newest = shortId(g.runId ?? g.runIds[0] ?? '');
  const sub = fork ? 'Asks first: a golden that forks where the agent parts from production, judged by the checks you give' : `Asks first: replays ${newest} offline with the agent’s command, and packs it when it reproduces${quiet ? '. The last try found the agent no longer does this' : ''}`;
  const command = packCommand(g.key, { fork, command: g.pack?.command ? quoteArgv(g.pack.command) : '' });
  return (
    <>
      <TestsJobButton verb="pack it" off={actionsOff} className="btn sm" card={{ tip: label, sub, command: `$ ${command}` }} onClick={() => setAsking(true)}>
        {label}
      </TestsJobButton>
      {asking ? <PackDialogPart group={g} fork={fork} onClose={() => setAsking(false)} /> : null}
    </>
  );
}

/** Who tried the last pack, where the store names people. */
const triedBy = (by: string | null): string | null => (by ? personName(by).replace(' (you)', '') : null);

/** A row's details: its whole path, where and when it was seen, its nearest golden, what the last pack made of it, and its key. */
function Details({ g, id, packs }: { g: CoverageGroupView; id: string; packs: boolean }) {
  const last = lastTried(g);
  const by = last ? triedBy(last.by) : null;
  const n = g.nearest;
  const name = n ? goldenName(n.golden) : '';
  return (
    <dl className="rpx cvx" id={id}>
      <dt>Path</dt>
      <dd>
        <code className="cvpath">
          {g.path.map((x, i) => (
            <Fragment key={i}>
              {i ? ' ' : null}
              <span className="nw">
                {x}
                {i < g.path.length - 1 ? ' →' : null}
              </span>
            </Fragment>
          ))}
        </code>
        <p className="rpw">{pathWords(g)}</p>
      </dd>
      <dt>Seen</dt>
      <dd>
        <p className="rpc">
          {plural(g.runs, 'run')}
          {g.runs > 1 ? ', the newest' : ','} <span className="nw">{minuteStamp(g.lastSeen)}:</span>{' '}
          {g.runIds.map((rid, i) => (
            <Fragment key={rid}>
              {i ? ' ' : null}
              <Id id={shortId(rid)} href={g.kept.includes(rid) ? href.run(rid) : undefined} />
            </Fragment>
          ))}
        </p>
        {g.sources.length ? <p className="rpw">in {andList(g.sources)}</p> : null}
      </dd>
      {n ? (
        <>
          <dt>Nearest golden</dt>
          <dd>
            <p className="rpc">
              <code>{name}</code>
              {nearestWords(n, '; ').slice(name.length)}
            </p>
          </dd>
        </>
      ) : null}
      {last ? (
        <>
          <dt>Last tried</dt>
          <dd>
            <p className="rpc">
              {minuteStamp(last.at)}
              {by ? `, by ${by}` : ''}: {triedWhy(last)}
            </p>
            <CmdLine>{packCommand(g.key, { command: last.command ? quoteArgv(last.command.argv) : '' })}</CmdLine>
            {packs && g.pack?.forkable ? (
              <span className="cvq">
                <PackButton g={g} fork={false} quiet />
              </span>
            ) : null}
          </dd>
        </>
      ) : null}
      <dt>Behaviour</dt>
      <dd>
        <code>{g.key}</code>
      </dd>
    </dl>
  );
}

/** A behaviour no golden covers: its two lines, how many runs (the toggle of its details) and when the newest was seen, and its one action. */
function Row({ g, open, focused, packs, onToggle }: { g: CoverageGroupView; open: boolean; focused: boolean; packs: boolean; onToggle: () => void }) {
  const key8 = g.key.slice(0, 8);
  const details = `cvx-${key8}`;
  const last = lastTried(g);
  const keep = !!g.pack?.forkable;
  const by = last ? triedBy(last.by) : null;
  const gone = keep && last ? (
    <span className="cvst" data-tip={tipCard(`${ACTIONS.packBehaviour.label}, ${minuteStamp(last.at)}${by ? ` · ${by}` : ''}`, [], triedWhy(last))}>
      {NO_LONGER}
    </span>
  ) : null;
  const runs = plural(g.runs, 'run');
  return (
    <li className={[open ? 'open' : '', focused ? 'krow' : ''].filter(Boolean).join(' ') || undefined} data-rowkey={`cov:${g.key}`}>
      <Lines g={g} note={gone} />
      <span className="cvm">
        <button type="button" className="xbtn cvn" aria-expanded={open} aria-controls={open ? details : undefined} aria-label={`${runs}, details of behaviour ${key8}`} onClick={onToggle}>
          {runs}
          <Icon name="caret" />
        </button>
        <span className="cvw">{minuteStamp(g.lastSeen)}</span>
      </span>
      <span className="cvacts">{packs ? <PackButton g={g} fork={keep} /> : null}</span>
      {open ? <Details g={g} id={details} packs={packs} /> : null}
    </li>
  );
}

/** Every row's action as wide as the widest (Pack with checks… beside Pack as golden), so the counts and dates beside them line up. */
function fitActions(list: HTMLElement): void {
  // Nothing to measure where nothing is laid out (a test's document).
  if (typeof list.getBoundingClientRect !== 'function') return;
  const acts = [...list.querySelectorAll<HTMLElement>('.cvacts')];
  for (const a of acts) a.style.minWidth = '';
  const widest = Math.max(0, ...acts.map((a) => a.getBoundingClientRect().width));
  if (widest) for (const a of acts) a.style.minWidth = `${Math.ceil(widest)}px`;
}

/** The rows, a list with a roving focus: Enter opens a row's details, ⌘K offers its action. */
function Rows({ groups }: { groups: readonly CoverageGroupView[] }) {
  const { hasKind } = useApp();
  const box = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string) =>
    setOpen((was) => {
      const now = new Set(was);
      if (!now.delete(key)) now.add(key);
      return now;
    });
  const inFocus = useListKeys({ rows: groups, keyOf: (g) => `cov:${g.key}`, root: box, open: (g) => toggle(g.key), actions: (g) => rowScope(g, box) });
  const packs = hasKind(JOB_KINDS.coveragePack);
  // Measured after every render, as the width changes and once the fonts are in.
  useFitAbouts(box, fitActions);
  return (
    <>
      <div className="cvhead">
        <span className="legend cvkey" aria-hidden="true">
          <span>
            <i className="lg k-write" />a write
          </span>
          <span>
            <i className="lg k-err" />
            failed
          </span>
        </span>
      </div>
      <ul className="covl" ref={box}>
        {groups.map((g) => (
          <Row key={g.key} g={g} open={open.has(g.key)} focused={inFocus === `cov:${g.key}`} packs={packs} onToggle={() => toggle(g.key)} />
        ))}
      </ul>
    </>
  );
}

/** The last scan in a line: when, how many runs it read, how many behaviours and how many a golden covers (which, on its card), and the runs it hasn't read. */
function Foot({ v }: { v: CoverageView }) {
  const covered = v.groups.filter((g) => g.covered);
  const parts: ReactNode[] = v.scan
    ? [
        `scanned ${justNow(v.scan.at) ? 'just now' : minuteStamp(v.scan.at)}`,
        plural(v.scan.runs, 'imported run'),
        <>
          {plural(v.groups.length, 'behaviour')},{' '}
          {covered.length ? (
            <span className="cvcov" data-tip={tipCard('Covered by a golden', [], covered.map((g) => `${goldenName(g.coveredBy[0] ?? '')} · ${plural(g.runs, 'run')}`).join(' · '))}>
              {covered.length} with a golden
            </span>
          ) : (
            '0 with a golden'
          )}
        </>,
        ...(v.newRuns ? [`${plural(v.newRuns, 'run')} imported since`] : []),
      ]
    : [plural(v.newRuns, 'imported run')];
  return (
    <div className="pbody cvfoot">
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i ? ' · ' : null}
          <span className="nw">{p}</span>
        </Fragment>
      ))}
    </div>
  );
}

/** Rescan coverage: the CLI's scan, free, on no lane: it waits only as every action does. Lime where it leads (`rescanLeads`). */
function Rescan({ lime }: { lime: boolean }) {
  const app = useApp();
  if (!app.hasKind(JOB_KINDS.coverage)) return null;
  const scan = () => app.watchJob(app.client.startJob(JOB_KINDS.coverage, {}));
  return (
    <JobButton className={lime ? 'btn sm lime' : 'btn sm'} why={app.actionsOff} tip={ACTIONS.rescanCoverage.label} sub={RESCAN_SUB} command="$ shadowlap coverage" bills={false} start={scan} ask={scan}>
      {ACTIONS.rescanCoverage.label}
    </JobButton>
  );
}

/** A link to Not covered (`#/tests?at=notcovered`) brings it into view with its heading in focus, the address going back to #/tests. */
function useArrival(v: CoverageView | null): void {
  const [asked, setAsked] = useState(() => asksNotCovered(addressNow()));
  useEffect(() => {
    const take = () => {
      if (asksNotCovered(addressNow())) setAsked(true);
    };
    window.addEventListener('hashchange', take);
    return () => window.removeEventListener('hashchange', take);
  }, []);
  useEffect(() => {
    if (!asked || !v) return;
    setAsked(false);
    navigate(href.tests(), true);
    const section = document.querySelector<HTMLElement>('#notcovered');
    const h = section?.querySelector<HTMLElement>('h2');
    if (!section || !h) return;
    section.scrollIntoView({ block: 'start' });
    if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1');
    h.focus({ preventScroll: true });
  }, [asked, v]);
}

/**
 * The section, from the scan the page read (`useCoverage`): none where there is no imported run to
 * read. `lime`: Rescan coverage leads where runs came in that no scan read, the page's own step not
 * leading (Tests keeps one lime button).
 */
export function NotCovered({ v, lime }: { v: CoverageView | null; lime: boolean }) {
  useArrival(v);
  if (!coverageShows(v)) return null;
  const rows = v.groups.filter((g) => !g.covered);
  const lead = LEAD.map((clause, i) => (
    <Fragment key={i}>
      {i ? ' ' : null}
      <span className="nw">{clause}</span>
    </Fragment>
  ));
  return (
    <Section className="cov" id="notcovered" title="Not covered" sub={lead} actions={<Rescan lime={lime && v.newRuns > 0} />}>
      {!v.scan ? (
        <div className="pbody">
          <p className="muted cvnone">Coverage hasn’t read the imported runs yet.</p>
        </div>
      ) : rows.length ? (
        <Rows groups={rows} />
      ) : (
        <div className="pbody">
          <p className="muted cvnone">Every behaviour production took has a golden.</p>
        </div>
      )}
      <Foot v={v} />
    </Section>
  );
}
