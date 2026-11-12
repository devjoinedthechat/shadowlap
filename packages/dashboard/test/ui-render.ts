import { createRequire } from 'node:module';
import { act, createContext, type ReactElement } from 'react';
import { vi } from 'vitest';

/**
 * Renders the dashboard's components in Node, with effects, state and events, and no DOM library:
 * React's own reconciler (react-reconciler, a development dependency here, at the version the
 * terminal UI's Ink uses) draws into a tree of plain elements that answer
 * what the components and the shell ask of the DOM: focus and the element that has it, the
 * selectors they query, contains and closest. Events go to the props that take them and bubble as
 * in a browser, then to the document's and the window's listeners. Tab, unless a listener prevented
 * it, moves the focus to the next element that takes it, as a browser does. Enough to see a
 * component wired as the page wires it: that Tab stays in a dialog, that typing in the palette asks
 * the server. Not a browser: no layout, no styles, no default actions but Tab's.
 */

type Child = FakeElement | FakeText;
type Listener = (e: FakeEvent) => void;

export class FakeText {
  parentNode: FakeElement | null = null;
  constructor(public data: string) {}
  get textContent(): string {
    return this.data;
  }
}

/** Elements that take the focus, and Tab, without a tabindex. */
const NATURAL = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);

export class FakeElement {
  /** An element's, as react-dom's createPortal checks of the element a dialog is drawn into. */
  readonly nodeType = 1;
  parentNode: FakeElement | null = null;
  readonly childNodes: Child[] = [];
  readonly attributes = new Map<string, string>();
  /** The props React last gave it: its handlers among them. */
  props: Record<string, unknown> = {};
  value = '';
  checked = false;
  private readonly listeners = new Map<string, Set<Listener>>();
  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {}

