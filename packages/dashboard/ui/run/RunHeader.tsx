import { useRef, useState, type ReactNode } from 'react';
import { JOB_KINDS, type CallDetail, type RunDetail, type RunOffers } from '../api.js';
import { AboutLine, useFitAbouts } from '../components/About.js';
import { Eyebrow, Tag } from '../components/bits.js';
import { ConfirmDialog } from '../components/Dialog.js';
import { Icon } from '../components/Icon.js';
import { useMenu } from '../components/Popover.js';
import { copyText } from '../dom.js';
import { dur, shortId, stamp } from '../format.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { compareTarget, failedWord, isFailed, isInterrupted, runTag, runType } from '../runs.js';
import { useApp } from '../state.js';
import { errorText } from '../toast.js';
import { ForkMenu, type PendingAction } from './actions.js';
import { failureText, fixCheckShort } from './banner.js';
import { checksOf, recordingWords, runLikeOf } from './model.js';
import { canPush, pushTitle } from './share.js';
import { ShareMenu } from './ShareMenu.js';

/**
 * The run's header: what kind of run it is, its id as its heading (decision 10: the id is the run's
 * name), the one quiet line that says what it was about with its labels after it, its command and
 * timing, and what can be done with it: compare, share, replay, fork at the selected call, delete.
 * Its lineage is in the crumbs; a phone, which has no crumbs, names the parent in the eyebrow.
 */
