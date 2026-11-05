import { pageSig, samePage, trailAfter, type LinkNote, type TrailStop } from './focus.js';
import { sameRun } from './format.js';
import { controlKey, findControl, type ControlKey } from './overlays/focus-back.js';
import { openerNow, overlayOpen } from './overlays/modal-store.js';
import { knownParent } from './parents.js';
import { parseRoute, type Route } from './route.js';

/**
 * Where the focus goes as the page changes, in one place. A new page gives it to its heading, so a
 * screen reader says where you are and Tab goes on from there; a step within a page (`pageSig`)
 * leaves it where it was. What had it and is drawn anew hands it to its counterpart. Esc's way back
 * lands on the row or the link you left. A job's end hands it on from the control the job took away.
 * Nothing here ever scrolls for a move (`focusQuiet`), but for a row or a link asked for by name. A
 * plain module `useRoute` calls: nothing runs at import.
 */

export function focusQuiet(el: HTMLElement): void {
  el.focus({ preventScroll: true });
}

/** A heading takes the focus as -1: a target the page focuses, where Tab never stops. One with a Tab stop of its own keeps it. */
function takeHeading(h: HTMLElement): void {
  if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1');
  focusQuiet(h);
}

const pageHeading = () => document.querySelector<HTMLElement>('#view h1');

/** The page takes the focus: its heading, else its scrolling pane, else the region that holds it. For the skip link, and a row let go of. */
export function focusPage(): void {
  const main = document.querySelector<HTMLElement>('#view');
  if (!main) return;
  const h = pageHeading();
  if (h) return takeHeading(h);
  const pane = [...main.children].find((c): c is HTMLElement => c instanceof HTMLElement && c.classList.contains('page'));
  focusQuiet(pane ?? main);
}

/** A page's step Esc takes before going up: what the page has open, or a selection. True when it did something. Set by the page. */
export const pageUp: { current: (() => boolean) | null } = { current: null };

/** The run's selected call takes the focus; false on a view with no such row. */
export function focusCall(): boolean {
  const tr = document.querySelector<HTMLElement>('.vbody tr[aria-selected="true"]');
  if (!tr) return false;
  if (!tr.hasAttribute('tabindex')) tr.setAttribute('tabindex', '-1');
  focusQuiet(tr);
  return true;
}

/** A key moved the selection: the call it landed on takes the focus once it is drawn, a window having to bring it in first. */
let callWanted: { n: number; until: number } | null = null;

/** The wanted call, if it is drawn and selected by now. Called as the page and the table draw. A view with no such row leaves the focus where it is. */
export function claimCallFocus(): void {
  if (!callWanted) return;
  if (Date.now() > callWanted.until) {
    callWanted = null;
    return;
  }
  const tr = document.querySelector<HTMLElement>('.vbody tr[aria-selected="true"]');
  if (tr?.getAttribute('data-call') !== String(callWanted.n)) return;
  callWanted = null;
  focusCall();
}

export function wantCallFocus(n: number | null): void {
  callWanted = n === null ? null : { n, until: Date.now() + 1000 };
  claimCallFocus();
}

/** How long a page that is still coming can claim the focus: after that, the focus stays where it is. */
const PENDING_MS = 5000;

interface BackNote {
  sig: string;
  row: string | null;
  link: LinkNote | null;
}

interface Pending {
  sig: string;
  until: number;
  /** What Esc came back for, while the page may still draw it. */
  back: BackNote | null;
}

let lastHash: string | null = null;
let lastSig: string | null = null;
let how: 'up' | 'side' | null = null;
let back: BackNote | null = null;
let trail: readonly TrailStop[] = [];
let pending: Pending | null = null;
let clicked: { sig: string | null; key: string } | null = null;
let clickedLink: { sig: string | null; link: LinkNote } | null = null;
let kept: { el: HTMLElement; key: ControlKey | null; tab: string | null } | null = null;
let leaving: Element | null = null;
let rowLander: ((left: string, own: string | null) => boolean) | null = null;

/** Tells the manager how to land on a list's row: list-keys.ts, which knows the lists. */
export function landRowsWith(fn: (left: string, own: string | null) => boolean): void {
  rowLander = fn;
}

function viewLinks(to: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('#view a[href]')].filter((a) => a.getAttribute('href') === to && a.getClientRects().length > 0);
}

const inARow = (el: Element) => !!el.closest('[data-rowkey]');

