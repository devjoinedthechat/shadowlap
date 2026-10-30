import { CREDENTIAL_PLACEHOLDER, credentialFlag, credentialHeader, credentialQueryParam, jwtShaped, maskTextCredentials, maskUrlCredentials, urlShaped } from './http.js';
import { rawWord, rewriteWords, scriptWord, shellWords, type WordWriter } from './shell-words.js';
import { quoteArgv } from './text.js';

/**
 * Credentials on a command line, masked as every copy that leaves the machine writes it: a run's
 * command line in a pack, an HTML file or a share link, a push, a trace and a dataset, and the
 * command lines a fix's blames, verdicts and repairs ran (fix-doc.ts). The store keeps a run's
 * command as it ran, which a replay runs again.
 *
 * A credential is found where a command line puts one: the value of a flag whose name says so
 * (credentialFlag), an assignment's or a header line's, a URL's, a JWT, what a text holds, and what
 * a program takes under a name that doesn't say so (PROGRAMS: curl's `-u user:password`, mysql's
 * `-pPASSWORD`, a body curl sends); and in a script a program runs (`sh -c`, `cmd /c`, PowerShell's
 * `-Command`, `python -c`, an ssh remote command, a `--build` script), word by word.
 */

const C = CREDENTIAL_PLACEHOLDER;