  get children(): FakeElement[] {
    return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement);
  }
  get textContent(): string {
    return this.childNodes.map((n) => n.textContent).join('');
  }
  get className(): string {
    return this.attributes.get('class') ?? '';
  }
  /** Its `data-*` attributes by their names in camelCase, read and set as a page does (`data-tip` is `dataset.tip`). */
  get dataset(): Record<string, string | undefined> {
    const name = (k: string | symbol) => (typeof k === 'string' ? `data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}` : null);
    return new Proxy({}, {
      get: (_, k) => {
        const n = name(k);
        return n === null ? undefined : this.attributes.get(n);
      },
      set: (_, k, v) => {
        const n = name(k);
        if (n !== null) this.attributes.set(n, String(v));
        return true;
      },
    });
  }
  /** No layout here: every box sits at 0, 0 with no size (`clientWidth` below too), and nothing scrolls. */
  scrollLeft = 0;
  scrollTop = 0;
  readonly clientHeight = 0;
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number; x: number; y: number } {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
  }
  /** The classes, as the shell marks the page's body with a state (`is-offline`, `is-expired`). */
  get classList(): { add(c: string): void; remove(c: string): void; toggle(c: string, on?: boolean): boolean; contains(c: string): boolean } {
    const list = () => this.className.split(/\s+/).filter(Boolean);
    const write = (classes: string[]) => this.attributes.set('class', classes.join(' '));
    return {
      add: (c) => write([...new Set([...list(), c])]),
      remove: (c) => write(list().filter((x) => x !== c)),
      toggle: (c, on) => {
        const now = on ?? !list().includes(c);
        write(now ? [...new Set([...list(), c])] : list().filter((x) => x !== c));
        return now;
      },
      contains: (c) => list().includes(c),
    };
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: unknown): void {
    this.attributes.set(name, String(value));
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  getAttributeNames(): string[] {
    return [...this.attributes.keys()];
  }
  get tabIndex(): number {
    const t = this.attributes.get('tabindex');
    if (t !== undefined) return Number(t);
    return NATURAL.has(this.tagName) || (this.tagName === 'A' && this.attributes.has('href')) ? 0 : -1;
  }
  set tabIndex(n: number) {
    this.attributes.set('tabindex', String(n));
  }
  get disabled(): boolean {
    return this.attributes.has('disabled');
  }
  get id(): string {
    return this.attributes.get('id') ?? '';
  }
  get isConnected(): boolean {
    for (let n: FakeElement | null = this; n; n = n.parentNode) if (n === this.ownerDocument.body) return true;
    return false;
  }
  /** Takes the focus when a browser would let it: a control, a link, or anything with a tabindex. */
  focus(): void {
    if (!this.isConnected || this.disabled) return;
    if (!this.attributes.has('tabindex') && this.tabIndex < 0) return;
    this.ownerDocument.activeElement = this;
  }
  blur(): void {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
  }
  contains(other: unknown): boolean {
    for (let n = other as FakeElement | FakeText | null; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  matches(selector: string): boolean {
    return parseSelector(selector).some((chain) => matchNested(this, chain));
  }
  closest(selector: string): FakeElement | null {
    for (let n: FakeElement | null = this; n; n = n.parentNode) if (n.matches(selector)) return n;
    return null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const list = parseSelector(selector);
    const out: FakeElement[] = [];
    walk(this, (el) => {
      if (el !== this && list.some((chain) => matchNested(el, chain))) out.push(el);
    });
    return out;
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  /** No styles and no layout: a style set is kept nowhere, and every size is 0. */
  readonly style = { setProperty: (): void => undefined, removeProperty: (): string => '', getPropertyValue: (): string => '' };
  readonly offsetWidth = 0;
  readonly offsetHeight = 0;
  readonly clientWidth = 0;
  /** Laid out when it is in the page: there is no layout here. */
  getClientRects(): object[] {
    return this.isConnected ? [{}] : [];
  }
  scrollIntoView(): void {}
  select(): void {}
  /** A click the page sends itself: it and what holds it hear it, as a browser's do. */
  click(): void {
    this.ownerDocument.sent?.(this, 'click');
  }
  setSelectionRange(): void {}
  addEventListener(type: string, fn: Listener): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }
  /** The listeners added for `type`, as the document's and the window's hear an event last. */
  heard(type: string): Listener[] {
    return [...(this.listeners.get(type) ?? [])];
  }
}

export class FakeInput extends FakeElement {}
export class FakeTextArea extends FakeElement {}

export class FakeDocument {
  readonly documentElement: FakeElement;
  readonly body: FakeElement;
  activeElement: FakeElement;
  /** How an element sends an event of its own (`click()`), once it is in a page. */
  sent: ((el: FakeElement, type: string) => void) | null = null;
  /** Listeners the page adds to the document itself. */
  private readonly own: FakeElement;
  /** Those it adds for the capture phase, which hear an event before anything in the page does. */
  private readonly capturing: FakeElement;
  constructor() {
    this.documentElement = new FakeElement('HTML', this);
    this.body = new FakeElement('BODY', this);
    this.activeElement = this.body;
    this.own = new FakeElement('#document', this);
    this.capturing = new FakeElement('#document', this);
  }
  createElement(tag: string): FakeElement {
    return make(tag, this);
  }
  querySelectorAll(selector: string): FakeElement[] {
    return [...(this.body.matches(selector) ? [this.body] : []), ...this.body.querySelectorAll(selector)];
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  addEventListener(type: string, fn: Listener, options?: boolean | { capture?: boolean; passive?: boolean }): void {
    (isCapture(options) ? this.capturing : this.own).addEventListener(type, fn);
  }
  removeEventListener(type: string, fn: Listener, options?: boolean | { capture?: boolean }): void {
    (isCapture(options) ? this.capturing : this.own).removeEventListener(type, fn);
  }
  heard(type: string): Listener[] {
    return this.own.heard(type);
  }
  /** The listeners added for `type`'s capture phase, as the document hears an event first. */
  heardFirst(type: string): Listener[] {
    return this.capturing.heard(type);
  }
}

const isCapture = (options: boolean | { capture?: boolean } | undefined): boolean => options === true || (typeof options === 'object' && options.capture === true);

function make(tag: string, doc: FakeDocument): FakeElement {
  const t = tag.toUpperCase();
  return t === 'INPUT' ? new FakeInput(t, doc) : t === 'TEXTAREA' ? new FakeTextArea(t, doc) : new FakeElement(t, doc);
}

function walk(el: FakeElement, visit: (el: FakeElement) => void): void {
  visit(el);
  for (const c of el.children) walk(c, visit);
}

// ---- selectors: tags, classes, ids, attributes and :not() of those, one inside another or
// directly inside (`>`), in lists. Nothing else: anything more is refused rather than matched wrongly.

interface Compound {
  tag: string | null;
  classes: string[];
  ids: string[];
  attrs: Array<{ name: string; value: string | null }>;
  nots: Compound[];
  /** `:focus-visible`: here, the element that has the focus, as a key moves it. */
  focused: boolean;
  /** Written after `>`: directly inside the one before it. */
  child: boolean;
}

/** `s` cut where `at` says, outside brackets and parentheses. */
function splitTop(s: string, at: (ch: string) => boolean): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (depth === 0 && at(ch)) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

function parseCompound(s: string): Compound {
  const c: Compound = { tag: null, classes: [], ids: [], attrs: [], nots: [], focused: false, child: false };
  let i = 0;
  const tag = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(s);
  if (tag) {
    c.tag = tag[0].toUpperCase();
    i = tag[0].length;
  }
  while (i < s.length) {
    const rest = s.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^\.([\w-]+)/.exec(rest))) c.classes.push(m[1]);
    else if ((m = /^#([\w-]+)/.exec(rest))) c.ids.push(m[1]);
    else if ((m = /^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([\w-]+)))?\]/.exec(rest))) c.attrs.push({ name: m[1], value: m[2] ?? m[3] ?? m[4] ?? null });
    else if ((m = /^:not\(([^()]*)\)/.exec(rest))) c.nots.push(parseCompound(m[1].trim()));
    else if ((m = /^:focus-visible/.exec(rest))) c.focused = true;
    else throw new Error(`the test renderer reads no selector like "${s}"`);
    i += m[0].length;
  }
  return c;
}

