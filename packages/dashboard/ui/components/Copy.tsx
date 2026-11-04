import { Fragment, isValidElement, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { commandParts, pieceText, type CmdPiece } from '../cmdline.js';
import { planCopy, type CopyMeasure, type CopyPlan, type CopyUnit } from '../typeset-lines.js';
import { codePieces, inlineCodeCuts, longPieces, pathPieces, type CopyPart, type Piece } from '../typeset.js';
import { Id } from './Id.js';
import { Link } from './Link.js';

/**
 * Clean line breaks at render time (the rules are typeset.ts's, set at a width by
 * typeset-lines.ts): the parts that set a page's copy and code so a line breaks where a careful
 * typesetter would break it, at every width. React owns its text, so nothing reads the page after
 * the fact: each part measures what it sets (a canvas, in each element's own font, against the width
 * of the block it sits in) and renders the pieces. What a user copies to run (a command, code, JSON)
 * keeps plain spaces, never a no-break space, and pieces kept whole are nowrap elements. Nothing here
 * balances a block whose words are each a nowrap piece, which crashed Chromium.
 */

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- React's own JSX namespace, which a custom element joins by augmenting it
  namespace JSX {
    interface IntrinsicElements {
      /** A sentence of short copy, or a piece of one broken at a clause (`.snt`): an element of its own, so no page rule for spans reaches it. */
      'ts-s': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      /** A word kept whole (a hyphenated name, an order id), or an element of copy (`.ts-a`): nowrap, never a changed character, so a copy of it is exact. */
      'ts-w': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      /** A piece of a long name or a long path, whole, after which it may break (`.ts-seg`). */
      'ts-p': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}

export { glue } from '../typeset.js';

// ---------------------------------------------------------------------------------------------- measuring

let canvas: CanvasRenderingContext2D | null | undefined;
/** The font the canvas was last set in: setting it again for every word costs more than the measuring. */
let canvasFont = '';

/** A text's width on one line in a CSS font, or null where the page can't measure (no canvas: the tests' renderer). */
function widthIn(font: string): ((s: string) => number) | null {
  if (canvas === undefined) {
    const el = typeof document !== 'undefined' ? (document.createElement('canvas') as Partial<HTMLCanvasElement>) : null;
    canvas = typeof el?.getContext === 'function' ? el.getContext('2d') : null;
  }
  const ctx = canvas;
  if (!ctx) return null;
  return (s) => {
    if (canvasFont !== font) {
      ctx.font = font;
      canvasFont = font;
    }
    return ctx.measureText(s).width;
  };
}

/** A font as canvas takes it: the computed shorthand, or its parts where the browser gives none. */
const fontOf = (cs: CSSStyleDeclaration) => cs.font || `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;

/** Whether the page can be measured: a browser's layout (not the tests' renderer). */
const canMeasure = () => typeof getComputedStyle === 'function' && typeof ResizeObserver === 'function';

/**
 * The block an element's lines are laid in: itself where it is a box, else its nearest ancestor that
 * is, since an inline element's width is no line's and a resize of it is never observed. The pieces
 * this file draws are inline, so they are passed over too.
 */
export function blockOf(el: HTMLElement): HTMLElement {
  for (let b: HTMLElement | null = el; b; b = b.parentElement) {
    if (b.localName.startsWith('ts-')) continue;
    const d = getComputedStyle(b).display;
    if (d !== 'inline' && d !== 'contents') return b;
  }
  return el;
}

/** The width a line of a block has: its content width, never more than the window's less its margins. */
function lineWidth(b: HTMLElement): number {
  const cs = getComputedStyle(b);
  const w = b.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  return typeof innerWidth === 'number' && innerWidth > 0 ? Math.min(w, innerWidth - 32) : w;
}

/**
 * Measures what `target`'s block gives once it is laid out, again as its width changes, and again
 * once web fonts load (whose widths the fallback's measures got wrong, though the font's name and
 * the width stay the same), each time through `read`. Nothing where the page can't be measured (the
 * tests' renderer). `deps`: what `target` and `read` read from the render, which measures anew when it changes.
 */
function useRemeasure(target: () => HTMLElement | null, read: (el: HTMLElement, block: HTMLElement, fontsLoaded: boolean) => void, deps: readonly unknown[]): void {
  useLayoutEffect(() => {
    const el = target();
    if (!el || !canMeasure()) return;
    let alive = true;
    const block = blockOf(el);
    const resized = () => alive && read(el, block, false);
    const loaded = () => alive && read(el, block, true);
    resized();
    const ro = new ResizeObserver(resized);
    ro.observe(block);
    const fonts = document.fonts as FontFaceSet | undefined;
    fonts?.addEventListener('loadingdone', loaded);
    // fonts still loading as it mounts: measured again once they all have
    if (fonts?.status === 'loading') void fonts.ready.then(loaded);
    return () => {
      alive = false;
      ro.disconnect();
      fonts?.removeEventListener('loadingdone', loaded);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `target` and `read` are the caller's, new each render; what they read from it is in `deps`
  }, deps);
}

/** An element's font as canvas takes it, the width its block's lines have, and how many times the page's fonts have loaded since. */
interface Box {
  font: string;
  width: number;
  fonts: number;
}

/** The font of `ref`'s element and the width of its block's lines, read once laid out and again as the width changes or the fonts load. */
function useBox(ref: { current: HTMLElement | null }): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  useRemeasure(
    () => ref.current,
    (el, block, fontsLoaded) => {
      const font = fontOf(getComputedStyle(el));
      const width = lineWidth(block);
      setBox((b) => (b && !fontsLoaded && b.font === font && b.width === width ? b : { font, width, fonts: (b?.fonts ?? 0) + (fontsLoaded ? 1 : 0) }));
    },
    [],
  );
  return box;
}

/** The width of the text an element shows, each text in its own font: what is hidden, or set apart for a screen reader, shows none. */
function shownWidth(el: Element): number {
  let w = 0;
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 3) {
      const measure = widthIn(fontOf(getComputedStyle(el)));
      w += measure ? measure((n.nodeValue ?? '').replace(/[\s\u00a0]+/g, ' ')) : 0;
    } else if (n.nodeType === 1) {
      const e = n as HTMLElement;
      const cs = getComputedStyle(e);
      if (e.hidden || cs.display === 'none' || cs.position === 'absolute' || cs.position === 'fixed') continue;
      w += shownWidth(e);
    }
  }
  return w;
}

// ---------------------------------------------------------------------------------------------- copy's parts

type AnyElement = ReactElement<{ children?: ReactNode; k?: string; id?: string; cmd?: string; to?: boolean }>;

/** The text an element of copy shows, as far as its props say: what tells where a sentence starts and ends beside it. */
function shownText(el: AnyElement): string {
  const p = el.props;
  if (el.type === Id) return p.id ?? '';
  const own = p.children === undefined ? (typeof p.k === 'string' ? p.k : typeof p.cmd === 'string' ? p.cmd : '') : textOf(p.children);
  return el.type === Link && p.to ? `${own}\u00a0→` : own;
}

function textOf(n: ReactNode): string {
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(textOf).join('');
  return isValidElement(n) ? shownText(n as AnyElement) : '';
}

/** Whether an element of copy starts a sentence after a stop and a space: an id, code, a key, a command or a link set apart, or text that starts as a sentence does. */
function startsSentence(el: AnyElement, text: string): boolean {
  return (typeof el.type === 'string' ? ['code', 'kbd', 'a', 'samp'].includes(el.type) : [Id, Link, Code, Command].includes(el.type as never)) || /^[“‘"'([]?[A-Z0-9$#≈€£`]/.test(text);
}

