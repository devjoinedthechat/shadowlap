import { useId, useRef, useState, type ReactNode } from 'react';
import { JOB_KINDS, type CallDetail, type RunDetail, type RunOffers } from '../api.js';
import { AboutLine, useFitAbouts } from '../components/About.js';
import { Eyebrow } from '../components/bits.js';
import { suggestedList, Suggestions } from '../components/Dialog.js';
import { RunKey } from '../components/RunKey.js';
import { MARKS, type RunMark } from '../runkey.js';
import { tipText } from '../components/HoverCard.js';
import { Icon } from '../components/Icon.js';
import { Popover, useMenu } from '../components/Popover.js';
import { copyText } from '../dom.js';
import { headingRef } from '../focus-manager.js';
import { shortcut } from '../shortcuts.js';
import { dur, shortId, stamp, wholeCounts } from '../format.js';
import { href } from '../route.js';
import { isFailed, runType } from '../runs.js';
import { labelSuggestions } from '../runspage/run-words.js';
import { pendingRunOf, useDeleteRun } from './delete-run.js';
import { useApp } from '../state.js';
import { errorText } from '../toast.js';
import { ForkMenu, type PendingAction } from './actions.js';
import { failureText, fixCheckText } from './banner.js';
import { nextStepOf } from './next-step.js';
import { BlameBesideButton, CompareButton, NextStepButton, PlainPackAsGolden, ReplayButton } from './NextStepButton.js';
import { TraceLink } from './TraceLink.js';
import { exitWords, type PresetAttempt } from './preset.js';
import { checksOf, forkKindWords, recordingWords, runDuration, runLikeOf } from './model.js';
import { canPush, pushTitle } from './share.js';
// The share job's drawer offers the link it made, as the run's page loads, whether Share has opened or not.
import './share-link.js';
import { ActionButton, useWhenFree } from '../components/ActionButton.js';
import { fitHead, moreRows, useMetaCard, type MoreRow } from './fit-head.js';
import { fitWork } from './fit-work.js';
import { onShow } from '../components/OnShow.js';
import { useServedParts, type ShareMenuProps } from '../served-parts.js';

/** Delete run's dialog, which a run's page rarely opens: a part of its own, with Find breaking commit's (OnShow.tsx). */
const DeleteRunDialog = onShow(() => import('./RunDialogs.js').then((m) => m.DeleteRunDialog));
/**
 * Share's menu, a part of its own for the same reason, which only the served dashboard hands in
 * (served-parts.ts): an exported copy draws no Share, so its script holds no menu. Nothing where none
 * was handed in.
 */
function ShareMenuPart(props: ShareMenuProps) {
  const { ShareMenu } = useServedParts();
  return ShareMenu ? <ShareMenu {...props} /> : null;
}

/**
 * The run's header, as every page's: what kind of run it is, muted, over its id (decision 10: the id
 * is the run's name), a Tab stop whose card says its command, revision, time and failure; under it the
 * one quiet line that says what it was about with its labels after it, and the facts at its right
 * (`facts`, how it came out first); at the right what can be done with it: compare, share, replay,
 * fork at the selected call, the lime next step last, and … with Delete run and whatever folded into
 * it (fit-head.ts). Its lineage is in the crumbs; a phone, which has no crumbs, names the parent in
 * the eyebrow. The next step is the server's (src/next-step.ts); every other action stays, plain. No
 * chip says how the run stands: its first fact does.
 */
