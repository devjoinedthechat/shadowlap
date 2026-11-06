/**
 * What a golden's jobs do, the sentence under each one's title on its card: the run's next step's and
 * Tests' buttons alike. Apart from the action words, so the dashboard's first look doesn't carry them:
 * only the pages that draw these cards, and the server, import it.
 */
export const GOLDEN_JOB_WORDS = {
  remade: 'It re-records the golden under the change',
  judgeOnce: 'Asks the judge once, live, and keeps its verdict in the pack: every test after judges from the recording, free',
  ruleIn: 'The rule is in shadowlap.config.json: it replays the golden again',
  masksThenReplays: 'Masks the value at match time, then replays the golden offline',
  masksThenRemakes: 'Masks the value at match time, then re-records the golden',
  /** Find breaking commit for a golden that replays, from the commit it last passed at. */
  replaysSince: (good: string): string => `Replays the golden at the commits since ${good}, where it passed, offline: no tokens`,
} as const;
