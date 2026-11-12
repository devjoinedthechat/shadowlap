import { Fragment, type ReactNode } from 'react';
import { CopyButton } from '../components/bits.js';
import { num } from '../format.js';
import type { NotePart, RunNote } from './notes.js';

// The notes' words come with the finding that draws one: a page loads both as it may first draw a note (notes-part.ts).
export { runNotes } from './notes.js';

/**
 * A thing the run did that Shadowlap did not record, or answered as it went (notes.ts), as one of the
 * run's findings (FindingsBar.tsx): the tools the model called that it never recorded, with how to
 * have them recorded and the config's lines to copy; no preload loaded, or a process the guard
 * couldn't watch, with what to do; WebSockets gone to a provider live; a replay's extra reads. Its
 * label and words on its line, wrapping, never cut, `more` (the bar's toggle) at its end; its tools
 * and hint under it (`.fbody`), which a closed bar hides. Each call it names opens on a click. `fx`:
 * a finding the closed bar folds away.
 */
export function NoteFinding({ n, fx, more, onSelect }: { n: RunNote; fx: boolean; more: ReactNode; onSelect: (callNo: number) => void }) {
  return (
    <section className={`rnote ${n.tone}${fx ? ' fx' : ''}`}>
      <span className="bk">{n.label}</span>
      <div className="rnw">
        <p className="why">{said(n.parts, onSelect)}</p>
        {n.tools?.length || n.hint ? (
          <div className="fbody">
            {n.tools?.length ? (
              <ul className="rntools">
                {n.tools.map((t) => (
                  <li key={t.name}>
                    <code>{t.name}</code>
                    <span className="rnc">
                      {num(t.count)} {t.count === 1 ? 'call' : 'calls'} from model call{' '}
                      <button className="bn" type="button" onClick={() => onSelect(t.firstCallNo)} aria-label={`Open #${t.firstCallNo}, the model call that first asked for ${t.name}`}>
                        #{t.firstCallNo}
                      </button>
                    </span>
                    {/* A tool whose effect nothing tells is refused as a write is: it may write. */}
                    <span className={`eff ${t.effect === 'unknown' ? 'unknown' : t.effect}`}>{t.effect === 'unknown' ? 'may write' : t.effect}</span>
                    <span className="rnwhy">{t.why}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {n.hint ? (
              <p className="rnhint">
                {said(n.hint.parts, onSelect)}
                {n.hint.copy ? (
                  <>
                    <code className="rncopy">{n.hint.copy}</code>
                    <CopyButton text={n.hint.copy} label="what to declare in shadowlap.config.json" />
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      {more}
    </section>
  );
}

/** A note's parts drawn: words, names as code, calls as buttons that open them. */
function said(parts: readonly NotePart[], onSelect: (callNo: number) => void): ReactNode[] {
  return parts.map((p, i) =>
    typeof p === 'string' ? (
      <Fragment key={i}>{p}</Fragment>
    ) : 'code' in p ? (
      <code key={i}>{p.code}</code>
    ) : (
      <button key={i} className="bn" type="button" onClick={() => onSelect(p.call)} aria-label={`Open #${p.call}`}>
        #{p.call}
      </button>
    ),
  );
}
