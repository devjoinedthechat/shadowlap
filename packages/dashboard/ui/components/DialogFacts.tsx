import { Fragment, useLayoutEffect, useRef, type ReactNode } from 'react';
import { asWords, Code, Copy, Words } from './Copy.js';
import { tipCard } from './HoverCard.js';

/** What decides whether to press, as a row: a label of a word or two, its value and the value's quiet part under it. */
export interface DialogFact {
  label: ReactNode;
  /** Its words, a name in code between backticks. */
  value: ReactNode;
  /** Under the value, quieter: what it means, or for whom. */
  quiet?: ReactNode;
  /** A row that acts for real or runs another's code reads in this colour, and a screen reader hears it first. */
  tone?: 'amber' | 'red' | undefined;
  /** A value that is one long token: its label over it on the narrowest phones. */
  wide?: boolean;
}

/** Rows a dialog may leave out as it decides: null and false draw nothing. */
export type DialogFactRows = readonly (DialogFact | null | false | undefined)[];

export const shownFacts = (rows: DialogFactRows | undefined): DialogFact[] => (rows ?? []).filter((x): x is DialogFact => !!x);

/** A toned row's id, to name it in the dialog's description. */
export const factId = (id: string, at: number) => `${id}f${at}`;

/**
 * Words that name something in code say it between backticks, as a dialog's words kept apart from its
 * markup do: each drawn by `Code`, whole up to 32 characters, a longer path breaking only after a slash.
 */
export function inCode(words: ReactNode): ReactNode {
  if (typeof words !== 'string' || !words.includes('`')) return words;
  return words.split('`').map((part, i) => (i % 2 ? <Code key={i}>{part}</Code> : part));
}

/** Short words no `Copy` sets (a cost line's part, a quiet clause) glued by `Words`, a name between backticks drawn by `Code`. */
export function codeWords(words: ReactNode): ReactNode {
  if (typeof words !== 'string') return words;
  return words.split('`').map((part, i) => (i % 2 ? <Code key={i}>{part}</Code> : part ? <Words key={i}>{part}</Words> : null));
}

/**
 * A quiet part's clauses after a middle dot each stay whole on a narrow line: the mock's `.dph`. Each
 * is set by `Copy`, measured, so a clause its line can't hold breaks where it may (a run glued
 * unmeasured, up to 30 characters, outgrew a phone's 184px row).
 */
function quietWords(words: ReactNode): ReactNode {
  if (typeof words !== 'string' || !words.includes(' · ')) return codeWords(words);
  return words.split(' · ').map((part, i) =>
    i ? (
      <Fragment key={i}>
        {'\u00a0· '}
        <span className="dph">
          <Copy as="span" phrases>
            {inCode(part)}
          </Copy>
        </span>
      </Fragment>
    ) : (
      <Fragment key={i}>{codeWords(part)}</Fragment>
    ),
  );
}

/** A row's value: words set as a lead is (`Copy` with phrases), a name in code inside; one long token (`wide`) and a node as they are. */
function valueOf(f: DialogFact): ReactNode {
  return typeof f.value === 'string' && !f.wide ? (
    <Copy as="span" phrases>
      {inCode(f.value)}
    </Copy>
  ) : (
    inCode(f.value)
  );
}

/**
 * Label and value rows between hairlines, in a dialog: each fact said once, never the lead's or the
 * cost line's again. Not the page's `Facts`, a row of figures.
 */
export function DialogFacts({ rows, id }: { rows: DialogFactRows; id?: string | undefined }) {
  const shown = shownFacts(rows);
  if (!shown.length) return null;
  return (
    <dl className="dfacts">
      {shown.map((f, i) => (
        <div key={i} id={f.tone && id ? factId(id, i) : undefined} className={[f.tone, f.wide ? 'wide' : ''].filter(Boolean).join(' ') || undefined}>
          <dt>{f.label}</dt>
          <dd>
            {valueOf(f)}
            {f.quiet ? <small>{quietWords(f.quiet)}</small> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Words in a dialog with a card of their own, titled with what they name: the rest of what they say, on hover, on focus and on a tap. */
export function DialogTip({ title, tip, children }: { title: string; tip: string; children: ReactNode }) {
  return (
    <span className="dtip" tabIndex={0} data-tip={tipCard(title, [], tip)}>
      {children}
    </span>
  );
}

/** One step of what a dialog changes in several: what it does, and where. */
export interface DialogStep {
  what: ReactNode;
  where?: ReactNode;
}

/**
 * What happens, numbered, between hairlines. On a phone a step's where sits at its line's right only
 * where every step's in the list fits there; else each under its step, so one list keeps one layout.
 */
export function DialogSteps({ steps, head = 'What happens', className = '' }: { steps: readonly DialogStep[]; head?: string; className?: string }) {
  const list = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    const ul = list.current;
    if (!ul) return;
    const fit = () => {
      ul.classList.remove('under');
      const under =
        window.innerWidth <= 640 &&
        [...ul.children].some((li) => {
          const what = li.querySelector(':scope > span');
          const where = li.querySelector(':scope > small');
          return !!what && !!where?.textContent?.trim() && where.getBoundingClientRect().top > what.getBoundingClientRect().top + 2;
        });
      ul.classList.toggle('under', under);
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  });
  return (
    <div className={`ondisk steps${className ? ` ${className}` : ''}`}>
      <span className="k">{head}</span>
      <ul ref={list}>
        {steps.map((s, i) => (
          <li key={i}>
            <i aria-hidden="true">{i + 1}</i>
            <span>{asWords(s.what)}</span>
            {s.where ? <small>{asWords(s.where)}</small> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
