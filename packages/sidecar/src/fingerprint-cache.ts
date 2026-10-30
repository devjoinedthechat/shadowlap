import { canonicalize, FINGERPRINT_VERSION, maskClock, nearClock, sha256, type ClockReference, type Normalizer, type SecretNamesRule } from '@shadowlap/engine';

/**
 * Replay start without reading every recorded request again. A replay matches its recording's calls
 * by fingerprints made under its own rules (the project's normalizers, the rules that redacted a
 * copy, the clock), so it used to load and hash every stored request: 6.5 s for a run of 1,000 calls
 * whose requests add up to 1 GB. A fingerprint depends on three things: the request, the rules, and
 * the times dates are masked against (each run's start). The cache keys an entry by the first two
 * (`fingerprintKey`), and keeps beside the fingerprint every date, time and epoch value the request
 * holds with whether it was masked (`ClockMark`). An entry serves a replay that masks every one of
 * those values the same (`servesClock`); any other replay works the fingerprint out again. The
 * recording fills the cache as it goes, so the first replay already starts from it.
 */

/**
 * Bump when what a key covers, or what a mark means, changes. 2: a call's query is marked by its
 * values decoded, as its fingerprint reads them, and a judge's key names its query. 3: a captured
 * call's arguments are read with the credentials in a JSON or multipart body masked, so its
 * fingerprint differs. 4: and in a body by its shape whatever its content type (JSON sent as text,
 * lines of JSON, an event stream, XML, bytes that aren't UTF-8), so it differs again. 5: and inside
 * its strings (a URL, JSON in a string, a JWT, a connection string, GraphQL arguments), under a
 * credential member, and by the names added since (a cookie, lists of credentials). 6: and in its
 * address's path (a webhook's secret, a credential path parameter), which its name masks too, and
 * by the names a query or form carries one under (a session, a ticket, a secret key). 7: and in
 * the JSON objects among other text (after a comment, before `;`, in a page's script). 8: and in an
 * event's data read across its lines, and lines of JSON with other lines among them. 9: and in XML
 * and HTML by an element's name or key attribute, and inside an element that attribute names as one.
 * 10: and in `key: value` lines, a GraphQL block string, and a token given as a URL's name. 11: and
 * a URL's user info wherever it stands in text (a .env line's database URL, a sentence). 12: and a
 * JWT as a word of its own anywhere in text. 13: but a name that names or describes a secret
 * (`secret_name`, `password_policy`), which keeps its value, unless the run masked them, as one made
 * before did (RunMeta.secretNames), which the key names. 14: but a value under such a name that reads
 * as a key (`secret_name: "ghp_…"`), which is masked. 15: and a secret's path, ref, scope, namespace and
 * id, which keep their value too, under the rule a run stores as RunMeta.secretNames 2: the key names
 * any other rule a run's captured calls were read under. 16: and an object or a list under such a
 * name, masked through when a string in it reads as a key. 17: and a key under such a name made of
 * digits and a time's letters (`48201938475610293847561`), which only a time or a duration isn't;
 * where a secret store's answer holds its secret by its shape (a Kubernetes Secret's `data` and
 * `stringData`, as a manifest sends them); and a TLS key (`tls.key`). 18: and the secret a write to a
 * secret store sends, by the call's method and address (Vault's KV engine and wrapping, Key Vault,
 * Secret Manager's addVersion, a Kubernetes Secret's create, replace and patch).
 */
const CACHE_VERSION = 18;

