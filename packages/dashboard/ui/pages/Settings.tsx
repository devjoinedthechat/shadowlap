import { useEffect } from 'react';
import { PageHeader } from '../components/bits.js';
import { Page } from '../components/Page.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { AgentsTab } from './settings/Agents.js';
import { CiTab } from './settings/Ci.js';
import './settings/jobs.js';
import { SETTINGS_TABS, settingsTab, type SettingsTab } from './settings/logic.js';
import { MatchingTab } from './settings/Matching.js';
import { ProjectTab } from './settings/Project.js';
import { RedactionTab } from './settings/Redaction.js';
import { StoreTab } from './settings/Store.js';
import { ToolsTab } from './settings/Tools.js';

/**
 * Settings (`#/settings/<tab>`): the rules this project replays and shares by, kept in
 * shadowlap.config.json beside its code, one tab per address. Matching, Redaction, CI (still
 * `#/settings/alerts`), Coding agents, Tools, Project and Store. It is the one page a project with
 * no runs can open: nothing here needs a run.
 */
export function SettingsPage({ tab }: { tab: string | null }) {
  const current = settingsTab(tab);
  // An address that isn't a tab (an old one, a typo) opens Matching in its place.
  useEffect(() => {
    if (!current) navigate(href.settings('matching'), true);
  }, [current]);
  const shown: SettingsTab = current ?? 'matching';
  return (
    <Page>
      <PageHeader eyebrow="shadowlap.config.json" title="Settings" text="The rules this project replays and shares by." />
      <nav className="stabs" aria-label="Settings">
        {SETTINGS_TABS.map((t) => (
          <a key={t.key} href={href.settings(t.key)} aria-current={t.key === shown ? 'page' : undefined}>
            {t.label}
          </a>
        ))}
      </nav>
      <div className="settab">
        <TabBody tab={shown} />
      </div>
    </Page>
  );
}

function TabBody({ tab }: { tab: SettingsTab }) {
  switch (tab) {
    case 'matching':
      return <MatchingTab />;
    case 'redaction':
      return <RedactionTab />;
    case 'alerts':
      return <CiTab />;
    case 'agents':
      return <AgentsTab />;
    case 'tools':
      return <ToolsTab />;
    case 'project':
      return <ProjectTab />;
    case 'store':
      return <StoreTab />;
  }
}
