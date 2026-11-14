import { describe, expect, it } from 'vitest';
import { withReason } from '../src/tests-reason.js';

/** Update golden's reason as the server takes it from the dialog (src/tests-reason.ts). */
describe('an update job’s reason', () => {
  it('gives a reason to each update a job runs, as one argument the CLI can never read as an option', () => {
    const update = { title: 'Updating golden', args: ['test', 'goldens/refund-in-limit', '--update'] };
    expect(withReason(update, '  refunds above the limit\n go to a manager ')).toEqual({ title: 'Updating golden', args: ['test', 'goldens/refund-in-limit', '--update', '--reason', 'refunds above the limit go to a manager'] });
    // Steps: only the one that updates takes it.
    expect(withReason({ title: 'x', steps: [['normalize', 'add'], ['test', 'goldens/a', '--update'], ['test', 'goldens/a']] }, 'why')).toEqual({ title: 'x', steps: [['normalize', 'add'], ['test', 'goldens/a', '--update', '--reason', 'why'], ['test', 'goldens/a']] });
    // None, a blank one, or a job that updates nothing: the job as it was.
    for (const none of [undefined, null, '', '  \n ']) expect(withReason(update, none)).toBe(update);
    expect(withReason({ title: 'Running tests', args: ['test', 'goldens/a'] }, 'why')).toEqual({ title: 'Running tests', args: ['test', 'goldens/a'] });
    expect(withReason({ error: 'no such golden' }, 'why')).toEqual({ error: 'no such golden' });
    // Never an option, never more than a line holds, never anything but text.
    expect(withReason(update, '--yes')).toEqual({ error: "the reason can't start with a dash" });
    expect(withReason(update, 'x'.repeat(301))).toEqual({ error: 'the reason is at most 300 characters' });
    expect(withReason(update, 'x'.repeat(300))).toHaveProperty('args');
    expect(withReason(update, 42)).toEqual({ error: 'the reason is text' });
  });
});