/** Copy's children as parts: its own text (strings and numbers, fragments opened), each element a piece kept whole. */
function partsOf(children: ReactNode): { parts: CopyPart[]; nodes: ReactNode[] } {
  const parts: CopyPart[] = [];
  const nodes: ReactNode[] = [];
  const walk = (c: ReactNode): void => {
    if (c === null || c === undefined || typeof c === 'boolean') return;
    if (typeof c === 'string' || typeof c === 'number') {
      const last = parts[parts.length - 1];
      if (last && !('atom' in last)) last.text += String(c);
      else parts.push({ text: String(c) });
    } else if (Array.isArray(c)) c.forEach(walk);
    else if (isValidElement(c) && c.type === Fragment) walk((c as AnyElement).props.children);
    else if (isValidElement(c)) {
      const text = shownText(c as AnyElement);
      parts.push({ atom: nodes.length, text, starts: startsSentence(c as AnyElement, text) });
      nodes.push(c);
    }
  };
  walk(children);
  return { parts, nodes };
}

// ---------------------------------------------------------------------------------------------- drawing copy

/**
 * A long name (a host, a dotted field, a golden's name: 24 characters or more with a dot, 28 with a
 * hyphen) as rule 4 sets it: whole where its line holds it, and only where it doesn't may it break
 * after a dot or a hyphen (`.ts-long`: each piece nowrap, a <wbr> after it, not laid out while the
 * name is whole). `whole` where the copy around it measured it; else it measures itself.
 */
