/**
 * Needs a look's groups, in their order, with their heads: what holds the team up first, then what
 * fails, what is ready to ship, what the tests leave open, what an injection test found, and what
 * keeps the project tidy. No imports: the page reads it as it is.
 */
export const LOOK_GROUPS = [
  ['setup', 'Setup'],
  ['failing', 'Failing'],
  ['ship', 'Ready to ship'],
  ['tests', 'Tests'],
  ['security', 'Security'],
  ['housekeeping', 'Housekeeping'],
] as const;

export type LookGroup = (typeof LOOK_GROUPS)[number][0];
