import { createContext, useContext, type ComponentProps, type ComponentType } from 'react';
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
import type { PresetsDialog } from './presets/PresetsDialog.js';
import type { PresetsFinding } from './presets/PresetsFinding.js';
import type { PresetsResults } from './presets/PresetsResults.js';
import type { ChangeBoxProps } from './revert/ChangeBox.js';
import type { RevertDialogProps } from './revert/RevertDialog.js';
import type { BuilderProps } from './run/check-part.js';
import type { CheckMenu } from './run/CheckMenu.js';
import type { ForkMenu } from './run/ForkMenu.js';
import type { MoreMenu } from './run/MoreMenu.js';
import type { ShareMenu } from './run/ShareMenu.js';
import type { StepDialog } from './run/StepDialogs.js';
import type { FailedIssuesProps } from './runspage/FailedIssues.js';

/** What Share's menu takes (run/ShareMenu.tsx), named here so a page draws it without importing it. */
export type ShareMenuProps = ComponentProps<typeof ShareMenu>;
/** What Run blame's dialogs take (fixes/RunBlameAsks.tsx), named here for the same reason. */
export type RunBlameAsksProps = ComponentProps<typeof RunBlameAsks>;
/** What the fork menu takes (run/ForkMenu.tsx), and the header's … (run/MoreMenu.tsx). */
export type ForkMenuProps = ComponentProps<typeof ForkMenu>;
export type CheckMenuProps = ComponentProps<typeof CheckMenu>;
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
export type { FailedIssuesProps };

/**
 * The parts a page draws only where the dashboard runs, never in an exported copy, handed in by the
 * served entry (App.tsx, from pages/served.tsx) as it hands the shell its pages: a copy's script then
 * holds none of their code, and a page that finds one missing draws nothing in its place. What keeps
 * each undrawn in a copy is pinned by a test. test/ui-exported-copy.test.ts: a copy's run page draws
 * no Share, so nothing there opens Share's menu, no Fork at #n in its header or on a row and no …,
 * so nothing opens the fork menu or the header's, and no Add check…, so nothing opens the check menu
 * or the builder; a copy's next step is only ever Compare, so it draws no Run blame either, and no
 * step that asks; it draws no Run injection test… (its fork menu, step and palette rows are the
 * served dashboard's) nor Pack with injection gate…, no Run error-path presets… (its fork menu and
 * palette rows are the served dashboard's), and no Find cause… nor the answers it finds; it keeps no
 * error-path presets, so the run they ran on draws neither their finding nor their results; its
 * Runs keeps Failed a filter, so draws no issues. test/ui-revert-copy.test.ts: a copy's run has no
 * revert step and no offers, so no first bad commit to show, and its Tests page is not in it.
 * test/ui-injection-results.test.ts: a copy keeps no injection results, so its run page draws no
 * test's finding to open them from, and no Share to download a report from; a copy keeps no
 * attempt's read, so an attempt's page there draws no proof and marks nothing.
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
  /** The check menu at a call (run/CheckMenu.tsx), its rules by the call's arguments and Ask a judge…: loaded ahead with the builder, as a row's menu offers Add check… or the pointer or the focus reaches it on the inspector. */
  CheckMenu?: OnShow<CheckMenuProps>;
  /** What Run blame asks in once pressed (fixes/RunBlameAsks.tsx), with the check a blame needs: loaded the first time one asks. */
  RunBlameAsks?: OnShow<RunBlameAsksProps>;
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
}

export const ServedPartsContext = createContext<ServedParts>({});

/** The parts the served dashboard handed in; none in a copy. */
export const useServedParts = (): ServedParts => useContext(ServedPartsContext);
