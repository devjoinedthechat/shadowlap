import { compilePattern, countMatches, normalizerApplies, parsePath, type RewriteObserver, type Segment } from './normalize.js';
import type { CallKind, Normalizer } from './types.js';

/**
 * A stored JSON document (a response, a tool's result, a clock or random read) as a copy masks it:
 * the rules apply to its values where they sit, and everything they leave keeps its bytes. Numbers
 * stay as they were written, so a recorded timestamp whose 13 digits a card-number pattern matches
 * still reads as that number when the copy replays; so do whitespace, the order of keys and how
 * each string was escaped. Only a string a rule changes is written again, and a value a path rule
 * replaces whole.
 *
 * The document is read once into a tree of spans over its text: each value knows where it starts
 * and ends, the object or list that holds it and its place there. Rules change the tree; the copy
 * is the text with each changed value's span replaced.
 */

/** The call a document belongs to: a path rule applies only within its scope. */
export interface CallScope {
  kind: CallKind;
  name: string;
}

/**
 * Whether a path rule reaches what a call got back (a response, a tool's result, an error) as well
 * as its request: one whose path starts with a key or a position, such as `$.result.card`. `$`
 * alone and a path that starts with a wildcard (`$.*`) reach requests only, as they always have: a
 * rule written to hide a tool's whole arguments doesn't hide its results too.
 */
export function pathReachesResults(rule: Normalizer): boolean {
  if (rule.path === undefined) return false;
  const first = parsePath(rule.path)[0];
  return first !== undefined && first.type !== 'wild';
}

/** Whether a path rule applies to what this call got back: within its scope, and reaching it. */
const reachesHere = (rule: Normalizer, call: CallScope | null): call is CallScope => !!call && pathReachesResults(rule) && normalizerApplies(rule, call.kind, call.name);

interface Span {
  start: number;
  end: number;
  /** The object or list that holds it (null for the document itself), and its place there. */
  up: Container | null;
  slot: number;
}
/** A string, a key among them. `was` is what it read as recorded; null for a value a rule put in place of another. */
interface Str extends Span {
  t: 's';
  value: string;
  was: string | null;
  key: boolean;
}
/** A number, true, false or null, as written. */
interface Scalar extends Span {
  t: 'n';
}
interface List extends Span {
  t: 'a';
  items: Node[];
}
interface Obj extends Span {
  t: 'o';
  keys: Str[];
  values: Node[];
}
type Container = List | Obj;
type Node = Str | Scalar | Container;

/** Where a value sits: in a container's slot, or the document itself (`up` null). */
interface Place {
  up: Container | null;
  slot: number;
}

const WS = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;

/**
 * The tree of a text that is one JSON document (JSON.parse has accepted it), read without
 * recursion, so a deeply nested document is read as surely as JSON.parse reads it.
 */
function parse(text: string): Node {
  let i = 0;
  const skip = () => {
    while (i < text.length && WS(text.charCodeAt(i))) i++;
  };
  const string = (up: Container | null, slot: number, key: boolean): Str => {
    const start = i;
    let escaped = false;
    i++;
    for (let c = text.charCodeAt(i); c !== 0x22; c = text.charCodeAt(i)) {
      if (c === 0x5c) {
        escaped = true;
        i += 2;
      } else i++;
    }
    i++;
    const raw = text.slice(start, i);
    const value = escaped ? (JSON.parse(raw) as string) : raw.slice(1, -1);
    return { t: 's', start, end: i, up, slot, value, was: value, key };
  };
  const scalar = (up: Container | null, slot: number): Scalar => {
    const start = i;
    for (let c = text.charCodeAt(i); i < text.length && c !== 0x2c && c !== 0x5d && c !== 0x7d && !WS(c); c = text.charCodeAt(++i));
    return { t: 'n', start, end: i, up, slot };
  };
  let root: Node | null = null;
  const stack: Container[] = [];
  for (;;) {
    skip();
    const up = stack[stack.length - 1] ?? null;
    let c = text.charCodeAt(i);
    let key: Str | null = null;
    if (up) {
      // After a member: a comma before the next, or the end of the container.
      if (c === 0x2c) {
        i++;
        skip();
        c = text.charCodeAt(i);
      } else if (c === 0x5d || c === 0x7d) {
        i++;
        up.end = i;
        stack.pop();
        if (!stack.length) break;
        continue;
      }
      if (up.t === 'o') {
        key = string(up, up.keys.length, true);
        skip();
        i++; // the colon
        skip();
        c = text.charCodeAt(i);
      }
    }
    const slot = up ? (up.t === 'a' ? up.items.length : up.values.length) : 0;
    const start = i;
    let node: Node;
    if (c === 0x7b || c === 0x5b) {
      i++;
      node = c === 0x7b ? { t: 'o', start, end: -1, up, slot, keys: [], values: [] } : { t: 'a', start, end: -1, up, slot, items: [] };
    } else node = c === 0x22 ? string(up, slot, false) : scalar(up, slot);
    if (!up) root = node;
    else if (up.t === 'a') up.items.push(node);
    else {
      up.keys.push(key!);
      up.values.push(node);
    }
    if (node.t === 'o' || node.t === 'a') stack.push(node);
    else if (!stack.length) break;
  }
  return root!;
}

