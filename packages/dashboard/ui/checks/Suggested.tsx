import { useEffect, useId, useRef } from 'react';
import type { CheckSuggestion, CheckSuggestions, SuggestionsAsk } from '../checks-api.js';
import { ErrorState } from '../components/States.js';
import { shortId } from '../format.js';
import { useApp } from '../state.js';
import type { Fragment } from './model.js';
import { useSettledRead } from './settled-read.js';

/**
 * Suggested, in the check builder: at most three rules that fail a failed recording and none of its
 * good runs (its fix's, then the agent's recordings labelled good), mined by the engine beside the
 * server. Each is one click into the builder: Use rule puts it in place of the rule being built, Add
 * rule adds it, and nothing is saved until Save. A rule the builder holds is left out, the used one at
 * once. Drawn only while there is a suggestion, or a read that failed.
 */

export interface SuggestedProps {
  /** What is asked; null where the builder asks nothing (a golden's checks, a run that didn't fail). */
  ask: SuggestionsAsk | null;
  verb: 'Use rule' | 'Add rule';
  onUse: (expect: Fragment) => void;
}

/** The suggestions for what is asked, read as the draft's preview is: settled, one read in flight, the last answer kept. */
function useSuggestions(ask: SuggestionsAsk | null) {
  const { client } = useApp();
  return useSettledRead<CheckSuggestions>(ask ? JSON.stringify(ask) : null, (k) => client.checks.suggestions(JSON.parse(k) as SuggestionsAsk));
}

/** What each suggestion fails and passes: the run, and its one good run by its id or how many there are. */
function SubLine({ answer }: { answer: CheckSuggestions }) {
  const [one] = answer.goods;
  return (
    <span className="cb-sub">
      each fails <code>{shortId(answer.runId)}</code> and{' '}
      {answer.goods.length === 1 && one ? (
        <>
          not its good run, <code>{shortId(one)}</code>
        </>
      ) : (
        <>none of your {answer.goods.length} good runs</>
      )}
    </span>
  );
}

/**
 * Where focus goes once a row leaves while one of its buttons had it: to the row now in its place,
 * else the row that is last now, else the editor's pressed kind, where the builder starts.
 */
function useFocusKept(rows: readonly CheckSuggestion[]) {
  const list = useRef<HTMLUListElement | null>(null);
  const dialog = useRef<Element | null>(null);
  const focused = useRef<{ label: string; at: number } | null>(null);
  useEffect(() => {
    const was = focused.current;
    if (!was || rows.some((r) => r.label === was.label)) return;
    // Focus still on something else is left there.
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const buttons = list.current?.querySelectorAll<HTMLButtonElement>('button') ?? [];
    const next = buttons[Math.min(was.at, buttons.length - 1)] ?? dialog.current?.querySelector<HTMLElement>('.cb-kinds [aria-pressed="true"]') ?? null;
    focused.current = next && buttons.length ? { label: rows[Math.min(was.at, rows.length - 1)]!.label, at: Math.min(was.at, rows.length - 1) } : null;
    next?.focus();
  });
  const track = (label: string, at: number) => (e: { currentTarget: Element }) => {
    focused.current = { label, at };
    dialog.current = e.currentTarget.closest('[role="dialog"]');
  };
  const untrack = (e: { relatedTarget: EventTarget | null }) => {
    if (e.relatedTarget) focused.current = null;
  };
  return { list, track, untrack };
}

export function Suggested({ ask, verb, onUse }: SuggestedProps) {
  const read = useSuggestions(ask);
  const id = useId();
  const answer = read.answer ?? read.last;
  // A used rule leaves at once: the builder holds it, so the next answer leaves it out too.
  const rows = answer && ask ? answer.suggestions.filter((s) => !ask.have.includes(s.label)) : [];
  const focus = useFocusKept(rows);
  if (!ask || (!rows.length && !read.error)) return null;
  return (
    <section className="cb-sec">
      <p className="cb-k">
        <span className="k">Suggested</span>
        {answer && rows.length ? <SubLine answer={answer} /> : null}
      </p>
      {read.error ? <ErrorState retry={read.retry}>{read.error}</ErrorState> : null}
      {rows.length ? (
        <ul className="cb-sugs" ref={focus.list}>
          {rows.map((s, i) => (
            <li className="cb-sug" key={s.label}>
              <code id={`${id}-${i}`}>{s.label}</code>
              <button type="button" className="linkbtn" aria-describedby={`${id}-${i}`} onFocus={focus.track(s.label, i)} onBlur={focus.untrack} onClick={() => onUse(s.expect as Fragment)}>
                {verb}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
