import { useEffect, useSyncExternalStore } from 'react';
import { comparePair, noteChangesTab, onChangesTab, type ShownTab } from '../changes-tab.js';
import { PageHeader } from '../components/bits.js';
import { tipCard } from '../components/HoverCard.js';
import { shortId } from '../format.js';
import { useActiveTabInView } from '../hooks.js';
import { href } from '../route.js';
import { projectOf } from '../shell/ProjectBlock.js';
import { useApp } from '../state.js';

/**
 * Changes' head, on each of its tabs: the project and what the page is, its one line, and the tabs,
 * each one word, its CLI verb on hover as a job button shows it. No button of its own: each tab's own
 * next step keeps the lime. The tab shown is noted for the project (changes-tab.ts), so the nav,
 * `g c` and Go to come back to it; Compare's tab opens the pair it last showed. A later tab (a
 * preview's, a migration's) joins `TABS`.
 */

interface ChangesTabLink {
  key: ShownTab;
  label: string;
  /** What it is, on its card. */
  tip: string;
}

const TABS: readonly ChangesTabLink[] = [
  { key: 'verdicts', label: 'Verdicts', tip: 'Every change checked, and its verdict' },
  { key: 'compare', label: 'Compare', tip: 'Compare two runs, call by call' },
];

export function ChangesHead({ tab }: { tab: ShownTab }) {
  const { meta } = useApp();
  const project = meta?.project?.id ?? null;
  // Noted in the project shown: the head can draw before the meta names it, and notes it again once it does.
  useEffect(() => noteChangesTab(tab), [tab, project]);
  const pair = useSyncExternalStore(onChangesTab, comparePair);
  const strip = useActiveTabInView<HTMLElement>(tab);
  const at = (key: ShownTab) => (key === 'compare' ? (pair ? href.compare(pair[0], pair[1]) : href.compare()) : href.changes());
  const command = (key: ShownTab) => (key === 'compare' ? `shadowlap diff ${pair ? `${shortId(pair[0])} ${shortId(pair[1])}` : '<a> <b>'}` : 'shadowlap test goldens/*');
  return (
    <>
      <PageHeader eyebrow={[projectOf(meta)?.name, 'diffs'].filter(Boolean).join(' · ')} title="Changes" text="What a change does to your agent, on its own recorded runs." />
      <nav className="stabs" aria-label="Changes" ref={strip}>
        {TABS.map((t) => (
          <a key={t.key} href={at(t.key)} aria-current={t.key === tab ? 'page' : undefined} data-tip={tipCard(t.tip, [], null, `$ ${command(t.key)}`)}>
            {t.label}
          </a>
        ))}
      </nav>
    </>
  );
}
