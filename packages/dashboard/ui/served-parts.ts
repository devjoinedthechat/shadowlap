import { createContext, useContext, type ComponentProps } from 'react';
import type { OnShow } from './components/OnShow.js';
import type { RunBlameAsks } from './fixes/RunBlameAsks.js';
import type { BuilderProps } from './run/check-part.js';
import type { ShareMenu } from './run/ShareMenu.js';
import type { FailedIssuesProps } from './runspage/FailedIssues.js';

/** What Share's menu takes (run/ShareMenu.tsx), named here so a page draws it without importing it. */
export type ShareMenuProps = ComponentProps<typeof ShareMenu>;
/** What Run blame's dialogs take (fixes/RunBlameAsks.tsx), named here for the same reason. */
export type RunBlameAsksProps = ComponentProps<typeof RunBlameAsks>;
export type { FailedIssuesProps };

/**
 * The parts a page draws only where the dashboard runs, never in an exported copy, handed in by the
 * served entry (App.tsx, from pages/served.tsx) as it hands the shell its pages: a copy's script then
 * holds none of their code, and a page that finds one missing draws nothing in its place. What keeps
 * each undrawn in a copy is pinned by a test (test/ui-exported-copy.test.ts: a copy's run page draws
 * no Share, so nothing there opens Share's menu, and no Add check…, so nothing opens the builder; a
 * copy's next step is only ever Compare, so it draws no Run blame either; its Runs keeps Failed a
 * filter, so draws no issues).
 */
export interface ServedParts {
  /** Share's menu (run/ShareMenu.tsx), with its Export dataset… and Export OpenTelemetry trace…: loaded ahead as the pointer or the focus reaches Share, so it opens at once. */
  ShareMenu?: OnShow<ShareMenuProps>;
  /** The check builder (checks/Builder.tsx), which only Add check… opens (run/check-entry.tsx): loaded ahead as a row's menu offers Add check…, as the pointer or the focus reaches it on the inspector, or as its check menu opens, so it shows at once on a pick. */
  CheckBuilder?: OnShow<BuilderProps>;
  /** What Run blame asks in once pressed (fixes/RunBlameAsks.tsx), with the check a blame needs: loaded the first time one asks. */
  RunBlameAsks?: OnShow<RunBlameAsksProps>;
  /** Runs › Failed as issues (runspage/FailedIssues.tsx): a copy keeps Failed a filter over its runs. */
  FailedIssues?: OnShow<FailedIssuesProps>;
}

export const ServedPartsContext = createContext<ServedParts>({});

/** The parts the served dashboard handed in; none in a copy. */
export const useServedParts = (): ServedParts => useContext(ServedPartsContext);