export function RunHeader({ run, call, selected, rescued, offers, forkMenu, onAction, onFindCommit, preset = null, labels: given, setLabels: setGiven, onMark = null, facts = null, judged }: {
  run: RunDetail;
  call: CallDetail | null;
  selected: number | null;
  /** The fork blame rescued a run with: a fork of its own, as its eyebrow says, though blame made it as a probe. */
  rescued: boolean;
  offers: RunOffers | null;
  forkMenu: ReturnType<typeof useMenu>;
  onAction: (p: PendingAction) => void;
  onFindCommit: () => void;
  preset?: PresetAttempt | null;
  /** The run's labels as the page shows them (useRunLabels), and how a change of them is shown; the run's own without. */
  labels?: readonly string[];
  setLabels?: (labels: string[]) => void;
  /** A press of the good/bad key; without it, the header has no key. */
  onMark?: ((m: RunMark, from?: HTMLElement) => void) | null;
  /** The facts, how it came out first: the page's, which holds what they're worked out from. */
  facts?: ReactNode;
  /** Its verdict by today's checks, the first fact's (useJudgedAt): undefined while they judge it, when no plain Pack as golden… shows. */
  judged?: RunDetail['judged'];
}) {
  const app = useApp();
  const { exported, toast, client, guard, hasKind } = app;
  const r = run.run;
  // The page's labels when it keeps them (the good/bad key changes them too), else the run's, kept here.
  const [own, setOwn] = useState<string[] | null>(null);
  const labels = given ?? own ?? r.meta?.labels ?? [];
  const setLabels = setGiven ?? setOwn;
  const like = runLikeOf(run);
  const type = runType(like);
  const live = r.status === 'running';
  const share = useMenu();
  // Its script loads as the pointer or the focus reaches Share, so the menu opens at once.
  const served = useServedParts();
  const preloadShare = () => served.ShareMenu?.preload();
  const next = nextStepOf(run);
  const lead = next ? <NextStepButton key={next.key} run={run} step={next} offers={offers} onAction={onAction} onFindCommit={onFindCommit} /> : null;
  // The lineage is in the crumbs; a phone, which has none, reads the parent here, after the kind.
  const parent = run.parent ? (
    <span className="ebp">
      <span className="ebof">of</span>
      <a href={href.run(run.parent.runId)} title={app.runs?.find((x) => x.runId === run.parent!.runId)?.about?.text ?? run.parent.label}>
        <code>{shortId(run.parent.runId)}</code>
      </a>
    </span>
  ) : null;
  // Failed, as Runs, the sidebar and the Overview say it: the server's state.
  const failed = isFailed(like);
  const outcome = like.outcome ?? null;
  // Why it failed, in the CLI's words: the check it failed and what the run did against it
  // ("send_email called 1 time, but called 2 times (2 blocked)"), the agent's exit, a fix's check. A
  // test that diverged failed there, as `shadowlap test` says it; one whose golden may fork, on its checks.
  const d = r.divergence;
  const failure = !failed
    ? null
    : type === 'test' && d && (!outcome || outcome.kind === 'diverged')
      ? `diverged at call ${d.callNo} (${d.kind} ${d.name})`
      : (failureText({ status: r.status, checks: checksOf(run), blame: null, outcome, calls: run.calls }) ?? (run.fix?.check ? fixCheckText(run.fix.check, run.calls) : null));
  // What kind of run it is, said once and only that, muted, on one line: its golden and what it
  // changed are its about line, under the id; how it stands is the first fact, and why it failed the
  // id's card. An attempt says it is one (its finding says which); a fork, where it forked.
  const forkWords = forkKindWords(run, type, rescued);
  const kind = forkWords ? forkWords : type === 'clean' ? 'clean replay' : type === 'replay' ? 'replay' : type === 'test' ? 'test replay' : type === 'capture' ? 'capture' : recordingWords(r);
  const eyebrow = (
    <Eyebrow className="ek">
      <span className="ebk">{kind}</span>
      {parent}
    </Eyebrow>
  );
  // The about line, unless it only says what the eyebrow says (a clean replay): then the labels sit
  // on the id's row after Copy ID. An import's about line names its file, which the meta line leaves out.
  const about = run.about ?? null;
  const ownAbout = !!about?.text && about.text.toLowerCase() !== kind.toLowerCase();
  const head = useRef<HTMLElement>(null);
  // Once it is fitted, the calls list under it keeps to the room it leaves (fit-work.ts).
  useFitAbouts(head, fitHead, fitWorkUnder);
  useMetaCard(head);
  // Push: a run only on this machine goes to the team store the config names.
  const pushable = canPush({ exported, live, team: offers?.team, hasPush: hasKind(JOB_KINDS.push) });
  return (
    // The DOM's order is the mock's (title, about line, facts, card, buttons): `order` draws the buttons
    // beside the title, Tab reaches them last, and a stacked header reads as it is drawn.
    <section className="rhead" ref={head}>
      <div className="rtitle">
        {eyebrow}
        {/* The whole id is Copy ID's card: the heading's own title would show over the meta card it describes. */}
        <h1 className="rnm" tabIndex={0} aria-describedby="rmeta" data-run={r.runId} ref={headingRef}>
          {shortId(r.runId)}
        </h1>
        <button className="linkbtn" type="button" data-tip={tipText(r.runId)} onClick={() => void copyText(r.runId).then((ok) => toast(ok ? 'Copied the run id' : 'Copying was refused by the browser'))}>
          <Icon name="copy" />
          Copy ID
        </button>
        {ownAbout ? null : <Labels run={run} labels={labels} setLabels={setLabels} onMark={onMark} />}
      </div>
      {ownAbout ? (
        <div className="rabout">
          <AboutLine about={about} />
          <Labels run={run} labels={labels} setLabels={setLabels} onMark={onMark} />
        </div>
      ) : null}
      {facts}
      <div className="meta" id="rmeta" role="note">
        {run.source && about?.from === 'source' ? null : run.source ? (
          <span className="src" title={run.source}>
            from <code>{run.source}</code>
          </span>
        ) : (
          <code className="cmd" title={r.command.argv.join(' ')}>
            {r.command.argv.join(' ')}
          </code>
        )}
        {r.codeVersion ? (
          <span>
            rev <code>{r.codeVersion}</code>
          </span>
        ) : null}
        {/* Its start and its duration are one piece, so the duration never stands alone on a line. */}
        <span className="mwhen">
          <span>{stamp(r.startedAt)}</span>
          {live ? <span>recording…</span> : runDuration(run) !== null ? <span>{dur(runDuration(run)!)}</span> : null}
        </span>
        {failure ? <span className="mfail">{wholeCounts(failure)}</span> : null}
        {/* A fork whose agent exited with an error says so, the preset's failure in red: the run's own state counts an injected failure as no failure. */}
        {!failure && type === 'fork' && exitWords(r.status, preset) ? <span className={preset?.verdict === 'failed' ? 'mfail' : undefined}>{exitWords(r.status, preset)}</span> : null}
      </div>
      <div className="actions">
        {next?.key === 'compare' ? null : <CompareButton run={run} />}<TraceLink trace={run.trace} />
        {exported ? lead : (
          <>
            <ActionButton className="btn" id="shareBtn" reads aria-haspopup="menu" aria-expanded={share.open} onPointerEnter={preloadShare} onFocus={preloadShare} onClick={(e) => share.toggle(e.currentTarget)}>
              <Icon name="share" />
              Share
              <Icon name="caret" className="caret" />
            </ActionButton>
            {pushable ? (
              <ActionButton className="btn" data-fold="push" tip="Push" sub={pushTitle(offers!.team!)} command={`$ shadowlap push ${shortId(r.runId)}`} onClick={() => guard(() => app.watchJob(client.startJob(JOB_KINDS.push, { runIds: [r.runId] })))}>
                Push
              </ActionButton>
            ) : null}
            {next?.key === 'replay' ? null : <ReplayButton run={run} step={run.replay ?? null} lime={false} onAction={onAction} />}
            <PlainPackAsGolden run={run} offers={offers} next={next} judged={judged} />
            <BlameBesideButton runId={r.runId} step={next} />
            <ActionButton className="btn" id="forkBtn" aria-haspopup="menu" aria-expanded={forkMenu.open} why={live ? 'Fork once the recording finishes' : null} disabled={!live && selected === null} {...cardUnlessIdle(selected === null, 'Each change in the menu shows the flag it runs')} onClick={(e) => forkMenu.toggle(e.currentTarget)} {...shortcut('fork')}>
              <Icon name="fork" />
              Fork at #{selected ?? '–'}
              <Icon name="caret" className="caret" />
            </ActionButton>
            {lead}
            <MoreMenu run={run} offers={offers} live={live} />
          </>
        )}
      </div>
      {share.open && share.anchor ? <ShareMenuPart anchor={share.anchor} run={run} offers={offers} onClose={share.close} onAction={onAction} /> : null}
      {forkMenu.open && forkMenu.anchor ? <ForkMenu anchor={forkMenu.anchor} run={run} call={call && call.call.callNo === selected ? call : null} offers={offers} onPick={onAction} onFindCommit={onFindCommit} onClose={forkMenu.close} /> : null}
    </section>
  );
}

