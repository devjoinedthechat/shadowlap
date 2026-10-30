import { ACCOUNT_HEADERS } from './account-headers.js';
import { maskEmbeddedJson, maskEventStream, maskGraphqlArguments, maskJsonLines, maskKeyValueLines, maskMultipart, maskXml, skipJsonValue, unwrapJson, walkJson, type FindHeld, type MultipartPartText, type StringMask, type StringTest } from './credential-shapes.js';
import { parseJsonExact } from './json-exact.js';
import { mayHoldSecrets, secretStoreValues, storeCall, type StoreCall } from './secret-stores.js';
import { isObject } from './is-object.js';
import type { RunMeta } from './types.js';

/**
 * Credentials in recorded HTTP traffic: which query and form parameters carry one (credentialParam,
 * the one list every part of Shadowlap reads), which headers do, and the stored shapes with them
 * masked. The sidecar masks them before anything is stored, and every copy that leaves the machine
 * (a pack, an HTML report or share link, a push to the team store) masks them again, so a recording
 * made before a name was known to carry one leaves without it all the same.
 */

/**
 * What a credential in a captured call's query string or form body, or in a response header, is
 * stored as. The call is forwarded with the real value; the store, every copy made from it and
 * matching on replay see this.
 */
export const CREDENTIAL_PLACEHOLDER = '<CREDENTIAL>';

/**
 * Last words of a parameter name that make it a credential whatever comes before: `client_secret`,
 * `X-Amz-Signature`, `X-Amz-Credential`, `client_assertion`, `code_verifier`, a header such as
 * `X-Upstream-Authorization`, and the lists `signatures`.
 */
const SECRET_LAST = new Set(['secret', 'signature', 'signatures', 'password', 'passwd', 'pwd', 'credential', 'credentials', 'assertion', 'verifier', 'authorization']);
/**
 * Words that make a name a credential wherever they are in it (`password_confirmation`, `secret_id`,
 * `client_secrets`, `SecretString`), unless its last words name or describe the secret (namesASecret).
 */
const SECRET_WORD = new Set(['password', 'passwd', 'passphrase', 'secret', 'secrets']);
/** A word of SECRET_WORD, or one a password's starts (`passwords`, `passwordless`). */
const secretWord = (w: string): boolean => SECRET_WORD.has(w) || w.startsWith('password');
/**
 * Last words that make a name with a secret word in it name or describe the secret rather than hold
 * it: its name (`secret_name`, Kubernetes' `secretName`), its ARN (`SecretArn`), its version and stage
 * (`secret_version_id`, `SecretVersionStages`), a policy (IAM's `PasswordPolicy`), the e-mail address a
 * reset goes to (`password_reset_email`), its length, count, type, description and tags, its
 * rotation's settings (`secret_rotation_enabled`), and when it was made, changed or expires
 * (`password_expires_at`). Never a hint (often the password itself, or one that gives it away), a URL
 * (a reset link carries its token, and a secret URL is the secret), nor any other word (`secret_value`).
 */
const NAMES_A_SECRET = new Set(['name', 'names', 'arn', 'arns', 'version', 'versions', 'version id', 'version ids', 'version stage', 'version stages', 'policy', 'policies', 'email', 'length', 'count', 'type', 'description', 'tags', 'rotation', 'rotation enabled', 'rotation rules', 'rotation schedule', 'rotation period', 'rotation interval', 'rotation days', 'expires at', 'created at', 'updated at']);
/**
 * Last words that name a secret too, under the rule a run stores as RunMeta.secretNames 2: where it
 * is kept (`secret_path`, Vault's; `secret_scope`, Databricks'; `secret_namespace`), a reference to it
 * (`secret_ref`, Kubernetes' `secretKeyRef`), and its id (AWS's `SecretId`). An id signs in as often
 * as it names (Vault AppRole's `secret_id`): kept, as each of these is, only when it doesn't read as a
 * key (readsAsKey), as a name, an ARN or a path doesn't, and a UUID does.
 */
const NAMES_A_SECRET_TOO = new Set(['path', 'paths', 'ref', 'refs', 'reference', 'scope', 'scopes', 'namespace', 'namespaces', 'key ref', 'id', 'ids']);

/**
 * Which names that name or describe a secret a run's captured calls keep, as RunMeta.secretNames
 * says (secretNamesOf): 0 none, as a run made before any were kept masked them all; 1 those of
 * NAMES_A_SECRET (`true`, as runs made before a path, a ref, a scope, a namespace or an id was kept
 * mark it); 2 those and NAMES_A_SECRET_TOO. Either keeps only a value that doesn't read as a key.
 */
export type SecretNamesRule = 0 | 1 | 2;

/** The rule a run stores, as RunMeta.secretNames says it: none, `true` or `2`; one it doesn't know reads as 0, which masks most. */
export function secretNamesOf(meta: Pick<RunMeta, 'secretNames'> | null | undefined): SecretNamesRule {
  const kept: unknown = meta?.secretNames;
  return kept === 2 ? 2 : kept === true ? 1 : 0;
}

/** RunMeta.secretNames for a run stored under `rule`: none for 0, `true` for 1, `2` for 2. */
export function secretNamesMeta(rule: SecretNamesRule): Pick<RunMeta, 'secretNames'> {
  return rule === 0 ? {} : { secretNames: rule === 1 ? true : 2 };
}

/**
 * Whether a name with a secret word in it names or describes the secret rather than holding it, under
 * `rule`: its last word or two are one of NAMES_A_SECRET (or with 2, NAMES_A_SECRET_TOO), or the words
 * after its last secret word say when it was last done something to (`secret_last_rotated_date`).
 */
function namesASecret(words: readonly string[], rule: SecretNamesRule): boolean {
  const n = words.length;
  const tails = [words[n - 1]!, ...(n > 1 ? [`${words[n - 2]!} ${words[n - 1]!}`] : [])];
  if (tails.some((tail) => NAMES_A_SECRET.has(tail) || (rule === 2 && NAMES_A_SECRET_TOO.has(tail)))) return true;
  let after = n;
  while (after > 0 && !secretWord(words[after - 1]!)) after--;
  return words[n - 1] === 'date' && words.indexOf('last', after) >= 0;
}

/** The rule masking reads a name that names or describes a secret by while it runs (withSecretNames); a recording made now keeps 2. */
let secretNames: SecretNamesRule = 2;

/**
 * What `mask` gives, with the names that name or describe a secret read under `rule`: as a recording
 * made now keeps them (2), or as one that RunMeta.secretNames says kept fewer, or none, kept them, so
 * a replay of it reads a live call as it reads the recording to match it. Masking reads no time, so
 * nothing else masks while `mask` runs.
 */
export function withSecretNames<T>(rule: SecretNamesRule, mask: () => T): T {
  const was = secretNames;
  secretNames = rule;
  try {
    return mask();
  } finally {
    secretNames = was;
  }
}
/**
 * Whole names (their words run together) that are credentials: `api_key`, `apiKey`, `apikeys`, `sig`,
 * `appid`, `auth`, a `cookie` or `cookies` (a session's), a one-time password (`otp`, `totp`), and
 * a SAML response, which is an identity provider's signed assertion.
 */
const SECRET_NAME = new Set(['apikey', 'apikeys', 'appid', 'appkey', 'sig', 'hmac', 'auth', 'authorization', 'proxyauthorization', 'pass', 'passphrase', 'sessionid', 'jsessionid', 'phpsessid', 'jwt', 'bearer', 'cookie', 'cookies', 'otp', 'totp', 'samlresponse']);
/**
 * Whole names that carry a credential as often as a lookup (`?key=AIzaSy…` beside `?key=checkout_v2`
 * for a feature flag, `?code=` for an OAuth code or a country): one is a credential only when its
 * value reads as one (credentialValue), or when no value is given.
 */
const EITHER_NAME = new Set(['key', 'token', 'code']);
/**
 * Words before `key` that make it a credential (`x-api-key`, `Subscription-Key`, `user_key`, a TLS
 * private key's `tls.key`), unlike a `sort_key` or an `idempotency_key`.
 */
