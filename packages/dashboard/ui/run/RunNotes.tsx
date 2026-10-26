import { Fragment, type ReactNode } from 'react';
import { CopyButton } from '../components/bits.js';
import { num } from '../format.js';
import type { NotePart, RunNote } from './notes.js';

/**
 * Under a run's banner, a line for each thing the run did that Shadowlap did not record, or answered
 * as it went (notes.ts): the tools the model called that it never recorded, with how to have them
 * recorded and the config's lines to copy; no preload loaded, or a process the guard couldn't watch,
 * with what to do; WebSockets gone to a provider live; a replay's extra reads. Each call it names
 * opens on a click. Nothing at all when there is none.
 */
export function RunNotes({ notes, onSelect }: { notes: readonly RunNote[]; onSelect: (callNo: number) => void }) {
  if (!notes.length) return null;
  return (
    <section className="rnotes" aria-label="What Shadowlap did not record">
      {notes.map((n, i) => (
        <div className={`rnote ${n.tone}`} key={`${n.kind}:${i}`}>
          <span className="bk">{n.label}</span>
          <div className="rnw">
            <p className="why">{said(n.parts, onSelect)}</p>
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
        </div>
      ))}
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
