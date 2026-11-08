import { Fragment, useCallback, useLayoutEffect, useReducer, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import { cssVars } from '../dom.js';
import { focusQuiet, settleFocus } from '../focus-manager.js';
import { useScrollStop } from '../hooks.js';
import { cellPlace, cellTone, glueBound, type Matrix, type MatrixCol, type MatrixRow } from '../matrix.js';
import { bandsOf, fitMatrix, fitText, GAP, groupOpen, keyStart, openGroups, shownRows, toggleGroup, type Band, type Fit, type Measure, type Part } from '../matrix-fit.js';
import { useFitAbouts } from './About.js';
import { fontOf, widthIn } from './Copy.js';
import { Icon } from './Icon.js';
import { MatrixKey, type KeyEntry } from './MatrixKey.js';

/**
 * The results matrix (matrix.ts): an injection test's untrusted reads by payload, a run by the
 * error-path presets. What was tested runs down the side and its variants across the top, each cell
 * in the strip's grammar: a bar in its tone, the word, the tally with its noun, the bound kept whole.
 * Fitted to its room once laid out, again as its width changes and once the web fonts load
 * (matrix-fit.ts): columns that don't fit wrap into balanced bands where it has one row, scroll
 * sideways in one band under row heads that stay put where it has several (a hairline beside them
 * once cells are under them, the right edge fading while columns run past it), and turn on a phone or
 * in the run's inspector where turned they fit. Its key, if given, sits in its head over the cells.
 * Its script loads on its own the first time it shows (FindingPanel.tsx's ResultsMatrixPart).
 */

/** How the page draws a row's head, what is under it and a column's head, in place of their labels. */
export interface MatrixHeads {
  /** A row's head: a run's id, a read's call. Its label stays what is measured and read. */
  row?: (row: MatrixRow) => ReactNode;
  /** What is under a row's head: a run's about line, fitted to its room (`AboutLine` with `className="rmxab"`). */
  sub?: (row: MatrixRow) => ReactNode;
  col?: (col: MatrixCol) => ReactNode;
}

export interface MatrixKeys {
  main: readonly KeyEntry[];
  quiet: readonly KeyEntry[];
}

// ---------------------------------------------------------------------------------------------- measuring

/** Each measured part in a probe drawn as the matrix draws it, so its font is the stylesheet's. */
function fontsIn(box: HTMLElement): Record<Part, string> {
  const make = (tag: string, cls: string, ...kids: HTMLElement[]) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    e.append(...kids);
    return e;
  };
  const parts: Record<Part, HTMLElement> = { head: make('span', 'rmx-ch'), row: make('span', 'rmx-r'), word: make('b', ''), tally: make('span', 'rmx-tally'), bound: make('small', ''), sub: make('small', ''), chip: make('span', 'chip rmx-gc') };
  const probe = make('div', '', parts.head, parts.row, make('span', 'rmx-c', parts.word, parts.tally, parts.bound), make('span', 'rmx-r', parts.sub, parts.chip));
  probe.hidden = true;
  box.append(probe);
  const fonts = Object.fromEntries((Object.keys(parts) as Part[]).map((p) => [p, fontOf(getComputedStyle(parts[p]))])) as Record<Part, string>;
  probe.remove();
  return fonts;
}

/** About how wide a character is in each part, where nothing can measure (the tests' renderer, the first frame). */
const ROUGH: Readonly<Record<Part, number>> = { head: 6.6, row: 7.5, word: 6.8, tally: 6.6, bound: 6.6, sub: 6.6, chip: 6.6 };

/** A width in a part's font, each text measured once a fit. */
function measurer(fonts: Record<Part, string> | null): Measure {
  const seen = new Map<string, number>();
  const pens = new Map<Part, ((s: string) => number) | null>();
  return (text, part) => {
    const k = `${part}\n${text}`;
    let w = seen.get(k);
    if (w === undefined) {
      if (!pens.has(part)) pens.set(part, fonts ? widthIn(fonts[part]) : null);
      const pen = pens.get(part);
      w = pen ? pen(text) : text.length * ROUGH[part];
      seen.set(k, w);
    }
    return w;
  };
}

