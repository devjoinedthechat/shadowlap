import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { JOB_KINDS } from '../api.js';
import { pageLeads, wayOnControl } from '../dom.js';
import { useTreeBusy } from '../fixes/tree.js';
import { shortId } from '../format.js';
import { useLatest } from '../hooks.js';
import { jobFooter } from '../job-actions.js';
import { drawnJob } from '../job-store.js';
import { drawerCost } from '../../../engine/src/estimates/spending.js';
import { calibrationTarget, endToast, forkDivergedEarly, jobCommand, jobHeader, jobStatus, lineTone, openRunWords, replayDivergence, stopAsk } from '../jobs.js';
import { InSlot, usePanel } from '../overlays/slots.js';
import { href, parseRoute, samePage } from '../route.js';
import { currentRoute } from '../router.js';
import { switchProject } from '../shell/ProjectBlock.js';
import { useApp, type WatchedJob } from '../state.js';
import { retoast } from '../toast-place.js';
import { errorText, type ToastAction } from '../toast.js';
import { ActionButton } from './ActionButton.js';
import { Spin } from './bits.js';
import { DotParts } from './DotParts.js';
import { Dialog } from './Dialog.js';
import { Icon } from './Icon.js';

/**
 * The job drawer: a CLI run the dashboard started, docked across the content's foot, a hairline above
 * it, the content making room (`--dock-h`). Its header says what the job does, the -ing form of its
 * button, and its log streams in below. Esc or the chevron hides a running job behind the status bar's
 * chip, across pages. Ended, it says what it did in the past tense and how, in the verdict's colour,
 * and its way on; two seconds later it folds to its header line, unless the keyboard is in it. Esc or
 * Close closes it then, and so does leaving the page. A hidden job's end raises a toast with its way
 * on. While it runs, Stop ends it as Ctrl-C would, asking first when it is changing the working tree.
 * A Replay that diverged offers Calibrate beside the run it made.
 */
export function JobDrawer() {
  const { jobs } = useApp();
  const current = drawnJob(jobs);
  return current ? (
    <InSlot name="dock">
      <Drawer key={current.job.id} watched={current} />
    </InSlot>
  ) : null;
}

/** What the drawer takes at the content's foot: `--dock-h`, or, folded, its own height, kept as it wraps. On the root, so what reads it there follows. */
function useDockRoom(panel: { readonly current: HTMLElement | null }, hidden: boolean, folded: boolean): void {
  useLayoutEffect(() => {
    const body = document.body.classList;
    body.toggle('docked', !hidden);
    body.toggle('dockfold', !hidden && folded);
    const el = panel.current;
    retoast();
    if (!el || hidden || !folded) return () => body.remove('docked', 'dockfold');
    const root = document.documentElement.style;
    const room = () => {
      root.setProperty('--dock-h', `${el.offsetHeight}px`);
      retoast();
    };
    room();
    const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(room) : null;
    watch?.observe(el);
    return () => {
      watch?.disconnect();
      root.removeProperty('--dock-h');
      body.remove('docked', 'dockfold');
    };
  }, [panel, hidden, folded]);
}

/** A word of the log is kept whole where the line wraps, a flag with its value; a long one breaks after a slash. The spaces stay as printed, so the log copies as it prints. */
const WORDS = /--?[a-z][\w-]* (?!-)\S+|\S+/g;

const LogLine = memo(function LogLine({ line, tone: as }: { line: string; tone?: string }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const m of line.matchAll(WORDS)) {
    if (m.index > at) parts.push(line.slice(at, m.index));
    const word = m[0];
    const pieces = word.length > 30 ? word.split(/(?<=\/)/) : [word];
    parts.push(
      <span className="tk" key={m.index}>
        {pieces.flatMap((p, i) => (i ? [<wbr key={i} />, p] : [p]))}
      </span>,
    );
    at = m.index + word.length;
  }
  if (at < line.length) parts.push(line.slice(at));
  const tone = as ?? lineTone(line);
  return (
    <span className={tone || undefined}>
      {parts}
      {'\n'}
    </span>
  );
});

/** Whether a link leads to the page on the screen, which a way on never does. */
function linksHere(to: string): boolean {
  return typeof location !== 'undefined' && samePage(parseRoute(to), currentRoute());
}

/**
 * The log: scrolled by keyboard too, focusable and named for what it holds, and never read out line by
 * line. It follows the end as it grows, and shows its end when it is shown again, hidden or folded as
 * the lines came. Each line is keyed by its place in the whole output, so a line keeps its element as
 * the last 2,000 move on.
 */
