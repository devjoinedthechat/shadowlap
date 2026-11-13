import { useEffect } from 'react';
import { LoadFailed, loadFailedText } from '../components/bits.js';
import { onShow, type OnShowOptions } from '../components/OnShow.js';
import { Skeleton } from '../components/States.js';
import { useLatest } from '../hooks.js';
import { BuilderLost } from '../run/check-part.js';
import { IssuesLoading } from '../runspage/IssuesLoading.js';
import type { FindCauseProps, InjectionFindingProps, MoreMenuProps, ServedParts } from '../served-parts.js';
import { useApp } from '../state.js';
import { ElsewhereFallback, ElsewhereWaiting } from './held-elsewhere.js';

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
 * the fork menu, the header's …, the check menu, Revert's dialog, Run blame's dialogs, New
 * preview's dialogs, the steps' dialogs, Run injection test…'s, Run error-path presets…'s, Not
 * covered's pack dialogs and Pack with injection gate…'s, a run's action's, Find breaking commit's,
 * a diverged test's, Edit and fork's, Remove project's, Preview pull request comment's and Apply
 * config change?'s, each a `menu` or a `dialog` in the toast's words. The parts drawn in place keep
 * their own: the first bad commit's change box's LoadFailed, the check builder's BuilderLost, Runs ›
 * Failed's issues' LoadFailed, the injection and the presets results panels' LoadFailed, Find
 * cause…'s (CauseLost), an injection test's finding's, the presets' finding's and Find cause's
 * answers' (FindingLost) and the In page's, its page's not-found. The palette and the job's drawer,
 * drawn before any press asks for them, draw nothing.
 */
const failed = <P,>(what: 'menu' | 'dialog', pressed: (props: P) => Pressed): OnShowOptions<P> => ({
  failed: (props) => {
    const { open = true, close } = pressed(props);
    return <PressLost what={what} open={open} close={close} />;
  },
});

/**
 * In the place of an injection test's finding, a recording's error-path presets' finding or Find
 * cause's answers, once its script didn't come: LoadFailed's line in the finding's slot of the run's
 * findings bar, rather than nothing, which would hide what the test, the presets or the answers
 * found. As the finding would, it hides while the bar is closed under the finding that leads it
 * (`fx`), and where it leads the bar, it keeps the bar's toggle at its end (`more`), so the rest
 * still opens.
 */
function FindingLost({ finding, fx, more }: Pick<InjectionFindingProps, 'fx' | 'more'> & { finding: 'injection' | 'presets' | 'cause' }) {
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
 * (main-copy.tsx) holds none of them: neither those of a run's page nor the shell's palette, job's
 * drawer and Remove project, nor the In page, nor Preview pull request comment's dialog.
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
  NewPreview: onShow(() => import('../changes/NewPreview.js').then((m) => m.NewPreview), failed('dialog', closes)),
  CheckMenu: onShow(() => import('../run/CheckMenu.js').then((m) => m.CheckMenu), failed('menu', closes)),
  FailedIssues: onShow(() => import('../runspage/FailedIssues.js').then((m) => m.FailedIssues), { waiting: <IssuesLoading />, failed: <LoadFailed what="view" /> }),
  StepDialog: onShow(() => import('../run/StepDialogs.js').then((m) => m.StepDialog), failed('dialog', closes)),
  TestDialog: onShow(() => import('../injection/TestDialog.js').then((m) => m.TestDialog), failed('dialog', closes)),
  PresetsDialog: onShow(() => import('../presets/PresetsDialog.js').then((m) => m.PresetsDialog), failed('dialog', closes)),
  PackDialog: onShow(() => import('../not-covered/PackDialog.js').then((m) => m.PackDialog), failed('dialog', closes)),
  PackWithGate: onShow(() => import('../injection/PackWithGate.js').then((m) => m.PackWithGate), failed('dialog', closes)),
  FindCause: onShow(() => import('../injection/FindCause.js').then((m) => m.FindCause), { failed: (p) => <CauseLost callNo={p.callNo} cause={p.cause} /> }),
  CauseFinding: onShow(() => import('../injection/CauseFinding.js').then((m) => m.CauseFinding), { failed: (p) => <FindingLost finding="cause" fx={p.fx} more={p.more} /> }),
  SecurityReportDialog: onShow(() => import('../injection/SecurityReportDialog.js').then((m) => m.SecurityReportDialog), failed('dialog', closes)),
  InjectionFinding: onShow(() => import('../injection/InjectionFinding.js').then((m) => m.InjectionFinding), { failed: (p) => <FindingLost finding="injection" fx={p.fx} more={p.more} /> }),
  PresetsFinding: onShow(() => import('../presets/PresetsFinding.js').then((m) => m.PresetsFinding), { failed: (p) => <FindingLost finding="presets" fx={p.fx} more={p.more} /> }),
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
  PresetsResults: onShow(
    () =>
      import('../presets/PresetsResults.js').then((m) => {
        m.preloadMatrix();
        return m.PresetsResults;
      }),
    { waiting: <Skeleton what="the results" lines={4} />, failed: <LoadFailed what="panel" /> },
  ),
  // The shell's: the palette and the job's drawer load as the shell first draws them, the words of a job's kind with the drawer.
  Palette: onShow(() => import('../shell/Palette.js').then((m) => m.Palette)),
  JobDrawer: onShow(() => import('../components/Drawer.js').then((m) => m.JobDrawer)),
  jobs: () => import('../jobs.js'),
  RemoveProject: onShow(() => import('../shell/RemoveProject.js').then((m) => m.RemoveProjectDialog), failed('dialog', closes)),
  // A run's page's, which it rarely opens.
  ActionDialog: onShow(() => import('../run/ActionDialog.js').then((m) => m.ActionDialog), failed('dialog', closes)),
  BisectDialog: onShow(() => import('../run/RunDialogs.js').then((m) => m.BisectDialog), failed('dialog', closes)),
  DivergedDialogs: onShow(() => import('../run/DivergedDialogs.js').then((m) => m.DivergedDialogs), failed('dialog', closes)),
  EditDialog: onShow(() => import('../run/EditDialog.js').then((m) => m.EditDialog), failed('dialog', closes)),
  // Settings → CI's and the newest revision's, from one script.
  PrCommentDialog: onShow(() => import('../ci/PrCommentDialog.js').then((m) => m.PrCommentDialog), failed('dialog', closes)),
  // The Migrate report's, opened on a press of Apply config change alone.
  ApplyConfigDialog: onShow(() => import('../changes/ApplyConfigDialog.js').then((m) => m.ApplyConfigDialog), failed('dialog', closes)),
  // The page's own looks, from the page that asked (held-elsewhere.tsx), while its script comes and should it fail to come.
  Elsewhere: onShow(() => import('./Elsewhere.js').then((m) => m.ElsewherePage), { waiting: <ElsewhereWaiting />, failed: <ElsewhereFallback /> }),
};
