/**
 * Characters that are never part of a name and that a team store's copy can't keep: C0 and C1
 * control characters, format characters (a right-to-left override, a zero-width space: Unicode's Cf)
 * and line and paragraph separators. They can rewrite a terminal, or disguise what a page or a
 * question asking for a yes shows.
 */
export const HIDDEN_IN_NAME = /[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u;
/**
 * The same, but for text that may run over lines, such as a model's answer in a report: a tab, a
 * line feed and a carriage return are allowed. A push sends the others in a fix as U+FFFD.
 */
export const HIDDEN_IN_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u;

/** A hidden character in a value: its code point (`U+200B`), the path to where it sits, its place there (from 1), and whether it is in a key. */
export interface HiddenCharacter {
  codePoint: string;
  path: string;
  position: number;
  inKey: boolean;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const step = (path: string, key: string) => (IDENTIFIER.test(key) ? (path ? `${path}.${key}` : key) : `${path}[${JSON.stringify(key)}]`);

function found(text: string, re: RegExp, path: string, inKey: boolean): HiddenCharacter | null {
  const chars = [...text];
  const i = chars.findIndex((c) => re.test(c));
  return i < 0 ? null : { codePoint: `U+${chars[i]!.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`, path, position: i + 1, inKey };
}

/**
 * The first hidden character in a value, such as a check's JSON, or null: in a string, one of
 * HIDDEN_IN_TEXT; in a key, one of HIDDEN_IN_NAME, since a pull refuses a key with a line break.
 * A check holding one would reach a teammate as another check (the push writes it as U+FFFD), and
 * no step could run under it again.
 */
export function hiddenCharacter(v: unknown, path = '', depth = 0): HiddenCharacter | null {
  if (typeof v === 'string') return found(v, HIDDEN_IN_TEXT, path, false);
  if (v === null || typeof v !== 'object' || depth > 40) return null;
  if (Array.isArray(v)) {
    for (const [i, x] of v.entries()) {
      const hit = hiddenCharacter(x, `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [k, x] of Object.entries(v)) {
    const hit = found(k, HIDDEN_IN_NAME, path, true) ?? hiddenCharacter(x, step(path, k), depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** Why a check holding a hidden character is refused, naming it and where it sits: `The check holds a hidden character, U+200B, at position 4 of tools.send_email.args.to: remove it. Nothing changed.` */
export function hiddenCharacterWords(h: HiddenCharacter, what = 'The check'): string {
  const where = h.inKey ? `a key ${h.path ? `under ${h.path}` : 'at its top'}` : h.path || 'it';
  return `${what} holds a hidden character, ${h.codePoint}, at position ${h.position} of ${where}: remove it. Nothing changed.`;
}