class JsonDoc {
  root: Node;
  constructor(readonly text: string) {
    this.root = parse(text);
  }

  at(p: Place): Node {
    if (!p.up) return this.root;
    return p.up.t === 'a' ? p.up.items[p.slot]! : p.up.values[p.slot]!;
  }

  /** Every node under `from` in the order its text has them, keys before their values. */
  *nodes(from: Node = this.root): Generator<Node> {
    const todo: Node[] = [from];
    while (todo.length) {
      const n = todo.pop()!;
      yield n;
      if (n.t === 'a') for (let k = n.items.length - 1; k >= 0; k--) todo.push(n.items[k]!);
      else if (n.t === 'o') {
        for (let k = n.values.length - 1; k >= 0; k--) {
          todo.push(n.values[k]!);
          todo.push(n.keys[k]!);
        }
      }
    }
  }

  /** The places a path names, in the order `applyNormalizers` visits them. A key named twice in one object is every one of them. */
  places(segs: Segment[]): Place[] {
    if (segs.length === 0) return [{ up: null, slot: 0 }];
    let at: Place[] = [{ up: null, slot: 0 }];
    for (const seg of segs) {
      const next: Place[] = [];
      for (const p of at) {
        const node = this.at(p);
        if (node.t === 'a') {
          if (seg.type === 'wild') node.items.forEach((_, k) => next.push({ up: node, slot: k }));
          else if (seg.type === 'index') {
            const k = seg.index < 0 ? node.items.length + seg.index : seg.index;
            if (k >= 0 && k < node.items.length) next.push({ up: node, slot: k });
          }
        } else if (node.t === 'o') {
          if (seg.type === 'wild') node.values.forEach((_, k) => next.push({ up: node, slot: k }));
          else if (seg.type === 'key') node.keys.forEach((key, k) => key.value === seg.key && next.push({ up: node, slot: k }));
        }
      }
      at = next;
    }
    return at;
  }

  /** Puts a string where a value was: what a path rule with no pattern does. */
  replace(p: Place, value: string): void {
    const old = this.at(p);
    const node: Str = { t: 's', start: old.start, end: old.end, up: old.up, slot: old.slot, value, was: null, key: false };
    if (!p.up) this.root = node;
    else if (p.up.t === 'a') p.up.items[p.slot] = node;
    else p.up.values[p.slot] = node;
  }

  /** The text of `node` now: its own bytes, with each changed string or replaced value in it written again. */
  textOf(node: Node = this.root): string {
    let out = '';
    let pos = node.start;
    for (const n of this.nodes(node)) {
      if (n.t !== 's' || n.value === n.was) continue;
      out += this.text.slice(pos, n.start) + JSON.stringify(n.value);
      pos = n.end;
    }
    return out + this.text.slice(pos, node.end);
  }

  /** The value of `node` now, as JSON.parse reads it. */
  valueOf(node: Node): unknown {
    return node.t === 's' ? node.value : JSON.parse(this.textOf(node));
  }

