import type { ReactNode } from 'react';
import { CopyButton } from '../components/bits.js';
import { Code, Words } from '../components/Copy.js';
import { num } from '../format.js';
import { noteLines } from './note-lines.js';
import type { NotePart, RunNote } from './notes.js';

/**
 * A note's words as one of the run's findings draws them (FindingsBar.tsx's NoteFinding holds its
 * label and the bar's toggle): its line, wrapping, never cut; the tools the model called that it
 * never recorded, with how to have them recorded and the config's lines to copy; no preload loaded,
 * or a process the guard couldn't watch, with what to do; WebSockets gone to a provider live; a
 * replay's extra reads. Its tools and hint go under its line (`.fbody`), which a closed bar hides.
 * Each call it names opens on a click. A part of its own with the notes' words (note-lines.ts),
 * loaded the first time a run's page draws a note.
 */
export function NoteWords({ n, onSelect }: { n: RunNote; onSelect: (callNo: number) => void }) {
  const w = noteLines(n);
  return (
    <>
      <p className="why">{said(w.parts, onSelect)}</p>
      {w.tools?.length || w.hint ? (
        <div className="fbody">
          {w.tools?.length ? (
            <ul className="rntools">
              {w.tools.map((t) => (
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
          {w.hint ? (
            <p className="rnhint">
              {said(w.hint.parts, onSelect)}
              {w.hint.copy ? (
                <>
                  <code className="rncopy">{w.hint.copy}</code>
                  <CopyButton text={w.hint.copy} label="what to declare in shadowlap.config.json" />
                </>
              ) : null}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** A note's parts drawn: words glued (a count with its noun), names as code kept whole, calls as buttons that open them. */
function said(parts: readonly NotePart[], onSelect: (callNo: number) => void): ReactNode[] {
  return parts.map((p, i) =>
    typeof p === 'string' ? (
      <Words key={i}>{p}</Words>
    ) : 'code' in p ? (
      <Code key={i}>{p.code}</Code>
    ) : (
      <button key={i} className="bn" type="button" onClick={() => onSelect(p.call)} aria-label={`Open #${p.call}`}>
        #{p.call}
      </button>
    ),
  );
}
