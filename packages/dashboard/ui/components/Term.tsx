import { Fragment, useId, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { GLOSSARY, glossPieces, termCard, type GlossaryTerm } from '../glossary.js';
import { Words } from './Copy.js';

/**
 * A word the glossary defines (ui/glossary.ts), defined where it first shows on a page: a dotted
 * underline, its definition in the hover card, on hover and on a tap, and named to a screen reader
 * by `aria-describedby`; it takes the focus, so the keyboard reaches it, and a tap on it defines it
 * without opening the row it sits in. Later uses on the page read as plain words. Every `Term`
 * registers with one list; once a page has drawn, and after it draws a part again, the first of
 * each word in the page's order is the one defined. A dialog, a drawer and a page (`.page`) each
 * define their own first uses, and so does any part marked `data-glossary`. A term inside a link, a
 * button, a tab, a menu item, a switch or a place with a hover card of its own is never the one
 * defined: it would hide that card or that action.
 */

/** Where a page's first uses are counted: a dialog's and a drawer's apart from the page under them. */
const SCOPE = '.dialog, .drawer, .page, [data-glossary]';
/** What a defined term can't sit in: a control, or a place whose hover card is its own. */
const SKIP = 'a, button, label, summary, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="switch"], [data-tip]';

interface Entry {
  el: HTMLElement;
  term: GlossaryTerm;
}

const entries = new Map<string, Entry>();
let defined: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
let queued = false;

/** The element and its ancestors, the page's root first. */
function path(n: Node): Node[] {
  const out: Node[] = [];
  for (let x: Node | null = n; x; x = x.parentNode) out.unshift(x);
  return out;
}

/** The page's order of two elements: negative when `a` comes first (it holds `b`, or is before it). */
function order(a: Node, b: Node): number {
  // the browser's own, where there is one (the tests' renderer has none)
  if (typeof a.compareDocumentPosition === 'function') return a.compareDocumentPosition(b) & 4 ? -1 : a === b ? 0 : 1;
  const pa = path(a);
  const pb = path(b);
  let i = 0;
  while (i < pa.length && i < pb.length && pa[i] === pb[i]) i++;
  if (i === 0) return 0;
  if (i === pa.length || i === pb.length) return pa.length - pb.length;
  const kids = Array.from(pa[i - 1]!.childNodes);
  return kids.indexOf(pa[i] as ChildNode) - kids.indexOf(pb[i] as ChildNode);
}

/**
 * Whether a term shows: in the page, laid out, and in no closed fold. A browser says so
 * (`checkVisibility`, false in a closed <details> as under `hidden` or `display: none`), since a
 * closed fold's content still has its boxes (`getClientRects`); where it can't say, a term in a
 * closed fold, its summary aside, or under the `hidden` attribute is hidden.
 */
function shows(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  if (typeof el.checkVisibility === 'function') return el.checkVisibility();
  if (el.getClientRects().length === 0) return false;
  for (let n: HTMLElement = el, up = n.parentNode as HTMLElement | null; up?.nodeType === 1; n = up, up = up.parentNode as HTMLElement | null) {
    if (up.hasAttribute('hidden') && up.getAttribute('hidden') !== 'until-found') return false;
    if (up.tagName === 'DETAILS' && !up.hasAttribute('open') && n.tagName !== 'SUMMARY') return false;
  }
  return true;
}

/** Whether a term is one that can be defined: shown, and in no control or place with a hover card of its own. */
function definable(el: HTMLElement): boolean {
  const up = el.parentNode as HTMLElement | null;
  return shows(el) && !(typeof up?.closest === 'function' && up.closest(SKIP));
}

/** The terms defined: the first of each word in each scope's order. */
function firstOfEach(): Set<string> {
  const seen = new Set<string>();
  const out = new Set<string>();
  const list = [...entries].filter(([, e]) => definable(e.el)).sort(([, a], [, b]) => order(a.el, b.el));
  for (const [id, e] of list) {
    const key = `${scopeKey(e.el.closest(SCOPE))}:${e.term}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.add(id);
  }
  return out;
}

const scopeKeys = new WeakMap<Element, number>();
let scopeCount = 0;
/** A scope by its element, the page itself (0) where none holds the term. */
function scopeKey(el: Element | null): number {
  if (!el) return 0;
  let k = scopeKeys.get(el);
  if (k === undefined) scopeKeys.set(el, (k = ++scopeCount));
  return k;
}

/** Works out which terms are defined, once the page has drawn, and tells those whose state changed. */
function settle(): void {
  queued = false;
  const next = firstOfEach();
  if (next.size === defined.size && [...next].every((id) => defined.has(id))) return;
  defined = next;
  for (const fn of listeners) fn();
}

/**
 * Works the defined terms out again once the page is done drawing: after a term mounts, goes or
 * draws again (a sorted list moves its terms without mounting them anew), and after a fold opens or
 * closes (a <details> shows or hides its terms without a draw).
 */
function schedule(): void {
  if (queued) return;
  queued = true;
  queueMicrotask(settle);
}
let folds = false;
function watchFolds(): void {
  if (folds || typeof document === 'undefined') return;
  folds = true;
  document.addEventListener('toggle', schedule, true);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Registers a term's element; the returned function lets it go. */
function register(id: string, el: HTMLElement, term: GlossaryTerm): () => void {
  entries.set(id, { el, term });
  watchFolds();
  schedule();
  return () => {
    entries.delete(id);
    schedule();
  };
}

/** A word the glossary defines, as the line writes it (`children`, the word itself by default). */
export function Term({ k, children }: { k: GlossaryTerm; children?: string }) {
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const on = useSyncExternalStore(
    subscribe,
    () => defined.has(id),
    () => false,
  );
  useLayoutEffect(() => (ref.current ? register(id, ref.current, k) : undefined), [id, k]);
  // drawn again (moved in a list, or the part around it redrawn): which use is the first may have changed
  useLayoutEffect(schedule);
  const text = children ?? k;
  const desc = `${id}-def`;
  // One shape, defined or not, so the word's element stays the one registered.
  return (
    <>
      <span
        ref={ref}
        className={on ? 'term on' : 'term'}
        data-term={k}
        tabIndex={on ? 0 : undefined}
        aria-describedby={on ? desc : undefined}
        data-tip={on ? JSON.stringify(termCard(k, text)) : undefined}
        // a tap on the word defines it and does nothing else: the row around it doesn't open
        onClick={on ? (e) => e.stopPropagation() : undefined}
      >
        {text}
      </span>
      {on ? (
        <span id={desc} hidden>
          {GLOSSARY[k]}
        </span>
      ) : null}
    </>
  );
}

/**
 * A status word, a legend or a figure's words with the glossary's terms in it marked: `glossed('lost
 * at #5')`. A line of them (`words`) has its words between the terms glued as `Words` glues them, a
 * count with its noun and a dot or an arrow with the word before it.
 */
export function glossed(text: string, words = false): ReactNode {
  return glossPieces(text).map((p, i) => <Fragment key={i}>{typeof p !== 'string' ? <Term k={p.term}>{p.text}</Term> : words ? <Words>{p}</Words> : p}</Fragment>);
}
