import { describe, expect, it } from 'vitest';
import { commandParts, type CmdPiece } from '../ui/cmdline.js';
import { greedy, planCopy, tokens, type CopyMeasure } from '../ui/typeset-lines.js';
import { codePieces, flatText, flatten, glue, inlineCodeCuts, isShortCopy, JOIN, joinOf, keptWords, pathPieces, sentenceRanges, sentences, type CopyPart, type Piece } from '../ui/typeset.js';

/**
 * The line-break rules (ui/typeset.ts) and copy set at a width (ui/typeset-lines.ts), the mock's
 * typeset() pass made over text before React draws it: measured here by characters, one a pixel,
 * so each width is a count of characters.
 */

/** A line of `width` characters, each character one wide, an element as wide as its text. */
const chars = (width: number, atoms: readonly string[] = []): CopyMeasure => ({ width, text: (s) => s.length, atom: (i) => atoms[i]?.length ?? 0 });
/** Joins drawn as `~`. */
const joins = (s: string) => s.replace(/\u00a0/g, '~');
/** How copy sets at a width: the block's wrap, and each sentence's setting with its text, its joins as `~`. */
function setAt(parts: readonly CopyPart[] | string, width: number, phrases = false) {
  const list = typeof parts === 'string' ? [{ text: parts }] : parts;
  const atoms = list.map((p) => ('atom' in p ? p.text : '')).filter(Boolean);
  const plan = planCopy(list, chars(width, atoms), { phrases });
  return { wrap: plan.wrap, units: plan.units?.map((u) => [u.set, joins(plan.text.slice(u.from, u.to))]) ?? null, text: joins(plan.text), plan };
}
/** A sentence `n` characters long, of words of four letters. */
const sentence = (n: number) => `${'Aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm nnnn oooo pppp qqqq rrrr ssss tttt uuuu vvvv wwww xxxx yyyy zzzz '.repeat(2).slice(0, n - 1).trimEnd()}.`;
/** Pieces drawn as text: a piece kept whole in brackets, a place to break `|`, a long argument in braces. */
const drawn = (pieces: ReadonlyArray<Piece | CmdPiece>): string => pieces.map((p) => ('wbr' in p ? '|' : 'arg' in p ? `{${drawn(p.arg)}}` : p.whole ? `[${p.text}]` : p.text)).join('');

describe('sentences', () => {
  it('finds a short copy’s sentences, never after an abbreviation or inside a quotation', () => {
    expect(sentences('Connect a bucket you own, push your runs and add CI. About fifteen minutes, with nothing to install or host.')).toEqual(['Connect a bucket you own, push your runs and add CI.', 'About fifteen minutes, with nothing to install or host.']);
    expect(sentences('Use a flag, e.g. --fail-at. It forks there.')).toEqual(['Use a flag, e.g. --fail-at.', 'It forks there.']);
    expect(sentences('It answered “Done. Refunded.” Then it stopped.')).toEqual(['It answered “Done. Refunded.”', 'Then it stopped.']);
    expect(sentences('It cost $0.34. 3 runs failed.')).toEqual(['It cost $0.34.', '3 runs failed.']);
    expect(sentences('version 0.1.0 ships')).toEqual(['version 0.1.0 ships']);
    expect(isShortCopy('One. Two. Three. Four.')).toBe(true);
    expect(isShortCopy('One. Two. Three. Four. Five.')).toBe(false);
  });

  it('never ends one at a stop inside an element, and ends one where an element’s stop is followed by the copy’s own space', () => {
    const inside = flatten([{ text: 'Run ' }, { atom: 0, text: 'shadowlap fix. Now', starts: true }, { text: ' and wait.' }]);
    expect(sentenceRanges(inside)).toHaveLength(1);
    const after = flatten([{ atom: 0, text: 'Blamed at #17.', starts: true }, { text: ' The prompt changed.' }]);
    expect(sentenceRanges(after).map(([a, b]) => after.str.slice(a, b))).toEqual(['Blamed at #17.', 'The prompt changed.']);
    // an id, a command or a link set apart starts a sentence whatever its first letter
    const link = flatten([{ text: 'Mine a check from your recordings. ' }, { atom: 0, text: 'training tasks', starts: true }]);
    expect(sentenceRanges(link)).toHaveLength(2);
  });
});

