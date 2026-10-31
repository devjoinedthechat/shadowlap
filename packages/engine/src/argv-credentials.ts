import { CREDENTIAL_PLACEHOLDER, credentialFlag, credentialHeader, credentialQueryParam, jwtShaped, maskTextCredentials, maskUrlCredentials, urlShaped } from './http.js';
import { rawWord, rewriteWords, scriptWord, shellWords, type ShellWord, type WordWriter } from './shell-words.js';
import { quoteArgv } from './text.js';

/**
 * Credentials on a command line, masked as every copy that leaves the machine writes it: a run's
 * command line in a pack, an HTML file or a share link, a push, a trace and a dataset, and the
 * command lines a fix's blames, verdicts and repairs ran (fix-doc.ts). The store keeps a run's
 * command as it ran, which a replay runs again.
 *
 * A credential is found where a command line puts one: the value of a flag whose name says so
 * (credentialFlag), an assignment's or a header line's, a URL's, a JWT, a libpq connection string's
 * password, what a text holds, what a program takes under a name that doesn't say so (PROGRAMS:
 * curl's `-u user:password`, mysql's `-pPASSWORD`, a body curl sends) and what it takes by a word's
 * place (PLACES: vault's `login TOKEN`, `aws configure set aws_secret_access_key …`); and in a script
 * a program runs (`sh -c`, `cmd /c`, PowerShell's `-Command`, `python -c`, an ssh remote command, a
 * `--build` script), word by word.
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
 * A parameter of a libpq connection string, as libpq reads one: a keyword, `=` with white space
 * around it or not, and a value in single quotes or to the next white space, a backslash keeping
 * the character after it.
 */
const CONNINFO_PARAM = /(\s*([A-Za-z_]\w*)\s*=\s*)('(?:[^'\\]|\\[^])*'|(?!')(?:[^\s\\]|\\[^])+)(\s*)/y;

/**
 * A libpq connection string (`host=db user=app password=… dbname=shop`, which psql, pg_dump and
 * libpq's other clients take) with the value of each parameter that is a credential masked: its
 * `password`, `sslpassword` (the client key's) and any other named as one (credentialQueryParam).
 * Two or more parameters and nothing else. Null when it isn't one, or holds none.
 */
function maskConnInfo(text: string): string | null {
  const parts: string[] = [];
  let pairs = 0;
  let changed = false;
  CONNINFO_PARAM.lastIndex = 0;
  for (let m = CONNINFO_PARAM.exec(text); m; m = CONNINFO_PARAM.exec(text)) {
    pairs++;
    const [whole, lead = '', keyword = '', value = '', space = ''] = m;
    const credential = value !== C && (/password$/i.test(keyword) || credentialQueryParam(keyword, value.replace(/^'([^]*)'$/, '$1')));
    changed ||= credential;
    parts.push(credential ? `${lead}${C}${space}` : whole);
    if (CONNINFO_PARAM.lastIndex >= text.length) return pairs >= 2 && changed ? parts.join('') : null;
  }
  return null;
}

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
 * (credentialFreeValue); then a libpq connection string's password (withoutConnInfo).
 */
function credentialFreeArgument(arg: string): string {
  const assign = ASSIGN_ARG.exec(arg);
  if (!assign) return withoutConnInfo(credentialFreeValue(arg));
  const name = assign[1]!;
  const value = assign[2]!;
  if (!value || value === C) return arg;
  if (credentialQueryParam(name, value)) return `${name}=${C}`;
  const masked = credentialFreeValue(value);
  return withoutConnInfo(masked === value ? arg : `${name}=${masked}`);
}

/**
 * Text as the rest of the masking left it, with a libpq connection string's password masked too
 * (maskConnInfo): read after the rest, so a text an earlier version masked is masked to the same as
 * the one it ran with.
 */
function withoutConnInfo(text: string): string {
  return maskConnInfo(text) ?? text;
}

// ---- What a program's options take

/**
 * What an option's value holds: a credential whole (`secret`); a password after a user and `:`
 * (`user`) or `%` (`percent`, smbclient's), or after `:` when the value reads as a user and one
 * (`login`, LOGIN); a value after a name and `=` (`assigned`, kubectl's `--from-literal`); a body,
 * read as a form or JSON (`body`); a script a POSIX shell runs (`sh`), or code another language runs
 * (`code`), each masked word by word; or nothing more than any other argument (`plain`: docker's
 * `--user user:group`).
 */
