import { keptWhole } from './kept-canaries.js';
import { compilePattern, countMatches, normalizerApplies, parsePath, type RewriteObserver, type Segment, type UnmaskedAt } from './normalize.js';
import { withinPatternBudget } from './safe-regex.js';
import { mayHoldSigned, placeKey, signedParts, signedTexts } from './signed.js';
import type { CallKind, Normalizer } from './types.js';

/**
 * A stored JSON document (a response, a tool's result, a clock or random read, one event of a
 * stream) as a copy masks it: the rules apply to its values where they sit, and everything they
 * leave keeps its bytes. Numbers stay as they were written, so a recorded timestamp whose 13 digits
 * a card-number pattern matches still reads as that number when the copy replays; so do whitespace,
 * the order of keys and how each string was escaped. Only a string a rule changes is written again,
 * and a value a path rule replaces whole.
 *
 * The document is read once, token by token, with where each value sits (the keys and positions
 * down to it) on a stack: nothing of it is held but what is written again, so a document of any
 * size, or nested to any depth, is read in time and memory in proportion to its text. A document no
 * rule could change (no pattern matches its text, and nothing in it is escaped) is not read at all.
 */

/** The call a document belongs to: a path rule applies only within its scope. */
export interface CallScope {
  kind: CallKind;
  name: string;
}

/**
 * Whether a path rule can reach what a call got back as well as its request: one whose path starts
 * with a key or a position, such as `$.result.card`. `$` alone and a path that starts with a
 * wildcard (`$.*`) reach requests only: a rule written to hide a tool's whole arguments doesn't hide
 * its results too.
 */
export function pathReachesResults(rule: Normalizer): boolean {
  if (rule.path === undefined) return false;
  const first = parsePath(rule.path)[0];
  return first !== undefined && first.type !== 'wild';
}

/**
 * Whether a path rule reaches what `call` got back (a response or tool result that is JSON, an
 * attempt's error) in a copy that is only read, never replayed (export html, har and dataset):
 * within the rule's scope, with a path that reaches results, and never in a clock or random read,
 * whose value is the run's own time or randomness. A pack reaches none of it: its replay hands what
 * calls got back to the agent, which would act on a masked value differently and fork.
 */
export function reachesResultsOf(rule: Normalizer, call: CallScope): boolean {
  return call.kind !== 'clock' && call.kind !== 'random' && pathReachesResults(rule) && normalizerApplies(rule, call.kind, call.name);
}

/**
 * Whether a pattern matches a piece of text the same way wherever the text sits: no anchor, no
 * lookaround, not sticky. Then a pattern that matches nowhere in a document's text matches none of
 * its numbers, nor any string written there without escapes, since the quotes around a string read
 * as the edges of a text do to `\b`.
 */
export function contextFree(regex: RegExp): boolean {
  if (regex.sticky || regex.flags.includes('v')) return false;
  const s = regex.source;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === '[') {
      for (i++; i < s.length && s[i] !== ']'; i++) if (s[i] === '\\') i++;
    } else if (c === '^' || c === '$') return false;
    else if (c === '(' && s[i + 1] === '?' && (s[i + 2] === '=' || s[i + 2] === '!' || (s[i + 2] === '<' && (s[i + 3] === '=' || s[i + 3] === '!')))) return false;
  }
  return true;
}

// ---- reading the text ----

const isWs = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isHex = (c: number) => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);

function skipWs(text: string, i: number): number {
  while (isWs(text.charCodeAt(i))) i++;
  return i;
}

/** The end of the JSON string whose quote is at `i`, or -1 when it is no JSON string. */
function stringEnd(text: string, i: number): number {
  const n = text.length;
  for (let j = i + 1; j < n; j++) {
    const c = text.charCodeAt(j);
    if (c === 0x22) return j + 1;
    if (c === 0x5c) {
      const e = text.charCodeAt(j + 1);
      if (e === 0x75) {
        if (!(isHex(text.charCodeAt(j + 2)) && isHex(text.charCodeAt(j + 3)) && isHex(text.charCodeAt(j + 4)) && isHex(text.charCodeAt(j + 5)))) return -1;
        j += 5;
      } else if (e === 0x22 || e === 0x5c || e === 0x2f || e === 0x62 || e === 0x66 || e === 0x6e || e === 0x72 || e === 0x74) j++;
      else return -1;
    } else if (c < 0x20) return -1;
  }
  return -1;
}

