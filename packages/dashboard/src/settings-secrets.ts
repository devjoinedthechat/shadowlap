
/**
 * What Settings keeps off the page in an MCP server's config: a secret by its name or by its look, a
 * URL's credentials, and a header that only names where its value comes from left as it is.
 */

/** Names that say a value is a credential, anywhere in the name: `GITHUB_TOKEN`, `--client-secret`, `x-api-key`. */
const SECRET_WORDS = /(token|secret|passw(?:or)?d|credential|bearer|api[-_]?key|private[-_]?key|access[-_]?key|account[-_]?key|cookie|signature)/i;

/** ...or as one whole part of the name, where a substring would also catch `--path` or `--author`: `--pat`, `DB_PWD`, `--auth`, `--dsn`. */
const SECRET_PARTS = new Set(['key', 'pat', 'pwd', 'pass', 'auth', 'oauth', 'authorization', 'dsn', 'sig', 'sas', 'jwt']);

/** Tokens recognisable by their shape. */
const SECRET_VALUE = /^(sk-|sk_|rk_|pk_live|ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|glpat-|xox[abeprs]-|AKIA|ASIA|AIza|ya29\.|eyJ|hf_|npm_|pypi-|shpat_|SG\.|sq0atp-|dop_v1_|lin_api_)/;

/** A secret inside a connection string: `Server=db;Password=…;`, `AccountKey=…`. */
const CONNECTION_SECRET = /\b(password|pwd|passwd|secret|token|api[-_]?key|account[-_]?key|shared[-_]?access[-_]?key)=([^;&\s]+)/gi;

const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

export const HIDDEN = '•••';

function secretName(name: string): boolean {
  const bare = name.replace(/^-+/, '');
  return SECRET_WORDS.test(bare) || bare.split(/[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])/).some((part) => SECRET_PARTS.has(part.toLowerCase()));
}

/**
 * A value that mixes letters and digits the way keys do: 8 characters or more, at least two of
 * each, and no path or spaces in it (`a1b2c3d4`, `xyzzy-plain-key-42`). A name with a version in it
 * (`server-v2`) has one digit; a port or a date has no letters.
 */
function mixedKey(text: string): boolean {
  return text.length >= 8 && /^[\w.~%+=-]+$/.test(text) && !/^[.~-]/.test(text) && (text.match(/\d/g)?.length ?? 0) >= 2 && (text.match(/[A-Za-z]/g)?.length ?? 0) >= 2;
}

/** A URL path segment that is a key rather than a name: a token's shape, letters and digits mixed as in a key, or a long run of them. */
function keyLike(segment: string): boolean {
  let text = segment;
  try {
    text = decodeURIComponent(segment);
  } catch {
    // keep it as written
  }
  return SECRET_VALUE.test(text) || mixedKey(text) || (text.length >= 16 && /\d/.test(text) && /[A-Za-z]/.test(text) && /^[\w.~%+=-]+$/.test(text)) || (text.length >= 32 && /^[\w+/=-]+$/.test(text));
}

/** One argument, or a value inside one, with a credential in it hidden. */
function hideValue(text: string, depth = 0): string {
  const assigned = /^(-{0,2}[A-Za-z_][\w.-]*)=([\s\S]+)$/.exec(text);
  if (assigned && depth < 3) return secretName(assigned[1]!) ? `${assigned[1]!}=${HIDDEN}` : `${assigned[1]!}=${hideValue(assigned[2]!, depth + 1)}`;
  if (URL_LIKE.test(text)) return hideUrlSecrets(text);
  const header = /^([\w-]+)\s*:\s*(\S[\s\S]*)$/.exec(text);
  // A header whose value is only a variable (`Authorization: Bearer $ISSUES_TOKEN`) holds no secret.
  if (header && secretName(header[1]!) && !headerReference(header[2]!)) return `${header[1]!}: ${HIDDEN}`;
  if (SECRET_VALUE.test(text) || (/^Bearer\s/i.test(text) && !headerReference(text))) return HIDDEN;
  return text.replace(CONNECTION_SECRET, (_m, key: string) => `${key}=${HIDDEN}`);
}

/**
 * Arguments with anything that looks like a credential hidden: the value after a flag whose name
 * says it is one, a key-like value after a one-letter flag (`-k a1b2c3d4e5`), a `NAME=value` (also
 * inside a `--flag=value`, as in `--env=TOKEN=…`), a `Header: value`, a password in a connection
 * string, a URL's user, password, query values and key-like path segments, and a token
 * recognisable by its shape.
 */
