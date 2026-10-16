import { useState } from 'react';
import { JOB_KINDS, type CallDetail, type RunDetail, type RunOffers } from '../api.js';
import { Eyebrow, Tag } from '../components/bits.js';
import { ConfirmDialog } from '../components/Dialog.js';
import { Icon } from '../components/Icon.js';
import { useMenu } from '../components/Popover.js';
import { copyText } from '../dom.js';
import { dur, shortId, stamp } from '../format.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { compareTarget, isFailed, isInterrupted, runTag, runType } from '../runs.js';
import { useApp } from '../state.js';
import { ForkMenu, type PendingAction } from './actions.js';
import { failureText, fixCheckShort } from './banner.js';
import { checksOf, runLikeOf } from './model.js';
import { canPush } from './share.js';
import { ShareMenu } from './ShareMenu.js';

/**
 * The run's header: what it is and where it came from, its id, labels, command and timing, and what
 * can be done with it: compare, share, replay, fork at the selected call, delete.
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
  const parent = run.parent ? <a href={href.run(run.parent.runId)}>{shortId(run.parent.runId)}</a> : null;
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
      : (failureText({ status: r.status, checks: checksOf(run), blame: null, outcome, calls: run.calls }, true) ?? (run.fix?.check ? fixCheckShort(run.fix.check, run.calls) : null));
  const checkFailed = !!failure?.startsWith('check failed');
  // An interrupted run says so after what it is, in grey: it stopped, it did not fail.
  const stopped = cut ? ' · interrupted' : '';
  const eyebrow = live ? (
    <Eyebrow>recording now</Eyebrow>
  ) : type === 'fork' ? (
    <Eyebrow tone="fork">
      {rescued ? 'rescued by blame · ' : ''}fork @{r.divergence!.callNo}
      {parent ? <> of {parent}</> : null}
      {stopped}
    </Eyebrow>
  ) : type === 'clean' || type === 'replay' ? (
    <Eyebrow tone={failed ? 'err' : cut ? 'n' : undefined}>
      {type === 'clean' ? 'clean replay' : failed ? 'replay · failed' : 'replay'}
      {parent ? <> of {parent}</> : null}
      {stopped}
    </Eyebrow>
  ) : type === 'test' ? (
    <Eyebrow tone={failed ? 'err' : cut ? 'n' : undefined}>
      test replay{parent ? <> of {parent}</> : null}
      {r.meta?.test?.golden ? (
        <>
          {' · '}
          <code>{r.meta.test.golden}</code>
        </>
      ) : null}
      {stopped}
    </Eyebrow>
  ) : type === 'capture' ? (
    <Eyebrow>imported from a capture</Eyebrow>
  ) : (
    <Eyebrow tone={failed ? 'err' : cut ? 'n' : undefined}>{failed ? (checkFailed ? 'recording · check failed' : 'recording · failed') : cut ? 'recording · interrupted' : r.meta?.imported ? 'recording · from a pack' : 'recording'}</Eyebrow>
  );
  const off = actionsOff ?? undefined;
  // Push: a run only on this machine goes to the team store the config names.
  const pushable = canPush({ exported, live, team: offers?.team, hasPush: hasKind(JOB_KINDS.push) });
  return (
    <section className="rhead">
      <div className="rmain">
        {eyebrow}
        <div className="rtitle">
          <h1 title={r.runId}>{shortId(r.runId)}</h1>
          <Tag cls={tag.cls}>{tag.text}</Tag>
          <button className="linkbtn" type="button" onClick={() => void copyText(r.runId).then((ok) => toast(ok ? 'Copied the run id' : 'Copying was refused by the browser'))}>
            <Icon name="copy" />
            Copy ID
          </button>
          <Labels run={run} />
        </div>
        <div className="meta">
          {run.source ? (
            <span>
              from <code>{run.source}</code>
            </span>
          ) : (
            <code>{r.command.argv.join(' ')}</code>
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
                title={off ?? `Copy this run to the team store, ${offers!.team!.store}, with the runs it came from`}
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
              (err: unknown) => toast(err instanceof Error ? err.message : String(err)),
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
        (err: unknown) => toast(err instanceof Error ? err.message : String(err)),
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