type Kind = 'secret' | 'user' | 'percent' | 'login' | 'assigned' | 'body' | 'sh' | 'code' | 'plain';

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
// az's and twine's, as Python's argparse reads one, glued too: az's -p is a parameters file but for a login (`az acr login`).
programs(['az'], { '-p': { kind: 'secret', glued: true, after: 'login' } });
programs(['twine'], { '-p': { kind: 'secret', glued: true } });
// Each literal a Secret is made of (`--from-literal=password=…`); a ConfigMap's are no secret.
programs(['kubectl', 'oc'], { '--from-literal': { kind: 'assigned', after: 'secret' } });
// A container's --user is a user and a group (`1000:1000`, `app:app`), any other program's a user and a password (ANY).
programs(['docker', 'podman', 'nerdctl', 'buildah', 'finch', 'docker-compose', 'podman-compose'], { '--user': { kind: 'plain' } });
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

/**
 * A user and a password, as `--user` gives them to a program no rule names (`etcdctl --user
 * root:…`): a user with no white space, `:`, `/` or `\` in it, and a password after its colon. Never
 * a URL (`git+https://…`, a package `pip install --user` takes) or a drive's path (`C:\…`), whose
 * colon a slash follows, nor a uid and a gid (`1000:1000`).
 */
const LOGIN = /^(?!\d+:\d+$)[^\s:/\\]+:(?![/\\])[^]+$/;

/**
 * Options read so whatever the program: a body curl and its kin send, a build script (`repair
 * --build`), and a user's password `--user` gives (LOGIN).
 */
