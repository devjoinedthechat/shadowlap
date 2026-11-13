import { createContext, useContext, type ComponentProps, type ComponentType } from 'react';
import type { ApplyConfigDialog } from './changes/ApplyConfigDialog.js';
import type { NewPreviewProps } from './changes/NewPreview.js';
import type { PrCommentDialog } from './ci/PrCommentDialog.js';
import type { OnShow } from './components/OnShow.js';
import type { RunBlameAsks } from './fixes/RunBlameAsks.js';
import type { AttemptPage } from './injection/AttemptPage.js';
import type { CauseFinding } from './injection/CauseFinding.js';
import type { FindCause } from './injection/FindCause.js';
import type { InjectionFinding } from './injection/InjectionFinding.js';
import type { InjectionResults } from './injection/InjectionResults.js';
import type { PackWithGate } from './injection/PackWithGate.js';
import type { Proof } from './injection/Proof.js';
import type { SecurityReportDialog } from './injection/SecurityReportDialog.js';
import type { TestDialog } from './injection/TestDialog.js';
import type * as JobWordsModule from './jobs.js';
import type { PackDialogProps } from './not-covered/PackDialog.js';
import type { ElsewhereProps } from './pages/held-elsewhere.js';
import type { PresetsDialog } from './presets/PresetsDialog.js';
import type { PresetsFinding } from './presets/PresetsFinding.js';
import type { PresetsResults } from './presets/PresetsResults.js';
import type { ChangeBoxProps } from './revert/ChangeBox.js';
import type { RevertDialogProps } from './revert/RevertDialog.js';
import type { ActionDialog } from './run/ActionDialog.js';
import type { BuilderProps, CheckMenuProps } from './run/check-part.js';
import type { DivergedDialogs } from './run/DivergedDialogs.js';
import type { EditDialog } from './run/EditDialog.js';
import type { ForkMenu } from './run/ForkMenu.js';
import type { MoreMenu } from './run/MoreMenu.js';
import type { BisectDialog } from './run/RunDialogs.js';
import type { ShareMenu } from './run/ShareMenu.js';
import type { StepDialog } from './run/StepDialogs.js';
import type { FailedIssuesProps } from './runspage/FailedIssues.js';
import type { Palette } from './shell/Palette.js';
import type { RemoveProjectDialog } from './shell/RemoveProject.js';

/** What Share's menu takes (run/ShareMenu.tsx), named here so a page draws it without importing it. */
export type ShareMenuProps = ComponentProps<typeof ShareMenu>;
/** What Run blame's dialogs take (fixes/RunBlameAsks.tsx), named here for the same reason. */
export type RunBlameAsksProps = ComponentProps<typeof RunBlameAsks>;
/** What the fork menu takes (run/ForkMenu.tsx), and the header's … (run/MoreMenu.tsx). */
export type ForkMenuProps = ComponentProps<typeof ForkMenu>;
export type MoreMenuProps = ComponentProps<typeof MoreMenu>;
export type InjectionResultsProps = ComponentProps<typeof InjectionResults>;
export type StepDialogProps = ComponentProps<typeof StepDialog>;
export type SecurityReportProps = ComponentProps<typeof SecurityReportDialog>;
export type ProofProps = ComponentProps<typeof Proof>;
export type InjectionFindingProps = ComponentProps<typeof InjectionFinding>;
export type TestDialogProps = ComponentProps<typeof TestDialog>;
export type PackWithGateProps = ComponentProps<typeof PackWithGate>;
export type FindCauseProps = ComponentProps<typeof FindCause>;
export type CauseFindingProps = ComponentProps<typeof CauseFinding>;
export type PresetsDialogProps = ComponentProps<typeof PresetsDialog>;
export type PresetsFindingProps = ComponentProps<typeof PresetsFinding>;
export type PresetsResultsProps = ComponentProps<typeof PresetsResults>;
export type { PackDialogProps };
export type { FailedIssuesProps };
/** What the shell's parts a copy never draws take: the palette and Remove project's dialog (the job's drawer takes nothing). */
export type PaletteProps = ComponentProps<typeof Palette>;
export type RemoveProjectProps = ComponentProps<typeof RemoveProjectDialog>;
/** What a run's page's dialogs a copy never opens take: an action's, Find breaking commit's, a diverged test's and Edit and fork's. */
export type ActionDialogProps = ComponentProps<typeof ActionDialog>;
export type BisectDialogProps = ComponentProps<typeof BisectDialog>;
export type DivergedDialogsProps = ComponentProps<typeof DivergedDialogs>;
export type EditDialogProps = ComponentProps<typeof EditDialog>;
/** What Preview pull request comment's dialog takes (ci/PrCommentDialog.tsx), which Settings → CI and the newest revision's page open. */
export type PrCommentDialogProps = ComponentProps<typeof PrCommentDialog>;
/** What Apply config change?'s dialog takes (changes/ApplyConfigDialog.tsx), which the Migrate report's Apply config change opens. */
export type ApplyConfigDialogProps = ComponentProps<typeof ApplyConfigDialog>;
/** The words of a job's kind (jobs.ts), which come with the job's drawer. */
export type JobWords = typeof JobWordsModule;