/** An argument written as a flag: `--name`, `-name`, with `=value` or not. */
const FLAG_ARG = /^--?([A-Za-z][\w.-]*)(?:=([^]*))?$/;
/** An argument that assigns a value: `API_KEY=…`, `auth.password=…` (`env`, `helm --set`, `vault write`). */
const ASSIGN_ARG = /^([A-Za-z_][\w.-]*)=([^]*)$/;
/** An argument that is a header line: `Authorization: Bearer …` (curl's `-H`). */
const HEADER_ARG = /^([A-Za-z][\w-]*):[ \t]*(\S[^]*)$/;
/** A value the text masker reads: with white space or an `=` in it, or JSON. */
const TEXT = /[\s=]|^\s*[{[]/;
/** How many scripts deep a script inside a script is read word by word; one deeper is masked as any other argument. */
const MAX_SCRIPTS = 4;

/**
 * A value as an argument or an option holds it, with its credentials masked: a JWT; a header line's
 * credential (`Authorization: Bearer …`); a URL's (maskUrlCredentials: its user info's password, its
 * query, a webhook's secret); and in text, what the text masker reads there (maskTextCredentials: a
 * URL's password and a JWT wherever they stand, `key: value` and `key=value` lines, a form, JSON).
 */
function credentialFreeValue(value: string): string {
  if (jwtShaped(value)) return C;
  const header = HEADER_ARG.exec(value);
  if (header && header[2] !== C && credentialHeader(header[1]!)) return `${value.slice(0, value.length - header[2]!.length)}${C}`;
  if (urlShaped(value)) return maskUrlCredentials(value);
  return TEXT.test(value) ? (maskTextCredentials(value) ?? value) : value;
}

/**
 * One argument with its credentials masked: an assignment's value whole when its name reads as a
 * credential with it (`API_KEY=…`), else the value it assigns as any other (`DATABASE_URL=` a URL
 * with a password, a JWT, git's `http.extraheader=AUTHORIZATION: …`); any other argument as a value
 * (credentialFreeValue).
 */
function credentialFreeArgument(arg: string): string {
  const assign = ASSIGN_ARG.exec(arg);
  if (!assign) return credentialFreeValue(arg);
  const name = assign[1]!;
  const value = assign[2]!;
  if (!value || value === C) return arg;
  if (credentialQueryParam(name, value)) return `${name}=${C}`;
  const masked = credentialFreeValue(value);
  return masked === value ? arg : `${name}=${masked}`;
}

// ---- What a program's options take

/**
 * What an option's value holds: a credential whole (`secret`); a password after a user and `:`
 * (`user`) or `%` (`percent`, smbclient's); a body, read as a form or JSON (`body`); a script a
 * POSIX shell runs (`sh`), or code another language runs (`code`), each masked word by word.
 */
type Kind = 'secret' | 'user' | 'percent' | 'body' | 'sh' | 'code';

/**
 * An option's rule: what its value holds, whether the value may be glued to it (`-pPASSWORD`), or
 * only so (`gluedOnly`: mysql's `-p` alone asks for the password, and the word after it is the
 * database), and a word that must come between the program and it (`after`: docker's `login`).
 */
interface OptionRule {
  kind: Kind;
  glued?: true;
  gluedOnly?: true;
  after?: string;
}

const SECRET: OptionRule = { kind: 'secret' };
const USER: OptionRule = { kind: 'user', glued: true };
const BODY: OptionRule = { kind: 'body' };
const SH: OptionRule = { kind: 'sh' };
const CODE: OptionRule = { kind: 'code' };

/** By program (programOf), the options whose value holds a credential under a name that doesn't say so, or a script. */
const PROGRAMS = new Map<string, ReadonlyMap<string, OptionRule>>();

function programs(names: readonly string[], options: Readonly<Record<string, OptionRule>>): void {
  for (const name of names) PROGRAMS.set(name, new Map([...(PROGRAMS.get(name) ?? []), ...Object.entries(options)]));
}

// A user's password after its colon; curl's proxy's too, and the bearer token it sends.
programs(['curl'], { '-u': USER, '--user': USER, '-U': USER, '--proxy-user': USER, '--oauth2-bearer': SECRET });
programs(['http', 'https', 'httpie', 'xh', 'xhs'], { '-a': USER, '--auth': USER });
programs(['ab'], { '-A': USER, '-P': USER });
// -p is a port or a path in most programs, a password only in these: mysql's glued to it alone.
programs(['mysql', 'mysqldump', 'mysqladmin', 'mysqlimport', 'mysqlshow', 'mysqlcheck', 'mysqlpump', 'mysqlslap', 'mysqlbinlog', 'mariadb', 'mariadb-dump', 'mariadb-admin', 'mariadb-import', 'mariadb-show', 'mariadb-check', 'mariadb-slap', 'mariadb-binlog'], { '-p': { kind: 'secret', glued: true, gluedOnly: true } });
programs(['mongo', 'mongosh', 'mongodump', 'mongorestore', 'mongoexport', 'mongoimport', 'mongostat', 'mongotop', 'mongofiles', 'sshpass'], { '-p': { kind: 'secret', glued: true } });
programs(['docker', 'podman', 'nerdctl', 'buildah', 'finch'], { '-p': { kind: 'secret', after: 'login' } });
// The same password under another letter.
programs(['redis-cli'], { '-a': SECRET });
programs(['sqlcmd', 'bcp', 'osql'], { '-P': SECRET });
programs(['ldapsearch', 'ldapadd', 'ldapmodify', 'ldapdelete', 'ldapwhoami', 'ldappasswd', 'ldapcompare', 'ldapmodrdn', 'ldapexop'], { '-w': SECRET });
programs(['smbclient', 'rpcclient'], { '-U': { kind: 'percent', glued: true }, '--user': { kind: 'percent' } });
// Scripts: a POSIX shell's `-c` (alone or last in a cluster, `-lc`), and other languages' code.
programs(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'csh', 'tcsh', 'su'], { '-c': SH });
programs(['cmd'], { '/c': CODE, '/k': CODE });
programs(['pwsh', 'powershell'], { '-c': CODE, '-command': CODE });
programs(['python', 'py'], { '-c': CODE });
programs(['node', 'nodejs', 'bun'], { '-e': CODE, '--eval': CODE, '-p': CODE, '--print': CODE });
programs(['ruby'], { '-e': CODE });
programs(['perl'], { '-e': CODE, '-E': CODE });
programs(['php'], { '-r': CODE });
// ssh: the remote command, a script the shell on the far end runs (plainArgument).
programs(['ssh'], {});

/** Options read so whatever the program: a body curl and its kin send, and a build script (`repair --build`). */
const ANY = new Map<string, OptionRule>([
  ['-d', { kind: 'body', glued: true }],
  ['--data', BODY],
  ['--data-raw', BODY],
  ['--data-binary', BODY],
  ['--data-ascii', BODY],
  ['--data-urlencode', BODY],
  ['--json', BODY],
  ['-F', { kind: 'body', glued: true }],
  ['--form', BODY],
  ['--form-string', BODY],
  ['--build', SH],
]);

/** Programs whose options are read in any case: Windows' own. */
const CASELESS = new Set(['cmd', 'pwsh', 'powershell']);

/** A command's program as PROGRAMS names it: its file's name, in lower case, without a folder, `.exe` or a version (`python3.12`). */
function programOf(word: string): string {
  const name = (word.split(/[\\/]/).pop() ?? word).toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, '');
  return /^(?:python|pypy)[\d.]*$/.test(name) ? 'python' : name;
}