/** How a stored call is fingerprinted, besides its request: everything its cache key names. */
export type FingerprintRules =
  | {
      kind: 'api';
      method: string;
      path: string;
      matchPath: string | null;
      /** The fingerprint headers as matching reads them (Provider.matchHeaders), and the list they come from. */
      headers: Record<string, string>;
      allow: readonly string[];
      normalizers: string;
      clock: boolean;
      withoutPrompt: boolean;
      /** The call's query string as it keeps it: part of the key, so a version that matches on it never reuses an entry made without. */
      query: string | null;
      /** How the request's numbers are read: as stored, or rounded for a recording made before requests kept them. */
      numbers: 'exact' | 'rounded';
    }
  | { kind: 'judge'; method: string; path: string; matchPath: string | null; headers: Record<string, string>; allow: readonly string[]; rules: string; query: string | null; numbers: 'exact' | 'rounded' }
  /** `secretNames`: a captured call's arguments read under a rule that keeps fewer of a secret's names than a run made now (SecretNamesRule). */
  | { kind: 'tool'; name: string; normalizers: string; clock: boolean; captured: boolean; secretNames?: 0 | 1 };

/** A list of rules as a key names it. */
export function rulesId(rules: readonly Normalizer[]): string {
  return sha256(canonicalize(rules));
}

/**
 * How a tool call is fingerprinted, as its key names it: its name, its normalizers' id, whether dates
 * are masked, and for a captured call, the rule its arguments are read under when it keeps fewer of a
 * secret's names than a run made now (`secretNames`, RunMeta.secretNames).
 */
export function toolRules(name: string, normalizers: string, clock: boolean, captured: boolean, secretNames: SecretNamesRule): FingerprintRules {
  return { kind: 'tool', name, normalizers, clock, captured, ...(captured && secretNames !== 2 ? { secretNames } : {}) };
}

/** The cache key of a stored request's fingerprint under `rules`. */
export function fingerprintKey(rules: FingerprintRules, requestRef: string): string {
  return sha256(canonicalize({ v: FINGERPRINT_VERSION, cache: CACHE_VERSION, rules, request: requestRef }));
}

/** A date, time or epoch value a request holds: its time (ms), how near a reference masks it, and whether it was masked when the entry was made. */
export type ClockMark = [time: number, window: number, masked: 0 | 1];

/**
 * Every clock value masking against `reference` sees in `values`, with whether it masked it. Read
 * from the whole request (its prompt, its `cache_control`, its query and headers too), a superset of
 * what the fingerprint masked: a value too many only makes an entry serve fewer replays, never a
 * wrong one.
 */
export function clockMarks(values: readonly unknown[], reference: ClockReference | undefined): ClockMark[] {
  if (reference === undefined) return [];
  const seen = new Map<string, ClockMark>();
  for (const value of values) {
    maskClock(value, reference, (time, window) => {
      if (!Number.isFinite(time)) return;
      const k = `${time}/${window}`;
      if (!seen.has(k)) seen.set(k, [time, window, nearClock(time, reference, window) ? 1 : 0]);
    });
  }
  return [...seen.values()];
}

/**
 * Whether an entry's fingerprint holds under `reference`: each value it marks is masked against it
 * exactly when it was masked then. Masking reads a string rule by rule, and a value it masks hides
 * what lies inside it from the rules after (a datetime's date); with every value it saw read the
 * same way, it sees the same values again and masks the request to the same text.
 */
export function servesClock(marks: readonly ClockMark[], reference: ClockReference | undefined): boolean {
  return marks.every(([time, window, masked]) => (reference !== undefined && nearClock(time, reference, window)) === (masked === 1));
}

export function encodeMarks(marks: readonly ClockMark[]): string | null {
  return marks.length ? JSON.stringify(marks) : null;
}

/** The marks an entry keeps, or null when they don't read as marks (the entry is then not used). */
export function decodeMarks(text: string | null): ClockMark[] | null {
  if (text === null) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return null;
    const ok = parsed.every((m) => Array.isArray(m) && m.length === 3 && typeof m[0] === 'number' && typeof m[1] === 'number' && (m[2] === 0 || m[2] === 1));
    return ok ? (parsed as ClockMark[]) : null;
  } catch {
    return null;
  }
}

/** The headers of `headers` a provider fingerprints (`allow`), as a key names them. */
export function allowedHeaders(headers: Readonly<Record<string, string>>, allow: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of allow) if (headers[h] !== undefined) out[h] = headers[h]!;
  return out;
}