function JobLog({ job, lines, running, shown }: { job: WatchedJob['job']; lines: readonly string[]; running: boolean; shown: boolean }) {
  const out = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    const el = out.current;
    if (el && shown) el.scrollTop = el.scrollHeight;
  }, [lines.length, job.total, shown]);
  const first = job.total - lines.length;
  return (
    <pre ref={out} id="jout" tabIndex={0} role="log" aria-live="off" aria-label="Output">
      <LogLine line={`$ ${jobCommand(job.args)}`} tone="p" />
      {lines.map((l, i) => (
        <LogLine key={first + i} line={l} />
      ))}
      {running && lines.length === 0 ? <span>starting…</span> : null}
    </pre>
  );
}

/** Stop: sent once, then the job's own view says it is stopping until it has ended. It asks first for a job that is changing the working tree. */
function StopButton({ job, title }: { job: WatchedJob['job']; title: string }) {
  const { client, guard, toast } = useApp();
  const [asking, setAsking] = useState(false);
  const [sent, setSent] = useState(false);
  const stopping = sent || job.stopped === true;
  const ask = stopAsk(job);
  const stop = () =>
    guard(() => {
      setSent(true);
      client.stopJob(job.id).then(
        (r) => {
          if (!r.stopped) toast(`${title} had ended already`);
        },
        (err: unknown) => {
          setSent(false);
          toast(errorText(err), 'error');
        },
      );
    });
  return (
    <>
      <ActionButton className="btn" disabled={stopping} title={stopping ? 'Asked to stop: it ends once its command has' : `Stops ${jobCommand(job.args)} as Ctrl-C would`} onClick={() => (ask ? setAsking(true) : stop())}>
        {stopping ? 'Stopping…' : 'Stop'}
      </ActionButton>
      {asking && ask ? <StopJobDialog ask={ask} onClose={() => setAsking(false)} onOk={stop} /> : null}
    </>
  );
}

/**
 * Its way on, in the header line: the links beside it, what it wrote, what its kind adds, Calibrate,
 * then the one that leads. Never a link to the page on the screen, and plain while the page leads
 * with a lime step of its own. A job of another project than the page shows (the dashboard switched
 * since it started) has links that switch to that project first, and nothing that acts on this one.
 */
function WayOn({ watched, close, elsewhere }: { watched: WatchedJob; close: () => void; elsewhere: { id: string; name: string } | null }) {
  const app = useApp();
  const { client, toast, guard } = app;
  const { job, lines, lost = false } = watched;
  const follow = (to: string) => (e: { preventDefault(): void }) => {
    close();
    if (!elsewhere) return;
    e.preventDefault();
    guard(() => void switchProject(app, elsewhere.id, to));
  };
  const there = elsewhere ? `Switches to ${elsewhere.name}, where this job ran` : undefined;
  const files = (job.files ?? []).filter((f) => !f.directory);
  const links = job.links ?? [];
  const here = (l: { href: string }) => !linksHere(l.href);
  const primary = links.filter((l) => !l.secondary && here(l));
  const beside = links.filter((l) => l.secondary && here(l));
  const opens = job.done && job.newRunId && (job.opensRun || links.length === 0) && !links.some((l) => l.href.includes(job.newRunId!)) && !linksHere(href.run(job.newRunId)) ? job.newRunId : null;
  // What the job's own feature adds: calibrate's "Add normalizer", a clean-up's "Delete N runs".
  const Footer = elsewhere ? null : jobFooter(job.kind);
  // A Replay whose request differed from its recording, or a fork that left it before the call its
  // flag acts on: Calibrate finds the normalizer when the difference is a value made anew on every run.
  const calibrate = !elsewhere && !lost && (replayDivergence(job, lines) || forkDivergedEarly(job, lines)) && app.hasKind(JOB_KINDS.calibrate) ? calibrationTarget(job.runId, app.runs ?? []) : null;
  // One lime at a time.
  const lime = job.done && pageLeads() ? 'btn' : 'btn lime';
  return (
    <>
      {beside.length ? (
        <span className="jlinks">
          {beside.map((l) => (
            <a key={l.href + l.label} className="more" href={l.href} title={there} onClick={follow(l.href)}>
              {l.label}
            </a>
          ))}
        </span>
      ) : null}
      {files.map((f) => (
        <ActionButton
          key={f.fileId}
          className="btn jfile"
          onClick={() =>
            void client.downloadFile(f).then(
              () => toast(`Saved ${f.name}`),
              (err: unknown) => toast(errorText(err), 'error'),
            )
          }
        >
          <Icon name="import" />
          {f.label ?? f.name}
        </ActionButton>
      ))}
      {Footer && !lost ? (
        <span className="jkind">
          {/* eslint-disable-next-line react-hooks/static-components -- the footer registered for the job's kind: one component a kind, the same on every render */}
          <Footer job={job} plain={lime === 'btn'} done={close} />
        </span>
      ) : null}
      {calibrate ? <CalibrateButton runId={calibrate} /> : null}
      {primary.map((l) => (
        <a key={l.href + l.label} className={lime} href={l.href} title={there} onClick={follow(l.href)}>
          {l.label}
        </a>
      ))}
      {opens ? (
        <a className={lime} href={href.run(opens)} title={there} onClick={follow(href.run(opens))}>
          {openRunWords(job)}
        </a>
      ) : null}
    </>
  );
}

