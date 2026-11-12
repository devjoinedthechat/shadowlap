import { LoadFailed } from '../components/bits.js';
import { onShow } from '../components/OnShow.js';
import { Skeleton } from '../components/States.js';
import { BuilderLost } from '../run/check-part.js';
import type { ServedParts } from '../served-parts.js';

/**
 * The parts only the served dashboard draws (served-parts.ts), each a script of its own that loads the
 * first time it shows (OnShow.tsx). Only App.tsx imports this module, so an exported copy's script
 * (main-copy.tsx) holds none of them.
 */
export const SERVED_PARTS: ServedParts = {
  ShareMenu: onShow(() => import('../run/ShareMenu.js').then((m) => m.ShareMenu)),
  ForkMenu: onShow(() => import('../run/ForkMenu.js').then((m) => m.ForkMenu)),
  MoreMenu: onShow(() => import('../run/MoreMenu.js').then((m) => m.MoreMenu)),
  CheckBuilder: onShow(() => import('../checks/Builder.js').then((m) => m.Builder), { failed: <BuilderLost /> }),
  CheckMenu: onShow(() => import('../run/CheckMenu.js').then((m) => m.CheckMenu)),
  RunBlameAsks: onShow(() => import('../fixes/RunBlameAsks.js').then((m) => m.RunBlameAsks)),
  StepDialog: onShow(() => import('../run/StepDialogs.js').then((m) => m.StepDialog)),
  TestDialog: onShow(() => import('../injection/TestDialog.js').then((m) => m.TestDialog)),
  PackWithGate: onShow(() => import('../injection/PackWithGate.js').then((m) => m.PackWithGate)),
  FindCause: onShow(() => import('../injection/FindCause.js').then((m) => m.FindCause)),
  CauseFinding: onShow(() => import('../injection/CauseFinding.js').then((m) => m.CauseFinding)),
  SecurityReportDialog: onShow(() => import('../injection/SecurityReportDialog.js').then((m) => m.SecurityReportDialog)),
  InjectionFinding: onShow(() => import('../injection/InjectionFinding.js').then((m) => m.InjectionFinding)),
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
