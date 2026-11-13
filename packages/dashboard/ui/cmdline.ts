/**
 * A shell command as `.cmdline` sets it (`CodeBox`, `Command`), cut where it may wrap, as the mock's
 * cmdArgs() and argHtml() cut one. Words break at the spaces between them. A flag stays with the
 * value after it, so a line never ends on `--expect`, and no flag breaks inside itself (after its
 * first hyphen, `--` / `expect` reads as two). An id, a short value and a short quoted string stay
 * whole. A long argument is one piece of its own (`arg`, `.carg`), whole where its line holds it
 * with its flag, and only where it doesn't does it break inside: JSON as code shown as text breaks
 * (`codePieces`: a key kept with a short value), a path after each slash (never inside `//`), a
 * quoted value glued to its key (`17="Escalate … tier 2."`) or a long title between its words, a
 * small word kept with the next. Every break is a plain space or a <wbr>, never a no-break space, so
 * a copy of the command is exactly the command. No DOM here: the tests import it.
 */
import { codePieces, wbrSafe } from './typeset.js';

/** A piece of a command: text kept on one line (`whole`; a flag with the space after it, `flag`) or free to wrap, a place it may break, or a long argument's pieces (`arg`). */
export type CmdPiece = { text: string; whole: boolean; flag?: boolean } | { wbr: true } | { arg: CmdPiece[] };

/** The command's words as a shell splits them: at unquoted whitespace, each kept with its quotes. */
export function cmdWords(cmd: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: string | null = null;
  let escaped = false;
  for (const c of cmd) {
    if (escaped) {
      word += c;
      escaped = false;
    } else if (quote) {
      word += c;
      if (c === quote) quote = null;
    } else if (c === '\\') {
      word += c;
      escaped = true;
    } else if (/\s/.test(c)) {
      if (word) words.push(word);
      word = '';
    } else {
      word += c;
      if (c === "'" || c === '"') quote = c;
    }
  }
  if (word) words.push(word);
  return words;
}

const whole = (text: string): CmdPiece => ({ text, whole: true });
const free = (text: string): CmdPiece => ({ text, whole: false });
const WBR: CmdPiece = { wbr: true };

/** Pieces kept whole with a break between each two: a plain space, or a <wbr>. */
const between = (pieces: readonly string[], gap: 'space' | 'wbr'): CmdPiece[] => pieces.flatMap((x, i) => (i ? [gap === 'space' ? free(' ') : WBR, whole(x)] : [whole(x)]));

/** The small words a long title keeps with the word after it. */
const TITLE_SMALL = /\b(a|an|the|to|of|in|on|at|by|for|and|or|with|from|as|is|its|your|no) /gi;

/** One argument (`argHtml`): JSON, a long path or a long quoted value is a long argument of its own, any other word one piece kept whole. */
export function argPieces(w: string): CmdPiece {
  if (w.length > 24 && /[{,]/.test(w)) return { arg: codePieces(w) };
  if (w.length > 30 && w.includes('/')) return { arg: between(w.split(/(?<=\/)(?!\/)/), 'wbr') };
  if (w.length > 30 && /^[^\s"']*["']/.test(w) && /\s/.test(w)) {
    const words = w.replace(TITLE_SMALL, '$1\u0001').split(' ');
    return { arg: between(words, 'space').map((p) => ('text' in p ? { ...p, text: p.text.replace(/\u0001/g, ' ') } : p)) };
  }
  return whole(w);
}

/** A flag: `-v`, `--expect`, `--no-test`; not `--` alone, which ends the options. */
const isFlag = (w: string) => /^--?[a-z]/i.test(w);

/** A command's words cut where they may wrap; `glued`, `--` is kept with the word after it, as a flag is with its value. */
function wordParts(words: readonly string[], glued: boolean): CmdPiece[] {
  const out: CmdPiece[] = [];
  for (let i = 0; i < words.length; i++) {
    if (out.length) out.push(free(' '));
    const w = words[i]!;
    const next = words[i + 1];
    // The flag and the space after it are one piece: no line ends between a flag and its value.
    if ((isFlag(w) || (glued && w === '--')) && next !== undefined && !next.startsWith('--')) {
      out.push({ text: `${w} `, whole: true, flag: true }, argPieces(next));
      i++;
      continue;
    }
    out.push(argPieces(w));
  }
  return wbrSafe(out);
}

/** A command cut where it may wrap, each word as `argPieces` cuts it. */
export function cmdParts(cmd: string): CmdPiece[] {
  return wordParts(cmdWords(cmd), false);
}

/**
 * A command as a code box sets it (`Command`, components/Copy.tsx): as `cmdParts` cuts it, with its
 * head whole. The head is the program and the words up to its first flag, one piece while it is
 * short (four words, 34 characters), so `shadowlap test 'goldens/*'` never breaks inside; the
 * program is the head's first piece, so the `$` drawn before it never ends a line alone. `--` stays
 * with the command it introduces. Joined, the pieces are the command.
 */
export function commandParts(cmd: string): CmdPiece[] {
  const words = cmdWords(cmd);
  let h = 0;
  while (h < words.length && h < 4 && !words[h]!.startsWith('-') && words.slice(0, h + 1).join(' ').length <= 34) h++;
  if (h === 0) return wordParts(words, true);
  const head: CmdPiece[] = [whole(words[0]!), ...(h > 1 ? [free(' '), whole(words.slice(1, h).join(' '))] : [])];
  const rest = wordParts(words.slice(h), true);
  return rest.length ? [...head, free(' '), ...rest] : head;
}

/** A piece's text: a long argument's whole. */
export const pieceText = (p: CmdPiece): string => ('wbr' in p ? '' : 'arg' in p ? p.arg.map(pieceText).join('') : p.text);