describe('glue', () => {
  it('joins what belongs together with a no-break space: a number and its unit, a tally, a separator, a small word, the last two words', () => {
    const j = (s: string) => joins(glue(s, () => true));
    expect(j('12 calls replayed')).toBe('12~calls~replayed');
    expect(j('failed in 3 of 4 attempts')).toBe('failed in~3~of~4~attempts');
    expect(j('Removed support-agent · nothing on disk changed')).toBe('Removed support-agent~· nothing on~disk~changed');
    expect(j('the gate held at call 5 again')).toBe('the~gate held at~call~5~again');
    // an operator holds the word before it, and what follows it, so no line starts or ends on one
    expect(j('amount 240 > limit 100 here')).toBe('amount 240~>~limit 100~here');
    expect(j('open a pull request with --fail-at 5 now')).toBe('open a~pull~request with~--fail-at~5~now');
    expect(j('Asked again, it escalated. Then it passed.')).toBe('Asked again, it~escalated. Then it~passed.');
  });

  it('takes the mock’s words: a capitalised word that names a number, plurals of a compound, up to, and every small word', () => {
    const j = (s: string) => joins(glue(s, () => true));
    expect(j('Call 19 failed, and Attempt 2 of the fork passed')).toBe('Call~19~failed, and~Attempt~2 of~the~fork~passed');
    expect(j('Probe 3 rescued it at tier 2 or exit code 1 then')).toBe('Probe~3~rescued it~at~tier~2 or~exit code~1~then');
    expect(j('pull requests and system prompts with judge checks up to 3 times')).toBe('pull~requests and~system~prompts with~judge~checks up~to~3~times');
    expect(j('neither x nor y but it runs onto my bench and our desk')).toBe('neither x nor~y but~it~runs onto~my~bench and~our~desk');
    // a revision keeps its word, its hash starting with a letter or a digit
    expect(j('golden from rev a7b3c2e, then revision 3f9e2d1 kept it')).toBe('golden from~rev~a7b3c2e, then revision~3f9e2d1 kept~it');
    // "no" holds its word as an article does, more than a small word
    expect(joinOf(['no', 'runs'], 0)).toBe(JOIN.article);
    expect(joinOf(['with', 'runs'], 0)).toBe(JOIN.small);
  });

  it('gives up the weakest join of a run wider than its line, where both sides then fit', () => {
    // "at call 5 again" is one run; it breaks at its weakest join, where both sides fit
    expect(joins(glue('held at call 5 again', (s) => s.length <= 12))).toBe('held at call~5~again');
  });
});

