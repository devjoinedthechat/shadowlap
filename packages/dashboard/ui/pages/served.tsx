import { onShow } from '../components/OnShow.js';
import { BuilderLost } from '../run/check-part.js';
import type { ServedParts } from '../served-parts.js';

/**
 * The parts only the served dashboard draws (served-parts.ts), each a script of its own that loads the
 * first time it shows (OnShow.tsx). Only App.tsx imports this module, so an exported copy's script
 * (main-copy.tsx) holds none of them.
 */
export const SERVED_PARTS: ServedParts = {
  ShareMenu: onShow(() => import('../run/ShareMenu.js').then((m) => m.ShareMenu)),
  CheckBuilder: onShow(() => import('../checks/Builder.js').then((m) => m.Builder), { failed: <BuilderLost /> }),
  RunBlameAsks: onShow(() => import('../fixes/RunBlameAsks.js').then((m) => m.RunBlameAsks)),
  CheckMenu: onShow(() => import('../run/CheckMenu.js').then((m) => m.CheckMenu), { failed: <BuilderLost /> }),
};