/** One selector of a list, as the compounds it nests. */
function parseChain(one: string): Compound[] {
  const chain: Compound[] = [];
  let child = false;
  for (const part of splitTop(one, (ch) => /\s/.test(ch))) {
    if (part === '>') child = true;
    else {
      chain.push({ ...parseCompound(part), child });
      child = false;
    }
  }
  return chain;
}

/** Each selector of a list, as the compounds it nests, outermost first. */
const parsed = new Map<string, Compound[][]>();
function parseSelector(selector: string): Compound[][] {
  let list = parsed.get(selector);
  if (!list) parsed.set(selector, (list = splitTop(selector, (ch) => ch === ',').map(parseChain)));
  return list;
}

function matchCompound(el: FakeElement, c: Compound): boolean {
  if (c.tag && el.tagName !== c.tag) return false;
  const classes = el.className.split(/\s+/);
  if (!c.classes.every((x) => classes.includes(x))) return false;
  if (!c.ids.every((x) => el.getAttribute('id') === x)) return false;
  if (!c.attrs.every((a) => el.hasAttribute(a.name) && (a.value === null || el.getAttribute(a.name) === a.value))) return false;
  if (c.focused && el.ownerDocument.activeElement !== el) return false;
  return !c.nots.some((n) => matchCompound(el, n));
}

/** Whether `el` is what the last compound says, inside what each one before it says. */
function matchNested(el: FakeElement, chain: Compound[], at = chain.length - 1): boolean {
  const c = chain[at];
  if (!matchCompound(el, c)) return false;
  if (at === 0) return true;
  if (c.child) return !!el.parentNode && matchNested(el.parentNode, chain, at - 1);
  for (let n = el.parentNode; n; n = n.parentNode) if (matchNested(n, chain, at - 1)) return true;
  return false;
}

// ---- props as attributes, as React DOM sets them

const RENAMED: Record<string, string> = { className: 'class', htmlFor: 'for', tabIndex: 'tabindex', spellCheck: 'spellcheck', autoComplete: 'autocomplete', readOnly: 'readonly' };
const BOOLEAN = new Set(['disabled', 'hidden', 'readonly', 'required', 'multiple', 'open']);
const SKIPPED = new Set(['children', 'key', 'ref', 'style', 'dangerouslySetInnerHTML', 'suppressHydrationWarning', 'suppressContentEditableWarning', 'autoFocus', 'defaultValue', 'defaultChecked']);

function setProps(el: FakeElement, props: Record<string, unknown>, before: Record<string, unknown> = {}): void {
  for (const key of Object.keys(before)) if (!(key in props)) setProp(el, key, undefined);
  for (const [key, value] of Object.entries(props)) if (before[key] !== value || !(key in before)) setProp(el, key, value);
  el.props = props;
}

function setProp(el: FakeElement, key: string, value: unknown): void {
  if (SKIPPED.has(key) || /^on[A-Z]/.test(key)) return;
  if (key === 'value') {
    el.value = value === undefined || value === null ? '' : String(value);
    return;
  }
  if (key === 'checked') {
    el.checked = value === true;
    return;
  }
  const name = RENAMED[key] ?? key;
  if (value === undefined || value === null || (BOOLEAN.has(name) && value === false)) {
    el.removeAttribute(name);
    return;
  }
  if (BOOLEAN.has(name)) el.setAttribute(name, '');
  else if (typeof value === 'boolean' && !name.startsWith('aria-') && !name.startsWith('data-')) {
    if (value) el.setAttribute(name, '');
    else el.removeAttribute(name);
  } else if (typeof value !== 'function') el.setAttribute(name, value);
}