const ANY = new Map<string, OptionRule>([
  ['--user', { kind: 'login' }],
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

// ---- What a program takes by a word's place

/**
 * A secret a program takes by a word's place among the words after a command of its (`command`,
 * its words one after another; a flag holds no place, nor the value VALUE_FLAGS says it takes): the
 * first of them, unless it is an assignment (`first`: vault's `login TOKEN`); each assignment's value
 * after the first, which is the path written to (`values`: all of `vault kv put secret/db user=app
 * password=…` is the secret); the value given a setting whose name is a credential's (`named`: `aws
 * configure set aws_secret_access_key …`); or the word that many after the command, counted from 0
 * (`mc alias set NAME URL ACCESS SECRET`: 3).
 */
interface PlaceRule {
  command: readonly string[];
  take: 'first' | 'values' | 'named' | number;
}

/** By program (programOf), the secrets its commands take by a word's place. */
const PLACES = new Map<string, readonly PlaceRule[]>([
  // A token to sign in with or to unwrap, an unseal key's share, and every value a KV write puts.
  [
    'vault',
    [
      { command: ['login'], take: 'first' },
      { command: ['unwrap'], take: 'first' },
      { command: ['operator', 'unseal'], take: 'first' },
      { command: ['kv', 'put'], take: 'values' },
      { command: ['kv', 'patch'], take: 'values' },
    ],
  ],
  // The secret key after an alias, its URL and its access key; a user's password after the alias and the user.
  [
    'mc',
    [
      { command: ['alias', 'set'], take: 3 },
      { command: ['config', 'host', 'add'], take: 3 },
      { command: ['admin', 'user', 'add'], take: 2 },
    ],
  ],
]);

/** Whatever the program: a setting's value, when its name is a credential's (`aws configure set`, `npm config set`, `kubectl config set`). */
const ANY_PLACES: readonly PlaceRule[] = [
  { command: ['config', 'set'], take: 'named' },
  { command: ['configure', 'set'], take: 'named' },
];

/**
 * By program, the flags that take the word after them as their value, so that word holds no place:
 * vault's (Go's flags, one dash or two) and mc's. A flag of theirs not named here leaves the word
 * after it a place of its own, as one that takes none would.
 */
const VALUE_FLAGS = new Map<string, ReadonlySet<string>>([
  ['vault', new Set(['address', 'agent-address', 'ca-cert', 'ca-path', 'cas', 'client-cert', 'client-key', 'field', 'format', 'header', 'method', 'mfa', 'mount', 'namespace', 'ns', 'path', 'policy-override', 'tls-server-name', 'wrap-ttl'])],
  ['mc', new Set(['api', 'path', 'config-dir', 'C', 'custom-header', 'H', 'limit-upload', 'limit-download', 'resolve'])],
]);

/** An assignment a KV write puts (`user=app`): a key of any characters but `=`, and its value. */
const PUT_ARG = /^([^=]+)=([^]*)$/;

/**
 * The program a command line's options belong to, as it is read: the last one PROGRAMS or PLACES
 * knows, the words since it, how far each of its place rules' commands came (how many of its words
 * came last, one after another), and the place rule whose command came: the words since it, and the
 * credential's name a `named` one read.
 */
interface Program {
  name: string;
  since: Set<string>;
  progress: number[];
  place: { rule: PlaceRule; words: number; named: string | null } | null;
}

/** The program a word names (programOf), with nothing read since it. */
function programNamed(word: string): Program {
  return { name: programOf(word), since: new Set(), progress: [], place: null };
}

/** Whether a setting's name (`aws_secret_access_key`, `//registry.example.com/:_auth`) is a credential's with `value`: by its words, or those of its part after its last `.`, `:` or `/`. */
function namesCredential(name: string, value?: string): boolean {
  const part = name.slice(Math.max(name.lastIndexOf('.'), name.lastIndexOf(':'), name.lastIndexOf('/')) + 1);
  return credentialQueryParam(name, value) || (part !== '' && part !== name && credentialQueryParam(part, value));
}

/** A word whose place holds a secret, masked: as it is when it holds none to mask (empty, or masked already). */
const placed = (word: string): string => (word === '' || word === C ? word : C);

/**
 * Moves each of the program's place rules' commands on by a word (`word`, one that holds no place),
 * and opens the place of the rule whose command it ends.
 */
function advance(program: Program, word: string): void {
  let k = 0;
  for (const rules of [PLACES.get(program.name) ?? [], ANY_PLACES]) {
    for (const rule of rules) {
      const at = program.progress[k] ?? 0;
      const next = word === rule.command[at] ? at + 1 : word === rule.command[0] ? 1 : 0;
      if (next === rule.command.length) {
        program.place = { rule, words: 0, named: null };
        program.progress = [];
        return;
      }
      program.progress[k++] = next;
    }
  }
}

/**
 * A word after a command a place rule reads (PlaceRule), as its place says: masked, or undefined to
 * read it as any other argument. A rule reads the words it takes and no more, so the words after
 * them (the next command's, in a script) are their own.
 */
function byPlace(program: Program, word: string): string | undefined {
  const place = program.place;
  if (!place) {
    advance(program, word);
    return undefined;
  }
  const { take } = place.rule;
  if (typeof take === 'number') {
    if (place.words++ < take) return undefined;
    program.place = null;
    return placed(word);
  }
  if (take === 'first') {
    program.place = null;
    return ASSIGN_ARG.test(word) || word === '-' ? undefined : placed(word);
  }
  if (take === 'values') return putValue(program, place, word);
  return settingValue(program, place, word);
}

/** A word after `vault kv put` (PlaceRule `values`): the path it writes to, kept; then each value it puts, masked, but one read from a file (`@…`) or the input (`-`). */
function putValue(program: Program, place: NonNullable<Program['place']>, word: string): string | undefined {
  if (place.words++ === 0) return undefined;
  const put = PUT_ARG.exec(word);
  if (!put) {
    program.place = null;
    return undefined;
  }
  const value = put[2]!;
  return value === '' || value === C || value === '-' || value.startsWith('@') ? undefined : `${put[1]!}=${C}`;
}

/**
 * A word after `config set` (PlaceRule `named`): the value given a name that is a credential's
 * (namesCredential), apart from it or after its `=`, masked. The name is the first word after the
 * command, or the second when a flag's value comes first (`--profile dev`).
 */
function settingValue(program: Program, place: NonNullable<Program['place']>, word: string): string | undefined {
  if (place.named !== null) {
    program.place = null;
    return namesCredential(place.named, word) ? placed(word) : undefined;
  }
  const eq = word.indexOf('=');
  if (eq > 0) {
    program.place = null;
    const value = word.slice(eq + 1);
    return value !== '' && value !== C && namesCredential(word.slice(0, eq), value) ? `${word.slice(0, eq + 1)}${C}` : undefined;
  }
  // By its name alone, a bare `key` or `token` is one: its value says (credentialQueryParam).
  if (namesCredential(word)) place.named = word;
  else if (++place.words >= 2) program.place = null;
  return undefined;
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
  if (rule.kind === 'secret') return placed(value);
  if (rule.kind === 'user') return afterMark(value, ':');
  if (rule.kind === 'percent') return afterMark(value, '%');
  if (rule.kind === 'login') return LOGIN.test(value) ? afterMark(value, ':') : credentialFreeArgument(value);
  if (rule.kind === 'assigned') return value.includes('=') ? afterMark(value, '=') : credentialFreeArgument(value);
  if (rule.kind === 'plain') return credentialFreeArgument(value);
  // A database's connection string too, which psql's and pg_dump's -d take, curl's body's letter.
  if (rule.kind === 'body') return withoutConnInfo(maskTextCredentials(value) ?? value);
  return credentialFreeScript(value, depth, rule.kind === 'sh' ? scriptWord : rawWord);
}

/**
 * Whether an option a rule reads takes the argument after it as its value: one that isn't a flag of
 * its own, and for any program's `--user`, one that reads as a user and a password (LOGIN), as
 * systemd's `--user`, which takes none, is followed by a command.
 */
function takesNext(rule: OptionRule, next: string): boolean {
  return !rule.gluedOnly && !FLAG_ARG.test(next) && (rule.kind !== 'login' || LOGIN.test(next));
}

/**
 * An argument no rule took as an option's value: an ssh remote command with white space in it, as
 * the far end's shell runs it; a word whose place holds a secret (byPlace); else as any other
 * argument (credentialFreeArgument). A program PROGRAMS or PLACES knows starts its own options and
 * places, and every other word is one since it (docker's `login`).
 */
function plainArgument(program: Program, arg: string, depth: number): string {
  if (program.name === 'ssh' && /\s/.test(arg)) return credentialFreeScript(arg, depth, scriptWord);
  const name = programOf(arg);
  if (PROGRAMS.has(name) || PLACES.has(name)) {
    Object.assign(program, programNamed(arg));
    return credentialFreeArgument(arg);
  }
  program.since.add(arg);
  return byPlace(program, arg) ?? credentialFreeArgument(arg);
}

/**
 * A script a program runs (`sh -c '…'`, `cmd /c`, `python -c`, an ssh remote command), masked word
 * by word as credentialFreeArgv masks a command line's arguments, each word read as a shell reads it
 * (shellWords): an assignment's value up to where its word ends, the rest of the script kept, a
 * flag's value and a header line as in any command line, and a script it hands on in turn. A word
 * that changes is written again in its place by `write`: as a POSIX shell quotes it (scriptWord), or
 * in the quotes its language wrote it in (rawWord), every other character as it was. So is a string
 * code gives a credential (givenInCode). A script whose quote is left open, or one inside
 * MAX_SCRIPTS others, is masked as any other argument.
 */
function credentialFreeScript(script: string, depth: number, write: WordWriter): string {
  const words = depth < MAX_SCRIPTS ? shellWords(script) : null;
  if (!words) return credentialFreeArgument(script);
  // No program before its first word, which is read as any other (`API_KEY=… node agent.js`).
  const masked = argvWithoutCredentials(['', ...words.map((w) => w.value)], depth + 1).slice(1);
  return rewriteWords(script, words, givenInCode(script, words, masked), write);
}

/**
 * What follows a string a word writes in quotes, as code writes one (`"…"`, `'…'`): what ends the
 * expression it stands in (`,`, `}`, `]`), or nothing; null when the word is no such string.
 */
function afterLiteral(raw: string): string | null {
  const quote = raw[0];
  const close = quote === '"' || quote === "'" ? raw.lastIndexOf(quote) : -1;
  const tail = raw.slice(close + 1);
  return close > 0 && /^[,}\]]*$/.test(tail) ? tail : null;
}