/** A link takes the focus, in view: the one noted, else the first outside a list's rows that leads to the page left. */
function landLink(note: LinkNote | null, left: string): boolean {
  const noted = note ? (viewLinks(note.href)[note.i] ?? viewLinks(note.href)[0]) : null;
  const a = noted ?? [...document.querySelectorAll<HTMLElement>('#view a[href]')].find((x) => !inARow(x) && x.getClientRects().length > 0 && samePage(pageSig(parseRoute(x.getAttribute('href') ?? '')), left));
  if (!a) return false;
  focusQuiet(a);
  a.scrollIntoView?.({ block: 'center' });
  return true;
}

function landBack(b: BackNote): boolean {
  if (b.link && landLink(b.link, b.sig)) return true;
  if (rowLander?.(b.sig, b.row)) return true;
  return landLink(null, b.sig);
}

/**
 * Gives the page that has come the focus it is owed: what Esc came back for once it shows, the
 * heading meanwhile. It gives up if you moved the focus or the route moved on. Called as the route
 * draws, as a heading mounts, as a list's rows arrive and as the page changes.
 */
export function settleFocus(): void {
  const p = pending;
  if (!p) return;
  if (!samePage(p.sig, lastSig) || Date.now() > p.until) {
    pending = null;
    return;
  }
  // A menu or a dialog opened over the page has the focus; closing it hands the focus back, and that decides.
  if (overlayOpen()) return;
  const a = document.activeElement;
  const h = pageHeading();
  const free = !a || a === document.body || a === h || a === document.querySelector('#view') || !!a.closest('#menu, #layer');
  if (!free) {
    pending = null;
    return;
  }
  if (p.back && landBack(p.back)) {
    pending = null;
    return;
  }
  if (h && !h.closest('[inert]')) {
    takeHeading(h);
    if (!p.back) pending = null;
  }
}

/** A callback ref for a page's heading: a page that draws it late still gets the focus. */
export function headingRef(h: HTMLElement | null): void {
  if (h) settleFocus();
}