/** The program a command line's options belong to, as it is read: the last one PROGRAMS knows, and the words since it. */
interface Program {
  name: string;
  since: Set<string>;
}

/** An option's rule for the program, the case it is read in, and a word it needs after the program. */
function ruleFor(program: Program, option: string): OptionRule | undefined {
  const rule = PROGRAMS.get(program.name)?.get(CASELESS.has(program.name) ? option.toLowerCase() : option) ?? ANY.get(option);
  return rule && (!rule.after || program.since.has(rule.after)) ? rule : undefined;
}

/** An option a rule reads, and its value when the argument holds it: after `=`, or glued (`-pPASSWORD`); null when it is the next argument. */
interface Ruled {
  rule: OptionRule;
  prefix: string;
  value: string | null;
}

/**
 * The option an argument is, when a rule reads its value: the option itself (`-u`, `/c`, `-Command`);
 * `--name=value`; a cluster of short options its last one ends (`-sSu`, bash's `-lc`); or a short
 * option with its value glued to it (`-ualice:…`, `-pPASSWORD`). Undefined for any other argument.
 */
function ruledOption(program: Program, arg: string): Ruled | undefined {
  const exact = ruleFor(program, arg);
  if (exact) return { rule: exact, prefix: '', value: null };
  const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
  const long = eq > 2 ? ruleFor(program, arg.slice(0, eq)) : undefined;
  if (long) return { rule: long, prefix: arg.slice(0, eq + 1), value: arg.slice(eq + 1) };
  if (!/^-[A-Za-z]/.test(arg) || arg.length < 3) return undefined;
  const last = /^-[A-Za-z]+$/.test(arg) ? ruleFor(program, `-${arg.at(-1)!}`) : undefined;
  if (last && !last.gluedOnly) return { rule: last, prefix: '', value: null };
  const glued = ruleFor(program, arg.slice(0, 2));
  return glued?.glued ? { rule: glued, prefix: arg.slice(0, 2), value: arg.slice(2) } : undefined;
}

/** `user:password` (or smbclient's `user%password`) with its password masked; as it is without one, a user alone. */
function afterMark(value: string, mark: string): string {
  const at = value.indexOf(mark);
  const rest = at < 0 ? '' : value.slice(at + 1);
  return !rest || rest === C ? value : `${value.slice(0, at + 1)}${C}`;
}

/** An option's value with its credentials masked as its rule reads it. */
function maskedBy(rule: OptionRule, value: string, depth: number): string {
  if (rule.kind === 'secret') return value === '' || value === C ? value : C;
  if (rule.kind === 'user') return afterMark(value, ':');
  if (rule.kind === 'percent') return afterMark(value, '%');
  if (rule.kind === 'body') return maskTextCredentials(value) ?? value;
  return credentialFreeScript(value, depth, rule.kind === 'sh' ? scriptWord : rawWord);
}

/**
 * An argument no rule took as an option's value: an ssh remote command with white space in it, as
 * the far end's shell runs it; else as any other argument (credentialFreeArgument). A program
 * PROGRAMS knows starts its own options, and every other word is one since it (docker's `login`).
 */
function plainArgument(program: Program, arg: string, depth: number): string {
  if (program.name === 'ssh' && /\s/.test(arg)) return credentialFreeScript(arg, depth, scriptWord);
  const name = programOf(arg);
  if (PROGRAMS.has(name)) {
    program.name = name;
    program.since.clear();
  } else program.since.add(arg);
  return credentialFreeArgument(arg);
}

/**
 * A script a program runs (`sh -c '…'`, `cmd /c`, `python -c`, an ssh remote command), masked word
 * by word as credentialFreeArgv masks a command line's arguments, each word read as a shell reads it
 * (shellWords): an assignment's value up to where its word ends, the rest of the script kept, a
 * flag's value and a header line as in any command line, and a script it hands on in turn. A word
 * that changes is written again in its place by `write`: as a POSIX shell quotes it (scriptWord), or
 * in the quotes its language wrote it in (rawWord), every other character as it was. A script whose
 * quote is left open, or one inside MAX_SCRIPTS others, is masked as any other argument.
 */
