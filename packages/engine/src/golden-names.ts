import { NAME_MAX } from './name-max.js';

/**
 * The names the goldens a fix's apply copies go by: `shadowlap fix apply <fix> --name <run>=<name>`,
 * and the dashboard's Apply fix, which asks for one in a field beside each. A golden is a folder of the
 * goldens folder, named for what a test reads it by, never a run's id. The rule a name keeps, the
 * name each takes when none is given, and the words that say a name won't do, for the CLI, the
 * server's apply job and the dialog's field alike. Its one import, NAME_MAX, imports nothing: the
 * dashboard's pages bundle it as it is.
 */

/** A golden's name: lower-case letters, digits and hyphens, from a letter or a digit. */
const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** The names Windows keeps for its devices, read without case as it reads them: a folder of one misbehaves there. */
const DEVICE = /^(?:con|nul|prn|aux|com[1-9]|lpt[1-9])$/i;

/** The longest name a label or a title makes, before a number goes after it: well within NAME_MAX. */
const MADE_MAX = 40;

/**
 * Text as a golden's name: lower-cased, accents dropped, each run of other characters a hyphen, cut
 * to 40 characters at the end of a word where it can be; empty when nothing of it is left, or when
 * what is left is a name Windows keeps for itself.
 */
export function asGoldenName(text: string): string {
  const whole = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const end = whole.length > MADE_MAX ? whole.lastIndexOf('-', MADE_MAX) : whole.length;
  const name = end > 0 ? whole.slice(0, end) : whole.slice(0, MADE_MAX);
  return DEVICE.test(name) ? '' : name;
}

/**
 * The names a fix's goldens go by when none is given: its label, else its title, as a name (else
 * `golden`), numbered after it when its repair made several recordings (`refund-bug-1`,
 * `refund-bug-2`), each by its place among them, so a name stays whichever are copied. Neither makes
 * a name past 40 characters before its number, well within NAME_MAX, nor one Windows keeps for
 * itself: a label that would (`con`) gives way to the title.
 */
export function defaultGoldenNames(fix: { label: string | null; title: string }, count: number): string[] {
  const made = asGoldenName(fix.label ?? '') || asGoldenName(fix.title) || 'golden';
  return count === 1 ? [made] : Array.from({ length: count }, (_, i) => `${made}-${i + 1}`);
}

/** Why the names given won't do, as the dialog says it under its fields: the first name it is about (`at`, its place among them), and why. */
export interface GoldenNameProblem {
  at: number;
  text: string;
}

/**
 * Why the names for the goldens apply copies won't do, or null when each will: every one given, none
 * a name Windows keeps for itself (`con`, `nul`, `prn`, `aux`, `com1` to `com9`, `lpt1` to `lpt9`, in
 * any case), of lower-case letters, digits and hyphens from a letter or a digit, at most NAME_MAX of
 * them, as a judge's name is, the only one with that name, and none taken in the goldens folder.
 * `held` names what that folder holds, read without case, as macOS and Windows read a folder's name;
 * `folder` is the goldens folder as the words show it (`goldens`).
 */
export function goldenNamesProblem(names: readonly string[], o: { folder: string; held: readonly string[] }): GoldenNameProblem | null {
  const held = new Set(o.held.map((h) => h.toLowerCase()));
  const checks: Array<[(n: string, i: number) => boolean, (n: string) => string]> = [
    [(n) => !n, () => (names.length > 1 ? 'Give each golden a name.' : 'Give the golden a name.')],
    [(n) => DEVICE.test(n), (n) => `${n} is a name Windows keeps for itself: pick another.`],
    [(n) => !NAME.test(n), () => 'A golden’s name takes lower-case letters, digits and hyphens.'],
    [(n) => n.length > NAME_MAX, () => `A golden’s name is at most ${NAME_MAX} characters.`],
    [(n, i) => names.indexOf(n) !== i, () => 'Each golden needs a name of its own.'],
    [(n) => held.has(n), (n) => `${o.folder.replace(/\/+$/, '')}/${n} is taken: pick another name.`],
  ];
  for (const [bad, words] of checks) {
    const at = names.findIndex(bad);
    if (at >= 0) return { at, text: words(names[at]!) };
  }
  return null;
}

/** The flags that give the goldens their names, as `fix apply` takes them: `--name <run>=<name>` for each. */
export const goldenNameArgs = (names: ReadonlyArray<{ run: string; name: string }>): string[] => names.flatMap((n) => ['--name', `${n.run}=${n.name}`]);
