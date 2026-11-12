import { Fragment, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { costWords, type CostShown } from '../../../engine/src/estimates/spending.js';
import { shownMenu } from '../overlays/menu-store.js';
import { overlayOpen } from '../overlays/modal-store.js';
import { placeTip } from '../place.js';
import { heldTo, spendingNow } from '../spending.js';
import { Command, Copy } from './Copy.js';

/**
 * Hover cards: one style everywhere, a title, a line or two, coloured rows and a command. An element
 * opts in with a `data-tip` attribute (`tipText` or `tipCard`), and one layer listens for all of them,
 * so a strip of 360 cells costs one listener, not 360. A card is anchored to its element (`placeTip`),
 * never over the menu its button opened or a dialog's footer. A pointer waits 400 ms for it, and the
 * next one shows at once while one was showing; the keyboard's focus shows one at once and keeps it
 * as Tab scrolls the page to its control; a tap on a touch screen toggles one on a fact that is no
 * link or button and in no row that acts on the tap. It changes as its element's card does, and goes
 * when its element or its page does. While it shows, its element points at it with `aria-describedby`,
 * and an element with a card and no action
 * of its own takes the focus (`markTipTargets`), so what a hover shows is never only a hover's.
 */

export interface TipRow {
  label: string;
  value: string;
  /** A colour token such as `var(--o-rep)`. */
  color?: string;
}

interface Tip {
  t: string;
  /** Under the title, a line a sentence: what a mark means here and the rule it stands on, a run's about line. */
  s?: string;
  rows?: Array<[string, string, string?]>;
  /** What it runs, as `$ shadowlap …`: up to its first arguments, the whole of it in the dialog or the drawer. */
  cmd?: string;
  /** What the job it starts bills, for the line under its sentence (`TipEst`). */
  est?: TipEst;
}

/**
 * A billed job's price as its control's card holds it: the line says it with whether it starts at once
 * or asks first, worked out as the card shows from Spending as it stands then, so a change never
 * redraws a page. `form`: it opens a dialog that asks what to run; `wait`: it waits, so the amount alone.
 */
export interface TipEst extends CostShown {
  usd: number | null;
  ceiling: boolean;
  always?: string;
  per?: string;
  stops?: number;
}

/** A card with a title only, such as an icon's words. */
export function tipText(t: string): string {
  return JSON.stringify({ t } satisfies Tip);
}

/** A card with a title and rows: what a strip cell, a bar or a chart group holds; `s`, a line under the title; `cmd`, what it runs; `est`, what the job it starts bills. */
export function tipCard(t: string, rows: TipRow[], s?: string | null, cmd?: string | null, est?: TipEst | null): string {
  return JSON.stringify({ t, ...(s ? { s } : {}), rows: rows.map((r) => [r.label, r.value, r.color ?? '']), ...(cmd ? { cmd } : {}), ...(est ? { est } : {}) } satisfies Tip);
}

/** A billed job's line on its card, as Spending stands now: until the threshold is known, the amount alone. Null for one that bills nothing and asks nothing. */
export function tipCostLine(est: TipEst): string | null {
  return costWords(est, heldTo(), { form: !!est.form, wait: !!est.wait || spendingNow() === undefined });
}

function read(el: Element): Tip | null {
  const raw = el.getAttribute('data-tip');
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Tip;
    return typeof v.t === 'string' ? v : null;
  } catch {
    return { t: raw };
  }
}

/** A clause of a definition that fits a card's line at the size it sets. */
const CLAUSE = 64;

/**
 * A definition cut at its clauses and asides, each kept whole where a line holds it, so it breaks
 * between them; one with a longer clause flows as written (null).
 */
export function tipClauses(text: string): string[] | null {
  const clauses: string[] = [];
  // The split keeps what it cuts at, every other piece: a clause's stop stays with its clause.
  text.split(/([,:;.)] | (?=\())/).forEach((part, i) => clauses.push(i % 2 ? `${clauses.pop() ?? ''}${part.trim()}` : part));
  return clauses.length > 1 && clauses.every((c) => c.length <= CLAUSE) ? clauses : null;
}

/**
 * A long command on a card up to its first arguments, ending on …: the whole of it is in the dialog
 * the button asks in, or the drawer of the job it starts. What a card quotes with no `$` stays whole.
 */
