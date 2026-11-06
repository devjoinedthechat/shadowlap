import { useRef, useState } from 'react';
import { JOB_KINDS, type CallDetail, type RunDetail, type RunOffers } from '../api.js';
import { AboutLine, useFitAbouts } from '../components/About.js';
import { Eyebrow, Tag } from '../components/bits.js';
import { RunKey } from '../components/RunKey.js';
import { MARKS, type RunMark } from '../runkey.js';
import { tipText } from '../components/HoverCard.js';
import { Icon } from '../components/Icon.js';
import { useMenu } from '../components/Popover.js';
import { copyText } from '../dom.js';
import { headingRef } from '../focus-manager.js';
import { shortcut } from '../shortcuts.js';
import { dur, shortId, stamp, wholeCounts } from '../format.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { headerStatus, isFailed, runType } from '../runs.js';
import { bulkToast } from '../runspage/bulk.js';
import { DeleteRunDialog } from './RunDialogs.js';
import { useApp } from '../state.js';
import { errorText } from '../toast.js';
import { ForkMenu, type PendingAction } from './actions.js';
import { failureText, fixCheckText } from './banner.js';
import { nextStepOf } from './next-step.js';
import { BlameBesideButton, CompareButton, NextStepButton, PlainPackAsGolden, ReplayButton } from './NextStepButton.js';
import { exitWords, presetTag, type PresetAttempt } from './preset.js';
import { checksOf, forkKindWords, recordingWords, runDuration, runLikeOf } from './model.js';
import { canPush, pushTitle } from './share.js';
import { ShareMenu } from './ShareMenu.js';
import { ActionButton, useWhenFree } from '../components/ActionButton.js';

/**
 * The run's header: what kind of run it is, its id as its heading (decision 10: the id is the run's
 * name), the one quiet line that says what it was about with its labels after it, its command and
 * timing, and what can be done with it: compare, share, replay, fork at the selected call, delete.
 * Its lineage is in the crumbs; a phone, which has no crumbs, names the parent in the eyebrow. The
 * one lime button is the run's next step, as the server works it out (src/next-step.ts); every other
 * action stays, plain.
 */