/**
 * A job's end, once. On the screen, it folds a moment later, once its last line has been read, unless
 * the keyboard is in it, and the focus goes to the way on if the page drawn anew took it. Hidden, a
 * toast says how it ended, with the way on, and it never folds: shown again, it shows its log, which
 * is what was asked for, and says what the toast said, so that toast goes.
 */
function useJobEnd(watched: WatchedJob, panel: { readonly current: HTMLElement | null }, fold: () => void, close: () => void): void {
  const { toast, openJob, dropToast } = useApp();
  const { job } = watched;
  const hidden = !watched.open;
  const now = useLatest({ hidden, job, lines: watched.lines, toast, openJob, dropToast, fold, close });
  const said = useRef(job.done);
  const offered = useRef<ToastAction | null>(null);
  useEffect(() => {
    if (!job.done || said.current) return;
    said.current = true;
    const next = wayOnControl(panel.current);
    if (now.current.hidden) {
      const onGone = () => {
        document.body.classList.remove('jobtoast');
        offered.current = null;
      };
      // Taken from the toast, the way on closes the drawer as it does from the drawer: a link by
      // itself, a file as it downloads. What the job's kind adds may start a job or ask first.
      const take = () => {
        next!.click();
        if (next!.classList.contains('jfile')) now.current.close();
      };
      const action: ToastAction = next ? { label: next.textContent.trim(), run: take, onGone } : { label: 'Show', run: () => now.current.openJob(job.id, true), onGone };
      document.body.classList.add('jobtoast');
      offered.current = action;
      const { job: ended, lines } = now.current;
      now.current.toast(endToast(ended, lines), jobStatus(ended, lines).tone === 'err' ? 'error' : 'notice', action);
      return;
    }
    // Where the focus goes as it ends is the job store's (`handOnAtEnd`): the page's step first.
    const folds = setTimeout(() => {
      if (!now.current.hidden && !panel.current?.contains(document.activeElement)) now.current.fold();
    }, 2000);
    return () => clearTimeout(folds);
  }, [job.done, job.id, panel, now]);
  useEffect(() => {
    if (!hidden && offered.current) now.current.dropToast(offered.current);
  }, [hidden, now]);
}

/**
 * Where the focus goes. The drawer sits beside the page, and takes it only when a job's end leaves it
 * nowhere else (`handOnAtEnd`). Hidden with the focus in it, the chip that opens it again takes it;
 * asked for from the chip or a toast's Show, the button that hides or closes it does. Closed with the
 * focus in it, it goes back to where it was before it went into the drawer, or to the page. Returns
 * what `close` calls first and the panel's own handler.
 */
function useDockFocus(watched: WatchedJob, panel: { readonly current: HTMLElement | null }, hideOrClose: { readonly current: HTMLElement | null }): { noteFocus: () => void; onFocus: (e: { relatedTarget: EventTarget | null }) => void } {
  const hidden = !watched.open;
  const hadFocus = useRef(false);
  const cameFrom = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = panel.current;
    return () => {
      if (!el?.contains(document.activeElement)) return;
      const back = cameFrom.current?.isConnected ? cameFrom.current : document.querySelector<HTMLElement>('#view');
      back?.focus();
    };
  }, [panel]);
  useEffect(() => {
    if (hidden && hadFocus.current) document.querySelector<HTMLElement>('.status .jobchip')?.focus();
    hadFocus.current = false;
    if (!hidden && watched.focus) (watched.focus === 'log' ? panel.current?.querySelector<HTMLElement>('#jout') : hideOrClose.current)?.focus();
  }, [hidden, watched.focus, hideOrClose, panel]);
  return {
    noteFocus: () => {
      hadFocus.current = !!panel.current?.contains(document.activeElement);
    },
    onFocus: (e) => {
      const from = e.relatedTarget;
      if (from instanceof HTMLElement && !panel.current?.contains(from)) cameFrom.current = from;
    },
  };
}