// ---- the reconciler

interface Reconciler {
  createContainer(...args: unknown[]): unknown;
  updateContainer(element: ReactElement | null, root: unknown, parent: null, callback: null): void;
}

const require = createRequire(import.meta.url);
const createReconciler = require('react-reconciler') as (config: object) => Reconciler;
const constants = require('react-reconciler/constants') as { DefaultEventPriority: number; NoEventPriority: number; ConcurrentRoot: number };

let priority = constants.NoEventPriority;
/** The host context: nothing a component's place in the tree changes here. */
const HOST = {};

function appendChild(parent: FakeElement, child: Child): void {
  if (child.parentNode) removeChild(child.parentNode, child);
  parent.childNodes.push(child);
  child.parentNode = parent;
}
function insertBefore(parent: FakeElement, child: Child, before: Child): void {
  if (child.parentNode) removeChild(child.parentNode, child);
  const at = parent.childNodes.indexOf(before);
  parent.childNodes.splice(at < 0 ? parent.childNodes.length : at, 0, child);
  child.parentNode = parent;
}
function removeChild(parent: FakeElement, child: Child): void {
  const at = parent.childNodes.indexOf(child);
  if (at >= 0) parent.childNodes.splice(at, 1);
  child.parentNode = null;
  // An element taken out of the page with the focus in it leaves the focus on the page's body.
  const doc = parent.ownerDocument;
  if (child instanceof FakeElement && child.contains(doc.activeElement)) doc.activeElement = doc.body;
}

const reconciler = createReconciler({
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,
  supportsMicrotasks: true,
  scheduleMicrotask: queueMicrotask,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,
  getRootHostContext: () => HOST,
  getChildHostContext: (parent: unknown) => parent,
  getPublicInstance: (instance: unknown) => instance,
  prepareForCommit: () => null,
  resetAfterCommit: () => undefined,
  preparePortalMount: () => undefined,
  shouldSetTextContent: () => false,
  createInstance(type: string, props: Record<string, unknown>, root: FakeElement) {
    const el = make(type, root.ownerDocument);
    setProps(el, props);
    return el;
  },
  createTextInstance: (text: string) => new FakeText(text),
  appendInitialChild: appendChild,
  appendChild,
  appendChildToContainer: appendChild,
  insertBefore,
  insertInContainerBefore: insertBefore,
  removeChild,
  removeChildFromContainer: removeChild,
  // autoFocus, as React DOM does it: once the element is in the page.
  finalizeInitialChildren: (_el: FakeElement, _type: string, props: Record<string, unknown>) => props.autoFocus === true,
  commitMount: (el: FakeElement) => el.focus(),
  commitUpdate(el: FakeElement, _type: string, before: Record<string, unknown>, after: Record<string, unknown>) {
    setProps(el, after, before);
  },
  commitTextUpdate(text: FakeText, _before: string, after: string) {
    text.data = after;
  },
  resetTextContent: () => undefined,
  clearContainer: (root: FakeElement) => {
    for (const c of [...root.childNodes]) removeChild(root, c);
  },
  hideInstance: (el: FakeElement) => el.setAttribute('hidden', ''),
  unhideInstance: (el: FakeElement) => el.removeAttribute('hidden'),
  hideTextInstance: () => undefined,
  unhideTextInstance: () => undefined,
  detachDeletedInstance: () => undefined,
  beforeActiveInstanceBlur: () => undefined,
  afterActiveInstanceBlur: () => undefined,
  prepareScopeUpdate: () => undefined,
  getInstanceFromScope: () => null,
  getInstanceFromNode: () => null,
  setCurrentUpdatePriority: (p: number) => {
    priority = p;
  },
  getCurrentUpdatePriority: () => priority,
  resolveUpdatePriority: () => (priority !== constants.NoEventPriority ? priority : constants.DefaultEventPriority),
  maySuspendCommit: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: () => undefined,
  suspendInstance: () => undefined,
  waitForCommitToBeReady: () => null,
  NotPendingTransition: null,
  HostTransitionContext: createContext(null),
  resetFormInstance: () => undefined,
  requestPostPaintCallback: () => undefined,
  shouldAttemptEagerTransition: () => false,
  trackSchedulerEvent: () => undefined,
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1.1,
  rendererPackageName: 'shadowlap-test-renderer',
  rendererVersion: '0.0.0',
});

