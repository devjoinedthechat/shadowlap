import { describe, expect, it } from 'vitest';
import { progressLog } from '../src/progress.js';

/**
 * The progress blame, verify and repair print: in a terminal a run of attempt lines folds into one
 * line that counts them, which the next line of another kind takes the place of; anywhere else every
 * line stays. A demo's 180 attempt lines once buried its story.
 */

/** A stream as a terminal or a pipe is, keeping what is written to it. */
function stream(isTTY: boolean): NodeJS.WriteStream & { text: string } {
  const s = {
    isTTY,
    columns: 60,
    text: '',
    write(chunk: unknown) {
      s.text += String(chunk);
      return true;
    },
  };
  return s as unknown as NodeJS.WriteStream & { text: string };
}

/** What a terminal shows for `text`: `\r` and an erase take the line back, `\n` ends it. */
function screen(text: string): string[] {
  const lines: string[] = [];
  let line = '';
  for (const part of text.split(/(\r\x1b\[2K|\n)/)) {
    if (part === '\r\x1b[2K') line = '';
    else if (part === '\n') {
      lines.push(line);
      line = '';
    } else line += part;
  }
  return line ? [...lines, line] : lines;
}

const BLAME = [
  '  model call #1 (1 of 5)',
  '    attempt 3  ✗ issue_refund with {"amount":240} called 0 times, but called 1 time · 7 live · 219ms · 01M5TPWGFH',
  '    attempt 1  ✓ passed · 7 live · 348ms · 01M5TPWGBN',
  '    attempt 2  ? the judge could not be asked · 7 live · 359ms · 01M5TPWGDF',
  '    attempt 4  \x1b[32m✓ passed\x1b[39m\x1b[2m · 7 live · 401ms · 01M5TPWGHC\x1b[22m',
  '    rescued · 2 of 4 · rate >= 0.12 (99.2%)',
  '  model call #5 (3 of 5)',
  '    attempt 1  ✗ issue_refund with {"amount":240} called 0 times, but called 1 time · 3 live · 305ms · 01M5TPWHBF',
];

describe('the progress of blame, verify and repair', () => {
  it('keeps every line where it is not a terminal', () => {
    const out = stream(false);
    const progress = progressLog(out);
    for (const line of BLAME) progress.log(line);
    progress.done();
    expect(out.text).toBe(BLAME.map((l) => `${l}\n`).join(''));
  });

  it('folds the attempts in a terminal into a count, which the next line of another kind replaces', () => {
    const out = stream(true);
    const progress = progressLog(out);
    for (const line of BLAME.slice(0, 5)) progress.log(line);
    expect(screen(out.text)).toEqual(['  model call #1 (1 of 5)', '    4 attempts: 2 passed, 1 failed, 1 not decided']);
    progress.log(BLAME[5]);
    progress.log(BLAME[6]);
    progress.log(BLAME[7]);
    // A probe's attempts count afresh.
    expect(screen(out.text)).toEqual(['  model call #1 (1 of 5)', '    rescued · 2 of 4 · rate >= 0.12 (99.2%)', '  model call #5 (3 of 5)', '    1 attempt: 0 passed, 1 failed']);
    progress.done();
    expect(screen(out.text)).toEqual(['  model call #1 (1 of 5)', '    rescued · 2 of 4 · rate >= 0.12 (99.2%)', '  model call #5 (3 of 5)']);
  });

  it("folds verify's attempts of each run, and its baselines, as one count", () => {
    const out = stream(true);
    const progress = progressLog(out);
    progress.log('  candidate 3 (system prompt, 39 characters changed): You are a support agent.');
    progress.log('    target    01M5TPWDF0  attempt 1  ✓ passed · 7 live · 256ms · 01M5TPWT4D');
    progress.log('    held-out  01M5TPWD00  attempt 1  ✗ issue_refund called 1 time · 7 live · 352ms · 01M5TPWT6D');
    progress.log('    good      01M5TPWDXP  baseline 1  ✓ passed · 7 live · 393ms · 01M5TPWT8C');
    progress.log('    target    01M5TPWDF0  fixed · 12 of 12 · rate >= 0.73 (95%)');
    progress.log('    good      01M5TPWDXP  attempt 2  ✓ passed · 7 live · 387ms · 01M5TPWV24');
    expect(screen(out.text)).toEqual(['  candidate 3 (system prompt, 39 characters changed): You are a support agent.', '    target    01M5TPWDF0  fixed · 12 of 12 · rate >= 0.73 (95%)', '    4 attempts: 3 passed, 1 failed']);
    progress.done();
  });

  it("folds blame's pairs into a count of each call's attempts, which the check's verdict replaces", () => {
    const out = Object.assign(stream(true), { columns: 100 });
    const progress = progressLog(out);
    const check = '  check of #5 (fresh pairs at #5 and #6: does rescue drop at #5, or fall gradually?)';
    progress.log(check);
    // Under --concurrency 2 a pair's two attempts end in either order.
    progress.log('    \x1b[2mpair 1, #6\x1b[22m  \x1b[31m✗\x1b[39m issue_refund called 1 time · 7 live · 219ms · 01M5TPWGFH');
    progress.log('    \x1b[2mpair 1, #5\x1b[22m  \x1b[32m✓ passed\x1b[39m · 7 live · 348ms · 01M5TPWGBN');
    expect(screen(out.text)).toEqual([check, '    1 pair: #5 1 passed · #6 0 passed, 1 failed']);
    progress.log('    pair 2, #5  ✓ passed · 7 live · 401ms · 01M5TPWGHC');
    progress.log('    pair 2, #6  ? the judge could not be asked · 7 live · 359ms · 01M5TPWGDF');
    expect(screen(out.text)).toEqual([check, '    2 pairs: #5 2 passed · #6 0 passed, 1 failed, 1 not decided']);
    progress.log('    could not be decided: a check could not be decided');
    // The next probe's attempts, at the same indent, count afresh.
    progress.log('  model call #7 (4 of 5)');
    progress.log('    attempt 1  ✓ passed · 3 live · 305ms · 01M5TPWHBF');
    expect(screen(out.text)).toEqual([check, '    could not be decided: a check could not be decided', '  model call #7 (4 of 5)', '    1 attempt: 1 passed']);
    progress.done();
  });

  it('puts what else is written meanwhile above the count, and gives the stream back when done', () => {
    const out = stream(true);
    const write = out.write;
    const progress = progressLog(out);
    progress.log(BLAME[0]);
    progress.log(BLAME[1]);
    out.write('! a warning\n');
    expect(screen(out.text)).toEqual(['  model call #1 (1 of 5)', '! a warning', '    1 attempt: 0 passed, 1 failed']);
    progress.done();
    expect(out.write).toBe(write);
    expect(screen(out.text)).toEqual(['  model call #1 (1 of 5)', '! a warning']);
  });

  it('keeps every line with fold off, as -v asks, and in a terminal that can take no line back', () => {
    const out = stream(true);
    const progress = progressLog(out, false);
    for (const line of BLAME) progress.log(line);
    expect(out.text).toBe(BLAME.map((l) => `${l}\n`).join(''));
    const term = process.env.TERM;
    process.env.TERM = 'dumb';
    try {
      const dumb = stream(true);
      const plain = progressLog(dumb);
      for (const line of BLAME) plain.log(line);
      expect(dumb.text).toBe(BLAME.map((l) => `${l}\n`).join(''));
    } finally {
      if (term === undefined) delete process.env.TERM;
      else process.env.TERM = term;
    }
  });
});