export function RunHeader({ run, call, selected, rescued, offers, forkMenu, onAction, onFindCommit }: { run: RunDetail; call: CallDetail | null; selected: number | null; rescued: boolean; offers: RunOffers | null; forkMenu: ReturnType<typeof useMenu>; onAction: (p: PendingAction) => void; onFindCommit: () => void }) {
  const app = useApp();
  const { exported, actionsOff, toast, client, guard, refresh, hasKind } = app;
  const r = run.run;
  const like = runLikeOf(run);
  const type = runType(like);
  const live = r.status === 'running';
  const tag = runTag(like);
  const share = useMenu();
  const [deleting, setDeleting] = useState(false);
  const replay = run.actions.find((a) => a.key === 'r');
  const pair = compareTarget(r, run.children);
  // The lineage is in the crumbs; a phone, which has none, reads the parent here, after the kind.
  const parent = run.parent ? (
    <span className="ebp">
      <span className="ebof">of</span>
      <a href={href.run(run.parent.runId)} title={app.runs?.find((x) => x.runId === run.parent!.runId)?.about?.text ?? run.parent.label}>
        <code>{shortId(run.parent.runId)}</code>
      </a>
    </span>
  ) : null;
  // Failed, or only interrupted, as Runs, the sidebar and the Overview say it: the server's state.
  const failed = isFailed(like);
  const cut = isInterrupted(like);
  const outcome = like.outcome ?? null;
  // Why it failed, in a few words: what the run did against the check it failed ("send_email called
  // 1 time"; the banner says what was expected), the agent's exit, a fix's check. A test that
  // diverged failed there, as `shadowlap test` says it; one whose golden may fork, on its checks.
  const d = r.divergence;
  const failure = !failed
    ? null
    : type === 'test' && d && (!outcome || outcome.kind === 'diverged')
      ? `diverged at call ${d.callNo} (${d.kind} ${d.name})`
      : (failureText({ status: r.status, checks: checksOf(run), blame: null, outcome, calls: run.calls }, true) ?? (run.fix?.check ? fixCheckShort(run.fix.check, run.calls, true) : null));
  // A check (blame's among them), or the agent's exit: the word Runs and the sidebar use.
  const checkFailed = !!failure?.startsWith('check failed') || (failed && failedWord(like) === 'check failed');
  // An interrupted run says so after what it is, in grey: it stopped, it did not fail.
  const stopped = cut ? ' · interrupted' : '';
  // What kind of run it is, said once: its golden and what it changed are its about line, under the id.
  const kind = live ? 'recording' : type === 'fork' ? (rescued ? 'rescued fork' : `fork @${r.divergence!.callNo}`) : type === 'clean' ? 'clean replay' : type === 'replay' ? (failed ? 'replay · failed' : 'replay') : type === 'test' ? 'test replay' : type === 'capture' ? 'imported from a capture' : failed ? (checkFailed ? 'recording · check failed' : 'recording · failed') : cut ? 'recording · interrupted' : recordingWords(r);
  const eyebrowOf = (tone: 'fork' | 'err' | 'n' | undefined, tail: ReactNode = null) => (
    <Eyebrow tone={tone}>
      <span className="ebk">{kind}</span>
      {parent}
      {tail}
    </Eyebrow>
  );
  const eyebrow = live
    ? eyebrowOf(undefined)
    : type === 'fork'
      ? // A fork keeps its own colour; that it stopped is said in grey, as on every other run.
        eyebrowOf('fork', cut ? <span className="n">{stopped}</span> : null)
      : type === 'clean' || type === 'replay' || type === 'test'
        ? eyebrowOf(failed ? 'err' : cut ? 'n' : undefined, stopped)
        : type === 'capture'
          ? eyebrowOf(undefined)
          : eyebrowOf(failed ? 'err' : cut ? 'n' : undefined);
  // The about line, unless it only says what the eyebrow says (a clean replay): then the labels sit
  // on the id's row after Copy ID. An import's about line names its file, which the meta line leaves out.
  const about = run.about ?? null;
  const ownAbout = !!about?.text && about.text.toLowerCase() !== kind.toLowerCase();
  const head = useRef<HTMLElement>(null);
  useFitAbouts(head);
  const off = actionsOff ?? undefined;
  // Push: a run only on this machine goes to the team store the config names.
  const pushable = canPush({ exported, live, team: offers?.team, hasPush: hasKind(JOB_KINDS.push) });
  return (
    <section className="rhead" ref={head}>
      <div className="rmain">
        {eyebrow}
        <div className="rtitle">
          <h1 className="rnm" title={r.runId}>
            {shortId(r.runId)}
          </h1>
          <Tag cls={tag.cls}>{tag.text}</Tag>
          <button className="linkbtn" type="button" onClick={() => void copyText(r.runId).then((ok) => toast(ok ? 'Copied the run id' : 'Copying was refused by the browser'))}>
            <Icon name="copy" />
            Copy ID
          </button>
          {ownAbout ? null : <Labels run={run} />}
        </div>
        {ownAbout ? (
          <div className="rabout">
            <AboutLine about={about} />
            <Labels run={run} />
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
          <span>{live ? 'recording…' : run.summary.durationMs !== null ? dur(run.summary.durationMs) : ''}</span>
          {failure ? <span className="bad">{failure}</span> : null}
        </div>
      </div>
      <div className="actions">
        {pair ? (
          <a className="btn" href={href.compare(pair[0], pair[1])}>
            {r.parentRunId ? 'Compare with parent' : 'Compare'}
          </a>
        ) : null}
        {exported ? null : (
          <>
            <button className="btn" type="button" aria-haspopup="menu" aria-expanded={share.open} onClick={(e) => share.toggle(e.currentTarget)}>
              <Icon name="share" />
              Share
              <Icon name="caret" className="caret" />
            </button>
            {pushable ? (
              <button
                className="btn"
                type="button"
                disabled={!!actionsOff}
                title={off ?? pushTitle(offers!.team!)}
                onClick={() => guard(() => app.watchJob(client.startJob(JOB_KINDS.push, { runIds: [r.runId] })))}
              >
                Push
              </button>
            ) : null}
            <button
              className="btn lime"
              type="button"
              disabled={live || !!actionsOff || !replay || !!replay.disabled}
              title={live ? 'Replay once the recording finishes' : (off ?? replay?.disabled ?? undefined)}
              onClick={() => replay && onAction({ action: replay, callNo: null })}
            >
              <Icon name="replay" />
              Replay
            </button>
            <button
              className="btn"
              type="button"
              id="forkBtn"
              aria-haspopup="menu"
              aria-expanded={forkMenu.open}
              disabled={live || !!actionsOff || selected === null}
              title={live ? 'Fork once the recording finishes' : off}
              onClick={(e) => forkMenu.toggle(e.currentTarget)}
            >
              <Icon name="fork" />
              Fork at #{selected ?? '–'}
              <Icon name="caret" className="caret" />
            </button>
            <button className="btn quiet dz" type="button" disabled={live || !!actionsOff} title={live ? 'A run that is still recording can’t be deleted' : off} onClick={() => guard(() => setDeleting(true))}>
              Delete
            </button>
          </>
        )}
      </div>
      {share.open && share.anchor ? <ShareMenu anchor={share.anchor} run={run} offers={offers} onClose={share.close} onAction={onAction} /> : null}
      {forkMenu.open && forkMenu.anchor ? <ForkMenu anchor={forkMenu.anchor} run={run} call={call && call.call.callNo === selected ? call : null} offers={offers} onPick={onAction} onFindCommit={onFindCommit} onClose={forkMenu.close} /> : null}
      {deleting ? (
        <ConfirmDialog
          title={`Delete ${shortId(r.runId)}?`}
          text="This removes the run and the recorded data nothing else uses. Its forks and replays keep their own copies, but lose the link to it."
          command={`shadowlap rm ${shortId(r.runId)}`}
          ok="Delete run"
          danger
          onClose={() => setDeleting(false)}
          onOk={() => {
            setDeleting(false);
            client.remove(r.runId).then(
              () => {
                toast(`Deleted ${shortId(r.runId)}`);
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

/** Labels: chips with ×, and + Label for a new one (Enter adds, Esc cancels). */
function Labels({ run }: { run: RunDetail }) {
  const { client, actionsOff, exported, toast, refresh, guard } = useApp();
  const [labels, setLabels] = useState<string[] | null>(null);
  const shown = labels ?? run.run.meta?.labels ?? [];
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState('');
  const enabled = !exported && !actionsOff;
  const change = (add: string[], remove: string[]) =>
    guard(() =>
      client.labels(run.run.runId, add, remove).then(
        (r) => {
          setLabels(r.labels);
          refresh();
        },
        (err: unknown) => toast(errorText(err), 'error'),
      ),
    );
  if (!shown.length && !enabled) return null;
  return (
    <span className="labelbar">
      {shown.map((l) => (
        <span className="chip" key={l}>
          {l}
          {enabled ? (
            <button type="button" aria-label={`Remove label ${l}`} onClick={() => change([], [l])}>
              ×
            </button>
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
              if (v && !shown.includes(v)) change([v], []);
              setValue('');
              setAdding(false);
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              setValue('');
              setAdding(false);
            }
          }}
        />
      ) : enabled ? (
        <button className="linkbtn" type="button" onClick={() => setAdding(true)}>
          <Icon name="plus" />
          Label
        </button>
      ) : null}
    </span>
  );
}