// ---- events

export interface FakeEvent {
  type: string;
  target: FakeElement;
  currentTarget: FakeElement | null;
  key?: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  button: number;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  nativeEvent: FakeEvent;
}

/** React's prop for each event type it hears. */
const HANDLER: Record<string, string> = { click: 'onClick', mousedown: 'onMouseDown', mouseup: 'onMouseUp', mousemove: 'onMouseMove', pointerenter: 'onPointerEnter', keydown: 'onKeyDown', input: 'onChange', change: 'onChange', focusin: 'onFocus', focusout: 'onBlur', drop: 'onDrop' };

function dispatch(doc: FakeDocument, win: FakeWindow, target: FakeElement, type: string, init: Partial<FakeEvent>): FakeEvent {
  let stopped = false;
  const e = {
    type,
    target,
    currentTarget: null,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    button: 0,
    defaultPrevented: false,
    ...init,
    preventDefault() {
      e.defaultPrevented = true;
    },
    stopPropagation() {
      stopped = true;
    },
  } as FakeEvent;
  e.nativeEvent = e;
  const prop = HANDLER[type];
  for (const fn of doc.heardFirst(type)) if (!stopped) fn(e);
  for (let n: FakeElement | null = target; n && !stopped; n = n.parentNode) {
    const fn = prop ? n.props[prop] : undefined;
    if (typeof fn === 'function') {
      e.currentTarget = n;
      (fn as (e: FakeEvent) => void)(e);
    }
  }
  for (const fn of stopped ? [] : doc.heard(type)) fn(e);
  for (const fn of stopped ? [] : win.heard(type)) fn(e);
  return e;
}

class FakeWindow {
  private readonly listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, fn: Listener): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }
  heard(type: string): Listener[] {
    return [...(this.listeners.get(type) ?? [])];
  }
  /** An event the page sends itself (the router's, when it rewrites the address): its listeners hear it. */
  dispatchEvent(e: { type: string }): boolean {
    for (const fn of this.heard(e.type)) fn(e as FakeEvent);
    return true;
  }
}

/** The elements Tab steps through, in the page's order: what takes the focus with a tabindex of 0 or more. */
function tabStops(doc: FakeDocument): FakeElement[] {
  const out: FakeElement[] = [];
  walk(doc.body, (el) => {
    if (el !== doc.body && el.tabIndex >= 0 && !el.disabled && !el.closest('[inert]') && !el.closest('[hidden]')) out.push(el);
  });
  return out;
}

export interface Rendered {
  document: FakeDocument;
  /** The focused element, or the page's body. */
  focused(): FakeElement;
  /** The elements the selector matches in the page. */
  all(selector: string): FakeElement[];
  /** The one element the selector matches; throws on none or several. */
  one(selector: string): FakeElement;
  /** The element whose text is `text`, among those the selector matches. */
  byText(selector: string, text: string): FakeElement;
  /** A click on it: the press, the focus it moves, the release and the click, as a browser sends them. */
  click(el: FakeElement): Promise<void>;
  /** One event on it, as a browser sends it: a press that ends elsewhere, the pointer coming over it. It and what holds it hear it, then the document and the window. */
  fire(el: FakeElement, type: string, init?: Partial<FakeEvent> & { pointerType?: string; clientX?: number; relatedTarget?: FakeElement | null }): Promise<FakeEvent>;
  /** The pointer moving onto it from outside the page, as a mouse's or a finger's does: it and what holds it hear pointerenter. */
  hover(el: FakeElement): Promise<void>;
  /** The focus moving to it, as Tab or a screen reader moves it: it and what holds it hear focusin. */
  focus(el: FakeElement): Promise<void>;
  /** A key pressed where the focus is (or on `el`), heard as the page hears it. Tab moves the focus unless something prevented it. */
  press(key: string, mods?: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }, el?: FakeElement): Promise<FakeEvent>;
  /** Types `text` into a field, as one change. */
  type(el: FakeElement, text: string): Promise<void>;
  /** Lets timers and answers run for `ms`, the page redrawing as they land: on fake timers (vi.useFakeTimers), `ms` of the test's clock. */
  wait(ms: number): Promise<void>;
  /** Lets timers and answers run until `done` holds, 5 s at most (then it throws, saying `what`): of the test's clock, on fake timers. */
  until(what: string, done: () => boolean): Promise<void>;
  unmount(): Promise<void>;
}

const g = globalThis as Record<string, unknown>;

