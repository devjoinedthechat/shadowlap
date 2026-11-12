import { createContext, useContext, type ComponentProps } from 'react';
import type { OnShow } from './components/OnShow.js';
import type { RunBlameAsks } from './fixes/RunBlameAsks.js';
import type { AttemptPage } from './injection/AttemptPage.js';
import type { CauseFinding } from './injection/CauseFinding.js';
import type { FindCause } from './injection/FindCause.js';
import type { InjectionFinding } from './injection/InjectionFinding.js';
import type { InjectionResults } from './injection/InjectionResults.js';
import type { Proof } from './injection/Proof.js';
import type { SecurityReportDialog } from './injection/SecurityReportDialog.js';
import type { TestDialog } from './injection/TestDialog.js';
import type { BuilderProps } from './run/check-part.js';
import type { CheckMenu } from './run/CheckMenu.js';
import type { ForkMenu } from './run/ForkMenu.js';
import type { MoreMenu } from './run/MoreMenu.js';
import type { ShareMenu } from './run/ShareMenu.js';
import type { StepDialog } from './run/StepDialogs.js';

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
export type FindCauseProps = ComponentProps<typeof FindCause>;
export type CauseFindingProps = ComponentProps<typeof CauseFinding>;

/**
 * The parts a page draws only where the dashboard runs, never in an exported copy, handed in by the
 * served entry (App.tsx, from pages/served.tsx) as it hands the shell its pages: a copy's script then
 * holds none of their code, and a page that finds one missing draws nothing in its place. What keeps
 * each undrawn in a copy is pinned by a test (test/ui-exported-copy.test.ts: a copy's run page draws
 * no Share, so nothing there opens Share's menu, no Fork at #n in its header or on a row and no …,
 * so nothing opens the fork menu or the header's, and no Add check…, so nothing opens the check menu or the builder; a
 * copy's next step is only ever Compare, so it draws no Run blame either, and no step that asks; a
 * copy keeps no injection results, so its run page draws no test's finding to open them from, no
 * Run injection test… (its fork menu and step are the served dashboard's), no Find cause… nor the answers it finds, and no Share to download a report from; a copy keeps no attempt's read, so an attempt's page there
 * draws no proof and marks nothing, test/ui-injection-results.test.ts).
 */
export interface ServedParts {
  /** Share's menu (run/ShareMenu.tsx), with its Export dataset… and Export OpenTelemetry trace…: loaded ahead as the pointer or the focus reaches Share, so it opens at once. */
  ShareMenu?: OnShow<ShareMenuProps>;
  /** The fork menu at a call (run/ForkMenu.tsx), with Find breaking commit's price: loaded ahead as the pointer or the focus reaches Fork at #n or a row's fork button, so it opens at once. */
  ForkMenu?: OnShow<ForkMenuProps>;
  /** The header's … (run/MoreMenu.tsx), what folded into it then Delete run, with its dialog and Delete run's helper: loaded ahead as the pointer or the focus reaches …. */
  MoreMenu?: OnShow<MoreMenuProps>;
  /** The check builder (checks/Builder.tsx), which only Add check… opens (run/check-entry.tsx): loaded ahead as a row's menu offers Add check…, as the pointer or the focus reaches it on the inspector, or as its check menu opens, so it shows at once on a pick. */
  CheckBuilder?: OnShow<BuilderProps>;
  /** The check menu at a call (run/CheckMenu.tsx), its rules by the call's arguments and Ask a judge…: loaded ahead with the builder, as a row's menu offers Add check… or the pointer or the focus reaches it on the inspector. */
  CheckMenu?: OnShow<CheckMenuProps>;
  /** What Run blame asks in once pressed (fixes/RunBlameAsks.tsx), with the check a blame needs: loaded the first time one asks. */
  RunBlameAsks?: OnShow<RunBlameAsksProps>;
  /** An injection test's results in the inspector's place (injection/InjectionResults.tsx), with the matrix they draw: loaded ahead as the pointer or the focus reaches Show results. */
  InjectionResults?: OnShow<InjectionResultsProps>;
  /** The dialogs the run page's steps ask in, Pack as golden…'s too (run/StepDialogs.tsx): loaded as one first shows. */
  StepDialog?: OnShow<StepDialogProps>;
  /** Run injection test…'s dialog (injection/TestDialog.tsx): the fork menu's whole run, the lime step, a read's row on Settings → Tools, Tests' Security and the palette open it. Loaded as it first shows. */
  TestDialog?: OnShow<TestDialogProps>;
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