/** The width it is fitted to before it is laid out: the page's beside the sidebar and the inspector. */
const fallbackWidth = () => (typeof innerWidth === 'number' && innerWidth > 0 ? Math.max(320, Math.min(innerWidth - 420, 1100)) : 1100);
const isNarrow = () => typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches;

interface Edges {
  more: boolean;
  under: boolean;
}

/** What the band hides sideways: columns past its right edge, cells under the row heads. */
const edgesOf = (b: HTMLElement): Edges => ({ more: b.scrollWidth - b.clientWidth - b.scrollLeft > 2, under: b.scrollLeft > 2 });

// ---------------------------------------------------------------------------------------------- drawing

/** A column's card: its label and what it does, which its head has no room for. */
const colTip = (c: MatrixCol): string | undefined => (c.sub ? JSON.stringify({ t: c.label, s: c.sub }) : undefined);

function Fills({ n }: { n: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className="rmx-fill" aria-hidden="true" />
      ))}
    </>
  );
}

/** A label as drawn: a read's call number muted before its tool ("#4 get_ticket"). */
function drawnLabel(label: string): ReactNode {
  const m = /^(#\d+)(\s[\s\S]*)?$/.exec(label);
  if (!m) return label;
  return (
    <>
      <span className="rmx-cn">{m[1]}</span>
      {m[2] ?? ''}
    </>
  );
}

/** A row's label, read in full where its name says more ("#4", read "#4 get_ticket"). */
function named(row: MatrixRow): ReactNode {
  const name = row.name;
  const label = drawnLabel(row.label);
  if (!name || name === row.label) return label;
  if (name.startsWith(row.label)) {
    return (
      <>
        {label}
        <span className="sr">{name.slice(row.label.length)}</span>
      </>
    );
  }
  return (
    <>
      <span aria-hidden="true">{label}</span>
      <span className="sr">{name}</span>
    </>
  );
}

/** A row's head as drawn: the page's, else its label, a link where it goes somewhere; its chip beside it, what is under it below. */
function RowHead({ row, member, heads }: { row: MatrixRow; member: boolean; heads: MatrixHeads | undefined }) {
  const label = heads?.row?.(row) ?? (row.href ? <a className={member ? 'rmx-rb rmx-rn' : 'rmx-rb'} href={row.href}>{named(row)}</a> : named(row));
  const sub = heads?.sub?.(row) ?? row.sub;
  return (
    <>
      {label}
      {row.chip ? <span className="chip rmx-gc">{row.chip}</span> : null}
      {sub ? <small>{sub}</small> : null}
    </>
  );
}

/** A tool's reads as one row: its head opens them under it, "get_ticket · 40 reads", the count under the tool on a phone. */
function GroupHead({ m, row, heads, onGroup }: { m: Matrix; row: MatrixRow; heads: MatrixHeads | undefined; onGroup: (key: string) => void }) {
  const sub = heads?.sub?.(row) ?? row.sub;
  return (
    <>
      <button className="rmx-g" type="button" data-at={`g|${row.key}`} aria-expanded={groupOpen(m.id, row.key)} onClick={() => onGroup(row.key)}>
        <Icon name="caret" />
        <span>
          {row.parts ? (
            <>
              <span className="rmxl">
                {row.parts[0]}
                <span className="rmxsep">{'\u00a0·'}</span>
              </span>{' '}
              <span className="rmxl">{row.parts[1]}</span>
            </>
          ) : (
            row.label
          )}
        </span>
      </button>
      {sub ? <small>{sub}</small> : null}
    </>
  );
}

/**
 * A cell: a bar in its tone, the word, the tally and the bound, a link to the attempt that shows it.
 * Read by its text: where it is, then what came of it, with a screen reader's commas between the parts
 * the page sets apart. One with a card and no link takes the focus itself, which shows the card.
 */
function Cell({ m, row, col }: { m: Matrix; row: MatrixRow; col: MatrixCol }) {
  const c = m.cell(row, col);
  const at = `${row.key}|${col.key}`;
  const place = <span className="sr">{cellPlace(m, row, col)}</span>;
  if (!c) {
    return (
      <span className="rmx-c none" data-at={at}>
        <i aria-hidden="true" />
        {place}
        <b>not run</b>
      </span>
    );
  }
  const inner = (
    <>
      <i aria-hidden="true" />
      {place}
      <b>{c.word}</b>
      {c.tally ? <span className="sr">, </span> : null}
      {c.tally ? <span className="rmx-tally">{c.tally}</span> : null}
      {c.bound ? <span className="sr">, </span> : null}
      {c.bound ? <small>{glueBound(c.bound)}</small> : null}
    </>
  );
  const cls = `rmx-c ${cellTone(c)}`;
  const tip = c.tip ?? undefined;
  if (c.href) {
    return (
      <a className={cls} href={c.href} data-tip={tip} data-at={at}>
        {inner}
      </a>
    );
  }
  return (
    <span className={cls} data-tip={tip} data-at={at} tabIndex={tip ? 0 : undefined}>
      {inner}
    </span>
  );
}

interface BandProps {
  m: Matrix;
  fit: Fit;
  band: Band;
  n: number;
  first: boolean;
  heads: MatrixHeads | undefined;
  onGroup: (key: string) => void;
}

const bandStyle = (fit: Fit, n: number) => ({ ...cssVars({ '--n': n, '--rh': `${fit.rh}px`, '--cw': `${fit.cw}px` }), ...(fit.w ? { width: fit.w } : {}) });

/** A band: the corner (on the first band), its column heads, then each row's head and its cells; an opened group's reads under it. */
function RowsBand({ m, fit, band, n, first, heads, onGroup }: BandProps) {
  const cols = m.cols.slice(band.from, band.to);
  const shown = shownRows(m, (r) => groupOpen(m.id, r.key));
  return (
    <div className="rmx-band" style={bandStyle(fit, n)}>
      <span className="rmx-k">{first ? m.corner : ''}</span>
      {cols.map((c) => (
        <span key={c.key} className="rmx-ch" data-tip={colTip(c)}>
          {heads?.col?.(c) ?? c.label}
        </span>
      ))}
      <Fills n={band.fill} />
      {shown.map(({ row, member }) =>
        row.note ? (
          <span key={row.key} className="rmx-note">
            <span>{row.note}</span>
          </span>
        ) : (
          <Fragment key={row.key}>
            <span className={member ? 'rmx-r rmx-sub' : 'rmx-r'}>{row.rows ? <GroupHead m={m} row={row} heads={heads} onGroup={onGroup} /> : <RowHead row={row} member={member} heads={heads} />}</span>
            {cols.map((c) => (
              <Cell key={c.key} m={m} row={row} col={c} />
            ))}
            <Fills n={band.fill} />
          </Fragment>
        ),
      )}
    </div>
  );
}

/** Turned: its rows across the top, each with what is under it, and its variants down the side, each keeping its card. */
function TurnedBand({ m, fit, band, n, heads }: BandProps) {
  const rows = m.rows.slice(band.from, band.to);
  return (
    <div className="rmx-band" style={bandStyle(fit, n)}>
      <span className="rmx-k" />
      {rows.map((r) => (
        <span key={r.key} className="rmx-ch rmx-chr">
          <RowHead row={r} member={false} heads={heads} />
        </span>
      ))}
      <Fills n={band.fill} />
      {m.cols.map((c) => (
        <Fragment key={c.key}>
          <span className="rmx-r" data-tip={colTip(c)}>
            {heads?.col?.(c) ?? c.label}
          </span>
          {rows.map((r) => (
            <Cell key={r.key} m={m} row={r} col={c} />
          ))}
          <Fills n={band.fill} />
        </Fragment>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- the matrix

interface Laid {
  fit: Fit;
  /** Where the key starts: past the row heads while the columns hold its first line, else 0. */
  rhk: number;
}

/** What has the focus in the matrix, by its place (`data-at`), to give it back once a refit draws it anew. */
function focusedAt(box: HTMLElement): string | null {
  const a = document.activeElement as HTMLElement | null;
  return a && a !== box && box.contains(a) ? a.getAttribute('data-at') : null;
}

function giveBack(box: HTMLElement, at: string): void {
  if (box.contains(document.activeElement)) return;
  const el = [...box.querySelectorAll<HTMLElement>('[data-at]')].find((x) => x.getAttribute('data-at') === at);
  if (el) focusQuiet(el);
}

export function ResultsMatrix({ matrix: m, keys, heads }: { matrix: Matrix; keys?: MatrixKeys | null | undefined; heads?: MatrixHeads | undefined }) {
  const box = useRef<HTMLDivElement>(null);
  const band = useRef<HTMLDivElement>(null);
  const fonts = useRef<Record<Part, string> | null>(null);
  // What had the focus before the matrix was drawn anew (a refit, a group opened): it gets it back.
  const keep = useRef<string | null>(null);
  const [laid, setLaid] = useState<Laid>(() => ({ fit: fitMatrix(m, { width: null, fallback: fallbackWidth(), narrow: false }, measurer(null)), rhk: 0 }));
  const [edges, setEdges] = useState<Edges>({ more: false, under: false });
  const [, redraw] = useReducer((n: number) => n + 1, 0);

  const sawEdges = () => {
    const b = band.current;
    if (!b) return;
    const now = edgesOf(b);
    setEdges((was) => (was.more === now.more && was.under === now.under ? was : now));
  };
  // Fitted after every render, as its width changes and once the fonts load, before its about lines are.
  const refit = (el: HTMLElement) => {
    if (keep.current) giveBack(el, keep.current);
    keep.current = null;
    const width = el.clientWidth || null;
    if (width !== null && !fonts.current) fonts.current = fontsIn(el);
    const fit = fitMatrix(m, { width, fallback: fallbackWidth(), narrow: isNarrow() }, measurer(width === null ? null : fonts.current));
    const firstLine = [...el.querySelectorAll<HTMLElement>('.rmx-key0 .mxk1 > .mxk')].map((e) => e.offsetWidth);
    const rhk = keyStart(fit, m.cols.length, width, firstLine);
    if (fitText(fit, []) !== fitText(laid.fit, []) || rhk !== laid.rhk) {
      keep.current = focusedAt(el);
      setLaid({ fit, rhk });
    }
    if (width !== null) sawEdges();
  };
  useFitAbouts(box, refit);
  useScrollStop(band, 'x');
  // Esc's way back to a cell: the matrix comes a script later than the page that opened it.
  useLayoutEffect(settleFocus);

  const onGroup = useCallback(
    (key: string) => {
      toggleGroup(m.id, key);
      keep.current = `g|${key}`;
      redraw();
    },
    [m.id],
  );
  // A cell reached by Tab comes all the way into view, clear of the row heads and the fade; a click leaves the band where it is.
  const intoView = (e: FocusEvent<HTMLDivElement>) => {
    const b = band.current;
    const t = e.target as HTMLElement;
    if (b && t !== b && b.scrollWidth > b.clientWidth && t.matches(':focus-visible')) t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  const { fit } = laid;
  const { n, bands } = bandsOf(fit.flip ? m.rows.length : m.cols.length, fit.per);
  const Drawn = fit.flip ? TurnedBand : RowsBand;
  return (
    <div className="rmx" ref={box} role="group" aria-label={m.label || 'Results'} data-rmxfit={fitText(fit, openGroups(m.id))} style={cssVars({ '--rhk': `${laid.rhk}px` })}>
      {keys ? (
        <div className="rmx-key0">
          <MatrixKey main={keys.main} quiet={keys.quiet} />
        </div>
      ) : null}
      <div className={`rmx-in${edges.more ? ' rmx-more' : ''}${edges.under ? ' rmx-under' : ''}`} ref={band} style={{ scrollPaddingLeft: fit.rh + GAP }} onScroll={sawEdges} onFocus={intoView}>
        {bands.map((b, i) => (
          <Drawn key={i} m={m} fit={fit} band={b} n={n} first={i === 0} heads={heads} onGroup={onGroup} />
        ))}
      </div>
    </div>
  );
}
