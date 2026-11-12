import { useState, type ReactElement } from 'react';
import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import type { PreviewEstimates } from '../estimates-api.js';
import { shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { ACTIONS, confirmWords } from '../labels.js';
import { useServedParts } from '../served-parts.js';
import { useApp } from '../state.js';
import { ActionButton } from './ActionButton.js';
import { tipText } from './HoverCard.js';
import { Icon } from './Icon.js';
import { tipEst, useBilledPress } from './JobButton.js';
import { Popover, useMenu } from './Popover.js';

/**
 * New preview: the three ways a preview changes a run's recorded model calls, each with the flag it
 * runs, on every golden (Preview), on the runs picked (Runs' Preview change) or on one run (its
 * Decisions view). It lives outside ui/changes/, which only Changes loads; its dialogs come in through
 * the served parts (ui/changes/NewPreview.tsx), so an exported copy draws none of them.
 */

/** Who a new preview asks: every golden (`count`, the project's goldens where known), the runs picked, or one run. */
export type PreviewTarget = { goldens: 'all'; count?: number } | { runs: readonly string[] };

/** Said where there is nothing to preview on: no golden yet. */
export const NO_GOLDENS = 'No goldens yet: pack a run as a golden, or preview a change on one run from its Decisions view.';

/** Whether a target names nothing to ask: no run, or every golden of a project that has none. */
export const noTargets = (t: PreviewTarget): boolean => ('runs' in t ? !t.runs.length : t.count === 0);

/** A way a preview changes the calls: the model, the working tree's prompt and tools, or a request field. */
export type PreviewWay = 'model' | 'code' | 'field';

/** The ways in the menu's order, each with the flag it runs. */
export const PREVIEW_WAYS: ReadonlyArray<{ way: PreviewWay; label: string; flag: string }> = [
  { way: 'model', label: ACTIONS.previewModelSwitch.label, flag: '--model' },
  { way: 'code', label: ACTIONS.previewChangedPrompt.label, flag: '--from-code' },
  { way: 'field', label: ACTIONS.previewFieldChange.label, flag: '--set' },
];

/** The menu's head: `On every golden`, `On 2 runs`, `On <id>`. */
export function targetHead(t: PreviewTarget): string {
  if ('goldens' in t) return 'On every golden';
  return t.runs.length === 1 ? `On ${shortId(t.runs[0]!)}` : `On ${t.runs.length} runs`;
}

/** The menu's head as it draws: one run's id set as code. */
function TargetHead({ target }: { target: PreviewTarget }) {
  if ('runs' in target && target.runs.length === 1)
    return (
      <>
        On <code className="rnm">{shortId(target.runs[0]!)}</code>
      </>
    );
  return <>{targetHead(target)}</>;
}

/** What the targets read as on a command's card: `goldens/*`, or the runs' ids. */
export const targetWords = (t: PreviewTarget): string => ('goldens' in t ? 'goldens/*' : t.runs.map(shortId).join(' '));

/** Each way's command on a button's card, as the way's dialog runs it at its default. */
export function wayCommand(way: PreviewWay, t: PreviewTarget): string {
  const head = `$ shadowlap decisions ${targetWords(t)}`;
  return way === 'model' ? `${head} --model <model>` : way === 'code' ? `${head} --from-code --samples 1` : `${head} --set <key=value> --samples 1`;
}

/** A way's price on its card, from the menu's read: the changed prompt has none until its dialog reads the working tree; undefined while the read is out. */
export function wayPrice(way: PreviewWay, ways: PreviewEstimates['ways'] | undefined): Estimate | null | undefined {
  if (way === 'code') return null;
  if (ways === undefined) return undefined;
  return (way === 'model' ? ways?.modelSwitch : ways?.fieldChange) ?? null;
}

/** The three ways' cards priced as they open: one read of every way's default, none in a copy or a dashboard that runs nothing. */
export function useWayPrices(target: PreviewTarget, on: boolean): PreviewEstimates['ways'] | undefined {
  const { client, exported, actionsOff } = useApp();
  const api = client.estimates;
  const key = 'goldens' in target ? 'goldens' : target.runs.join(',');
  const asks = on && !noTargets(target);
  const read = useLoad(() => (asks && api && !exported && !actionsOff ? api.previewEstimates(target) : null), `preview-ways:${asks ? key : ''}`);
  return read.data ? read.data.ways : read.error ? null : undefined;
}

/** Opens a way's dialog where the served dashboard handed it in; nothing in a copy. */
export function usePreviewDialog(target: PreviewTarget): { open: (way: PreviewWay) => void; preload: () => void; dialog: ReactElement | null } {
  const { NewPreview } = useServedParts();
  const [way, setWay] = useState<PreviewWay | null>(null);
  return {
    open: setWay,
    preload: () => NewPreview?.preload(),
    dialog: way && NewPreview ? <NewPreview way={way} target={target} onClose={() => setWay(null)} /> : null,
  };
}

export interface NewPreviewMenuProps {
  target: PreviewTarget;
  /** Lime, where another change is the next step. */
  lime?: boolean;
  small?: boolean;
  /** Why it can't open yet: a run still recording. */
  why?: string | null;
  /** Runs' `Preview change`, its card the runs it takes, in place of New preview's own. */
  bulk?: { label: string; tip: string; whyTip?: string | undefined; command: string };
}

/** `New preview`, its menu and the dialog a pick opens. */
export function NewPreviewMenu({ target, lime = false, small = false, why = null, bulk }: NewPreviewMenuProps) {
  const menu = useMenu();
  const press = useBilledPress();
  const dialog = usePreviewDialog(target);
  const ways = useWayPrices(target, menu.open);
  const pick = (way: PreviewWay) => {
    menu.close();
    const show = () => dialog.open(way);
    press({ estimate: wayPrice(way, ways), form: true, start: show, ask: show });
  };
  return (
    <>
      <ActionButton
        className={`btn${lime ? ' lime' : ''}${small ? ' sm' : ''}`}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        why={why}
        {...(bulk ? { tip: bulk.tip, whyTip: bulk.whyTip, command: bulk.command } : { 'data-tip': tipText('Each way shows the flag it runs') })}
        onPointerEnter={dialog.preload}
        onFocus={dialog.preload}
        onClick={(e) => menu.toggle(e.currentTarget)}
      >
        {bulk ? (
          bulk.label
        ) : (
          <>
            <Icon name="plus" />
            {ACTIONS.newPreview.label}
            <Icon name="caret" className="caret" />
          </>
        )}
      </ActionButton>
      {menu.anchor ? (
        <Popover anchor={menu.anchor} onClose={menu.close} className="fkm" label={ACTIONS.newPreview.label}>
          <div className="pk">
            <TargetHead target={target} />
          </div>
          {PREVIEW_WAYS.map((w) => (
            <ActionButton key={w.way} role="menuitem" tip={confirmWords(w.label)} est={tipEst(wayPrice(w.way, ways), true)} onClick={() => pick(w.way)}>
              <b>{w.label}</b>
              <small>{w.flag}</small>
            </ActionButton>
          ))}
        </Popover>
      ) : null}
      {dialog.dialog}
    </>
  );
}

/** The three ways as buttons, each card with its command: on Preview's empty tab the first lime, on a run nobody previewed small and plain. */
export function PreviewWayButtons({ target, why = null, small = false, plain = false }: { target: PreviewTarget; why?: string | null; small?: boolean; plain?: boolean }) {
  const press = useBilledPress();
  const dialog = usePreviewDialog(target);
  const ways = useWayPrices(target, true);
  return (
    <div className="actions">
      {PREVIEW_WAYS.map((w, i) => (
        <ActionButton
          key={w.way}
          className={`btn${i === 0 && !plain ? ' lime' : ''}${small ? ' sm' : ''}`}
          why={why}
          tip={confirmWords(w.label)}
          command={wayCommand(w.way, target)}
          est={tipEst(wayPrice(w.way, ways), true)}
          onPointerEnter={dialog.preload}
          onFocus={dialog.preload}
          onClick={() => {
            const show = () => dialog.open(w.way);
            press({ estimate: wayPrice(w.way, ways), form: true, start: show, ask: show });
          }}
        >
          {w.label}
        </ActionButton>
      ))}
      {dialog.dialog}
    </div>
  );
}