function Drawer({ watched }: { watched: WatchedJob }) {
  const { closeJob, meta } = useApp();
  // Gone, what sits over it takes its place, once it is off the page.
  useEffect(() => retoast, []);
  const { job, lines, lost = false } = watched;
  const hidden = !watched.open;
  const running = !job.done && !lost;
  const panel = useRef<HTMLElement>(null);
  const hideOrClose = useRef<HTMLButtonElement>(null);
  const { noteFocus, onFocus } = useDockFocus(watched, panel, hideOrClose);
  const close = () => {
    noteFocus();
    closeJob(job.id);
  };
  usePanel(close, !hidden);
  const [folded, setFolded] = useState(false);
  useDockRoom(panel, hidden, folded);
  useJobEnd(watched, panel, () => setFolded(true), close);
  const elsewhere = job.project && meta?.project?.id && job.project.id !== meta.project.id ? job.project : null;
  const head = jobHeader(job, lines, lost);
  // A billed job says what it costs beside running, a ceiling as one.
  const cost = running ? drawerCost(job.estimate) : null;
  const folders = (job.files ?? []).filter((f) => f.directory);
  const logWord = folded ? 'Show log' : 'Hide log';
  const xWord = running ? 'Hide while it runs' : 'Close';
  return (
    <section className={`drawer${folded ? ' folded' : ''}`} role="region" aria-labelledby="jtitle" hidden={hidden} ref={panel} onFocus={onFocus}>
      <header>
        {running ? <Spin /> : null}
        <span className="jhd">
          <b id="jtitle">{head.title}</b> {elsewhere ? <span className="st2 jin">in {elsewhere.name}</span> : null}{' '}
          <span className={`st2${head.tone ? ` ${head.tone}` : ''}`}>
            <DotParts parts={[...head.text.split(' · '), ...(cost ? [cost] : [])]} />
          </span>
        </span>
        <span className="jfoot">
          {running ? <StopButton job={job} title={head.title} /> : null}
          <WayOn watched={watched} close={close} elsewhere={elsewhere || null} />
        </span>
        {job.done ? (
          <button className="ibtn" id="jlog" type="button" aria-controls="jout" aria-expanded={!folded} aria-label={logWord} title={logWord} onClick={() => setFolded(!folded)}>
            <Icon name={folded ? 'up' : 'down'} />
          </button>
        ) : null}
        <button className="ibtn" id="jx" type="button" ref={hideOrClose} aria-label={xWord} title={xWord} onClick={close}>
          <Icon name={running ? 'down' : 'x'} />
        </button>
      </header>
      {folders.length && !folded ? (
        <div className="jfiles">
          {folders.map((f) => (
            <span key={f.fileId} title="A folder in the project: open it from your editor or a terminal">
              <Icon name="folder" />
              {f.label ? `${f.label} · ` : ''}
              <code>{f.path ?? f.name}</code>
            </span>
          ))}
        </div>
      ) : null}
      <JobLog job={job} lines={lines} running={running} shown={!hidden && !folded} />
      {/* What a screen reader hears of the job: how it stands, as that changes, never each line it prints. */}
      <span className="sr" role="status">
        {`${head.title}, ${head.text.replace(/ · /g, ', ')}${cost ? `, ${cost.replace('≈', 'about ').replace('<', 'under ')}` : ''}`}
      </span>
    </section>
  );
}

/**
 * Calibrate, after a Replay diverged, or a fork before its flag acted: the calibrate job on the
 * recording, which replays it offline until it is clean and proposes a normalizer for each value
 * that changes every run (a user id, a temporary path); its own drawer then offers to add them. It
 * runs the agent from the working tree, so it waits while a repair or an apply changes it, as
 * Settings → Matching's Calibrate does.
 */
function CalibrateButton({ runId }: { runId: string }) {
  const { client, guard, watchJob } = useApp();
  const tree = useTreeBusy('reads', 'calibrate');
  const id = shortId(runId);
  return (
    <ActionButton className="btn" why={tree} title={`Replays ${id} offline until it is clean and proposes a normalizer for each value that changes every run: shadowlap calibrate ${id}`} onClick={() => guard(() => watchJob(client.startJob(JOB_KINDS.calibrate, { runId })))}>
      Calibrate
    </ActionButton>
  );
}

/** What Stop asks first, for a job that holds the working tree: it starts on Keep it running, as the job goes on unless you say. */
export function StopJobDialog({ ask, onOk, onClose }: { ask: NonNullable<ReturnType<typeof stopAsk>>; onOk: () => unknown; onClose: () => void }) {
  return <Dialog title={ask.title} lead={ask.lead} doc="jobs" facts={ask.facts} ok={ask.ok} tone="plain" initialFocus="cancel" cancel="Keep it running" onClose={onClose} onOk={onOk} />;
}