  /** Where `node` sits: the keys and positions from the document down to it, keys as they read now. */
  pathOf(node: Node): Array<string | number> {
    const out: Array<string | number> = [];
    for (let n: Node = node; n.up; n = n.up) out.push(n.up.t === 'a' ? n.slot : n.up.keys[n.slot]!.value);
    return out.reverse();
  }

  toString(): string {
    return this.text.slice(0, this.root.start) + this.textOf(this.root) + this.text.slice(this.root.end);
  }
}

/**
 * `text` with the rules applied as a copy applies them, when it is one JSON document; null when it
 * isn't (a stream, plain text), which the copy masks as text instead. In the order the rules come:
 * a rule without a path rewrites what its pattern matches in every string, keys included, whatever
 * its scope, as it does in every response; a rule with a path that reaches results
 * (pathReachesResults), for the call's kind and name, rewrites the value at its path as it does in
 * a request: its pattern in a string there, or with no pattern the whole value, numbers and objects
 * included. A number is never rewritten by a pattern.
 *
 * The observer hears each change as `applyNormalizers` reports it, each value a path rule reaches,
 * and, once every rule has applied, what a pattern matches that is left as it is (`unmasked`): a
 * number anywhere for a rule without a path; for a rule with a path and a pattern, a number, object
 * or list at its path.
 */
export function rewriteJsonDocument(text: string, rules: readonly Normalizer[], call: CallScope | null, observer?: RewriteObserver): string | null {
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  const doc = new JsonDoc(text);
  rules.forEach((rule, i) => {
    if (rule.path === undefined) {
      if (rule.pattern === undefined) return;
      const regex = compilePattern(rule.pattern);
      for (const s of doc.nodes()) {
        if (s.t !== 's') continue;
        regex.lastIndex = 0;
        const next = s.value.replace(regex, rule.replace);
        if (next === s.value) continue;
        observer?.changed?.(i, s.value, next, countMatches(s.value, regex));
        s.value = next;
      }
      return;
    }
    if (!reachesHere(rule, call)) return;
    const regex = rule.pattern === undefined ? null : compilePattern(rule.pattern);
    for (const place of doc.places(parsePath(rule.path))) {
      const leaf = doc.at(place);
      if (observer?.reached) observer.reached(i, doc.valueOf(leaf));
      if (regex === null) {
        if (leaf.t === 's' && leaf.value === rule.replace) continue;
        observer?.changed?.(i, doc.valueOf(leaf), rule.replace, 1);
        doc.replace(place, rule.replace);
      } else if (leaf.t === 's') {
        regex.lastIndex = 0;
        const next = leaf.value.replace(regex, rule.replace);
        if (next === leaf.value) continue;
        observer?.changed?.(i, leaf.value, next, countMatches(leaf.value, regex));
        leaf.value = next;
      }
    }
  });
  if (observer?.unmasked) reportUnmaskedIn(doc, rules, call, observer.unmasked);
  return doc.toString();
}

/** What each pattern matches that the document keeps as it is: see rewriteJsonDocument. */
function reportUnmaskedIn(doc: JsonDoc, rules: readonly Normalizer[], call: CallScope | null, report: NonNullable<RewriteObserver['unmasked']>): void {
  rules.forEach((rule, i) => {
    if (rule.pattern === undefined) return;
    const regex = compilePattern(rule.pattern);
    const test = (node: Node, text: string) => {
      const count = countMatches(text, regex);
      if (count) report(i, text, { path: doc.pathOf(node), key: false }, count);
    };
    if (rule.path === undefined) {
      for (const n of doc.nodes()) if (n.t === 'n' && isNumber(doc.text, n)) test(n, doc.text.slice(n.start, n.end));
      return;
    }
    if (!reachesHere(rule, call)) return;
    for (const place of doc.places(parsePath(rule.path))) {
      const leaf = doc.at(place);
      if (leaf.t === 'n' ? isNumber(doc.text, leaf) : leaf.t !== 's') test(leaf, leaf.t === 'n' ? doc.text.slice(leaf.start, leaf.end) : JSON.stringify(doc.valueOf(leaf)));
    }
  });
}

/** A number, not true, false or null: those hold nothing to mask. */
const isNumber = (text: string, n: Scalar) => {
  const c = text.charCodeAt(n.start);
  return c === 0x2d || (c >= 0x30 && c <= 0x39);
};