export function LongWord({ children, whole }: { children: string; whole?: boolean | null | undefined }) {
  const ref = useRef<HTMLElement | null>(null);
  const own = useFitsWhole(ref, children, whole === undefined || whole === null, 0.96);
  return (
    <ts-w ref={(el: HTMLElement | null) => void (ref.current = el)} className={`ts-long${(whole ?? own) ? ' whole' : ''}`}>
      {longPieces(children).map((p, i) => (
        <Fragment key={i}>
          {i ? <wbr /> : null}
          <ts-p className="ts-seg">{p}</ts-p>
        </Fragment>
      ))}
    </ts-w>
  );
}

/** Copy's own text from `from` to `to`, each word kept whole drawn so. */
function drawOwn(plan: Pick<CopyPlan, 'text' | 'words' | 'long'>, from: number, to: number): ReactNode[] {
  const out: ReactNode[] = [];
  let at = from;
  for (const w of plan.words) {
    if (w.from < from || w.to > to) continue;
    if (w.from > at) out.push(plan.text.slice(at, w.from));
    const word = plan.text.slice(w.from, w.to);
    if (w.kind === 'long')
      out.push(
        <LongWord key={w.from} whole={plan.long.get(w.from)}>
          {word}
        </LongWord>,
      );
    else if (w.kind === 'path')
      out.push(
        <Fragment key={w.from}>
          {pathPieces(word).map((p, i) => (
            <Fragment key={i}>
              {i ? <wbr /> : null}
              <ts-w>{p}</ts-w>
            </Fragment>
          ))}
        </Fragment>,
      );
    else out.push(<ts-w key={w.from}>{word}</ts-w>);
    at = w.to;
  }
  if (to > at) out.push(plan.text.slice(at, to));
  return out;
}

/** What draws copy: its plan, where each element sits in its text, the elements, and each element's wrapper's ref. */
interface Drawer {
  plan: CopyPlan;
  atoms: ReadonlyArray<{ from: number; to: number; atom: number }>;
  nodes: readonly ReactNode[];
  wrap: (i: number) => (el: HTMLElement | null) => void;
}

/** Copy from `from` to `to`: its own text, and each element in a wrapper of its own, nowrap where its line holds it. */
function drawRange(d: Drawer, from: number, to: number): ReactNode[] {
  const out: ReactNode[] = [];
  let at = from;
  for (const a of d.atoms) {
    if (a.from < from || a.to > to) continue;
    if (a.from > at) out.push(<Fragment key={`t${at}`}>{drawOwn(d.plan, at, a.from)}</Fragment>);
    out.push(
      <ts-w key={`a${a.atom}`} className={d.plan.wide.has(a.atom) ? 'ts-a ts-free' : 'ts-a'} data-a={a.atom} ref={d.wrap(a.atom)}>
        {d.nodes[a.atom]}
      </ts-w>,
    );
    at = a.to;
  }
  if (to > at) out.push(<Fragment key={`t${at}`}>{drawOwn(d.plan, at, to)}</Fragment>);
  return out;
}

const SET_CLASS: Record<CopyUnit['set'], string> = { whole: 'snt', balanced: 'snt ts-bal', flow: 'snt ts-flow' };

/** Copy's sentences, each in an element of its own as it sets, the space between two as it is. */
function drawUnits(d: Drawer, units: readonly CopyUnit[]): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  units.forEach((u, i) => {
    if (u.from > at) out.push(d.plan.text.slice(at, u.from));
    out.push(
      // role none: the paragraph reads with its text, as it would without the pass
      <ts-s key={`s${i}`} className={SET_CLASS[u.set]} role="none">
        {drawRange(d, u.from, u.to)}
      </ts-s>,
    );
    at = u.to;
  });
  if (d.plan.text.length > at) out.push(d.plan.text.slice(at));
  return out;
}