export function hideSecrets(argv: readonly string[]): string[] {
  return argv.map((a, i) => {
    const prev = argv[i - 1];
    // The value of a secret flag, unless it is the next flag. A key may start with one dash.
    if (prev && /^--?[\w.-]+$/.test(prev) && secretName(prev) && !a.startsWith('--')) return HIDDEN;
    // A one-letter flag says nothing about its value (`-k`, `-t`): hide one shaped like a key.
    if (prev && /^-[A-Za-z]$/.test(prev) && mixedKey(a)) return HIDDEN;
    return hideValue(a);
  });
}

/**
 * A path segment shown as it is: a short lowercase word such as `mcp`, `sse`, `v1` or `github`.
 * Anything else (capitals, a long run of letters and digits, a token's shape) may be a key, as in
 * Zapier's MCP URLs, and is hidden.
 */
const plainSegment = (segment: string) => segment === '' || (/^[a-z0-9][a-z0-9._-]{0,23}$/.test(segment) && !keyLike(segment));

/**
 * A URL with its user and password shown as `•••@` (a place to put them back, never their text),
 * its query values and fragment hidden, and path segments that may be keys hidden.
 */
export function hideUrlSecrets(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname
      .split('/')
      .map((segment) => (plainSegment(segment) ? segment : HIDDEN))
      .join('/');
    if (!u.username && !u.password && !u.search && !u.hash && path === u.pathname) return url;
    const query = [...new Set(u.searchParams.keys())].map((k) => `${encodeURIComponent(k)}=${HIDDEN}`).join('&');
    return `${u.protocol}//${u.username || u.password ? `${HIDDEN}@` : ''}${u.host}${path}${query ? `?${query}` : ''}${u.hash ? `#${HIDDEN}` : ''}`;
  } catch {
    return url.replace(USERINFO_LOOSE, `$1${HIDDEN}@`);
  }
}

/**
 * A remote server's URL without the user and password in it, which `shadowlap mcp --url` refuses:
 * they go in an `Authorization: Basic` header instead. `had` says there were some.
 */
export function withoutCredentials(url: string): { url: string; had: boolean } {
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return { url, had: false };
    // Cut from the URL as typed, so the rest stays exactly as it was.
    return { url: url.replace(USERINFO, '$1'), had: true };
  } catch {
    return { url, had: false };
  }
}

/**
 * A URL's scheme and the user and password after it, as typed: `https://` and `bob:s3cret@`. Up to
 * the last `@` before the host, as a URL parser splits them: a password may hold an `@` of its own
 * (`bob:p@ss@host`), and all of it goes.
 */
const USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#\\]*@/i;

/** The same in text no URL parser takes (`https://bob:p/ss@host`): everything up to its last `@`, which is as far as a password could reach. */
const USERINFO_LOOSE = /^([a-z][a-z0-9+.-]*:\/\/)\S*@/i;

/** Hides only a URL's user and password, as `•••@`: what a copied entry carries in their place, leaving the rest as typed. */
export function hideUrlCredentials(text: string): string {
  if (!URL_LIKE.test(text)) return text.replace(/(=)([a-z][a-z0-9+.-]*:\/\/[^\s]+)$/i, (_m, eq: string, url: string) => `${eq}${hideUrlCredentials(url)}`);
  try {
    const u = new URL(text);
    if (!u.username && !u.password) return text;
    return text.replace(USERINFO, `$1${HIDDEN}@`);
  } catch {
    return text.replace(USERINFO_LOOSE, `$1${HIDDEN}@`);
  }
}

/** A value that is only a reference the client, or `shadowlap mcp`, fills in from the environment (`${GITHUB_TOKEN}`, `${env:KEY}`): it holds no secret, so it is shown. */
export const REFERENCE = /^\$\{[^}\s]+\}$/;

/**
 * A variable `shadowlap mcp` reads from its own environment in a header (`$STRIPE_TOKEN`), which
 * no client fills in: the form a header is copied in, since a client that fills in `${…}` itself
 * (Claude Code) would put the token on the proxy's command line. It holds no secret either.
 */
export const PROXY_REFERENCE = /^\$[A-Za-z_][A-Za-z0-9_]*$/;

/** A header's value, or its token after the scheme (`Bearer $STRIPE_TOKEN`), that is only a reference. */
function headerReference(text: string): boolean {
  const token = SCHEME.exec(text.trim())?.[2]?.trim() ?? text.trim();
  return REFERENCE.test(token) || PROXY_REFERENCE.test(token);
}

/** An Authorization header's scheme, kept in front of the variable that stands for its token. */
export const SCHEME = /^(Bearer|Basic|Token|Bot)\s+(\S[\s\S]*)$/i;
