/**
 * A run is named by its id; one quiet line says what it was about (decision 10). Where a place gives
 * that line one line (the run's header, Runs, the sidebar, the palette, the pickers, Today, the
 * Forks view, Lineage), it is fitted to the room it gets once laid out, at whole words, measured in
 * that place's font, never cut by a character count or a CSS ellipsis: the whole line if it fits,
 * else the widest of its shorter forms that does (its first words and its last, "…" for what is
 * left out), else nothing rather than part of a word. What a replay or a fork changed (`override
 * #16`) is never cut. A hint that holds a command is cut only at its end, after a whole word, so an
 * id in it is whole or left out.
 *
 * The forms and the order a place tries them in are pure functions the tests read; `fitAbouts`
 * applies them to the lines in a part of the page, and `useFitAbouts` (components/About.tsx) calls
 * it after each render, when the room changes and once the web fonts load.
 */

import type { RunAbout } from './types.js';

/**
 * Small words (two letters or fewer, articles, prepositions), amounts and what only a machine reads
 * (a UUID, a hash): a cut never ends on one ("A customer asks for a …") or starts with one ("… of
 * order A-1131"), and an amount goes only with the order number beside it ("A-1042 ($240)"), so the
 * number outlasts it.
 */
const LIGHT = /^(a|an|the|of|for|to|from|and|or|in|on|at|by|with|my|our|your|their|is|was|it|·|:|–|—|-)$/i;
const AMOUNT = /^\(?[$€£]\d[\d,.]*\)?[,.;:]?$/;

/**
 * A UUID (`d9091835-5bac-4eba-acac-0f3c19eb863d`), a hash of seven hex characters or more with a
 * letter and a digit (`7f3a9c2e`), or a ULID: an id no person reads, so it is never the number a cut
 * keeps ("New ticket T-8812 …", never "New … d9091835-…)"). Quotes and brackets around it don't count.
 */