export function tipCmd(c: string): string {
  if (!c.startsWith('$ ') || c.length <= 64) return c;
  const parts = c.slice(2).match(/[^\s'"]*(?:'[^']*'|"[^"]*")\S*|\S+/g) ?? [];
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (out.length > 2 && `${out.join(' ')} ${part}`.length > 48) break;
    out.push(part);
    const next = parts[i + 1];
    if (/^--?[a-z]/.test(part) && next && !next.startsWith('--') && `${out.join(' ')} ${next}`.length <= 56) {
      out.push(next);
      i++;
    }
  }
  return `$ ${out.join(' ')}${out.length < parts.length ? ' …' : ''}`;
}

/** Past this, a row's label and value stack: its value under its words. */
const STACKED = 46;

function Line({ text, term }: { text: string; term: boolean }) {
  const clauses = term ? tipClauses(text) : null;
  if (clauses)
    return (
      <span className="ts">
        {/* The space goes between them: inside an inline block it would collapse, and two on a line would touch. */}
        {clauses.map((c, i) => (
          <Fragment key={i}>
            {i ? ' ' : null}
            <span className="tcl">{c}</span>
          </Fragment>
        ))}
      </span>
    );
  if (term) return <span className="ts">{text}</span>;
  return (
    <Copy as="span" className="ts" phrases>
      {text}
    </Copy>
  );
}

/** The single key a card's control answers to, while single-key shortcuts leave it marked: a chord (⌘K) shows none. */
function singleKeyOf(el: Element | undefined): string | null {
  const k = el?.getAttribute('aria-keyshortcuts');
  return k && !k.includes('+') ? k : null;
}

function Body({ d, term, shortcutKey }: { d: Tip; term: boolean; shortcutKey: string | null }) {
  const cmd = d.cmd ?? (d.s?.startsWith('$ ') ? d.s : null);
  const lines = d.s && d.s !== cmd ? d.s.split('\n') : [];
  const cost = d.est ? tipCostLine(d.est) : null;
  return (
    <>
      <b>
        {d.t}
        {shortcutKey ? <span className="kbd">{shortcutKey}</span> : null}
      </b>
      {lines.map((line, i) => (
        <Line key={i} text={line} term={term} />
      ))}
      {cost ? <span className="tc">{cost}</span> : null}
      {(d.rows ?? []).map(([label, value, color], i) => (
        <div key={i} className={label.length + value.length > STACKED ? 'stk' : undefined}>
          <i style={color ? { background: color } : undefined} />
          {label}
          <em>{value}</em>
        </div>
      ))}
      {cmd?.startsWith('$ ') ? <Command cmd={tipCmd(cmd).slice(2)} inline prompt /> : cmd ? <code>{cmd}</code> : null}
    </>
  );
}

// ---- what shows: one card, whatever asked for it

type By = 'pointer' | 'focus' | 'tap';

interface Shown {
  el: HTMLElement;
  /** What points at the card: its element, or the control in it that has the focus (a link in a line). */
  describes: HTMLElement;
  d: Tip;
  /** The element's `data-tip` as it was read, so a change to it is seen (`reread`). */
  raw: string | null;
  by: By;
  /** Where the pointer came onto a wide row, which the card starts near. */
  x: number | null;
}

let shown: Shown | null = null;
/** An element waiting out the pointer's 400 ms. */
let next: Element | null = null;
let wait: ReturnType<typeof setTimeout> | undefined;
/** When a card last went: the next one shows at once for half a second. */
let wentAt = 0;
const listeners = new Set<() => void>();

const ID = 'tip';
const WAIT_MS = 400;
const WARM_MS = 500;

function tell(): void {
  for (const fn of [...listeners]) fn();
}

/** Points an element at the card, beside what it is described by already (a term's definition). */
function describe(el: HTMLElement): void {
  const had = el.getAttribute('aria-describedby');
  if (!had?.split(' ').includes(ID)) el.setAttribute('aria-describedby', had ? `${had} ${ID}` : ID);
}

function undescribe(el: HTMLElement): void {
  const rest = (el.getAttribute('aria-describedby') ?? '').split(' ').filter((x) => x && x !== ID);
  if (rest.length) el.setAttribute('aria-describedby', rest.join(' '));
  else el.removeAttribute('aria-describedby');
}

function show(el: HTMLElement, x: number | null, by: By, describes = el): void {
  // An open menu is never covered by the card of the button that opened it.
  const menu = shownMenu();
  const d = el.isConnected && !(menu && !menu.root.contains(el)) ? read(el) : null;
  if (!d) return;
  if (shown && shown.describes !== describes) undescribe(shown.describes);
  describe(describes);
  shown = { el, describes, d, raw: el.getAttribute('data-tip'), by, x };
  tell();
}

/**
 * The card that shows, read again from its element. One whose element's card changed while it showed is
 * redrawn: a price that came after the card did, as a run's estimates can on a busy machine, which
 * would otherwise never show on it. One whose element has no card any more goes.
 */
function reread(): void {
  if (!shown) return;
  const raw = shown.el.getAttribute('data-tip');
  if (raw === shown.raw) return;
  const d = read(shown.el);
  if (!d) return hideTip();
  shown = { ...shown, d, raw };
  tell();
}

/** Whether a card shows. */
export const tipShowing = (): boolean => shown !== null;

/** Hides the card, and any on its way; the next one shows at once for a moment. */
export function hideTip(): void {
  clearTimeout(wait);
  next = null;
  if (!shown) return;
  wentAt = Date.now();
  undescribe(shown.describes);
  shown = null;
  tell();
}

// ---- what takes the focus

/** Where the row or the chart is the one stop: a mark in it takes no focus of its own. */
const NO_STOP = 'tr, [role="row"], .groups, .cbars, .tl-row, .pips';

/** What a card says, for a mark with no words of its own to be named by. */
function tipWords(d: Tip): string {
  return [d.t, d.s, ...(d.rows ?? []).map(([label, value]) => `${label} ${value}`.trim())].filter(Boolean).join(', ');
}

/** On a mark named here, as a component's own `role="img"` is not: its name follows its card. */
const NAMED = 'data-tip-named';

/** Names a mark by its card's words as they stand; one whose card has gone is no image any more. */
function nameMark(el: HTMLElement): void {
  const d = read(el);
  if (d) {
    el.setAttribute(NAMED, '');
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', tipWords(d));
    return;
  }
  for (const a of [NAMED, 'role', 'aria-label']) el.removeAttribute(a);
}

/**
 * An element with a card and no action of its own takes the focus where it stands on its own (a
 * page's facts, a lead line), unless a control in it does (a link in a line), whose focus shows the
 * card; in a row or a chart it doesn't, and one with no words of its own (an avatar, a history cell,
 * a chart's day) is an image named by its card's words, so a screen reader has them, and has them
 * anew each time this runs, as a live page changes a card in place.
 */
export function markTipTargets(root: Pick<ParentNode, 'querySelectorAll'>): void {
  for (const el of root.querySelectorAll<HTMLElement>(`[data-tip], [${NAMED}]`)) {
    if (el.hasAttribute(NAMED)) {
      nameMark(el);
      continue;
    }
    if (el.tabIndex >= 0 || el.matches('a[href], button, input, select, textarea, [tabindex], .glyph') || el.closest('a[href], button, [role="button"], [role="img"], [aria-hidden="true"]')) continue;
    if (!el.closest(NO_STOP)) {
      if (!el.querySelector('a[href], button')) el.tabIndex = 0;
      continue;
    }
    if (!el.textContent?.trim()) nameMark(el);
  }
}

// ---- where it goes

function inView(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  const v = el.closest('#view')?.getBoundingClientRect() ?? { top: 0, bottom: innerHeight };
  return r.bottom > Math.max(0, v.top) && r.top < Math.min(innerHeight, v.bottom);
}

/**
 * Places the card on what it describes. It is shown at the window's left first, where it has its whole
 * width, so it is set for the width it keeps wherever it goes, never for the room left beside the
 * last card's place.
 */
function place(tip: HTMLElement, s: Shown): void {
  tip.style.left = '8px';
  tip.style.top = '8px';
  tip.style.visibility = '';
  const menu = s.el.closest('.pop:not(.sheet)');
  const foot = s.el.closest('.dialog, .help')?.querySelector('footer');
  const at = placeTip(
    s.el.getBoundingClientRect(),
    { width: tip.offsetWidth, height: tip.offsetHeight },
    { width: innerWidth, height: innerHeight },
    { x: s.x, menu: menu?.getBoundingClientRect() ?? null, foot: foot?.getClientRects().length ? foot.getBoundingClientRect().top : null },
  );
  tip.style.left = `${at.left}px`;
  tip.style.top = `${at.top}px`;
}

// ---- what asks for it

const tipOf = (t: EventTarget | null): HTMLElement | null => (t as Element | null)?.closest?.('[data-tip]') ?? null;

function pointerOver(e: PointerEvent): void {
  if (e.pointerType === 'touch') return;
  const el = tipOf(e.target);
  if (el && (el === shown?.el || el === next)) return;
  clearTimeout(wait);
  next = null;
  const warm = shown !== null || Date.now() - wentAt < WARM_MS;
  if (shown && shown.by !== 'focus') hideTip();
  if (!el) return;
  const x = e.clientX;
  next = el;
  wait = setTimeout(
    () => {
      next = null;
      show(el, x, 'pointer');
    },
    warm ? 0 : WAIT_MS,
  );
}

function pointerOut(e: PointerEvent): void {
  if (!e.relatedTarget && shown?.by !== 'focus') hideTip();
}

function focusIn(e: FocusEvent): void {
  const t = e.target as HTMLElement | null;
  const el = tipOf(t);
  // A row in focus (j and k) is a place in its list, not a control: it shows no card.
  if (el && t?.matches(':focus-visible') && !t.hasAttribute('data-rowkey')) {
    clearTimeout(wait);
    next = null;
    show(el, null, 'focus', t);
  } else if (shown?.by === 'focus') hideTip();
}

function focusOut(e: FocusEvent): void {
  if (shown?.by === 'focus' && shown.el.contains(e.target as Node)) hideTip();
}

/** What a tap acts on, so a fact's card inside it stays away: a control, or a row that opens or selects on a click (`data-acts`). */
const ACTS = 'a[href], button, input, select, textarea, label, summary, [role="button"], [role="switch"], [data-acts]';

/** What a press found: a finger, and the card that showed, which its tap then hides. */
let pressedBy: string | null = null;
let hadCard: HTMLElement | null = null;

function pressed(e: PointerEvent): void {
  pressedBy = e.pointerType;
  hadCard = shown?.el ?? null;
}

/**
 * What a click does to a card, before the click itself acts: a click acts, and the card comes back on
 * the next move. A tap on a fact, or any click on a term, is what the card is for, unless what holds
 * the fact acts on the tap instead (`ACTS`): a term alone defines itself wherever it sits.
 */
function clicked(e: MouseEvent): void {
  const el = tipOf(e.target);
  const term = !!el?.matches('.term.on');
  if (pressedBy !== 'touch') {
    if (term) show(el!, null, 'pointer');
    else hideTip();
    return;
  }
  if (!el || (el.closest(ACTS) && !term)) return hideTip();
  if (el === hadCard) hideTip();
  else show(el, null, 'tap');
}

/** Esc hides a card in the press that closes the menu or dialog it shows over. With neither open it is the shell's Esc, after a panel and the phone's sidebar (Keyboard.tsx). */
function escape(e: KeyboardEvent): void {
  if (e.key === 'Escape' && shown && overlayOpen()) hideTip();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function HoverCardLayer() {
  const s = useSyncExternalStore(
    subscribe,
    () => shown,
    () => null,
  );
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // A scroll hides a card; one shown for the keyboard's focus moves with its control instead (Tab
    // scrolls the page to the control it reaches), hidden while the control is out of view.
    const scrolled = () => {
      const tip = ref.current;
      if (!shown) return;
      if (shown.by === 'focus' && tip && shown.el.contains(document.activeElement)) {
        if (inView(shown.el)) place(tip, shown);
        else tip.style.visibility = 'hidden';
      } else hideTip();
    };
    document.addEventListener('pointerover', pointerOver);
    document.addEventListener('pointerout', pointerOut);
    document.addEventListener('focusin', focusIn);
    document.addEventListener('focusout', focusOut);
    document.addEventListener('pointerdown', pressed, true);
    document.addEventListener('click', clicked, true);
    document.addEventListener('keydown', escape, true);
    document.addEventListener('scroll', scrolled, true);
    window.addEventListener('blur', hideTip);
    // A card belongs to the page it was shown on.
    window.addEventListener('hashchange', hideTip);
    return () => {
      document.removeEventListener('pointerover', pointerOver);
      document.removeEventListener('pointerout', pointerOut);
      document.removeEventListener('focusin', focusIn);
      document.removeEventListener('focusout', focusOut);
      document.removeEventListener('pointerdown', pressed, true);
      document.removeEventListener('click', clicked, true);
      document.removeEventListener('keydown', escape, true);
      document.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('blur', hideTip);
      window.removeEventListener('hashchange', hideTip);
      hideTip();
    };
  }, []);

  // Every element with a card takes the focus or is named by it, however it came into the page; the
  // card that shows follows its element's card as it changes, and goes once its element has left the page.
  useEffect(() => {
    if (typeof MutationObserver !== 'function') return;
    let frame = 0;
    const soon = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        markTipTargets(document.body);
        if (shown && !shown.el.isConnected) hideTip();
        else reread();
      });
    };
    soon();
    const watch = new MutationObserver(soon);
    watch.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-tip'] });
    return () => {
      cancelAnimationFrame(frame);
      watch.disconnect();
    };
  }, []);

  // Placed as it is drawn, and again as its words settle at the width they get.
  useLayoutEffect(() => {
    const tip = ref.current;
    if (!tip || !s) return;
    place(tip, s);
    if (typeof ResizeObserver !== 'function') return;
    let width = tip.offsetWidth;
    let height = tip.offsetHeight;
    const again = new ResizeObserver(() => {
      if (tip.offsetWidth === width && tip.offsetHeight === height) return;
      width = tip.offsetWidth;
      height = tip.offsetHeight;
      place(tip, s);
    });
    again.observe(tip);
    return () => again.disconnect();
  }, [s]);

  const term = !!s?.el.classList.contains('term');
  return (
    <div className={`tip${term ? ' gl' : ''}`} id={ID} ref={ref} role="tooltip" hidden={!s}>
      {s ? <Body d={s.d} term={term} shortcutKey={singleKeyOf(s.el)} /> : null}
    </div>
  );
}