/** What takes the focus inside an element of copy. */
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';

type Block = 'p' | 'span' | 'div' | 'li' | 'dd' | 'h2' | 'h3';

/** Each element's width, measured after every draw (what it shows may change while the copy's text doesn't), and the focus kept on an element drawn anew. */
function useAtoms(nodes: readonly ReactNode[], block: { current: HTMLElement | null }) {
  const wrappers = useRef(new Map<number, HTMLElement>());
  const [widths, setWidths] = useState<readonly number[]>([]);
  const focus = useRef<{ atom: number; el: Element } | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- after every draw, since what an element shows can change while the copy's text doesn't; it sets the widths only when one changed, so it settles in one more draw
  useLayoutEffect(() => {
    if (!canMeasure()) return;
    const now = nodes.map((_, i) => {
      const el = wrappers.current.get(i);
      return el ? shownWidth(el) : 0;
    });
    if (now.length !== widths.length || now.some((w, i) => Math.abs(w - widths[i]!) > 0.01)) setWidths(now);
    // an element drawn anew where its sentence moved keeps the focus it had
    const f = focus.current;
    if (f && !f.el.isConnected && (!document.activeElement || document.activeElement === document.body)) {
      const next = wrappers.current.get(f.atom);
      const target = next?.querySelector(FOCUSABLE) ?? null;
      if (target instanceof HTMLElement) target.focus({ preventScroll: true });
      focus.current = target ? { atom: f.atom, el: target } : null;
    } else if (f && f.el.isConnected && document.activeElement !== f.el) focus.current = null;
  });
  const wrap = (i: number) => (el: HTMLElement | null) => {
    if (el) wrappers.current.set(i, el);
    else wrappers.current.delete(i);
  };
  const onFocus = (target: EventTarget) => {
    const w = (target as Element).closest?.('ts-w.ts-a');
    focus.current = w && block.current?.contains(w) ? { atom: Number(w.getAttribute('data-a')), el: target as Element } : null;
  };
  return { widths, wrap, onFocus };
}

/**
 * A piece of UI copy (a lead, an empty state, a note, a step, a dialog's text, a finding, a caption),
 * set by rules 1 to 4 at the width it has. Its sentences are found in its own text (`children`:
 * strings, and the elements in them, such as a link, code, a key or a term, each kept whole and
 * measured in its own font); each is glued (a number with its unit, a separator with the word before
 * it, a small word with the word after it…); each that fits a line is kept whole on it, one of two
 * lines starts a line of its own with its lines balanced unless it should flow on, and a short tail
 * with no stop (a link) stays with the sentence before it where the two fit a line. A block of two
 * lines balances, its one sentence breaking after a clause where it can; a longer one wraps pretty,
 * its last line a third of the measure where it can. `phrases`: a dialog's lead, a row's value, a
 * card or a setup step, which also break before a phrase, and a sentence too long for its line at
 * its clauses. Longer prose (five sentences or more, or past 640 characters) keeps its flow. Data
 * never goes in it: a model's answer, a prompt, code or an id.
 */
export function Copy({ children, as: Tag = 'p', className, phrases = false }: { children: ReactNode; as?: Block; className?: string | undefined; phrases?: boolean }) {
  const ref = useRef<HTMLElement | null>(null);
  const box = useBox(ref);
  const { parts, nodes } = useMemo(() => partsOf(children), [children]);
  const atoms = useAtoms(nodes, ref);
  const widths = atoms.widths;
  const plan = useMemo(() => {
    const text = box ? widthIn(box.font) : null;
    const m: CopyMeasure | null = box && text && box.width > 0 ? { width: box.width, text, atom: (i) => widths[i] ?? 0 } : null;
    return planCopy(parts, m, { heading: Tag === 'h2' || Tag === 'h3', phrases });
  }, [parts, box, widths, Tag, phrases]);
  const placed = useMemo(() => {
    let at = 0;
    return parts.flatMap((p) => {
      const from = at;
      at += p.text.length;
      return 'atom' in p ? [{ from, to: at, atom: p.atom }] : [];
    });
  }, [parts]);
  const drawer: Drawer = { plan, atoms: placed, nodes, wrap: atoms.wrap };
  return (
    <Tag ref={(el: HTMLElement | null) => void (ref.current = el)} className={[className, plan.wrap].filter(Boolean).join(' ') || undefined} onFocus={(e) => atoms.onFocus(e.target)}>
      {plan.units ? drawUnits(drawer, plan.units) : drawRange(drawer, 0, plan.text.length)}
    </Tag>
  );
}

