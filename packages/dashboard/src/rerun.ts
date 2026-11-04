import { fieldValue, type StepRerun } from '@shadowlap/engine';

/**
 * The arguments Run blame again, Run more attempts and Verify again run `shadowlap` with, built from a
 * kept blame's or verdict's checked fields: its report (runs, gate, request fields), its check, its
 * scope, and the flags it kept beside them (`StepRerun`), each one a flag this list allows with a
 * value of the shape it allows. Never from the command line it kept, which a pull can bring from
 * anyone's machine: a value is never a flag, a file (`@…`), or anything after `--` that a teammate
 * wrote.
 *
 * Three things are this machine's own, run again only from a record made here: the command given
 * after `--`, and verify's `--base` (a commit whose code the baseline runs) and `--build` (a shell
 * command). A record a pull brought (`pulled`) runs again without them, and says which it left out.
 * A record kept before its flags were (no `rerun`), or with anything this list doesn't allow, is not
 * run again from here: its command is the user's to read and type.
 */

/** A run id as the store makes them. */
const RUN_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** A model name: `claude-opus-5-5`, `gpt-4o-2024-08-06`, `us.anthropic.claude-…:0`, `models/gemini-2.5-pro`. */
const MODEL = /^[A-Za-z0-9][\w.:/@[\]+-]{0,199}$/;
/**
 * What disguises a command line a person is asked to say yes to: a control character, a format
 * character (a right-to-left override, a zero-width space) or a line or paragraph separator. A value
 * holding one is never run again from here.
 */
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u;
/** A name (a tool's, a scope's): one line, at most 200 characters, never starting like a flag, a file or a space, and nothing hidden in it. */
const NAME = /^[^\s@-][^\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]{0,199}$/u;
/** A request field's dotted path, as `--set` takes it. */
const FIELD = /^[A-Za-z_][\w.]{0,199}$/;
const USD = /^\d{1,9}(?:\.\d{1,9})?$/;
const SECONDS = /^[1-9]\d{0,6}$/;
/** A share between 0 and 1, as `--margin` takes it. */
const SHARE = /^(?:0?\.\d{1,12}|0)$/;
/** A git revision as `--base` takes it: a ref, a hash, `HEAD~1`; never an option. */
const REVISION = /^[A-Za-z0-9_][\w./@{}^~-]{0,199}$/;
/** A shell command `--build` runs: one line. */
const LINE = /^[^\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]{1,4096}$/u;

export type RerunKind = 'blame' | 'verify';

/** A flag's value shape (null for a flag that takes none), whether it is this machine's own, and the most a pulled record may give it. */
interface FlagRule {
  value: RegExp | null;
  check?: (value: string) => boolean;
  own?: true;
  pulledMax?: number;
}

const STEP: Record<string, FlagRule> = {
  '--writes': { value: /^(?:stub|block)$/ },
  '--reads': { value: /^(?:live|replay)$/ },
  '--budget': { value: USD, check: (v) => Number(v) > 0 },
  '--timeout': { value: SECONDS },
};

/** The flags each command is run again with, beyond what its report and record hold. */
const RERUN_FLAGS: Readonly<Record<RerunKind, Readonly<Record<string, FlagRule>>>> = {
  // A pulled blame probes at most its default 2 calls past the boundary: one yes spends no more than Shadowlap would.
  blame: { ...STEP, '--scan': { value: /^\d{1,3}$/, pulledMax: 2 } },
  verify: {
    ...STEP,
    '--from': { value: MODEL },
    '--live-tool': { value: NAME },
    '--margin': { value: SHARE, check: (v) => Number(v) > 0 && Number(v) < 1 },
    '--baseline': { value: /^(?:paired|history)$/ },
    '--fail-fast': { value: null },
    '--base': { value: REVISION, check: (v) => !v.includes('..'), own: true },
    '--build': { value: LINE, own: true },
  },
};