/** The end of the JSON number at `i`, or -1 when there is none: -?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)? */
function numberEnd(text: string, i: number): number {
  if (text.charCodeAt(i) === 0x2d) i++;
  const first = text.charCodeAt(i);
  if (first === 0x30) i++;
  else if (first >= 0x31 && first <= 0x39) while (isDigit(text.charCodeAt(++i)));
  else return -1;
  if (text.charCodeAt(i) === 0x2e) {
    if (!isDigit(text.charCodeAt(++i))) return -1;
    while (isDigit(text.charCodeAt(++i)));
  }
  const e = text.charCodeAt(i);
  if (e === 0x65 || e === 0x45) {
    const sign = text.charCodeAt(++i);
    if (sign === 0x2b || sign === 0x2d) i++;
    if (!isDigit(text.charCodeAt(i))) return -1;
    while (isDigit(text.charCodeAt(++i)));
  }
  return i;
}

/** The end of a scalar that isn't a string (a number, true, false or null) at `i`, or -1. */
function scalarEnd(text: string, i: number): number {
  const c = text.charCodeAt(i);
  if (c === 0x74) return text.startsWith('true', i) ? i + 4 : -1;
  if (c === 0x66) return text.startsWith('false', i) ? i + 5 : -1;
  if (c === 0x6e) return text.startsWith('null', i) ? i + 4 : -1;
  return numberEnd(text, i);
}

/**
 * Whether `text` is one JSON document, as JSON.parse reads it (no byte order mark, no trailing
 * text), checked without building it.
 */
export function isJsonText(text: string): boolean {
  const stack: number[] = [];
  let i = skipWs(text, 0);
  for (;;) {
    // A value is next.
    const c = text.charCodeAt(i);
    if (c === 0x7b || c === 0x5b) {
      i = skipWs(text, i + 1);
      if (text.charCodeAt(i) === (c === 0x7b ? 0x7d : 0x5d)) i++;
      else {
        stack.push(c);
        if (c === 0x7b) {
          if (text.charCodeAt(i) !== 0x22 || (i = stringEnd(text, i)) < 0) return false;
          i = skipWs(text, i);
          if (text.charCodeAt(i) !== 0x3a) return false;
          i = skipWs(text, i + 1);
        }
        continue;
      }
    } else if (c === 0x22) {
      if ((i = stringEnd(text, i)) < 0) return false;
    } else if ((i = scalarEnd(text, i)) < 0) return false;
    // After a value: a comma before the next member, the end of a container, or the end of the text.
    for (;;) {
      i = skipWs(text, i);
      if (!stack.length) return i === text.length;
      const top = stack[stack.length - 1]!;
      const d = text.charCodeAt(i);
      if (d === 0x2c) {
        i = skipWs(text, i + 1);
        if (top === 0x7b) {
          if (text.charCodeAt(i) !== 0x22 || (i = stringEnd(text, i)) < 0) return false;
          i = skipWs(text, i);
          if (text.charCodeAt(i) !== 0x3a) return false;
          i = skipWs(text, i + 1);
        }
        break;
      }
      if (d !== (top === 0x7b ? 0x7d : 0x5d)) return false;
      stack.pop();
      i++;
    }
  }
}

/** The end of the value at `i` in a text that is JSON. */
function valueEnd(text: string, i: number): number {
  const c = text.charCodeAt(i);
  if (c === 0x22) return stringEnd(text, i);
  if (c !== 0x7b && c !== 0x5b) return scalarEnd(text, i);
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const d = text.charCodeAt(j);
    if (d === 0x22) j = stringEnd(text, j) - 1;
    else if (d === 0x7b || d === 0x5b) depth++;
    else if (d === 0x7d || d === 0x5d) {
      if (--depth === 0) return j + 1;
    }
  }
  return text.length;
}