/**
 * A line of copy no `Copy` sets (a verdict's sentence, a heading, a caption): its words glued
 * (`glue`), and each one a browser would break at a hyphen, a dash, a slash or a dot kept whole, so
 * `refund-in-limit` never splits; a long name whole where its line holds it. A line that may hold
 * what a user copies (a command among facts) keeps its spaces as they are (`glued={false}`): its
 * words whole, nothing in it changed.
 */
export function Words({ children, glued = true }: { children: string; glued?: boolean }) {
  const plan = planCopy([{ text: children }], null);
  return <>{drawOwn(glued ? plan : { ...plan, text: children }, 0, children.length)}</>;
}

// ---------------------------------------------------------------------------------------------- code

/** Pieces as elements: whole ones nowrap, a place to break a <wbr>, the rest as text. */
function drawn(pieces: readonly Piece[]): ReactNode[] {
  return pieces.map((p, i) => ('wbr' in p ? <wbr key={i} /> : p.whole ? <span key={i} className="nw">{p.text}</span> : p.text));
}

/** Whether `text` fits whole on a line of the block `ref`'s element sits in (`share` of it), measured again as the block's width changes or the fonts load. */
function useFitsWhole(ref: { current: HTMLElement | null }, text: string, on: boolean, share = 0.98): boolean {
  const [whole, setWhole] = useState(false);
  useRemeasure(
    () => (on ? (ref.current?.parentElement ?? null) : null),
    (_, block) => {
      const el = ref.current;
      const width = el ? widthIn(fontOf(getComputedStyle(el))) : null;
      if (width) setWhole(width(text) <= lineWidth(block) * share);
    },
    [text, on],
  );
  return whole;
}

