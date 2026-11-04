import { Fragment, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { commandParts, type CmdPiece } from '../cmdline.js';
import { codePieces, glue, greedyLines, inlineCodePieces, isShortCopy, sentences, setSentences, type Piece, type SentenceSet } from '../typeset.js';

/**
 * Clean line breaks at render time (MISSING §16 Line breaks): the parts that set a page's copy and
 * code so a line breaks where a careful typesetter would break it, at every width. React owns its
 * text, so nothing reads the page after the fact: each part measures what it sets (a canvas, in its
 * element's own font, against its width) and renders the pieces. What a user copies to run (a
 * command, code, JSON) keeps plain spaces, never a no-break space, and pieces kept whole are nowrap
 * elements. Nothing here balances a block whose words are each a nowrap piece, which crashed Chromium.
 */

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- React's own JSX namespace, which a custom element joins by augmenting it
  namespace JSX {
    interface IntrinsicElements {
      /** A sentence of short copy, kept whole where it fits a line (`.snt`): an element of its own, so no page rule for spans reaches it. */
      'ts-s': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      /** A word kept whole (a hyphenated name, an order id): nowrap, never a changed character, so a copy of it is exact. */
      'ts-w': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
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

/** An element's font as canvas takes it, and the width its text has. */
interface Box {
  font: string;
  width: number;
}

/** The font and the content width of the block `ref` holds, read once laid out and again as its width changes or the fonts load. */
function useBox(ref: { current: HTMLElement | null }): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof getComputedStyle !== 'function' || typeof ResizeObserver !== 'function') return;
    const read = () => {
      const cs = getComputedStyle(el);
      const font = cs.font || `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const width = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      setBox((b) => (b && b.font === font && b.width === width ? b : { font, width }));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    const fonts = document.fonts as FontFaceSet | undefined;
    fonts?.addEventListener('loadingdone', read);
    return () => {
      ro.disconnect();
      fonts?.removeEventListener('loadingdone', read);
    };
  }, [ref]);
  return box;
}

// ---------------------------------------------------------------------------------------------- copy

/** A word with a hyphen, a dash, a slash or a dot inside it, which a browser would break there: kept whole, as rule 4 asks. */
const splits = (w: string) => /\S[-–—/.]\S/.test(w.replace(/[.,;:!?”’"')\]]+$/, ''));

/** A sentence's words, each one a browser would break inside kept whole (`ts-w`). */
function words(text: string): ReactNode[] {
  return text.split(/(\S+)/).map((w, i) => (i % 2 && splits(w) ? <ts-w key={i}>{w}</ts-w> : w));
}

/**
 * A line of copy that no `Copy` sets (a verdict's sentence, a heading, a caption): its words glued
 * (`glue`), and each one a browser would break at a hyphen, a dash, a slash or a dot kept whole, so
 * `refund-in-limit` never splits. A line that may hold what a user copies (a command among facts)
 * keeps its spaces as they are (`glued={false}`): its words whole, nothing in it changed.
 */
export function Words({ children, glued = true }: { children: string; glued?: boolean }) {
  return <>{words(glued ? glue(children) : children)}</>;
}

/** Whether every word of a sentence is kept whole: balancing such a block crashed Chromium, so it never balances. */
const allWhole = (text: string) => text.split(/\s+/).filter(Boolean).every(splits);

const SET_CLASS: Record<SentenceSet, string | null> = { whole: 'snt', balanced: 'snt ts-bal', flow: null };

type Block = 'p' | 'span' | 'div' | 'li' | 'dd' | 'h2' | 'h3';

/**
 * A piece of UI copy (a lead, an empty state, a note, a step, a dialog's text, a finding, a caption),
 * set as rule 1 to 3 ask: its sentences found (`sentences`), each glued (`glue`: a number with its
 * unit, a separator with the word before it, a small word with the word after it…), and each one
 * that fits a line kept whole on it, a sentence of two lines on a line of its own with its lines
 * balanced, a longer one flowing. A block of one sentence that sets in two lines balances; a longer
 * one wraps pretty. Longer prose (five sentences or more, or past 640 characters) keeps its flow.
 * Data never goes in it: a model's answer, a prompt, code or an id.
 */
export function Copy({ children, as: Tag = 'p', className }: { children: string; as?: Block; className?: string | undefined }) {
  const ref = useRef<HTMLElement | null>(null);
  const box = useBox(ref);
  const short = isShortCopy(children);
  const set = useMemo(() => {
    const parts = short ? sentences(children) : [children];
    const width = box ? widthIn(box.font) : null;
    if (!box || !width || box.width <= 0) return { parts: parts.map((p) => glue(p)), sets: parts.map((): SentenceSet => 'whole'), lines: 0 };
    const room = box.width;
    const measure = { fits: (s: string) => width(s) <= room * 0.96, lines: (s: string) => greedyLines(s, room, width) };
    const glued = parts.map((p) => glue(p, measure));
    const widths = glued.map((p) => width(p));
    const counts = glued.map((p) => measure.lines(p));
    const sets = setSentences(widths, counts, room, width(' ')).map((s, i) => (s === 'balanced' && allWhole(glued[i]!) ? 'flow' : s));
    return { parts: glued, sets, lines: counts.reduce((a, b) => a + b, 0) };
  }, [children, short, box]);
  // One sentence of two lines balances, unless each of its words is kept whole; a longer block wraps pretty (rule 2).
  const block = set.lines === 2 && set.parts.length === 1 && !allWhole(set.parts[0]!) ? 'ts-bal' : set.lines > 2 ? 'ts-pretty' : null;
  const cls = [className, block].filter(Boolean).join(' ') || undefined;
  const body = !short ? words(set.parts[0]!) : set.parts.map((p, i) => {
    const c = SET_CLASS[set.sets[i]!];
    return (
      <Fragment key={i}>
        {i ? ' ' : null}
        {/* role none: the paragraph reads with its text, as it would without the pass */}
        {c ? (
          <ts-s className={c} role="none">
            {words(p)}
          </ts-s>
        ) : (
          words(p)
        )}
      </Fragment>
    );
  });
  return (
    <Tag ref={(el: HTMLElement | null) => void (ref.current = el)} className={cls}>
      {body}
    </Tag>
  );
}

// ---------------------------------------------------------------------------------------------- code

/** Pieces as elements: whole ones nowrap, a place to break a <wbr>, the rest as text. */
function drawn(pieces: ReadonlyArray<Piece | CmdPiece>): ReactNode[] {
  return pieces.map((p, i) => ('wbr' in p ? <wbr key={i} /> : p.whole ? <span key={i} className="nw">{p.text}</span> : p.text));
}

/** Whether code fits whole on its line: its width against its block's, once both are measured. */
function useFitsWhole(ref: { current: HTMLElement | null }, text: string, on: boolean): boolean {
  const [whole, setWhole] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    const block = el?.parentElement;
    if (!on || !el || !block || typeof getComputedStyle !== 'function') return;
    const cs = getComputedStyle(el);
    const width = widthIn(cs.font || `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`);
    if (width) setWhole(width(text) <= block.clientWidth);
  }, [ref, text, on]);
  return whole;
}

/**
 * Inline code (a path, a host, a field, a golden's name) as rule 4 sets it: up to 32 characters
 * one piece that never breaks (`code.ts-code`); a longer one whole where its line holds it, and only
 * where it doesn't may it break after a slash or a dot, a hyphen in a name, or between the words of
 * a phrase (`code.ts-cb`). Its text is the code as written, so a copy of it is exact.
 */
export function Code({ children, className }: { children: string; className?: string | undefined }) {
  const ref = useRef<HTMLElement | null>(null);
  const pieces = inlineCodePieces(children);
  const long = pieces.length > 1;
  const whole = useFitsWhole(ref, children, long);
  const cls = [long ? `ts-cb${whole ? ' whole' : ''}` : 'ts-code', className].filter(Boolean).join(' ');
  return (
    <code ref={(el: HTMLElement | null) => void (ref.current = el)} className={cls}>
      {long ? drawn(pieces) : children}
    </code>
  );
}

/**
 * A command as a code box shows it (rule 6), breaking only between its arguments: its head whole, a
 * flag with its value, an id or a short quoted value whole, JSON after its commas and opening
 * braces, a long path after a slash. Its `$` is never copied with it (`user-select: none`) and never
 * ends a line alone. Inside a `.cmdline` (`CodeBox`), or set as code in a line (`inline`), where it
 * has no `$` unless `prompt` asks for one.
 */
export function Command({ cmd, inline = false, prompt = !inline }: { cmd: string; inline?: boolean; prompt?: boolean }) {
  const [first, ...rest] = commandParts(cmd);
  const head = first && !('wbr' in first) ? first.text : '';
  const body = (
    <>
      {prompt ? (
        <span className="nw cmdp">
          <b>$</b>
          {head}
        </span>
      ) : (
        <span className="nw">{head}</span>
      )}
      {drawn(rest)}
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
