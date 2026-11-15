import { describe, expect, it } from 'vitest';
import { endToast, jobHeader } from '../ui/jobs.js';
import { jobTitle } from '../ui/job-title.js';

/**
 * The toast a job ends with behind a closed drawer says its title in the past tense only where that
 * claims no more than happened: a job that did what its title says, one whose own status says it
 * did, or one whose past tense says only that it ran and that ran. One refused before it ran, one
 * that failed with an error and nothing more, and one that came out badly lead with what ran.
 */

const done = (o: { args: string[]; code: number; kind?: string; title?: string; result?: unknown }) => ({ done: true, ...o });

describe('the toast a job ends with', () => {
  it('words a pack’s import as unpack reports it: the runs it brought in, those already here, one kept as another recording, a refusal', () => {
    const [A, B] = ['01K5CQ4N7G8M2XWQH6V3T9RB1D', '01K5CQ5P2X8M2XWQH6V3T9RB1E'];
    const dir = '.shadowlap/uploads/01K0UPLOAD0000000000000001/support-refund';
    const unpack = (code: number, result?: unknown) => done({ kind: 'import', title: 'Importing pack', args: ['unpack', dir], code, ...(result ? { result } : {}) });
    const ended = (result: unknown) => ({ toast: endToast(unpack(0, result), []), header: jobHeader(unpack(0, result), []) });
    expect(ended({ imported: [A, B], skipped: [], mismatched: [] })).toEqual({ toast: 'Imported pack · 2 runs · exit 0', header: { title: 'Imported pack', text: '2 runs · exit 0', tone: 'ok' } });
    expect(ended({ imported: [B], skipped: [A], mismatched: [] }).toast).toBe('Imported pack · 1 run · 1 already here · exit 0');
    expect(ended({ imported: [], skipped: [A, B], mismatched: [] })).toEqual({ toast: 'Tried importing pack · 2 runs already here · exit 0', header: { title: 'Tried importing pack', text: '2 runs already here · exit 0', tone: '' } });
    const kept = [{ runId: B, command: null, calls: true }];
    expect(ended({ imported: [A], skipped: [B], mismatched: kept })).toEqual({
      toast: 'Imported pack · 1 run · 1 not imported: the store holds another recording under its id · exit 0',
      header: { title: 'Imported pack', text: '1 run · 1 not imported: the store holds another recording under its id · exit 0', tone: 'warn' },
    });
    expect(ended({ imported: [], skipped: [A, B], mismatched: [{ ...kept[0], runId: A }, ...kept] }).toast).toBe('Tried importing pack · 2 not imported: the store holds another recording under their ids · exit 0');
    // Refused, in unpack's words, the folder named as it was picked.
    const refused = [`shadowlap: ${dir}: unexpected format some-other-pack`];
    expect(endToast(unpack(2), refused)).toBe('Tried importing pack · refused · support-refund: unexpected format some-other-pack · exit 2');
    expect(jobHeader(unpack(2), refused)).toEqual({ title: 'Tried importing pack', text: 'refused · support-refund: unexpected format some-other-pack · exit 2', tone: 'err' });
    // A job the server sent no title for is named by its command as the server names it.
    expect(jobTitle({ args: ['unpack', dir], done: false, code: null })).toBe('Importing pack');
  });

  it('never says a job that failed did what its title says', () => {
    expect(endToast(done({ kind: 'import', title: 'Importing capture', args: ['import', 'x.har'], code: 2 }), ['shadowlap: x.har is not a HAR file: no log.entries'])).toBe('Tried importing capture · shadowlap: x.har is not a HAR file: no log.entries');
    expect(endToast(done({ title: 'Exporting HTML report', args: ['export', 'html', 'X', 'x.html'], code: 2 }), ['shadowlap: no run X'])).toBe('Tried exporting HTML report · shadowlap: no run X');
    expect(endToast(done({ args: ['rm', 'X'], code: 2 }), ['shadowlap: X is still recording'])).toBe('Tried deleting · shadowlap: X is still recording');
    expect(endToast(done({ args: ['normalize', 'add', '--path', 'messages[0].content'], code: 2 }), ['shadowlap: shadowlap.config.json could not be written'])).toBe('Tried adding normalizer · shadowlap: shadowlap.config.json could not be written');
  });

  it('says what ran when it came out with nothing, or was refused before it ran', () => {
    expect(endToast(done({ kind: 'pairs', title: 'Exporting pairs', args: ['export', 'pairs'], code: 0, result: { pairs: 0 } }), [])).toBe('Tried exporting pairs · nothing exported · exit 0');
    expect(endToast(done({ kind: 'score', title: 'Scoring model', args: ['tasks', 'score'], code: 1, result: { tasks: [], skipped: [{ task: 'refund' }] } }), [])).toBe('Tried scoring model · nothing scored · exit 1');
    const refused = ["shadowlap: 01K0UNKNOW holds model calls of tools shadowlap never recorded, which write, or may: a replay serves the model's answers again, so it would run them again for real."];
    expect(endToast(done({ args: ['replay', 'X'], code: 2 }), refused)).toBe('Tried replaying · refused · unrecorded tools write, or may · exit 2');
    expect(endToast(done({ kind: 'blame', args: ['blame', 'X'], code: 3, result: { outcome: 'stopped' } }), [])).toBe('Tried blaming · stopped · exit 3');
  });

  it('says an injection job in the past as far as it went: packed though its test failed, a cause searched for whatever it answered', () => {
    expect(endToast(done({ kind: 'pack-test', title: 'Packing with injection gate', args: ['test', 'goldens/x'], code: 1 }), ['0 passed, 1 failed · 4 upstream requests'])).toBe('Packed with injection gate · its test failed · exit 1');
    expect(endToast(done({ kind: 'pack-test', title: 'Packing with injection gate', args: ['test', 'goldens/x'], code: 1 }), ['goldens/x is packed without its gate: its entry changed'])).toBe('Tried packing with injection gate · goldens/x is packed without its gate: its entry changed');
    expect(endToast(done({ kind: 'injection', title: 'Finding cause: testing #4', args: ['injection', 'X', '--clean', '4'], code: 0, result: { results: [{ mode: 'clean', verdict: 'not caused' }] } }), [])).toBe('Searched for cause: testing #4 · not caused · exit 0');
    expect(endToast(done({ kind: 'injection', title: 'Re-running injection test', args: ['injection', 'X'], code: 3, result: { results: [{ mode: 'plant' }], verdict: 'inconclusive' } }), [])).toBe('Re-ran injection test · inconclusive · exit 3');
  });

  it('says it in the past where it did what its title says, or ran and says only that', () => {
    expect(endToast(done({ kind: 'apply', title: 'Applying fix', args: ['fix', 'apply', 'fx-1'], code: 1, result: { status: 'applied', tests: 'failed' } }), [])).toBe('Applied fix · tests failed · exit 1');
    expect(endToast(done({ kind: 'apply', title: 'Marking the fix applied', args: ['fix', 'apply', 'fx-1'], code: 0, result: { status: 'applied' } }), [])).toBe('Marked the fix applied · exit 0');
    expect(endToast(done({ kind: 'apply', title: 'Finishing the apply', args: ['fix', 'apply', 'fx-1'], code: 0, result: { status: 'applied', tests: 'passed' } }), [])).toBe('Finished the apply · applied · tests passed · exit 0');
    expect(endToast(done({ args: ['test', 'goldens/a'], code: 1 }), ['5 passed, 1 failed'])).toBe('Ran tests · failed · 5 of 6 goldens passed · exit 1');
  });

  it('judges a job of several steps by its last, each step running only once the one before it succeeded', () => {
    const failed = ['0 passed, 1 failed'];
    expect(endToast(done({ kind: 'pack-test', title: 'Packing and testing', args: ['pack', 'X', 'goldens/x'], code: 1 }), failed)).toBe('Packed and tested · failed · exit 1');
    expect(endToast(done({ kind: 'normalize-and-test', title: 'Adding normalizer and re-running', args: ['normalize', 'add'], code: 1 }), failed)).toBe('Added normalizer and re-ran · failed · exit 1');
    // An update whose checks failed replaced nothing: what ran, then.
    expect(endToast(done({ kind: 'normalize-and-test', title: 'Adding normalizer and updating golden', args: ['normalize', 'add'], code: 1 }), failed)).toBe('Tried adding normalizer and updating golden · diverged again · exit 1');
  });
});