/** Inline code's pieces: JSON as code shown as text, a phrase as a command, a path or a host in its pieces, else its text. */
function codeBody(text: string, spaced: boolean, cuts: readonly string[] | null): ReactNode {
  if (spaced) return /^[\s"'{[]/.test(text) ? drawn(codePieces(text)) : <CommandPieces pieces={commandParts(text)} room={null} />;
  if (!cuts) return text;
  return cuts.map((p, i) => (
    <Fragment key={i}>
      {i ? <wbr /> : null}
      <ts-p className="ts-seg">{p}</ts-p>
    </Fragment>
  ));
}

/**
 * Inline code (a path, a host, a field, a golden's name) as rule 4 sets it: up to 32 characters one
 * piece that never breaks (`code.ts-code`); a longer one whole where its line holds it, and only
 * where it doesn't may it break: a path after a slash (never inside `//`), a host after a dot, a
 * list after a comma, JSON as code shown as text breaks, a phrase as a command does (`code.ts-cb`).
 * Its text is the code as written, so a copy of it is exact.
 */
export function Code({ children, className }: { children: string; className?: string | undefined }) {
  const ref = useRef<HTMLElement | null>(null);
  const long = children.length > 32;
  const spaced = long && /\s/.test(children);
  const cuts = spaced ? null : inlineCodeCuts(children);
  const whole = useFitsWhole(ref, children, long);
  const kind = spaced || cuts ? `ts-cb${whole ? ' whole' : ''}` : !long || whole ? 'ts-code' : null;
  return (
    <code ref={(el: HTMLElement | null) => void (ref.current = el)} className={[kind, className].filter(Boolean).join(' ') || undefined}>
      {codeBody(children, spaced, cuts)}
    </code>
  );
}

// ---------------------------------------------------------------------------------------------- commands

/** What a command's line holds, measured: its width and a text's width in the command's font. */
interface Room {
  width: number;
  text: (s: string) => number;
}

/** A value wider than its line breaks after its `=` and its slashes ("2=@payloads/" / "exfil-email.txt"). */
const valuePieces = (v: string) => v.split(/(?<=[=/])(?=[^/])/);

/** One piece of a command drawn, its neighbours read for its flag: see `CommandPieces`. */
function commandPiece(pieces: readonly CmdPiece[], i: number, fits: (s: string) => boolean, measured: boolean): ReactNode {
  const p = pieces[i]!;
  if ('wbr' in p) return <wbr key={i} />;
  const prev = pieces[i - 1];
  const flag = prev && 'flag' in prev && prev.flag ? prev.text : '';
  if ('arg' in p)
    return (
      <span key={i} className={`carg${measured && fits(flag + pieceText(p)) ? ' whole' : ''}`}>
        <CommandPieces pieces={p.arg} room={null} />
      </span>
    );
  const next = pieces[i + 1];
  // a flag and a value that can't break inside it, too wide for the line together, break between them at a plain space
  if (p.flag && next && 'text' in next && !fits(p.text + next.text))
    return (
      <Fragment key={i}>
        <span className="nw cf">{p.text.trimEnd()}</span>{' '}
      </Fragment>
    );
  if (flag && !fits(p.text) && /[=/]./.test(p.text))
    return (
      <Fragment key={i}>
        {valuePieces(p.text).map((x, k) => (
          <Fragment key={k}>
            {k ? <wbr /> : null}
            <span className="nw">{x}</span>
          </Fragment>
        ))}
      </Fragment>
    );
  if (!p.whole) return p.text;
  return (
    <span key={i} className={p.flag ? 'nw cf' : 'nw'}>
      {p.text}
    </span>
  );
}

/**
 * A command's pieces drawn: a flag with its value; a long argument whole where its line holds it
 * with its flag (`.carg.whole`, its <wbr>s not laid out), else breaking inside; a flag and a value
 * that can't break inside it (an id) wider together than the line break between them, at a plain
 * space, and a value wider than the line by itself after its `=` and its slashes (`tsFlagSplit`).
 * Unmeasured (`room` null), a long argument breaks where it may and a flag keeps its value.
 */
export function CommandPieces({ pieces, room }: { pieces: readonly CmdPiece[]; room: Room | null }) {
  const fits = (s: string) => !room || room.text(s) <= room.width * 0.98;
  return <>{pieces.map((_, i) => commandPiece(pieces, i, fits, !!room))}</>;
}

/**
 * A command as a code box shows it (rule 6), breaking only between its arguments: its head whole, a
 * flag with its value, an id or a short quoted value whole, a long argument whole where its line
 * holds it with its flag and else broken inside only where it may (`commandParts`). Its `$` is never
 * copied with it (`user-select: none`) and never ends a line alone. Inside a `.cmdline` (`CodeBox`),
 * or set as code in a line (`inline`), where it has no `$` unless `prompt` asks for one.
 */
export function Command({ cmd, inline = false, prompt = !inline }: { cmd: string; inline?: boolean; prompt?: boolean }) {
  const ref = useRef<HTMLElement | null>(null);
  const box = useBox(ref);
  const [first, ...rest] = commandParts(cmd);
  const head = first && 'text' in first ? first.text : '';
  const text = box ? widthIn(box.font) : null;
  const body = (
    <>
      <span ref={(el: HTMLElement | null) => void (ref.current = el)} className={prompt ? 'nw cmdp' : 'nw'}>
        {prompt ? <b>$</b> : null}
        {head}
      </span>
      <CommandPieces pieces={rest} room={box && text && box.width > 0 ? { width: box.width, text } : null} />
    </>
  );
  return inline ? <code className="ts-cmd">{body}</code> : body;
}

/**
 * Code shown as text: a failure line, a model's tool call, a decision's step (`codePieces`). It
 * breaks at its spaces, after a comma and after a run of opening braces, a field or a call keeping
 * its number and an operator the word before it, so no line starts with `>`; a short object stays
 * whole. Never with a <wbr> before a space, which crashed Chromium in a block that balances.
 */
export function CodeText({ children, className }: { children: string; className?: string | undefined }) {
  return <code className={['ts-ct', className].filter(Boolean).join(' ')}>{drawn(codePieces(children))}</code>;
}
