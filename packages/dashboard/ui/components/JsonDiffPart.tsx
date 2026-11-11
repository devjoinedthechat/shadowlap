import { LoadFailed } from './bits.js';
import { onShow } from './OnShow.js';
import { Skeleton } from './States.js';

/**
 * The structural diff (JsonDiff.tsx), a script of its own that loads the first time one shows:
 * Show diff, Compare and a test's report draw it. test/ui-bundle-size.test.ts fails the build if
 * it loads with a page.
 */
export const JsonDiffPart = onShow(() => import('./JsonDiff.js').then((m) => m.JsonDiff), { waiting: <Skeleton what="diff" lines={6} />, failed: <LoadFailed what="diff" /> });
