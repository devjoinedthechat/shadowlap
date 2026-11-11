import type { Store } from '@shadowlap/engine';
import { dayIndex, type LocalDay } from './local-days.js';
import type { DaySums, TimeWindow, WeekSums } from './overview.js';

/**
 * Spent live's part that no run holds, added to the week's, last week's and each day's money on the
 * day it was spent: what a preview of a change or a migration spent asking and judging
 * (`decisionSpend`), and what a repair's own model answered (`repairerSpend`). What they replayed is
 * runs, priced with the rest: a preview's verify, a repair's blame and its candidates' verify. So
 * each dollar counts once, as a fix's cost counts the repairer apart from its attempts.
 */
export function addSpendNoRunHolds(store: Store, windows: { week: TimeWindow; lastWeek: TimeWindow }, weekDays: readonly LocalDay[], sums: { week: WeekSums; lastWeek: WeekSums }, daily: DaySums[]): void {
  const { week, lastWeek } = windows;
  for (const { at, spent } of [...store.decisionSpend(lastWeek.from, week.to), ...store.repairerSpend(lastWeek.from, week.to)]) {
    if (!spent) continue;
    (at >= week.from ? sums.week : sums.lastWeek).spent += spent;
    const i = dayIndex(weekDays, at);
    if (i >= 0) daily[i]!.spent += spent;
  }
}
