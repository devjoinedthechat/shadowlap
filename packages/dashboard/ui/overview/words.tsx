import { Fragment, useMemo } from 'react';
import { Id } from '../components/Id.js';
import { dotParts } from '../components/Verdict.js';
import { shortId } from '../format.js';
import { useApp } from '../state.js';
import type { KeptPart } from './model.js';

/**
 * The Overview's words as a wrapping line keeps them, for Needs a look's rows and Activity's entries:
 * a hyphenated name whole, a run named by its id with its about line on hover, and a line of parts
 * broken only after a dot.
 */

/** A run's about line by its short id, or null for a run the dashboard hasn't listed. */
export type AboutOf = (id: string) => string | null;

/** The about lines of the runs the dashboard has listed, by short id. */
export function useAbouts(): AboutOf {
  const { runs } = useApp();
  const abouts = useMemo(() => new Map((runs ?? []).map((r) => [shortId(r.runId), r.about?.text ?? null])), [runs]);
  return useMemo<AboutOf>(() => (id) => abouts.get(id) ?? null, [abouts]);
}

/** Words in their pieces: a hyphenated name kept whole, a run's id with its about line on hover. */
export function Pieces({ parts, aboutOf }: { parts: readonly KeptPart[]; aboutOf: AboutOf }) {
  return (
    <>
      {parts.map((p, i) =>
        p.kind === 'id' ? (
          <Id key={i} id={p.text} about={aboutOf(p.text)} />
        ) : p.kind === 'nw' ? (
          <span key={i} className="nw">
            {p.text}
          </span>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * A line of parts broken only after a dot, each part of `max` characters or fewer kept whole, its
 * words cut by `cut`. A longer part may wrap inside, but keeps its dot with its last word, so a dot
 * ends a line and never starts one.
 */
export function DotPieces({ text, max, cut, aboutOf }: { text: string; max: number; cut: (part: string) => KeptPart[]; aboutOf: AboutOf }) {
  return (
    <>
      {dotParts(text, max).map((p, i) => (
        <Fragment key={i}>
          {i ? ' ' : null}
          {p.keep ? (
            <span className={p.keep === 'whole' ? 'nw' : 'kc'}>
              <Pieces parts={cut(p.text)} aboutOf={aboutOf} />
            </span>
          ) : (
            <Pieces parts={cut(p.text.replace(/ ·$/, '\u00a0·'))} aboutOf={aboutOf} />
          )}
        </Fragment>
      ))}
    </>
  );
}