const MACHINE_ID = /^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,}|[0-9A-HJKMNP-TV-Z]{26})$/i;
const machineId = (w: string): boolean => MACHINE_ID.test(w.replace(/^[("'[{]+|[)"'\]},.;:!?]+$/g, ''));

function light(w: string): boolean {
  const b = w.replace(/[,.;:!?()]+$/g, '');
  return LIGHT.test(b) || AMOUNT.test(w) || (b.length <= 2 && !/\d/.test(b)) || machineId(w);
}

/** A word that holds a number, an order or a ticket (`A-1042`, `T-8812`): one a cut keeps. */
const idWord = (w: string): boolean => /\d/.test(w) && !AMOUNT.test(w) && !machineId(w);

/** What a cut leaves out reads as this, kept with the word before it: no line starts with it. */
export const CUT = ' …';

/**
 * The shorter forms of an about line: its first words and its last, whole, with "…" for what is left
 * out ("A customer … order A-1131"), since runs of one prompt differ at the end. A small word never
 * starts or ends a cut, an amount goes only with the order number before it, the start never stops
 * just before an order or a ticket number, and a cut leaves out at least one word that isn't small.
 * A line that holds such a number keeps one in every form, at either end, and only then may a form
 * end on its cut, right after the number ("Ticket T-8812 …", "Hi, my order A-1042 …"). No form
 * starts with "…".
 */
export function cutForms(s: string): string[] {
  const w = s.split(' ').filter(Boolean);
  const n = w.length;
  const out: string[] = [];
  const ids = w.some(idWord);
  const heavy = (x: string) => !light(x);
  for (let h = 1; h < n; h++) {
    if (light(w[h - 1]!) || idWord(w[h]!)) continue;
    const head = w.slice(0, h);
    const hid = head.some(idWord);
    const hs = head.join(' ').replace(/[,;:]$/, '');
    for (let t = 0; h + t < n; t++) {
      const tail = w.slice(n - t);
      if (t && light(tail[0]!)) continue;
      if (!w.slice(h, n - t).some(heavy)) continue;
      if (t ? ids && !hid && !tail.some(idWord) : !idWord(w[h - 1]!)) continue;
      out.push(`${hs}${CUT}${t ? ` ${tail.join(' ')}` : ''}`);
    }
  }
  return out;
}

/** A form ends on its cut: it keeps the line's start and a number, and leaves out its end. */
const endsCut = (form: string): boolean => form.endsWith(CUT);

/**
 * The shorter forms of an import's sources, when it read several files (`shadowlap-4121.jsonl,
 * shadowlap-4122.jsonl`): its first files whole and how many more, `shadowlap-4121.jsonl and 1 more`.
 * A file's name is never cut.
 */
export function sourceForms(s: string): string[] {
  const files = s.split(', ');
  const out: string[] = [];
  for (let k = files.length - 1; k >= 1; k--) out.push(`${files.slice(0, k).join(', ')} and ${files.length - k} more`);
  return out;
}

/**
 * An about line and every shorter form of it, then nothing: with no room even for its shortest form,
 * a line gives its place up rather than show part of a word. What a replay or a fork changed, and a
 * clean replay's "clean replay", are never cut; an import of several files gives way a file at a time.
 */
export function aboutForms(about: Pick<RunAbout, 'text' | 'from'>): string[] {
  const whole = about.text;
  const cuts = about.from === 'change' || about.from === 'nothing' ? [] : about.from === 'source' && whole.includes(', ') ? sourceForms(whole) : cutForms(whole);
  const out = [whole];
  for (const c of cuts) if (!out.includes(c)) out.push(c);
  return [...out.slice(0, 1), ...out.slice(1).sort((a, b) => b.length - a.length), ''];
}

/**
 * The about line as a browser tab can hold it, which can't be measured: the longest of its forms
 * that keeps to `max` characters, one that keeps the line's end first (the mock's docTitle: "Ticket
 * T-8812 … damaged"), else null. The tab reads the id, then this: `01K5CQ6L0P · Ticket T-8812 …
 * damaged — shadowlap`.
 */
export function tabAbout(about: Pick<RunAbout, 'text' | 'from'> | null | undefined, max = 26): string | null {
  if (!about?.text) return null;
  const fit = aboutForms(about).filter((f) => f && f.length <= max);
  return fit.find((f) => !f.endsWith(CUT)) ?? fit[0] ?? null;
}

/**
 * A hint that holds a command or ids (the palette's) is cut only at its end, after a whole word, so
 * an id in it is whole or left out: "shadowlap replay …", never "shadowlap replay 01K5CQ…". A hint
 * with a short form of its own takes that instead ("against 01K5CQ4N7G" for a diff command).
 */
export function hintForms(s: string, short?: string | null): string[] {
  const w = s.split(' ');
  const out = [s];
  if (short) out.push(short);
  else for (let k = w.length - 1; k >= 1; k--) out.push(`${w.slice(0, k).join(' ').replace(/[\s,;:·]+$/, '')}${CUT}`);
  return [...out, ''];
}

export interface Form {
  t: string;
  w: number;
}

/**
 * The forms as a place tries them: the whole line, then the shorter ones widest first as `measure`
 * gives their width in that place's font, those that keep the line's end before those that stop at
 * a number ("Ticket T-8812 … arrived damaged" before "Ticket T-8812 from customer C-311 …"), then
 * nothing.
 */
export function orderForms(forms: readonly string[], measure: (text: string) => number): Form[] {
  const whole = forms[0] ?? '';
  const middle = forms
    .slice(1)
    .filter((x) => x !== '')
    .map((t) => ({ t, w: measure(t) }))
    .sort((a, b) => Number(endsCut(a.t)) - Number(endsCut(b.t)) || b.w - a.w);
  return [{ t: whole, w: measure(whole) }, ...middle, { t: '', w: 0 }];
}

/** One line to fit: its forms in the order to try them, and how to write, measure and read it. */
export interface FitLine {
  forms: readonly Form[];
  write(text: string): void;
  /** Its text is wider than its room, by any fraction of a pixel. */
  overflows(): boolean;
  /** The width its box gives its text. */
  room(): number;
}

/**
 * Fits lines to their room: every line is written whole and read once for its room; one that
 * overflows takes the widest form that fits that room. All are written, then read, then written, so
 * a fit lays the page out twice; a form that still overflows (a rounding) steps down to the next.
 */
export function fitLines(lines: readonly FitLine[]): void {
  for (const x of lines) x.write(x.forms[0]!.t);
  const open = lines.filter((x) => x.forms.length > 1 && x.overflows()).map((x) => {
    const room = x.room() - 0.25;
    let i = 1;
    while (i < x.forms.length - 1 && x.forms[i]!.w > room) i++;
    return { x, i };
  });
  let pending = open;
  for (let n = 0; pending.length && n < 8; n++) {
    for (const o of pending) o.x.write(o.x.forms[o.i]!.t);
    pending = pending.filter((o) => o.i < o.x.forms.length - 1 && o.x.overflows() && ++o.i > 0);
  }
}

// ---------------------------------------------------------------------------------------------- in the page

/** Widths per font and text: measured once, until the web fonts arrive. */
let widths = new Map<string, number>();
let pen: CanvasRenderingContext2D | null = null;

/** Forgets every width measured: the web fonts arrived, wider than the fallback they replaced. */
export function forgetWidths(): void {
  widths = new Map();
}

function measureIn(font: string): (text: string) => number {
  if (!pen) pen = document.createElement('canvas').getContext('2d');
  return (text) => {
    const key = `${font}|${text}`;
    let w = widths.get(key);
    if (w === undefined) {
      if (!pen) return text.length * 7;
      pen.font = font;
      w = pen.measureText(text).width;
      widths.set(key, w);
    }
    return w;
  };
}

function boxWidth(el: HTMLElement): number {
  const cs = getComputedStyle(el);
  return el.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
}

function overflowing(el: HTMLElement): boolean {
  const range = document.createRange();
  range.selectNodeContents(el);
  return range.getBoundingClientRect().width > boxWidth(el) + 0.25;
}

/** A search word, marked where it still is in a fitted line. */
function markIn(el: HTMLElement, word: string): void {
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const lw = word.toLowerCase();
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const text = n as Text;
    const k = (text.nodeValue ?? '').toLowerCase().indexOf(lw);
    if (k < 0) continue;
    const hit = text.splitText(k);
    hit.splitText(word.length);
    const mark = document.createElement('mark');
    mark.textContent = hit.nodeValue;
    hit.parentNode!.replaceChild(mark, hit);
    return;
  }
}

/**
 * Fits every about line and command hint in `scope`: `[data-about]` lines take their about line's
 * forms (`data-from` says where it comes from: a change is never cut), `[data-fit]` hints are cut at
 * their end, or take `data-short`. A line `data-mark` names a search word in is marked where the
 * word still is. Lines not laid out (a hidden column) are left as they are.
 */
export function fitAbouts(scope: ParentNode): void {
  // Only a page that lays itself out can be measured (a test's document without layout is left whole).
  if (typeof getComputedStyle !== 'function' || typeof document === 'undefined' || typeof document.createRange !== 'function') return;
  const lines: Array<FitLine & { el: HTMLElement }> = [];
  for (const el of scope.querySelectorAll<HTMLElement>('[data-about], [data-fit]')) {
    if (!el.dataset || typeof el.getBoundingClientRect !== 'function' || !el.getClientRects().length) continue;
    const about = el.dataset.about;
    const forms = about !== undefined ? aboutForms({ text: about, from: (el.dataset.from ?? 'user') as RunAbout['from'] }) : hintForms(el.dataset.fit ?? '', el.dataset.short ?? null);
    const ordered = orderForms(forms, measureIn(getComputedStyle(el).font));
    // Its text only: React draws the line as one text, and leaves it to the fit until the line itself changes.
    lines.push({ el, forms: ordered, write: (t) => (el.textContent = t), overflows: () => overflowing(el), room: () => boxWidth(el) });
  }
  fitLines(lines);
  for (const x of lines) if (x.el.dataset.mark) markIn(x.el, x.el.dataset.mark);
}