/**
 * The parts a page draws only where the dashboard runs, never in an exported copy, handed in by the
 * served entry (App.tsx, from pages/served.tsx) as it hands the shell its pages: a copy's script then
 * holds none of their code, and a page that finds one missing draws nothing in its place. What keeps
 * each undrawn in a copy is pinned by a test. test/ui-exported-copy.test.ts: a copy's run page draws
 * no Share, so nothing there opens Share's menu, no Fork at #n in its header or on a row and no …,
 * so nothing opens the fork menu or the header's, and no Add check…, so nothing opens the check
 * menu or the builder; a copy's next step is only ever Compare, so it draws no Run blame either,
 * and no step that asks; it draws no Run injection test… (its fork menu, step and palette rows are
 * the served dashboard's) nor Pack with injection gate…, no Run error-path presets… (its fork menu
 * and palette rows are the served dashboard's), and no Find cause… nor the answers it finds; it
 * keeps no error-path presets, so the run they ran on draws neither their finding nor their
 * results; its Runs keeps Failed a filter, so draws no issues; New preview waits in a copy, as
 * every server action does, so its menu never opens there. test/ui-revert-copy.test.ts: a copy's
 * run has no revert step and no offers, so no first bad commit to show, and its Tests page is not
 * in it.
 * test/ui-injection-results.test.ts: a copy keeps no injection results, so its run page draws no
 * test's finding to open them from, and no Share to download a report from; a copy keeps no
 * attempt's read, so an attempt's page there draws no proof and marks nothing. And the shell's
 * and a run's page's parts a copy never draws (test/ui-exported-copy.test.ts again): its client
 * starts and follows no job, so it draws no job's drawer and needs none of its words; its actions
 * wait (`actionsOff`), so no action and no Find breaking commit asks in a dialog; it runs no job of
 * a test's, so a diverged test asks in none; Edit and fork draws nothing there; its meta draws the
 * copy's own block in the project switcher's place, so nothing opens Remove project; a page that
 * can't find what a link names says so itself, never asking another project; ⌘K, `/` and the
 * top bar open no palette; a copy sends Settings → CI and a revision's page under Changes to its
 * runs, so nothing opens Preview pull request comment; and test/ui-migrate.test.ts: a copy's
 * migration offers no Apply config change, so nothing opens its dialog.
 */
