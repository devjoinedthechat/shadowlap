import type { CauseView } from './model.js';

type Answer = CauseView['answers'][number];

/** A `--clean` answer's verdict ahead of its line, as Test another read's card and the finding's further lines say it. */
export const ANSWER_LEAD: Readonly<Record<Answer['verdict'], string>> = { caused: 'caused by', 'not caused': 'not caused by', inconclusive: 'inconclusive,' };

/** `caused by #4 get_ticket · #28 send_email is gone in 3 of 3 clean attempts · rate >= 0.29 (95%)`. */
export const answerWords = (a: Answer): string => `${ANSWER_LEAD[a.verdict]} ${a.line}`;