/** What had the focus, found again by what it is, if it was drawn anew and the focus fell with it. */
function keepFocus(): void {
  const a = document.activeElement;
  if ((a && a !== document.body) || !kept || kept.el.isConnected || !kept.key) return;
  const el = findControl(kept.key);
  if (!el) return;
  if (el.matches('#view h1')) {
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  } else if (kept.tab !== null && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', kept.tab);
  if (handOn?.had === kept.el) handOn.had = el;
  focusQuiet(el);
}

function focusIn(e: Event): void {
  const el = e.target as HTMLElement | null;
  if (el?.closest?.('#app')) kept = { el, key: controlKey(el), tab: el.getAttribute('tabindex') };
}

/** Focus you moved away yourself stays away: an element still there, the focus on nothing. */
function focusOut(e: Event): void {
  const el = e.target as HTMLElement | null;
  void Promise.resolve().then(() => {
    const a = document.activeElement;
    if (el === kept?.el && el?.isConnected && (!a || a === document.body)) kept = null;
  });
}

/** Where a click in the page came from: the row, else the link, so Esc can come back to it. */
function noteClick(e: Event): void {
  clicked = null;
  clickedLink = null;
  const t = e.target as HTMLElement | null;
  if (!t?.closest?.('#view')) return;
  const key = t.closest('[data-rowkey]')?.getAttribute('data-rowkey');
  if (key) {
    clicked = { sig: lastSig, key };
    return;
  }
  const a = t.closest<HTMLElement>('a[href]');
  const to = a?.getAttribute('href');
  if (a && to?.startsWith('#/')) clickedLink = { sig: lastSig, link: { href: to, i: viewLinks(to).indexOf(a) } };
}

let mounted = 0;
let observer: MutationObserver | null = null;

function pageChanged(): void {
  keepFocus();
  settleFocus();
  lookToHandOn();
}

/**
 * Starts following, for as long as a `useRoute` is mounted: two can be, so it counts them. The page
 * it starts on takes nothing: a first load moves no focus.
 */
export function startFocusManager(): () => void {
  if (mounted++ === 0) {
    lastHash = location.hash;
    lastSig = pageSig(parseRoute(lastHash));
    how = back = pending = clicked = clickedLink = kept = leaving = null;
    trail = [];
    document.addEventListener('focusin', focusIn);
    document.addEventListener('focusout', focusOut);
    document.addEventListener('click', noteClick, true);
    if (typeof MutationObserver === 'function') {
      observer = new MutationObserver(pageChanged);
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }
  return () => {
    if (--mounted > 0) return;
    dropHandOn();
    document.removeEventListener('focusin', focusIn);
    document.removeEventListener('focusout', focusOut);
    document.removeEventListener('click', noteClick, true);
    observer?.disconnect();
    observer = null;
  };
}

/** Whether the run `to` is above the run `from` in its family: going up it adds nothing to the way back. */
function runAbove(to: Route, from: string | null): boolean {
  if (to.page !== 'run' || !from?.startsWith('run:')) return false;
  let at = knownParent(from.slice(4));
  for (let i = 0; at && i < 100; i++, at = knownParent(at)) if (sameRun(to.id, at)) return true;
  return false;
}

/** The row you left a page on: the one clicked, else the one in focus there. */
function rowLeft(): string | null {
  if (clicked?.sig === lastSig) return clicked.key;
  const a = document.activeElement;
  const row = a?.closest?.('#view [data-rowkey]') ?? document.querySelector('#view .krow');
  return row?.getAttribute('data-rowkey') ?? null;
}

/**
 * The address changed. Called by `useRoute`'s listener, after a pasted token link's rewrite; two can
 * hear one change, and the second finds nothing new. A replace is never a move, but the page it
 * settles on is noted: a short id settling on the full one is still that run.
 */
export function routeHeard(type: string): void {
  const hash = location.hash;
  const route = parseRoute(hash);
  const sig = pageSig(route);
  const a = document.activeElement;
  leaving = a?.closest?.('#view, #menu, #layer') ? a : null;
  if (type === 'hashchange' && hash !== lastHash && !samePage(sig, lastSig)) {
    const from: TrailStop = { sig: lastSig ?? '', hash: lastHash ?? '#/', row: rowLeft(), link: clickedLink?.sig === lastSig ? clickedLink.link : null };
    trail = trailAfter(trail, { to: route, how, above: runAbove(route, lastSig), from });
    pending = { sig, until: Date.now() + PENDING_MS, back: how === 'up' ? back : null };
    dropHandOn();
    kept = null;
    leaving = null;
    const view = document.querySelector<HTMLElement>('#view');
    if (view && !view.closest('[inert]')) focusQuiet(view);
  }
  if (type === 'hashchange' && hash !== lastHash) how = back = clicked = clickedLink = null;
  lastHash = hash;
  lastSig = sig;
}

/** The route has drawn: what lost the focus with it gets it back, or the page takes it; then a new page's heading. */
export function routeDrawn(): void {
  const had = leaving;
  leaving = null;
  keepFocus();
  const a = document.activeElement;
  if (had && !had.isConnected && (!a || a === document.body)) {
    const view = document.querySelector<HTMLElement>('#view');
    if (view) focusQuiet(view);
  }
  settleFocus();
}

/** A step along a list is coming: it adds nothing to the way back. */
export function stepsSideways(): void {
  how = 'side';
}

/** Esc goes up from a detail page: where to, the way you came, else `up`, the crumbs' parent. */
export function stepBack(up: string): string {
  const from = trail.at(-1);
  trail = trail.slice(0, -1);
  how = 'up';
  back = { sig: lastSig ?? '', row: from?.row ?? null, link: from?.link ?? null };
  return from ? from.hash : up;
}

/** The part of the page a job's control sat in: its row, a section with an id, or the page's head. */
export type JobFrom = { row: string } | { section: string } | { head: true } | null;

const JOB_HEAD = '.ph, .rhead, .page-in > .verdict';

/** Where a job is starting from: what opened the dialog or menu it starts from, else what has the focus. Outside the page, nowhere. */
export function noteJobFrom(): JobFrom {
  const opener = openerNow();
  if (!opener?.closest?.('#view')) return null;
  for (let x: HTMLElement | null = opener; x && x.id !== 'view'; x = x.parentElement) {
    const row = x.getAttribute('data-rowkey');
    if (row) return { row };
    if (x.id && x.matches('section')) return { section: x.id };
    if (x.matches(JOB_HEAD)) return { head: true };
  }
  return null;
}

const pressable = (b: HTMLElement) => b.getClientRects().length > 0 && !(b as HTMLButtonElement).disabled && b.getAttribute('aria-disabled') !== 'true' && !b.closest('[inert], [hidden]');

/**
 * The step that took the control's place in that part of the page: its lime lead, else its first
 * button that can be pressed; in the page's head only its lime lead (a secondary button there is no
 * step). A row is the opener's alone: where its key names no row, or two, neither is known to be it.
 */
function jobStep(from: JobFrom): HTMLElement | null {
  if (!from) return null;
  const view = document.querySelector('#view');
  if (!view) return null;
  let parts: HTMLElement[];
  if ('row' in from) {
    const rows = [...view.querySelectorAll<HTMLElement>('[data-rowkey]')].filter((x) => x.getAttribute('data-rowkey') === from.row);
    parts = rows.length === 1 ? rows : [];
  } else if ('section' in from) parts = [...view.querySelectorAll<HTMLElement>('section[id]')].filter((x) => x.id === from.section);
  else parts = [...view.querySelectorAll<HTMLElement>(JOB_HEAD)];
  const all = parts.flatMap((x) => [...x.querySelectorAll<HTMLElement>('.btn')]).filter(pressable);
  return all.find((b) => b.classList.contains('lime')) ?? ('head' in from ? null : (all[0] ?? null));
}

/** The drawer's way on, else its log, else its first button. */
function drawerFocus(): HTMLElement | null {
  const shows = (el: HTMLElement) => el.getClientRects().length > 0 && !el.closest('[inert]');
  const drawer = document.querySelector<HTMLElement>('.drawer');
  if (!drawer) return null;
  return [...drawer.querySelectorAll<HTMLElement>('.btn.lime')].filter(pressable)[0] ?? [...drawer.querySelectorAll<HTMLElement>('pre')].find(shows) ?? [...drawer.querySelectorAll<HTMLElement>('button')].find(shows) ?? null;
}

/** Where the jobs being followed started; a closed drawer's job asks no hand-on, and goes when later ones come. */
const jobsFrom = new Map<string, JobFrom>();
const JOBS_NOTED = 32;

/** Notes where a job is starting from, by its id once the server has answered. */
export function notingJobFrom<T extends { id: string }>(p: Promise<T>): Promise<T> {
  const from = noteJobFrom();
  return p.then((job) => {
    jobsFrom.set(job.id, from);
    if (jobsFrom.size > JOBS_NOTED) jobsFrom.delete(jobsFrom.keys().next().value!);
    return job;
  });
}

/** How long after a job's end the drawer is given to say how it ended, before the first look. */
const HAND_ON_FIRST_MS = 60;
/** How long the page then has to take the control away: it reads the run again first, and a busy read pool makes that slow. */
const HAND_ON_MS = 3000;

/** A job's end being followed. `had` is what has the focus meanwhile: the control, its counterpart, or a step the focus was handed to, which a later redraw may take too. */
let handOn: { from: JobFrom; had: Element | null; looks: boolean } | null = null;
let handOnTimer: ReturnType<typeof setTimeout> | undefined;

function dropHandOn(): void {
  clearTimeout(handOnTimer);
  handOn = null;
}

/** Whether an element can still hold the focus: there, and not turned off. */
const canHold = (el: Element | null) => !!el?.isConnected && !(el as HTMLButtonElement).disabled;

/**
 * Looks at a job's end being followed: at the first look, as the page changes, and at the last look.
 * The focus fallen from a control that went is handed on; on what had it, it waits. A menu or a
 * dialog over the page, or a move of yours (the focus elsewhere, or let go of what is still there),
 * ends the wait. The drawer takes it only when no part of the page is owed it, or at the last look.
 */
function lookToHandOn(last = false): void {
  const h = handOn;
  if (!h?.looks) return;
  const a = document.activeElement;
  const fell = !a || a === document.body;
  if (overlayOpen() || (fell ? canHold(h.had) : a !== h.had)) return dropHandOn();
  if (fell) {
    const to = jobStep(h.from) ?? (h.from && !last ? null : drawerFocus());
    if (to) {
      h.had = to;
      focusQuiet(to);
    }
  }
  if (last) dropHandOn();
}

/**
 * A job has ended with its drawer open. If the control that started it goes as the page is drawn
 * anew, which may be well after the job's end, the focus goes to the step that took its place, else
 * to the drawer. Never from where you moved it, nor from under a menu or a dialog; another page ends
 * the wait.
 */
export function handOnAtEnd(jobId: string): void {
  const from = jobsFrom.get(jobId) ?? null;
  jobsFrom.delete(jobId);
  dropHandOn();
  if (!mounted) return;
  const a = document.activeElement;
  const h = { from, had: a && a !== document.body ? a : null, looks: false };
  handOn = h;
  handOnTimer = setTimeout(() => {
    h.looks = true;
    handOnTimer = setTimeout(() => lookToHandOn(true), HAND_ON_MS);
    lookToHandOn();
  }, HAND_ON_FIRST_MS);
}
