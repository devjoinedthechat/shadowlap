import { useEffect } from 'react';
import { LoadFailed, loadFailedText } from '../components/bits.js';
import { onShow, type OnShowOptions } from '../components/OnShow.js';
import { Skeleton } from '../components/States.js';
import { useLatest } from '../hooks.js';
import { BuilderLost } from '../run/check-part.js';
import { IssuesLoading } from '../runspage/IssuesLoading.js';
import type { FindCauseProps, InjectionFindingProps, MoreMenuProps, ServedParts } from '../served-parts.js';
import { useApp } from '../state.js';

/** How a part that opens on a press stands, by its props: open unless they say otherwise, and how it closes. */
interface Pressed {
  open?: boolean;
  close: () => void;
}

/** A part that closes through its `onClose`, open for as long as it is drawn. */
const closes = (props: { onClose: () => void }): Pressed => ({ close: props.onClose });

/**
 * In the place of a part that opens on a press, once its script didn't come: nothing, so the focus
 * stays on what was pressed, and the error toast in LoadFailed's words, whose Retry loads the page
 * again, waiting while the server can't be reached (`guard`), as LoadFailed's does. The part closes as
 * the toast comes, so its button no longer says it is open, and the next press says it again.
 */
function PressLost({ what, open, close }: { what: 'menu' | 'dialog'; open: boolean; close: () => void }) {
  const { toast, guard } = useApp();
  const closing = useLatest(close);
  useEffect(() => {
    if (!open) return;
    toast(loadFailedText(what), 'error', { label: 'Retry', run: () => void guard(() => location.reload()) });
    closing.current();
  }, [open, what, toast, guard, closing]);
  return null;
}

/**
 * The one `failed` of the parts that open on a press: Share's menu and the Security report it opens,
 * the fork menu, the header's …, the check menu, Revert's dialog, Run blame's dialogs, the steps'
 * dialogs, Run injection test…'s and Pack with injection gate…'s, each a `menu` or a `dialog` in the
 * toast's words. The parts drawn in place keep their own: the first bad commit's change box's
 * LoadFailed, the check builder's BuilderLost, Runs › Failed's issues' LoadFailed, the results
 * panel's LoadFailed, Find cause…'s (CauseLost), and an injection test's finding's and Find cause's
 * answers' (FindingLost).
 */
const failed = <P,>(what: 'menu' | 'dialog', pressed: (props: P) => Pressed): OnShowOptions<P> => ({
  failed: (props) => {
    const { open = true, close } = pressed(props);
    return <PressLost what={what} open={open} close={close} />;
  },
});

/**
 * In the place of an injection test's finding, or of Find cause's answers, once its script didn't
 * come: LoadFailed's line in the finding's slot of the run's findings bar, rather than nothing, which
 * would hide what the test or the answers found. As the finding would, it hides while the bar is
 * closed under the finding that leads it (`fx`), and where it leads the bar, it keeps the bar's
 * toggle at its end (`more`), so the rest still opens.
 */
function FindingLost({ finding, fx, more }: Pick<InjectionFindingProps, 'fx' | 'more'> & { finding: 'injection' | 'cause' }) {
  return (
    <div className={`banner wrap${fx ? ' fx' : ''}`} data-finding={finding}>
      <LoadFailed what="finding" />
      {more}
    </div>
  );
}

/**
 * In the place of Find cause…'s link, once its script didn't come: LoadFailed's line on a write the
 * run's answer names (`cause.facts`), the one call the link is drawn on, and nothing on the others.
 */
function CauseLost({ callNo, cause }: Pick<FindCauseProps, 'callNo' | 'cause'>) {
  return cause.facts.some((f) => f.write === callNo) ? <LoadFailed what="link" /> : null;
}

/**
 * The parts only the served dashboard draws (served-parts.ts), each a script of its own that loads the
 * first time it shows (OnShow.tsx). Only App.tsx imports this module, so an exported copy's script
 * (main-copy.tsx) holds none of them.
 */
export const SERVED_PARTS: ServedParts = {
  ShareMenu: onShow(() => import('../run/ShareMenu.js').then((m) => m.ShareMenu), failed('menu', closes)),
  ForkMenu: onShow(() => import('../run/ForkMenu.js').then((m) => m.ForkMenu), failed('menu', closes)),
  // Drawn from the first press on, so Delete run's dialog outlives the menu: open while its button says so.
  MoreMenu: onShow(() => import('../run/MoreMenu.js').then((m) => m.MoreMenu), failed('menu', (p: MoreMenuProps) => p.more)),
  RevertDialog: onShow(() => import('../revert/RevertDialog.js').then((m) => m.RevertDialog), failed('dialog', closes)),
  ChangeBox: onShow(() => import('../revert/ChangeBox.js').then((m) => m.ChangeBox), { failed: <LoadFailed what="change" /> }),
  CheckBuilder: onShow(() => import('../checks/Builder.js').then((m) => m.Builder), { failed: <BuilderLost /> }),
  RunBlameAsks: onShow(() => import('../fixes/RunBlameAsks.js').then((m) => m.RunBlameAsks), failed('dialog', closes)),
  CheckMenu: onShow(() => import('../run/CheckMenu.js').then((m) => m.CheckMenu), failed('menu', closes)),
  FailedIssues: onShow(() => import('../runspage/FailedIssues.js').then((m) => m.FailedIssues), { waiting: <IssuesLoading />, failed: <LoadFailed what="view" /> }),
  StepDialog: onShow(() => import('../run/StepDialogs.js').then((m) => m.StepDialog), failed('dialog', closes)),
  TestDialog: onShow(() => import('../injection/TestDialog.js').then((m) => m.TestDialog), failed('dialog', closes)),
  PackWithGate: onShow(() => import('../injection/PackWithGate.js').then((m) => m.PackWithGate), failed('dialog', closes)),
  FindCause: onShow(() => import('../injection/FindCause.js').then((m) => m.FindCause), { failed: (p) => <CauseLost callNo={p.callNo} cause={p.cause} /> }),
  CauseFinding: onShow(() => import('../injection/CauseFinding.js').then((m) => m.CauseFinding), { failed: (p) => <FindingLost finding="cause" fx={p.fx} more={p.more} /> }),
  SecurityReportDialog: onShow(() => import('../injection/SecurityReportDialog.js').then((m) => m.SecurityReportDialog), failed('dialog', closes)),
  InjectionFinding: onShow(() => import('../injection/InjectionFinding.js').then((m) => m.InjectionFinding), { failed: (p) => <FindingLost finding="injection" fx={p.fx} more={p.more} /> }),
  // A line inside an attempt's finding, which the run's page draws: nothing in its place if its script didn't come.
  Proof: onShow(() => import('../injection/Proof.js').then((m) => m.Proof)),
  attemptPage: () => import('../injection/AttemptPage.js').then((m) => m.ATTEMPT_PAGE),
  // The matrix's script starts as the panel's comes, so Show results opens on both.
  InjectionResults: onShow(
    () =>
      import('../injection/InjectionResults.js').then((m) => {
        m.preloadMatrix();
        return m.InjectionResults;
      }),
    { waiting: <Skeleton what="the results" lines={4} />, failed: <LoadFailed what="panel" /> },
  ),
};
