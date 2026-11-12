import { useEffect, useSyncExternalStore } from 'react';
import { comparePair, migrationShown, noteChangesTab, onChangesTab, previewSession, type ShownTab } from '../changes-tab.js';
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
 * `g c` and Go to come back to it; Compare's tab opens the pair it last showed, Preview's and
 * Migrate's the session.
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
  { key: 'decisions', label: 'Preview', tip: 'Preview what a change decides differently' },
  { key: 'migrate', label: 'Migrate', tip: 'Migrate to another model, with the evidence' },
];

const COMMANDS: Record<ShownTab, string> = { verdicts: 'shadowlap test goldens/*', compare: 'shadowlap diff <a> <b>', decisions: 'shadowlap decisions <runs> --model <model>', migrate: 'shadowlap migrate --to <model>' };

export function ChangesHead({ tab }: { tab: ShownTab }) {
  const { meta } = useApp();
  const project = meta?.project?.id ?? null;
  // Noted in the project shown: the head can draw before the meta names it, and notes it again once it does.
  useEffect(() => noteChangesTab(tab), [tab, project]);
  const pair = useSyncExternalStore(onChangesTab, comparePair);
  const session = useSyncExternalStore(onChangesTab, previewSession);
  const migration = useSyncExternalStore(onChangesTab, migrationShown);
  const strip = useActiveTabInView<HTMLElement>(tab);
  const at = (key: ShownTab) => (key === 'compare' ? (pair ? href.compare(pair[0], pair[1]) : href.compare()) : key === 'decisions' ? href.changeSession('decisions', session) : key === 'migrate' ? href.changeSession('migrate', migration) : href.changes());
  const command = (key: ShownTab) => (key === 'compare' && pair ? `shadowlap diff ${shortId(pair[0])} ${shortId(pair[1])}` : COMMANDS[key]);
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