export interface ServedParts {
  /** Share's menu (run/ShareMenu.tsx), with its Export dataset… and Export OpenTelemetry trace…: loaded ahead as the pointer or the focus reaches Share, so it opens at once. */
  ShareMenu?: OnShow<ShareMenuProps>;
  /** The fork menu at a call (run/ForkMenu.tsx), with Find breaking commit's price: loaded ahead as the pointer or the focus reaches Fork at #n or a row's fork button, so it opens at once. */
  ForkMenu?: OnShow<ForkMenuProps>;
  /** The header's … (run/MoreMenu.tsx), what folded into it then Delete run, with its dialog and Delete run's helper: loaded ahead as the pointer or the focus reaches …. */
  MoreMenu?: OnShow<MoreMenuProps>;
  /** Revert's dialog (revert/RevertDialog.tsx), which every Revert button opens. */
  RevertDialog?: ComponentType<RevertDialogProps>;
  /** The first bad commit's change in its file's box (revert/ChangeBox.tsx), in the run page's inspector's place: Tests draws it at once. */
  ChangeBox?: ComponentType<ChangeBoxProps>;
  /** The check builder (checks/Builder.tsx), which only Add check… opens (run/check-entry.tsx): loaded ahead as a row's menu offers Add check…, as the pointer or the focus reaches it on the inspector, or as its check menu opens, so it shows at once on a pick. */
  CheckBuilder?: OnShow<BuilderProps>;
  /** What Run blame asks in once pressed (fixes/RunBlameAsks.tsx), with the check a blame needs: loaded the first time one asks. */
  RunBlameAsks?: OnShow<RunBlameAsksProps>;
  /** New preview's three dialogs (changes/NewPreview.tsx), which a pick in its menu opens (components/NewPreviewMenu.tsx): loaded ahead as the pointer or the focus reaches New preview. */
  NewPreview?: OnShow<NewPreviewProps>;
  /** The check menu at a tool call (run/CheckMenu.tsx), whose pick opens the builder: loaded ahead with the builder, and a page handed one without the other offers no Add check…. */
  CheckMenu?: OnShow<CheckMenuProps>;
  /** Runs › Failed as issues (runspage/FailedIssues.tsx): a copy keeps Failed a filter over its runs. */
  FailedIssues?: OnShow<FailedIssuesProps>;
  /** An injection test's results in the inspector's place (injection/InjectionResults.tsx), with the matrix they draw: loaded ahead as the pointer or the focus reaches Show results. */
  InjectionResults?: OnShow<InjectionResultsProps>;
  /** The dialogs the run page's steps ask in, Pack as golden…'s too (run/StepDialogs.tsx): loaded as one first shows. */
  StepDialog?: OnShow<StepDialogProps>;
  /** Run injection test…'s dialog (injection/TestDialog.tsx): the fork menu's whole run, the lime step, a read's row on Settings → Tools, Tests' Security and the palette open it. Loaded as it first shows. */
  TestDialog?: OnShow<TestDialogProps>;
  /** Run error-path presets…'s dialog (presets/PresetsDialog.tsx): the fork menu's whole run, a golden's row on Tests and the palette open it. Loaded as it first shows. */
  PresetsDialog?: OnShow<PresetsDialogProps>;
  /** A recording's error-path presets as a finding on its page (presets/PresetsFinding.tsx), with its Show results: loaded as a run's page first draws one. */
  PresetsFinding?: OnShow<PresetsFindingProps>;
  /** A recording's presets in the inspector's place (presets/PresetsResults.tsx), with the matrix they draw: loaded ahead as the pointer or the focus reaches Show results. */
  PresetsResults?: OnShow<PresetsResultsProps>;
  /** Not covered's Pack as golden and Pack with checks… (not-covered/PackDialog.tsx): its rows on Tests and Needs a look's step open it. Loaded as it first shows. */
  PackDialog?: OnShow<PackDialogProps>;
  /** Pack with injection gate…'s dialog (injection/PackWithGate.tsx), which the run's lime step opens where a read caused a write or an attempt obeyed. Loaded as it first shows. */
  PackWithGate?: OnShow<PackWithGateProps>;
  /** Find cause… on a write after an untrusted read, the inspector's link and its dialog (injection/FindCause.tsx): loaded as the inspector first shows on a run that has a write to ask about. */
  FindCause?: OnShow<FindCauseProps>;
  /** The run's `--clean` answers as a finding (injection/CauseFinding.tsx): loaded as a run's page first draws one. */
  CauseFinding?: OnShow<CauseFindingProps>;
  /** A kept injection result's Security report, its masks and canaries read first (injection/SecurityReportDialog.tsx): Share's row opens it. */
  SecurityReportDialog?: OnShow<SecurityReportProps>;
  /** A kept injection test's finding on the run it tested (injection/InjectionFinding.tsx), with its Show results: loaded as a run's page first draws one. */
  InjectionFinding?: OnShow<InjectionFindingProps>;
  /** An injection attempt's proof line in its finding (injection/Proof.tsx): loaded as an attempt's page first draws it. */
  Proof?: OnShow<ProofProps>;
  /** What only an injection attempt's page does (injection/AttemptPage.tsx): its inspector's marks, the tab a call its proof names opens on and the scroll to its mark. Loaded once a page reads an attempt (injection/attempt-load.ts). */
  attemptPage?: () => Promise<AttemptPage>;
  /** The palette (shell/Palette.tsx), which the shell draws closed as it first draws, so it opens at once: only ⌘K, `/`, the top bar's Search or jump to… and Enter on a row with actions open it. */
  Palette?: OnShow<PaletteProps>;
  /** The job's drawer (components/Drawer.tsx): loaded as the first job shows. */
  JobDrawer?: OnShow<object>;
  /** The words of a job's kind (jobs.ts), which the drawer brings: asked for as a hidden job's chip shows, and as a job a newer one took the drawer from ends. */
  jobs?: () => Promise<JobWords>;
  /** Remove project's dialog (shell/RemoveProject.tsx), which the project switcher and Settings › Project open: loaded ahead as the switcher opens. */
  RemoveProject?: OnShow<RemoveProjectProps>;
  /** The dialog a run's action asks in (run/ActionDialog.tsx): loaded the first time an action asks something first. */
  ActionDialog?: OnShow<ActionDialogProps>;
  /** Find breaking commit's dialog (run/RunDialogs.tsx), with Delete run's, which the header's … opens. */
  BisectDialog?: OnShow<BisectDialogProps>;
  /** A diverged test's dialogs (run/DivergedDialogs.tsx): Update golden's, and Add normalizer and re-run's where it re-records the golden. */
  DivergedDialogs?: OnShow<DivergedDialogsProps>;
  /** Edit and fork's dialog (run/EditDialog.tsx). */
  EditDialog?: OnShow<EditDialogProps>;
  /** Preview pull request comment's dialog (ci/PrCommentDialog.tsx), one script for Settings → CI and the newest revision's page under Changes, which both open it: loaded the first time one does. */
  PrCommentDialog?: OnShow<PrCommentDialogProps>;
  /** Apply config change?'s dialog (changes/ApplyConfigDialog.tsx), which only the Migrate report's Apply config change opens: loaded the first time it does. */
  ApplyConfigDialog?: OnShow<ApplyConfigDialogProps>;
  /** The In page (pages/Elsewhere.tsx), in the place of a page's not-found while another project on this machine holds what a link names: the page's own loading look while its script comes, and its own not-found should it fail to come. */
  Elsewhere?: OnShow<ElsewhereProps>;
}

export const ServedPartsContext = createContext<ServedParts>({});

/** The parts the served dashboard handed in; none in a copy. */
export const useServedParts = (): ServedParts => useContext(ServedPartsContext);