const KEY_OWNER = new Set(['api', 'access', 'app', 'secret', 'private', 'subscription', 'auth', 'client', 'consumer', 'developer', 'dev', 'master', 'admin', 'service', 'account', 'signing', 'session', 'license', 'encryption', 'user', 'tls']);
/** Words before `token` that make it a pagination cursor, not a credential: `page_token`, `nextPageToken`. */
const CURSOR = ['page', 'next', 'prev', 'previous', 'continuation', 'sync', 'cursor', 'resume', 'start', 'pagination'];
/** Words before `code` or `codes` that make it a credential (`auth_code`, `device_code`, `mfa_code`, `recovery_codes`), unlike an `error_code`. */
const CODE_OWNER = new Set(['auth', 'authorization', 'device', 'user', 'otp', 'verification', 'access', 'mfa', 'totp', 'sms', 'recovery', 'backup', 'security']);
/** Words before `tokens` that make a list of credentials (`refresh_tokens`), unlike a count (`input_tokens`, `max_tokens`). */
const TOKEN_OWNER = new Set(['access', 'refresh', 'id', 'auth', 'api', 'session', 'bearer', 'csrf', 'xsrf', 'oauth', 'device', 'personal', 'service']);

/** A name's words, as a person reads them: `X-Amz-Security-Token`, `APIToken`, `client_secret`. */
function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Whether a word that runs its owner and `suffix` together (`accesstoken`, `subscriptionkey`) is a
 * credential: what comes before the suffix is one of `owners`, or for a token anything but a cursor.
 */
function runTogether(word: string, suffix: 'key' | 'token' | 'code'): boolean {
  if (word.length <= suffix.length || !word.endsWith(suffix)) return false;
  const owner = word.slice(0, -suffix.length);
  if (suffix === 'token') return !CURSOR.some((c) => owner.startsWith(c));
  return [...(suffix === 'key' ? KEY_OWNER : CODE_OWNER)].some((w) => owner === w);
}

/**
 * Whether a query or form parameter carries a credential: an API key, a token, a signature, a
 * password. Read by its words, in any case (`api_key`, `apiKey`, `API-KEY`, `X-Amz-Security-Token`,
 * `Ocp-Apim-Subscription-Key`), never by a piece of a word: `monkey`, `keyword`, `tokens` and
 * `author` are not credentials. Narrowly, since a value masked here is left out of matching too, so
 * two calls that differ only in it match the same recorded call: a sort key, a page token or an
 * error code stays a value like any other. A bare `key`, `token` or `code` is a credential when its
 * `value` (decoded) reads as one (credentialValue); with no value given, it is taken for one, as a
 * model call's query takes it. So is a name with a password or secret word in it, wherever the word
 * stands (`SecretString`, `password_confirmation`), but one whose last words name or describe the
 * secret (`secret_name`, `password_policy`: namesASecret), which keeps a value given it that doesn't
 * read as a key (readsAsKey), so lookups of two secrets stay two calls, while a key under such a name
 * (`secret_name: "ghp_…"`) is masked; read by its name alone, it is taken for one too. An AWS access
 * key's id (`AccessKeyId`, `aws_access_key_id`) is none: it names a key pair, as a user names a user,
 * and signs nothing alone, the secret beside it masked; and an IAM call names the key it acts on by
 * it (`DeleteAccessKey`), so calls on two keys stay two calls. Where it signs a URL, SigV2's
 * `AWSAccessKeyId`, it is one (SIGNER).
 */
export function credentialParam(name: string, value?: string): boolean {
  const words = wordsOf(name);
  if (!words.length) return false;
  const joined = words.join('');
  const last = words[words.length - 1]!;
  const before = words.slice(0, -1);
  if (EITHER_NAME.has(joined)) return value === undefined || credentialValue(value);
  if (SECRET_NAME.has(joined) || SECRET_LAST.has(last)) return true;
  if (words.some(secretWord) && !(value !== undefined && secretNames > 0 && namesASecret(words, secretNames) && !readsAsKey(value))) return true;
  if (last === 'key' || last === 'keys') return before.some((w) => KEY_OWNER.has(w));
  if (last === 'token') return !before.some((w) => CURSOR.includes(w));
  if (last === 'tokens') return before.some((w) => TOKEN_OWNER.has(w));
  if (last === 'code' || last === 'codes') return before.some((w) => CODE_OWNER.has(w));
  return runTogether(last, 'key') || runTogether(last, 'token') || runTogether(last, 'code');
}

/**
 * Names that carry a credential in URL-encoded parameters (a query string, a form body, a path's
 * parameters), where they name a session or a signed proof far more often than in a JSON body,
 * whose member of the same name is as often a record of one: a session (`session`, `sid`), a
 * service ticket (CAS's, Kerberos'), Facebook's `appsecret_proof`.
 */
const PARAM_SECRET_NAME = new Set(['session', 'sid', 'ticket', 'appsecretproof']);
/**
 * Short parameter names that are a credential as often as a lookup: a secret key (`sk`, as Baidu's
 * APIs name it), an access key (`ak`), a signed `hash`. One is a credential when its value reads as
 * one (credentialValue), or when no value is given, as a model call's query takes it.
 */
const PARAM_EITHER_NAME = new Set(['sk', 'ak', 'hash']);
/**
 * The parameter SigV2 names who signed a URL by, as it spells it (`AWSAccessKeyId=AKIA…`, beside its
 * `Signature`): masked, as SigV4's `X-Amz-Credential` is, so a URL signed again with a rotated key
 * still matches. An access key's id under any other name is kept (credentialParam).
 */
const SIGNER = 'AWSAccessKeyId';

/**
 * Whether a URL-encoded parameter (a query's, a form body's, a path's) carries a credential: a name
 * credentialParam reads as one, and the names parameters carry one under (SIGNER, PARAM_SECRET_NAME,
 * and PARAM_EITHER_NAME by its value).
 */
export function credentialQueryParam(name: string, value?: string): boolean {
  if (name === SIGNER || credentialParam(name, value)) return true;
  const joined = wordsOf(name).join('');
  if (PARAM_SECRET_NAME.has(joined)) return true;
  return PARAM_EITHER_NAME.has(joined) && (value === undefined || credentialValue(value));
}

/** A JSON Web Token: a header and a payload, each base64url JSON (`eyJ…`), and a signature. */
const JWT = /^eyJ[A-Za-z0-9_-]{2,}\.eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*$/;

/** Whether a value is a JSON Web Token, a bearer credential whatever it is named (`data`, `value`, `result`). */
export function jwtShaped(value: string): boolean {
  return JWT.test(value);
}

/** How deep strings inside strings are read for their shape (JSON in a JSON string, a URL in a form value). */
const MAX_NESTING = 6;

/** A part of a value that reads as written by a person: a word (`checkout`, `Refund`, `EU`), a number, or a short tag (`v2`). */
const WORDLIKE = /^(?:[a-z]{1,20}|[A-Z][a-z]{0,19}|[A-Z]{1,20}|\d{1,20}|[A-Za-z]{1,2}\d{1,3})$/;

/**
 * Whether a value reads as a credential rather than a name looked up: 16 characters or more, with a
 * part between its punctuation that is no word or number (WORDLIKE), as in an API key (`AIzaSy…`,
 * `sk_live_51H…`), a hex or base64 token or a JWT. `checkout_v2`, `checkout_redesign_2026` and
 * `user:12345:settings` read as names.
 */
export function credentialValue(value: string): boolean {
  if (value.length < 16) return false;
  return value.split(/[^A-Za-z0-9]+/).some((part) => part !== '' && !WORDLIKE.test(part));
}

/** A time as RFC 3339 writes it: `2026-10-30T12:00:00Z`, `2026-10-30T12:00:00.125+01:00`. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:[Zz]|[+-]\d{2}:\d{2})$/;
/** A time as HTTP writes it, RFC 9110's IMF-fixdate: `Thu, 30 Oct 2026 12:00:00 GMT`. */
const HTTP_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
/** The units of a duration as Go writes it, those of two letters first. */
const DURATION_UNITS = ['ns', 'us', 'µs', 'ms', 'h', 'm', 's'];
/**
 * An Amazon Resource Name as AWS writes one: `arn:`, a partition (`aws`, `aws-cn`, `aws-us-gov`,
 * `aws-iso-b`), a service in lower case, a region (`us-east-1`, `us-gov-west-1`) or none, an
 * account's 12 digits or none, and a resource, whose last part may end in a suffix AWS makes up
 * (`arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db-AbCdEf`). A value only `arn:` and
 * colons begin (`arn:x:y::1:ghp_…`) is none, and reads as the key it holds.
 */