/** How many members the list at `i` holds, in a text that is JSON. */
function listLength(text: string, i: number): number {
  let j = skipWs(text, i + 1);
  if (text.charCodeAt(j) === 0x5d) return 0;
  let n = 0;
  for (;;) {
    n++;
    j = skipWs(text, valueEnd(text, j));
    if (text.charCodeAt(j) !== 0x2c) return n;
    j = skipWs(text, j + 1);
  }
}

// ---- the rules, as a document reads them ----

interface Rule {
  /** Its place in the list of rules. */
  i: number;
  replace: string;
  regex: RegExp | null;
  /** A path rule's segments; null for a rule without a path. */
  segs: Segment[] | null;
  /**
   * For a rule without a path: false when its pattern matches nowhere in the document's text and
   * reads the same wherever text sits, so it changes no number and no string written without
   * escapes there (until another rule has written that string again).
   */
  hits: boolean;
}

/** A path rule partway down its path: how many of its segments the places above have used. */
interface Lead {
  rule: Rule;
  depth: number;
}

/** An object or list being read. */
interface Frame {
  obj: boolean;
  /** The member being read: its key as the copy writes it, or its position. */
  at: string | number;
  /** The member's key as the document writes it, before any rule masked it. */
  raw: string;
  /** For a member of an object: its key as each path rule reads it (`keyFor`); null when no path rule leads here. */
  keys: string[] | null;
  /** The path rules that lead into this container's members. */
  leads: Lead[] | null;
  /** Its length, read ahead when a path rule counts positions from the end (`[-1]`). */
  length: number;
  /** Rules from this one on act on nothing inside it: one of them replaces it whole. */
  ceiling: number;
  /** The ceiling of the container around it. */
  outer: number;
  /** False inside a value a rule replaces whole: nothing there reaches the copy. */
  keep: boolean;
  /** Path rules with a pattern whose place is this container or one around it: what their pattern matches inside, they leave. */
  within: Rule[] | null;
  /** The path rules whose place this container is. */
  exact: Rule[] | null;
  /** Where its own text starts in `out`, when it is needed at its end; -1 when not. */
  mark: number;
}

function prepare(rules: readonly Normalizer[], call: CallScope | null, text: string): { pathless: Rule[]; pathed: Rule[]; free: boolean } {
  const pathless: Rule[] = [];
  const pathed: Rule[] = [];
  let free = true;
  rules.forEach((rule, i) => {
    if (rule.path === undefined) {
      if (rule.pattern === undefined) return;
      const regex = compilePattern(rule.pattern);
      const loose = !contextFree(regex);
      if (loose) free = false;
      regex.lastIndex = 0;
      pathless.push({ i, replace: rule.replace, regex, segs: null, hits: loose || regex.test(text) });
      regex.lastIndex = 0;
      return;
    }
    if (!call || !reachesResultsOf(rule, call)) return;
    pathed.push({ i, replace: rule.replace, regex: rule.pattern === undefined ? null : compilePattern(rule.pattern), segs: parsePath(rule.path), hits: true });
  });
  return { pathless, pathed, free };
}

/**
 * Whether the rules leave `text` exactly as it is, whatever it holds, without reading it: no path
 * rule reaches it, no pattern matches its text, every pattern reads the same wherever text sits,
 * and nothing in it is escaped (an escaped character reads otherwise once the string is read).
 */
export function untouched(text: string, rules: readonly Normalizer[], call: CallScope | null): boolean {
  if (call && rules.some((r) => reachesResultsOf(r, call))) return false;
  if (text.includes('\\')) return false;
  for (const rule of rules) {
    if (rule.path !== undefined || rule.pattern === undefined) continue;
    const regex = compilePattern(rule.pattern);
    if (!contextFree(regex) || regex.test(text)) return false;
  }
  return true;
}