/** Why a recording can't be deleted yet: the server refuses it. */
const DELETE_WAITS = 'A run that is still recording can’t be deleted';

/**
 * The header's …: what a run page needs rarely. The buttons the header folded in, where they would
 * have wrapped, each as it was (its card, its wait, a press of the button itself, so its own dialog
 * opens as from the header), then Delete run, which waits while the run records.
 */
function MoreMenu({ run, offers, live }: { run: RunDetail; offers: RunOffers | null; live: boolean }) {
  const { guard, toast } = useApp();
  const more = useMenu();
  const [rows, setRows] = useState<MoreRow[]>([]);
  const [deleting, setDeleting] = useState(false);
  const deleteRun = useDeleteRun();
  const id = shortId(run.run.runId);
  const pick = (row: MoreRow) => {
    more.close();
    if (row.off) toast(row.why ?? row.label, 'notice');
    else row.press();
  };
  return (
    <>
      <button
        className="btn quiet more"
        type="button"
        id="moreBtn"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={more.open}
        data-tip={tipText('More: Delete')}
        onClick={(e) => {
          setRows(moreRows(e.currentTarget.parentElement));
          more.toggle(e.currentTarget);
        }}
      >
        <Icon name="more" />
      </button>
      {more.open && more.anchor ? (
        <Popover anchor={more.anchor} onClose={more.close} label="More actions" className="fkm more narrow">
          {rows.map((row) =>
            row.href && !row.why ? (
              <a key={row.key} role="menuitem" href={row.href} data-tip={row.tip ?? undefined} onClick={more.close}>
                <b>{row.label}</b>
              </a>
            ) : (
              <button key={row.key} type="button" role="menuitem" aria-disabled={row.why ? 'true' : undefined} data-why={row.why ?? undefined} data-tip={row.tip ?? undefined} onClick={() => pick(row)}>
                <b>{row.label}</b>
              </button>
            ),
          )}
          {rows.length ? <hr /> : null}
          <ActionButton role="menuitem" className="dz" why={live ? DELETE_WAITS : null} tip={`Delete ${id}`} sub="Removes the run, its attempts and the recorded data nothing else uses; asks first" command={`$ shadowlap rm ${id}`} onClick={() => guard(() => (more.close(), setDeleting(true)))}>
            <b>Delete run</b>
            <small>rm</small>
          </ActionButton>
        </Popover>
      ) : null}
      {deleting ? (
        // As Runs' Delete and `shadowlap rm` delete it: with the attempts bundled under it, named here
        // and counted when it is done.
        <DeleteRunDialog runId={run.run.runId} attempts={run.attempts ?? 0} onClose={() => setDeleting(false)} onOk={() => deleteRun(pendingRunOf(run, offers))} />
      ) : null}
    </>
  );
}