describe('copy set at a width', () => {
  it('keeps a sentence that fits a line whole, balances one of two lines on a line of its own, and flows one where the line before would be left under half full', () => {
    expect(setAt(`${sentence(60)} ${sentence(150)}`, 100).units?.map(([s]) => s)).toEqual(['whole', 'balanced']);
    expect(setAt(`${sentence(30)} ${sentence(150)}`, 100).units?.map(([s]) => s)).toEqual(['whole', 'flow']);
  });

  it('flows a sentence on where the short one after it can end its last line, after prose left short, and after a balanced one takes a full line (tsSettle)', () => {
    const sets = (...ws: number[]) => setAt(ws.map(sentence).join(' '), 100).units?.map(([s]) => s);
    // not a balanced pair of lines over a short third: the short sentence ends the first's last line
    expect(sets(150, 30)).toEqual(['flow', 'flow']);
    // prose whose last line is 30% full: the short sentence flows on, never under it alone
    expect(sets(230, 60)).toEqual(['flow', 'flow']);
    // a balanced sentence fills its line, and one after a short line flows on
    expect(sets(120, 20, 150)).toEqual(['flow', 'flow', 'flow']);
    expect(sets(150, 120)).toEqual(['balanced', 'balanced']);
  });

  it('keeps a short tail with no stop of its own with the sentence before it where the two fit a line', () => {
    const parts: CopyPart[] = [{ text: 'Mine a check from your recordings. ' }, { atom: 0, text: 'Training tasks\u00a0→', starts: true }];
    expect(setAt(parts, 60).units).toBeNull();
    expect(setAt(parts, 40).units?.map(([s, t]) => [s, t])).toEqual([
      ['whole', 'Mine a~check from~your~recordings.'],
      ['whole', 'Training tasks~→'],
    ]);
  });

  it('breaks a sentence of two lines after a clause, the strongest stop first, both sides whole on their line', () => {
    const blame = 'Asked again at #5, the model escalated and the run passed in 3 of 4 attempts; asked again at #7, in none of 4.';
    expect(setAt(blame, 82).units?.map(([, t]) => t.replace(/~/g, ' '))).toEqual(['Asked again at #5, the model escalated and the run passed in 3 of 4 attempts;', 'asked again at #7, in none of 4.']);
    // a comma only where its shorter side holds a third of the line
    expect(setAt('Adds a check to escalate-over-limit, the golden that guards this fix.', 50).units?.map(([, t]) => t.replace(/~/g, ' '))).toEqual(['Adds a check to escalate-over-limit,', 'the golden that guards this fix.']);
    expect(setAt('Plants a payload, then runs the agent from the call that reads it.', 60).units).toBeNull();
    // never at a stop inside a quotation
    expect(setAt('It said “refunded, and emailed the customer twice over” in the end.', 40).units).toBeNull();
  });

  it('in a dialog’s lead, breaks before a phrase where no stop can, and twice in copy of three lines (tsClauses, tsSplitSents)', () => {
    const lead = 'Asks your own Claude Code for prompt and tool rewrites and picks the smallest that fixes the failing runs.';
    expect(setAt(lead, 52, true).units?.map(([, t]) => t.replace(/~/g, ' '))).toEqual(['Asks your own Claude Code', 'for prompt and tool rewrites', 'and picks the smallest that fixes the failing runs.']);
    // never inside one noun: "prompt and tool rewrites" stays whole
    expect(setAt(lead, 52, true).units?.some(([, t]) => t.endsWith('prompt'))).toBe(false);
    // copy that isn't a dialog's breaks only after a stop
    expect(setAt(lead, 52).units).toBeNull();
  });

  it('never lets a small word’s join cost a short block a line (tsCost)', () => {
    // joined, "for the 56 model calls" would push the block to three lines at 30
    expect(setAt('Asks the model again for the 56 model calls in the run', 30).text).toContain('for the~56');
    expect(setAt('Asks the model again for the 56 model calls in the run', 80).text).toContain('for~the~56');
  });

  it('pulls words onto a pretty block’s short last line while it keeps its lines (tsWidow)', () => {
    const text = 'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mm nn.';
    const { wrap, text: set, plan } = setAt(text, 30);
    expect(wrap).toBe('ts-pretty');
    expect(set.endsWith('llll~mm~nn.')).toBe(true);
    const f = flatText(plan.text);
    const last = greedy(tokens(f, chars(30)), 30);
    expect([last.n, last.x >= 10]).toEqual([3, true]);
  });

  it('keeps a word with a hyphen or a dot whole where its line holds it, and lets a long name break after a dot only where none does', () => {
    const host = 'Sign in to shadowlap.northwind.internal to push.';
    const narrow = setAt(host, 20).plan;
    const wide = setAt(host, 60).plan;
    const at = host.indexOf('shadowlap.');
    expect(narrow.words.find((w) => w.from === at)?.kind).toBe('long');
    expect([narrow.long.get(at), wide.long.get(at)]).toEqual([false, true]);
    // a path longer than a short line breaks only after a slash, never inside `//`
    const path = keptWords(flatText('Push to s3://northwind-agent-runs/support-agent now.'), null);
    expect(path.map((w) => w.kind)).toEqual(['path']);
    expect(pathPieces('s3://northwind-agent-runs/support-agent')).toEqual(['s3://northwind-agent-runs/', 'support-agent']);
    // unmeasured, every such word is held
    expect(keptWords(flatText('Adds refund-in-limit and get_policy.result.limit'), null).map((w) => w.kind)).toEqual(['w', 'w']);
  });

  it('balances no block, nor sentence, whose every word is kept whole: it wraps pretty, outranking a stylesheet’s balance', () => {
    expect(setAt('refund-in-limit escalate-over-limit', 20).wrap).toBe('ts-pretty');
  });

  it('sets copy unmeasured as a block not laid out yet: short copy’s sentences whole, a run of joined words giving way past 30 characters', () => {
    const plan = planCopy([{ text: 'Adds a check to refund-in-limit. It runs 3 of 4 attempts.' }], null);
    expect([plan.wrap, plan.units?.map((u) => u.set)]).toEqual([null, ['whole', 'whole']]);
    expect(joins(plan.text)).toContain('3~of~4~attempts.');
  });
});