/**
 * `text` with the rules applied as a copy applies them, when it is one JSON document; null when it
 * isn't (a stream, plain text), which the copy masks as text instead. In the order the rules come:
 * a rule without a path rewrites what its pattern matches in every string, keys included, whatever
 * its scope, as it does in every response. With `call`, for a copy that is only read, a rule with a
 * path that reaches what the call got back (reachesResultsOf) rewrites the value at its path, as it
 * does in a request: its pattern in a string there, or with no pattern the whole value, numbers and
 * objects included. Without it, as in a pack, no path rule applies. A number is never rewritten by
 * a pattern.
 *
 * The observer hears each change as `applyNormalizers` reports it, each value a path rule reaches,
 * and what a pattern matches that is left as it is (`unmasked`), once every rule has applied there:
 * a number, for a rule without a path; for a rule with a path and a pattern, a number at its path,
 * or a string, number or key inside an object or list at its path.
 *
 * `signed`, for a copy that can be replayed: signed reasoning in the document (signed.ts) keeps its
 * bytes, keys and all, whatever the rules, and the observer hears what the rules without a path
 * match in its texts (`signed`); with `stream`, the document is one event of a stream, whose
 * thinking text is told where the stream's pieces add up (redact-stream.ts).
 */
export function rewriteJsonDocument(text: string, rules: readonly Normalizer[], call: CallScope | null, observer?: RewriteObserver, signed?: { stream: boolean }): string | null {
  // Its rules' patterns run within the time budget, as everywhere a document is rewritten (safe-regex.ts).
  return withinPatternBudget(
    text.length,
    () => rules.flatMap((r) => (r.pattern !== undefined ? [r.pattern] : [])),
    () => rewriteJsonDocumentNow(text, rules, call, observer, signed),
  );
}

function rewriteJsonDocumentNow(text: string, rules: readonly Normalizer[], call: CallScope | null, observer?: RewriteObserver, signed?: { stream: boolean }): string | null {
  if (!isJsonText(text)) return null;
  const { pathless, pathed, free } = prepare(rules, call, text);
  if (!pathed.length && (!pathless.length || (free && !text.includes('\\') && !pathless.some((r) => r.hits)))) return text;
  return scan(text, pathless, pathed, observer, signed && mayHoldSigned(text) ? { stream: signed.stream, places: new Set(signedParts(JSON.parse(text)).map((p) => placeKey(p.place))) } : null);
}

/** Whether a segment of a path names this member: its key as the rule reads it, or its position in a list of `length`. */
function names(seg: Segment, key: string | number, length: number): boolean {
  if (seg.type === 'wild') return true;
  if (seg.type === 'key') return typeof key === 'string' && key === seg.key;
  if (typeof key !== 'number') return false;
  return seg.index < 0 ? key === length + seg.index : key === seg.index;
}

/** The places of signed reasoning in a document (placeKey), kept as recorded; `stream` as rewriteJsonDocument says. */
interface SignedPlaces {
  stream: boolean;
  places: Set<string>;
}