/** The run page's calls list, fitted to the room the header leaves it. */
const fitWorkUnder = (head: HTMLElement) => fitWork(head.closest<HTMLElement>('.rv'));

/**
 * A button's card, which says its key; none where it is off with no words for why (`idle`, no call
 * picked). Why it waits (a run still recording) is ActionButton's `why`: a card, a toast on a press,
 * and a focus, which a disabled button's title never reaches from the keyboard or a touch screen.
 */
const cardUnlessIdle = (idle: boolean, card: string) => (idle ? {} : { 'data-tip': tipText(card) });

/**
 * A label's ×: the label goes at once, the focus to Add label where the × had it, and the toast's Undo
 * puts it back (last, as the server appends). A removal the server refuses puts the labels back as
 * they were, and says why.
 */
function useRemoveLabel(runId: string, shown: readonly string[], setLabels: (labels: string[]) => void): (label: string, from: HTMLElement, add: HTMLElement | null) => void {
  const { client, toast, guard, refresh } = useApp();
  const id = shortId(runId);
  return (label, from, add) =>
    guard(() => {
      const before = [...shown];
      const had = document.activeElement === from;
      setLabels(before.filter((l) => l !== label));
      if (had) add?.focus();
      void client.labels(runId, [], [label]).then(
        (r) => {
          setLabels(r.labels);
          refresh();
          const back = () =>
            guard(() =>
              void client.labels(runId, [label], []).then(
                (u) => {
                  setLabels(u.labels);
                  refresh();
                  toast(`${label} is back on ${id}`);
                },
                (err: unknown) => toast(errorText(err), 'error'),
              ),
            );
          toast(`Removed ${label} from ${id}`, 'notice', { label: 'Undo', undo: true, returnTo: add, run: back });
        },
        (err: unknown) => {
          setLabels(before);
          toast(errorText(err), 'error');
        },
      );
    });
}