function credentialFreeScript(script: string, depth: number, write: WordWriter): string {
  const words = depth < MAX_SCRIPTS ? shellWords(script) : null;
  if (!words) return credentialFreeArgument(script);
  // No program before its first word, which is read as any other (`API_KEY=… node agent.js`).
  const values = ['', ...words.map((w) => w.value)];
  const masked = argvWithoutCredentials(values, depth + 1);
  return masked === values ? script : rewriteWords(script, words, masked.slice(1), write);
}

/**
 * A command line as every copy that leaves the machine writes it, its credentials masked with
 * CREDENTIAL_PLACEHOLDER: the value of each flag that takes one (`--api-key <value>`,
 * `--api-key=<value>`, `-token <value>` as Go's flags are written: credentialFlag); what a program
 * takes under a name that doesn't say so (PROGRAMS, ANY: curl's `-u user:password`, mysql's
 * `-pPASSWORD`, a body curl sends, a script); in any other argument or flag value a JWT, an
 * assignment's or a header line's credential, a URL's, and what its text holds
 * (credentialFreeArgument). The program stays as it is. The same array when nothing changes.
 */
export function credentialFreeArgv(argv: readonly string[]): readonly string[] {
  return argvWithoutCredentials(argv, 0);
}

/** credentialFreeArgv, `depth` scripts deep. */
function argvWithoutCredentials(argv: readonly string[], depth: number): readonly string[] {
  let out: string[] | null = null;
  const set = (i: number, value: string) => {
    if (value === argv[i]) return;
    out ??= [...argv];
    out[i] = value;
  };
  const program: Program = { name: programOf(argv[0] ?? ''), since: new Set() };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    const ruled = ruledOption(program, arg);
    if (ruled) {
      // Its value in the argument, or the next one, unless that is a flag of its own.
      if (ruled.value !== null) set(i, `${ruled.prefix}${maskedBy(ruled.rule, ruled.value, depth)}`);
      else if (!ruled.rule.gluedOnly && i + 1 < argv.length && !FLAG_ARG.test(argv[i + 1]!)) {
        i++;
        set(i, maskedBy(ruled.rule, argv[i]!, depth));
      }
      continue;
    }
    const flag = FLAG_ARG.exec(arg);
    if (!flag) {
      set(i, plainArgument(program, arg, depth));
      continue;
    }
    const [, name = '', value] = flag;
    if (value !== undefined) {
      const masked = value === '' || value === C ? value : credentialFlag(name, value) ? C : credentialFreeArgument(value);
      set(i, `${arg.slice(0, arg.length - value.length)}${masked}`);
      continue;
    }
    // A flag's value is the argument after it, unless that is a flag of its own.
    const next = argv[i + 1];
    if (next === undefined || FLAG_ARG.test(next) || !credentialFlag(name, next)) continue;
    if (next !== '' && next !== C) set(i + 1, C);
    i++;
  }
  return out ?? argv;
}

/** Whether a command line carries a credential every copy masks (credentialFreeArgv); false for none at all. */
export function argvCarriesCredentials(argv: readonly string[] | undefined): boolean {
  return !!argv && credentialFreeArgv(argv) !== argv;
}

/** Whether two command lines are one, but for the credentials a copy masks in them (credentialFreeArgv). */
export function sameCommandLine(a: readonly string[], b: readonly string[]): boolean {
  return JSON.stringify(credentialFreeArgv(a)) === JSON.stringify(credentialFreeArgv(b));
}

/**
 * A command line written as one text, as quoteArgv writes it (the command a blame, a verdict or a
 * repair keeps, as the CLI printed it), with its credentials masked as credentialFreeArgv masks its
 * words, each word read as a shell reads it (shellWords): a word that changes is written again in
 * its place, quoted as quoteArgv quotes it, every other character as it was. A text whose quote is
 * left open has each of its words between white space masked as one. The same string when nothing
 * changes.
 */
export function credentialFreeCommandLine(text: string): string {
  const words = shellWords(text) ?? [...text.matchAll(/\S+/g)].map((m) => ({ start: m.index, end: m.index + m[0].length, value: m[0] }));
  const values = words.map((w) => w.value);
  const masked = credentialFreeArgv(values);
  return masked === values ? text : rewriteWords(text, words, masked, (v) => quoteArgv([v]));
}