export function RunHeader({ run, call, selected, rescued, offers, forkMenu, onAction, onFindCommit, preset = null, labels: given, setLabels: setGiven, onMark = null }: {
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
}) {
  const app = useApp();
  const { exported, toast, client, guard, refresh, hasKind } = app;
  const r = run.run;
  // The page's labels when it keeps them (the good/bad key changes them too), else the run's, kept here.
  const [own, setOwn] = useState<string[] | null>(null);
  const labels = given ?? own ?? r.meta?.labels ?? [];
  const setLabels = setGiven ?? setOwn;
  const like = runLikeOf(run);
  const type = runType(like);
  const live = r.status === 'running';
  // The chip says how the run stands, and nothing else: what kind of run it is is the eyebrow's, why it
  // failed the meta line's. A preset's attempt takes its status from the preset's verdict: its run
  // alone reads as a healthy fork.
  const tag = preset ? presetTag(preset) : headerStatus(like);
  const share = useMenu();
  const [deleting, setDeleting] = useState(false);
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
  // What kind of run it is, said once and only that: its golden and what it changed are its about
  // line, under the id; how it stands is the chip beside the id, and why it failed the meta line.
  // An attempt says it is one (its banner says which and how it came out); a fork, where it forked.
  const forkWords = forkKindWords(run, type, rescued);
  const kind = live ? 'recording' : forkWords ? forkWords : type === 'clean' ? 'clean replay' : type === 'replay' ? 'replay' : type === 'test' ? 'test replay' : type === 'capture' ? 'imported from a capture' : recordingWords(r);
  // A fork, or an attempt, keeps its own colour.
  const eyebrow = (
    <Eyebrow tone={!live && forkWords ? 'fork' : undefined}>
      <span className="ebk">{kind}</span>
      {parent}
    </Eyebrow>
  );
  // The about line, unless it only says what the eyebrow says (a clean replay): then the labels sit
  // on the id's row after Copy ID. An import's about line names its file, which the meta line leaves out.
  const about = run.about ?? null;
  const ownAbout = !!about?.text && about.text.toLowerCase() !== kind.toLowerCase();
  const head = useRef<HTMLElement>(null);
  useFitAbouts(head);
  // Push: a run only on this machine goes to the team store the config names.
  const pushable = canPush({ exported, live, team: offers?.team, hasPush: hasKind(JOB_KINDS.push) });
  return (
    <section className="rhead" ref={head}>
      <div className="rmain">
        {eyebrow}
        <div className="rtitle">
          <h1 className="rnm" title={r.runId} ref={headingRef}>
            {shortId(r.runId)}
          </h1>
          {tag ? <Tag cls={tag.cls}>{tag.text}</Tag> : null}
          <button className="linkbtn" type="button" onClick={() => void copyText(r.runId).then((ok) => toast(ok ? 'Copied the run id' : 'Copying was refused by the browser'))}>
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
        <div className="meta">
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
          <span>{stamp(r.startedAt)}</span>
          {live ? <span>recording…</span> : runDuration(run) !== null ? <span>{dur(runDuration(run)!)}</span> : null}
          {failure ? <span className="bad">{wholeCounts(failure)}</span> : null}
          {/* A fork whose agent exited with an error says so, the preset's failure in red: the run's own state counts an injected failure as no failure. */}
          {!failure && type === 'fork' && exitWords(r.status, preset) ? <span className={preset?.verdict === 'failed' ? 'bad' : undefined}>{exitWords(r.status, preset)}</span> : null}
        </div>
      </div>
      <div className="actions">
        {next?.key === 'compare' ? null : <CompareButton run={run} />}
        {exported ? lead : (
          <>
            <ActionButton className="btn" reads aria-haspopup="menu" aria-expanded={share.open} onClick={(e) => share.toggle(e.currentTarget)}>
              <Icon name="share" />
              Share
              <Icon name="caret" className="caret" />
            </ActionButton>
            {pushable ? (
              <ActionButton className="btn" title={pushTitle(offers!.team!)} onClick={() => guard(() => app.watchJob(client.startJob(JOB_KINDS.push, { runIds: [r.runId] })))}>
                Push
              </ActionButton>
            ) : null}
            {next?.key === 'replay' ? null : <ReplayButton run={run} step={run.replay ?? null} lime={false} onAction={onAction} />}
            <PlainPackAsGolden run={run} offers={offers} next={next} />
            <BlameBesideButton runId={r.runId} step={next} />
            <ActionButton className="btn" id="forkBtn" aria-haspopup="menu" aria-expanded={forkMenu.open} disabled={live || selected === null} {...offOrCard(live ? 'Fork once the recording finishes' : undefined, selected === null, 'Each change in the menu shows the flag it runs')} onClick={(e) => forkMenu.toggle(e.currentTarget)} {...shortcut('fork')}>
              <Icon name="fork" />
              Fork at #{selected ?? '–'}
              <Icon name="caret" className="caret" />
            </ActionButton>
            {lead}
            <ActionButton className="btn quiet dz" why={live ? 'A run that is still recording can’t be deleted' : null} onClick={() => guard(() => setDeleting(true))}>
              Delete
            </ActionButton>
          </>
        )}
      </div>
      {share.open && share.anchor ? <ShareMenu anchor={share.anchor} run={run} offers={offers} onClose={share.close} onAction={onAction} /> : null}
      {forkMenu.open && forkMenu.anchor ? <ForkMenu anchor={forkMenu.anchor} run={run} call={call && call.call.callNo === selected ? call : null} offers={offers} onPick={onAction} onFindCommit={onFindCommit} onClose={forkMenu.close} /> : null}
      {deleting ? (
        // As Runs' Delete and `shadowlap rm` delete it: with the attempts bundled under it, named here
        // and counted when it is done.
        <DeleteRunDialog
          runId={r.runId}
          attempts={run.attempts ?? 0}
          onClose={() => setDeleting(false)}
          onOk={() => {
            client.remove(r.runId).then(
              (out) => {
                toast(bulkToast({ verb: 'Deleted', done: [r.runId], of: 1, skipped: [], attempts: out.attempts?.length ?? 0 }));
                refresh();
                navigate(href.runs());
              },
              (err: unknown) => toast(errorText(err), 'error'),
            );
          }}
        />
      ) : null}
    </section>
  );
}

/** A button's hover, as every disabled button's: why it is off, which a browser shows on one; nothing where it is off with no words for why (`idle`); else its card, which says its key. */
const offOrCard = (off: string | null | undefined, idle: boolean, card: string) => (off ? { title: off } : idle ? {} : { 'data-tip': tipText(card) });

/**
 * Labels: the good/bad key first (good and bad are its, so no chip says them again), then the other
 * labels as chips with ×, and + Label for a new one (Enter adds, Esc cancels).
 */
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

function Labels({ run, labels: shown, setLabels, onMark }: { run: RunDetail; labels: readonly string[]; setLabels: (labels: string[]) => void; onMark: ((m: RunMark, from?: HTMLElement) => void) | null }) {
  const { client, actionsOff, exported, toast, refresh, guard } = useApp();
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState('');
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
          Label
        </ActionButton>
      ) : null}
    </span>
  );
}