/** Renders `element` into a page of its own. The globals the components read (document, window and the element classes) are this page's until `unmount`. */
export async function render(element: ReactElement): Promise<Rendered> {
  const doc = new FakeDocument();
  const win = new FakeWindow();
  doc.sent = (el, type) => void dispatch(doc, win, el, type, {});
  const names = ['document', 'window', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const saved = new Map(names.map((n) => [n, Object.getOwnPropertyDescriptor(g, n)]));
  Object.assign(g, { document: doc, window: win, HTMLElement: FakeElement, HTMLInputElement: FakeInput, HTMLTextAreaElement: FakeTextArea, IS_REACT_ACT_ENVIRONMENT: true });
  const errors: unknown[] = [];
  const root = reconciler.createContainer(doc.body, constants.ConcurrentRoot, null, false, null, 't', (err: unknown) => errors.push(err), () => undefined, () => undefined, () => undefined);
  await act(async () => reconciler.updateContainer(element, root, null, null));
  const check = () => {
    if (errors.length) throw errors[0];
  };
  check();
  const all = (selector: string) => doc.querySelectorAll(selector);
  const r: Rendered = {
    document: doc,
    focused: () => doc.activeElement,
    all,
    one(selector) {
      const found = all(selector);
      if (found.length !== 1) throw new Error(`${found.length} elements match ${selector}`);
      return found[0];
    },
    byText(selector, text) {
      const found = all(selector).filter((el) => el.textContent.trim() === text);
      if (found.length !== 1) throw new Error(`${found.length} of ${selector} say "${text}"`);
      return found[0];
    },
    async click(el) {
      await act(async () => {
        dispatch(doc, win, el, 'mousedown', {});
        el.focus();
        dispatch(doc, win, el, 'mouseup', {});
        dispatch(doc, win, el, 'click', {});
      });
      check();
    },
    async fire(el, type, init = {}) {
      let e!: FakeEvent;
      await act(async () => {
        e = dispatch(doc, win, el, type, init);
      });
      check();
      return e;
    },
    async hover(el) {
      await act(async () => {
        dispatch(doc, win, el, 'pointerenter', {});
      });
      check();
    },
    async focus(el) {
      await act(async () => {
        el.focus();
        dispatch(doc, win, el, 'focusin', {});
      });
      check();
    },
    async press(key, mods = {}, el) {
      let e!: FakeEvent;
      // The handlers first, and what they set drawn, as React draws a key's updates before the
      // browser's own step: a menu Tab closes hands the focus back to its button before Tab moves on.
      await act(async () => {
        e = dispatch(doc, win, el ?? doc.activeElement, 'keydown', { key, ...mods });
      });
      if (key === 'Tab' && !e.defaultPrevented) {
        await act(async () => {
          // From where the focus is in the page, as a browser steps: the next stop after it (the
          // one before it for Shift+Tab), though the element with the focus is no stop itself.
          const order = new Map<FakeElement, number>();
          walk(doc.body, (x) => void order.set(x, order.size));
          const here = order.get(doc.activeElement) ?? 0;
          const stops = tabStops(doc);
          const next = mods.shiftKey ? ([...stops].reverse().find((x) => order.get(x)! < here) ?? stops.at(-1)) : (stops.find((x) => order.get(x)! > here) ?? stops[0]);
          next?.focus();
        });
      }
      check();
      return e;
    },
    async type(el, text) {
      await act(async () => {
        el.value = text;
        dispatch(doc, win, el, 'input', {});
      });
      check();
    },
    async wait(ms) {
      await act(async () => {
        // On fake timers the test's clock moves by `ms`, and the page's timers due by then run.
        if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(ms);
        else await new Promise((resolve) => setTimeout(resolve, ms));
      });
      check();
    },
    async until(what, done) {
      for (const end = Date.now() + 5000; !done(); ) {
        if (Date.now() > end) throw new Error(`still waiting, after 5 s, for ${what}`);
        await r.wait(20);
      }
    },
    async unmount() {
      await act(async () => reconciler.updateContainer(null, root, null, null));
      for (const [n, d] of saved) {
        if (d) Object.defineProperty(g, n, d);
        else delete g[n];
      }
    },
  };
  return r;
}

/** What an element shows: its text but a hidden element's, such as a glossary term's definition for a screen reader. */
export function shownText(el: FakeElement): string {
  return el.childNodes.map((n) => (n instanceof FakeElement ? (n.hasAttribute('hidden') ? '' : shownText(n)) : n.textContent)).join('');
}