const ARN_SHAPED = /^arn:aws(?:-[a-z]+)*:[a-z][a-z0-9-]*:(?:[a-z]{2,}-(?:[a-z]+-)+\d+)?:(?:\d{12})?:\S+$/;

/**
 * Whether a value is a duration as Go writes one, and OpenAI's rate limits with it: one to six
 * numbers of at most 20 characters, a fraction allowed, each followed by its unit (`6m0s`,
 * `1h2m3.5s`, `150ms`). Read by hand, character by character.
 */
function goDuration(value: string): boolean {
  let i = 0;
  let parts = 0;
  while (i < value.length) {
    const start = i;
    while (i < value.length && value.charCodeAt(i) >= 0x30 && value.charCodeAt(i) <= 0x39) i++;
    if (value[i] === '.') i++;
    while (i < value.length && value.charCodeAt(i) >= 0x30 && value.charCodeAt(i) <= 0x39) i++;
    const unit = DURATION_UNITS.find((u) => value.startsWith(u, i));
    if (i === start || i - start > 20 || value[start] === '.' || value[i - 1] === '.' || !unit || ++parts > 6) return false;
    i += unit.length;
  }
  return parts > 0;
}

/** Whether a value is a time or a duration as a service writes one: RFC 3339, an HTTP date, Go's `6m0s`. */
function timeShaped(value: string): boolean {
  return RFC3339.test(value) || HTTP_DATE.test(value) || goDuration(value);
}

/**
 * Whether a value under a name that holds none (a secret's name) reads as a key (credentialValue)
 * all the same: never a time or a duration, nor an ARN, whose suffix AWS makes up reads as a key's part.
 */
function readsAsKey(value: string): boolean {
  return credentialValue(value) && !timeShaped(value) && !ARN_SHAPED.test(value);
}