/** The document read once, as rewriteJsonDocument describes. `text` is JSON. */
function scan(text: string, pathless: Rule[], pathed: Rule[], observer: RewriteObserver | undefined, signed: SignedPlaces | null): string {
  const all = [...pathless, ...pathed].sort((a, b) => a.i - b.i);
  const counting = pathed.some((r) => r.segs!.some((s) => s.type === 'index' && s.index < 0));
  const changed = observer?.changed;
  const reached = observer?.reached;
  const unmasked = observer?.unmasked;
  const out: string[] = [];
  let pos = 0;
  /** Writes `s` in place of the text from `from` to `to`. */
  const put = (from: number, to: number, s: string) => {
    if (from > pos) out.push(text.slice(pos, from));
    out.push(s);
    pos = to;
  };
  const stack: Frame[] = [];
  /** What `rule`'s pattern matches in `value`, left as it is where the reading is now (a key's own name ends the path). */
  const report = (rule: Rule, value: string, what: UnmaskedAt['what']) => {
    const count = countMatches(value, rule.regex!);
    if (count) unmasked!(rule.i, value, { what, path: stack.map((f) => f.at) }, count);
  };

  /**
   * A string value, `v` as read, with the rules up to `ceiling` applied in their order: those
   * without a path, and the path rules whose place it is (`exact`), a pattern there or the whole
   * value replaced. `after` skips the rules up to and including that one, for a value a rule has
   * just put in place of another. `raw` is true while `v` is still the text as written.
   */
  const applyTo = (v: string, exact: Rule[] | null, ceiling: number, raw: boolean, after = -1): string => {
    for (const r of exact ? all : pathless) {
      if (r.i <= after) continue;
      if (r.i >= ceiling) break;
      if (r.segs) {
        if (!exact!.includes(r)) continue;
        reached?.(r.i, v);
        if (!r.regex) {
          const kept = keptWhole(v, r.replace);
          if (v === kept) continue;
          changed?.(r.i, v, kept, 1);
          [v, raw] = [kept, false];
          continue;
        }
      } else if (raw && !r.hits) continue;
      const regex = r.regex!;
      regex.lastIndex = 0;
      const next = v.replace(regex, r.replace);
      if (next === v) continue;
      changed?.(r.i, v, next, countMatches(v, regex));
      v = next;
      raw = false;
    }
    return v;
  };

  /** Where the value being read sits among the path rules: those whose place it is, and those that lead into it. */
  const placed = (): { exact: Rule[] | null; leads: Lead[] | null } => {
    const top = stack[stack.length - 1];
    if (!top) return { exact: null, leads: pathed.length ? pathed.map((rule) => ({ rule, depth: 0 })) : null };
    if (!top.leads) return { exact: null, leads: null };
    let exact: Rule[] | null = null;
    let leads: Lead[] | null = null;
    for (const lead of top.leads) {
      const r = lead.rule;
      if (r.i >= top.ceiling) continue;
      const key = top.obj ? top.keys![pathed.indexOf(r)]! : top.at;
      if (!names(r.segs![lead.depth]!, key, top.length)) continue;
      if (lead.depth + 1 === r.segs!.length) (exact ??= []).push(r);
      else (leads ??= []).push({ rule: r, depth: lead.depth + 1 });
    }
    return { exact, leads };
  };

  /** Where the value being read sits, by the keys the document writes. */
  const here = (): Array<string | number> => stack.map((f) => (f.obj ? f.raw : f.at));
  /** Signed reasoning at `i`, ending at `end`: kept as written, and what the rules match in it told. */
  const keepSigned = (i: number, end: number) => {
    const tell = observer?.signed;
    if (!tell) return;
    const place = here();
    for (const { place: inner, text: t } of signedTexts(JSON.parse(text.slice(i, end)) as unknown, place, signed!.stream)) {
      for (const r of pathless) {
        const count = countMatches(t, r.regex!);
        if (count) tell(r.i, t, { what: 'string', path: [...inner], signed: true }, count);
      }
    }
  };

  let i = skipWs(text, 0);
  for (;;) {
    // A value starts at i.
    const top = stack[stack.length - 1];
    const ceiling = top ? top.ceiling : Infinity;
    const keep = top ? top.keep : true;
    const within = top ? top.within : null;
    const { exact, leads } = pathed.length ? placed() : { exact: null, leads: null };
    const c = text.charCodeAt(i);
    if (signed && signed.places.has(placeKey(here()))) {
      const end = valueEnd(text, i);
      keepSigned(i, end);
      i = end;
    } else if (c === 0x7b || c === 0x5b) {
      const whole = exact?.find((r) => !r.regex) ?? null;
      if (whole && !observer) {
        // A copy needs nothing from inside a value it replaces whole.
        const end = valueEnd(text, i);
        put(i, end, JSON.stringify(applyTo(whole.replace, exact, ceiling, false, whole.i)));
        i = end;
      } else {
        const patterns = exact?.filter((r) => r.regex) ?? [];
        const frame: Frame = {
          obj: c === 0x7b,
          at: c === 0x7b ? '' : 0,
          raw: '',
          keys: null,
          leads,
          // A list's length is read ahead only when a path rule counts its positions from the end.
          length: counting && c === 0x5b && leads ? listLength(text, i) : 0,
          ceiling: whole ? whole.i : ceiling,
          outer: ceiling,
          keep: keep && !whole,
          within: patterns.length ? [...(within ?? []), ...patterns] : within,
          exact,
          mark: -1,
        };
        if (whole || (patterns.length && reached)) {
          if (i > pos) out.push(text.slice(pos, i));
          pos = i;
          frame.mark = out.length;
        }
        stack.push(frame);
        i = skipWs(text, i + 1);
        if (text.charCodeAt(i) === (frame.obj ? 0x7d : 0x5d)) i++;
        else {
          if (frame.obj) i = readKey(i);
          continue;
        }
        i = close(i);
      }
    } else if (c === 0x22) {
      const end = stringEnd(text, i);
      const written = text.slice(i + 1, end - 1);
      const escaped = written.includes('\\');
      const value = escaped ? (JSON.parse(text.slice(i, end)) as string) : written;
      const v = applyTo(value, exact, ceiling, !escaped);
      if (v !== value) put(i, end, JSON.stringify(v));
      if (unmasked && keep && within) for (const r of within) report(r, v, 'string');
      i = end;
    } else {
      const end = scalarEnd(text, i);
      const written = text.slice(i, end);
      let v: string | null = null;
      if (exact) {
        // Rules before a whole value's replacement find a number there, which no pattern rewrites.
        const value = JSON.parse(written) as unknown;
        for (const r of exact) {
          if (r.i >= ceiling) break;
          reached?.(r.i, value);
          if (r.regex) continue;
          changed?.(r.i, value, r.replace, 1);
          v = applyTo(r.replace, exact, ceiling, false, r.i);
          break;
        }
        if (v !== null) put(i, end, JSON.stringify(v));
      }
      if (unmasked && keep && v === null && (c === 0x2d || isDigit(c))) {
        for (const r of pathless) if (r.hits) report(r, written, 'number');
        if (exact) for (const r of exact) if (r.regex) report(r, written, 'number');
        if (within) for (const r of within) report(r, written, 'number');
      }
      i = end;
    }
    // After a value: the next member, or the end of a container, or of the document.
    for (;;) {
      i = skipWs(text, i);
      const f = stack[stack.length - 1];
      if (!f) {
        if (pos < text.length) out.push(text.slice(pos));
        return out.join('');
      }
      if (text.charCodeAt(i) === 0x2c) {
        i = skipWs(text, i + 1);
        if (f.obj) i = readKey(i);
        else f.at = (f.at as number) + 1;
        break;
      }
      i = close(i + 1);
    }
  }

  /** Reads the key at `i` of the object on top (masking it as the copy does) and the colon after it; returns where its value starts. */
  function readKey(i: number): number {
    const f = stack[stack.length - 1]!;
    const end = stringEnd(text, i);
    const written = text.slice(i + 1, end - 1);
    const escaped = written.includes('\\');
    const key = escaped ? (JSON.parse(text.slice(i, end)) as string) : written;
    if (f.leads) {
      // Each path rule reads the key as the rules before it left it.
      f.keys = pathed.map((r) => {
        let k = key;
        for (const p of pathless) {
          if (p.i >= r.i || p.i >= f.ceiling) break;
          p.regex!.lastIndex = 0;
          k = k.replace(p.regex!, p.replace);
        }
        return k;
      });
    }
    const v = applyTo(key, null, f.ceiling, !escaped);
    if (v !== key) put(i, end, JSON.stringify(v));
    f.at = v;
    f.raw = key;
    if (unmasked && f.keep && f.within) for (const r of f.within) report(r, v, 'key');
    return skipWs(text, skipWs(text, end) + 1);
  }

  /** The container on top ends just before `end`: a rule whose place it is applies to it now. Returns `end`. */
  function close(end: number): number {
    const f = stack.pop()!;
    if (f.mark < 0) return end;
    if (end > pos) out.push(text.slice(pos, end));
    pos = end;
    const own = out.slice(f.mark).join('');
    let parsed: unknown;
    let read = false;
    const value = () => {
      if (!read) parsed = JSON.parse(own) as unknown;
      read = true;
      return parsed;
    };
    const whole = f.exact!.find((r) => !r.regex) ?? null;
    for (const r of f.exact!) {
      if (r.i >= f.outer) break;
      if (whole && r.i > whole.i) break;
      if (reached) reached(r.i, value());
      if (r !== whole) continue;
      changed?.(r.i, value(), r.replace, 1);
      out.length = f.mark;
      out.push(JSON.stringify(applyTo(r.replace, f.exact, f.outer, false, r.i)));
    }
    return end;
  }
}
