/**
 * A shell command as `.cmdline` sets it (`CmdLine`), cut where it may wrap, as the mock's cmdHtml()
 * cuts one. Words break at the spaces between them. A flag stays with the value after it, so a line
 * never ends on `--expect`, and no flag breaks inside itself (after its first hyphen, `--` / `expect`
 * reads as two). An id, a short value and a short quoted string stay whole; JSON breaks after its
 * commas and opening braces; a long path after a slash; a long quoted value, such as a pull
 * request's title, between its words. No DOM here: the tests import it.
 */

/** A piece of a command: text kept on one line (`whole`) or free to wrap, or a place it may break. */
export type CmdPiece = { text: string; whole: boolean } | { wbr: true };

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

/** JSON, cut after each comma and opening brace; a quoted string in it of a few words stays whole. */
function jsonPieces(w: string): CmdPiece[] {
  return w.split(/("[^"]*")/).flatMap((part, i): CmdPiece[] => {
    if (!part) return [];
    if (i % 2) return [part.length <= 30 ? whole(part) : free(part)];
    // A break after each comma and opening brace, the last one's too: the string after it may start the line.
    return (part.match(/[^,{]*[,{]|[^,{]+$/g) ?? []).flatMap((x) => (/[,{]$/.test(x) ? [free(x), WBR] : [free(x)]));
  });
}

/** One argument: JSON, a long path, a long quoted value, or a word kept whole. */
function argPieces(w: string): CmdPiece[] {
  if (w.length > 24 && /[{,]/.test(w)) return jsonPieces(w);
  if (w.length > 30 && w.includes('/')) return w.split('/').flatMap((x, i) => (i ? [free('/'), WBR, ...(x ? [whole(x)] : [])] : x ? [whole(x)] : []));
  if (w.length > 30 && /^["']/.test(w)) return w.split(' ').flatMap((x, i) => (i ? [free(' '), whole(x)] : [whole(x)]));
  return [whole(w)];
}

/** A flag: `-v`, `--expect`, `--no-test`; not `--` alone, which ends the options. */
const isFlag = (w: string) => /^--?[a-z]/i.test(w);

export function cmdParts(cmd: string): CmdPiece[] {
  const words = cmdWords(cmd);
  const out: CmdPiece[] = [];
  for (let i = 0; i < words.length; i++) {
    if (out.length) out.push(free(' '));
    const w = words[i]!;
    const next = words[i + 1];
    // The flag and the space after it are one piece: no line ends between a flag and its value.
    if (isFlag(w) && next !== undefined && !next.startsWith('--')) {
      out.push(whole(`${w} `), ...argPieces(next));
      i++;
      continue;
    }
    out.push(...argPieces(w));
  }
  return out;
}