/**
 * A script's words (`values`, as masked so far) with the string code gives a credential masked
 * where a shell's reading parts it from the credential's name: assigned with white space around its
 * `=` or `:=` (`api_key = "…"`, `api_key= "…"`, `token ="…"`), or a member's (`{"api_key": "…"}`,
 * `{ apiKey: '…' }`), named as an assignment is (credentialQueryParam). Only a string written in
 * quotes is one (afterLiteral): what reads a key from elsewhere (`os.environ[…]`) or a type
 * (`api_key: str`) is code, kept.
 */
function givenInCode(script: string, words: readonly ShellWord[], values: readonly string[]): readonly string[] {
  let out: string[] | null = null;
  for (let k = 0; k + 1 < words.length; k++) {
    const given = givenAt(words, k);
    const word = given && words[given.at];
    if (!given || !word) continue;
    const tail = afterLiteral(script.slice(word.start + given.lead.length, word.end));
    if (tail === null) continue;
    const value = word.value.slice(given.lead.length, word.value.length - tail.length);
    if (value === '' || value === C || !credentialQueryParam(given.name, value)) continue;
    out ??= [...values];
    out[given.at] = `${given.lead}${C}${tail}`;
  }
  return out ?? values;
}

/**
 * Where code gives a name a value, from word `k` on: the name, the word its value starts, and what
 * leads the value in that word (`=` in `token ="…"`). Null when word `k` gives none.
 */