/** A URL-encoded name or value as text: `+` a space, `%xx` its character; as it is when it doesn't decode. */
export function decodedParam(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

/**
 * URL-encoded parameters (a query string with or without its `?`, or a form body) with the value of
 * each credential (credentialParam, read with its value) replaced by CREDENTIAL_PLACEHOLDER, and a
 * JWT whatever its name; any other value masked by its shape (a URL or JSON inside it, encoded again
 * as it was). `&` and `;` separate them; everything else stays byte for byte, in its order. Applied
 * again, it changes nothing.
 */
export function withoutCredentials(encoded: string): string {
  return maskParams(encoded, false, 0);
}

/**
 * `text` with each half of a surrogate pair standing alone made U+FFFD, as String.prototype.toWellFormed
 * makes it: what encodeURIComponent can always encode.
 */
export function wellFormed(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

/**
 * `text` URL-encoded again, or null when it has no encoding: half of a character's surrogate pair
 * (a `\ud800` a JSON string escaped on its own) makes encodeURIComponent throw.
 */
export function encodedAgain(text: string): string | null {
  try {
    return encodeURIComponent(text);
  } catch {
    return null;
  }
}

/**
 * Parameters as withoutCredentials masks them; `byName` reads a name alone (a bare `code` or
 * `token` is one whatever its value), as a redirect's are read. A value masked inside that can't be
 * encoded again as it was is masked whole: a request is never held up by how its body is stored.
 */
function maskParams(encoded: string, byName: boolean, depth: number): string {
  return encoded.replace(/(^\??|[&;])([^&;=]*)=([^&;]*)/g, (whole, lead: string, raw: string, value: string) => {
    if (!value || value === CREDENTIAL_PLACEHOLDER) return whole;
    const text = decodedParam(value);
    if (credentialQueryParam(decodedParam(raw), byName ? undefined : text) || JWT.test(text)) return `${lead}${raw}=${CREDENTIAL_PLACEHOLDER}`;
    const inner = depth < MAX_NESTING ? maskTextCredentials(text, depth + 1, byName) : null;
    if (inner === null) return whole;
    const again = text === value ? inner : encodedAgain(inner);
    return `${lead}${raw}=${again ?? CREDENTIAL_PLACEHOLDER}`;
  });
}

/** A URL in its parts (RFC 3986's own reading): scheme, `//authority`, path, `?query`, `#fragment`. */
const URL_PARTS = /^([A-Za-z][A-Za-z0-9+.-]*:)?(\/\/[^/?#]*)?([^?#]*)(\?[^#]*)?(#[^]*)?$/;
/** A string that reads as a URL: absolute (`https://…`, `postgres://…`), or a path with a query, a fragment or parameters (`/next?page=2`). */
const URL_SHAPED = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s]*|\/[^\s?#;]*[?#;][^\s]*)$/;

/** Where a Slack webhook's address keeps its secret: under one of these, after the team's id (`T…`). */
const SLACK_HOOKS = new Set(['services', 'workflows', 'triggers']);

/**
 * A URL's path with the credentials in it masked: the secret a webhook's address carries, wherever
 * it is served from (the service, a proxy, a mock), and the value of each path parameter that is a
 * credential (`;jsessionid=…`, credentialQueryParam; by its name alone with `byName`, as a
 * redirect's are). A webhook's secret is the last segment of Slack's `/services/T…/B…/<secret>`
 * (and of its workflow and trigger addresses), the segment after the id in Discord's
 * `/api/webhooks/<id>/<token>`, and the token in a Telegram bot's `/bot<id>:<token>/`. Read segment by
 * segment, in time linear in the path. The same string when there is nothing to mask.
 */
export function maskPathCredentials(path: string, byName = false): string {
  const params = !path.includes(';')
    ? path
    : path.replace(/;([^;/=?#]*)=([^;/?#]*)/g, (whole, raw: string, value: string) => (value && value !== CREDENTIAL_PLACEHOLDER && credentialQueryParam(decodedParam(raw), byName ? undefined : decodedParam(value)) ? `;${raw}=${CREDENTIAL_PLACEHOLDER}` : whole));
  const segments = params.split('/');
  let changed = false;
  const mask = (i: number, keep = '') => {
    const next = `${keep}${CREDENTIAL_PLACEHOLDER}`;
    if (segments[i] && segments[i] !== next) {
      segments[i] = next;
      changed = true;
    }
  };
  // Slack: /services/T…/…/<secret>, the last segment that isn't empty.
  if (segments.length >= 5 && segments[0] === '' && SLACK_HOOKS.has(segments[1]!) && /^T[A-Za-z0-9]+$/.test(segments[2]!)) mask(segments.at(-1) ? segments.length - 1 : segments.length - 2);
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    // Discord: /api/webhooks/<id>/<token>, or /api/v10/webhooks/…
    if (s === 'webhooks' && /^\d+$/.test(segments[i + 1] ?? '') && (segments[i - 1] === 'api' || (segments[i - 2] === 'api' && /^v\d+$/.test(segments[i - 1] ?? '')))) mask(i + 2);
    // Telegram: /bot<id>:<token>/…
    const bot = /^bot\d+:/.exec(s);
    if (bot && s.length > bot[0].length) mask(i, bot[0]);
  }
  return changed ? segments.join('/') : params;
}

/**
 * A URL's authority (`//user:password@host`) with the credential in its user info masked: its
 * password, or, with none, a name that reads as a credential (credentialValue), as a token given in
 * its place is (`https://ghp_…@github.com`). The same string when there is nothing to mask.
 */
function maskUserInfo(authority: string): string {
  const at = authority.lastIndexOf('@');
  if (at <= 2) return authority;
  const info = authority.slice(2, at);
  const colon = info.indexOf(':');
  const name = colon < 0 ? info : info.slice(0, colon);
  const password = colon < 0 ? '' : info.slice(colon + 1);
  if (password) return password === CREDENTIAL_PLACEHOLDER ? authority : `//${name}:${CREDENTIAL_PLACEHOLDER}${authority.slice(at)}`;
  return name && name !== CREDENTIAL_PLACEHOLDER && credentialValue(decodedParam(name)) ? `//${CREDENTIAL_PLACEHOLDER}${info.slice(name.length)}${authority.slice(at)}` : authority;
}

/**
 * A URL with its credentials masked: the password in its user info (`https://svc:…@host`,
 * `postgres://app:…@db`) or a token given as its name (`https://ghp_…@github.com`), a webhook's secret and each path parameter that is one
 * (maskPathCredentials), and its query and fragment's parameters (maskParams: a URL inside one too,
 * as a redirect's `next` holds one). `byName` reads each parameter by its name alone, as a
 * redirect's are. The same string when there is nothing to mask.
 */
export function maskUrlCredentials(url: string, byName = false, depth = 0): string {
  const m = URL_PARTS.exec(url);
  if (!m) return url;
  const [, scheme = '', authority = '', path = '', query = '', fragment = ''] = m;
  const params = maskPathCredentials(path, byName);
  const auth = maskUserInfo(authority);
  const q = query ? `?${maskParams(query.slice(1), byName, depth)}` : '';
  const f = fragment.includes('=') ? `#${maskParams(fragment.slice(1), byName, depth)}` : fragment;
  return `${scheme}${auth}${params}${q}${f}`;
}

/**
 * A captured call's address as a recording keeps it (`args.url`): a webhook's secret and the
 * credential path parameters in its path masked (maskPathCredentials), and the credentials in its
 * query (withoutCredentials). The same string when there is nothing to mask.
 */
export function credentialFreeUrl(url: string): string {
  const m = URL_PARTS.exec(url);
  if (!m) return url;
  const [, scheme = '', authority = '', path = '', query = '', fragment = ''] = m;
  const out = `${scheme}${authority}${maskPathCredentials(path)}${query ? withoutCredentials(query) : ''}${fragment}`;
  return out === url ? url : out;
}

/**
 * A captured HTTP call's name (`POST hooks.slack.com/services/T…/B…/…`, the method, the host and the
 * path it asked for) as a recording keeps it: its path masked as its address's is
 * (maskPathCredentials). The same string when there is nothing to mask.
 */
export function credentialFreeCallName(name: string): string {
  const space = name.indexOf(' ');
  const slash = space < 0 ? -1 : name.indexOf('/', space + 1);
  if (slash < 0) return name;
  const path = name.slice(slash);
  const masked = maskPathCredentials(path);
  return masked === path ? name : `${name.slice(0, slash)}${masked}`;
}

/**
 * Last words of a flag's name that make it say where a credential is rather than what it is:
 * `--api-key-file`, `--token-env`, `--password-stdin`, `--secret-dir`.
 */
const FLAG_PLACE = new Set(['file', 'files', 'path', 'paths', 'dir', 'env', 'var', 'stdin', 'fd']);

/**
 * Whether a command line's flag (its name without the dashes) takes a credential: one
 * credentialQueryParam reads as one with the `value` it was given (a bare `--key` or `--code` only
 * when its value reads as one; `--token` whatever it is), unless its name says where the
 * credential is (FLAG_PLACE).
 */
export function credentialFlag(name: string, value: string): boolean {
  const words = wordsOf(name);
  if (!words.length || FLAG_PLACE.has(words.at(-1)!)) return false;
  return words.join('') === 'token' || credentialQueryParam(name, value);
}

/** Whether a string reads as a URL: absolute (`https://…`), or a path with a query, a fragment or parameters (URL_SHAPED). */
export function urlShaped(text: string): boolean {
  return URL_SHAPED.test(text);
}

/**
 * A connection string (`Server=db;User ID=app;Password=…;`, Azure Storage's
 * `AccountName=acct;AccountKey=…;`) with each credential's value masked: two or more `name=value`
 * pairs, a name of words. Null when it isn't one, or holds no credential.
 */
function maskConnectionString(text: string): string | null {
  if (!text.includes(';') || !text.includes('=') || /[\r\n]/.test(text)) return null;
  const parts = text.split(';');
  let pairs = 0;
  let changed = false;
  const out: string[] = [];
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k]!;
    if (part === '' && k === parts.length - 1) {
      out.push(part);
      continue;
    }
    const eq = part.indexOf('=');
    if (eq < 1 || !/^\s*[A-Za-z][\w .-]*$/.test(part.slice(0, eq))) return null;
    pairs++;
    const value = part.slice(eq + 1);
    if (value && value !== CREDENTIAL_PLACEHOLDER && credentialParam(part.slice(0, eq).trim(), value)) {
      out.push(`${part.slice(0, eq + 1)}${CREDENTIAL_PLACEHOLDER}`);
      changed = true;
    } else out.push(part);
  }
  return pairs >= 2 && changed ? out.join(';') : null;
}

/**
 * A text body written as URL-encoded parameters, as a form body is (`a=1&b=2`): a `=`, and no space,
 * quote or brace. A value masked already counts as any other, so a form masked once reads as a form
 * again, as a replay reads a stored one: read otherwise, as a `key=value` line, it lost the
 * parameters after its first when that was a credential.
 */
export function formShaped(text: string): boolean {
  return text.includes('=') && /^[^\s"{}<>\\^`|]+$/.test(text.replaceAll(CREDENTIAL_PLACEHOLDER, ''));
}

/**
 * A parsed JSON value (an object, an array, or a scalar) with its credentials masked as a recording
 * keeps them, at any depth (maskedString): a credential member's string (an OAuth token response's
 * `access_token`, a request body's `client_secret` or `api_key`), every string under a credential
 * member (`api_keys: […]`, `client_secret: { value: … }`), a JWT whatever its member, and the
 * credentials inside a string (JSON in it, a URL, a connection string, a GraphQL query's
 * arguments). Numbers and the shape stay as they are (copies mask strings only); a value with
 * nothing to mask comes back the same object. `call` says how the call that sends it holds a secret
 * (StoreCall, heldIn). For a body stored as text, where the bytes matter, use maskJsonTextCredentials.
 */
export function maskJsonCredentials(value: unknown, call: StoreCall | null = null): unknown {
  // Read as the text a recording stores, by the one walk every body takes, iteratively.
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return value;
  }
  const masked = text === undefined ? null : walkJson(text, stringsAt(0), credentialMember, heldIn(text, call));
  return masked == null ? value : (JSON.parse(masked) as unknown);
}

/**
 * A string in a body as a recording keeps it: CREDENTIAL_PLACEHOLDER when it is a credential (under
 * a credential member; its member read as one with it, or by its name alone with `byName`; a JWT,
 * whatever its member is named); else with the credentials inside it masked by its shape
 * (maskTextCredentials, `byName` passed on: JSON in the string, a URL, a query string, a connection
 * string, a GraphQL query). Null to keep it as it is.
 */
function maskedString(key: string | null, value: string, under: boolean, depth: number, byName: boolean): string | null {
  if (value === CREDENTIAL_PLACEHOLDER) return null;
  if (under || (key !== null && credentialParam(key, byName ? undefined : value)) || JWT.test(value)) return CREDENTIAL_PLACEHOLDER;
  return depth < MAX_NESTING ? maskTextCredentials(value, depth + 1, byName) : null;
}

/**
 * Whether a member's object or array value is a credential through and through, every string in it
 * masked: its name read as one by itself (`client_secret`, `api_keys`, `recovery_codes`, `cookies`),
 * which a bare `key`, `token` or `code` never is; and, for a name that names or describes a secret
 * (`secret_version`, `secret_tags`), when any string in it reads as a key (readsAsKey), as one
 * given it directly would (`{"secret_version": {"value": "ghp_…"}}`).
 */
const credentialMember = (key: string): boolean | StringTest => (credentialParam(key, '') ? true : describesASecret(key) ? readsAsKey : false);

/** Every word of SECRET_WORD, and every one a password's starts, holds one of these, in any case. */
const SECRET_WORD_IN = /pass|secret/i;

/**
 * Whether a name names or describes a secret under the rule masking reads by (namesASecret), so it
 * keeps a value that reads as no key. A name with no secret word's letters in it (SECRET_WORD_IN), as
 * most are, isn't split into its words: a body nested deep opens an object under a member at every
 * level.
 */
function describesASecret(name: string): boolean {
  if (secretNames === 0 || !SECRET_WORD_IN.test(name)) return false;
  const words = wordsOf(name);
  return words.some(secretWord) && namesASecret(words, secretNames);
}

/** The string rule for strings `depth` deep, as walkJson takes it; with `byName`, as a redirect's JSON is read (maskedString). */
const stringsAt =
  (depth: number, byName = false): StringMask =>
  (key, value, under) =>
    maskedString(key, value, under, depth, byName);

/**
 * Where the JSON in `text` holds a secret by its shape, as walkJson reads it: a secret store's answer
 * (secretStoreValues), looked for only in a text that can hold one; and by `call`, how the captured
 * call `text` is the body of holds one (StoreCall): a write's secret, Vault's KV version 1 answer's.
 * An answer from another mount is read only when it names its mount.
 */
function heldIn(text: string, call: StoreCall | null): FindHeld | null {
  const told = call !== null && (call !== 'mount' || text.includes('"mount_type"'));
  if (!told && !mayHoldSecrets(text)) return null;
  return (doc, start) => secretStoreValues(doc, start, call, readsAsKey);
}

/** How a captured call (`callName`, when the masking is told it) holds a secret in its answer (StoreCall). */
const answerOf = (callName: string | undefined): StoreCall | null => (callName === undefined ? null : storeCall(callName, false));

/**
 * JSON text with its credentials masked as maskJsonCredentials masks a parsed value, each string
 * replaced written as `"<CREDENTIAL>"` (or as the string with what is in it masked), every other byte
 * kept (whitespace, numbers of any length such as a 64-bit id or `20.0`, the other strings), so a
 * body stored as received can be masked without being re-serialised. `callName` names the captured
 * call it answers, which says where a Vault KV answer holds its secret (heldIn). Null when it holds no
 * credential to mask, or doesn't read as JSON.
 */
export function maskJsonTextCredentials(text: string, callName?: string): string | null {
  return walkJson(text, stringsAt(0), credentialMember, heldIn(text, answerOf(callName))) ?? null;
}

/**
 * A text body, a string in one, or text read from bytes, with its credentials masked by its shape,
 * whatever a content type said: JSON (also behind a byte-order mark, an anti-XSSI prefix or inside a
 * JSONP call); a URL; a form's or a query string's parameters; a connection string; a multipart
 * body's fields and parts; an event stream's data; lines of JSON (NDJSON); XML elements and
 * attributes; a GraphQL query's arguments; `key: value` and `key = value` lines (YAML, an INI or a
 * .env file); and the JSON objects among other text (maskEmbeddedJson).
 * Each value by its name (credentialParam), and a JWT whatever its name; in JSON, the secret a secret
 * store's answer holds (heldIn). `depth` counts the strings it is inside of; `byName` reads parameters by their
 * name alone, as a redirect's are, and so the members of its JSON and what its strings hold (htmx's
 * `hx-location`); `call` says how the captured call a whole JSON text is the body of holds a secret
 * (StoreCall, heldIn). Every character it doesn't replace stays as it was; null when it replaced
 * nothing.
 */
export function maskTextCredentials(text: string, depth = 0, byName = false, call: StoreCall | null = null): string | null {
  const strings = stringsAt(depth, byName);
  const wrapped = unwrapJson(text);
  const held = heldIn(text, null);
  const json = walkJson(wrapped.json, strings, credentialMember, call === null ? held : heldIn(text, call));
  if (json !== undefined) return json === null ? null : wrapped.prefix + json + wrapped.suffix;
  if (URL_SHAPED.test(text)) {
    const masked = maskUrlCredentials(text, byName, depth);
    return masked === text ? null : masked;
  }
  if (formShaped(text)) {
    const masked = maskParams(text, byName, depth);
    return masked === text ? null : masked;
  }
  const shaped =
    maskConnectionString(text) ??
    maskMultipart(text, (part) => maskedPart(part, depth)) ??
    // An event's data is a string inside this one, a level deeper: a data line inside a data line,
    // over and over, is read no deeper than any other string inside a string, so a level at a time.
    maskEventStream(text, (payload) => (depth < MAX_NESTING ? maskTextCredentials(payload, depth + 1) : null)) ??
    maskJsonLines(text, (line) => walkJson(line, strings, credentialMember, held)) ??
    maskXml(text, (name, value) => credentialParam(name, value) || JWT.test(value), credentialMember, CREDENTIAL_PLACEHOLDER) ??
    maskGraphqlArguments(text, (name, value) => credentialParam(name, value), CREDENTIAL_PLACEHOLDER) ??
    maskLooseForm(text, byName, depth) ??
    maskKeyValueLines(text, (name, value) => credentialParam(name, value) || JWT.test(value), CREDENTIAL_PLACEHOLDER);
  // JSON among other text, which no shape above read whole: after a comment, before `;`, run
  // together, in a page's script. What a shape masked already is read again, and stays as it is.
  const embedded = text.includes('{') ? (maskEmbeddedJson(shaped ?? text, strings, credentialMember, held) ?? shaped) : shaped;
  // A URL's user info and a JWT, wherever they stand in what is left: a .env line's database URL, a sentence's token.
  const read = embedded ?? text;
  const loose = maskJwtsInText(maskUrlUserInfo(read));
  return loose === read ? embedded : loose;
}

/** Whether a character is one a URL's scheme is written with: a letter, a digit, `+`, `.` or `-`. */
const schemeChar = (c: number) => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2e || c === 0x2d;
/** What ends a URL's authority in text: its path, query or fragment (`/`, `?`, `#`), a space, or what quotes it (`"`, `'`, `<`, `>`, a backquote, a backslash). */
const AUTHORITY_END = new Set([0x2f, 0x3f, 0x23, 0x22, 0x27, 0x3c, 0x3e, 0x60, 0x5c]);
const isSpace = (c: number) => c === 0x20 || (c >= 0x09 && c <= 0x0d) || c === 0xa0 || c === 0x2028 || c === 0x2029;

/**
 * Text with the credential in the user info of each URL in it masked (maskUserInfo), wherever the
 * URL stands: `postgres://app:…@db/app` in a .env line or a sentence, `redis://:…@cache` in a log
 * line. Each `://` is read once, back over its scheme and on over its authority. The same string
 * when there is nothing to mask.
 */
function maskUrlUserInfo(text: string): string {
  const parts: string[] = [];
  let copied = 0;
  for (let at = text.indexOf('://'); at >= 0; at = text.indexOf('://', at + 3)) {
    let s = at;
    while (s > 0 && schemeChar(text.charCodeAt(s - 1))) s--;
    const first = text.charCodeAt(s);
    if (s === at || !((first >= 0x61 && first <= 0x7a) || (first >= 0x41 && first <= 0x5a))) continue;
    let e = at + 3;
    while (e < text.length && !AUTHORITY_END.has(text.charCodeAt(e)) && !isSpace(text.charCodeAt(e))) e++;
    const authority = `//${text.slice(at + 3, e)}`;
    const masked = maskUserInfo(authority);
    if (masked === authority) continue;
    parts.push(text.slice(copied, at + 1), masked);
    copied = e;
  }
  return parts.length ? parts.join('') + text.slice(copied) : text;
}

/** Whether a character is one a JWT is written with: base64url, or the dot between its parts. */
const jwtChar = (c: number) => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x5f || c === 0x2e;

/**
 * Text with each JWT in it masked, wherever it stands: after `Bearer `, in a sentence, in a log
 * line. A JWT is a word of its own (`eyJ…` after a character it can't hold) to where the word ends,
 * less the full stop a sentence puts after it. Each word is read once. The same string when there
 * is none.
 */
function maskJwtsInText(text: string): string {
  const parts: string[] = [];
  let copied = 0;
  for (let at = text.indexOf('eyJ'); at >= 0; ) {
    if (at > 0 && jwtChar(text.charCodeAt(at - 1))) {
      at = text.indexOf('eyJ', at + 3);
      continue;
    }
    let e = at;
    while (e < text.length && jwtChar(text.charCodeAt(e))) e++;
    let end = e;
    while (end > at && text.charCodeAt(end - 1) === 0x2e) end--;
    // One without a signature ends with its dot: `header.payload.`.
    const word = JWT.test(text.slice(at, end)) ? end : end < e && JWT.test(text.slice(at, end + 1)) ? end + 1 : -1;
    if (word > 0) {
      parts.push(text.slice(copied, at), CREDENTIAL_PLACEHOLDER);
      copied = word;
    }
    at = text.indexOf('eyJ', e);
  }
  return parts.length ? parts.join('') + text.slice(copied) : text;
}

/** One parameter of a form written without encoding its values: a name, then `=`. */
const LOOSE_PARAM = /^[\w.\-[\]%]+=/;

/**
 * A form written without encoding its values (`data={"api_key":…}&x=1`), masked as maskParams masks
 * one: on one line, every `&`-separated part a parameter, and two or more of them or a value that
 * opens JSON, so a sentence that starts `name=` stays a sentence. Null when it isn't one, or nothing
 * changed.
 */
function maskLooseForm(text: string, byName: boolean, depth: number): string | null {
  if (/[\r\n]/.test(text)) return null;
  const parts = text.split('&');
  if (!parts.every((part) => LOOSE_PARAM.test(part))) return null;
  if (parts.length < 2 && !/^[^=]*=\s*[[{"]/.test(text)) return null;
  const masked = maskParams(text, byName, depth);
  return masked === text ? null : masked;
}

/**
 * Bytes (a body that isn't UTF-8, stored as base64: one in Latin-1, a JSON document holding raw
 * bytes, a form with a file) with their credentials masked by their shape, as maskTextCredentials
 * masks text (`call`, how the call they are the body of holds a secret, too): read one byte to a
 * character, so every byte it doesn't replace stays as it was. Null when it replaced nothing.
 */
export function maskBytesCredentials(bytes: Buffer, call: StoreCall | null = null): Buffer | null {
  const masked = maskTextCredentials(bytes.toString('latin1'), 0, false, call);
  return masked === null ? null : Buffer.from(masked, 'latin1');
}

/** The `name` parameter of a Content-Disposition value (`name="api_key"`, `name=api_key`), quoted or not; undefined when absent. */
function dispositionName(header: string): string | undefined {
  const m = /(?:^|;)\s*name\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/i.exec(header);
  if (!m) return undefined;
  return m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]!.trim();
}

/** Its RFC 5987 extended `name*` parameter (`name*=UTF-8''api_key`), its value decoded; undefined when absent. */
function extendedName(header: string): string | undefined {
  const m = /(?:^|;)\s*name\*\s*=\s*([^;]*)/i.exec(header);
  return m ? decodedParam(m[1]!.trim().replace(/^[^']*'[^']*'/, '')) : undefined;
}

/**
 * A part of a multipart body as a recording keeps it: the content of a part whose name
 * credentialParam reads as one with its content (`api_key`, a `credentials` file) replaced by
 * CREDENTIAL_PLACEHOLDER, a name given as `name*=` read too; a part header that carries one
 * (`X-Api-Key:`, a JWT) masked; and any other part's content masked by its shape (a JSON metadata
 * part, a service account's key file).
 */
function maskedPart(part: MultipartPartText, depth: number): MultipartPartText | null {
  const headers = part.headers.replace(/^([A-Za-z][\w-]*)([ \t]*:[ \t]*)([^\r\n]*)$/gm, (whole, name: string, colon: string, value: string) => {
    const lower = name.toLowerCase();
    if (lower === 'content-disposition' || lower === 'content-type' || !value || value === CREDENTIAL_PLACEHOLDER) return whole;
    return credentialHeader(lower) || JWT.test(value.trim()) ? `${name}${colon}${CREDENTIAL_PLACEHOLDER}` : whole;
  });
  const disposition = /^content-disposition:([^\r\n]*)$/im.exec(part.headers)?.[1] ?? '';
  const name = dispositionName(disposition) ?? extendedName(disposition);
  if (name !== undefined && part.content !== CREDENTIAL_PLACEHOLDER && credentialParam(name, part.content)) return { headers, content: CREDENTIAL_PLACEHOLDER };
  const content = depth < MAX_NESTING ? maskTextCredentials(part.content, depth + 1) : null;
  return content === null && headers === part.headers ? null : { headers, content: content ?? part.content };
}

/**
 * A multipart body (`multipart/form-data`, `multipart/related`) with each part masked as maskedPart
 * masks it. Its boundary is read from the body itself, as a copy that has no content type must, past
 * a preamble, with CRLF or LF line breaks; every other byte (the delimiters, each part's headers but
 * a credential one, the other fields and files) stays as it was. Null when it holds no credential,
 * or doesn't read as multipart.
 */
export function maskMultipartBytes(bytes: Buffer): Buffer | null {
  const masked = maskMultipart(bytes.toString('latin1'), (part) => maskedPart(part, 0));
  return masked === null ? null : Buffer.from(masked, 'latin1');
}

/**
 * A captured call's stored body (`{ body, encoding }`, as decodeBody stores one) with its credentials
 * masked, the one rule both sides of matching read a body by: a JSON body's credential members (by
 * key, at any depth); a text body by its shape whatever its content type (maskTextCredentials: JSON
 * typed as text or behind a prefix, a form, multipart, lines of JSON, an event stream, XML); bytes
 * stored as base64 the same way, read one byte to a character; and the secret a write to a secret
 * store sends, by `sentBy`, the name of the call that sends the body (StoreCall). The same object when
 * nothing changes.
 */
export function credentialFreeBody<T extends { body?: unknown; encoding?: unknown }>(stored: T, sentBy?: string): T {
  const { body, encoding } = stored;
  const call = sentBy === undefined ? null : storeCall(sentBy, true);
  if (encoding === 'json' && body !== undefined) {
    const masked = maskJsonCredentials(body, call);
    return masked === body ? stored : { ...stored, body: masked };
  }
  if (typeof body !== 'string') return stored;
  if (encoding === 'text') {
    const masked = maskTextCredentials(body, 0, false, call);
    return masked === null ? stored : { ...stored, body: masked };
  }
  if (encoding === 'base64') {
    const masked = maskBytesCredentials(Buffer.from(body, 'base64'), call);
    return masked === null ? stored : { ...stored, body: masked.toString('base64') };
  }
  return stored;
}

/**
 * A captured call's stored arguments (`{ method, url, body?, encoding? }`) as they are matched on
 * replay and as every copy carries them: with the credentials in the URL's path and query masked
 * (credentialFreeUrl), and those in its body (credentialFreeBody: a JSON body's credential members,
 * a form's parameters, a multipart body's credential fields, the secret a write to a secret store
 * sends, by the call its method and address name), as a call is stored now. The sidecar stores a
 * live call's body by the same rule, so both sides of matching read it alike. A recording made by an
 * earlier version holds them as sent, and so still matches a live call with the same key or a
 * rotated one; a stored call that already reads so comes back as it is (the same object).
 */
export function withoutStoredCredentials(args: unknown): unknown {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return args;
  const stored = args as Record<string, unknown>;
  let out = stored;
  if (typeof stored.url === 'string') {
    const url = credentialFreeUrl(stored.url);
    if (url !== stored.url) out = { ...out, url };
  }
  return credentialFreeBody(out, sentBy(out));
}

/**
 * The name of the call stored arguments are, as the sidecar names a captured call (`PUT
 * acme.vault.azure.net/secrets/db`): its method, and its URL's host and path, the query left out.
 * Undefined when they have no method or no absolute URL.
 */
function sentBy(args: Readonly<Record<string, unknown>>): string | undefined {
  if (typeof args.method !== 'string' || typeof args.url !== 'string') return undefined;
  const [, , authority, path = ''] = URL_PARTS.exec(args.url) ?? [];
  return authority ? `${args.method} ${authority.slice(2)}${path}` : undefined;
}

/**
 * A model call's query string (`meta.query`, without its `?`) with every credential left out, as
 * the sidecar records one: each parameter credentialParam names, whatever its value (a model API
 * takes no `key` or `token` that is a lookup). The others stay byte for byte, in their order.
 * Undefined when nothing is left.
 */
export function credentialFreeQuery(query: string): string | undefined {
  const kept = query.split('&').filter((part) => {
    if (!part) return false;
    const eq = part.indexOf('=');
    return !credentialQueryParam(decodedParam(eq < 0 ? part : part.slice(0, eq)));
  });
  const out = kept.join('&');
  return out || undefined;
}

/**
 * Response headers whose whole value is a credential: a token a service hands back (OpenStack's
 * `x-subject-token`, Swift's `x-auth-token` and `x-storage-token`, GitLab's `private-token`,
 * OAuth's `x-access-token`/`x-refresh-token`, a CSRF or Vault token), and the request's own
 * credential headers, should a server echo one. Beyond this list, any header `credentialParam` reads
 * as a credential is masked too (credentialHeader), so a service's own `*-token`, `*-key` or
 * `*-secret` header is covered without being named here. A captured call's response keeps each with
 * CREDENTIAL_PLACEHOLDER for its value, so a client that reads its token from one still finds the
 * header on replay. `www-authenticate` and `location` carry a credential inside a larger value
 * (TOKEN_IN_VALUE), masked in place rather than whole.
 */
export const CREDENTIAL_HEADERS: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-subject-token',
  'x-auth-token',
  'x-storage-token',
  'x-access-token',
  'x-refresh-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-vault-token',
  'private-token',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  'ocp-apim-subscription-key',
  'x-amz-security-token',
  // An AWS load balancer's signed token naming the user it signed in.
  'x-amzn-oidc-data',
];

/**
 * Response headers whose value holds a credential among other text, masked in place: a URL that
 * carries an OAuth code or token in its query or fragment, or a password in its user info (a
 * redirect's `location`, a `content-location`, a proxy's `x-original-url`, `x-original-uri` and
 * `x-forwarded-uri`, htmx's `hx-redirect` and its kin, each URL of a `link`, the one a `refresh`
 * sends the client to), and a `www-authenticate` challenge whose token the server
 * hands back (a Negotiate/NTLM blob, a `token=` parameter).
 */
export const TOKEN_IN_VALUE: Readonly<Record<string, (value: string) => string>> = {
  location: maskLocation,
  'content-location': maskLocation,
  'x-original-url': maskLocation,
  'x-original-uri': maskLocation,
  'x-forwarded-uri': maskLocation,
  // htmx's: where the page goes next, a URL, or for hx-location a URL or JSON naming one.
  'hx-redirect': maskLocation,
  'hx-push-url': maskLocation,
  'hx-replace-url': maskLocation,
  'hx-location': (value) => (value.trimStart().startsWith('{') ? (maskTextCredentials(value, 0, true) ?? value) : maskLocation(value)),
  link: maskLinks,
  refresh: maskRefresh,
  'www-authenticate': maskChallenge,
  'proxy-authenticate': maskChallenge,
};

/** Response headers that set state in the client: never stored, nor handed to the agent on replay. */
export const STATE_HEADERS: readonly string[] = ['set-cookie', 'set-cookie2'];

/** Words that make a header's whole value a credential wherever they are in its name: `x-session-token-raw`, `x-api-secret-v2`. */
const HEADER_SECRET_WORD = new Set(['token', 'secret', 'password', 'passwd', 'credential']);

/**
 * Words that make the token word before them in a header's name a count or a limit of tokens, not a
 * token (countsTokens): Bedrock's `x-amzn-bedrock-input-token-count`. The rate limits' families count
 * `tokens`, which no rule reads as a token (`anthropic-ratelimit-input-tokens-remaining`,
 * `x-ratelimit-reset-tokens`).
 */
const TOKEN_COUNT = new Set(['count', 'counts', 'usage', 'limit', 'limits', 'remaining', 'reset', 'used']);

/**
 * Headers named as a session's that hold none: Azure's `azureml-model-session`, which Azure OpenAI
 * and Azure ML endpoints send with every answer, names the model deployment's session that served
 * the call, so a client can send it back to be routed there again. It signs nobody in: a call that
 * sends it back still needs its key.
 */
const ROUTING_HEADERS = ['azureml-model-session'];

/**
 * A count or a limit of tokens as a header gives it: at most 12 digits, a trillion, more than any
 * provider counts or limits tokens in, and fewer than a card number or a numeric token has.
 */
const SHORT_COUNT = /^\d{1,12}$/;
/** The session Azure names in `azureml-model-session`: a letter and a few digits, then the 14 digits of when it started (`d065-20240606224238`). */
const AZURE_SESSION = /^[a-z]\d{1,6}-\d{14}$/;

/**
 * Whether the token word at `i` of a header's name is a count's or a limit's: the word after it is
 * one of TOKEN_COUNT, and ends the name (`…-token-count`). Before it, it says what the token is for:
 * a `reset-token` is a password reset's.
 */
function countsTokens(words: readonly string[], i: number): boolean {
  return i === words.length - 2 && TOKEN_COUNT.has(words[i + 1]!);
}

/**
 * Whether a response header's whole value is a credential: one of CREDENTIAL_HEADERS, a name
 * `credentialParam` reads as one (`x-access-token`, `x-vault-token`, a service's own `*-token` or
 * `*-key`), a session's (`x-session`, `*-session`), an auth header of a service's own (`x-auth`,
 * `*-auth`), or one with a token, secret, password or credential word anywhere in its name
 * (`x-session-token-raw`), but a page's token (`x-next-page-token`), which a client sends back. The
 * explicit list covers the echoed request headers, which read by their words alone aren't
 * credentials. A count or a limit of tokens (countsTokens) and a routing hint (ROUTING_HEADERS) hold
 * none: given its `value`, one is kept only in the shape its name says it has, a count of at most 12
 * digits, a time or a duration (SHORT_COUNT, timeShaped), and Azure's session as Azure writes it
 * (AZURE_SESSION), and taken for a credential otherwise, as with no value given.
 */
export function credentialHeader(name: string, value?: string): boolean {
  const lower = name.toLowerCase();
  if (CREDENTIAL_HEADERS.includes(lower) || credentialParam(lower)) return true;
  const routing = ROUTING_HEADERS.includes(lower);
  if (!routing && /(?:^|-)(?:session|auth)$/.test(lower)) return true;
  const words = wordsOf(lower);
  const counted = words.map((w, i) => w === 'token' && countsTokens(words, i));
  if (words.some((w, i) => HEADER_SECRET_WORD.has(w) && !counted[i])) return !words.some((w) => CURSOR.includes(w));
  if (!routing && !counted.includes(true)) return false;
  return value === undefined || !(routing ? AZURE_SESSION.test(value) : SHORT_COUNT.test(value) || timeShaped(value));
}

/** A header value that is a JWT, alone or after an auth scheme (`Bearer eyJ…`): a bearer credential, whatever the header is named. */
function jwtValue(value: string): boolean {
  const v = value.trim();
  return JWT.test(v) || JWT.test(v.replace(/^[A-Za-z][\w-]*[ \t]+/, ''));
}

/**
 * A (possibly relative) URL a response names, its credentials masked as a redirect's are: query and
 * fragment parameters by name alone, a URL inside one (`next=/done?access_token=…`), a path
 * parameter (`;jsessionid=…`) and the password in its user info (maskUrlCredentials).
 */
export function maskLocation(location: string): string {
  return maskUrlCredentials(location, true);
}

/** A `link` header with each `<URL>` in it masked as a redirect's is. */
function maskLinks(value: string): string {
  return value.replace(/<([^<>]*)>/g, (whole, url: string) => {
    const masked = maskLocation(url);
    return masked === url ? whole : `<${masked}>`;
  });
}

/** Where the white space at `from` ends: `\s`'s characters, which are the ones `trimStart` takes. */
const pastSpace = (text: string, from: number) => text.length - text.slice(from).trimStart().length;

/**
 * A `refresh` header (`0; url=…`) with the URL it sends the client to masked as a redirect's is.
 * Read once through, by hand: a delay, `;` or `,`, `url` in any case, `=`, white space around each,
 * then the URL, quoted or not, which may be followed by a closing quote and white space only. A
 * value of any other shape stays as it is. (A pattern for it backtracked: a long value that ended
 * otherwise took time that grew with its length squared.)
 */
function maskRefresh(value: string): string {
  let at = pastSpace(value, 0);
  const delay = at;
  while (at < value.length && value.charCodeAt(at) >= 0x30 && value.charCodeAt(at) <= 0x39) at++;
  if (at > delay) at = pastSpace(value, at);
  if (value[at] === ';' || value[at] === ',') at = pastSpace(value, at + 1);
  if (value.slice(at, at + 3).toLowerCase() !== 'url') return value;
  at = pastSpace(value, at + 3);
  if (value[at] !== '=') return value;
  at = pastSpace(value, at + 1);
  const start = value[at] === '"' || value[at] === "'" ? at + 1 : at;
  let end = start;
  while (end < value.length && value[end] !== '"' && value[end] !== "'") end++;
  if (pastSpace(value, Math.min(end + 1, value.length)) < value.length) return value;
  const url = value.slice(start, end);
  const masked = maskLocation(url);
  return masked === url ? value : `${value.slice(0, start)}${masked}${value.slice(end)}`;
}

/**
 * An HTTP authentication challenge (`WWW-Authenticate`, `Proxy-Authenticate`) with its credential
 * masked in place: the value of any `name=value` auth-parameter whose name is a credential
 * (`token=…`), quoted or not, and the token68 blob after a scheme (a Negotiate or NTLM GSSAPI
 * token), in each of the challenges a value holds (`Negotiate …==, Basic realm="x"`). The schemes,
 * the realm and an error stay as the server sent them.
 */
export function maskChallenge(value: string): string {
  const params = value.replace(/([A-Za-z][\w-]*)\s*=\s*("(?:[^"\\]|\\.)*"|[^\s,]+)/g, (whole, name: string, v: string) => (credentialParam(name) ? `${name}=${v.startsWith('"') ? `"${CREDENTIAL_PLACEHOLDER}"` : CREDENTIAL_PLACEHOLDER}` : whole));
  // A scheme and its token68 blob, a challenge of its own: Negotiate/NTLM hand back a GSSAPI token this way.
  return params.replace(/(^|,)(\s*[A-Za-z][\w-]*\s+)([A-Za-z0-9._~+/-]+={0,2})(?=\s*(?:,|$))/g, (_whole, lead: string, scheme: string) => `${lead}${scheme}${CREDENTIAL_PLACEHOLDER}`);
}

/**
 * Headers as a recording keeps them: each credential header (credentialHeader, read with its value,
 * so a count of tokens stays as sent unless it reads as a key), and each whose value
 * is a JWT (alone or after a scheme, `Bearer eyJ…`), with CREDENTIAL_PLACEHOLDER for its value; the credential inside a URL a header names or
 * a challenge masked in place (TOKEN_IN_VALUE); and the headers that set a cookie or name the account
 * a call was made with (ACCOUNT_HEADERS) left out. Names are read in any case. The same object when
 * nothing changes.
 */
export function credentialFreeHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  let out: Record<string, string> | null = null;
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    const state = STATE_HEADERS.includes(lower) || ACCOUNT_HEADERS.includes(lower);
    const inValue = !state ? TOKEN_IN_VALUE[lower] : undefined;
    const credential = !state && !inValue && value !== CREDENTIAL_PLACEHOLDER && (credentialHeader(lower, value) || jwtValue(value));
    const masked = inValue ? inValue(value) : value;
    if (!state && !credential && masked === value) continue;
    out ??= { ...headers };
    if (state) delete out[name];
    else out[name] = credential ? CREDENTIAL_PLACEHOLDER : masked;
  }
  return out ?? headers;
}

const WS = new Set([' ', '\t', '\n', '\r']);

/**
 * The text of the value at `path` in a JSON document, with the whitespace around it, as written; null
 * when the document doesn't read as JSON there or has no such member.
 */
export function rawJsonMember(text: string, path: readonly string[]): string | null {
  let i = 0;
  const ws = () => {
    while (i < text.length && WS.has(text[i]!)) i++;
  };
  /** Moves past one string, from its opening quote; returns its text with the quotes. */
  const string = (): string | null => {
    const start = i;
    if (text[i] !== '"') return null;
    for (i++; i < text.length; i++) {
      if (text[i] === '\\') i++;
      else if (text[i] === '"') return text.slice(start, ++i);
    }
    return null;
  };
  /** Moves past one value, however deep, iteratively; false when it isn't JSON. */
  const value = (): boolean => {
    const end = skipJsonValue(text, i);
    if (end < 0) return false;
    i = end;
    return true;
  };
  for (let depth = 0; depth < path.length; depth++) {
    ws();
    if (text[i] !== '{') return null;
    i++;
    // Left only by the break at the key (or a return): past the loop, the key was found.
    for (;;) {
      ws();
      if (text[i] === '}') return null;
      const key = string();
      if (key === null) return null;
      ws();
      if (text[i++] !== ':') return null;
      let name: unknown;
      try {
        name = JSON.parse(key);
      } catch {
        return null;
      }
      if (name === path[depth]) break;
      if (!value()) return null;
      ws();
      if (text[i] === ',') i++;
      else return null;
    }
    if (depth === path.length - 1) {
      const start = i;
      if (!value()) return null;
      ws();
      return text[i] === ',' || text[i] === '}' ? text.slice(start, i) : null;
    }
  }
  return null;
}

/**
 * A captured call's result as a stored blob, `{ "result": … }`, from the result without its body
 * and, for a JSON response, the body's text as it arrived (`rawBody`): written inside the document
 * as it was, so its layout, escapes and numbers (a 64-bit id, `20.0`) stay as the service sent them.
 */
export function resultBlob(rest: Readonly<Record<string, unknown>>, rawBody: Buffer | string): Buffer {
  const head = JSON.stringify({ result: rest });
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  return Buffer.concat([Buffer.from(`${head.slice(0, -2)}${Object.keys(rest).length ? ',' : ''}"body":`, 'utf8'), body, Buffer.from('}}', 'utf8')]);
}

/** Whether a call is a captured HTTP call (a host under "http" in the config), recorded as a tool call. */
export function capturedHttp(call: { kind: string; meta: Readonly<Record<string, unknown>> }): boolean {
  return call.kind === 'tool' && typeof call.meta.http === 'string';
}

/**
 * A captured call's stored request (`{ "args": { method, url, body?, encoding? } }`) with the
 * credentials in its URL's query and its body masked (withoutStoredCredentials), its numbers as
 * written; null when it holds none to mask (or is no such request).
 */
export function credentialFreeRequest(bytes: Buffer): Buffer | null {
  let doc: unknown;
  try {
    doc = parseJsonExact(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (!isObject(doc) || !('args' in doc)) return null;
  const args = withoutStoredCredentials(doc.args);
  return args === doc.args ? null : Buffer.from(JSON.stringify({ ...doc, args }), 'utf8');
}

/**
 * A captured call's stored result (`{ "result": { status, headers, body?, encoding? } }`) as a
 * recording keeps it: its headers as credentialFreeHeaders keeps them, and its body with its
 * credentials masked in place by its shape, whatever its content type said (an OAuth token
 * response's `access_token` in JSON, typed as text or behind a prefix; a form-encoded answer's
 * token; an event stream's; an STS answer's XML; a secret store's secret, by `callName` too, the
 * name of the call it answers), every other byte as the service sent it; null when it holds nothing
 * to mask (or is no such result).
 */
export function credentialFreeResult(bytes: Buffer, callName?: string): Buffer | null {
  const text = bytes.toString('utf8');
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(doc) || !isObject(doc.result) || !isObject(doc.result.headers)) return null;
  const result = doc.result;
  const headers = result.headers as Record<string, string>;
  if (!Object.values(headers).every((v) => typeof v === 'string')) return null;
  const kept = credentialFreeHeaders(headers);
  const { body, ...rest } = result;
  const next = { ...rest, headers: kept };
  if (result.encoding === 'json' && body !== undefined) {
    const raw = rawJsonMember(text, ['result', 'body']);
    if (raw !== null) {
      const masked = maskJsonTextCredentials(raw, callName);
      return kept === headers && masked === null ? null : resultBlob(next, masked ?? raw);
    }
  }
  const maskedBody = typeof body === 'string' && (result.encoding === 'text' || result.encoding === 'base64') ? maskedResponseBody(body, result.encoding, callName) : body;
  if (kept === headers && maskedBody === body) return null;
  return Buffer.from(JSON.stringify({ result: maskedBody === undefined ? next : { ...next, body: maskedBody } }), 'utf8');
}

/** A stored text or base64 response body, the answer to `callName`, with its credentials masked by its shape; the same string when there are none. */
function maskedResponseBody(body: string, encoding: 'text' | 'base64', callName?: string): string {
  if (encoding === 'text') return maskTextCredentials(body, 0, false, answerOf(callName)) ?? body;
  return maskBytesCredentials(Buffer.from(body, 'base64'), answerOf(callName))?.toString('base64') ?? body;
}

/**
 * A captured call's response body, as received, with its credentials masked in place, by its shape
 * whatever its content type said: for a JSON body, the string value of each credential member
 * (maskJsonTextCredentials); for text, as maskTextCredentials reads it (JSON typed as text or behind
 * a prefix, a form-encoded answer, an event stream, lines of JSON, XML); for bytes that aren't
 * UTF-8, the same, read one byte to a character. A secret store's secret is masked by the answer's
 * shape, and by `callName`, the name of the call it answers (heldIn). Every other byte as sent; the
 * bytes as they are when nothing is masked.
 */
export function responseBodyWithoutCredentials(received: Buffer, encoding: unknown, callName?: string): Buffer {
  if (encoding === 'json') {
    const masked = maskJsonTextCredentials(received.toString('utf8'), callName);
    return masked === null ? received : Buffer.from(masked, 'utf8');
  }
  if (encoding === 'text') {
    const masked = maskTextCredentials(received.toString('utf8'), 0, false, answerOf(callName));
    return masked === null ? received : Buffer.from(masked, 'utf8');
  }
  if (encoding === 'base64') return maskBytesCredentials(received, answerOf(callName)) ?? received;
  return received;
}