/**
 * Labels: the good/bad key first (good and bad are its, so no chip says them again), then the other
 * labels as chips with ×, and Add label for a new one (Enter adds, Esc cancels), offering as you type
 * the labels the runs carry, most used first, as Runs' Add label… does.
 */
function Labels({ run, labels: shown, setLabels, onMark }: { run: RunDetail; labels: readonly string[]; setLabels: (labels: string[]) => void; onMark: ((m: RunMark, from?: HTMLElement) => void) | null }) {
  const { client, actionsOff, exported, toast, refresh, guard, runs } = useApp();
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState('');
  const listId = useId();
  const suggestions = adding ? labelSuggestions(runs) : undefined;
  const enabled = !exported && !actionsOff;
  // Enter while the server is out of reach says why, the field kept open with what was typed.
  const whenFree = useWhenFree();
  const change = (add: string[], remove: string[]) =>
    guard(() =>
      void client.labels(run.run.runId, add, remove).then(
        (r) => {
          setLabels(r.labels);
          refresh();
        },
        (err: unknown) => toast(errorText(err), 'error'),
      ),
    );
  const remove = useRemoveLabel(run.run.runId, shown, setLabels);
  const addRef = useRef<HTMLButtonElement>(null);
  const keyed = !!onMark && (enabled || MARKS.some((m) => shown.includes(m)));
  if (!shown.length && !enabled) return null;
  return (
    <span className="labelbar">
      {keyed ? <RunKey runId={run.run.runId} labels={shown} onMark={onMark} off={exported ? 'An exported copy changes nothing' : (actionsOff ?? null)} /> : null}
      {(keyed ? shown.filter((l) => !(MARKS as readonly string[]).includes(l)) : shown).map((l) => (
        <span className="chip" key={l}>
          {l}
          {enabled ? (
            <ActionButton aria-label={`Remove label ${l}`} onClick={(e) => remove(l, e.currentTarget, addRef.current)}>
              ×
            </ActionButton>
          ) : null}
        </span>
      ))}
      {adding ? (
        <input
          autoFocus
          placeholder="label, then Enter"
          maxLength={40}
          value={value}
          aria-label="New label"
          {...suggestedList(listId, suggestions)}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => !value.trim() && setAdding(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const v = value.trim();
              whenFree(() => {
                if (v && !shown.includes(v)) change([v], []);
                setValue('');
                setAdding(false);
              });
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              setValue('');
              setAdding(false);
            }
          }}
        />
      ) : enabled ? (
        <ActionButton ref={addRef} className="linkbtn" onClick={() => setAdding(true)}>
          <Icon name="plus" />
          Add label
        </ActionButton>
      ) : null}
      <Suggestions id={listId} values={suggestions} />
    </span>
  );
}