function givenAt(words: readonly ShellWord[], k: number): { name: string; at: number; lead: string } | null {
  const word = words[k]!.value;
  const next = words[k + 1]!.value;
  if (next === '=' || next === ':=') return { name: word, at: k + 2, lead: '' };
  if (next.startsWith('=') && !next.startsWith('==')) return { name: word, at: k + 1, lead: '=' };
  // `api_key=`, `"api_key":` (a shell reads it `api_key:`), `{apiKey:`: the name ends the word.
  const ends = /^[{([,]*([^=:{}()[\],\s]+)[=:]$/.exec(word);
  return ends ? { name: ends[1]!, at: k + 1, lead: '' } : null;
}

/**
 * A command line as every copy that leaves the machine writes it, its credentials masked with
 * CREDENTIAL_PLACEHOLDER: the value of each flag that takes one (`--api-key <value>`,
 * `--api-key=<value>`, `-token <value>` as Go's flags are written: credentialFlag); what a program
 * takes under a name that doesn't say so (PROGRAMS, ANY: curl's `-u user:password`, mysql's
 * `-pPASSWORD`, a body curl sends, a script) or by a word's place (PLACES, ANY_PLACES: vault's
 * `login TOKEN`, `aws configure set aws_secret_access_key …`); in any other argument or flag value a
 * JWT, an assignment's or a header line's credential, a URL's, and what its text holds
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
  const program = programNamed(argv[0] ?? '');
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    const ruled = ruledOption(program, arg);
    if (ruled) {
      // Its value in the argument, or the next one when it takes it (takesNext).
      if (ruled.value !== null) set(i, `${ruled.prefix}${maskedBy(ruled.rule, ruled.value, depth)}`);
      else if (next !== undefined && takesNext(ruled.rule, next)) set(++i, maskedBy(ruled.rule, next, depth));
      continue;
    }
    const flag = FLAG_ARG.exec(arg);
    if (!flag) set(i, plainArgument(program, arg, depth));
    else if (flag[2] !== undefined) set(i, flagWithValue(arg, flag[1]!, flag[2]));
    // A flag's value is the argument after it, unless that is a flag of its own: masked when the flag
    // takes a credential, and holding no place when the program's place rules know it takes one.
    else if (next !== undefined && !FLAG_ARG.test(next) && credentialFlag(flag[1]!, next)) set(++i, placed(next));
    else if (next !== undefined && !FLAG_ARG.test(next) && VALUE_FLAGS.get(program.name)?.has(flag[1]!)) set(++i, credentialFreeArgument(next));
  }
  return out ?? argv;
}

/** A flag written with its value (`--name=value`), the value masked: whole when the flag takes a credential (credentialFlag), else as any argument. */
function flagWithValue(arg: string, name: string, value: string): string {
  const masked = value === '' || value === C ? value : credentialFlag(name, value) ? C : credentialFreeArgument(value);
  return `${arg.slice(0, arg.length - value.length)}${masked}`;
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