export interface RerunFlags {
  /** The flags it runs again with, checked, in the order kept. */
  flags: string[];
  /** The command after `--`, from a record made here; null for none. */
  command: string[] | null;
  /** What a pulled record's own flags left out: `--build`, `--base`, and `--` for the command after it (`leftWords` says them). */
  left: string[];
  /** The values of the flags `drop` left out, by flag (`--budget`: `0.5`); a flag that takes none, as ''. */
  dropped: Record<string, string>;
}

/** A command after `--` as the CLI takes it: words of text, the first of them a program, never a flag. */
function isCommand(v: readonly string[]): boolean {
  return v.length > 0 && v.length <= 1000 && v.every((w) => typeof w === 'string' && w.length <= 16_384 && !w.includes('\u0000')) && !!v[0] && !v[0].startsWith('-');
}

/**
 * A kept blame's or verdict's flags, checked: every one a flag `RERUN_FLAGS` allows for its kind,
 * each value of its shape, `drop` (flags the caller sets itself) left out. Null when the record has
 * none (kept before they were) or anything is not of its shape: then it is not run again from here.
 * Of a pulled record, `--base`, `--build` and the command after `--` are left out (`left`), and a
 * figure is held to the most a pulled record may give it (`pulledMax`).
 */
export function rerunFlags(kind: RerunKind, rerun: StepRerun | null | undefined, o: { pulled: boolean; drop?: ReadonlySet<string> }): RerunFlags | null {
  if (!rerun || !Array.isArray(rerun.flags)) return null;
  const rules = RERUN_FLAGS[kind];
  const flags: string[] = [];
  const left: string[] = [];
  const dropped: Record<string, string> = {};
  for (let i = 0; i < rerun.flags.length; i++) {
    const flag = rerun.flags[i]!;
    const rule = Object.hasOwn(rules, flag) ? rules[flag]! : null;
    if (!rule) return null;
    let value: string | null = null;
    if (rule.value) {
      value = rerun.flags[i + 1] ?? null;
      if (value === null || !rule.value.test(value) || (rule.check && !rule.check(value))) return null;
      i++;
    }
    if (o.drop?.has(flag)) {
      dropped[flag] = value ?? '';
      continue;
    }
    if (rule.own && o.pulled) {
      if (!left.includes(flag)) left.push(flag);
      continue;
    }
    // A pulled record's figure held to the most it may give (one yes spends no more than Shadowlap would).
    const held = value !== null && o.pulled && rule.pulledMax !== undefined && Number(value) > rule.pulledMax ? String(rule.pulledMax) : value;
    flags.push(flag, ...(held === null ? [] : [held]));
  }
  let command: string[] | null = null;
  if (rerun.command?.length) {
    if (!isCommand(rerun.command)) return null;
    if (o.pulled) left.push('--');
    else command = [...rerun.command];
  }
  return { flags, command, left, dropped };
}

/**
 * Request fields as `--model` and `--set` take them, read back as they were: a string that would
 * parse as JSON goes quoted. Null when a field's path or the model isn't of its shape, or a value
 * holds a character that would disguise the command line (HIDDEN).
 */
export function fieldArgs(fields: Record<string, unknown> | null | undefined): string[] | null {
  const out: string[] = [];
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (k === 'model' && typeof v === 'string') {
      if (!MODEL.test(v)) return null;
      out.push('--model', v);
      continue;
    }
    if (!FIELD.test(k) || v === undefined) return null;
    const arg = `${k}=${fieldValue(v)}`;
    if (HIDDEN.test(arg)) return null;
    out.push('--set', arg);
  }
  return out;
}

/** Whether every id is a run id as the store makes them. */
export const runIds = (ids: readonly string[]): boolean => ids.every((id) => RUN_ID.test(id));

/** A count as `--attempts` and `--passes` take one: a whole number in range. */
export const isCount = (n: unknown, max = 1000): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= max;
