import { createRequire } from 'node:module';
import { act, createContext, type ReactElement } from 'react';

/**
 * Renders the dashboard's components in Node, with effects, state and events, and no DOM library:
 * React's own reconciler (react-reconciler, installed with the terminal UI's Ink, which
 * @shadowlap/tui and so the dashboard depend on) draws into a tree of plain elements that answer
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
  readonly clientWidth = 0;
  /** Laid out when it is in the page: there is no layout here. */
  getClientRects(): object[] {
    return this.isConnected ? [{}] : [];
  }
  scrollIntoView(): void {}
  select(): void {}
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
  readonly body: FakeElement;
  activeElement: FakeElement;
  /** Listeners the page adds to the document itself. */
  private readonly own: FakeElement;
  constructor() {
    this.body = new FakeElement('BODY', this);
    this.activeElement = this.body;
    this.own = new FakeElement('#document', this);
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
  addEventListener(type: string, fn: Listener): void {
    this.own.addEventListener(type, fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.own.removeEventListener(type, fn);
  }
  heard(type: string): Listener[] {
    return this.own.heard(type);
  }
}

function make(tag: string, doc: FakeDocument): FakeElement {
  const t = tag.toUpperCase();
  return t === 'INPUT' ? new FakeInput(t, doc) : t === 'TEXTAREA' ? new FakeTextArea(t, doc) : new FakeElement(t, doc);
}

function walk(el: FakeElement, visit: (el: FakeElement) => void): void {
  visit(el);
  for (const c of el.children) walk(c, visit);
}

// ---- selectors: tags, classes, ids, attributes and :not() of those, one inside another, in
// lists. Nothing else: anything more is refused rather than matched wrongly.

interface Compound {
  tag: string | null;
  classes: string[];
  ids: string[];
  attrs: Array<{ name: string; value: string | null }>;
  nots: Compound[];
}

/** `s` cut where `at` says, outside brackets and parentheses. */
function splitTop(s: string, at: (ch: string) => boolean): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
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
  const c: Compound = { tag: null, classes: [], ids: [], attrs: [], nots: [] };
  let i = 0;
  const tag = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(s);
  if (tag) {
    c.tag = tag[0].toUpperCase();
    i = tag[0].length;
  }
  while (i < s.length) {
    const rest = s.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^\.([\w-]+)/.exec(rest))) c.classes.push(m[1]!);
    else if ((m = /^#([\w-]+)/.exec(rest))) c.ids.push(m[1]!);
    else if ((m = /^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([\w-]+)))?\]/.exec(rest))) c.attrs.push({ name: m[1]!, value: m[2] ?? m[3] ?? m[4] ?? null });
    else if ((m = /^:not\(([^()]*)\)/.exec(rest))) c.nots.push(parseCompound(m[1]!.trim()));
    else throw new Error(`the test renderer reads no selector like "${s}"`);
    i += m[0].length;
  }
  return c;
}

/** Each selector of a list, as the compounds it nests, outermost first. */
const parsed = new Map<string, Compound[][]>();
function parseSelector(selector: string): Compound[][] {
  let list = parsed.get(selector);
  if (!list) parsed.set(selector, (list = splitTop(selector, (ch) => ch === ',').map((one) => splitTop(one, (ch) => /\s/.test(ch)).map(parseCompound))));
  return list;
}

function matchCompound(el: FakeElement, c: Compound): boolean {
  if (c.tag && el.tagName !== c.tag) return false;
  const classes = el.className.split(/\s+/);
  if (!c.classes.every((x) => classes.includes(x))) return false;
  if (!c.ids.every((x) => el.getAttribute('id') === x)) return false;
  if (!c.attrs.every((a) => el.hasAttribute(a.name) && (a.value === null || el.getAttribute(a.name) === a.value))) return false;
  return !c.nots.some((n) => matchCompound(el, n));
}

/** Whether `el` is what the last compound says, inside what each one before it says. */
function matchNested(el: FakeElement, chain: Compound[]): boolean {
  if (!matchCompound(el, chain.at(-1)!)) return false;
  let i = chain.length - 2;
  for (let n = el.parentNode; n && i >= 0; n = n.parentNode) if (matchCompound(n, chain[i]!)) i--;
  return i < 0;
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
const HANDLER: Record<string, string> = { click: 'onClick', mousedown: 'onMouseDown', mousemove: 'onMouseMove', keydown: 'onKeyDown', input: 'onChange', change: 'onChange', focusin: 'onFocus', focusout: 'onBlur' };

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
  /** A click on it. */
  click(el: FakeElement): Promise<void>;
  /** A key pressed where the focus is (or on `el`), heard as the page hears it. Tab moves the focus unless something prevented it. */
  press(key: string, mods?: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }, el?: FakeElement): Promise<FakeEvent>;
  /** Types `text` into a field, as one change. */
  type(el: FakeElement, text: string): Promise<void>;
  /** Lets timers and answers run for `ms`, the page redrawing as they land. */
  wait(ms: number): Promise<void>;
  /** Lets timers and answers run until `done` holds, 5 s at most (then it throws, saying `what`). */
  until(what: string, done: () => boolean): Promise<void>;
  unmount(): Promise<void>;
}

const g = globalThis as Record<string, unknown>;

/** Renders `element` into a page of its own. The globals the components read (document, window and the element classes) are this page's until `unmount`. */
export async function render(element: ReactElement): Promise<Rendered> {
  const doc = new FakeDocument();
  const win = new FakeWindow();
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
      return found[0]!;
    },
    byText(selector, text) {
      const found = all(selector).filter((el) => el.textContent.trim() === text);
      if (found.length !== 1) throw new Error(`${found.length} of ${selector} say "${text}"`);
      return found[0]!;
    },
    async click(el) {
      await act(async () => {
        dispatch(doc, win, el, 'mousedown', {});
        el.focus();
        dispatch(doc, win, el, 'click', {});
      });
      check();
    },
    async press(key, mods = {}, el) {
      let e!: FakeEvent;
      await act(async () => {
        e = dispatch(doc, win, el ?? doc.activeElement, 'keydown', { key, ...mods });
        if (key === 'Tab' && !e.defaultPrevented) {
          const stops = tabStops(doc);
          const at = stops.indexOf(doc.activeElement);
          const next = mods.shiftKey ? (at <= 0 ? stops.at(-1) : stops[at - 1]) : stops[(at + 1) % stops.length];
          next?.focus();
        }
      });
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
        await new Promise((resolve) => setTimeout(resolve, ms));
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
