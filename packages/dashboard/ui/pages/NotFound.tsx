import { PageHeader } from '../components/bits.js';
import { Code } from '../components/Copy.js';
import { Page } from '../components/Page.js';
import { notFoundWords, type NotFoundKind } from '../not-found-words.js';
import { codeParts } from '../projects.js';
import { projectOf } from '../shell/ProjectBlock.js';
import { useApp } from '../state.js';

/**
 * What a page with nothing at it shows, under the page's header: `<project> · not found` (`not
 * found` in an exported copy, or with no project), Nothing here, what was missing and the way back
 * to the list that holds its kind (`notFoundWords`), or to the Overview. `what` and `back` say it
 * otherwise, as an exported copy's run it doesn't hold does (`No run <id> in this copy.`).
 */
export function NotFoundPage({ kind = 'page', id, what, back }: { kind?: NotFoundKind; id?: string; what?: string; back?: readonly [string, string] }) {
  const { meta, exported } = useApp();
  const words = notFoundWords(kind, id ?? location.hash);
  const name = exported ? null : (projectOf(meta)?.name ?? null);
  const to = back ?? words.back;
  return (
    <Page>
      <PageHeader
        eyebrow={name ? `${name} · not found` : 'not found'}
        title="Nothing here"
        text={
          <>
            {what ?? codeParts(words.text, words.code ? [words.code] : []).map((p, i) => (p.code ? <Code key={i}>{p.text}</Code> : p.text))}{' '}
            <a className="more" href={to[0]}>
              {to[1]}
            </a>
          </>
        }
      />
    </Page>
  );
}
