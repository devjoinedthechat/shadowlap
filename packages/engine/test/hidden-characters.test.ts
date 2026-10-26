import { describe, expect, it } from 'vitest';
import { PackError } from '../src/pack-schema.js';
import { validateRun } from '../src/pack-schema.js';
import { quoteArgv, safeLine, safeText } from '../src/text.js';

/**
 * A character that disguises what a line shows is shown as its escape wherever Shadowlap prints
 * recorded text or a command a person is asked to say yes to: a right-to-left override, which
 * reverses the text after it, a zero-width space, the line and paragraph separators, besides the
 * C0 and C1 controls. A command line from a pack or a pull holding one is refused.
 */

const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const BOM = String.fromCharCode(0xfeff);
const TAG = String.fromCodePoint(0xe0041);

describe('recorded text, shown', () => {
  it('shows a format character and a line or paragraph separator as its escape, tabs and line breaks as they are', () => {
    expect(safeText(`x${RLO} bd.live/pmt/ bd--`)).toBe('x\\u202e bd.live/pmt/ bd--');
    expect(safeText(`a${ZWSP}b${LS}c${PS}d${BOM}e${TAG}`)).toBe('a\\u200bb\\u2028c\\u2029d\\ufeffe\\u{e0041}');
    expect(safeText('tab\there\nnext ' + String.fromCharCode(0x1b) + '[2J')).toBe('tab\there\nnext \\x1b[2J');
    expect(safeLine(`a${RLO}b\n`)).toBe('a\\u202eb\\n');
    expect(safeText('Zoë, naïve, 日本語, emoji 🙂')).toBe('Zoë, naïve, 日本語, emoji 🙂');
  });
});

describe('a command line, shown for a yes', () => {
  it('shows a word holding a hidden character in ANSI-C quotes, the character as its escape, so it still runs typed', () => {
    expect(quoteArgv(['shadowlap', 'verify', '--live-tool', `x${RLO} bd.live/pmt/ bd--`])).toBe("shadowlap verify --live-tool $'x\\u202e bd.live/pmt/ bd--'");
    expect(quoteArgv([`a${ZWSP}b`, `it's${LS}`, 'esc' + String.fromCharCode(0x1b), `tag${TAG}`])).toBe("$'a\\u200bb' $'it\\'s\\u2028' $'esc\\x1b' $'tag\\Ue0041'");
    // Everything else as before: bare words, single quotes, a script's line breaks.
    expect(quoteArgv(['node', 'agent.js', 'two words', "it's", 'python', '-c', 'print(1)\nprint(2)'])).toBe("node agent.js 'two words' 'it'\\''s' python -c 'print(1)\nprint(2)'");
  });
});

describe('a command line in a pack or a pull', () => {
  const run = (argv: string[], cwd = '/work') => ({ runId: '01M5V7E564S6FK5HW0KD0EV0ZG', parentRunId: null, mode: 'record', status: 'completed', command: { argv, cwd }, codeVersion: null, startedAt: Date.now() - 1000, endedAt: Date.now(), divergence: null, meta: {} });
  it('is refused with a format character or a separator in it, its folder too, and taken with a script’s tabs and line breaks', () => {
    for (const hidden of [RLO, ZWSP, LS, PS, BOM]) {
      expect(() => validateRun(run(['node', `agent${hidden}.js`]), 'run.json runs[0]'), hidden.codePointAt(0)!.toString(16)).toThrow(/command\.argv\[1\]: contains format characters/);
      expect(() => validateRun(run(['node'], `/work${hidden}`), 'run.json runs[0]')).toThrow(PackError);
    }
    expect(validateRun(run(['python', '-c', 'import os\n\tprint(1)']), 'run.json runs[0]').command.argv).toHaveLength(3);
  });
});