describe('code and commands', () => {
  it('cuts a long path only after a slash, never inside `//`, a host before a word of five letters, a list after its commas', () => {
    expect(inlineCodeCuts('goldens/refund-in-limit')).toBeNull();
    expect(inlineCodeCuts('s3://northwind-agent-runs/support-agent/runs')).toEqual(['s3://northwind-agent-runs/', 'support-agent/', 'runs']);
    expect(inlineCodeCuts('shadowlap-db.northwind.internal.example.com')).toEqual(['shadowlap-db.', 'northwind.', 'internal.', 'example.com']);
  });

  it('breaks code shown as text at its spaces and after its commas and braces, a key kept with a short value, never before an operator or a number its word names', () => {
    expect(drawn(codePieces('check failed: issue_refund #6: amount 240 > get_policy.result.limit 100 (#4)'))).toBe('[check] [failed:] [issue_refund #6:] [amount 240 >] [get_policy.result.limit 100] [(#4)]');
    expect(drawn(codePieces('escalate({"reason":"above the refund limit","to":"tier 2"})'))).toBe('[escalate({]|["reason":"above the refund limit",]|["to":"tier 2"})]');
    expect(drawn(codePieces('{"amount":240}'))).toBe('[{"amount":240}]');
    // a short object or call stays whole however it is spaced
    expect(drawn(codePieces('{"amount": 240}'))).toBe('[{"amount": 240}]');
    expect(drawn(codePieces('issue_refund({"amount": 240})'))).toBe('[issue_refund({"amount": 240})]');
    // never a place to break right before a space, which offers the same break
    expect(drawn(codePieces('{"a": 1, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 2}'))).not.toMatch(/\| /);
  });

  it('keeps a command’s head whole, -- with the command it introduces, and a long argument one piece of its own', () => {
    const cmd = (c: string) => drawn(commandParts(c));
    expect(cmd(`shadowlap test 'goldens/*' --junit report.xml`)).toBe(`[shadowlap] [test 'goldens/*'] [--junit ][report.xml]`);
    expect(cmd('shadowlap run -- node agent.mjs')).toBe('[shadowlap] [run] [-- ][node] [agent.mjs]');
    expect(cmd('shadowlap blame 01K5CQ4N7G2W8XRM6E3V7NQB5D --expect x')).toBe('[shadowlap] [blame] [01K5CQ4N7G2W8XRM6E3V7NQB5D] [--expect ][x]');
    expect(commandParts('shadowlap test --update').map((p) => ('text' in p ? p.text : '')).join('')).toBe('shadowlap test --update');
  });

  it('reads a quoted value glued to its key as one argument that breaks between its words, a small word kept with the next', () => {
    expect(drawn(commandParts('shadowlap inject 01K5CQ4N7G --inject 17="Escalate refunds above the regional limit to tier 2."'))).toBe('[shadowlap] [inject 01K5CQ4N7G] [--inject ]{[17="Escalate] [refunds] [above] [the regional] [limit] [to tier] [2."]}');
  });

  it('breaks a command’s JSON as code shown as text, a key kept with its short value, and a path only after a slash, never inside `s3://`', () => {
    expect(drawn(commandParts(`shadowlap replay 01K5CQ4N7G --set '{"amount": 240, "currency": "EUR", "reason": "above the regional refund limit"}'`))).toBe(
      `[shadowlap] [replay 01K5CQ4N7G] [--set ]{['{]|["amount": 240,] ["currency": "EUR",] ["reason":] ["above] [the] [regional] [refund] [limit"}']}`,
    );
    expect(drawn(commandParts('shadowlap store push --to s3://northwind-agent-runs/support-agent/runs .'))).toBe('[shadowlap] [store push] [--to ]{[s3://]|[northwind-agent-runs/]|[support-agent/]|[runs]} [.]');
  });
});
